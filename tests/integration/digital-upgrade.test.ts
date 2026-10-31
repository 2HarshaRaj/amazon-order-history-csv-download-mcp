/** Fabricated order records, intercepted offline requests, no account profile. */
import { existsSync, readFileSync } from "fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { Browser, BrowserContext, Page, chromium } from "playwright";
import { ALEXA_UPGRADE } from "../../src/poc/digital-upgrade";
import {
  closeBrowser,
  listOrders,
  parseCurrentOrderPage,
} from "../../src/poc/hardened-index-v3";
import { FailureDiagnostics } from "../../src/poc/failure-diagnostics";
import { runExport, validateAndWriteExport } from "../../src/poc/export-json";

const executable = [chromium.executablePath(), "/usr/bin/chromium"].find(
  existsSync,
);
const browserTests = executable ? describe : describe.skip;
const id = "D01-0000000-0000001",
  purchaseId = "111-2222222-3333333";
const bind = (html: string): string =>
  html
    .replaceAll("SERVICE_ASIN", ALEXA_UPGRADE.asin)
    .replaceAll("SERVICE_SELLER", ALEXA_UPGRADE.sellerId);
const fixture = (name: string): string =>
  bind(readFileSync(join(__dirname, "fixtures", name), "utf8"));
const cardBase = fixture("digital-upgrade-card.html"),
  detailBase = fixture("digital-upgrade-detail.html");
const purchase = (name = "Fictional merchandise", amount = "10.00"): string =>
  '<section class="order-card"><div class="order-header">Order placed 2 October 2026<div>Total ₹' +
  amount +
  "</div><span>" +
  purchaseId +
  '</span></div><a href="/dp/B000000015">' +
  name +
  "</a></section>";
const next =
  '<ul class="a-pagination"><li class="a-last"><a href="?page=2">Next</a></li></ul>';
const mutate = (html: string, code: string): string =>
  html + "<script>" + bind(code) + ";document.currentScript.remove()</script>";
