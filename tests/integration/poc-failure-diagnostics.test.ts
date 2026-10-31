/** Synthetic pipeline integration: actual list/detail/validation/writers, a fake
 * Playwright transport, and temporary local files. Never opens a live browser. */
import { existsSync } from "fs";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { chromium, BrowserContext, Page } from "playwright";
import * as items from "../../src/amazon/extractors/items";
import type { Item } from "../../src/core/types/item";
import {
  runExport,
  runExportWithBrowserLifecycle,
  validateAndWriteExport,
} from "../../src/poc/export-json";
import {
  AuthenticationRequiredError,
  closeBrowser,
  extractOrderItems,
  listOrders,
} from "../../src/poc/hardened-index-v3";
import {
  FailureReport,
  writeFailureReport,
} from "../../src/poc/failure-diagnostics";

const orderId = "408-0000000-0000001";
const privateError = new Error(
  "PRIVATE_EXCEPTION cookie=secret OTP=123456 buyer@upi <html>private</html>",
);
const syntheticItem = {
  asin: "B000000001",
  name: "Synthetic notebook",
  quantity: 2,
  unitPrice: { amount: 100, currency: "INR", formatted: "₹100.00" },
  totalPrice: { amount: 200, currency: "INR", formatted: "₹200.00" },
} as Item;

type Scenario =
  | "success"
  | "browser"
  | "list-navigation"
  | "list-selector"
  | "list-facts"
  | "missing-total"
  | "ambiguous-total"
  | "detail"
  | "adjustments"
  | "items"
  | "invoice-navigation"
  | "invoice-selector"
  | "invoice-extraction"
  | "invoice-success"
  | "reconciliation"
  | "output"
  | "auth";

function fakeBrowser(scenario: Scenario) {
  let currentUrl = "https://www.amazon.in/your-orders/orders";
  const goto = jest.fn(async (url: string) => {
    if (
      (scenario === "list-navigation" && url.includes("your-orders")) ||
      (scenario === "detail" && url.includes("order-details")) ||
      (scenario === "invoice-navigation" && url.includes("print.html"))
    )
      throw privateError;
    currentUrl = scenario === "auth" ? "https://www.amazon.in/ap/signin" : url;
    return null;
  });
  const locator = (selector: string) => {
    const isCard = selector.includes(".js-order-card");
    const isSummary = selector === "#od-subtotals";
    if (isSummary)
      return {
        first() {
          return this;
        },
        count: async () => 1,
        isVisible: async () => true,
        evaluate: async () => true,
        getByText: () => ({
          count: async () => 1,
          nth: () => ({
            isVisible: async () => true,
            evaluate: async (_callback: unknown, selector?: string) =>
              !selector || selector === orderId,
            locator: () => ({ count: async () => 0 }),
            innerText: async () =>
              `Grand Total ₹${scenario === "reconciliation" ? "200.02" : "200.00"}`,
          }),
        }),
        locator: () => ({
          allInnerTexts: async () =>
            scenario === "adjustments"
              ? ["Shipping:  ₹0.00", "Marketplace Fee:  PRIVATE_BAD_AMOUNT"]
              : [
                  "Shipping:  ₹0.00",
                  "Payment method:  Visa ending 9999",
                  "UPI:  buyer@upi",
                ],
        }),
      };
    return {
      first() {
        return this;
      },
      count: async () => (isCard || isSummary ? 1 : 0),
      nth: () => ({
        isVisible: async () => true,
        evaluate: async () => false, // top-level card ownership
        locator: (nestedSelector: string) =>
          nestedSelector.includes("/uff/")
            ? { count: async () => 0 }
            : {
                count: async () => (scenario === "missing-total" ? 0 : 1),
                nth: () => ({
                  isVisible: async () => true,
                  innerText: async () =>
                    scenario === "list-facts"
                      ? "unrecognized synthetic card"
                      : "Order placed 1 October 2026\n" + orderId,
                  getByText: () => ({
                    count: async () => (scenario === "ambiguous-total" ? 2 : 1),
                    nth: (index: number) => ({
                      locator: () => ({ count: async () => 0 }),
                      isVisible: async () => true,
                      evaluate: async (_callback: unknown, selector: string) =>
                        selector.startsWith(".order-header"),
                      innerText: async () =>
                        `Total\n₹${index ? "125.00" : scenario === "reconciliation" ? "200.02" : "200.00"}`,
                    }),
                  }),
                }),
              },
        innerText: async () =>
          scenario === "list-facts"
            ? "unrecognized synthetic card"
            : `Order placed\n1 October 2026\nTotal\n₹${scenario === "reconciliation" ? "200.02" : "200.00"}\n${orderId}`,
      }),
      locator: () => ({
        allInnerTexts: async () =>
          scenario === "adjustments"
            ? ["Shipping:  ₹0.00", "Marketplace Fee:  PRIVATE_BAD_AMOUNT"]
            : [
                "Shipping:  ₹0.00",
                "Payment method:  Visa ending 9999",
                "UPI:  buyer@upi",
              ],
      }),
    };
  };
  const page = {
    goto,
    url: () => currentUrl,
    isClosed: () => false,
    locator,
    waitForSelector: async (selector: string) => {
      if (
        (scenario === "list-selector" && selector.includes(".js-order-card")) ||
        (scenario === "invoice-selector" && selector.endsWith(", table"))
      )
        throw privateError;
    },
  } as unknown as Page;
  let onClose: () => void = () => {};
  const context = {
    pages: () => [page],
    on: (_event: string, callback: () => void) => {
      onClose = callback;
    },
    browser: () => ({ version: () => "123.0.0.0" }),
    close: async () => {
      onClose();
    },
  } as unknown as BrowserContext;
  const launch = jest.spyOn(chromium, "launchPersistentContext");
  if (scenario === "browser") launch.mockRejectedValue(privateError);
  else launch.mockResolvedValue(context);
  const detail = jest
    .spyOn(items, "extractItems")
    .mockImplementation(async (_page, _header, diagnostics) => {
      diagnostics?.(
        "Strategy4 (2024+ data-component) failed: PRIVATE_RAW_ERROR",
      );
      if (
        [
          "items",
          "invoice-navigation",
          "invoice-selector",
          "invoice-extraction",
          "invoice-success",
        ].includes(scenario)
      )
        throw privateError;
      return [syntheticItem];
    });
  const invoice = jest.spyOn(items, "extractDataComponentItems");
  if (scenario === "invoice-extraction")
    invoice.mockRejectedValue(privateError);
  else
    invoice.mockResolvedValue(
      scenario === "invoice-success" ? [syntheticItem] : null,
    );
  return { goto, launch, detail, invoice };
}

