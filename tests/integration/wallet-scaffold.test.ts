/** Offline synthetic wallet ownership and non-content accounting regressions. */
import { existsSync, readFileSync } from "fs";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Browser, BrowserContext, Page, chromium } from "playwright";
import { classifyWalletFundingCard } from "../../src/poc/wallet-card-classification";
import {
  closeBrowser,
  extractOrderItems,
  listOrders,
  parseCurrentOrderPage,
} from "../../src/poc/hardened-index-v3";
import { FailureDiagnostics } from "../../src/poc/failure-diagnostics";
import { runExport, validateAndWriteExport } from "../../src/poc/export-json";

const executable = [chromium.executablePath(), "/usr/bin/chromium"].find(
  existsSync,
);
const browserTests = executable ? describe : describe.skip;
const fixture = readFileSync(
  join(__dirname, "fixtures/order-card-wallet-scaffold.html"),
  "utf8",
);
const minimal = readFileSync(
  join(__dirname, "fixtures/order-card-wallet-confirmed.html"),
  "utf8",
);
const id = "111-2222222-4444444",
  purchaseId = "111-2222222-3333333";
const selector = '.js-order-card, .order-card, [class*="order-card"]';
const purchase = (value = purchaseId): string =>
  `<section class="order-card"><div class="order-header">Order placed 1 October 2026<div>Total ₹10.00</div><span>${value}</span></div><div data-component="purchasedItems"><a href="/dp/B000000015">Invented merchandise</a></div></section>`;
const options = {
  startDate: "2026-10-01",
  endDate: "2026-10-02",
  maxOrders: 2,
};
const invalid: Array<[string, string]> = [
  [
    "nonempty list",
    `document.querySelector('.yo-collapsible-actions__list').innerHTML='<li>Unknown action</li>'`,
  ],
  [
    "hidden list content",
    `document.querySelector('.yo-collapsible-actions__list').innerHTML='<li hidden>₹4</li>'`,
  ],
  [
    "collapsed content text",
    `document.querySelector('.a-expander-content').textContent='Unknown'`,
  ],
  [
    "collapsed content element",
    `document.querySelector('.a-expander-content').innerHTML='<span hidden></span>'`,
  ],
  [
    "active toggle",
    `document.querySelector('.yo-collapsible-actions__toggle').style.display='block'`,
  ],
  [
    "expanded pane",
    `document.querySelector('.a-expander-content').setAttribute('aria-expanded','true')`,
  ],
  [
    "visible pane",
    `document.querySelector('.a-expander-content').style.display='block'`,
  ],
  [
    "wrong href",
    `document.querySelector('[data-action]').href='https://example.invalid/action'`,
  ],
  [
    "wrong prompt",
    `document.querySelector('.a-expander-prompt').textContent='More options ₹1'`,
  ],
  [
    "duplicate prompt",
    `document.querySelector('[data-action]').append(document.querySelector('.a-expander-prompt').cloneNode(true))`,
  ],
  [
    "nested prompt payload",
    `document.querySelector('.a-expander-prompt').innerHTML='More options<span hidden>Qty: 1</span>'`,
  ],
  [
    "wrong icon",
    `document.querySelector('.a-icon-extender-expand').className='other-icon'`,
  ],
  [
    "duplicate widget",
    `document.querySelector('.a-button-stack').append(document.querySelector('.yo-collapsible-actions').cloneNode(true))`,
  ],
  [
    "nested card",
    `document.querySelector('.yo-collapsible-actions').classList.add('order-card')`,
  ],
  [
    "wrong sibling position",
    `document.querySelector('#funding-block').append(document.querySelector('#actions-column'))`,
  ],
  [
    "extra column",
    `document.querySelector('.a-fixed-right-grid-inner').append(document.createElement('div'))`,
  ],
  [
    "unknown column content",
    `document.querySelector('#actions-column').insertAdjacentHTML('beforeend','<span>Unknown</span>')`,
  ],
  [
    "empty unowned element",
    `document.querySelector('.a-button-stack').append(document.createElement('div'))`,
  ],
  [
    "hidden quantity beside code",
    `document.querySelector('.order-card').insertAdjacentHTML('beforeend','<span hidden>Qty: 1</span>')`,
  ],
  [
    "visible price beside code",
    `document.querySelector('.order-card').insertAdjacentHTML('beforeend','<span>₹4</span>')`,
  ],
  [
    "hidden unknown text",
    `document.querySelector('.order-card').insertAdjacentHTML('beforeend','<span hidden>Another purchase</span>')`,
  ],
  [
    "hidden incomplete product",
    `document.querySelector('#actions-column').insertAdjacentHTML('beforeend','<div hidden>Invented merchandise</div>')`,
  ],
  [
    "hidden purchased region",
    `document.querySelector('.order-card').insertAdjacentHTML('beforeend','<div data-component="purchasedItems" hidden></div>')`,
  ],
  [
    "extra product link",
    `document.querySelector('#actions-column').insertAdjacentHTML('beforeend','<a href="/dp/B0FAKE0099">Other product</a>')`,
  ],
  [
    "extra image",
    `document.querySelector('#actions-column').insertAdjacentHTML('beforeend','<img alt="Other product">')`,
  ],
  [
    "template payload",
    `document.querySelector('.yo-collapsible-actions').insertAdjacentHTML('beforeend','<template><span>₹4</span></template>')`,
  ],
  [
    "noscript payload",
    `document.querySelector('.a-button-stack').insertAdjacentHTML('beforeend','<noscript>Unknown</noscript>')`,
  ],
  [
    "rendered script source",
    `document.querySelector('script').style.display='block'`,
  ],
  [
    "rendered style source",
    `document.querySelector('style').style.display='block'`,
  ],
  [
    "duplicate hidden heading",
    `document.querySelector('#funding-block').insertAdjacentHTML('beforeend','<h3 hidden>Amazon Pay Wallet</h3>')`,
  ],
  [
    "historical status",
    `document.querySelector('h3').parentElement.parentElement.nextElementSibling.style.textDecoration='line-through'`,
  ],
  [
    "wrong third parent",
    `document.querySelector('h3').outerHTML='<div><h3>Amazon Pay Wallet</h3></div>'`,
  ],
  [
    "conflicting ID",
    `document.querySelector('#actions-column').dataset.orderId='111-2222222-9999999'`,
  ],
  [
    "duplicate identity",
    `document.querySelector('.order-card').insertAdjacentHTML('beforeend','<span hidden>111-2222222-4444444</span>')`,
  ],
  [
    "conflicting link ASIN",
    `document.querySelector('#funding-block a:last-child').href='https://www.amazon.in/dp/B0FAKE0099'`,
  ],
  ["conflicting image alt", `document.querySelector('img').alt='B0FAKE0099'`],
  [
    "payment context",
    `document.querySelector('.a-fixed-right-grid-inner').dataset.component='paymentSummary'`,
  ],
  [
    "paid merchandise status",
    `document.querySelector('h3').parentElement.parentElement.nextElementSibling.querySelector('span').textContent='Money added pending'`,
  ],
];

