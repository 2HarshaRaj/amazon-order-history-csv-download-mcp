/** Owner-confirmed generic structure, entirely invented data, offline Chromium. */
import { existsSync, readFileSync } from "fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Browser, BrowserContext, Page, chromium } from "playwright";
import { classifyWalletFundingCard } from "../../src/poc/wallet-card-classification";
import {
  FailureDiagnostics,
  writeFailureReport,
} from "../../src/poc/failure-diagnostics";
import {
  closeBrowser,
  extractOrderItems,
  listOrders,
  parseCurrentOrderPage,
} from "../../src/poc/hardened-index-v3";
import { runExport, validateAndWriteExport } from "../../src/poc/export-json";

const executable = [chromium.executablePath(), "/usr/bin/chromium"].find(
  existsSync,
);
const browserTests = executable ? describe : describe.skip;
const walletId = "111-2222222-4444444",
  purchaseId = "111-2222222-3333333",
  otherId = "111-2222222-5555555";
const selector = '.js-order-card, .order-card, [class*="order-card"]';
const wallet = readFileSync(
  join(__dirname, "fixtures/order-card-wallet-confirmed.html"),
  "utf8",
);
const detail = readFileSync(
  join(__dirname, "fixtures/order-detail-in-grand-total.html"),
  "utf8",
)
  .replaceAll("408-0000000-0000015", purchaseId)
  .replaceAll("1,220.00", "10.00")
  .replaceAll("1,225.00", "10.00")
  .replaceAll("₹5.00", "₹0.00")
  .replace(
    'id="od-subtotals"',
    `id="od-subtotals" data-order-id="${purchaseId}"`,
  );
const purchase = (id = purchaseId): string =>
  `<section class="order-card"><div class="order-header"><div>Order placed 1 October 2026</div><div>Total ₹10.00</div><span>${id}</span></div><div data-component="purchasedItems"><a href="/dp/B000000015">Invented merchandise</a></div><div>Paid using Amazon Pay wallet balance</div></section>`;
const next =
  '<ul class="a-pagination"><li class="a-last"><a href="?page=2">Next</a></li></ul>';
