import { makeTestDirectory } from "../../helpers/temp-directory";
import { readFile, readdir, rm } from "fs/promises";
import { join } from "path";
import type { Page } from "playwright";
import { extractNowOrder } from "../../../src/poc/amazon-now";
import {
  DiagnosticError,
  FailureDiagnostics,
  NOW_CHECKPOINTS,
  NOW_DOM_FAILURES,
  safeFailureMessage,
  writeFailureReport,
} from "../../../src/poc/failure-diagnostics";
import { AuthenticationRequiredError } from "../../../src/poc/hardened-index-v3";

const id = "111-2222222-3333333";
const outer = `https://www.amazon.in/uff/your-account/order-details?orderID=${id}`;
const tracking = `https://www.amazon.in/tez/browse/orderTracking?orderId=${id}`;
const privateText =
  "PRIVATE_SENTINEL cookie=secret buyer@example.invalid ₹999.99 <html>private</html>";
type Phase = (typeof NOW_CHECKPOINTS)[number];

/** Synthetic transport errors, never a browser or an Amazon request. */
function transport(failing?: Phase, error: unknown = new Error(privateText)) {
  let opened = false;
  const stop = (phase: Phase): void => {
    if (failing === phase) throw error;
  };
  const trackingFacts = { orderIds: [id], billRows: [], items: [] };
  const dialogFacts = {
    orderIds: [id],
    billRows: ["You pay ₹10.00"],
    items: [
      {
        parts: ["Invented diagnostic item", "Qty: 1", "₹10.00"],
        alts: [],
        hrefs: [],
      },
    ],
  };
  const control = {
    filter() {
      return this;
    },
    first() {
      return this;
    },
    count: async () => 1,
    waitFor: async () => stop("NOW_DETAILS_CONTROL"),
    evaluate: jest.fn(async () => {
      stop("NOW_TRACKING_IDENTITY");
      return { facts: trackingFacts, checkpoints: [] };
    }),
    click: jest.fn(async () => {
      stop("NOW_DIALOG_OPEN");
      opened = true;
    }),
  };
  const dialog = {
    filter() {
      return this;
    },
    first() {
      return this;
    },
    count: async () => (opened ? 1 : 0),
    waitFor: async () => {},
    evaluate: jest.fn(async () => {
      stop("NOW_DIALOG_IDENTITY");
      return {
        facts: dialogFacts,
        checkpoints: [
          "NOW_DIALOG_IDENTITY",
          "NOW_BILL_SUMMARY",
          "NOW_ITEMS_FEES",
        ],
      };
    }),
  };
  const page = {
    on: jest.fn(),
    off: jest.fn(),
    url: () => tracking,
    goto: async () => stop("NOW_NAVIGATION"),
    waitForURL: async () => {},
    waitForFunction: async () => stop("NOW_DETAILS_CONTROL"),
    locator: () => dialog,
    getByText: (pattern: RegExp) =>
      pattern.source === "^View details$"
        ? { ...control, count: async () => 0 }
        : control,
  } as unknown as Page;
  return { page, control, dialog, dialogFacts };
}

