import { mkdtemp, readFile, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join, win32 } from "path";
import packageJson from "../../../package.json";

import {
  createExportDocument,
  parseCliOptions,
  runExport,
  runExportWithBrowserLifecycle,
  validateOutputPath,
  validateAndWriteExport,
  writeExportFile,
} from "../../../src/poc/export-json";
import {
  AuthenticationRequiredError,
  isAuthenticationRedirect,
  parseOrderSummaryAdjustments,
} from "../../../src/poc/hardened-index-v3";

const timestamp = "2026-09-11T00:00:00.000Z";
const options = { startDate: "2026-09-01", endDate: "2026-09-11" };

function rawOrder(orderId: string, quantity = 2) {
  return {
    summary: {
      orderId,
      orderDate: "2026-09-03",
      orderTotal: { amount: 200, currency: "INR", formatted: "₹200.00" },
    },
    detail: {
      orderId,
      extractionSource: "order-detail",
      itemCount: 1,
      adjustments: parseOrderSummaryAdjustments([]),
      items: [
        {
          asin: "B000000001",
          productName: "Sanitized product",
          quantity,
          unitPrice: { amount: 100, currency: "INR", formatted: "₹100.00" },
          itemTotal: { amount: 200, currency: "INR", formatted: "₹200.00" },
        },
      ],
    },
  };
}

describe("POC JSON export contract", () => {
  test("converts Money objects to numbers and retains quantity pricing semantics", () => {
    const result = createExportDocument(
      options,
      3,
      [rawOrder("408-0000000-0000001")],
      timestamp,
    );
    expect(result.metadata.pagesScanned).toBe(3);
    expect(result.orders[0].orderTotal).toBe(200);
    expect(result.orders[0].items[0]).toMatchObject({
      quantity: 2,
      unitPrice: 100,
      itemTotal: 200,
    });
    expect(typeof result.orders[0].items[0].unitPrice).toBe("number");
  });

  test("emits explicit adjustments and reconciles item plus marketplace fee", () => {
    const order = rawOrder("408-0000000-0000001", 1);
    order.summary.orderTotal.amount = 204;
    order.detail.items[0].unitPrice.amount = 199;
    order.detail.items[0].itemTotal.amount = 199;
    order.detail.adjustments = parseOrderSummaryAdjustments([
      "Item(s) Subtotal:  ₹199.00",
      "Item Subtotal:  ₹199.00",
      "Items Subtotal:  ₹199.00",
      "Shipping:  ₹0.00",
      "Marketplace Fee:  ₹5.00",
      "Total:  ₹204.00",
      "Grand Total:  ₹204.00",
    ]);
    const first = createExportDocument(options, 1, [order], timestamp);
    const second = createExportDocument(options, 1, [order], timestamp);
    expect(first.orders[0].adjustments).toEqual([
      expect.objectContaining({
        adjustmentIndex: 0,
        type: "shipping",
        label: "Shipping",
        amount: 0,
      }),
      expect.objectContaining({
        adjustmentIndex: 1,
        type: "marketplace_fee",
        label: "Marketplace Fee",
        amount: 5,
      }),
    ]);
    expect(second.orders[0].adjustments).toEqual(first.orders[0].adjustments);
  });

  test("makes discounts and promotions negative while excluding totals and private rows", () => {
    expect(
      parseOrderSummaryAdjustments([
        "Subtotal:  ₹220.00",
        "Discount:  ₹10.00",
        "Promotion Applied:  -₹5.00",
        "Payment method:  Visa ending 0000",
        "Gift card payment:  ₹2.00",
        "Delivery address:  Sanitized Street",
        "Tracking:  SANITIZED",
        "Tax:  ₹1.00",
        "Total:  ₹206.00",
      ]),
    ).toEqual([
      expect.objectContaining({
        type: "discount",
        amount: expect.objectContaining({ amount: -10 }),
      }),
      expect.objectContaining({
        type: "promotion",
        amount: expect.objectContaining({ amount: -5 }),
      }),
      expect.objectContaining({
        type: "tax",
        amount: expect.objectContaining({ amount: 1 }),
      }),
    ]);
  });

  test("prioritizes reducing semantics in shipping and delivery labels", () => {
    expect(
      parseOrderSummaryAdjustments([
        "Shipping Discount:  ₹10.00",
        "Delivery Promotion:  ₹5.00",
      ]),
    ).toEqual([
      expect.objectContaining({
        type: "discount",
        amount: expect.objectContaining({ amount: -10 }),
      }),
      expect.objectContaining({
        type: "promotion",
        amount: expect.objectContaining({ amount: -5 }),
      }),
    ]);
  });

  test("rejects invalid adjustment amounts without exposing their payload", () => {
    expect(() =>
      parseOrderSummaryAdjustments(["Marketplace Fee:  unavailable-secret"]),
    ).toThrow("Order-summary adjustment validation failed.");
  });

  test("accepts invoice fallback provenance and exactly one paise variance", () => {
    const order = rawOrder("408-0000000-0000001");
    order.detail.extractionSource = "invoice-safe-fallback";
    order.summary.orderTotal.amount = 200.01;
    expect(
      createExportDocument(options, 1, [order], timestamp).orders[0].items[0]
        .extractionSource,
    ).toBe("invoice-safe-fallback");
  });

  test("fails unexplained residual before replacing an existing destination", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amazon-poc-test-"));
    const output = join(directory, "orders.json");
    await writeFile(output, "unchanged", "utf8");
    const order = rawOrder("408-0000000-0000001");
    order.summary.orderTotal.amount = 200.02;
    await expect(
      validateAndWriteExport(output, options, 1, [order], timestamp),
    ).rejects.toThrow("does not reconcile within one paise");
    expect(await readFile(output, "utf8")).toBe("unchanged");
  });

  test("keeps Amazon OrderIDs separate and assigns stable deterministic line indexes", () => {
    const first = rawOrder("408-0000000-0000001");
    first.detail.items.push({
      ...first.detail.items[0],
      asin: "",
      productName: "Second sanitized product",
    });
    first.summary.orderTotal.amount = 400;
    const input = [first, rawOrder("408-0000000-0000002")];
    const runOne = createExportDocument(options, 1, input, timestamp);
    const runTwo = createExportDocument(options, 1, input, timestamp);
    expect(runOne.orders.map((order) => order.orderId)).toEqual([
      "408-0000000-0000001",
      "408-0000000-0000002",
    ]);
    expect(runOne.orders[0].items.map((item) => item.lineIndex)).toEqual([
      0, 1,
    ]);
    expect(runTwo.orders[0].items.map((item) => item.lineIndex)).toEqual([
      0, 1,
    ]);
  });

  test("writes valid UTF-8 JSON without sensitive fields", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amazon-poc-test-"));
    const output = join(directory, "nested", "orders.json");
    const document = createExportDocument(
      options,
      1,
      [rawOrder("408-0000000-0000001")],
      timestamp,
    );
    await writeExportFile(output, document);
    const text = await readFile(output, "utf8");
    expect(JSON.parse(text)).toEqual(document);
    expect(text).not.toMatch(
      /recipient|address|paymentMethod|card|tracking|cookie/i,
    );
  });

  test("fails validation before creating a file when a required price is missing", async () => {
    const directory = await mkdtemp(join(tmpdir(), "amazon-poc-test-"));
    const output = join(directory, "not-created", "orders.json");
    const invalid = rawOrder("408-0000000-0000001");
    delete (
      invalid.detail.items[0] as {
        unitPrice?: { amount: number; currency: string; formatted: string };
      }
    ).unitPrice;
    await expect(
      validateAndWriteExport(output, options, 1, [invalid], timestamp),
    ).rejects.toThrow("unit price");
    expect(existsSync(output)).toBe(false);
  });

  test("operational validation errors do not include personal payload fields", () => {
    const invalid = rawOrder("408-0000000-0000001");
    invalid.detail.items[0].productName = "";
    expect(() =>
      createExportDocument(options, 1, [invalid], timestamp),
    ).toThrow("invalid required item facts");
    try {
      createExportDocument(options, 1, [invalid], timestamp);
    } catch (error) {
      expect(String(error)).not.toContain("Sanitized product");
      expect(String(error)).not.toContain("408-0000000-0000001");
    }
  });
});

