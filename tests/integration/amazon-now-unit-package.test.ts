import { existsSync, readFileSync } from "fs";
import { readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { chromium, Browser, BrowserContext, Page } from "playwright";
import { makeTestDirectory } from "../helpers/temp-directory";
import { extractNowOrder, parseNowSnapshot } from "../../src/poc/amazon-now";
import { FailureDiagnostics } from "../../src/poc/failure-diagnostics";
import {
  closeBrowser,
  extractOrderItems,
  listOrders,
} from "../../src/poc/hardened-index-v3";
import { runExport, validateAndWriteExport } from "../../src/poc/export-json";

const executable = [chromium.executablePath(), "/usr/bin/chromium"].find(
  existsSync,
);
const browserTests = executable ? describe : describe.skip;
const id = "111-2222222-3333333";
const outer = `https://www.amazon.in/uff/your-account/order-details?orderID=${id}`;
const tracking = `https://www.amazon.in/tez/browse/orderTracking?orderId=${id}`;
const fixture = readFileSync(
  join(__dirname, "fixtures/amazon-now-unit-package.html"),
  "utf8",
);
const list = `<div class="order-card"><div class="order-header">Order placed 1 October 2026<div>Total ₹31.00</div><span>${id}</span></div><a href="${outer}">View order details</a></div>`;
const mutate = (code: string): string =>
  fixture + `<script>${code};document.currentScript.remove()</script>`;

browserTests(
  "Amazon Now exact Unit package ownership (fictional offline HTML)",
  () => {
    let browser: Browser, context: BrowserContext, page: Page, html: string;
    beforeAll(async () => {
      browser = await chromium.launch({
        executablePath: executable,
        headless: true,
      });
    });
    afterAll(async () => {
      await browser?.close();
    });
    beforeEach(async () => {
      html = fixture;
      context = await browser.newContext({
        offline: true,
        serviceWorkers: "block",
      });
      await context.route("**/*", (route) => {
        const url = new URL(route.request().url());
        return route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: url.pathname.startsWith("/uff/")
            ? `<script>location.replace(${JSON.stringify(tracking)})</script>`
            : url.pathname === "/your-orders/orders"
              ? list
              : html,
        });
      });
      page = await context.newPage();
    });
    afterEach(async () => {
      await closeBrowser();
      await context.close();
      jest.restoreAllMocks();
    });
    const extract = (): ReturnType<typeof extractNowOrder> =>
      extractNowOrder(
        page,
        id,
        outer,
        async () => {},
        new FailureDiagnostics(),
        { amount: 31, currency: "INR" },
      );

    test.each(["View details"])(
      "normalizes only owned package metadata via %s",
      async (control) => {
        html = mutate(
          `document.querySelector('#details').textContent=${JSON.stringify(control)}`,
        );
        const detail = await extract();
        expect(
          detail.items.map((item) => [
            item.asin,
            item.quantity,
            item.unitPrice?.amount,
            item.itemTotal.amount,
          ]),
        ).toEqual([
          ["B0REC00001", 1, 13, 13],
          ["B0REC00002", 1, 18, 18],
        ]);
        expect(detail.orderTotal.amount).toBe(31);
        expect(detail.adjustments).toEqual([]);
        expect(JSON.stringify(detail)).not.toMatch(/1 Unit|₹24|B0REC00003/);
      },
    );
    test("ordinary details retains the existing 23-row historical-price behavior", async () => {
      const ordinary = readFileSync(
        join(__dirname, "fixtures/amazon-now-a11y-prices.html"),
        "utf8",
      );
      html = ordinary;
      const before = await extract();
      html = ordinary.replace(
        '<span class="package-size">400 g</span><span class="package-separator">.</span><div class="quantity">1 unit</div>',
        "<p>1 Unit<span> . </span>1 unit</p>",
      );
      expect(await extract()).toEqual(before);
      expect(before.items).toHaveLength(23);
    });
    test.each([
      "document.querySelector('#active-one [decorationtype]').hidden=true",
      "document.querySelector('#active-one>div:last-child').insertAdjacentHTML('beforeend','<s>₹24</s>')",
    ])(
      "retains existing merchandise historical-price handling: %s",
      async (code) => {
        html = mutate(code).replace("1 Unit<span>", "350 g<span>");
        const before = await extract();
        html = mutate(code);
        expect(await extract()).toEqual(before);
      },
    );
    test("package count never supplies purchased quantity", async () => {
      html = mutate(
        `document.querySelector('#range').lastChild.textContent='2 units';document.querySelector('#active-one>div:last-child').innerHTML='<p>Unit price: ₹6.50</p><p>Line total: ₹13</p>';document.querySelector('#count').textContent='3 items in order'`,
      );
      const item = (await extract()).items[0];
      expect([
        item.quantity,
        item.unitPrice?.amount,
        item.itemTotal.amount,
      ]).toEqual([2, 6.5, 13]);
    });
    const invalid: Array<[string, string]> = [
      [
        "equal purchased duplicate",
        "document.querySelector('#active-one>div').insertAdjacentHTML('beforeend','<p>1 unit</p>')",
      ],
      [
        "conflicting purchased duplicate",
        "document.querySelector('#active-one>div').insertAdjacentHTML('beforeend','<p>Qty: 2</p>')",
      ],
      [
        "duplicate within descriptor",
        "document.querySelector('#range').append(' 1 unit')",
      ],
      [
        "duplicate package descriptor",
        "document.querySelector('#range').prepend('1 Unit')",
      ],
      [
        "missing purchased declaration",
        "document.querySelector('#range').lastChild.remove()",
      ],
      [
        "zero purchased count",
        "document.querySelector('#range').lastChild.textContent='0 unit'",
      ],
      [
        "negative purchased count",
        "document.querySelector('#range').lastChild.textContent='-1 unit'",
      ],
      [
        "fractional purchased count",
        "document.querySelector('#range').lastChild.textContent='1.5 unit'",
      ],
      [
        "unsafe purchased count",
        "document.querySelector('#range').lastChild.textContent='9007199254740992 units'",
      ],
      [
        "package case ambiguity",
        "document.querySelector('#range').firstChild.textContent='1 unit'",
      ],
      [
        "unsupported package count",
        "document.querySelector('#range').firstChild.textContent='2 Unit'",
      ],
      [
        "joined source",
        "document.querySelector('#range').textContent='1 Unit . 1 unit'",
      ],
      [
        "middle dot source",
        "document.querySelector('#range span').textContent='·'",
      ],
      ["missing separator", "document.querySelector('#range span').remove()"],
      ["hidden separator", "document.querySelector('#range span').hidden=true"],
      [
        "historical separator",
        "document.querySelector('#range span').style.textDecoration='line-through'",
      ],
      [
        "nested separator",
        "document.querySelector('#range span').innerHTML='<span>.</span>'",
      ],
      [
        "separator control",
        "document.querySelector('#range span').innerHTML='<button>.</button>'",
      ],
      [
        "wrapped package",
        "document.querySelector('#range').firstChild.replaceWith(Object.assign(document.createElement('span'),{textContent:'1 Unit'}))",
      ],
      [
        "hidden package",
        "document.querySelector('#range').firstChild.replaceWith(Object.assign(document.createElement('span'),{hidden:true,textContent:'1 Unit'}))",
      ],
      [
        "historical package",
        "document.querySelector('#range').firstChild.replaceWith(Object.assign(document.createElement('s'),{textContent:'1 Unit'}))",
      ],
      [
        "wrapped purchased declaration",
        "document.querySelector('#range').lastChild.replaceWith(Object.assign(document.createElement('span'),{textContent:'1 unit'}))",
      ],
      [
        "historical descriptor",
        "document.querySelector('#range').style.textDecoration='line-through'",
      ],
      [
        "cross-owner declaration",
        "document.querySelector('#active-two>div').append(document.querySelector('#range').lastChild)",
      ],
      [
        "extra hidden quantity",
        "document.querySelector('#active-one').insertAdjacentHTML('beforeend','<p hidden>Qty: 1</p>')",
      ],
      [
        "wrong selected identity",
        "document.querySelector('#sheet b').nextElementSibling.textContent='999-8888888-7777777'",
      ],
      [
        "conflicting item identity",
        "document.querySelector('#active-one').insertAdjacentHTML('beforeend','<a href=https://www.amazon.in/dp/B0REC00009>Invented</a>')",
      ],
      [
        "changed item price",
        "document.querySelector('#active-one>div:last-child p:first-child').textContent='₹14'",
      ],
      [
        "bill mismatch",
        "document.querySelector('#you-pay>div:last-child>p').textContent='₹32'",
      ],
      [
        "count mismatch",
        "document.querySelector('#count').textContent='3 items in order'",
      ],
    ];
    test.each(invalid)("rejects %s", async (_label, code) => {
      html = mutate(code);
      await expect(extract()).rejects.toMatchObject({ category: "validation" });
    });
    test.each(["success", "duplicate", "bill"])(
      "atomic JSON pipeline: %s",
      async (mode) => {
        if (mode !== "success")
          html = mutate(
            mode === "duplicate"
              ? "document.querySelector('#active-one>div').insertAdjacentHTML('beforeend','<p>Qty: 1</p>')"
              : "document.querySelector('#you-pay>div:last-child>p').textContent='₹32'",
          );
        jest
          .spyOn(chromium, "launchPersistentContext")
          .mockResolvedValue(context);
        const directory = await makeTestDirectory("synthetic-unit-package-");
        const output = join(directory, "orders.json");
        await writeFile(output, "prior complete export");
        try {
          const pending = runExport(
            {
              startDate: "2026-10-01",
              endDate: "2026-10-02",
              maxOrders: 5,
              output,
            },
            () => {},
            {
              list: listOrders,
              extract: extractOrderItems,
              write: validateAndWriteExport,
              report: async () => {},
              cleanup: async () => {},
            },
          );
          if (mode === "success") {
            await pending;
            const saved = JSON.parse(await readFile(output, "utf8"));
            expect(saved.orders[0].orderTotal).toBe(31);
            expect(saved.orders[0].items).toHaveLength(2);
            expect(saved.orders[0].items[0]).toMatchObject({
              quantity: 1,
              unitPrice: 13,
              itemTotal: 13,
            });
            expect(JSON.stringify(saved)).not.toMatch(
              /1 Unit|lineTotalCandidateDomVerified|verifiedLineTotal/,
            );
          } else {
            await expect(pending).rejects.toBeInstanceOf(Error);
            expect(await readFile(output, "utf8")).toBe(
              "prior complete export",
            );
          }
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    );
  },
);

describe("unproven Unit snapshot fragments", () => {
  test.each(["1 unit", "Qty: 2"])(
    "preserves indexed duplicate diagnostic for %s",
    (declaration) => {
      const trace = new FailureDiagnostics();
      let failure: unknown;
      try {
        parseNowSnapshot(
          {
            orderIds: [id],
            billRows: ["You pay ₹13"],
            items: [
              {
                parts: ["Invented item", "1 Unit", ".", declaration, "₹13"],
                alts: [],
                hrefs: [],
              },
            ],
          },
          id,
          trace,
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ reason: "ITEM_FACTS_INVALID" });
      expect(trace.report(failure)).toMatchObject({
        lineIndex: 0,
        events: [{ reason: "NOW_PARSE_QUANTITY_DUPLICATE", lineIndex: 0 }],
      });
    },
  );
  test.each([
    ["1 Unit", ".", "1 unit"],
    ["1 Unit . 1 unit"],
    ["1 Unit", "1 unit"],
    ["1 unit", "1 unit"],
    ["1 Unit", ".", "Qty: 2"],
    ["1 Unit", ".", "0 unit"],
  ])("rejects fragments %j without DOM proof", (...quantityParts) => {
    expect(() =>
      parseNowSnapshot(
        {
          orderIds: [id],
          billRows: ["You pay ₹13"],
          items: [
            {
              parts: ["Invented item", ...quantityParts, "₹13"],
              alts: [],
              hrefs: [],
            },
          ],
        },
        id,
      ),
    ).toThrow();
  });
});