describe("Amazon Now categorical diagnostics (synthetic transport)", () => {
  test.each([
    "NOW_NAVIGATION",
    "NOW_DETAILS_CONTROL",
    "NOW_TRACKING_IDENTITY",
    "NOW_DIALOG_OPEN",
    "NOW_DIALOG_IDENTITY",
  ] as const)(
    "%s preserves timeout category without a raw exception",
    async (phase) => {
      const { page } = transport(
        phase,
        Object.assign(new Error(privateText), { name: "TimeoutError" }),
      );
      const trace = new FailureDiagnostics();
      const error = await extractNowOrder(
        page,
        id,
        outer,
        async () => {},
        trace,
      ).catch((e: unknown) => e);
      expect(error).toMatchObject({ reason: phase, category: "timeout" });
      const report = trace.report(error);
      expect(report.failure).toEqual({
        stage: "detail",
        reason: phase,
        category: "timeout",
      });
      expect(report.events.at(-1)).toMatchObject({
        reason: phase,
        category: "timeout",
      });
      expect(JSON.stringify(report) + String(error)).not.toContain(privateText);
      expect(page.off).toHaveBeenCalledWith(
        "framenavigated",
        expect.any(Function),
      );
    },
  );

  test("unexpected Playwright errors are sanitized and remain operation failures", async () => {
    const { page } = transport("NOW_DIALOG_OPEN", new Error(privateText));
    const trace = new FailureDiagnostics();
    const error = await extractNowOrder(
      page,
      id,
      outer,
      async () => {},
      trace,
    ).catch((e: unknown) => e);
    expect(trace.report(error).failure).toMatchObject({
      reason: "NOW_DIALOG_OPEN",
      category: "operation-failed",
    });
    expect(String(error)).not.toContain(privateText);
  });

  test.each(NOW_DOM_FAILURES)(
    "DOM category %s survives the bounded browser result",
    async (reason) => {
      const { page, dialog } = transport();
      dialog.evaluate.mockResolvedValueOnce({
        failure: reason,
        checkpoints: ["NOW_DIALOG_IDENTITY"],
      } as never);
      const trace = new FailureDiagnostics();
      const error = await extractNowOrder(
        page,
        id,
        outer,
        async () => {},
        trace,
      ).catch((e: unknown) => e);
      expect(error).toMatchObject({ reason, category: "validation" });
      expect(trace.report(error).events.at(-1)).toMatchObject({
        reason,
        category: "validation",
      });
    },
  );

  test.each(["NOW_BILL_SUMMARY", "NOW_ITEMS_FEES"] as const)(
    "unexpected DOM errors retain %s checkpoint",
    async (phase) => {
      const { page, dialog } = transport();
      dialog.evaluate.mockResolvedValueOnce({
        unexpected: true,
        checkpoints: [phase],
      } as never);
      const trace = new FailureDiagnostics();
      const error = await extractNowOrder(
        page,
        id,
        outer,
        async () => {},
        trace,
      ).catch((e: unknown) => e);
      expect(trace.report(error).failure).toMatchObject({
        reason: phase,
        category: "operation-failed",
      });
    },
  );

  test("unallowlisted browser diagnostics cannot reach the report", async () => {
    const { page, dialog } = transport();
    dialog.evaluate.mockResolvedValueOnce({
      failure: privateText,
      checkpoints: [],
    } as never);
    const trace = new FailureDiagnostics();
    const error = await extractNowOrder(
      page,
      id,
      outer,
      async () => {},
      trace,
    ).catch((e: unknown) => e);
    expect(trace.report(error).failure).toMatchObject({
      reason: "NOW_DIALOG_IDENTITY",
      category: "operation-failed",
    });
    expect(JSON.stringify(trace.report(error)) + String(error)).not.toContain(
      privateText,
    );
  });

  test("success records the entered phases with no snapshot facts in events", async () => {
    const { page } = transport();
    const trace = new FailureDiagnostics();
    await extractNowOrder(page, id, outer, async () => {}, trace);
    const report = trace.report(undefined);
    expect(new Set(report.events.map((event) => event.reason))).toEqual(
      new Set(NOW_CHECKPOINTS),
    );
    expect(JSON.stringify(report.events)).not.toMatch(
      /111-|₹|Invented|https?:|10\.00/,
    );
    expect(report.items).toEqual([]);
    expect(report.adjustments).toEqual([]);
  });

  test("parser and reconciliation failures retain their established exact reason", async () => {
    const { page, dialogFacts } = transport();
    dialogFacts.billRows = ["You pay ₹10.02"];
    const trace = new FailureDiagnostics();
    const error = await extractNowOrder(
      page,
      id,
      outer,
      async () => {},
      trace,
    ).catch((e: unknown) => e);
    expect(trace.report(error).failure).toEqual({
      stage: "reconciliation",
      reason: "TOTAL_MISMATCH",
      category: "validation",
    });
    expect(trace.report(error).events.slice(-2)).toMatchObject([
      { reason: "NOW_PARSING" },
      { stage: "reconciliation", reason: "TOTAL_MISMATCH" },
    ]);
  });

  test("authentication requirements propagate unchanged", async () => {
    const { page } = transport();
    const authError = new AuthenticationRequiredError();
    const trace = new FailureDiagnostics();
    await expect(
      extractNowOrder(
        page,
        id,
        outer,
        async () => {
          throw authError;
        },
        trace,
      ),
    ).rejects.toBe(authError);
    expect(trace.report(authError, true).failure.category).toBe(
      "authentication",
    );
    expect(trace.report(authError, true).events.at(-1)?.reason).toBe(
      "AUTHENTICATION_REQUIRED",
    );
  });

  test.each(["TimeoutError", "Error"])(
    "sign-in recheck sanitizes %s without replacing it with validation",
    async (name) => {
      const { page } = transport("NOW_DIALOG_OPEN");
      page.url = () => "https://www.amazon.in/ap/signin";
      let calls = 0;
      const trace = new FailureDiagnostics();
      const error = await extractNowOrder(
        page,
        id,
        outer,
        async () => {
          if (++calls === 3)
            throw Object.assign(new Error(privateText), { name });
        },
        trace,
      ).catch((e: unknown) => e);
      expect(trace.report(error).failure.category).toBe(
        name === "TimeoutError" ? "timeout" : "operation-failed",
      );
      expect(JSON.stringify(trace.report(error)) + String(error)).not.toContain(
        privateText,
      );
    },
  );

  test.each([...NOW_CHECKPOINTS, ...NOW_DOM_FAILURES])(
    "persisted %s report contains only categorical additions",
    async (reason) => {
      const directory = await makeTestDirectory("now-categorical-");
      try {
        const trace = new FailureDiagnostics();
        // Retain order index 2 without supplying purchase facts to diagnostics.
        trace.select({ orderId: privateText, orderDate: privateText }, 2);
        trace.provenance("amazon-now-order-details");
        trace.at("detail", reason);
        trace.noteFailure("detail", reason, new Error(privateText));
        const error = new DiagnosticError("detail", reason, privateText);
        const report = trace.report(error);
        await writeFailureReport(report, directory);
        const names = await readdir(directory);
        expect(names).toHaveLength(1);
        const serialized = await readFile(join(directory, names[0]), "utf8");
        expect(JSON.parse(serialized)).toMatchObject({
          failure: { reason, category: "validation" },
          order: { orderIndex: 2 },
          events: [{ reason, orderIndex: 2, category: "operation-failed" }],
          counts: { items: 0, adjustments: 0 },
        });
        expect(serialized + safeFailureMessage(report)).not.toMatch(
          /PRIVATE_SENTINEL|cookie|buyer@|₹|<html>|https?:/,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
