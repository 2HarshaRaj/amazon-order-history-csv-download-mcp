import {
  NOW_ITEM_COUNT_LABEL,
  NowSnapshot,
  parseNowSnapshot,
  validateNowSelectedOrder,
} from "../../../src/poc/amazon-now";

const id = "111-2222222-3333333";
const sampleItems = (): NowSnapshot["items"] => [
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
  declaredItemCount: 2,
  items: sampleItems().map((item, index) => ({
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

describe("anchored, normalized Amazon Now item-count label grammar", () => {
  test.each([
    ["1 item", 1],
    ["1 items", 1],
    ["7 items", 7],
    ["1 item in order", 1],
    ["7 items in order", 7],
    ["7 item", 7],
    ["1 items in order", 1],
    ["7 item in order", 7],
    ["100 items in order", 100],
    ["99 items", 99],
    ["  7\titems\n in\u00a0order  ", 7],
    ["1 ITEM IN ORDER", 1],
  ])("captures only the validated integer from %j", (label, expected) => {
    const normalized = String(label).replace(/\s+/g, " ").trim();
    expect(NOW_ITEM_COUNT_LABEL.exec(normalized)?.[1]).toBe(String(expected));
  });
  test.each([
    "",
    "item in order",
    "0 items",
    "00 items in order",
    "01 item",
    "07 items in order",
    "-1 item in order",
    "+1 item in order",
    "1.0 items in order",
    ".5 items in order",
    "1e1 items in order",
    "101 items",
    "9007199254740992 items in order",
    `${"9".repeat(310)} items in order`,
    "NaN items",
    "Infinity items in order",
    "2 items in delivery",
    "2 items in order today",
    "2 items elsewhere",
    "Product 2 items in order",
    "2 items in orders",
    "2 items in order.",
    "2 item(s) in order",
    "2 items2",
    "2 items in order 3 items",
  ])("rejects malformed or unsupported label %j", (label) => {
    expect(NOW_ITEM_COUNT_LABEL.exec(label)).toBeNull();
  });
});

describe("selected-order count and financial corroboration", () => {
  test("corroborates one order independently of row order", () => {
    const facts = snapshot();
    facts.items.reverse();
    const detail = parseNowSnapshot(facts, id);
    expect(() => validateNowSelectedOrder(facts, detail, listed)).not.toThrow();
    expect(detail.items.map((item) => item.itemTotal.amount)).toEqual([17, 11]);
    expect(detail.orderTotal.amount).toBe(30);
    expect(JSON.stringify(detail)).not.toMatch(
      /sourceItems|splitScope|Delivery/,
    );
  });
  test.each([undefined, 0, 1, 3, NaN, Infinity, 101, 2.5])(
    "rejects absent or inconsistent item count %s",
    (count) => {
      const facts = snapshot();
      const detail = parseNowSnapshot(facts, id);
      facts.declaredItemCount = count;
      expect(() => validateNowSelectedOrder(facts, detail, listed)).toThrow();
    },
  );
  test.each([2, 3])(
    "does not assign unqualified item count %s to lines or units",
    (count) => {
      const facts = snapshot();
      facts.declaredItemCount = count;
      facts.items[0].parts = [
        "Invented split lentils",
        "Qty: 2",
        "Unit price: ₹11.00",
        "Line total: ₹22.00",
      ];
      facts.billRows = [
        "Items total ₹39.00",
        "Handling fee ₹2.00",
        "You pay ₹41.00",
      ];
      const detail = parseNowSnapshot(facts, id);
      expect(() =>
        validateNowSelectedOrder(facts, detail, {
          amount: 41,
          currency: "INR",
        }),
      ).toThrow();
    },
  );
  test.each([
    undefined,
    { amount: 11, currency: "INR" },
    { amount: 30.01, currency: "INR" },
    { amount: 30, currency: "USD" },
    { amount: NaN, currency: "INR" },
  ])("requires the independent selected listed total: %j", (total) => {
    const facts = snapshot();
    expect(() =>
      validateNowSelectedOrder(facts, parseNowSnapshot(facts, id), total),
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
      validateNowSelectedOrder(facts, parseNowSnapshot(facts, id), listed),
    ).toThrow();
  });
});
