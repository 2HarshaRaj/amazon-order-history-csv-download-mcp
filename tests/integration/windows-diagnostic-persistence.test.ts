import { makeTestDirectory } from "../helpers/temp-directory";
/** Real Windows subprocesses, synthetic reports only; no Amazon/browser access. */
import childProcess, { ChildProcess } from "child_process";
import files from "fs/promises";
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "fs/promises";
import { tmpdir } from "os";
import { basename, dirname, join, resolve, sep } from "path";
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
    directory = await makeTestDirectory("windows-diag-persistence-");
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    if (
      !resolve(directory).startsWith(resolve(await realpath(tmpdir())) + sep) ||
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

  test("repeated writes retain protected owner-only ACLs and prior reports", async () => {
    const root = join(directory, "repeated ' [literal]");
    const reports = [syntheticReport(), syntheticReport(), syntheticReport()];
    await writeFailureReport(reports[0], root);
    const firstName = (await readdir(root))[0];
    const firstBytes = await readFile(join(root, firstName), "utf8");
    await writeFailureReport(reports[1], root);
    await writeFailureReport(reports[2], root);
    const names = await readdir(root);
    expect(names).toHaveLength(3);
    expect(names.every((name) => /^failure-.*\.json$/.test(name))).toBe(true);
    expect(await readFile(join(root, firstName), "utf8")).toBe(firstBytes);
    const stored = await Promise.all(
      names.map(async (name) =>
        JSON.parse(await readFile(join(root, name), "utf8")),
      ),
    );
    expect(stored.map((report) => report.runId).sort()).toEqual(
      reports.map((report) => report.runId).sort(),
    );
    const result = await execute(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        importDesktop +
          `
$u=[System.Security.Principal.WindowsIdentity]::GetCurrent().User
$root=$env:AMAZON_DIAGNOSTIC_ACL_PATH
$directoryAcl=Get-Acl -LiteralPath $root -ErrorAction Stop
$rules=@($directoryAcl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))
$files=@(Get-ChildItem -LiteralPath $root -File)
$invalid=@($files | Where-Object {
  $acl=Get-Acl -LiteralPath $_.FullName -ErrorAction Stop
  $access=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))
  $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $u.Value -or
  $access.Count -ne 1 -or $access[0].IdentityReference.Value -ne $u.Value -or
  $access[0].AccessControlType -ne 'Allow' -or
  $access[0].FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl
})
[ordered]@{
  OwnerIsCurrentUser=($directoryAcl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -eq $u.Value)
  Protected=$directoryAcl.AreAccessRulesProtected
  Rules=$rules.Count
  OwnerOnly=($rules.Count -eq 1 -and $rules[0].IdentityReference.Value -eq $u.Value -and $rules[0].AccessControlType -eq 'Allow' -and $rules[0].FileSystemRights -eq [System.Security.AccessControl.FileSystemRights]::FullControl)
  ChildrenInherit=($rules[0].InheritanceFlags -eq [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit')
  Files=$files.Count
  AllFilesOwnerOnly=($invalid.Count -eq 0)
} | ConvertTo-Json
`,
      ],
      {
        env: { ...process.env, AMAZON_DIAGNOSTIC_ACL_PATH: root },
        encoding: "utf8",
        timeout: 10000,
        windowsHide: true,
      },
    );
    expect(JSON.parse(result.stdout)).toEqual({
      OwnerIsCurrentUser: true,
      Protected: true,
      Rules: 1,
      OwnerOnly: true,
      ChildrenInherit: true,
      Files: 3,
      AllFilesOwnerOnly: true,
    });
  });

  test("rejects a noncanonical Windows alias without changing a prior report", async () => {
    await writeFailureReport(syntheticReport(), directory);
    const names = await readdir(directory);
    const prior = await readFile(join(directory, names[0]), "utf8");
    const temporaryAlias = join(tmpdir(), basename(directory));
    // Exercise the real 8.3 TEMP alias when present, or a Windows case alias.
    const alias =
      temporaryAlias !== directory
        ? temporaryAlias
        : join(dirname(directory), basename(directory).toUpperCase());
    expect(alias).not.toBe(directory);
    expect(await realpath(alias)).toBe(directory);
    const open = jest.spyOn(files, "open");
    try {
      await expect(
        writeFailureReport(syntheticReport(), alias),
      ).rejects.toThrow("Unsafe diagnostic directory.");
      expect(open).not.toHaveBeenCalled();
      expect(await readdir(directory)).toEqual(names);
      expect(await readFile(join(directory, names[0]), "utf8")).toBe(prior);
    } finally {
      open.mockRestore();
    }
  });

  test("rejects a Windows junction ancestor without publishing in its target", async () => {
    const target = join(directory, "target");
    const junction = join(directory, "junction");
    await mkdir(target);
    await symlink(target, junction, "junction");
    try {
      await expect(
        writeFailureReport(syntheticReport(), join(junction, "reports")),
      ).rejects.toThrow("Unsafe");
      expect(await readdir(target)).toEqual([]);
    } finally {
      await unlink(junction);
    }
  });

  test.each(["missing", "throws", "persistence"])(
    "%s failure prevents file opening and report publication",
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
        const replaced =
          mode === "persistence"
            ? commandArgs[3].replace(
                "[System.IO.Directory]::SetAccessControl($env:AMAZON_DIAGNOSTIC_ACL_PATH,$a)",
                "[System.IO.Directory]::SetAccessControl($null,$a)",
              )
            : commandArgs[3].replace(
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
        if (mode === "persistence")
          expect(stdout).toContain("SYNTHETIC_ACL_REACHED");
        else expect(stdout).not.toContain("SYNTHETIC_ACL_REACHED");
        expect(stderr).toContain(
          mode === "throws"
            ? "Synthetic module import failure"
            : mode === "persistence"
              ? "SetAccessControl"
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
