import { randomUUID } from "crypto";
import { existsSync } from "fs";
import files from "fs/promises";
import childProcess, { ChildProcess } from "child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
  utimes,
} from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  cleanupFailureReports,
  DiagnosticError,
  FailureDiagnostics,
  MAX_REPORT_BYTES,
  MAX_REPORTS,
  RETENTION_MS,
  safeFailureMessage,
  writeFailureReport,
} from "../../../src/poc/failure-diagnostics";
import {
  createExportDocument,
  parseCliOptions,
} from "../../../src/poc/export-json";
import { parseOrderSummaryAdjustments } from "../../../src/poc/hardened-index-v3";

const money = (amount: number) => ({
  amount,
  currency: "INR",
  formatted: `₹${amount}`,
});
const summary = {
  orderId: "408-0000000-0000001",
  orderDate: "2026-10-01",
  orderTotal: money(210.02),
};
const detail = {
  orderId: summary.orderId,
  extractionSource: "order-detail",
  itemCount: 1,
  items: [
    {
      asin: "B000000001",
      productName: "Synthetic notebook",
      quantity: 2,
      unitPrice: money(100),
      itemTotal: money(200),
    },
  ],
  adjustments: parseOrderSummaryAdjustments(["Marketplace Fee:  ₹10.00"]),
};
const options = { startDate: "2026-10-01", endDate: "2026-10-02" };

function report() {
  return new FailureDiagnostics().report(new Error("NEVER STORE THIS"));
}

