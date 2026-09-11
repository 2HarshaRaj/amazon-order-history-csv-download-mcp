import { mkdtemp, readFile } from "fs/promises";
import { existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import {
  createExportDocument,
  parseCliOptions,
  runExportWithBrowserLifecycle,
  validateAndWriteExport,
  writeExportFile,
} from "../../../src/poc/export-json";
import { AuthenticationRequiredError } from "../../../src/poc/hardened-index-v3";

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

  test("keeps Amazon OrderIDs separate and assigns stable deterministic line indexes", () => {
    const first = rawOrder("408-0000000-0000001");
    first.detail.items.push({
      ...first.detail.items[0],
      asin: "",
      productName: "Second sanitized product",
    });
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