describe("POC CLI validation", () => {
  const root = join(tmpdir(), "repository-root");
  const outside = join(tmpdir(), "amazon-export.json");
  const args = (
    start: string,
    end: string,
    max = "20",
    output = outside,
  ): string[] => [
    "--start-date",
    start,
    "--end-date",
    end,
    "--max-orders",
    max,
    "--output",
    output,
  ];

  test.each([
    ["invalid calendar date", args("2026-02-30", "2026-09-11")],
    ["start after end", args("2026-09-12", "2026-09-11")],
    ["maximum over 50", args("2026-09-01", "2026-09-11", "51")],
    [
      "output inside repository",
      args("2026-09-01", "2026-09-11", "20", join(root, "orders.json")),
    ],
  ])("rejects %s", (_label, cliArgs) =>
    expect(() => parseCliOptions(cliArgs, root)).toThrow(),
  );

  test("defaults max-orders to 20 and requires an absolute outside output", () => {
    expect(
      parseCliOptions(
        [
          "--start-date",
          "2026-09-01",
          "--end-date",
          "2026-09-11",
          "--output",
          outside,
        ],
        root,
      ).maxOrders,
    ).toBe(20);
    expect(() =>
      parseCliOptions(
        args("2026-09-01", "2026-09-11", "20", "orders.json"),
        root,
      ),
    ).toThrow("absolute path outside");
  });

  test("accepts a Windows absolute output path containing spaces", () => {
    const output =
      "C:\\Users\\Example User\\AppData\\Local\\amazon-orders\\export.json";
    expect(
      validateOutputPath(
        output,
        "C:\\Users\\Example User\\source\\amazon-order-history-csv-download-mcp",
        win32,
      ),
    ).toBe(output);
  });

  test("rejects an in-repository path whose name begins with two dots", () => {
    expect(() =>
      validateOutputPath(join(root, "..private", "export.json"), root),
    ).toThrow("absolute path outside");
  });

  test("keeps forwarded CLI arguments out of the compound build command", () => {
    expect(packageJson.scripts["preexport:poc"]).toBe("npm run build --silent");
    expect(packageJson.scripts["export:poc"]).toBe(
      "node dist/poc/export-json.js",
    );
    expect(packageJson.scripts["export:poc"]).not.toContain("&&");
  });
});

