import { makeTestDirectory } from "../../helpers/temp-directory";
import type { Locator } from "playwright";
import { readFile, readdir, rm } from "fs/promises";
import { join } from "path";
import { classifyWalletFundingCard } from "../../../src/poc/wallet-card-classification";
import {
  FailureDiagnostics,
  writeFailureReport,
} from "../../../src/poc/failure-diagnostics";
const id = "111-2222222-4444444",
  pair = "Amazon Pay Wallet\nMoney added";
describe("wallet classification transport and private exclusion events", () => {
  test.each([
    "Amazon Pay Wallet",
    "Money added",
    "Amazon Pay Wallet Add Money",
    "Paid using wallet balance",
    "/dp/B0FUND0001",
    "",
  ])("no partial text or link proves funding: %s", async (text) => {
    const evaluate = jest.fn();
    expect(
      await classifyWalletFundingCard(
        { evaluate } as unknown as Locator,
        text,
        id,
        ".order-card",
      ),
    ).toBe("not-observed");
    expect(evaluate).not.toHaveBeenCalled();
  });
  test.each([true, false, -1, 1, "true", null, undefined, {}])(
    "only a verified DOM result authorizes exclusion: %j",
    async (value) => {
      const evaluate = jest.fn(async () => value);
      expect(
        await classifyWalletFundingCard(
          { evaluate } as unknown as Locator,
          pair,
          id,
          ".order-card",
        ),
      ).toBe(
        value === true
          ? "funding-only"
          : value === false
            ? "unverified"
            : "unavailable",
      );
      expect(evaluate).toHaveBeenCalledWith(
        expect.any(Function),
        { expected: id, ownerSelector: ".order-card" },
        { timeout: 1500 },
      );
    },
  );
  test.each(["Error", "TimeoutError"])(
    "safe %s observation failure never authorizes a skip",
    async (name) => {
      const error = Object.assign(
        new Error("PRIVATE_ERROR cookie=secret /private/path ₹99.00"),
        { name },
      );
      await expect(
        classifyWalletFundingCard(
          {
            evaluate: async () => {
              throw error;
            },
          } as unknown as Locator,
          pair,
          id,
          ".order-card",
        ),
      ).resolves.toBe("unavailable");
    },
  );
  test("oversized candidates do not read DOM", async () => {
    const evaluate = jest.fn();
    expect(
      await classifyWalletFundingCard(
        { evaluate } as unknown as Locator,
        pair + "x".repeat(50000),
        id,
        ".order-card",
      ),
    ).toBe("unavailable");
    expect(evaluate).not.toHaveBeenCalled();
  });
  test.each([0, -1, 1.5, NaN, Infinity])(
    "invalid exclusion counts cannot create verified events: %s",
    (count) => {
      const trace = new FailureDiagnostics();
      trace.walletFundingExcluded(count);
      expect(trace.report(new Error()).events).toEqual([]);
    },
  );
  test("excluded records never inherit the previous merchandise index", () => {
    const trace = new FailureDiagnostics();
    trace.select({ orderId: id, orderDate: "2026-10-01" }, 3);
    trace.walletFundingExcluded(1);
    expect(trace.report(new Error()).events).toEqual([
      expect.objectContaining({
        stage: "list",
        reason: "LIST_WALLET_FUNDING_EXCLUDED",
        count: 1,
      }),
    ]);
    expect(trace.report(new Error()).events[0].orderIndex).toBeUndefined();
  });
  test("persisted exclusion evidence contains only a count, no funding facts", async () => {
    const trace = new FailureDiagnostics();
    trace.walletFundingExcluded(2);
    const directory = await makeTestDirectory("wallet-excluded-report-");
    try {
      await writeFailureReport(
        trace.report(new Error("PRIVATE_ERROR")),
        directory,
      );
      const [file] = await readdir(directory);
      const text = await readFile(join(directory, file), "utf8");
      const report = JSON.parse(text);
      expect(report.selectedOrders).toEqual([]);
      expect(report.order).toBeUndefined();
      expect(report.events[0]).toMatchObject({
        reason: "LIST_WALLET_FUNDING_EXCLUDED",
        count: 2,
      });
      expect(text).not.toMatch(/111-|PRIVATE_ERROR|Amazon Pay Wallet|₹|\/dp\//);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
