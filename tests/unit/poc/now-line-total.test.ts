import {
  parseNowSnapshot,
  validateNowSelectedOrder,
  NowSnapshot,
} from "../../../src/poc/amazon-now";
import {
  NOW_LINE_TOTAL_ONLY,
  NowPrintableProof,
  nowLinePaise,
  validateNowPrintableProof,
} from "../../../src/poc/now-line-total";
import { createExportDocument } from "../../../src/poc/export-json";
import { FailureDiagnostics } from "../../../src/poc/failure-diagnostics";

const id = "111-2222222-3333333";
const facts = (): NowSnapshot => ({
  orderIds: [id],
  declaredItemCount: 3,
  declaredItemCountIsUnits: true,
  items: [
    {
      parts: ["Invented stamp", "2 units", "₹13.01"],
      alts: ["B0LINE0001"],
      hrefs: [],
      lineTotalCandidateDomVerified: true,
    },
    {
      parts: ["Invented notebook", "1 unit", "₹18.00"],
      alts: ["B0LINE0002"],
      hrefs: [],
    },
  ],
  billRows: ["Items total ₹31.01", "Handling fee ₹1.00", "You pay ₹32.01"],
});
const proof = (): NowPrintableProof => ({
  source: "selected-order-printable-summary",
  orderId: id,
  items: [
    { asin: "B0LINE0001", quantity: 2, itemTotalPaise: 1301 },
    { asin: "B0LINE0002", quantity: 1, itemTotalPaise: 1800 },
  ],
});
const detail = () => parseNowSnapshot(facts(), id, undefined, proof());
function order(): Parameters<typeof createExportDocument>[2][number] {
  return {
    summary: {
      orderId: id,
      orderDate: "2026-10-02",
      orderTotal: { amount: 32.01, currency: "INR", formatted: "₹32.01" },
      nowDetailUrl: `https://www.amazon.in/uff/your-account/order-details?orderID=${id}`,
    },
    detail: detail(),
  };
}
const document = (o = order()) =>
  createExportDocument(
    { startDate: "2026-10-01", endDate: "2026-10-30" },
    1,
    [o],
    "2026-10-31T00:00:00Z",
  );

