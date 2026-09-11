import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { Money } from "../../../src/core/types/money";
import { Item } from "../../../src/core/types/item";
import {
  EnrichedOrder,
  FetchOrdersResult,
} from "../../../src/tools/fetch-orders";
import {
  createPocExport,
  writePocExport,
} from "../../../src/poc/export-contract";

const money = (amount: number): Money => ({
  amount,
  currency: "INR",
  currencySymbol: "₹",
  formatted: `₹${amount}`,
});

function fixture(orderIds = ["408-0000000-0000001"]): FetchOrdersResult {
  const orders: EnrichedOrder[] = orderIds.map((orderId) => ({
    id: orderId,
    orderId,
    date: new Date(2026, 8, 3),
    total: money(300),
    detailUrl: `https://www.amazon.in/gp/your-account/order-details?orderID=${orderId}`,
    platform: "amazon",
    region: "in",
  }));
  const items: Item[] = orders.flatMap((order) => [
    {
      id: "line-a",
      asin: "B000000001",
      name: "Sanitized item A",
      quantity: 2,
      unitPrice: money(100),
      totalPrice: money(200),
      url: "https://www.amazon.in/dp/B000000001",
      orderHeader: order,
      platformData: { source: "order-detail" },
    },
    {
      id: "line-b",
      name: "Sanitized item B",
      quantity: 1,
      unitPrice: money(100),
      totalPrice: money(100),
      url: "",
      orderHeader: order,
      platformData: {},
    },
  ]);
  return {
    orders,
    items,
    shipments: [],
    transactions: [],
    totalFound: orders.length,
    errors: [],
    pagesScanned: 3,
  };
}

describe("POC JSON producer boundary", () => {
  test("converts Money objects and preserves quantity, distinct totals, and actual page count", () => {
    const payload = createPocExport(
      fixture(),
      "2026-09-01",
      "2026-09-11",
      new Date("2026-09-11T00:00:00.000Z"),
    );
    expect(payload.metadata.pagesScanned).toBe(3);
    expect(payload.orders[0]).toMatchObject({
      orderTotal: 300,
      currency: "INR",
    });
    expect(payload.orders[0].items[0]).toMatchObject({
      quantity: 2,
      unitPrice: 100,
      itemTotal: 200,
    });
  });

  test("keeps multiple Amazon OrderIDs separate", () => {
    const payload = createPocExport(
      fixture(["408-1", "408-2"]),
      "2026-09-01",
      "2026-09-11",
    );
    expect(payload.orders.map((order) => order.orderId)).toEqual([
      "408-1",
      "408-2",
    ]);
  });

  test("assigns deterministic unique line indexes", () => {
    const input = fixture();
    const first = createPocExport(input, "2026-09-01", "2026-09-11");
    const second = createPocExport(input, "2026-09-01", "2026-09-11");
    expect(first.orders[0].items.map((item) => item.lineIndex)).toEqual([0, 1]);
    expect(second.orders[0].items.map((item) => item.lineIndex)).toEqual([
      0, 1,
    ]);
  });

  test("fails before writing when a required total is missing", async () => {
    const input = fixture();
    input.orders[0].total = undefined as unknown as Money;
    const output = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), "poc-export-")),
      "orders.json",
    );
    expect(() => createPocExport(input, "2026-09-01", "2026-09-11")).toThrow(
      "order total",
    );
    await expect(fs.access(output)).rejects.toBeDefined();
  });

  test("writes valid JSON without logging the sensitive payload", async () => {
    const output = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), "poc-export-")),
      "nested",
      "orders.json",
    );
    const payload = createPocExport(fixture(), "2026-09-01", "2026-09-11");
    const errorSpy = jest
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const logSpy = jest
      .spyOn(console, "log")
      .mockImplementation(() => undefined);
    await writePocExport(output, payload);
    expect(JSON.parse(await fs.readFile(output, "utf8"))).toEqual(payload);
    expect(errorSpy).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });
});