describe("allowlisted failure evidence", () => {
  test("captures exact signed reconciliation math and the first validation order, not the last extracted one", () => {
    const trace = new FailureDiagnostics();
    const second = { ...summary, orderId: "408-0000000-0000002" };
    trace.listed([summary, second], 1);
    trace.select(second, 1);
    expect(() =>
      createExportDocument(
        options,
        1,
        [{ summary, detail }],
        new Date().toISOString(),
        trace,
      ),
    ).toThrow("reconcile");
    expect(trace.report(undefined)).toMatchObject({
      failure: { stage: "reconciliation", reason: "TOTAL_MISMATCH" },
      order: {
        orderId: summary.orderId,
        orderIndex: 0,
        orderDate: summary.orderDate,
        orderTotalPaise: 21002,
      },
      items: [
        {
          lineIndex: 0,
          asin: "B000000001",
          productName: "Synthetic notebook",
          quantity: 2,
          unitPricePaise: 10000,
          itemTotalPaise: 20000,
        },
      ],
      adjustments: [{ type: "marketplace_fee", amountPaise: 1000 }],
      reconciliation: {
        itemsPaise: 20000,
        adjustmentsPaise: 1000,
        expectedPaise: 21002,
        actualPaise: 21000,
        differencePaise: -2,
        tolerancePaise: 1,
      },
    });
    const safe = safeFailureMessage(trace.report(undefined));
    expect(safe).toContain("code=TOTAL_MISMATCH");
    expect(safe).not.toMatch(/408-|notebook|21002|21000/);
  });

  test("pinpoints a missing price at its line without weakening validation", () => {
    const trace = new FailureDiagnostics();
    const invalid = {
      ...detail,
      items: [detail.items[0], { ...detail.items[0], unitPrice: undefined }],
    };
    try {
      createExportDocument(
        options,
        1,
        [{ summary, detail: invalid }],
        new Date().toISOString(),
        trace,
      );
      throw new Error("expected failure");
    } catch (error) {
      expect(trace.report(error)).toMatchObject({
        failure: {
          stage: "validation",
          reason: "UNIT_PRICE_INVALID",
          category: "validation",
        },
        order: { orderIndex: 0 },
        lineIndex: 1,
      });
    }
  });

  test("classifies safe technical error categories without echoing messages", () => {
    const trace = new FailureDiagnostics();
    trace.at("output", "OUTPUT_WRITE_FAILED");
    const error = Object.assign(new Error("PRIVATE_PATH_AND_COOKIE"), {
      code: "ENOSPC",
    });
    expect(trace.report(error).failure).toEqual({
      stage: "output",
      reason: "OUTPUT_WRITE_FAILED",
      category: "storage-full",
    });
    expect(JSON.stringify(trace.report(error))).not.toContain("PRIVATE_PATH");
  });

  test("retains partial adjustments and the failing row without copying its contents", () => {
    const trace = new FailureDiagnostics();
    expect(() =>
      parseOrderSummaryAdjustments(
        ["Shipping:  ₹5.00", "Marketplace Fee:  secret-cookie-value"],
        trace,
      ),
    ).toThrow(DiagnosticError);
    const evidence = trace.report(undefined);
    expect(evidence).toMatchObject({
      failure: { stage: "adjustments", reason: "ADJUSTMENT_AMOUNT_INVALID" },
      adjustmentIndex: 1,
      adjustments: [{ type: "shipping", amountPaise: 500 }],
    });
    expect(JSON.stringify(evidence)).not.toContain("secret-cookie-value");
  });

  test.each([
    "buyer@example.invalid",
    "synthetic@upi",
    "Card 4111 1111 1111 1111",
    "4111.1111.1111.1111",
    "OTP 123456",
    "cookie=session",
    "<b>html</b>",
    "https://example.invalid/?token=synthetic",
    "phone +91 9876543210",
    "Billing address: Synthetic Street",
  ])("omits sensitive title %s", (title) => {
    const trace = new FailureDiagnostics();
    trace.select(summary, 0);
    trace.detail({
      ...detail,
      items: [{ ...detail.items[0], productName: title }],
    });
    const evidence = trace.report(new Error(title));
    expect(evidence.items[0].productName).toBeUndefined();
    expect(JSON.stringify(evidence)).not.toContain(title);
  });

  test("projects facts rather than copying extra properties, arbitrary sources, labels, error messages or stacks", () => {
    const trace = new FailureDiagnostics();
    const privateFields = {
      address: "PRIVATE_ADDRESS",
      otp: "PRIVATE_OTP",
      cookie: "PRIVATE_COOKIE",
      html: "<html>PRIVATE_HTML</html>",
      payment: "PRIVATE_PAYMENT",
      stack: "PRIVATE_STACK",
    };
    trace.select({ ...summary, ...privateFields }, 0);
    trace.detail({
      ...detail,
      ...privateFields,
      extractionSource: "PRIVATE_SOURCE",
      items: [{ ...detail.items[0], ...privateFields }],
      adjustments: [
        { ...detail.adjustments[0], label: "PRIVATE_LABEL", ...privateFields },
      ],
    });
    trace.itemDiagnostics(
      "Strategy4 (2024+ data-component) failed: PRIVATE_EXCEPTION",
    );
    trace.itemDiagnostics(
      "Data components: Error extracting item: PRIVATE_EXCEPTION",
    );
    trace.itemDiagnostics("PRIVATE_RAW_DIAGNOSTIC");
    const text = JSON.stringify(
      trace.report(
        Object.assign(new Error("PRIVATE_EXCEPTION"), privateFields),
      ),
    );
    expect(text).not.toContain("PRIVATE_");
    expect(text).toContain("STRATEGY_FAILED");
    expect(text).toContain("ITEM_ROW_FAILED");
  });

  test("bounds entries while retaining total counts", () => {
    const trace = new FailureDiagnostics();
    for (let i = 0; i < 400; i++) trace.note("items", "ITEM_ROW_FAILED");
    trace.captureItems(Array.from({ length: 300 }, () => detail.items[0]));
    const evidence = trace.report(undefined);
    expect(evidence.events).toHaveLength(200);
    expect(evidence.items).toHaveLength(100);
    expect(evidence.counts.items).toBe(300);
    expect(evidence.truncated).toBe(true);
  });

  test("invalid option errors remain useful without echoing private arguments", () => {
    for (const args of [
      ["--secret-cookie=PRIVATE_PAYLOAD"],
      [
        "--start-date",
        "PRIVATE_PAYLOAD",
        "--end-date",
        "2026-10-01",
        "--output",
        join(tmpdir(), "out.json"),
      ],
    ]) {
      try {
        parseCliOptions(args);
        throw new Error("expected rejection");
      } catch (error) {
        expect(String(error)).not.toContain("PRIVATE_PAYLOAD");
        expect(String(error)).toMatch(/Unknown argument|YYYY-MM-DD/);
      }
    }
  });
});