describe("hardened POC failure diagnostics pipeline", () => {
  let directory: string;
  let output: string;
  let reports: string;
  let logs: string[];
  beforeEach(async () => {
    directory = await mkdtemp(
      join(tmpdir(), "amazon-diagnostics-integration-"),
    );
    output = join(directory, "orders.json");
    reports = join(directory, "reports");
    logs = [];
  });
  afterEach(async () => {
    await closeBrowser();
    jest.restoreAllMocks();
    await rm(directory, { recursive: true, force: true });
  });

  const cases: Array<[Scenario, string, string]> = [
    ["browser", "browser", "BROWSER_OPEN_FAILED"],
    ["list-navigation", "list", "LIST_NAVIGATION_FAILED"],
    ["list-selector", "list", "LIST_SELECTOR_MISSING"],
    ["list-facts", "list", "LIST_FACTS_MISSING"],
    ["missing-total", "list", "LIST_TOTAL_MISSING"],
    ["ambiguous-total", "list", "LIST_TOTAL_AMBIGUOUS"],
    ["detail", "detail", "DETAIL_NAVIGATION_FAILED"],
    ["adjustments", "adjustments", "ADJUSTMENT_AMOUNT_INVALID"],
    ["items", "items", "ITEMS_EMPTY"],
    ["invoice-navigation", "invoice", "INVOICE_NAVIGATION_FAILED"],
    ["invoice-selector", "items", "ITEMS_EMPTY"],
    ["invoice-extraction", "items", "ITEMS_EMPTY"],
    ["reconciliation", "reconciliation", "TOTAL_MISMATCH"],
    ["output", "output", "OUTPUT_WRITE_FAILED"],
    ["auth", "list", "AUTHENTICATION_REQUIRED"],
  ];

  test.each(cases)(
    "captures %s safely without publishing an export",
    async (scenario, stage, reason) => {
      const browser = fakeBrowser(scenario);
      if (scenario === "output") await mkdir(output);
      const run = runExport(
        {
          startDate: "2026-10-01",
          endDate: "2026-10-02",
          maxOrders: 1,
          output,
        },
        (message) => logs.push(message),
        {
          list: listOrders,
          extract: extractOrderItems,
          write: validateAndWriteExport,
          report: (evidence) => writeFailureReport(evidence, reports),
          cleanup: async () => {},
        },
      );
      if (scenario === "auth")
        await expect(run).rejects.toBeInstanceOf(AuthenticationRequiredError);
      else await expect(run).rejects.toThrow();
      const names = await readdir(reports);
      expect(names).toHaveLength(1);
      const text = await readFile(join(reports, names[0]), "utf8");
      const evidence = JSON.parse(text) as FailureReport;
      expect(evidence.failure).toMatchObject({ stage, reason });
      expect(text).not.toMatch(
        /PRIVATE_|secret|123456|buyer@upi|Visa|9999|<html>/,
      );
      expect(logs.join("\n")).toContain(`stage=${stage}; code=${reason}`);
      expect(logs.join("\n")).not.toMatch(
        /408-|B000|notebook|200\.02|PRIVATE_|cookie|123456|buyer@upi|Visa/,
      );
      expect(
        (await readdir(directory)).filter((name) => name.endsWith(".tmp")),
      ).toHaveLength(0);
      if (scenario !== "output") expect(existsSync(output)).toBe(false);
      else expect(await readdir(output)).toEqual([]);
      if (
        [
          "missing-total",
          "ambiguous-total",
          "detail",
          "adjustments",
          "items",
          "invoice-navigation",
          "invoice-selector",
          "invoice-extraction",
          "reconciliation",
          "output",
        ].includes(scenario)
      )
        expect(evidence.order).toMatchObject({
          orderId,
          orderIndex: 0,
          orderDate: "2026-10-01",
        });
      if (
        evidence.order &&
        scenario !== "missing-total" &&
        scenario !== "ambiguous-total"
      ) {
        expect(evidence.order.orderTotalPaise).toBe(
          scenario === "reconciliation" ? 20002 : 20000,
        );
      }
      if (scenario === "reconciliation")
        expect(evidence.reconciliation?.differencePaise).toBe(-2);
      if (scenario === "invoice-selector")
        expect(evidence.events).toContainEqual(
          expect.objectContaining({
            stage: "invoice",
            reason: "INVOICE_SELECTOR_MISSING",
          }),
        );
      if (scenario === "invoice-extraction")
        expect(evidence.events).toContainEqual(
          expect.objectContaining({
            stage: "invoice",
            reason: "INVOICE_EXTRACTION_FAILED",
          }),
        );
      if (scenario !== "browser")
        expect(browser.launch).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({ headless: false }),
        );
      for (const [url] of browser.goto.mock.calls)
        expect(url).toMatch(
          /(?:your-orders\/orders|order-details|summary\/print\.html)/,
        );
    },
  );

  test.each(["success", "invoice-success"] as Scenario[])(
    "preserves the %s export contract and only runs retention",
    async (scenario) => {
      fakeBrowser(scenario);
      const report = jest.fn();
      const cleanup = jest.fn(async () => {
        throw privateError;
      });
      await runExport(
        {
          startDate: "2026-10-01",
          endDate: "2026-10-02",
          maxOrders: 1,
          output,
        },
        (message) => logs.push(message),
        {
          list: listOrders,
          extract: extractOrderItems,
          write: validateAndWriteExport,
          report,
          cleanup,
        },
      );
      const document = JSON.parse(await readFile(output, "utf8"));
      expect(Object.keys(document).sort()).toEqual(["metadata", "orders"]);
      expect(document.orders[0].items[0]).toMatchObject({
        productName: "Synthetic notebook",
        itemTotal: 200,
        extractionSource:
          scenario === "success" ? "order-detail" : "invoice-safe-fallback",
      });
      expect(report).not.toHaveBeenCalled();
      expect(cleanup).toHaveBeenCalledTimes(1);
      expect(existsSync(reports)).toBe(false);
      expect(logs.join("\n")).not.toContain("Synthetic notebook");
    },
  );

  test.each(["root", "nested"])(
    "a rejected %s report cannot obscure the export error or leak data",
    async (location) => {
      fakeBrowser("detail");
      await writeFile(output, "prior complete export");
      await expect(
        runExport(
          {
            startDate: "2026-10-01",
            endDate: "2026-10-02",
            maxOrders: 1,
            output,
          },
          (message) => logs.push(message),
          {
            list: listOrders,
            extract: extractOrderItems,
            write: validateAndWriteExport,
            report: (evidence) =>
              writeFailureReport(
                location === "root"
                  ? { ...evidence, cookie: "PRIVATE_BOUNDARY_COOKIE" }
                  : {
                      ...evidence,
                      order: {
                        ...evidence.order,
                        recipient: "PRIVATE_BOUNDARY_RECIPIENT",
                      },
                    },
                reports,
              ),
          },
        ),
      ).rejects.toBe(privateError);
      expect(await readFile(output, "utf8")).toBe("prior complete export");
      expect(existsSync(reports)).toBe(false);
      expect(logs.join("\n")).toContain(
        "stage=detail; code=DETAIL_NAVIGATION_FAILED",
      );
      expect(logs.join("\n")).toContain("report unavailable");
      expect(logs.join("\n")).not.toMatch(
        /PRIVATE_|cookie|123456|buyer@upi|408-|notebook|stack|recipient/,
      );
    },
  );

  test("report and browser-close errors cannot obscure the original failure or replace a prior export", async () => {
    fakeBrowser("detail");
    await writeFile(output, "prior complete export");
    const run = () =>
      runExport(
        {
          startDate: "2026-10-01",
          endDate: "2026-10-02",
          maxOrders: 1,
          output,
        },
        (message) => logs.push(message),
        {
          list: listOrders,
          extract: extractOrderItems,
          write: validateAndWriteExport,
          report: async () => {
            throw new Error("PRIVATE_WRITER_ERROR");
          },
        },
      );
    await expect(
      runExportWithBrowserLifecycle(
        {
          startDate: "2026-10-01",
          endDate: "2026-10-02",
          maxOrders: 1,
          output,
        },
        {
          run,
          close: async () => {
            throw new Error("PRIVATE_CLOSE_ERROR");
          },
        },
      ),
    ).rejects.toBe(privateError);
    expect(await readFile(output, "utf8")).toBe("prior complete export");
    expect(logs.join("\n")).toContain("report unavailable");
    expect(logs.join("\n")).not.toContain("PRIVATE_");
  });
});
