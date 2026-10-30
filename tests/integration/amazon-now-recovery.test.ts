/** Fictional fixtures only. Every request is intercepted; no persistent profile. */
import { existsSync, readFileSync } from "fs";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { Browser, BrowserContext, Page, chromium } from "playwright";
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
  join(__dirname, "fixtures/amazon-now-recovery.html"),
  "utf8",
);
const a11y = readFileSync(
  join(__dirname, "fixtures/amazon-now-a11y-prices.html"),
  "utf8",
);
const options = {
  startDate: "2026-10-01",
  endDate: "2026-10-02",
  maxOrders: 5,
};
const list = `<div class="order-card"><div class="order-header">Order placed 1 October 2026<div>Total ₹31.00</div><span>${id}</span></div><a href="${outer}">View order details</a></div>`;
const mutate = (html: string, code: string): string =>
  html + `<script>${code};document.currentScript.remove()</script>`;

const invalid: Array<[string, string]> = [
  [
    "A visible duplicate",
    `document.querySelector('#sheet').insertAdjacentHTML('beforeend','<p>You pay ₹31</p>')`,
  ],
  [
    "A hidden fragmented duplicate",
    `document.querySelector('#sheet').insertAdjacentHTML('beforeend','<div hidden><span>You</span><span>pay</span></div>')`,
  ],
  [
    "A historical duplicate",
    `document.querySelector('#sheet').insertAdjacentHTML('beforeend','<s>You pay ₹31</s>')`,
  ],
  [
    "A ancestor suffix",
    `document.querySelector('#you-pay').append('You pay ₹31')`,
  ],
  ["A hidden sole label", `document.querySelector('#you-pay p').hidden=true`],
  [
    "A sole unspaced fragmented label",
    `document.querySelector('#you-pay p').innerHTML='<span>You</span><span>pay</span>'`,
  ],
  [
    "A conflicting declaration",
    `document.querySelector('#sheet').insertAdjacentHTML('beforeend','<p>You pay ₹32</p>')`,
  ],
  [
    "B hidden comparison",
    `document.querySelector('#subtotal [decorationtype]').hidden=true`,
  ],
  [
    "B accessibility-hidden comparison",
    `document.querySelector('#subtotal [decorationtype]').setAttribute('aria-hidden','true')`,
  ],
  [
    "B duplicate comparison",
    `document.querySelector('#subtotal').insertAdjacentHTML('beforeend','<s>₹99</s>')`,
  ],
  [
    "B separate-wrapper duplicate",
    `document.querySelector('#you-pay').insertAdjacentHTML('beforeend','<div><s>₹99</s></div>')`,
  ],
  [
    "B unknown hidden text",
    `document.querySelector('#subtotal').insertAdjacentHTML('beforeend','<span hidden>Handling</span>')`,
  ],
  [
    "B historical label",
    `document.querySelector('#subtotal p').style.textDecoration='line-through'`,
  ],
  [
    "B unknown charge",
    `document.querySelector('#bill').insertAdjacentHTML('beforeend','<div>Service fee ₹1</div>')`,
  ],
  [
    "B unowned comparison",
    `document.querySelector('#bill').insertAdjacentHTML('beforeend','<s>₹99</s>')`,
  ],
  [
    "B excessive wrapper depth",
    `const old=document.querySelector('#you-pay [decorationtype]');for(let i=0;i<6;i++){const wrap=document.createElement('div');old.before(wrap);wrap.append(old)}`,
  ],
  [
    "B historical extra text",
    `document.querySelector('#subtotal [decorationtype]').append(' estimate')`,
  ],
  [
    "B net conflict",
    `document.querySelector('#you-pay>div:last-child>p').textContent='₹32'`,
  ],
  [
    "C missing notice",
    `document.querySelector('#unavailable-notice').remove()`,
  ],
  [
    "C ambiguous notice",
    `document.querySelector('#unavailable-notice p').textContent='Refund completed'`,
  ],
  [
    "C missing timing evidence",
    `document.querySelector('#unavailable-notice p:last-child').remove()`,
  ],
  [
    "C hidden unavailable product",
    `document.querySelector('#unavailable-row img').hidden=true`,
  ],
  [
    "C historical quantity",
    `document.querySelector('#unavailable-package').style.textDecoration='line-through'`,
  ],
  [
    "C duplicate heading",
    `document.querySelector('#unavailable').insertAdjacentHTML('beforeend','<p>Out of Stock Items</p>')`,
  ],
  [
    "C hidden duplicate heading",
    `document.querySelector('#sheet').insertAdjacentHTML('beforeend','<p hidden>Out of Stock Items</p>')`,
  ],
  [
    "C misplaced heading",
    `document.querySelector('#fulfilled').prepend(document.querySelector('#unavailable-heading'))`,
  ],
  [
    "C priced unavailable",
    `document.querySelector('#unavailable-row').insertAdjacentHTML('beforeend','<p>₹9</p>')`,
  ],
  [
    "C hidden price",
    `document.querySelector('#unavailable-row').insertAdjacentHTML('beforeend','<p hidden>₹9</p>')`,
  ],
  [
    "C price accessible label",
    `document.querySelector('#unavailable-row p').setAttribute('aria-label','₹9')`,
  ],
  [
    "C semantic price field",
    `document.querySelector('#unavailable-row p').dataset.component='unitPrice'`,
  ],
  [
    "C product link",
    `document.querySelector('#unavailable-row').insertAdjacentHTML('beforeend','<a href="/dp/B0REC00003"></a>')`,
  ],
  [
    "C duplicate product",
    `document.querySelector('#unavailable-products').append(document.querySelector('#unavailable-row').cloneNode(true))`,
  ],
  [
    "C conflicting owner",
    `document.querySelector('#unavailable').dataset.orderId='111-2222222-4444444'`,
  ],
  [
    "C bill inside region",
    `document.querySelector('#unavailable-products').append(document.querySelector('#bill'))`,
  ],
  [
    "C active product inside region",
    `document.querySelector('#unavailable-products').append(document.querySelector('#active-one'))`,
  ],
  [
    "C incomplete fulfilled row",
    `document.querySelector('#active-one>div:last-child').remove()`,
  ],
  [
    "C count includes unavailable",
    `document.querySelector('#count').textContent='3 items in order'`,
  ],
  [
    "C unknown icon",
    `document.querySelector('#unavailable-notice img').alt='other-icon'`,
  ],
  [
    "C extra icon",
    `document.querySelector('#unavailable-notice').append(document.querySelector('#unavailable-notice img').cloneNode())`,
  ],
  [
    "C incomplete unavailable row",
    `document.querySelector('#unavailable-products').insertAdjacentHTML('beforeend','<div>Another invented product</div>')`,
  ],
  [
    "C active/unavailable ASIN overlap",
    `document.querySelector('#unavailable-row img').alt='B0REC00001'`,
  ],
  [
    "C active/unavailable name overlap",
    `document.querySelector('#unavailable-row p').textContent='Invented range groceries'`,
  ],
  [
    "C unsupported pack metadata",
    `document.querySelector('#unavailable-package').firstChild.textContent='Pack of 2, 6 Mystery'`,
  ],
  [
    "C unsafe package count",
    `document.querySelector('#unavailable-package').firstChild.textContent='Pack of 9007199254740992, 6 Pcs'`,
  ],
  [
    "C additional refund notice",
    `document.querySelector('#sheet').insertAdjacentHTML('beforeend','<p>Refund for these items initiated</p>')`,
  ],
  [
    "C ordinary uncorroborated path",
    `document.querySelector('#details').textContent='View order details'`,
  ],
];
for (const value of [
  "0-157 g",
  "-1-157 g",
  "157-123 g",
  "123-123 g",
  "01-157 g",
  "1e2-157 g",
  "123–157 g",
  "123-157 kg",
  "123-157 G",
  "Approx. 123-157 g",
  "123 - 157 g",
  "123-157. g",
])
  invalid.push([
    `D range ${value}`,
    `document.querySelector('#range').firstChild.textContent=${JSON.stringify(value)}`,
  ]);