const options = {
  startDate: "2026-10-01",
  endDate: "2026-10-02",
  maxOrders: 2,
};
const uncertain: [string, string][] = [
  [
    "same a-row",
    wallet.replace('</h3></a></div>\n<div class="a-row">', "</h3></a>"),
  ],
  [
    "excessive evidence",
    wallet.replace(
      "<span>Money added</span>",
      `<span>Money added</span>${"<i></i>".repeat(1001)}`,
    ),
  ],
  [
    "partial heading",
    wallet.replace(">Amazon Pay Wallet<", ">Amazon Pay Wallet Plus<"),
  ],
  ["partial status", wallet.replace(">Money added<", ">Money added pending<")],
  [
    "wrong heading tag",
    wallet.replace("<h3>", "<div>").replace("</h3>", "</div>"),
  ],
  [
    "wrong status tag",
    wallet.replace("<span>Money added</span>", "<div>Money added</div>"),
  ],
  [
    "duplicate heading",
    wallet.replace("</h3>", "</h3><h3>Amazon Pay Wallet</h3>"),
  ],
  [
    "duplicate status",
    wallet.replace(
      "<span>Money added</span>",
      "<span>Money added</span><span>Money added</span>",
    ),
  ],
  [
    "hidden duplicate heading",
    wallet.replace("</h3>", "</h3><h3 hidden>Amazon Pay Wallet</h3>"),
  ],
  [
    "historical duplicate status",
    wallet.replace(
      "<span>Money added</span>",
      "<span>Money added</span><s><span>Money added</span></s>",
    ),
  ],
  ...[
    "hidden",
    'aria-hidden="true"',
    'style="opacity:0"',
    'style="display:none"',
    'style="text-decoration:line-through"',
  ].map((attribute): [string, string] => [
    attribute,
    wallet.replace("<h3>", `<h3 ${attribute}>`),
  ]),
  [
    "different ancestors",
    wallet.replace(
      "<h3>Amazon Pay Wallet</h3>",
      "<div><h3>Amazon Pay Wallet</h3></div>",
    ),
  ],
  ["missing a-row", wallet.replace('class="a-row"', 'class="other-row"')],
  [
    "wrong card ownership",
    wallet.replace(
      '<a href="https://www.amazon.in/dp/B0FUND0001"><h3>',
      '<a class="order-card" href="https://www.amazon.in/dp/B0FUND0001"><h3>',
    ),
  ],
  [
    "purchased items",
    wallet.replace(
      '<div id="wallet-content">',
      '<div data-component="purchasedItems"></div><div id="wallet-content">',
    ),
  ],
  [
    "hidden purchased items",
    wallet.replace(
      '<div id="wallet-content">',
      '<div data-component="purchasedItems" hidden></div><div id="wallet-content">',
    ),
  ],
  ["merchandise price", wallet.replace("</h3>", "</h3><span>₹3.00</span>")],
  [
    "hidden quantity",
    wallet.replace("</h3>", "</h3><span hidden>Qty: 1</span>"),
  ],
  [
    "extra product",
    wallet.replace(
      "</section>",
      '<a href="/dp/B0FAKE0099">Another product</a></section>',
    ),
  ],
  [
    "incomplete product",
    wallet.replace(
      "</section>",
      "<div>Invented incomplete product</div></section>",
    ),
  ],
  [
    "different link identifiers",
    wallet.replace('B0FUND0001"><h3>', 'B0FUND0002"><h3>'),
  ],
  [
    "image identifier conflict",
    wallet.replace('alt="Invented wallet icon"', 'alt="B0FAKE0099"'),
  ],
  [
    "extra image",
    wallet.replace(
      "</section>",
      '<img width="20" height="20" alt="Unowned product"></section>',
    ),
  ],
  ["missing image", wallet.replace(/<img[^>]+>/, "")],
  [
    "wrong identity",
    wallet.replace(
      'id="wallet-content"',
      'id="wallet-content" data-order-id="111-2222222-9999999"',
    ),
  ],
  [
    "duplicate identity",
    wallet.replace("</section>", `<div>${walletId}</div></section>`),
  ],
  [
    "payment widget",
    wallet.replace(
      'id="wallet-content"',
      'id="wallet-content" data-component="paymentSummary"',
    ),
  ],
  [
    "cancelled",
    wallet
      .replace("Order placed", "Cancelled Order placed")
      .replace(
        'id="wallet-content"',
        'id="wallet-content" class="a-fixed-left-grid"',
      ),
  ],
  ["refund", wallet.replace("Order placed", "Refunded Order placed")],
  ["delivered purchase title", wallet.replace("Money added", "Delivered")],
];

