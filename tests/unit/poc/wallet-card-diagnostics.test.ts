import { makeTestDirectory } from "../../helpers/temp-directory";
import type { Locator } from "playwright";
import { readFile, readdir, rm } from "fs/promises";
import { join } from "path";
import {
  DiagnosticError,
  FailureDiagnostics,
  writeFailureReport,
} from "../../../src/poc/failure-diagnostics";
import {
  recordWalletCardDiagnostic,
  walletLabelDiagnostic,
} from "../../../src/poc/wallet-card-diagnostics";

const label = "Amazon Pay Wallet Add Money";
const privateText =
  "PRIVATE_SENTINEL cookie=secret ₹123.45 /private/path user@example.invalid";
const selector = ".order-card";
function trace(): FailureDiagnostics {
  const result = new FailureDiagnostics();
  result.select(
    { orderId: "untrusted-private-id", orderDate: "untrusted-date" },
    3,
  );
  result.at("detail", "DETAIL_ORDER_MISMATCH");
  return result;
}

describe("wallet label diagnostics never authorize classification", () => {
  test.each([0, 1, 2, -1, 3, 1.5, NaN, Infinity, "1", {}, null, undefined])(
    "maps only fixed bounded observation states: %j",
    (count) => {
      expect(walletLabelDiagnostic(count)).toBe(
        count === 0
          ? undefined
          : count === 1
            ? "LIST_WALLET_LABEL_UNVERIFIED"
            : count === 2
              ? "LIST_WALLET_LABEL_AMBIGUOUS"
              : "LIST_WALLET_EVIDENCE_UNAVAILABLE",
      );
    },
  );
  test.each([
    "Amazon Pay",
    "Paid using Amazon Pay balance",
    "Gift Card",
    "Wallet balance",
    "Refund",
    "Add Money",
    "Invented title mentioning Amazon Pay Wallet Add Money",
    "Amazon Pay Wallet Add Money extra",
  ])("ignores partial labels and payment/title text: %s", async (text) => {
    const evaluate = jest.fn();
    const diagnostics = trace();
    await recordWalletCardDiagnostic(
      { evaluate } as unknown as Locator,
      text,
      selector,
      diagnostics,
    );
    expect(evaluate).not.toHaveBeenCalled();
    expect(diagnostics.report(new Error()).events).toEqual([]);
  });
  test.each([
    label,
    `header\n${label}\nfooter`,
    `\tAmazon Pay Wallet Add Money\r\n`,
    "amazon pay wallet add money",
  ])("observes only a complete unverified label field", async (text) => {
    const evaluate = jest.fn(async () => 1);
    const diagnostics = trace();
    await recordWalletCardDiagnostic(
      { evaluate } as unknown as Locator,
      text,
      selector,
      diagnostics,
    );
    expect(evaluate).toHaveBeenCalledWith(expect.any(Function), selector, {
      timeout: 1500,
    });
    const report = diagnostics.report(new Error(privateText));
    expect(report.failure).toMatchObject({
      stage: "detail",
      reason: "DETAIL_ORDER_MISMATCH",
    });
    expect(report.events).toEqual([
      expect.objectContaining({
        stage: "list",
        reason: "LIST_WALLET_LABEL_UNVERIFIED",
        count: 1,
        orderIndex: 3,
      }),
    ]);
    expect(JSON.stringify(report)).not.toMatch(
      /PRIVATE_SENTINEL|cookie|user@example|untrusted-private|123\.45/,
    );
  });
  test.each([0, 2, -1, 8, "PRIVATE_SENTINEL"])(
    "sanitizes browser observations: %j",
    async (count) => {
      const diagnostics = trace();
      await recordWalletCardDiagnostic(
        { evaluate: async () => count } as unknown as Locator,
        label,
        selector,
        diagnostics,
      );
      const events = diagnostics.report(new Error()).events;
      if (count === 0) expect(events).toEqual([]);
      else {
        expect(events[0].reason).toBe(walletLabelDiagnostic(count));
        expect(events[0].count).toBe(count === 2 ? 2 : undefined);
        expect(JSON.stringify(events)).not.toContain("PRIVATE_SENTINEL");
      }
    },
  );
  test.each(["Error", "TimeoutError"])(
    "records safe %s failures without changing the root failure",
    async (name) => {
      const error = Object.assign(new Error(privateText), { name });
      const diagnostics = trace();
      await recordWalletCardDiagnostic(
        {
          evaluate: async () => {
            throw error;
          },
        } as unknown as Locator,
        label,
        selector,
        diagnostics,
      );
      const report = diagnostics.report(
        new DiagnosticError("detail", "DETAIL_ORDER_MISMATCH", privateText),
      );
      expect(report.failure).toEqual({
        stage: "detail",
        reason: "DETAIL_ORDER_MISMATCH",
        category: "validation",
      });
      expect(report.events[0]).toMatchObject({
        reason: "LIST_WALLET_EVIDENCE_UNAVAILABLE",
        category: name === "TimeoutError" ? "timeout" : "operation-failed",
      });
      expect(JSON.stringify(report)).not.toContain(privateText);
    },
  );
  test("does no additional DOM work without a diagnostics collector", async () => {
    const evaluate = jest.fn();
    await recordWalletCardDiagnostic(
      { evaluate } as unknown as Locator,
      label,
      selector,
    );
    expect(evaluate).not.toHaveBeenCalled();
  });
  test("bounds the preflight text without collecting it", async () => {
    const evaluate = jest.fn();
    const diagnostics = trace();
    await recordWalletCardDiagnostic(
      { evaluate } as unknown as Locator,
      "x".repeat(50001),
      selector,
      diagnostics,
    );
    expect(evaluate).not.toHaveBeenCalled();
    expect(diagnostics.report(new Error()).events[0]).toMatchObject({
      reason: "LIST_WALLET_EVIDENCE_UNAVAILABLE",
    });
  });
  test.each([1, 2, -1])(
    "persists only allowlisted observation additions: %s",
    async (count) => {
      const diagnostics = trace();
      await recordWalletCardDiagnostic(
        { evaluate: async () => count } as unknown as Locator,
        label,
        selector,
        diagnostics,
      );
      const directory = await makeTestDirectory("wallet-safe-report-");
      try {
        await writeFailureReport(
          diagnostics.report(
            new DiagnosticError("detail", "DETAIL_ORDER_MISMATCH", privateText),
          ),
          directory,
        );
        const [name] = await readdir(directory);
        const data = await readFile(join(directory, name), "utf8");
        const persisted = JSON.parse(data);
        expect(persisted.events[0].reason).toBe(walletLabelDiagnostic(count));
        expect(persisted.order.orderIndex).toBe(3);
        expect(data).not.toMatch(
          /PRIVATE_SENTINEL|cookie=secret|untrusted-private|123\.45|Amazon Pay|<html>|user@example/,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