for (const [label, code] of [
  [
    "wrong separator",
    `document.querySelector('#range span').textContent=' · '`,
  ],
  [
    "hidden metadata",
    `document.querySelector('#range').firstChild.replaceWith(Object.assign(document.createElement('span'),{hidden:true,textContent:'123-157 g'}))`,
  ],
  ["hidden separator", `document.querySelector('#range span').hidden=true`],
  [
    "hidden metadata and separator",
    `const p=document.querySelector('#range');p.firstChild.replaceWith(Object.assign(document.createElement('span'),{hidden:true,textContent:'123-157 g'}));p.querySelectorAll('span')[1].hidden=true`,
  ],
  [
    "extra name",
    `document.querySelector('#active-one>div').insertAdjacentHTML('afterbegin','<p>Another invented name</p>')`,
  ],
  [
    "nested control",
    `document.querySelector('#range span').insertAdjacentHTML('beforeend','<button></button>')`,
  ],
  [
    "duplicate quantity",
    `document.querySelector('#range').insertAdjacentHTML('beforeend','<span>Quantity: 2</span>')`,
  ],
])
  invalid.push([`D ${label}`, code]);

browserTests("Amazon Now bounded recovery", () => {
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
      if (url.pathname.startsWith("/uff/"))
        return route.fulfill({
          contentType: "text/html",
          body: `<script>location.replace(${JSON.stringify(tracking)})</script>`,
        });
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: url.pathname === "/your-orders/orders" ? list : html,
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
    extractNowOrder(page, id, outer, async () => {}, new FailureDiagnostics(), {
      amount: 31,
      currency: "INR",
    });

  test("all four Now corrections retain only fully corroborated billed merchandise", async () => {
    const detail = await extract();
    expect(
      detail.items.map((i) => [
        i.asin,
        i.productName,
        i.quantity,
        i.unitPrice.amount,
        i.itemTotal.amount,
      ]),
    ).toEqual([
      ["B0REC00001", "Invented range groceries", 1, 13, 13],
      ["B0REC00002", "Invented bottled item", 1, 18, 18],
    ]);
    expect(detail.orderTotal.amount).toBe(31);
    expect(detail.adjustments).toEqual([]);
    expect(JSON.stringify(detail)).not.toMatch(
      /B0REC00003|stationery|Refund|₹67|₹60/,
    );
    expect(
      await page
        .locator("#you-pay")
        .evaluate((e) => e.textContent?.includes("You payInclusive")),
    ).toBe(true);
  });
  test.each([
    "123-157 g",
    "0.000000000000000000001-0.000000000000000000002 g",
    "123.00000000000000000001-123.00000000000000000002 g",
  ])("D preserves exact increasing endpoints in %s", async (range) => {
    html = mutate(
      fixture,
      `document.querySelector('#range').firstChild.textContent=${JSON.stringify(range)}`,
    );
    expect((await extract()).items[0].quantity).toBe(1);
  });
  test("A/B remain independent of unavailable-region and range support", async () => {
    html = mutate(
      fixture,
      `document.querySelector('#unavailable').remove();document.querySelector('#range').firstChild.textContent='350 g'`,
    );
    expect((await extract()).orderTotal.amount).toBe(31);
  });
  test("B rejects hidden evidence even when current values agree", async () => {
    html = mutate(
      fixture,
      `document.querySelector('#delivery').insertAdjacentHTML('beforeend','<span style="display:none">Unknown</span>')`,
    );
    await expect(extract()).rejects.toMatchObject({
      reason: "NOW_BILL_ROW_INVALID",
    });
  });
  test.each(invalid)("rejects %s", async (_label, code) => {
    html = mutate(fixture, code);
    await expect(extract()).rejects.toMatchObject({ category: "validation" });
  });
  test("D supports an ordinary 23-line presentation without changing any purchase fact", async () => {
    html = a11y;
    const before = await extract();
    html = mutate(
      a11y,
      `document.querySelector('#a11y-row-11 .package-size').textContent='123-157 g'`,
    );
    const after = await extract();
    expect(after).toEqual(before);
    expect(after.items).toHaveLength(23);
  });
  test("D flat fragments still cannot authorize package normalization", () => {
    expect(() =>
      parseNowSnapshot(
        {
          orderIds: [id],
          billRows: ["You pay ₹13"],
          items: [
            {
              parts: ["Invented item", "123-157 g", ".", "1 unit", "₹13"],
              alts: [],
              hrefs: [],
            },
          ],
        },
        id,
      ),
    ).toThrow();
  });
  test.each(["success", "A", "B", "C", "D"])(
    "atomic pipeline %s",
    async (mode) => {
      const changes: Record<string, string> = {
        A: `document.querySelector('#sheet').insertAdjacentHTML('beforeend','<p>You pay ₹31</p>')`,
        B: `document.querySelector('#subtotal [decorationtype]').hidden=true`,
        C: `document.querySelector('#unavailable-row').insertAdjacentHTML('beforeend','<p>₹9</p>')`,
        D: `document.querySelector('#range').firstChild.textContent='157-123 g'`,
      };
      if (mode !== "success") html = mutate(fixture, changes[mode]);
      jest
        .spyOn(chromium, "launchPersistentContext")
        .mockResolvedValue(context);
      const directory = await mkdtemp(join(tmpdir(), "synthetic-recovery-"));
      const output = join(directory, "orders.json");
      await writeFile(output, "prior complete export");
      try {
        const pending = runExport({ ...options, output }, () => {}, {
          list: listOrders,
          extract: extractOrderItems,
          write: validateAndWriteExport,
          report: async () => {},
          cleanup: async () => {},
        });
        if (mode === "success") {
          await pending;
          const saved = JSON.parse(await readFile(output, "utf8"));
          expect(saved.orders[0].items).toHaveLength(2);
          expect(saved.orders[0].orderTotal).toBe(31);
        } else {
          await expect(pending).rejects.toBeInstanceOf(Error);
          expect(await readFile(output, "utf8")).toBe("prior complete export");
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
