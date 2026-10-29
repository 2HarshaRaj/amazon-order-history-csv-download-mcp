import {
  NowSnapshot,
  parseNowSnapshot,
  validateNowSplitScope,
} from "../../../src/poc/amazon-now";

const id = "111-2222222-3333333";
const manifest = (): NowSnapshot["items"] => [
  {
    parts: ["Invented split lentils", "Qty: 1"],
    alts: [],
    hrefs: ["https://www.amazon.in/dp/B0SPLT0001"],
  },
  {
    parts: ["Invented split rice", "Qty: 1"],
    alts: [],
    hrefs: ["https://www.amazon.in/dp/B0SPLT0002"],
  },
];
const snapshot = (): NowSnapshot => ({
  orderIds: [id],
  items: manifest().map((item, index) => ({
    ...item,
    parts: [...item.parts, index ? "₹17.00" : "₹11.00"],
  })),
  billRows: [
    "Items total ₹28.00",
    "Handling fee ₹2.00",
    "Delivery fee Free",
    "You pay ₹30.00",
  ],
});
const listed = { amount: 30, currency: "INR" };

describe("selected-order split scope (pure corroboration, no aggregation)", () => {
  test("corroborates both deliveries regardless of dialog row order", () => {
    const facts = snapshot();
    facts.items.reverse();
    const detail = parseNowSnapshot(facts, id);
    expect(() =>
      validateNowSplitScope(manifest(), facts, detail, listed),
    ).not.toThrow();
    expect(detail.items.map((item) => item.itemTotal.amount)).toEqual([17, 11]);
    expect(detail.orderTotal.amount).toBe(30);
    expect(JSON.stringify(detail)).not.toMatch(
      /sourceItems|splitScope|Delivery/,
    );
  });
  test.each([
    "missing",
    "omitted",
    "duplicate",
    "name",
    "quantity",
    "identifier",
    "untrustedUrl",
    "extraFields",
  ])("rejects %s source merchandise", (mode) => {
    const source = manifest();
    if (mode === "missing") source.length = 0;
    if (mode === "omitted") source.pop();
    if (mode === "duplicate") source[1] = source[0];
    if (mode === "name") source[0].parts[0] = "Different invented item";
    if (mode === "quantity") source[0].parts[1] = "Qty: 2";
    if (mode === "identifier")
      source[0].hrefs[0] = "https://www.amazon.in/dp/B0SPLT0099";
    if (mode === "untrustedUrl") source[0].hrefs[0] += "?redirect=1";
    if (mode === "extraFields") source[0].parts.push("Qty: 2");
    const facts = snapshot();
    expect(() =>
      validateNowSplitScope(source, facts, parseNowSnapshot(facts, id), listed),
    ).toThrow();
  });
  test.each([
    undefined,
    { amount: 11, currency: "INR" },
    { amount: 30.01, currency: "INR" },
    { amount: 30, currency: "USD" },
    { amount: NaN, currency: "INR" },
  ])("requires the independent selected listed total: %j", (total) => {
    const facts = snapshot();
    expect(() =>
      validateNowSplitScope(
        manifest(),
        facts,
        parseNowSnapshot(facts, id),
        total,
      ),
    ).toThrow();
  });
  test.each([
    "absent",
    "wrongItemsTotal",
    "subtotal",
    "duplicateChargeKind",
    "duplicatePluralFee",
  ])("rejects %s whole-order bill evidence", (mode) => {
    const facts = snapshot();
    if (mode === "absent") facts.billRows.shift();
    if (mode === "wrongItemsTotal") facts.billRows[0] = "Items total ₹11.00";
    if (mode === "subtotal") facts.billRows.push("Subtotal ₹28.00");
    if (mode === "duplicateChargeKind")
      facts.billRows.push("Shipping fee Free");
    if (mode === "duplicatePluralFee")
      facts.billRows.push("Delivery fees Free");
    expect(() =>
      validateNowSplitScope(
        manifest(),
        facts,
        parseNowSnapshot(facts, id),
        listed,
      ),
    ).toThrow();
  });
});
