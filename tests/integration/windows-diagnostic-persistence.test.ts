/** Real Windows subprocesses, synthetic reports only; no Amazon/browser access. */
import childProcess, { ChildProcess } from "child_process";
import files from "fs/promises";
import { mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { basename, join, resolve, sep } from "path";
import { promisify } from "util";
import {
  FailureDiagnostics,
  writeFailureReport,
} from "../../src/poc/failure-diagnostics";

const windowsTests = process.platform === "win32" ? describe : describe.skip;
const nativeExecFile = childProcess.execFile;
const execute = promisify(nativeExecFile);
const syntheticReport = (): ReturnType<FailureDiagnostics["report"]> =>
  new FailureDiagnostics().report(
    new Error("Synthetic diagnostic; no account data"),
  );
const importDesktop =
  'Import-Module (Join-Path $PSHOME "Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1") -ErrorAction Stop; ';

windowsTests("Windows Desktop diagnostic persistence", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "windows-diag-persistence-"));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    if (
      !resolve(directory).startsWith(resolve(tmpdir()) + sep) ||
      !basename(directory).startsWith("windows-diag-persistence-")
    )
      throw new Error(
        "Refusing cleanup outside the synthetic temporary directory",
      );
    await rm(directory, { recursive: true, force: true });
  });

  test("uses the child's built-in Desktop module, publishes atomically and enforces owner-only ACLs", async () => {
    const root = join(directory, "reports ' [literal]");
    const report = syntheticReport();
    const originalRename = files.rename;
    let publications = 0;
    const publish = jest
      .spyOn(files, "rename")
      .mockImplementation(async (from, to) => {
        publications++;
        expect(String(from)).toBe(String(to) + ".tmp");
        const before = await readdir(root);
        expect(before).toEqual([basename(String(from))]);
        expect(before.some((name) => name.endsWith(".json"))).toBe(false);
        expect(JSON.parse(await readFile(from, "utf8"))).toEqual(
          JSON.parse(JSON.stringify(report)),
        );
        await originalRename(from, to);
      });
    try {
      await writeFailureReport(report, root);
    } finally {
      publish.mockRestore();
    }
    expect(publications).toBe(1);
    const names = await readdir(root);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^failure-.*\.json$/);
    expect(JSON.parse(await readFile(join(root, names[0]), "utf8"))).toEqual(
      JSON.parse(JSON.stringify(report)),
    );

    const command =
      importDesktop +
      `
$u=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
function Get-SyntheticAclFacts($path) {
  $acl=Get-Acl -LiteralPath $path -ErrorAction Stop
  $rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))
  [ordered]@{
    OwnerIsCurrentUser=($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -eq $u.Value)
    Protected=$acl.AreAccessRulesProtected
    Rules=$rules.Count
    OnlyCurrentUserAllowFullControl=(@($rules | Where-Object {
      $_.IdentityReference.Value -ne $u.Value -or $_.AccessControlType -ne 'Allow' -or
      ($_.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl
    }).Count -eq 0)
  }
}
$m=Get-Module Microsoft.PowerShell.Security
$c=Get-Command Set-Acl -ErrorAction Stop
[ordered]@{
  Edition=$PSVersionTable.PSEdition
  ModuleVersion=$m.Version.ToString()
  ModuleUnderPSHOME=($m.Path -eq (Join-Path $PSHOME 'Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1'))
  SetAclFromModule=($c.Module.Path -eq $m.Path)
  Directory=(Get-SyntheticAclFacts $env:AMAZON_DIAGNOSTIC_ACL_PATH)
  File=(Get-SyntheticAclFacts $env:SYNTHETIC_DIAGNOSTIC_FILE)
} | ConvertTo-Json -Depth 5
`;
    const result = await execute(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      {
        env: {
          ...process.env,
          AMAZON_DIAGNOSTIC_ACL_PATH: root,
          SYNTHETIC_DIAGNOSTIC_FILE: join(root, names[0]),
        },
        encoding: "utf8",
        timeout: 10000,
        windowsHide: true,
      },
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      Edition: "Desktop",
      ModuleUnderPSHOME: true,
      SetAclFromModule: true,
      Directory: {
        OwnerIsCurrentUser: true,
        Protected: true,
        Rules: 1,
        OnlyCurrentUserAllowFullControl: true,
      },
      File: {
        OwnerIsCurrentUser: true,
        Rules: 1,
        OnlyCurrentUserAllowFullControl: true,
      },
    });
  });

  test.each(["missing", "throws"])(
    "a %s module import never reaches ACL work or report publication",
    async (mode) => {
      const root = join(directory, "reports");
      // Start with an actually protected, valid report and retain it byte-for-byte.
      await writeFailureReport(syntheticReport(), root);
      const previous = (await readdir(root))[0];
      const contents = await readFile(join(root, previous), "utf8");
      const module = join(
        directory,
        mode === "missing" ? "missing.psd1" : "throwing.psm1",
      );
      if (mode === "throws")
        await writeFile(module, 'throw "Synthetic module import failure"');
      let stdout = "",
        stderr = "";
      const open = jest.spyOn(files, "open");
      const exec = jest.spyOn(childProcess, "execFile").mockImplementation(((
        ...args: unknown[]
      ): ChildProcess => {
        const commandArgs = [...(args[1] as string[])];
        const replaced = commandArgs[3].replace(
          /\(Join-Path \$PSHOME "Modules\\Microsoft\.PowerShell\.Security\\Microsoft\.PowerShell\.Security\.psd1"\)/,
          "$env:SYNTHETIC_SECURITY_MODULE",
        );
        expect(replaced).not.toBe(commandArgs[3]);
        commandArgs[3] = replaced.replace(
          "; $u=",
          '; [Console]::WriteLine("SYNTHETIC_ACL_REACHED"); $u=',
        );
        const options = args[2] as childProcess.ExecFileOptions;
        const callback = args[3] as (
          error: Error | null,
          stdout: string,
          stderr: string,
        ) => void;
        return nativeExecFile(
          "powershell.exe",
          commandArgs,
          {
            ...options,
            encoding: "utf8",
            env: { ...options.env, SYNTHETIC_SECURITY_MODULE: module },
          },
          (error, out, err) => {
            stdout = out;
            stderr = err;
            callback(error, out, err);
          },
        );
      }) as unknown as typeof childProcess.execFile);
      try {
        await expect(
          writeFailureReport(syntheticReport(), root),
        ).rejects.toMatchObject({ code: expect.any(Number) });
        expect(stdout).not.toContain("SYNTHETIC_ACL_REACHED");
        expect(stderr).toContain(
          mode === "throws"
            ? "Synthetic module import failure"
            : "missing.psd1",
        );
        expect(open).not.toHaveBeenCalled();
        expect(await readdir(root)).toEqual([previous]);
        expect(await readFile(join(root, previous), "utf8")).toBe(contents);
      } finally {
        exec.mockRestore();
        open.mockRestore();
      }
    },
  );
});