browserTests("wallet empty actions scaffold", () => {
  let browser: Browser,
    context: BrowserContext,
    page: Page,
    html: string,
    second: string;
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
    second = purchase();
    context = await browser.newContext({
      offline: true,
      serviceWorkers: "block",
    });
    await context.route("**/*", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body:
          new URL(route.request().url()).searchParams.get("page") === "2"
            ? second
            : html,
      }),
    );
    page = await context.newPage();
    await page.goto("https://www.amazon.in/your-orders/orders");
  });
  afterEach(async () => {
    await closeBrowser();
    await context.close();
    jest.restoreAllMocks();
  });
  const classify = async (): Promise<string> => {
    const card = page.locator(selector).first();
    return classifyWalletFundingCard(
      card,
      await card.innerText(),
      id,
      selector,
    );
  };
  test("accepts only the complete proof with a recursively accounted empty sibling scaffold", async () => {
    expect(await classify()).toBe("funding-only");
    expect(await parseCurrentOrderPage(page)).toEqual([]);
  });
  test("minimal proven cards still work and code alone does not require a scaffold", async () => {
    await page.setContent(minimal + "<div></div>");
    expect(await classify()).toBe("funding-only");
    await page.evaluate(() =>
      document
        .querySelector(".order-card")
        ?.insertAdjacentHTML(
          "beforeend",
          '<div><script type="application/json">{"invented":"₹5"}</script><style>.invented { color: black }</style></div>',
        ),
    );
    expect(await classify()).toBe("funding-only");
  });
  test.each(["₹2.50", "₹41.00"])(
    "funding proof does not depend on the amount %s",
    async (amount) => {
      await page.setContent(fixture.replace("₹17.00", amount));
      expect(await classify()).toBe("funding-only");
    },
  );
  test.each(invalid)("retains %s", async (_label, code) => {
    await page.evaluate(code);
    expect(await classify()).toBe("unverified");
  });
  test("an unverified scaffold preserves the previous complete output", async () => {
    html = fixture.replace(
      'role="list"></ul>',
      'role="list"><li>Unknown action</li></ul>',
    );
    await page.setContent(html);
    expect((await parseCurrentOrderPage(page))[0].orderId).toBe(id);
    jest.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context);
    const directory = await mkdtemp(
      join(tmpdir(), "synthetic-wallet-scaffold-"),
    );
    const output = join(directory, "orders.json");
    await writeFile(output, "prior complete export");
    try {
      await expect(
        runExport({ ...options, output }, () => {}, {
          list: listOrders,
          extract: extractOrderItems,
          write: validateAndWriteExport,
          report: async () => {},
          cleanup: async () => {},
        }),
      ).rejects.toBeInstanceOf(Error);
      expect(await readFile(output, "utf8")).toBe("prior complete export");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("counts funding once across pages without consuming merchandise slots", async () => {
    html =
      fixture +
      '<ul class="a-pagination"><li class="a-last"><a href="?page=2">Next</a></li></ul>';
    second = fixture + purchase() + purchase("111-2222222-5555555");
    jest.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context);
    const trace = new FailureDiagnostics();
    const selected = await listOrders(
      options.startDate,
      options.endDate,
      2,
      trace,
    );
    expect(selected.pagesScanned).toBe(2);
    expect(selected.orders.map((o) => o.orderId)).toEqual([
      purchaseId,
      "111-2222222-5555555",
    ]);
    expect(
      trace
        .report(new Error())
        .events.filter((e) => e.reason === "LIST_WALLET_FUNDING_EXCLUDED"),
    ).toEqual([expect.objectContaining({ count: 1, orderIndex: undefined })]);
  });
  test("conflicting funding facts across pages remain fatal", async () => {
    html =
      fixture +
      '<ul class="a-pagination"><li class="a-last"><a href="?page=2">Next</a></li></ul>';
    second = fixture.replace("₹17.00", "₹18.00") + purchase();
    jest.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context);
    await expect(
      listOrders(
        options.startDate,
        options.endDate,
        2,
        new FailureDiagnostics(),
      ),
    ).rejects.toMatchObject({ reason: "LIST_DUPLICATE_CONFLICT" });
  });
});
