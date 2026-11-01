import { makeTestDirectory } from "../../helpers/temp-directory";
import { readFile, readdir, rm } from "fs/promises";
import { join } from "path";
import {
  NowSnapshot,
  normalizeNowDisplayedId,
  parseNowSnapshot,
  validateNowUrl,
} from "../../../src/poc/amazon-now";
import {
  createExportDocument,
  validateAndWriteExport,
} from "../../../src/poc/export-json";
import {
  FailureDiagnostics,
  writeFailureReport,
} from "../../../src/poc/failure-diagnostics";

const id = "111-2222222-3333333";
const outer = `https://www.amazon.in/uff/your-account/order-details?orderID=${id}`;
const summary = { orderId: id, orderDate: "2026-10-01", nowDetailUrl: outer };
const options = { startDate: "2026-10-01", endDate: "2026-10-02" };
const timestamp = "2026-10-03T00:00:00Z";
function fixture(): NowSnapshot {
  return {
    orderIds: [id],
    billRows: [
      "Items total ₹230.00",
      "Handling fee Free",
      "Delivery fee Free",
      "You pay ₹230.00",
    ],
    items: Array.from({ length: 23 }, (_, index) => ({
      parts: [`Invented product ${index + 1}`, "Qty: 1", "₹10.00"],
      alts: [],
      hrefs: [],
    })),
  };
}