browserTests("verified wallet funding classification", () => {
  let browser: Browser,
    context: BrowserContext,
    page: Page,
    html: string,
    second: string,
    requests: string[];
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
    html = wallet + purchase();
    second = purchase(otherId);
    requests = [];
    context = await browser.newContext({
      offline: true,
      serviceWorkers: "block",
    });
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      requests.push(url.pathname + url.search);
      let body = html;
      if (url.pathname.includes("order-details")) body = detail;
      else if (url.searchParams.get("page") === "2") body = second;
      return route.fulfill({ contentType: "text/html; charset=utf-8", body });
    });
    page = await context.newPage();
    await page.goto("https://www.amazon.in/your-orders/orders");
  });
  afterEach(async () => {
    await closeBrowser();
    await context.close();
    jest.restoreAllMocks();
  });
  const parse = async (fixture: string, trace?: FailureDiagnostics) => {
    await page.setContent(fixture);
    return parseCurrentOrderPage(page, trace);
  };
  test("exact confirmed structure excludes funding before the merchandise cap", async () => {
    const card = page.locator(selector).first();
    expect(
      await classifyWalletFundingCard(
        card,
        await card.innerText(),
        walletId,
        selector,
      ),
    ).toBe("funding-only");
    jest.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context);
    const trace = new FailureDiagnostics();
    const selected = await listOrders(
      options.startDate,
      options.endDate,
      1,
      trace,
    );
    expect(selected.orders.map((order) => order.orderId)).toEqual([purchaseId]);
    const events = trace
      .report(new Error())
      .events.filter(
        (event) => event.reason === "LIST_WALLET_FUNDING_EXCLUDED",
      );
    expect(events).toEqual([
      expect.objectContaining({ stage: "list", count: 1 }),
    ]);
    expect(events[0].orderIndex).toBeUndefined();
    expect(JSON.stringify(events)).not.toMatch(/111-|17\.00|Amazon Pay|\/dp\//);
  });
  test("two dp links or missing purchasedItems without the pair cannot exclude a purchase", async () => {
    expect(
      await parse(wallet.replace("Money added", "Delivered")),
    ).toHaveLength(1);
    expect(
      await parse(
        wallet.replace("Amazon Pay Wallet", "Invented wallet merchandise"),
      ),
    ).toHaveLength(1);
  });
  test.each(uncertain)(
    "uncertain %s remains selected and preserves atomic failure",
    async (_name, fixture) => {
      expect(fixture).not.toBe(wallet);
      html = fixture;
      // Retention is observable independently from whichever strict detail rule fails.
      const selected = await parse(fixture);
      expect(selected).toHaveLength(1);
      expect(selected[0].orderId).toBe(walletId);
      jest
        .spyOn(chromium, "launchPersistentContext")
        .mockResolvedValue(context);
      const directory = await mkdtemp(join(tmpdir(), "wallet-class-atomic-"));
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
        ).rejects.toMatchObject({ category: "validation" });
        expect(await readFile(output, "utf8")).toBe("prior complete export");
        expect(await readdir(directory)).toEqual(["orders.json"]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    15000,
  );
  test("funding-only pages advance pagination without losing merchandise indexes", async () => {
    html = wallet + next;
    second = wallet + purchase() + purchase(otherId);
    jest.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context);
    const trace = new FailureDiagnostics();
    const result = await listOrders(
      options.startDate,
      options.endDate,
      2,
      trace,
    );
    expect(result.pagesScanned).toBe(2);
    expect(result.orders.map((order) => order.orderId)).toEqual([
      purchaseId,
      otherId,
    ]);
    const events = trace
      .report(new Error())
      .events.filter(
        (event) => event.reason === "LIST_WALLET_FUNDING_EXCLUDED",
      );
    expect(events).toHaveLength(1);
    expect(events[0].count).toBe(1);
  });
  test("old funding-only pages cannot trigger the merchandise date cutoff", async () => {
    html = wallet.replace("1 October 2026", "30 September 2026") + next;
    second = purchase();
    jest.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context);
    const result = await listOrders(
      options.startDate,
      options.endDate,
      1,
      new FailureDiagnostics(),
    );
    expect(result.pagesScanned).toBe(2);
    expect(result.orders.map((order) => order.orderId)).toEqual([purchaseId]);
  });
  test("new over-cap funding-looking cards retain the existing non-validation behavior", async () => {
    html = purchase() + wallet.replace("Total ₹17.00", "Total unavailable");
    jest.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context);
    const result = await listOrders(
      options.startDate,
      options.endDate,
      1,
      new FailureDiagnostics(),
    );
    expect(result.orders.map((order) => order.orderId)).toEqual([purchaseId]);
  });
  test("only funding records produce an empty merchandise export and no detail requests", async () => {
    html = wallet;
    jest.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context);
    const result = await listOrders(
      options.startDate,
      options.endDate,
      2,
      new FailureDiagnostics(),
    );
    expect(result.orders).toEqual([]);
    expect(result.pagesScanned).toBe(1);
    expect(requests.some((url) => url.includes("order-details"))).toBe(false);
    const directory = await mkdtemp(join(tmpdir(), "wallet-only-export-"));
    const output = join(directory, "orders.json");
    try {
      await runExport({ ...options, output }, () => {}, {
        list: listOrders,
        extract: extractOrderItems,
        write: validateAndWriteExport,
        report: async () => {},
        cleanup: async () => {},
      });
      expect(JSON.parse(await readFile(output, "utf8")).orders).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  test.each(["payment widget", "product title"])(
    "a genuine wallet-related purchase is retained: %s",
    async (mode) => {
      const payment = wallet
        .slice(
          wallet.indexOf('<div id="wallet-content">'),
          wallet.lastIndexOf("</section>"),
        )
        .replace('id="wallet-content"', 'data-component="paymentSummary"');
      html =
        mode === "payment widget"
          ? purchase().replace("</section>", `${payment}</section>`)
          : purchase().replace(
              "Invented merchandise",
              "<h3>Invented case for Amazon Pay Wallet</h3>",
            );
      jest
        .spyOn(chromium, "launchPersistentContext")
        .mockResolvedValue(context);
      expect(
        (
          await listOrders(
            options.startDate,
            options.endDate,
            1,
            new FailureDiagnostics(),
          )
        ).orders.map((order) => order.orderId),
      ).toEqual([purchaseId]);
      const directory = await mkdtemp(join(tmpdir(), "wallet-paid-export-"));
      const output = join(directory, "orders.json");
      try {
        await runExport({ ...options, output }, () => {}, {
          list: listOrders,
          extract: extractOrderItems,
          write: validateAndWriteExport,
          report: async () => {},
          cleanup: async () => {},
        });
        expect(
          JSON.parse(await readFile(output, "utf8")).orders[0].orderId,
        ).toBe(purchaseId);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
  test("conflicting funding duplicate amounts fail closed", async () => {
    html = wallet + wallet.replace("₹17.00", "₹18.00");
    await expect(parseCurrentOrderPage(page)).resolves.toHaveLength(1);
    await page.setContent(html);
    await expect(
      parseCurrentOrderPage(page, new FailureDiagnostics()),
    ).rejects.toMatchObject({ reason: "LIST_DUPLICATE_CONFLICT" });
  });
  test.each([
    "funding then purchase",
    "purchase then funding",
    "funding date conflict",
  ])("classification dedup fails closed: %s", async (mode) => {
    html =
      (mode === "purchase then funding" ? purchase(walletId) : wallet) + next;
    second =
      mode === "funding then purchase"
        ? purchase(walletId)
        : mode === "funding date conflict"
          ? wallet.replace("1 October", "2 October")
          : wallet;
    jest.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context);
    await expect(
      listOrders(
        options.startDate,
        options.endDate,
        3,
        new FailureDiagnostics(),
      ),
    ).rejects.toMatchObject({ reason: "LIST_DUPLICATE_CONFLICT" });
  });
  test("verified exclusion publishes purchases only, preserving original names and total source", async () => {
    jest.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context);
    const directory = await mkdtemp(join(tmpdir(), "wallet-class-export-"));
    const output = join(directory, "orders.json");
    try {
      await runExport({ ...options, output }, () => {}, {
        list: listOrders,
        extract: extractOrderItems,
        write: validateAndWriteExport,
        report: async () => {},
        cleanup: async () => {},
      });
      const document = JSON.parse(await readFile(output, "utf8"));
      expect(document.orders).toHaveLength(1);
      expect(document.orders[0].orderId).toBe(purchaseId);
      expect(document.orders[0].items[0].lineIndex).toBe(0);
      expect(document.orders[0].orderTotal).toBe(10);
      expect(requests.some((url) => url.includes(walletId))).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  test("excluded counts persist without funding identities or amounts", async () => {
    const trace = new FailureDiagnostics();
    await parse(wallet, trace);
    const directory = await mkdtemp(join(tmpdir(), "wallet-class-report-"));
    try {
      await writeFailureReport(trace.report(new Error()), directory);
      const [file] = await readdir(directory);
      const data = await readFile(join(directory, file), "utf8");
      expect(data).not.toMatch(/111-|17\.00|Amazon Pay Wallet|\/dp\//);
      expect(JSON.parse(data).events[0]).toMatchObject({
        reason: "LIST_WALLET_FUNDING_EXCLUDED",
        count: 1,
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
