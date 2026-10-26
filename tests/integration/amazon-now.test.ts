/** Invented fixtures, ephemeral Chromium, every request intercepted. No Amazon access. */
import { existsSync, readFileSync } from "fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { chromium, Browser, BrowserContext, Page } from "playwright";
import { extractNowOrder } from "../../src/poc/amazon-now";
import {
  AuthenticationRequiredError,
  closeBrowser,
  extractOrderItems,
  listOrders,
  parseCurrentOrderPage,
} from "../../src/poc/hardened-index-v3";
import {
  createExportDocument,
  runExport,
  validateAndWriteExport,
} from "../../src/poc/export-json";

const executable = [chromium.executablePath(), "/usr/bin/chromium"].find(
  existsSync,
);
const browserTests = executable ? describe : describe.skip;
const id = "111-2222222-3333333";
const outer = `https://www.amazon.in/uff/your-account/order-details?orderID=${id}`;
const tracking = `https://www.amazon.in/tez/browse/orderTracking?orderId=${id}`;
const original = readFileSync(
  join(__dirname, "fixtures/amazon-now-order.html"),
  "utf8",
);
const presentation = readFileSync(
  join(__dirname, "fixtures/amazon-now-presentation.html"),
  "utf8",
);
const list = `<div class="order-card"><div class="order-header">Order placed 1 October 2026<div>Total ₹230.00</div><span>${id}</span></div><a href="${outer}">View order details</a></div>`;
const options = {
  startDate: "2026-10-01",
  endDate: "2026-10-02",
  maxOrders: 5,
};