describe("owner-local report store", () => {
  let directory: string;
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "amazon-diagnostics-unit-"));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  const filename = (time: number, suffix = "") =>
    `failure-${time}-${randomUUID()}.json${suffix}`;

  test("atomically writes a private, bounded report", async () => {
    const root = join(directory, "reports");
    await writeFailureReport(report(), root);
    const names = await readdir(root);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/\.json$/);
    const path = join(root, names[0]);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      schemaVersion: 1,
      failure: { stage: "list" },
    });
    expect((await stat(path)).size).toBeLessThanOrEqual(MAX_REPORT_BYTES);
    if (process.platform !== "win32") {
      expect((await stat(root)).mode & 0o777).toBe(0o700);
      expect((await stat(path)).mode & 0o777).toBe(0o600);
    }
  });

  test("expires 30-day reports by creation time, caps count, and preserves unrelated files/links/directories", async () => {
    const now = Date.now();
    const expired = filename(now - RETENTION_MS);
    const oldTemp = filename(now - RETENTION_MS, ".tmp");
    await writeFile(join(directory, expired), "old");
    await writeFile(join(directory, oldTemp), "partial");
    await writeFile(join(directory, "owner-notes.txt"), "keep");
    const nested = filename(now);
    await mkdir(join(directory, nested));
    const target = join(directory, "owner-target");
    await writeFile(target, "keep");
    const link = filename(now - RETENTION_MS);
    if (process.platform !== "win32")
      await symlink(target, join(directory, link));
    await Promise.all(
      Array.from({ length: MAX_REPORTS + 4 }, (_, i) =>
        writeFile(join(directory, filename(now - i)), "{}"),
      ),
    );
    await writeFailureReport(report(), directory, now);
    expect(existsSync(join(directory, expired))).toBe(false);
    expect(existsSync(join(directory, oldTemp))).toBe(false);
    expect(await readFile(target, "utf8")).toBe("keep");
    expect(await readFile(join(directory, "owner-notes.txt"), "utf8")).toBe(
      "keep",
    );
    expect((await stat(join(directory, nested))).isDirectory()).toBe(true);
    const reports = (await readdir(directory)).filter(
      (name) => /\.json$/.test(name) && name !== nested && name !== link,
    );
    expect(reports).toHaveLength(MAX_REPORTS);
    if (process.platform !== "win32")
      expect(existsSync(join(directory, link))).toBe(true);
  });

  test("cleans oversized reports and abandoned temporary files but retains fresh reports", async () => {
    const now = Date.now();
    const oversized = filename(now);
    const fresh = filename(now - RETENTION_MS + 1);
    const stale = filename(now, ".tmp");
    await writeFile(
      join(directory, oversized),
      Buffer.alloc(MAX_REPORT_BYTES + 1),
    );
    await writeFile(join(directory, fresh), "{}");
    await writeFile(join(directory, stale), "{}");
    await utimes(
      join(directory, stale),
      new Date(now - 7200000),
      new Date(now - 7200000),
    );
    await cleanupFailureReports(directory, now);
    expect(await readdir(directory)).toEqual([fresh]);
  });

  test("shrinks oversized evidence while preserving the failing line and reconciliation", async () => {
    const trace = new FailureDiagnostics();
    trace.select(summary, 0);
    trace.detail(detail);
    trace.item(0);
    trace.reconcile(20000, 1000, 21002);
    const evidence = trace.report(undefined);
    evidence.events = Array.from({ length: 3000 }, () => ({
      stage: "items" as const,
      reason: "ITEM_ROW_FAILED" as const,
      elapsedMs: 1,
    }));
    await writeFailureReport(evidence, directory);
    const path = join(directory, (await readdir(directory))[0]);
    expect((await stat(path)).size).toBeLessThanOrEqual(MAX_REPORT_BYTES);
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      truncated: true,
      items: [{ lineIndex: 0, productName: "Synthetic notebook" }],
      reconciliation: { differencePaise: -2 },
    });
  });

  test("cleans its temporary file when diagnostic finalization fails", async () => {
    const failure = new Error("synthetic rename failure");
    const rename = jest.spyOn(files, "rename").mockRejectedValue(failure);
    try {
      await expect(writeFailureReport(report(), directory)).rejects.toBe(
        failure,
      );
      expect(await readdir(directory)).toEqual([]);
    } finally {
      rename.mockRestore();
    }
  });

  test.each([false, true])(
    "Windows ACL setup (failure=%s) gates report writes",
    async (fail) => {
      const platform = Object.getOwnPropertyDescriptor(process, "platform");
      if (!platform) throw new Error("Missing platform descriptor");
      const permissionError = new Error("synthetic ACL failure");
      const exec = jest.spyOn(childProcess, "execFile").mockImplementation(((
        ...args: unknown[]
      ): ChildProcess => {
        const callback = args[args.length - 1] as (
          error: Error | null,
          stdout: string,
          stderr: string,
        ) => void;
        callback(fail ? permissionError : null, "", "");
        return {} as ChildProcess;
      }) as unknown as typeof childProcess.execFile);
      try {
        Object.defineProperty(process, "platform", { value: "win32" });
        const result = writeFailureReport(report(), directory);
        if (fail) {
          await expect(result).rejects.toBe(permissionError);
          expect(await readdir(directory)).toEqual([]);
        } else {
          await result;
          expect(await readdir(directory)).toHaveLength(1);
        }
        expect(exec.mock.calls[0][0]).toBe("powershell.exe");
        expect(exec.mock.calls[0][2]).toMatchObject({
          windowsHide: true,
          env: { AMAZON_DIAGNOSTIC_ACL_PATH: directory },
        });
      } finally {
        Object.defineProperty(process, "platform", platform);
        exec.mockRestore();
      }
    },
  );

  test("refuses a repository or a symlinked directory", async () => {
    await mkdir(join(directory, ".git"));
    await writeFile(
      join(directory, ".git", "HEAD"),
      "ref: refs/heads/synthetic\n",
    );
    await expect(
      writeFailureReport(report(), join(directory, "reports")),
    ).rejects.toThrow("outside repositories");
    expect(existsSync(join(directory, "reports"))).toBe(false);
    await rm(join(directory, ".git"), { recursive: true });
    await writeFile(join(directory, ".git"), "gitdir: synthetic-location\n");
    await expect(
      writeFailureReport(report(), join(directory, "reports")),
    ).rejects.toThrow("outside repositories");
    await rm(join(directory, ".git"));
    await writeFile(join(directory, "HEAD"), "ref: refs/heads/synthetic\n");
    await mkdir(join(directory, "objects"));
    await expect(
      writeFailureReport(report(), join(directory, "reports")),
    ).rejects.toThrow("outside repositories");
    await rm(join(directory, "HEAD"));
    await rm(join(directory, "objects"), { recursive: true });
    if (process.platform !== "win32") {
      const link = join(directory, "alias");
      await symlink(directory, link);
      await expect(
        writeFailureReport(report(), join(link, "reports")),
      ).rejects.toThrow("Unsafe");
    }
  });
});