describe("verified line totals without unit price inference", () => {
  test("retains an indivisible line amount, distinct rows, numeric adjustment and explicit JSON null", () => {
    const o = order();
    const parsed = detail();
    validateNowSelectedOrder(facts(), parsed, {
      amount: 32.01,
      currency: "INR",
    });
    expect(parsed.items[0].unitPrice).toBeUndefined();
    expect(parsed.items[1].unitPrice?.amount).toBe(18);
    const exported = document(o).orders[0];
    expect(exported.items[0]).toEqual({
      lineIndex: 0,
      asin: "B0LINE0001",
      productName: "Invented stamp",
      quantity: 2,
      unitPrice: null,
      itemTotal: 13.01,
      currency: "INR",
      extractionSource: NOW_LINE_TOTAL_ONLY,
    });
    expect(exported.items[1].extractionSource).toBe("amazon-now-order-details");
    expect(exported.adjustments[0].amount).toBe(1);
    expect(JSON.stringify(exported)).not.toMatch(
      /verifiedLineTotal|printable|itemTotalPaise/,
    );
  });
  test("marks private diagnostics without substituting zero for unknown unit price", () => {
    const trace = new FailureDiagnostics();
    trace.detail(detail());
    const report = trace.report(new Error("synthetic"));
    expect(report.items[0]).toMatchObject({
      itemTotalPaise: 1301,
      extractionSource: NOW_LINE_TOTAL_ONLY,
    });
    expect(report.items[0].unitPricePaise).toBeUndefined();
  });
  test("an unqualified amount is rejected without the separate printable proof", () => {
    expect(() => parseNowSnapshot(facts(), id)).toThrow();
  });
  test("a separate summary cannot authorize an unproven tracking row", () => {
    const f = facts();
    delete f.items[0].lineTotalCandidateDomVerified;
    expect(() => parseNowSnapshot(f, id, undefined, proof())).toThrow();
  });
  test.each([0, 1300, 1302])(
    "accepts independently matched nonnegative exact line paise %s without averaging",
    (value) => {
      const f = facts(),
        p = proof();
      f.items[0].parts[2] = `₹${(value / 100).toFixed(2)}`;
      p.items[0].itemTotalPaise = value;
      f.billRows = [
        `Items total ₹${((value + 1800) / 100).toFixed(2)}`,
        `You pay ₹${((value + 1800) / 100).toFixed(2)}`,
      ];
      expect(
        parseNowSnapshot(f, id, undefined, p).items[0].itemTotal.amount,
      ).toBe(value / 100);
    },
  );
  test.each([
    "order",
    "asin",
    "quantity",
    "amount",
    "duplicate",
    "missing",
    "extra",
    "negative",
    "unsafe",
  ])("rejects %s proof conflict", (kind) => {
    const p = proof();
    if (kind === "order") p.orderId = "111-2222222-4444444";
    if (kind === "asin") p.items[0].asin = "B0LINE9999";
    if (kind === "quantity") p.items[0].quantity = 1;
    if (kind === "amount") p.items[0].itemTotalPaise++;
    if (kind === "duplicate") p.items[1] = { ...p.items[0] };
    if (kind === "missing") p.items.pop();
    if (kind === "extra")
      p.items.push({ asin: "B0LINE0003", quantity: 1, itemTotalPaise: 0 });
    if (kind === "negative") p.items[0].itemTotalPaise = -1;
    if (kind === "unsafe") p.items[0].quantity = Number.MAX_SAFE_INTEGER + 1;
    expect(() => parseNowSnapshot(facts(), id, undefined, p)).toThrow();
  });
  test.each([undefined, 2, 4])(
    "qualified purchased count %s cannot discard or invent units",
    (count) => {
      const f = facts();
      f.declaredItemCount = count;
      expect(() =>
        validateNowSelectedOrder(
          f,
          parseNowSnapshot(f, id, undefined, proof()),
          { amount: 32.01, currency: "INR" },
        ),
      ).toThrow();
    },
  );
  test("plain count cannot acquire qualified unit semantics", () => {
    const f = facts();
    delete f.declaredItemCountIsUnits;
    expect(() => parseNowSnapshot(f, id, undefined, proof())).toThrow();
  });
  test.each([
    "unit label",
    "two prices",
    "no identity",
    "identity conflict",
    "duplicate quantity",
    "extra name",
    "unproven Pc",
  ])("rejects ambiguous tracking %s", (kind) => {
    const f = facts(),
      item = f.items[0];
    if (kind === "unit label") item.parts[2] = "Unit price: ₹13.01";
    if (kind === "two prices") item.parts.push("₹14.01");
    if (kind === "no identity") item.alts = [];
    if (kind === "identity conflict")
      item.hrefs = ["https://www.amazon.in/dp/B0LINE9999"];
    if (kind === "duplicate quantity") item.parts.push("2 units");
    if (kind === "extra name") item.parts.unshift("Another invented product");
    if (kind === "unproven Pc") item.parts.splice(1, 0, "1 Pc", ".");
    expect(() => parseNowSnapshot(f, id, undefined, proof())).toThrow();
  });
  test("reconciliation remains mandatory", () => {
    const f = facts();
    f.billRows[2] = "You pay ₹32.03";
    expect(() => parseNowSnapshot(f, id, undefined, proof())).toThrow();
  });
  test.each([
    "missing provenance",
    "wrong provenance",
    "numeric unit",
    "ordinary order",
    "cancelled",
    "missing certificate",
    "foreign certificate",
    "wrong certificate amount",
    "fractional paise total",
    "null total",
    "null order",
  ])("export rejects %s", (kind) => {
    const o = order();
    const item = o.detail.items[0] as unknown as Record<string, unknown>;
    if (kind === "missing provenance") delete item.extractionSource;
    if (kind === "wrong provenance") item.extractionSource = "order-detail";
    if (kind === "numeric unit")
      item.unitPrice = { amount: 0, currency: "INR" };
    if (kind === "ordinary order") delete o.summary.nowDetailUrl;
    if (kind === "cancelled") o.summary.status = "cancelled";
    if (kind === "missing certificate") delete item.verifiedLineTotal;
    if (kind === "foreign certificate")
      (item.verifiedLineTotal as Record<string, unknown>).orderId =
        "111-2222222-4444444";
    if (kind === "wrong certificate amount")
      (item.verifiedLineTotal as Record<string, unknown>).itemTotalPaise = 1300;
    if (kind === "fractional paise total")
      (item.itemTotal as Record<string, unknown>).amount = 13.0101;
    if (kind === "null total") item.itemTotal = null;
    if (kind === "null order") o.detail.orderTotal = undefined;
    expect(() => document(o)).toThrow();
  });
  test.each(["₹0", "₹1,234.56", "INR 2.00"])(
    "reads canonical paise %s",
    (value) => expect(Number.isSafeInteger(nowLinePaise(value))).toBe(true),
  );
  test.each([
    "₹01",
    "₹-1",
    "-₹1",
    "₹1.001",
    "₹1e2",
    "₹1,23",
    "₹NaN",
    "₹90071992547409.92",
    "",
  ])("rejects noncanonical or unsafe amount %s", (value) =>
    expect(() => nowLinePaise(value)).toThrow(),
  );
  test("complete proof uses identity, not row position", () => {
    const p = proof();
    p.items.reverse();
    expect(validateNowPrintableProof(p, id, proof().items)).toEqual(p);
  });
});