browserTests("integrated Amazon Now extraction", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let html: string;
  let listHtml: string;
  let redirect: string;
  let requests: string[];
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
    context = await browser.newContext({
      offline: true,
      serviceWorkers: "block",
    });
    html = original;
    listHtml = list;
    redirect = tracking;
    requests = [];
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      requests.push(url.pathname);
      if (url.pathname.startsWith("/uff/"))
        return route.fulfill({
          contentType: "text/html",
          body: `<script>location.replace(${JSON.stringify(redirect)})</script>`,
        });
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: url.pathname.startsWith("/tez/") ? html : listHtml,
      });
    });
    page = await context.newPage();
  });
  afterEach(async () => {
    await closeBrowser();
    await context.close();
    jest.restoreAllMocks();
  });
  const extract = async () => extractNowOrder(page, id, outer, async () => {});

  test("second invented presentation exports all 23 effective merchandise rows", async () => {
    html = presentation;
    listHtml = list.replace("₹230.00", "₹736.00");
    jest.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context);
    const [summary] = (await listOrders(options.startDate, options.endDate, 5))
      .orders;
    const detail = await extractOrderItems(id, undefined, summary);
    expect(detail.items).toHaveLength(23);
    expect(detail.items.map((item) => item.productName)).toEqual(
      Array.from(
        { length: 23 },
        (_, index) =>
          `Fictional market item ${String(index + 1).padStart(2, "0")}`,
      ),
    );
    expect(detail.items.map((item) => item.quantity)).toEqual(
      Array(23).fill(1),
    );
    expect(detail.items.map((item) => item.itemTotal?.amount)).toEqual(
      Array.from({ length: 23 }, (_, index) => index + 21),
    );
    expect(
      detail.items.every(
        (item) => item.unitPrice?.amount === item.itemTotal?.amount,
      ),
    ).toBe(true);
    expect(detail.items[0].asin).toBe("B0FAKE0001");
    expect(detail.items[3].asin).toBe("");
    expect(detail.orderTotal?.amount).toBe(736);
    expect(detail.orderTotalSource).toBe("amazon-now-you-pay");
    expect(detail.adjustments).toEqual([]);
    const document = createExportDocument(
      options,
      1,
      [{ summary, detail }],
      new Date().toISOString(),
    );
    expect(document.orders[0].items.map((item) => item.lineIndex)).toEqual(
      Array.from({ length: 23 }, (_, index) => index),
    );
    expect(JSON.stringify(document)).not.toMatch(
      /Gift Cards|Voucher|Payment card|Inclusive of taxes|999/,
    );
    expect(await page.locator("button").getAttribute("data-clicked")).toBe(
      "yes",
    );
  });

  test.each([
    "wrong",
    "missing",
    "duplicate",
    "hidden",
    "doubleHash",
    "suffix",
    "wrongOwner",
  ])("tracking %s identity prevents the click", async (mode) => {
    html = presentation;
    if (mode === "wrong")
      html = html.replace(
        `<span>#${id}</span>`,
        "<span>#111-2222222-4444444</span>",
      );
    if (mode === "missing")
      html = html.replace("<b>Order ID</b>", "<b>Reference</b>");
    if (mode === "duplicate")
      html = html.replace(
        "<h1>Order tracking</h1>",
        `<h1>Order tracking</h1><div>Order ID #${id}</div>`,
      );
    if (mode === "hidden")
      html = html.replace('id="tracking-id"', 'id="tracking-id" hidden');
    if (mode === "doubleHash")
      html = html.replace(`<span>#${id}</span>`, `<span>##${id}</span>`);
    if (mode === "suffix")
      html = html.replace(`<span>#${id}</span>`, `<span>#${id}0</span>`);
    if (mode === "wrongOwner")
      html = html.replace(
        `data-order-id="${id}"`,
        'data-order-id="111-2222222-4444444"',
      );
    await expect(extract()).rejects.toThrow();
    expect(
      await page.locator("button").getAttribute("data-clicked"),
    ).toBeNull();
  });

  test.each([
    "wrongSheet",
    "duplicateSheetId",
    "doubleHashSheet",
    "missingQuantity",
    "ambiguousQuantity",
    "duplicateQuantity",
    "quantityTwo",
    "twoCurrentPrices",
    "malformedPrice",
    "unmarkedOldPrice",
    "hiddenPrice",
    "missingBilled",
    "duplicateBilled",
    "conflictingBilled",
    "hiddenBilled",
    "twoBilledValues",
    "unknownSubtitle",
    "includedFee",
    "unknownCharge",
    "unclassifiedImage",
    "merchandiseInPayment",
  ])("presentation rejects %s instead of guessing", async (mode) => {
    html = presentation;
    if (mode === "wrongSheet")
      html = html.replace(
        `<b>Order ID:</b><span>#${id}</span>`,
        "<b>Order ID:</b><span>#111-2222222-4444444</span>",
      );
    if (mode === "duplicateSheetId")
      html = html.replace(
        "<h1>Order Details</h1>",
        `<h1>Order Details</h1><div>Order ID #${id}</div>`,
      );
    if (mode === "doubleHashSheet")
      html = html.replace(
        `<b>Order ID:</b><span>#${id}</span>`,
        `<b>Order ID:</b><span>##${id}</span>`,
      );
    if (mode === "missingQuantity")
      html = html.replace("500 g · <span>1 unit</span>", "500 g");
    if (mode === "ambiguousQuantity")
      html = html.replace(
        "<span>1 unit</span>",
        "<span>1 unit · 2 units</span>",
      );
    if (mode === "duplicateQuantity")
      html = html.replace(
        "<span>1 unit</span>",
        "<span>1 unit</span><span>Qty: 1</span>",
      );
    if (mode === "quantityTwo")
      html = html.replace("<span>1 unit</span>", "<span>2 units</span>");
    if (mode === "twoCurrentPrices")
      html = html.replace(
        'class="effective-number">21.00</span>',
        'class="effective-number">21.00</span><span>₹22.00</span>',
      );
    if (mode === "malformedPrice")
      html = html.replace(
        'class="effective-number">21.00',
        'class="effective-number">21.001',
      );
    if (mode === "unmarkedOldPrice")
      html = html.replace(
        "<del><span>₹</span><span>26.00</span></del>",
        "<div><span>₹</span><span>26.00</span></div>",
      );
    if (mode === "hiddenPrice")
      html = html.replace(
        'class="effective-symbol"',
        'class="effective-symbol" hidden',
      );
    if (mode === "missingBilled")
      html = html.replace(
        "<strong>You pay</strong>",
        "<strong>Other total</strong>",
      );
    if (mode === "duplicateBilled" || mode === "conflictingBilled")
      html = html.replace(
        '<div id="billed">',
        `<div>You pay ₹${mode === "duplicateBilled" ? "736" : "737"}.00</div><div id="billed">`,
      );
    if (mode === "hiddenBilled")
      html = html.replace('id="billed"', 'id="billed" hidden');
    if (mode === "twoBilledValues")
      html = html.replace(
        'id="effective-total">736.00</strong>',
        'id="effective-total">736.00</strong><span>₹735.00</span>',
      );
    if (mode === "unknownSubtitle")
      html = html.replace("Inclusive of taxes", "Tax calculation pending");
    if (mode === "includedFee")
      html = html.replace("Handling fee", "Handling fee included");
    if (mode === "unknownCharge")
      html = html.replace(
        '<div id="handling">',
        '<div>Service fee ₹3.00</div><div id="handling">',
      );
    if (mode === "unclassifiedImage")
      html = html.replace(
        '<div role="list"',
        '<img alt="Unknown icon" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="><div role="list"',
      );
    if (mode === "merchandiseInPayment")
      html = html.replace(
        "<h2>Payment</h2>",
        '<h2>Payment</h2><a href="/dp/B0FAKE0001">Incomplete merchandise</a>',
      );
    await expect(extract()).rejects.toThrow();
  });

  test("hidden duplicate merchandise and totals do not become active facts", async () => {
    html = presentation
      .replace(
        '<div role="list" id="merchandise">',
        '<div role="list" id="merchandise"><article hidden><img alt="B0FAKE0001"><span>Qty: 9</span><span>₹99.00</span></article>',
      )
      .replace(
        '<div id="billed">',
        '<div hidden>You pay ₹999.00</div><div id="billed">',
      );
    expect((await extract()).items).toHaveLength(23);
  });
  test("two units with separate labeled unit/line prices remain independently priced", async () => {
    html = presentation
      .replace("<span>1 unit</span>", "<span>2 units</span>")
      .replace(
        '<span class="effective-symbol">₹</span><span class="effective-number">21.00</span>',
        "<div>Unit price: <span>₹</span><span>10.50</span></div><div>Line total: <span>₹</span><span>21.00</span></div>",
      );
    expect((await extract()).items[0]).toMatchObject({
      quantity: 2,
      unitPrice: { amount: 10.5 },
      itemTotal: { amount: 21 },
    });
  });
  test.each(["Payment method", "Payment details", "Payment information"])(
    "recognizes a separate %s region",
    async (heading) => {
      html = presentation.replace("<h2>Payment</h2>", `<h2>${heading}</h2>`);
      expect((await extract()).items).toHaveLength(23);
    },
  );
  test("an explicit accessibility status region independently owns its icon", async () => {
    html = presentation
      .replace(
        '<section id="delivery-status">',
        '<section role="status" id="delivery-status">',
      )
      .replace("<h2>Delivery status</h2>", "");
    expect((await extract()).items).toHaveLength(23);
  });

  test.each([
    "presentationalImage",
    "missingImage",
    "duplicateProduct",
    "statusMerchandise",
    "rowOverlap",
  ])("merchandise ownership cannot omit %s", async (mode) => {
    html = presentation;
    if (mode === "presentationalImage")
      html = html
        .replace(
          '<img alt="B0FAKE0001"',
          '<img role="presentation" alt="B0FAKE0001"',
        )
        .replace("500 g · <span>1 unit</span>", "500 g");
    if (mode === "missingImage")
      html = html
        .replace(/<img alt="B0FAKE0001"[^>]+>/, "")
        .replace("500 g · <span>1 unit</span>", "500 g");
    if (mode === "duplicateProduct")
      html = html
        .replace("B0FAKE0002", "B0FAKE0001")
        .replace("Fictional market item 02", "Fictional market item 01");
    if (mode === "statusMerchandise")
      html = html.replace(
        "<span>Delivered</span>",
        "<span>Delivered</span><span>Qty: 1</span><span>₹21.00</span>",
      );
    if (mode === "rowOverlap")
      html = html.replace(
        '<article role="listitem" id="invented-row-2">',
        '<article role="listitem" id="invented-row-2"><span>Qty: 1</span>',
      );
    await expect(extract()).rejects.toThrow();
  });

  test("presentation signed discounts and charged fees retain their effective values", async () => {
    html = presentation
      .replace("<strong>Free</strong>", "<strong>₹5.00</strong>")
      .replace("<span>Free</span>", "<span>₹7.00</span>")
      .replace(
        '<div id="billed">',
        '<div><span>Discount</span><span>-₹</span><span>12.00</span></div><div id="billed">',
      );
    expect(
      (await extract()).adjustments.map(
        (adjustment) => adjustment.amount?.amount,
      ),
    ).toEqual([5, 7, -12]);
  });

  test.each([1, 2])(
    "presentation independently declared total has %s paise variance",
    async (paise) => {
      html = presentation.replace(
        'id="effective-total">736.00',
        `id="effective-total">736.0${paise}`,
      );
      if (paise === 1) expect((await extract()).orderTotal.amount).toBe(736.01);
      else
        await expect(extract()).rejects.toMatchObject({
          reason: "TOTAL_MISMATCH",
        });
    },
  );

  test.each(["tracking", "quantity", "total", "price", "incompleteRow"])(
    "presentation %s failure preserves prior JSON and creates no partial export",
    async (mode) => {
      html = presentation;
      if (mode === "tracking")
        html = html.replace(
          `<span>#${id}</span>`,
          "<span>#111-2222222-4444444</span>",
        );
      if (mode === "quantity")
        html = html.replace(
          "500 g · <span>1 unit</span>",
          "500 g · <span>1 unit · 2 units</span>",
        );
      if (mode === "incompleteRow")
        html = html.replace("500 g · <span>1 unit</span>", "500 g");
      if (mode === "total")
        html = html.replace(
          'id="effective-total">736.00',
          'id="effective-total">736.02',
        );
      if (mode === "price")
        html = html.replace(
          'class="effective-number">21.00',
          'class="effective-number">21.001',
        );
      jest
        .spyOn(chromium, "launchPersistentContext")
        .mockResolvedValue(context);
      const directory = await mkdtemp(
        join(tmpdir(), "now-presentation-atomic-"),
      );
      const output = join(directory, "orders.json");
      await writeFile(output, "prior complete export");
      const logs: string[] = [];
      try {
        await expect(
          runExport(
            { ...options, output },
            (message) => {
              logs.push(message);
            },
            {
              list: listOrders,
              extract: extractOrderItems,
              write: validateAndWriteExport,
              report: async () => {},
              cleanup: async () => {},
            },
          ),
        ).rejects.toThrow();
        expect(await readFile(output, "utf8")).toBe("prior complete export");
        expect(await readdir(directory)).toEqual(["orders.json"]);
        expect(logs.join(" ")).not.toMatch(
          /111-|736|Fictional|Voucher|amazon\.in/,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test("production list → selected outer UFF link → tracking → sheet → unchanged JSON", async () => {
    jest.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context);
    const listed = await listOrders(
      options.startDate,
      options.endDate,
      options.maxOrders,
    );
    expect(listed.orders).toHaveLength(1);
    const summary = listed.orders[0];
    expect(summary.nowDetailUrl).toBe(outer);
    const detail = await extractOrderItems(id, undefined, summary);
    expect(detail.orderTotalSource).toBe("amazon-now-you-pay");
    expect(detail.items).toHaveLength(23);
    expect(detail.items[0]).toMatchObject({
      productName: "Invented pantry product 01",
      asin: "B0TEST0001",
      quantity: 1,
      unitPrice: { amount: 10 },
      itemTotal: { amount: 10 },
    });
    expect(detail.items[2].asin).toBe("");
    expect(detail.adjustments).toEqual([]);
    const document = createExportDocument(
      options,
      1,
      [{ summary, detail }],
      new Date().toISOString(),
    );
    expect(document.orders[0].orderTotal).toBe(230);
    expect(document.orders[0].orderUrl).toBe(outer);
    expect(document.orders[0].items.map((item) => item.lineIndex)).toEqual(
      Array.from({ length: 23 }, (_, index) => index),
    );
    expect(JSON.stringify(document)).not.toMatch(
      /Voucher|Gift Card|Payment card|460/,
    );
    expect(requests).toContain("/uff/your-account/order-details");
    expect(requests).not.toContain("/gp/your-account/order-details");
  });

  test.each([
    "wrongId",
    "duplicateId",
    "missingId",
    "duplicateSheet",
    "staleSheet",
    "hiddenSheet",
    "wrongOwner",
    "hiddenOwner",
    "cancelled",
    "refunded",
    "missingQuantity",
    "quantityTwo",
    "duplicateItem",
    "missingTotal",
    "conflictingTotal",
    "duplicateTotal",
    "malformedTotal",
    "subtotalDecoy",
    "includedFee",
    "unsignedDiscount",
    "unclassifiedCharge",
    "twoControls",
    "wrongRoute",
    "duplicateQuery",
    "priceConflict",
  ])(
    "fails closed on %s",
    async (mode) => {
      if (mode === "wrongId")
        html = html.replace(
          `<span>${id}</span>`,
          "<span>111-2222222-4444444</span>",
        );
      if (mode === "duplicateId")
        html = html.replace(
          "<h1>Order Details</h1>",
          `<h1>Order Details</h1><div>Order ID ${id}</div>`,
        );
      if (mode === "missingId") html = html.replace("Order ID", "Reference");
      if (mode === "duplicateSheet")
        html =
          html.replace(
            "style.display='block'",
            "style.display='block';document.querySelector('#duplicate').style.display='block'",
          ) +
          `<section role="dialog" id="duplicate" style="display:none"><h1>Order Details</h1></section>`;
      if (mode === "staleSheet")
        html = html.replace('style="display:none"', 'style="display:block"');
      if (mode === "hiddenSheet")
        html = html.replace("style.display='block'", "style.display='none'");
      if (mode === "wrongOwner")
        html = html.replace(
          'id="fixture-bill"',
          'id="fixture-bill" data-order-id="111-2222222-4444444"',
        );
      if (mode === "hiddenOwner")
        html = html.replace(
          "<span>Order ID</span>",
          '<span style="display:none">Order ID</span>',
        );
      if (mode === "cancelled" || mode === "refunded")
        html = html.replace(
          "<h1>Order Details</h1>",
          `<h1>Order Details</h1><div>${mode}</div>`,
        );
      if (mode === "missingQuantity")
        html = html.replace("Qty: 1", "Quantity unavailable");
      if (mode === "quantityTwo") html = html.replace("Qty: 1", "Qty: 2");
      if (mode === "duplicateItem")
        html = html
          .replace("Invented pantry product 02", "Invented pantry product 01")
          .replace("B0TEST0002", "B0TEST0001");
      if (mode === "missingTotal")
        html = html.replace("You pay", "Other amount");
      if (mode === "conflictingTotal" || mode === "duplicateTotal")
        html = html.replace(
          '<div id="fixture-you-pay">',
          `<div>You pay <span>₹${mode === "duplicateTotal" ? "230" : "231"}.00</span></div><div id="fixture-you-pay">`,
        );
      if (mode === "malformedTotal")
        html = html.replace(
          "<span>₹230.00</span><s>₹460.00</s>",
          "<span>₹230.001</span><s>₹460.00</s>",
        );
      if (mode === "subtotalDecoy")
        html = html.replace(
          "<span>₹230.00</span><s>₹460.00</s>",
          "<span>Unavailable</span><s>₹460.00</s>",
        );
      if (mode === "includedFee")
        html = html.replace("Handling fee", "Handling fee included");
      if (mode === "unsignedDiscount")
        html = html.replace(
          "Handling fee <span>Free</span>",
          "Discount <span>₹5.00</span>",
        );
      if (mode === "unclassifiedCharge")
        html = html.replace("Handling fee", "Service adjustment");
      if (mode === "twoControls")
        html = html.replace(
          "<section role=",
          "<button>View order details</button><section role=",
        );
      if (mode === "wrongRoute")
        redirect = tracking.replace(id, "111-2222222-4444444");
      if (mode === "duplicateQuery") redirect += `&orderID=${id}`;
      if (mode === "priceConflict")
        html = html.replace(
          "<span>₹10.00</span>",
          "<span>₹10.00</span><span>₹11.00</span>",
        );
      await expect(extract()).rejects.toThrow();
    },
    15000,
  );

  test("reads nonzero fees and explicitly negative discounts; ignores mixed funding", async () => {
    html = html
      .replace(
        "Handling fee <span>Free</span>",
        "Handling fee <span>₹5.00</span>",
      )
      .replace(
        "Delivery fee <span>Free</span>",
        "Delivery fee <span>₹7.00</span>",
      )
      .replace(
        '<div id="fixture-you-pay">',
        '<div>Discount <span>-₹12.00</span></div><div id="fixture-you-pay">',
      );
    const detail = await extract();
    expect(
      detail.adjustments.map((adjustment) => adjustment.amount?.amount),
    ).toEqual([5, 7, -12]);
    expect(detail.orderTotal.amount).toBe(230);
  });

  test("accepts quantity two only with independently labeled unit and line prices", async () => {
    html = html
      .replace("Qty: 1", "Quantity: 2")
      .replace(
        "<span>₹10.00</span>",
        "<span>Unit price: ₹5.00</span><span>Line total: ₹10.00</span>",
      );
    const detail = await extract();
    expect(detail.items[0]).toMatchObject({
      quantity: 2,
      unitPrice: { amount: 5 },
      itemTotal: { amount: 10 },
    });
  });

  test("separate funding logos cannot become item anchors", async () => {
    html = html.replace(
      "<h2>Payment method</h2>",
      '<h2>Payment method</h2><img alt="Gift card logo" style="width:20px;height:20px" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">',
    );
    expect((await extract()).items).toHaveLength(23);
  });
  test("accepts complete inline Order ID and You pay label/value declarations", async () => {
    html = html
      .replace(`<span>Order ID</span><span>${id}</span>`, `Order ID:${id}`)
      .replace("<span>You pay</span><span>₹230.00</span>", "You pay ₹230.00");
    expect((await extract()).orderTotal.amount).toBe(230);
  });

  test.each(["outer", "inner"])(
    "preserves manual authentication on %s redirect",
    async (mode) => {
      jest
        .spyOn(chromium, "launchPersistentContext")
        .mockResolvedValue(context);
      if (mode === "outer") redirect = "https://www.amazon.in/ap/signin";
      else
        html = html.replace(
          "document.querySelector('#now-sheet').style.display='block'",
          "location.href='/ap/signin'",
        );
      await expect(
        extractOrderItems(id, undefined, {
          orderId: id,
          orderDate: "2026-10-01",
          nowDetailUrl: outer,
        }),
      ).rejects.toBeInstanceOf(AuthenticationRequiredError);
    },
    15000,
  );

  test("selected Now cancellations never enter conventional fallback", async () => {
    jest.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context);
    await expect(
      extractOrderItems(id, undefined, {
        orderId: id,
        orderDate: "2026-10-01",
        status: "cancelled",
        nowDetailUrl: outer,
      }),
    ).rejects.toMatchObject({ reason: "NOW_EXTRACTION_FAILED" });
    expect(requests).not.toContain("/gp/your-account/order-details");
  });

  test.each(["bad-alt", "missing-alt"])(
    "preserves empty ASIN for %s",
    async (mode) => {
      html = html.replace(
        'alt="B0TEST0001"',
        mode === "bad-alt" ? 'alt="not-an-asin B0TEST0001"' : "",
      );
      expect((await extract()).items[0].asin).toBe("");
    },
  );

  test.each([1, 2])(
    "one-paise reconciliation boundary: %s paise",
    async (paise) => {
      html = html.replace(
        "<span>₹230.00</span><s>₹460.00</s>",
        `<span>₹230.0${paise}</span><s>₹460.00</s>`,
      );
      if (paise === 1) expect((await extract()).orderTotal.amount).toBe(230.01);
      else
        await expect(extract()).rejects.toMatchObject({
          reason: "TOTAL_MISMATCH",
        });
    },
  );

  test.each(["wrongLink", "ambiguousLink", "validOtherOrder"])(
    "selected-card link isolation: %s",
    async (mode) => {
      listHtml =
        mode === "wrongLink"
          ? list.replace(outer, outer.replace(id, "111-2222222-4444444"))
          : mode === "ambiguousLink"
            ? list.replace("</a>", `</a><a href="${tracking}">Details</a>`)
            : list + list.replaceAll(id, "111-2222222-4444444");
      await page.goto("https://www.amazon.in/your-orders/orders");
      if (mode === "validOtherOrder")
        expect((await parseCurrentOrderPage(page))[0].nowDetailUrl).toBe(outer);
      else await expect(parseCurrentOrderPage(page)).rejects.toThrow();
    },
  );
  test("unrelated storefront links do not turn conventional cards into Now orders", async () => {
    listHtml = list
      .replace(outer, `/gp/your-account/order-details?orderID=${id}`)
      .replace("</a>", '</a><a href="/uff/storefront">Shop groceries</a>');
    await page.goto("https://www.amazon.in/your-orders/orders");
    expect((await parseCurrentOrderPage(page))[0].nowDetailUrl).toBeUndefined();
  });

  test.each(["missingTotal", "mismatch"])(
    "runExport never publishes partial JSON on %s",
    async (mode) => {
      html =
        mode === "missingTotal"
          ? html.replace("You pay", "Other amount")
          : html.replace(
              "<span>₹230.00</span><s>₹460.00</s>",
              "<span>₹230.02</span><s>₹460.00</s>",
            );
      jest
        .spyOn(chromium, "launchPersistentContext")
        .mockResolvedValue(context);
      const directory = await mkdtemp(join(tmpdir(), "now-atomic-"));
      const output = join(directory, "orders.json");
      await writeFile(output, "previous complete export");
      const logs: string[] = [];
      const report = jest.fn(async () => {});
      try {
        await expect(
          runExport(
            { ...options, output },
            (message) => {
              logs.push(message);
            },
            {
              list: listOrders,
              extract: extractOrderItems,
              write: validateAndWriteExport,
              report,
              cleanup: async () => {},
            },
          ),
        ).rejects.toThrow();
        expect(await readFile(output, "utf8")).toBe("previous complete export");
        expect(await readdir(directory)).toEqual(["orders.json"]);
        expect(logs.join(" ")).not.toMatch(
          /111-|pantry|Voucher|230|amazon\.in/,
        );
        expect(report).toHaveBeenCalledTimes(1);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