describe("POC CLI browser lifecycle", () => {
  const cliOptions = {
    ...options,
    maxOrders: 20,
    output: join(tmpdir(), "amazon-export.json"),
  };

  test("leaves the browser open when authentication is required", async () => {
    const close = jest.fn<Promise<void>, []>().mockResolvedValue();
    const run = jest
      .fn<Promise<void>, [typeof cliOptions]>()
      .mockRejectedValue(new AuthenticationRequiredError());

    await expect(
      runExportWithBrowserLifecycle(cliOptions, { run, close }),
    ).rejects.toBeInstanceOf(AuthenticationRequiredError);
    expect(close).not.toHaveBeenCalled();
  });

  test.each([
    ["successful export", undefined],
    ["non-auth failure", new Error("sanitized operational failure")],
  ])("closes the browser after %s", async (_label, failure) => {
    const close = jest.fn<Promise<void>, []>().mockResolvedValue();
    const run = jest.fn<Promise<void>, [typeof cliOptions]>();
    if (failure) run.mockRejectedValue(failure);
    else run.mockResolvedValue();

    const result = runExportWithBrowserLifecycle(cliOptions, { run, close });
    if (failure) await expect(result).rejects.toBe(failure);
    else await expect(result).resolves.toBeUndefined();
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe("POC CLI diagnostic privacy", () => {
  test("suppresses payload-bearing extractor diagnostics while retaining bounded status", async () => {
    const personalPayload = {
      orderId: "408-1234567-7654321",
      asin: "B0PERSONAL1",
      productName: "Private product name",
      adjustmentLabel: "Sanitized Marketplace Fee",
      price: "₹1,234.56",
    };
    const logs: string[] = [];
    const diagnosticMessages: string[] = [];
    const order = rawOrder(personalPayload.orderId);
    order.detail.items[0].asin = personalPayload.asin;
    order.detail.items[0].productName = personalPayload.productName;

    await runExport(
      {
        ...options,
        maxOrders: 1,
        output: join(tmpdir(), "privacy-safe-export.json"),
      },
      (message) => logs.push(message),
      {
        list: jest.fn().mockResolvedValue({
          pagesScanned: 1,
          orders: [order.summary],
        }),
        extract: jest.fn().mockImplementation(async (_orderId, diagnostics) => {
          const diagnostic = `[items] Found item ${personalPayload.asin} - ${personalPayload.productName} - ${personalPayload.price}; adjustment ${personalPayload.adjustmentLabel}; order ${personalPayload.orderId}`;
          diagnosticMessages.push(diagnostic);
          diagnostics(diagnostic);
          return order.detail;
        }),
        write: jest.fn().mockResolvedValue({ metadata: {}, orders: [order] }),
      },
    );

    expect(diagnosticMessages).toHaveLength(1);
    const consoleOutput = logs.join("\n");
    expect(consoleOutput).toContain("Inspected 1 order-list page(s)");
    expect(consoleOutput).toContain("Export complete: wrote 1 order(s)");
    for (const value of Object.values(personalPayload)) {
      expect(consoleOutput).not.toContain(value);
    }
  });
});

describe("Amazon.in authentication redirects", () => {
  test.each([
    "https://www.amazon.in/ap/signin?openid.return_to=%2Fyour-orders",
    "https://www.amazon.in/ap/cvf",
    "https://www.amazon.in/ap/cvf/request?arb=example",
  ])("recognizes %s as requiring authentication", (url) => {
    expect(isAuthenticationRedirect(url)).toBe(true);
  });

  test.each([
    "https://www.amazon.in/your-orders/orders?timeFilter=year-2026",
    "https://www.amazon.in/gp/your-account/order-details?orderID=example",
    "https://www.amazon.in/example?next=%2Fap%2Fsignin",
    "not-a-url",
  ])("does not classify %s as an authentication redirect", (url) => {
    expect(isAuthenticationRedirect(url)).toBe(false);
  });
});