describe("Amazon Now fact validation (no Chromium)", () => {
  test.each([
    ["3 Pcs (Approx. 61.5–93.25 g)", ".", "1 unit"],
    ["3 Pcs (Approx. 61.5–93.25 g)", "·", "1 unit"],
    ["7 Pcs (105-165 g)", ".", "1 unit"],
    ["7 Pcs (105-165 g)", "·", "1 unit"],
    ["3 Pcs (Approx. 61.5–93.25 g) . 1 unit"],
    ["7 Pcs (105-165 g) · 1 unit"],
    ["Pack of 6, 0.75 g Each", ".", "1 unit"],
    ["Pack of 4, 3 g Each", ".", "Qty: 1"],
    ["Pack of 6, 0.75 g Each", "·", "1 unit"],
    ["Pack of 6, 0.75 g Each"],
    ["Pack of 6, 0.75 g Each . 1 unit"],
    ["Pack of 0, 0.75 g Each", ".", "1 unit"],
    ["Pack of 1, 60 Tablets", ".", "1 unit"],
    ["Pack of 2, 120 Tablets", ".", "2 units"],
    ["Pack of 1, 60 Tablets"],
    ["Pack of 1, 60 Tablets . 1 unit"],
    ["400 g", ".", "1 unit"],
    ["1 kg", ".", "1 unit"],
    ["0 g", ".", "1 unit"],
    ["-400 g", ".", "1 unit"],
    ["400 oz", ".", "1 unit"],
    ["400 g", "·", "1 unit"],
    ["400 g", ".", ".", "1 unit"],
    [".", "400 g", "1 unit"],
    ["400 g", "."],
    ["400 g . 1 unit"],
  ])(
    "flat facts never supply DOM proof for package metadata: %j",
    (...fields) => {
      const facts = fixture();
      facts.items[0].parts = ["Invented name", ...fields, "₹10.00"];
      expect(() => parseNowSnapshot(facts, id)).toThrow();
    },
  );
  test.each([
    "Invented. name . 400 g",
    ".",
    "400 g",
    "Pack of 1, 60 Tablets",
    "Pack of 6, 0.75 g Each",
    "Invented. name . Pack of 4, 3 g Each",
    "3 Pcs (Approx. 61.5–93.25 g)",
    "7 Pcs (105-165 g)",
  ])("preserves the exact sole product-name field: %s", (name) => {
    const facts = fixture();
    facts.items[0].parts[0] = name;
    expect(parseNowSnapshot(facts, id).items[0].productName).toBe(name);
  });

  test.each([id, `#${id}`, `# ${id}`])(
    "normalizes only the optional display hash",
    (displayed) => {
      expect(normalizeNowDisplayedId(displayed)).toBe(id);
      const facts = fixture();
      facts.orderIds = [displayed];
      expect(parseNowSnapshot(facts, id).orderId).toBe(id);
    },
  );
  test.each([
    `##${id}`,
    `#${id}0`,
    `#${id.replace("111", "11")}`,
    `＃${id}`,
    `#${id} trailing`,
    `#${id.replace("-", " ")}`,
  ])("rejects malformed display identity without repairing it", (displayed) => {
    expect(() => normalizeNowDisplayedId(displayed)).toThrow();
  });
  test.each([
    "1 unit",
    "1 units",
    "500 g · 1 unit",
    "1 kg • 1 unit",
    "250 ml | 1 unit",
    "500 g · 1 unit(s)",
    "2 kg • 1 unit",
    "75 ml | 1 unit",
    "0.5 l · 1 unit",
    "1.25 litres • 1 units",
    "125 mg | 1 unit",
  ])("uses the explicit purchased count in %s", (part) => {
    const facts = fixture();
    facts.items[0].parts[1] = part;
    expect(parseNowSnapshot(facts, id).items[0].quantity).toBe(1);
  });
  test.each([
    "500 g",
    "500 g · unit",
    "500 g · 0 units",
    "500 g · -1 unit",
    "500 g · 1.5 units",
    "500 g · 1 unit · 2 units",
    "500 g · 1 unit Qty: 1",
    "0 g · 1 unit",
    "-250 g · 1 unit",
    "250 g / 1 unit",
    "250 g ; 1 unit",
    "Bundle · (100 - 200 g) · 1 unit",
    "(100-200 g) · 1 unit",
    "100-200 g · 1 unit",
    "250 g · 01 units",
    "250 g · 1 unit trailing",
    "250 g · units",
    "250 g",
    "1 kg · 9007199254740992 units",
  ])("rejects missing/ambiguous quantity %s", (part) => {
    const facts = fixture();
    facts.items[0].parts[1] = part;
    expect(() => parseNowSnapshot(facts, id)).toThrow();
  });
  test("multi-line orders still require explicit unit and line evidence for two units", () => {
    const facts = fixture();
    facts.items[0].parts = [
      "Invented item",
      "500 g · 2 units",
      "Unit price: ₹ 5.00",
      "Line total: ₹ 10.00",
    ];
    expect(parseNowSnapshot(facts, id).items[0]).toMatchObject({
      quantity: 2,
      unitPrice: { amount: 5 },
      itemTotal: { amount: 10 },
    });
    facts.items[0].parts = ["Invented item", "500 g · 2 units", "₹10.00"];
    expect(() => parseNowSnapshot(facts, id)).toThrow();
  });

  test.each([
    "Approx. (120-180 g) . 1 unit",
    "Approx. (120-180 g) · 1 unit",
    "Approx. (120-180 g) • 1 unit",
    "Approx.(120-180g).1 unit",
    "Approx. ( 120 - 180 g ) . 1 unit(s)",
    "Approx. (0.5-1.25 g) · 1 units",
    "Approx. (120.001-120.002 g) . 1 unit",
    "Approx. (120.000000000000000000001-120.000000000000000000002 g) . 1 unit",
    "Approx. (9007199254740992-9007199254740993 g) . 1 unit",
  ])(
    "approximate package weight never becomes purchased quantity: %s",
    (quantity) => {
      const facts = fixture();
      facts.items[22].parts[1] = quantity;
      expect(parseNowSnapshot(facts, id).items[22].quantity).toBe(1);
    },
  );

  test.each([
    "Approx (120-180 g) . 1 unit",
    "Approximate. (120-180 g) . 1 unit",
    "Estimated. (120-180 g) . 1 unit",
    "approx. (120-180 g) . 1 unit",
    "Bundle Approx. (120-180 g) . 1 unit",
    "Approx. (180-120 g) . 1 unit",
    "Approx. (120-120 g) . 1 unit",
    "Approx. (120-120.0 g) . 1 unit",
    "Approx. (120.01-120.001 g) . 1 unit",
    "Approx. (120.000000000000000000002-120.000000000000000000001 g) . 1 unit",
    "Approx. (0-180 g) . 1 unit",
    "Approx. (0.0-180 g) . 1 unit",
    "Approx. (-120-180 g) . 1 unit",
    "Approx. (120--180 g) . 1 unit",
    "Approx. (+120-180 g) . 1 unit",
    "Approx. (1e2-180 g) . 1 unit",
    "Approx. (0120-180 g) . 1 unit",
    "Approx. (120-180 kg) . 1 unit",
    "Approx. (120-180 ml) . 1 unit",
    "Approx. (120-180) . 1 unit",
    "Approx. (120–180 g) . 1 unit",
    "Approx. (120−180 g) . 1 unit",
    "Approx. 120-180 g . 1 unit",
    "Approx. (120-180 g) 1 unit",
    "Approx. (120-180 g) .. 1 unit",
    "Approx. (120-180 g) .· 1 unit",
    "Approx. (120-180 g) | 1 unit",
    "Approx. (120-180 g) / 1 unit",
    "Approx. (120-180 g) , 1 unit",
    "Approx. (120-180 g) ∙ 1 unit",
    "Approx. (120-180 g) ‧ 1 unit",
    "Approx. (120-180 g) ⋅ 1 unit",
    "Approx. (120-180 g) ． 1 unit",
    "Approx. (120-180 g) . unit",
    "Approx. (120-180 g) . 0 units",
    "Approx. (120-180 g) . -1 unit",
    "Approx. (120-180 g) . 1.5 units",
    "Approx. (120-180 g) . 01 units",
    "Approx. (120-180 g) . 9007199254740992 units",
    "Approx. (120-180 g) . 1 unit 2 units",
    "Approx. (120-180 g) . 1 unit trailing",
  ])("rejects unverified or invalid approximate grammar: %s", (quantity) => {
    const facts = fixture();
    facts.items[22].parts[1] = quantity;
    expect(() => parseNowSnapshot(facts, id)).toThrow();
  });

  test.each([2, 5])(
    "approximate package endpoints cannot replace %s purchased units or price evidence",
    (quantity) => {
      const facts = fixture();
      const part = `Approx. (120-180 g) . ${quantity} units`;
      facts.items[22].parts = [
        "Invented approximate item",
        part,
        `Unit price: ₹${10 / quantity}.00`,
        "Line total: ₹10.00",
      ];
      expect(parseNowSnapshot(facts, id).items[22]).toMatchObject({
        quantity,
        unitPrice: { amount: 10 / quantity },
        itemTotal: { amount: 10 },
      });
      facts.items[22].parts = ["Invented approximate item", part, "₹10.00"];
      expect(() => parseNowSnapshot(facts, id)).toThrow();
      facts.items[22].parts = [
        "Invented approximate item",
        part,
        "Unit price: ₹9.00",
        "Line total: ₹10.00",
      ];
      expect(() => parseNowSnapshot(facts, id)).toThrow();
    },
  );

  test("approximate quantity plus another declaration remains ambiguous", () => {
    const facts = fixture();
    facts.items[22].parts = [
      "Invented approximate item",
      "Approx. (120-180 g) . 1 unit",
      "Qty: 1",
      "₹10.00",
    ];
    expect(() => parseNowSnapshot(facts, id)).toThrow();
  });
  test("complete 23-item document with deterministic indexes and distinct provenance", () => {
    const detail = parseNowSnapshot(fixture(), id);
    expect(detail.orderTotalSource).toBe("amazon-now-you-pay");
    const document = createExportDocument(
      options,
      1,
      [{ summary, detail }],
      timestamp,
    );
    expect(document.orders[0].items).toHaveLength(23);
    expect(document.orders[0].items[22]).toMatchObject({
      lineIndex: 22,
      quantity: 1,
      unitPrice: 10,
      itemTotal: 10,
      asin: "",
    });
  });

  test.each(["wrong", "duplicate", "missing", "suffix"])(
    "rejects %s full displayed identity",
    (mode) => {
      const facts = fixture();
      facts.orderIds =
        mode === "wrong"
          ? ["111-2222222-4444444"]
          : mode === "duplicate"
            ? [id, id]
            : mode === "missing"
              ? []
              : [`${id}0`];
      expect(() => parseNowSnapshot(facts, id)).toThrow();
    },
  );
  test.each([
    "missing",
    "conflicting",
    "duplicate",
    "fraction",
    "foreign",
    "comparison",
    "negative",
    "free",
  ])("rejects %s billed total", (mode) => {
    const facts = fixture();
    const values: Record<string, string> = {
      fraction: "You pay ₹230.001",
      foreign: "You pay USD 230.00",
      comparison: "You pay ₹230.00 ₹460.00",
      negative: "You pay -₹230.00",
      free: "You pay Free",
    };
    if (mode === "missing") facts.billRows.pop();
    else if (mode === "conflicting" || mode === "duplicate")
      facts.billRows.push(
        `You pay ₹${mode === "duplicate" ? "230" : "231"}.00`,
      );
    else facts.billRows[3] = values[mode];
    expect(() => parseNowSnapshot(facts, id)).toThrow();
  });
  test("charged fees and signed discount reconcile without funding arithmetic", () => {
    const facts = fixture();
    facts.billRows = [
      "Items total ₹230.00",
      "Handling fee ₹5.00",
      "Delivery fee ₹7.00",
      "Discount -₹12.00",
      "You pay ₹230.00",
    ];
    const detail = parseNowSnapshot(facts, id);
    expect(detail.adjustments.map((a) => a.amount?.amount)).toEqual([
      5, 7, -12,
    ]);
    const document = createExportDocument(
      options,
      1,
      [{ summary, detail }],
      timestamp,
    );
    expect(
      document.orders[0].adjustments.map((a) => a.adjustmentIndex),
    ).toEqual([0, 1, 2]);
  });
  test.each([
    "Handling fee included ₹5.00",
    "Discount ₹5.00",
    "Delivery fee -₹5.00",
    "Service fee ₹5.00",
    "Amazon Pay balance ₹230.00",
    "Voucher ₹80.00",
    "Gift Card ₹100.00",
    "Card payment ₹50.00",
  ])("rejects unverified bill adjustment %s", (row) => {
    const facts = fixture();
    facts.billRows.push(row);
    expect(() => parseNowSnapshot(facts, id)).toThrow();
  });
  test.each([
    [[]],
    [["not an ASIN"]],
    [["prefix B0TEST0001"]],
    [["b0test0001"]],
  ])("keeps missing/invalid alt identifier optional", (alts) => {
    const facts = fixture();
    facts.items[0].alts = alts;
    expect(parseNowSnapshot(facts, id).items[0].asin).toBe("");
  });
  test("associated ASIN candidates must agree", () => {
    const facts = fixture();
    facts.items[0].alts = ["B0TEST0001"];
    facts.items[0].hrefs = ["https://www.amazon.in/dp/B0TEST0001"];
    expect(parseNowSnapshot(facts, id).items[0].asin).toBe("B0TEST0001");
    facts.items[0].hrefs = ["https://www.amazon.in/dp/B0TEST0002"];
    expect(() => parseNowSnapshot(facts, id)).toThrow();
  });
  test.each([
    "missing",
    "zero",
    "fraction",
    "negative",
    "twoOnlyPrice",
    "twoOnlyUnit",
    "twoOnlyLine",
    "unitConflict",
    "duplicateRow",
  ])("rejects %s quantity/price evidence", (mode) => {
    const facts = fixture();
    const quantity: Record<string, string> = {
      zero: "Qty: 0",
      fraction: "Qty: 1.5",
      negative: "Qty: -1",
    };
    if (mode === "duplicateRow") facts.items[1] = { ...facts.items[0] };
    else if (mode === "missing")
      facts.items[0].parts = ["Invented product", "₹10.00"];
    else if (mode in quantity) facts.items[0].parts[1] = quantity[mode];
    else
      facts.items[0].parts = [
        "Invented product",
        "Qty: 2",
        ...(mode === "twoOnlyPrice"
          ? ["₹10.00"]
          : mode === "twoOnlyUnit"
            ? ["Unit price: ₹5.00"]
            : mode === "twoOnlyLine"
              ? ["Line total: ₹10.00"]
              : ["Unit price: ₹5.01", "Line total: ₹10.00"]),
      ];
    expect(() => parseNowSnapshot(facts, id)).toThrow();
  });
  test("quantity two has independent unit and line evidence", () => {
    const facts = fixture();
    facts.items[0].parts = [
      "Invented product",
      "Quantity: 2",
      "Unit price: ₹5.00",
      "Item total: ₹10.00",
    ];
    expect(parseNowSnapshot(facts, id).items[0]).toMatchObject({
      quantity: 2,
      unitPrice: { amount: 5 },
      itemTotal: { amount: 10 },
    });
  });
  test.each(["Unit price", "Item total", "Line total"])(
    "quantity one permits a single explicit %s",
    (label) => {
      const facts = fixture();
      facts.items[0].parts[2] = `${label}: ₹10.00`;
      expect(parseNowSnapshot(facts, id).items[0]).toMatchObject({
        quantity: 1,
        unitPrice: { amount: 10 },
        itemTotal: { amount: 10 },
      });
    },
  );
  test.each([1, 2])(
    "independent total reconciliation tolerance %s paise",
    (paise) => {
      const facts = fixture();
      facts.billRows[3] = `You pay ₹230.0${paise}`;
      if (paise === 1)
        expect(parseNowSnapshot(facts, id).orderTotal.amount).toBe(230.01);
      else
        expect(() => parseNowSnapshot(facts, id)).toThrow(
          expect.objectContaining({ reason: "TOTAL_MISMATCH" }),
        );
    },
  );
  test("cannot pass Now total provenance on conventional orders or vice versa", () => {
    const detail = parseNowSnapshot(fixture(), id);
    expect(() =>
      createExportDocument(
        options,
        1,
        [{ summary: { ...summary, nowDetailUrl: undefined }, detail }],
        timestamp,
      ),
    ).toThrow();
    expect(() =>
      createExportDocument(
        options,
        1,
        [
          {
            summary,
            detail: { ...detail, orderTotalSource: "order-detail-grand-total" },
          },
        ],
        timestamp,
      ),
    ).toThrow();
  });
  test("validation creates no output on incomplete Now orders", async () => {
    const directory = await makeTestDirectory("now-no-output-");
    const detail = parseNowSnapshot(fixture(), id);
    detail.items[0].itemTotal.amount = 9;
    try {
      await expect(
        validateAndWriteExport(
          join(directory, "orders.json"),
          options,
          1,
          [{ summary, detail }],
          timestamp,
        ),
      ).rejects.toThrow();
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("diagnostics retain allowlisted Now provenance without raw URLs or funding", async () => {
    const diagnostics = new FailureDiagnostics();
    diagnostics.select(summary, 0);
    const facts = fixture();
    facts.billRows[1] = "Handling fee ₹5.00";
    facts.billRows.push("Discount -₹5.00");
    diagnostics.detail(parseNowSnapshot(facts, id));
    const report = diagnostics.report(new Error("private raw URL"));
    expect(report.extractionSource).toBe("amazon-now-order-details");
    expect(JSON.stringify(report)).not.toContain("private raw URL");
    expect(report.orderTotalSource).toBe("amazon-now-you-pay");
    expect(report.order?.orderTotalPaise).toBe(23000);
    const directory = await makeTestDirectory("now-report-");
    try {
      await writeFailureReport(report, directory);
      const names = await readdir(directory);
      const saved = JSON.parse(
        await readFile(join(directory, names[0]), "utf8"),
      );
      expect(saved.orderTotalSource).toBe("amazon-now-you-pay");
      expect(saved.adjustments[0]).toMatchObject({
        extractionSource: "amazon-now-bill-summary",
        label: "Handling fee",
        amountPaise: 500,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("Amazon Now exact route identity", () => {
  test("allows an actual UFF or tracking link", () => {
    expect(validateNowUrl(outer, id)).toBe(outer);
    expect(
      validateNowUrl(
        outer.replace(
          "/uff/your-account/order-details",
          "/tez/browse/orderTracking",
        ),
        id,
      ),
    ).toContain("/tez/");
  });
  test.each([
    outer.replace("https:", "http:"),
    outer.replace("www.amazon.in", "amazon.in.evil.invalid"),
    outer.replace(id, `${id}0`),
    `${outer}&orderId=${id}`,
    `${outer}&orderid=${id}`,
    `${outer}#other`,
    outer.replace(
      "/uff/your-account/order-details",
      "/gp/your-account/order-details",
    ),
    outer.replace("www.amazon.in", "user@www.amazon.in"),
    outer.replace("orderID", "reference"),
  ])("rejects unsupported or ambiguous navigation", (url) => {
    expect(() => validateNowUrl(url, id)).toThrow();
  });
});
