/** Fictional markup only; all requests intercepted, no persistent account profile. */
import { existsSync, readFileSync } from "fs";
import { mkdtemp, readFile, rm, writeFile, readdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { Browser, BrowserContext, Page, chromium } from "playwright";
import { extractNowOrder } from "../../src/poc/amazon-now";
import { NOW_LINE_TOTAL_ONLY } from "../../src/poc/now-line-total";
import { FailureDiagnostics } from "../../src/poc/failure-diagnostics";
import { runExport, validateAndWriteExport } from "../../src/poc/export-json";
import {
  closeBrowser,
  extractOrderItems,
  listOrders,
  AuthenticationRequiredError,
} from "../../src/poc/hardened-index-v3";

const executable = [chromium.executablePath(), "/usr/bin/chromium"].find(
  existsSync,
);
const browserTests = executable ? describe : describe.skip;
const id = "111-2222222-3333333";
const outer = `https://www.amazon.in/uff/your-account/order-details?orderID=${id}`;
const tracking = `https://www.amazon.in/tez/browse/orderTracking?orderId=${id}`;
const printable = `https://www.amazon.in/uff/your-account/order-details/printable/ref=fictional?orderID=${id}`;
const fixture = (name: string): string =>
  readFileSync(join(__dirname, "fixtures", name), "utf8");
const mutate = (html: string, code: string): string =>
  html + `<script>${code};document.currentScript.remove()</script>`;
const base = mutate(
  fixture("amazon-now-recovery.html"),
  `
 document.querySelector('#range').innerHTML='1 Pc<span> . </span>2 units';
 document.querySelector('#count').textContent='3 items in order';
 document.querySelector('#active-one>div:last-child>p:first-child').setAttribute('aria-label','₹13.01');
 document.querySelector('#active-one>div:last-child>p:first-child>span:last-child').textContent='13.01';
 document.querySelector('#active-one>div:last-child>p[decorationtype=strike]').setAttribute('aria-label','₹24');
 document.querySelector('#subtotal>div:last-child>p').textContent='₹31.01';
 document.querySelector('#you-pay>div:last-child>p').textContent='₹31.01';
`,
);
const printBase = fixture("amazon-now-line-total-printable.html");
const ordinaryBase = mutate(
  base,
  "document.querySelector('#unavailable').remove();document.querySelectorAll('#bill [decorationtype=strike]').forEach(e=>e.remove());document.querySelector('#handling>div:first-child>p:last-child').remove();document.querySelector('#you-pay>div:first-child>p').remove()",
).replace(">View details<", ">View order details<");

browserTests(
  "independently corroborated Amazon Now line-total-only items",
  () => {
    let browser: Browser,
      context: BrowserContext,
      page: Page,
      html: string,
      printed: string,
      printUrl: string;
    let printRequests: number, sourceChange: string, printStatus: number;
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
      html = base;
      printed = printBase;
      printUrl = printable;
      printRequests = 0;
      sourceChange = "";
      printStatus = 200;
      context = await browser.newContext({
        offline: true,
        serviceWorkers: "block",
      });
      await context.route("**/*", async (route) => {
        const u = new URL(route.request().url());
        if (u.pathname === "/gp/css/summary/print.html") {
          printRequests++;
          return route.fulfill({
            contentType: "text/html; charset=utf-8",
            body: `<script>location.replace(${JSON.stringify(printUrl)})</script>`,
          });
        }
        if (
          u.pathname.startsWith("/uff/your-account/order-details/printable")
        ) {
          if (sourceChange)
            await page.evaluate((code) => {
              (0, eval)(code);
            }, sourceChange);
          return route.fulfill({
            status: printStatus,
            contentType: "text/html; charset=utf-8",
            body: printed,
          });
        }
        if (u.pathname === "/intermediate")
          return route.fulfill({
            contentType: "text/html",
            body: `<script>location.replace(${JSON.stringify(printable)})</script>`,
          });
        if (u.pathname === "/uff/your-account/order-details")
          return route.fulfill({
            contentType: "text/html; charset=utf-8",
            body: `<script>location.replace(${JSON.stringify(tracking)})</script>`,
          });
        if (u.pathname === "/your-orders/orders")
          return route.fulfill({
            contentType: "text/html; charset=utf-8",
            body: `<div class="order-card"><div class="order-header">Order placed 1 October 2026<div>Total ₹31.01</div><span>${id}</span></div><a href="${outer}">View order details</a></div>`,
          });
        return route.fulfill({
          contentType: "text/html; charset=utf-8",
          body: html,
        });
      });
      page = await context.newPage();
    });
    afterEach(async () => {
      await closeBrowser();
      await context.close();
      jest.restoreAllMocks();
    });
    const extract = async (
      amount = 31.01,
    ): ReturnType<typeof extractNowOrder> => {
      const trace = new FailureDiagnostics();
      try {
        return await extractNowOrder(page, id, outer, async () => {}, trace, {
          amount,
          currency: "INR",
        });
      } catch (error) {
        throw new Error(
          JSON.stringify({
            failure: trace.report(error).failure,
            events: trace.report(error).events.map((e) => e.reason),
          }),
        );
      }
    };
    test("keeps every row and unit, with no guessed average for an odd-paise line", async () => {
      const result = await extract();
      expect(result.items).toHaveLength(2);
      expect(result.items[0]).toMatchObject({
        productName: "Invented range groceries",
        quantity: 2,
        unitPrice: undefined,
        itemTotal: { amount: 13.01 },
        extractionSource: NOW_LINE_TOTAL_ONLY,
      });
      expect(result.items[1].unitPrice?.amount).toBe(18);
      expect(result.orderTotal.amount).toBe(31.01);
      expect(printRequests).toBe(1);
      expect(context.pages()).toHaveLength(1);
    });
    test("ordinary control reuses strict five-unit/four-row proof without deriving a unit price", async () => {
      html = mutate(
        ordinaryBase,
        "for(const [suffix,name,amount]of [['04','Invented pen refill','2'],['05','Invented paper roll','3']]){const r=document.querySelector('#active-two').cloneNode(true);r.id='active-'+suffix;r.querySelector('img').alt='B0REC000'+suffix;r.querySelector('div>p').textContent=name;const price=r.lastElementChild.querySelector('p');price.setAttribute('aria-label','₹'+amount);price.lastElementChild.textContent=amount;document.querySelector('#fulfilled').append(r)}document.querySelector('#count').textContent='5 items in order';document.querySelector('#subtotal>div:last-child>p').textContent='₹36.01';document.querySelector('#you-pay>div:last-child>p').textContent='₹36.01'",
      );
      printed = mutate(
        printBase,
        "for(const [suffix,name,amount]of [['04','Fictional detailed pen title','2'],['05','Fictional detailed paper title','3']]){const r=document.querySelector('#owned-two').cloneNode(true);r.id='owned-'+suffix;r.querySelector('.a-span11>.a-row').id='printed-'+suffix;r.querySelector('img').alt=name;r.querySelector('a').textContent=name;r.querySelector('a').href='/dp/B0REC000'+suffix;r.querySelector('.a-span2').textContent='₹'+amount;document.querySelector('#printed-items').append(r,document.createElement('hr'))}",
      );
      const result = await extract(36.01);
      expect(result.items).toHaveLength(4);
      expect(result.items.map((i) => i.quantity)).toEqual([2, 1, 1, 1]);
      expect(result.items[0]).toMatchObject({
        unitPrice: undefined,
        itemTotal: { amount: 13.01 },
        extractionSource: NOW_LINE_TOTAL_ONLY,
      });
      expect(result.items.slice(1).map((i) => i.unitPrice?.amount)).toEqual([
        18, 2, 3,
      ]);
      expect(printRequests).toBe(1);
    });
    test("ordinary known single-unit prices retain the legacy path without a count or printable request", async () => {
      html = mutate(
        ordinaryBase,
        "document.querySelector('#range').innerHTML='1 Pc<span> . </span>1 unit';document.querySelector('#count').remove()",
      );
      const result = await extract();
      expect(result.items[0].unitPrice?.amount).toBe(13.01);
      expect(result.items[0].extractionSource).toBeUndefined();
      expect(printRequests).toBe(0);
    });
    test.each([
      ["missing qualified count", "document.querySelector('#count').remove()"],
      [
        "unqualified count",
        "document.querySelector('#count').textContent='3 items'",
      ],
      [
        "wrong unit count",
        "document.querySelector('#count').textContent='2 items in order'",
      ],
      [
        "duplicate count",
        "document.querySelector('#fulfilled').insertAdjacentHTML('beforeend','<p>3 items in order</p>')",
      ],
      ["hidden count", "document.querySelector('#count').hidden=true"],
      [
        "incomplete row",
        "document.querySelector('#fulfilled').insertAdjacentHTML('beforeend','<div role=listitem>Unaccounted merchandise</div>')",
      ],
      [
        "hidden merchandise",
        "document.querySelector('#fulfilled').insertAdjacentHTML('beforeend','<img hidden alt=B0REC99999>')",
      ],
      [
        "hidden bill conflict",
        "document.querySelector('#bill').insertAdjacentHTML('beforeend','<p hidden>You pay ₹31.01</p>')",
      ],
      [
        "conflicting unit hint",
        "document.querySelector('#active-one>div:last-child>p:first-child').title='Unit price ₹13.01'",
      ],
    ])("ordinary promotion rejects %s", async (_name, code) => {
      html = mutate(ordinaryBase, code);
      await expect(extract()).rejects.toBeInstanceOf(Error);
    });
    test.each([
      [
        "ASIN",
        "document.querySelector('#printed-one a').href='/dp/B0REC99999'",
      ],
      [
        "quantity",
        "document.querySelector('#printed-one>.a-span1').textContent='1'",
      ],
      [
        "gross line",
        "document.querySelector('#printed-one>.a-span2').textContent='₹26.02'",
      ],
    ])(
      "ordinary proof rejects printable %s disagreement",
      async (_name, code) => {
        html = ordinaryBase;
        printed = mutate(printBase, code);
        await expect(extract()).rejects.toBeInstanceOf(Error);
      },
    );
    test("ordinary promoted dialog must remain unchanged during independent reading", async () => {
      html = ordinaryBase;
      sourceChange =
        "document.querySelector('#count').textContent='4 items in order'";
      await expect(extract()).rejects.toBeInstanceOf(Error);
    });
    test("corroborates multiple unknown-unit lines without inventing either unit price", async () => {
      html = mutate(
        base,
        `document.querySelector('#active-two>div>p:last-child').innerHTML='250 ml<span> . </span>3 units';document.querySelector('#count').textContent='5 items in order'`,
      );
      printed = mutate(
        printBase,
        `document.querySelector('#printed-two>.a-span1').textContent='3'`,
      );
      const result = await extract();
      expect(result.items.map((i) => i.quantity)).toEqual([2, 3]);
      expect(result.items.map((i) => i.extractionSource)).toEqual([
        NOW_LINE_TOTAL_ONLY,
        NOW_LINE_TOTAL_ONLY,
      ]);
      expect(result.items.every((i) => i.unitPrice === undefined)).toBe(true);
    });
    test("accepts absent status and hidden empty weight columns without losing any facts", async () => {
      printed = mutate(
        printBase,
        `document.querySelector('#status-one').remove();document.querySelector('#owned-two>.a-span11>div:last-child').remove();document.querySelectorAll('#printed-items .a-span3').forEach(e=>{if(!e.textContent.trim())e.hidden=true})`,
      );
      const result = await extract();
      expect(result.items).toHaveLength(2);
      expect(result.items[0].itemTotal.amount).toBe(13.01);
      expect(result.items[0].unitPrice).toBeUndefined();
    });
    test("an independently printed zero line remains zero while unit price stays unknown", async () => {
      html = mutate(
        base,
        `document.querySelector('#active-one>div:last-child>p:first-child').setAttribute('aria-label','₹0');document.querySelector('#active-one>div:last-child>p:first-child>span:last-child').textContent='0';document.querySelector('#subtotal>div:last-child>p').textContent='₹18';document.querySelector('#you-pay>div:last-child>p').textContent='₹18'`,
      );
      printed = mutate(
        printBase,
        `document.querySelector('#printed-one>.a-span2').textContent='₹0.00';document.querySelector('#status-one>.a-span4').textContent=''`,
      );
      const result = await extract(18);
      expect(result.items[0].itemTotal.amount).toBe(0);
      expect(result.items[0].unitPrice).toBeUndefined();
    });
    test("existing explicit unit/line prices do not request printable fallback", async () => {
      html = mutate(
        base,
        `document.querySelector('#active-one>div:last-child').innerHTML='<p>Unit price: ₹6.50</p><p>Line total: ₹13</p>';document.querySelector('#subtotal>div:last-child>p').textContent='₹31';document.querySelector('#you-pay>div:last-child>p').textContent='₹31'`,
      );
      const result = await extract(31);
      expect(result.items[0].unitPrice?.amount).toBe(6.5);
      expect(result.items[0].extractionSource).toBeUndefined();
      expect(printRequests).toBe(0);
    });
    test.each([
      "1 pc",
      "1 PC",
      "1 Pcs",
      "2 Pc",
      "01 Pc",
      "0 Pc",
      "-1 Pc",
      "1.0 Pc",
      "1Pc",
      "Pc",
    ])("rejects unsupported metadata %s", async (value) => {
      html = mutate(
        base,
        `document.querySelector('#range').firstChild.textContent=${JSON.stringify(value)}`,
      );
      await expect(extract()).rejects.toBeInstanceOf(Error);
    });
    const trackingInvalid: [string, string][] = [
      [
        "conflicting price accessibility label",
        `document.querySelector('#active-one>div:last-child>p:first-child').setAttribute('aria-label','Unit price: ₹13.01')`,
      ],
      [
        "conflicting price title",
        `document.querySelector('#active-one>div:last-child>p:first-child').setAttribute('title','₹99')`,
      ],
      [
        "unit price component",
        `document.querySelector('#active-one>div:last-child>p:first-child').setAttribute('data-component','unitPrice')`,
      ],
      [
        "wrong separator",
        `document.querySelector('#range>span').textContent=' · '`,
      ],
      [
        "hidden Pc",
        `const p=document.querySelector('#range');p.firstChild.replaceWith(Object.assign(document.createElement('span'),{textContent:'1 Pc',hidden:true}))`,
      ],
      [
        "historical Pc",
        `const p=document.querySelector('#range');p.firstChild.replaceWith(Object.assign(document.createElement('s'),{textContent:'1 Pc'}))`,
      ],
      [
        "hidden metadata and period",
        `const p=document.querySelector('#range');p.firstChild.replaceWith(Object.assign(document.createElement('span'),{textContent:'1 Pc',hidden:true}));p.querySelectorAll('span')[1].hidden=true`,
      ],
      [
        "nested metadata action",
        `document.querySelector('#range>span').innerHTML='<button>.</button>'`,
      ],
      [
        "count of lines",
        `document.querySelector('#count').textContent='2 items in order'`,
      ],
      [
        "wrong unit count",
        `document.querySelector('#count').textContent='4 items in order'`,
      ],
      ["plain count", `document.querySelector('#count').textContent='3 items'`],
      ["hidden count", `document.querySelector('#count').hidden=true`],
      [
        "duplicate count",
        `document.querySelector('#fulfilled').insertAdjacentHTML('afterbegin','<p>3 items in order</p>')`,
      ],
      [
        "duplicate quantity",
        `document.querySelector('#range').append(' 2 units')`,
      ],
      [
        "conflicting price",
        `document.querySelector('#active-one>div:last-child').insertAdjacentHTML('beforeend','<p>₹14</p>')`,
      ],
      [
        "bad bill",
        `document.querySelector('#subtotal>div:last-child>p').textContent='₹31.03'`,
      ],
      [
        "bad gross",
        `document.querySelector('#you-pay>div:last-child>p').textContent='₹31.03'`,
      ],
      [
        "unit label instead of line meaning",
        `document.querySelector('#active-one>div:last-child').innerHTML='<p>Unit price: ₹13.01</p>'`,
      ],
    ];
    test.each(trackingInvalid)("rejects tracking %s", async (_name, change) => {
      html = mutate(base, change);
      await expect(extract()).rejects.toBeInstanceOf(Error);
    });
    const printInvalid: [string, string][] = [
      [
        "conflicting product image",
        `document.querySelector('#printed-one a').insertAdjacentHTML('beforeend','<img alt="B0REC99999">')`,
      ],
      [
        "foreign order",
        `document.querySelector('span').textContent='Order #: 111-2222222-4444444'`,
      ],
      [
        "hidden conflicting order",
        `document.querySelector('span[hidden]').textContent='Order #: 111-2222222-4444444'`,
      ],
      [
        "malformed order label",
        `document.querySelector('span[hidden]').textContent='Order #: unknown'`,
      ],
      [
        "foreign alternate order label",
        `document.body.insertAdjacentHTML('beforeend','<div>Order ID: 111-2222222-4444444</div>')`,
      ],
      [
        "missing product image",
        `document.querySelector('#owned-one img').remove()`,
      ],
      [
        "conflicting product image",
        `document.querySelector('#owned-one img').alt='Different product'`,
      ],
      [
        "hidden product image",
        `document.querySelector('#owned-one img').hidden=true`,
      ],
      [
        "extra product image",
        `document.querySelector('#owned-one>.a-span1').append(document.querySelector('#owned-one img').cloneNode())`,
      ],
      [
        "unowned item wrapper",
        `document.querySelector('#printed-items').insertAdjacentHTML('beforeend','<div class="a-row a-grid-vertical-align a-grid-center"><img alt="Unaccounted product"></div>')`,
      ],
      [
        "missing status structure",
        `document.querySelector('#status-one>.a-span4').remove()`,
      ],
      [
        "foreign status",
        `document.querySelector('#status-one .a-span8 span').textContent='Cancelled (1)'`,
      ],
      [
        "excess refunded quantity",
        `document.querySelector('#status-one .a-span8 span').textContent='Refunded (3)'`,
      ],
      [
        "zero refunded quantity",
        `document.querySelector('#status-one .a-span8 span').textContent='Refunded (0)'`,
      ],
      [
        "fractional refunded quantity",
        `document.querySelector('#status-one .a-span8 span').textContent='Refunded (1.0)'`,
      ],
      [
        "refund above gross",
        `document.querySelector('#status-one .ufpo-item-status-price').textContent='-₹14.00'`,
      ],
      [
        "zero refund",
        `document.querySelector('#status-one .ufpo-item-status-price span').textContent='-₹0'`,
      ],
      [
        "unsigned refund",
        `document.querySelector('#status-one .ufpo-item-status-price span').textContent='₹6'`,
      ],
      [
        "refund currency",
        `document.querySelector('#status-one .ufpo-item-status-price span').textContent='-USD 6'`,
      ],
      ["hidden refund", `document.querySelector('#status-one').hidden=true`],
      [
        "extra refund amount",
        `document.querySelector('#status-one .ufpo-item-status-price').insertAdjacentHTML('beforeend','<span>-₹6</span>')`,
      ],
      [
        "unowned refund text",
        `document.querySelector('#status-one>.a-span4').append('Other charge ₹1')`,
      ],
      [
        "hidden sole identities",
        `document.querySelectorAll('span').forEach(e=>e.hidden=true)`,
      ],
      [
        "identity inside items",
        `document.querySelector('#printed-items').append(document.querySelector('span'))`,
      ],
      [
        "wrong ASIN",
        `document.querySelector('#printed-one a').href='/dp/B0REC99999'`,
      ],
      [
        "extra link",
        `document.querySelector('#printed-one>.a-span6').insertAdjacentHTML('beforeend','<a href="/dp/B0REC00001">Other</a>')`,
      ],
      [
        "wrong quantity",
        `document.querySelector('#printed-one>.a-span1').textContent='1'`,
      ],
      [
        "fractional quantity",
        `document.querySelector('#printed-one>.a-span1').textContent='2.0'`,
      ],
      [
        "missing price",
        `document.querySelector('#printed-one>.a-span2').textContent=''`,
      ],
      [
        "different price",
        `document.querySelector('#printed-one>.a-span2').textContent='₹13.02'`,
      ],
      [
        "unknown price qualifier",
        `document.querySelector('#printed-one>.a-span2').textContent='Estimated ₹13.01'`,
      ],
      [
        "hidden price",
        `document.querySelector('#printed-one>.a-span2').hidden=true`,
      ],
      [
        "a11y hidden price",
        `document.querySelector('#printed-one>.a-span2').setAttribute('aria-hidden','true')`,
      ],
      [
        "historical price",
        `document.querySelector('#printed-one>.a-span2').innerHTML='<s>₹13.01</s>'`,
      ],
      [
        "hidden extra price",
        `document.querySelector('#printed-one>.a-span2').insertAdjacentHTML('beforeend','<span hidden>₹13.01</span>')`,
      ],
      [
        "quantity borrowed from title",
        `document.querySelector('#printed-one>.a-span1').textContent='';document.querySelector('#printed-one a').append(' 2')`,
      ],
      [
        "total header missing",
        `document.querySelector('#columns>.a-span2').textContent='Unit price'`,
      ],
      [
        "hidden duplicate header",
        `const c=document.querySelector('#columns').cloneNode(true);c.hidden=true;document.querySelector('#printed-items').append(c)`,
      ],
      ["missing row", `document.querySelector('#printed-two').remove()`],
      [
        "duplicate row",
        `document.querySelector('#printed-items').append(document.querySelector('#printed-one').cloneNode(true))`,
      ],
      [
        "unlinked incomplete row",
        `const r=document.createElement('div');r.className='a-row a-grid-vertical-align a-grid-center';r.textContent='Incomplete merchandise';document.querySelector('#printed-items').append(r)`,
      ],
      [
        "unowned outside price",
        `document.querySelector('#printed-items').insertAdjacentHTML('beforeend','<div>₹18</div>')`,
      ],
      [
        "row script",
        `const s=document.createElement('script');s.type='application/json';s.textContent='{}';document.querySelector('#printed-one').append(s)`,
      ],
      [
        "cross currency",
        `document.querySelector('#printed-one>.a-span2').textContent='USD 13.01'`,
      ],
    ];
    test.each(printInvalid)("rejects printable %s", async (_name, change) => {
      printed = mutate(printBase, change);
      await expect(extract()).rejects.toBeInstanceOf(Error);
    });
    test.each(["wrong-id", "duplicate-id", "foreign-host", "wrong-path"])(
      "rejects printable URL %s",
      async (kind) => {
        if (kind === "wrong-id")
          printUrl = printable.replace(id, "111-2222222-4444444");
        if (kind === "duplicate-id") printUrl = printable + `&orderId=${id}`;
        if (kind === "foreign-host")
          printUrl = printable.replace("www.amazon.in", "example.invalid");
        if (kind === "wrong-path")
          printUrl = printable.replace("/printable/ref=fictional", "/other");
        await expect(extract()).rejects.toBeInstanceOf(Error);
      },
    );
    test.each([404, 500])(
      "rejects unavailable summary status %s even with plausible markup",
      async (status) => {
        printStatus = status;
        await expect(extract()).rejects.toBeInstanceOf(Error);
      },
    );
    test("a valid final URL cannot excuse an unsupported intermediate navigation", async () => {
      printUrl = `https://www.amazon.in/intermediate?orderID=${id}`;
      await expect(extract()).rejects.toBeInstanceOf(Error);
    });
    test("summary authentication retains the visible sign-in tab", async () => {
      printUrl = "https://www.amazon.in/ap/signin";
      await expect(
        extractNowOrder(
          page,
          id,
          outer,
          async (target) => {
            if (target && new URL(target.url()).pathname === "/ap/signin")
              throw new AuthenticationRequiredError();
          },
          new FailureDiagnostics(),
          { amount: 31.01, currency: "INR" },
        ),
      ).rejects.toBeInstanceOf(AuthenticationRequiredError);
      expect(context.pages()).toHaveLength(2);
    });
    test("a changed tracking row during corroboration cannot use a stale snapshot", async () => {
      sourceChange =
        "document.querySelector('#active-one>div:last-child>p:first-child>span:last-child').textContent='14.01'";
      await expect(extract()).rejects.toBeInstanceOf(Error);
    });
    test.each([false, true])(
      "atomic export success=%s keeps the existing file safe",
      async (success) => {
        if (!success)
          printed = mutate(
            printBase,
            `document.querySelector('#printed-one>.a-span2').textContent='₹13.02'`,
          );
        jest
          .spyOn(chromium, "launchPersistentContext")
          .mockResolvedValue(context);
        const directory = await mkdtemp(
          join(tmpdir(), "fictional-line-export-"),
        );
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
          if (success) {
            await pending;
            const saved = JSON.parse(await readFile(output, "utf8"));
            expect(saved.orders[0].items[0].unitPrice).toBeNull();
            expect(saved.orders[0].items[0].itemTotal).toBe(13.01);
            expect(saved.orders[0].items[0].extractionSource).toBe(
              NOW_LINE_TOTAL_ONLY,
            );
          } else {
            await expect(pending).rejects.toBeInstanceOf(Error);
            expect(await readFile(output, "utf8")).toBe(
              "prior complete export",
            );
          }
          expect(await readdir(directory)).toEqual(["orders.json"]);
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    );
  },
);
