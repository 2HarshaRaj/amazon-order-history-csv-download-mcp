/** Invented bounded snapshots. DOM proof is supplied only by fixture construction. */
import { NowSnapshot, parseNowSnapshot } from "../../../src/poc/amazon-now";
const id = "111-2222222-3333333";
function fixture(price = "₹18.50", quantity = "2 units"): NowSnapshot {
  return {
    orderIds: [id],
    singleLinePriceDomVerified: true,
    billRows: [
      `Items total ${price}`,
      "Handling fee Free",
      "Delivery fee Free",
      `You pay ${price}`,
    ],
    items: [
      {
        parts: ["Invented. single-line item", quantity, price],
        alts: ["B0SOLO0001"],
        hrefs: [],
      },
    ],
  };
}
const negative: Array<[string, (f: NowSnapshot) => void]> = [
  [
    "missing DOM proof",
    (f) => {
      delete f.singleLinePriceDomVerified;
    },
  ],
  [
    "multiple rows",
    (f) => {
      f.items.push({
        parts: ["Second invented item", "2 units", "₹18.50"],
        alts: [],
        hrefs: [],
      });
      f.billRows = ["Items total ₹37.00", "You pay ₹37.00"];
    },
  ],
  [
    "missing Items total",
    (f) => {
      f.billRows.shift();
    },
  ],
  [
    "missing You pay",
    (f) => {
      f.billRows.pop();
    },
  ],
  [
    "duplicate Items total",
    (f) => {
      f.billRows.push("Items total ₹18.50");
    },
  ],
  [
    "duplicate You pay",
    (f) => {
      f.billRows.push("You pay ₹18.50");
    },
  ],
  [
    "one paise Items total conflict",
    (f) => {
      f.billRows[0] = "Items total ₹18.51";
    },
  ],
  [
    "one paise You pay conflict",
    (f) => {
      f.billRows[3] = "You pay ₹18.51";
    },
  ],
  [
    "matching bills one paise above line",
    (f) => {
      f.billRows[0] = "Items total ₹18.51";
      f.billRows[3] = "You pay ₹18.51";
    },
  ],
  ...["Subtotal", "Items subtotal", "Item total"].map(
    (label): [string, (f: NowSnapshot) => void] => [
      "not Items total: " + label,
      (f) => {
        f.billRows[0] = `${label} ₹18.50`;
      },
    ],
  ),
  [
    "ambiguous subtotal aliases",
    (f) => {
      f.billRows.push("Subtotal ₹18.50");
    },
  ],
  [
    "duplicate fee aliases",
    (f) => {
      f.billRows.push("Handling charge Free");
    },
  ],
  [
    "duplicate promotion aliases",
    (f) => {
      f.billRows.push("Promotion -₹0.00", "Promotion applied -₹0.00");
    },
  ],
  ...[
    "Handling fee ₹1.00",
    "Delivery fee ₹1.00",
    "Shipping fee ₹1.00",
    "Discount -₹1.00",
    "Promotion -₹1.00",
    "Tax ₹0.00",
    "Unknown fee ₹0.00",
    "Gift Card ₹18.50",
    "Handling fee Included ₹0.00",
  ].map((row): [string, (f: NowSnapshot) => void] => [
    "unsupported/nonzero bill " + row,
    (f) => {
      f.billRows = ["Items total ₹18.50", row, "You pay ₹18.50"];
    },
  ]),
  [
    "mixed adjustments net zero",
    (f) => {
      f.billRows = [
        "Items total ₹18.50",
        "Handling fee ₹1.00",
        "Discount -₹1.00",
        "You pay ₹18.50",
      ];
    },
  ],
  [
    "multiple current prices",
    (f) => {
      f.items[0].parts.push("₹37.00");
    },
  ],
  [
    "single labelled unit price",
    (f) => {
      f.items[0].parts[2] = "Unit price: ₹18.50";
    },
  ],
  [
    "single labelled line total",
    (f) => {
      f.items[0].parts[2] = "Line total: ₹18.50";
    },
  ],
  [
    "extra name",
    (f) => {
      f.items[0].parts.push("Another invented name");
    },
  ],
  [
    "conflicting identifiers",
    (f) => {
      f.items[0].hrefs = ["https://www.amazon.in/dp/B0SOLO0002"];
    },
  ],
];
describe("Amazon Now independently corroborated single-line unit derivation", () => {
  test("two units retain one line, exact name, original total and marked derived unit price", () => {
    const result = parseNowSnapshot(fixture(), id);
    expect(result).toMatchObject({
      itemCount: 1,
      extractionSource: "amazon-now-order-details",
      orderTotalSource: "amazon-now-you-pay",
      orderTotal: { amount: 18.5 },
      adjustments: [],
    });
    expect(result.items[0]).toEqual({
      productName: "Invented. single-line item",
      asin: "B0SOLO0001",
      quantity: 2,
      unitPrice: {
        amount: 9.25,
        currency: "INR",
        formatted: "Derived INR 9.25",
      },
      itemTotal: { amount: 18.5, currency: "INR", formatted: "₹18.50" },
    });
  });
  test.each([
    ["₹18.51", "Qty: 3", 6.17],
    ["₹0.06", "Quantity: 6", 0.01],
    ["INR 18.50", "2 unit(s)", 9.25],
    ["₹1,200.00", "2 units", 600],
    ["₹1,20,000.00", "2 units", 60000],
    ["₹2", "2 units", 1],
  ])("exact paise %s and %s derive %s", (price, quantity, amount) => {
    expect(
      parseNowSnapshot(fixture(price, quantity), id).items[0].unitPrice.amount,
    ).toBe(amount);
  });
  test("explicit zero fees/discount/promotion do not become nonzero adjustments", () => {
    const f = fixture();
    f.billRows.push(
      "Shipping fee ₹0.00",
      "Discount -₹0.00",
      "Promotion -₹0.00",
    );
    expect(parseNowSnapshot(f, id).adjustments).toEqual([]);
  });
  test.each(negative)("rejects %s", (_name, change) => {
    const f = fixture();
    change(f);
    expect(() => parseNowSnapshot(f, id)).toThrow();
  });
  test.each([
    "₹18.51",
    "₹0.01",
    "₹0",
    "₹-18.50",
    "-₹18.50",
    "₹018.50",
    "₹00.50",
    "₹18.500",
    "₹1e2",
    "₹+18.50",
    "₹1,20.00",
    "₹1,2000.00",
    "₹NaN",
    "₹90071992547409.92",
  ])("rejects non-divisible/noncanonical/unsafe price %s", (price) => {
    expect(() => parseNowSnapshot(fixture(price), id)).toThrow();
  });
  test.each([
    "0 units",
    "-2 units",
    "02 units",
    "2.0 units",
    "Qty: +2",
    "2e0 units",
    "9007199254740992 units",
    "9007199254740991 units",
    "Qty: unknown",
  ])("rejects invalid/non-divisible purchased quantity %s", (quantity) => {
    expect(() => parseNowSnapshot(fixture("₹18.50", quantity), id)).toThrow();
  });
  test.each([false, "true", 1])(
    "invalid DOM proof %s cannot authorize derivation",
    (proof) => {
      expect(() =>
        parseNowSnapshot(
          { ...fixture(), singleLinePriceDomVerified: proof },
          id,
        ),
      ).toThrow();
    },
  );
  test("quantity one retains its normal pricing and one-paise reconciliation", () => {
    const f = fixture("₹18.50", "1 unit");
    delete f.singleLinePriceDomVerified;
    f.billRows = ["Items total ₹18.50", "Handling fee ₹1.00", "You pay ₹19.51"];
    expect(parseNowSnapshot(f, id).items[0].unitPrice.formatted).toBe("₹18.50");
  });
  test("labelled multi-unit prices retain their normal adjustment/reconciliation path", () => {
    const f = fixture();
    delete f.singleLinePriceDomVerified;
    f.items[0].parts = [
      "Invented. single-line item",
      "2 units",
      "Unit price: ₹9.25",
      "Line total: ₹18.50",
    ];
    f.billRows = ["Items total ₹18.50", "Handling fee ₹1.00", "You pay ₹19.51"];
    expect(parseNowSnapshot(f, id).items[0].unitPrice.formatted).toBe("₹9.25");
  });
});