browserTests("narrow owner-approved digital upgrade exclusion", () => {
  let browser: Browser,
    context: BrowserContext,
    page: Page,
    html: string,
    detail: string,
    page2: string;
  let status: number, detailRequests: number, sourceChange: string;
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
    html = cardBase + purchase();
    detail = detailBase;
    page2 = purchase();
    status = 200;
    detailRequests = 0;
    sourceChange = "";
    context = await browser.newContext({
      offline: true,
      serviceWorkers: "block",
    });
    await context.route("**/*", async (route) => {
      const u = new URL(route.request().url());
      if (u.pathname === "/your-orders/order-details") {
        detailRequests++;
        if (sourceChange)
          await page.evaluate((code) => {
            (0, eval)(code);
          }, sourceChange);
        return route.fulfill({
          status,
          contentType: "text/html; charset=utf-8",
          body: detail,
        });
      }
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: u.searchParams.has("page") ? page2 : html,
      });
    });
    page = await context.newPage();
  });
  afterEach(async () => {
    await closeBrowser();
    await context.close();
    jest.restoreAllMocks();
  });
  const parse = async (
    trace = new FailureDiagnostics(),
  ): ReturnType<typeof parseCurrentOrderPage> => {
    await page.goto("https://www.amazon.in/your-orders/orders");
    return parseCurrentOrderPage(page, trace);
  };
  const listed = async (
    trace = new FailureDiagnostics(),
  ): ReturnType<typeof listOrders> => {
    jest.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context);
    return listOrders("2026-10-01", "2026-10-30", 1, trace);
  };
  test("independently verifies service, seller, exact order/date and both zero amounts", async () => {
    const trace = new FailureDiagnostics(),
      result = await listed(trace);
    expect(result.orders.map((o) => o.orderId)).toEqual([purchaseId]);
    expect(result.audit).toEqual({
      digitalOrdersExcluded: 1,
      walletFundingExcluded: 0,
      unresolvedOrders: 0,
    });
    expect(detailRequests).toBe(1);
    expect(context.pages()).toHaveLength(1);
    const event = trace
      .report(new Error("Fictional observation"))
      .events.find((e) => e.reason === "LIST_DIGITAL_UPGRADE_EXCLUDED");
    expect(event).toMatchObject({ count: 1 });
    expect(event?.orderIndex).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain(id);
  });
  test("digital-only pages continue; duplicates revalidate but count once", async () => {
    html = cardBase + next;
    page2 = cardBase + purchase();
    const result = await listed();
    expect(result.pagesScanned).toBe(2);
    expect(result.orders).toHaveLength(1);
    expect(result.audit.digitalOrdersExcluded).toBe(1);
    expect(detailRequests).toBe(2);
  });
  test("whitespace between owned screen-reader and visible zero price copies is presentation only", async () => {
    detail = mutate(
      detailBase,
      "document.querySelector('[data-component=unitPrice] .a-price').insertBefore(document.createTextNode(' \\n '),document.querySelector('[data-component=unitPrice] [aria-hidden]'))",
    );
    expect(await parse()).toHaveLength(1);
  });
  test("the agreeing offscreen accessibility copy is not the visible price authority", async () => {
    detail = mutate(
      detailBase,
      "document.querySelector('[data-component=unitPrice] .a-offscreen').style.opacity='0'",
    );
    expect(await parse()).toHaveLength(1);
  });
  test("wallet exclusions stay distinct and consume no merchandise slots", async () => {
    html = cardBase + fixture("order-card-wallet-confirmed.html") + purchase();
    const result = await listed();
    expect(result.orders).toHaveLength(1);
    expect(result.audit).toEqual({
      digitalOrdersExcluded: 1,
      walletFundingExcluded: 1,
      unresolvedOrders: 0,
    });
  });
  test("ordinary zero merchandise mentioning Alexa remains merchandise", async () => {
    html = purchase("Fictional Alexa+ lamp", "0.00");
    const result = await listed();
    expect(result.orders[0].orderTotal?.amount).toBe(0);
    expect(result.audit.digitalOrdersExcluded).toBe(0);
    expect(detailRequests).toBe(0);
  });
  test("an ordinary owned header remains authoritative over a body reference", async () => {
    html = purchase().replace(
      "</section>",
      "<div>Reference D01-0000000-0000002</div></section>",
    );
    expect((await listed()).orders[0].orderId).toBe(purchaseId);
  });
  test("a nested independent order cannot borrow or disappear into a parent's header", async () => {
    html = purchase().replace("</section>", cardBase + "</section>");
    await expect(listed()).rejects.toBeInstanceOf(Error);
  });
  test("outside-window digital cards are date-accounted, not claimed as exclusions", async () => {
    html = cardBase.replace("2 October 2026", "2 September 2026") + purchase();
    const result = await listed();
    expect(result.audit.digitalOrdersExcluded).toBe(0);
    expect(detailRequests).toBe(0);
  });
  const cardInvalid: [string, string][] = [
    [
      "unknown D01 service",
      cardBase.replaceAll(ALEXA_UPGRADE.asin, "B0FAKE0001"),
    ],
    ["partial Alexa title", cardBase.replaceAll(">Alexa+<", ">Alexa+ lamp<")],
    ["nonzero charge", cardBase.replace("Total ₹0.00", "Total ₹1.00")],
    ["missing zero charge", cardBase.replace("Total ₹0.00", "")],
    ["wrong currency", cardBase.replace("₹0.00", "USD 0.00")],
    ["hidden total", cardBase.replace("<div>Total", "<div hidden>Total")],
    [
      "hidden product",
      cardBase.replace(
        'class="a-fixed-left-grid"',
        'class="a-fixed-left-grid" hidden',
      ),
    ],
    [
      "conflicting image",
      cardBase.replace('alt="Alexa+"', 'alt="Other product"'),
    ],
    ["missing image", cardBase.replace(/<img[^>]*>/, "")],
    [
      "missing selected link",
      cardBase.replace("View order details", "View subscription"),
    ],
    [
      "duplicate action",
      cardBase.replace(
        "</section>",
        '<a href="/your-orders/order-details?orderID=' +
          id +
          '">View order details</a></section>',
      ),
    ],
    [
      "foreign selected link",
      cardBase.replace("?orderID=" + id, "?orderID=D01-0000000-0000002"),
    ],
    [
      "duplicate link identity",
      cardBase.replace("?orderID=" + id, "?orderID=" + id + "&orderId=" + id),
    ],
    [
      "foreign host",
      cardBase.replace(
        'href="/your-orders',
        'href="https://example.com/your-orders',
      ),
    ],
    [
      "unknown path",
      cardBase.replace(
        'href="/your-orders/order-details',
        'href="/unproven/order-details',
      ),
    ],
    [
      "extra merchandise",
      cardBase.replace(
        "</section>",
        '<a href="/dp/B0FAKE0001">Other merchandise</a></section>',
      ),
    ],
    [
      "purchased region collision",
      cardBase.replace(
        "</section>",
        '<div data-component="purchasedItems">Other merchandise</div></section>',
      ),
    ],
    [
      "refunded status",
      cardBase.replace("</section>", "<div>Refunded</div></section>"),
    ],
    ["unrecognized prefix", cardBase.replaceAll("D01-", "D02-")],
    ["unknown identifier", cardBase.replaceAll(id, "UNKNOWN")],
    [
      "unfamiliar header with a recognizable body reference",
      cardBase
        .replace("ORDER # " + id, "Order number UNKNOWN")
        .replace("</section>", "<span>111-0000000-0000001</span></section>"),
    ],
    [
      "numeric collision",
      cardBase.replace(
        "</section>",
        "<div>999-0000000-0000001</div></section>",
      ),
    ],
    [
      "uuid collision",
      cardBase.replace(
        "</section>",
        "<div>12345678-abcd-abcd-abcd-123456789abc</div></section>",
      ),
    ],
    ["missing date", cardBase.replace("Order placed 2 October 2026", "")],
    [
      "invalid calendar date",
      cardBase.replace("2 October 2026", "32 October 2026"),
    ],
  ];
  test.each(cardInvalid)(
    "fails closed for card %s",
    async (_label, invalid) => {
      html = invalid + purchase();
      const trace = new FailureDiagnostics();
      await expect(listed(trace)).rejects.toBeInstanceOf(Error);
      expect(trace.report(new Error("Fictional")).events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            reason: "LIST_ORDER_UNRESOLVED",
            count: 1,
          }),
        ]),
      );
    },
  );
  const changes: [string, string][] = [
    [
      "foreign order",
      "document.querySelector('[data-component=orderId]').textContent='D01-0000000-0000002'",
    ],
    [
      "hidden order",
      "document.querySelector('[data-component=orderId]').hidden=true",
    ],
    [
      "duplicate identity",
      "document.querySelector('main').insertAdjacentHTML('beforeend','<span hidden>D01-0000000-0000001</span>')",
    ],
    [
      "wrong date",
      "document.querySelector('[data-component=orderDate]').textContent='3 October 2026'",
    ],
    [
      "hidden date",
      "document.querySelector('[data-component=orderDate]').hidden=true",
    ],
    [
      "wrong identity label",
      "document.querySelector('[data-component=orderIdLabel]').textContent='Reference'",
    ],
    [
      "wrong service ASIN",
      "document.querySelectorAll('a').forEach(a=>{if(a.href.includes('/dp/'))a.href=a.href.replace('SERVICE_ASIN','B0FAKE0001')})",
    ],
    [
      "physical link presentation",
      "document.querySelectorAll('a').forEach(a=>{if(a.href.includes('/dp/'))a.href=a.href.split('?')[0]})",
    ],
    [
      "different service title",
      "document.querySelector('[data-component=itemTitle] a').textContent='Alexa+ accessory'",
    ],
    [
      "hidden extra name",
      "document.querySelector('[data-component=itemTitle]').insertAdjacentHTML('beforeend','<span hidden>Other merchandise</span>')",
    ],
    [
      "visible extra name",
      "document.querySelector('[data-component=itemTitle]').append('Other merchandise')",
    ],
    [
      "wrong seller",
      "document.querySelector('[data-component=orderedMerchant] a').textContent='Other seller'",
    ],
    [
      "wrong seller identity",
      "document.querySelector('[data-component=orderedMerchant] a').href='/gp/aag/main?seller=OTHER'",
    ],
    [
      "nonzero unit price",
      "document.querySelector('[data-component=unitPrice]').textContent='₹1.00'",
    ],
    [
      "missing price",
      "document.querySelector('[data-component=unitPrice]').remove()",
    ],
    [
      "conflicting price",
      "document.querySelector('[data-component=unitPrice] .a-offscreen').textContent='₹1.00'",
    ],
    [
      "hidden price",
      "document.querySelector('[data-component=unitPrice]').hidden=true",
    ],
    [
      "historical price",
      "document.querySelector('[data-component=unitPrice]').style.textDecoration='line-through'",
    ],
    [
      "unknown quantity",
      "document.querySelector('.a-fixed-left-grid').insertAdjacentHTML('beforeend','<div data-component=quantity>2</div>')",
    ],
    [
      "extra item",
      "document.querySelector('[data-component=purchasedItems]').insertAdjacentHTML('beforeend','<a href=\"/dp/B0FAKE0001\">Other product</a>')",
    ],
    [
      "hidden extra image",
      "document.querySelector('[data-component=purchasedItems]').insertAdjacentHTML('beforeend','<img hidden alt=\"Unknown product\">')",
    ],
    [
      "missing summary",
      "document.querySelector('[data-component=chargeSummary]').remove()",
    ],
    [
      "conflicting total",
      "document.querySelectorAll('.od-line-item-row-content')[1].textContent='₹1.00'",
    ],
    [
      "conflicting subtotal",
      "document.querySelectorAll('.od-line-item-row-content')[0].textContent='₹1.00'",
    ],
    [
      "generic total",
      "document.querySelectorAll('.od-line-item-row-label')[1].textContent='Total'",
    ],
    [
      "hidden total",
      "document.querySelectorAll('.od-line-item-row')[1].hidden=true",
    ],
    [
      "extra financial row",
      "document.querySelector('[data-component=chargeSummary]').append('Refund ₹1.00')",
    ],
    [
      "duplicate summary",
      "document.querySelector('main').append(document.querySelector('[data-component=chargeSummary]').cloneNode(true))",
    ],
  ];
  test.each(changes)("fails closed for detail %s", async (_label, code) => {
    detail = mutate(detailBase, code);
    await expect(parse()).rejects.toBeInstanceOf(Error);
    expect(context.pages()).toHaveLength(1);
  });
  test.each([404, 500])(
    "rejects HTTP %i even with valid HTML",
    async (code) => {
      status = code;
      await expect(parse()).rejects.toBeInstanceOf(Error);
    },
  );
  test("revalidates the selected card after detail inspection", async () => {
    sourceChange =
      "document.querySelector('.order-header').innerHTML+='Changed ₹1.00'";
    await expect(parse()).rejects.toBeInstanceOf(Error);
  });
  test("another distinct D01 activation stays unresolved even with matching facts", async () => {
    html =
      cardBase + cardBase.replaceAll(id, "D01-0000000-0000002") + purchase();
    await expect(listed()).rejects.toBeInstanceOf(Error);
  });
  test("an unknown D01 after the merchandise cap cannot be silently skipped", async () => {
    html = purchase() + cardBase.replaceAll(ALEXA_UPGRADE.asin, "B0FAKE0001");
    await expect(listed()).rejects.toBeInstanceOf(Error);
  });
  test("a date change during detail inspection invalidates the original card", async () => {
    sourceChange =
      "document.querySelector('.order-header').innerHTML=document.querySelector('.order-header').innerHTML.replace('2 October 2026','3 October 2026')";
    await expect(parse()).rejects.toBeInstanceOf(Error);
  });
  test("a conflicting duplicate date cannot disappear on a later page", async () => {
    html = cardBase + next;
    page2 = cardBase.replace("2 October 2026", "3 October 2026") + purchase();
    await expect(listed()).rejects.toMatchObject({
      reason: "LIST_DUPLICATE_CONFLICT",
    });
  });
  test("unresolved digital evidence preserves previous complete output atomically", async () => {
    const directory = await mkdtemp(join(tmpdir(), "digital-upgrade-")),
      output = join(directory, "prior.json"),
      reports: unknown[] = [];
    try {
      await writeFile(output, "previous complete export");
      html = cardBase.replaceAll(ALEXA_UPGRADE.asin, "B0FAKE0001") + purchase();
      jest
        .spyOn(chromium, "launchPersistentContext")
        .mockResolvedValue(context);
      const extract = jest.fn();
      await expect(
        runExport(
          {
            startDate: "2026-10-01",
            endDate: "2026-10-30",
            maxOrders: 50,
            output,
          },
          () => {},
          {
            list: listOrders,
            extract,
            write: validateAndWriteExport,
            report: async (r) => {
              reports.push(r);
            },
            cleanup: async () => {},
          },
        ),
      ).rejects.toBeInstanceOf(Error);
      expect(extract).not.toHaveBeenCalled();
      expect(await readFile(output, "utf8")).toBe("previous complete export");
      expect(await readdir(directory)).toEqual(["prior.json"]);
      expect(reports).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
