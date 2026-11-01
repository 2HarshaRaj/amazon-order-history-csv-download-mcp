import { makeTestDirectory } from "../helpers/temp-directory";
/** Synthetic Chromium only. All requests intercepted; no persistent profile. */
import { existsSync, readFileSync } from "fs";
import { readFile, readdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { chromium, Browser, BrowserContext, Page } from "playwright";
import { extractDetailOrderTotal } from "../../src/poc/order-total";
import {
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
import { FailureDiagnostics } from "../../src/poc/failure-diagnostics";
import * as itemExtractors from "../../src/amazon/extractors/items";

const executable = [
  chromium.executablePath(),
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find(existsSync);
const browserTests = executable ? describe : describe.skip;
const id = "408-0000000-0000015";
const detailUrl = `https://www.amazon.in/gp/your-account/order-details?orderID=${id}`;
const fixture = (name: string): string =>
  readFileSync(join(__dirname, "fixtures", name), "utf8");
const detailHtml = fixture("order-detail-in-grand-total.html");
const listHtml = fixture("order-card-in-mixed-tender.html").replace(
  "<span>Total</span><span>₹1,225.00</span>",
  "<span>Total</span><span>₹925.00</span>",
);
const options = {
  startDate: "2026-10-01",
  endDate: "2026-10-02",
  maxOrders: 5,
};

browserTests("Order Details Grand Total authority", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let currentDetail: string;
  let currentList: string;
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
    context = await browser.newContext();
    currentDetail = detailHtml;
    currentList = listHtml;
    await context.route("**/*", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: new URL(route.request().url()).pathname.includes("order-details")
          ? currentDetail
          : currentList,
      }),
    );
    page = await context.newPage();
  });
  afterEach(async () => {
    await closeBrowser();
    await context.close();
    jest.restoreAllMocks();
  });
  async function visitDetail(): Promise<void> {
    await page.goto(detailUrl);
  }
  function useSyntheticContext(): void {
    jest.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context);
  }

  test.each(["mixed", "normal", "legacy"])(
    "exports independently sourced gross for a %s purchase",
    async (mode) => {
      if (mode === "normal") {
        currentList = listHtml.replace(
          "₹925.00</span></li>",
          "₹1,225.00</span></li>",
        );
        // Ordinary purchase: remove funding markup from both synthetic pages.
        const funding =
          '.synthetic-tender-breakdown, [data-component="viewPaymentPlanSummaryWidget"], [data-component="paymentSummary"], .a-popover, [aria-hidden="true"]';
        await page.setContent(currentList);
        await page
          .locator(funding)
          .evaluateAll((elements) =>
            elements.forEach((element) => element.remove()),
          );
        currentList = await page.locator("body").innerHTML();
        await page.setContent(currentDetail);
        await page
          .locator(funding)
          .evaluateAll((elements) =>
            elements.forEach((element) => element.remove()),
          );
        currentDetail = await page.locator("body").innerHTML();
      }
      if (mode === "legacy") {
        currentList = fixture("order-card-in-legacy-total.html");
        currentDetail = detailHtml
          .replaceAll("1,225.00", "359.50")
          .replaceAll("1,220.00", "354.50")
          .replaceAll(id, "408-0000000-0000016");
      }
      useSyntheticContext();
      const listed = await listOrders(
        options.startDate,
        options.endDate,
        options.maxOrders,
      );
      const summary = listed.orders[0];
      const trace = new FailureDiagnostics();
      trace.select(summary, 0);
      const detail = await extractOrderItems(
        summary.orderId,
        trace.itemDiagnostics,
        summary,
        trace,
      );
      const document = createExportDocument(
        options,
        listed.pagesScanned,
        [{ summary, detail }],
        new Date().toISOString(),
        trace,
      );
      expect(document.orders[0].orderTotal).toBe(
        mode === "legacy" ? 359.5 : 1225,
      );
      expect(document.orders[0].items[0]).toMatchObject({
        lineIndex: 0,
        itemTotal: mode === "legacy" ? 354.5 : 1220,
      });
      expect(
        document.orders[0].adjustments.map((a) => a.adjustmentIndex),
      ).toEqual([0, 1]);
      expect(Object.keys(document.orders[0]).sort()).toEqual([
        "adjustments",
        "currency",
        "extractedAt",
        "items",
        "orderDate",
        "orderId",
        "orderTotal",
        "orderUrl",
        "status",
      ]);
      expect(JSON.stringify(document)).not.toMatch(
        /Voucher|Gift Cards|payment|orderTotalSource/,
      );
      if (mode === "mixed") {
        expect(summary.orderTotal?.amount).toBe(925);
        const report = trace.report(undefined);
        expect(report.events).toContainEqual(
          expect.objectContaining({
            stage: "detail",
            reason: "LIST_DETAIL_TOTAL_DIFFER",
            orderIndex: 0,
          }),
        );
        expect(report.order?.orderTotalPaise).toBe(122500);
      }
    },
  );

  test.each([
    ["missing", "DETAIL_TOTAL_MISSING"],
    ["malformed", "DETAIL_TOTAL_INVALID"],
    ["foreign", "DETAIL_TOTAL_INVALID"],
    ["conflicting", "DETAIL_TOTAL_AMBIGUOUS"],
    ["invalidDuplicate", "DETAIL_TOTAL_INVALID"],
    ["duplicateSummary", "DETAIL_TOTAL_AMBIGUOUS"],
    ["hidden", "DETAIL_TOTAL_MISSING"],
    ["outside", "DETAIL_TOTAL_MISSING"],
    ["unreadable", "DETAIL_TOTAL_INVALID"],
    ["tooMany", "DETAIL_TOTAL_AMBIGUOUS"],
  ])("fails closed on %s authoritative evidence", async (mode, reason) => {
    await visitDetail();
    await page.locator("#grand-total-row").evaluate((row, mode) => {
      if (mode === "missing") row.remove();
      if (mode === "malformed") row.textContent = "Grand Total ₹1,225.001";
      if (mode === "foreign") row.textContent = "Grand Total £1,225.00";
      if (mode === "unreadable") row.textContent = "Grand Total unavailable";
      if (mode === "conflicting" || mode === "invalidDuplicate")
        row.insertAdjacentHTML(
          "afterend",
          `<div>${mode === "conflicting" ? "Grand Total ₹925.00" : "Grand Total unavailable"}</div>`,
        );
      if (mode === "duplicateSummary")
        row
          .closest("#od-subtotals")
          ?.insertAdjacentHTML(
            "afterend",
            '<div id="od-subtotals">Grand Total ₹1,225.00</div>',
          );
      if (mode === "hidden") row.setAttribute("style", "display:none");
      if (mode === "outside") row.ownerDocument.body.append(row);
      if (mode === "tooMany")
        row.insertAdjacentHTML(
          "afterend",
          "<div>Grand Total ₹1,225.00</div>".repeat(17),
        );
    }, mode);
    await expect(extractDetailOrderTotal(page, id)).rejects.toMatchObject({
      stage: "detail",
      reason,
    });
  });

  test("accepts agreeing Grand Total duplicates, while ignoring unrelated amounts", async () => {
    await visitDetail();
    await page
      .locator("#grand-total-row")
      .evaluate((row) =>
        row.insertAdjacentHTML(
          "afterend",
          "<div>Grand Total INR 1,225.00</div><div>Total ₹925.00</div>",
        ),
      );
    expect((await extractDetailOrderTotal(page, id))?.amount).toBe(1225);
  });

  test.each([
    `https://www.amazon.in/gp/your-account/order-details?orderID=408-0000000-0000099`,
    `https://www.amazon.in/gp/your-account/order-details?orderID=${id}&orderID=${id}`,
    `https://www.amazon.in/your-orders/orders?orderID=${id}`,
    `https://example.invalid/gp/your-account/order-details?orderID=${id}`,
  ])("rejects a wrong source URL without exposing it", async (url) => {
    await page.goto(url);
    await expect(extractDetailOrderTotal(page, id)).rejects.toMatchObject({
      reason: "DETAIL_ORDER_MISMATCH",
    });
  });

  test.each(["#od-subtotals", "#grand-total-row"])(
    "rejects %s explicitly belonging to another order",
    async (selector) => {
      await visitDetail();
      await page
        .locator(selector)
        .evaluate((summary) =>
          summary.setAttribute("data-order-id", "408-0000000-0000099"),
        );
      await expect(extractDetailOrderTotal(page, id)).rejects.toMatchObject({
        reason: "DETAIL_ORDER_MISMATCH",
      });
    },
  );

  test.each(["agree", "conflict", "missing"])(
    "handles %s duplicate list cards without overwriting facts",
    async (mode) => {
      await page.setContent(
        listHtml +
          (mode === "conflict"
            ? listHtml.replace("₹925.00</span></li>", "₹1,225.00</span></li>")
            : mode === "missing"
              ? listHtml.replace(
                  '<li id="gross-total-cell"><span>Total</span><span>₹925.00</span></li>',
                  "",
                )
              : listHtml),
      );
      if (mode === "agree")
        expect(await parseCurrentOrderPage(page)).toHaveLength(1);
      else
        await expect(parseCurrentOrderPage(page)).rejects.toMatchObject({
          reason:
            mode === "conflict"
              ? "LIST_DUPLICATE_CONFLICT"
              : "LIST_TOTAL_MISSING",
        });
    },
  );

  test.each([false, true])(
    "compares duplicates across pagination (conflict=%s) and preserves the order cap",
    async (conflict) => {
      let listPage = 0;
      await page.goto("https://www.amazon.in/gp/css/order-history");
      await context.unroute("**/*");
      const nextOrder = listHtml.replaceAll(id, "408-0000000-0000017");
      await context.route("**/*", (route) => {
        listPage++;
        return route.fulfill({
          contentType: "text/html; charset=utf-8",
          body:
            listPage === 1
              ? listHtml +
                '<ul class="a-pagination"><li class="a-last"><a href="?page=2">Next</a></li></ul>'
              : (conflict
                  ? listHtml.replace(
                      "₹925.00</span></li>",
                      "₹1,225.00</span></li>",
                    )
                  : listHtml) + nextOrder,
        });
      });
      useSyntheticContext();
      if (conflict)
        await expect(
          listOrders(options.startDate, options.endDate, 2),
        ).rejects.toMatchObject({ reason: "LIST_DUPLICATE_CONFLICT" });
      else {
        const listed = await listOrders(options.startDate, options.endDate, 2);
        expect(listed.orders.map((o) => o.orderId)).toEqual([
          id,
          "408-0000000-0000017",
        ]);
        expect(listed.orders.every((o) => o.orderTotal?.amount === 925)).toBe(
          true,
        );
      }
    },
  );

  test.each(["missing", "malformed", "conflicting", "priced"])(
    "preserves cancellation constraints with %s detail gross",
    async (mode) => {
      const cancelled = fixture("order-card-in-cancelled.html");
      await page.setContent(cancelled);
      const [summary] = await parseCurrentOrderPage(page);
      currentDetail =
        '<div data-component="cancelledOrderBanner">Cancelled</div><div id="od-subtotals">' +
        (mode === "missing"
          ? ""
          : `<div>${mode === "malformed" ? "Grand Total unavailable" : "Grand Total ₹1,225.00"}</div>`) +
        "</div>" +
        detailHtml.slice(
          detailHtml.indexOf('<div data-component="purchasedItems">'),
        );
      if (mode === "conflicting")
        currentDetail = currentDetail.replace(
          "Grand Total ₹1,225.00",
          "Grand Total ₹1,225.00</div><div>Grand Total ₹925.00",
        );
      useSyntheticContext();
      if (mode === "malformed" || mode === "conflicting")
        await expect(
          extractOrderItems(summary.orderId, undefined, summary),
        ).rejects.toMatchObject({
          reason:
            mode === "malformed"
              ? "DETAIL_TOTAL_INVALID"
              : "DETAIL_TOTAL_AMBIGUOUS",
        });
      else {
        const detail = await extractOrderItems(
          summary.orderId,
          undefined,
          summary,
        );
        expect(detail.extractionSource).toBe(
          mode === "missing" ? "cancelled-order-list" : "order-detail",
        );
        expect(detail.orderTotal?.amount).toBe(
          mode === "missing" ? undefined : 1225,
        );
      }
    },
  );

  test("keeps the validated detail gross across invoice item fallback", async () => {
    await page.setContent(listHtml);
    const [summary] = await parseCurrentOrderPage(page);
    currentList = detailHtml.replaceAll("1,225.00", "999.00");
    useSyntheticContext();
    jest.spyOn(itemExtractors, "extractItems").mockResolvedValue([]);
    const detail = await extractOrderItems(id, undefined, summary);
    expect(detail.extractionSource).toBe("invoice-safe-fallback");
    expect(detail.orderTotal?.amount).toBe(1225);
    expect(
      createExportDocument(
        options,
        1,
        [{ summary, detail }],
        new Date().toISOString(),
      ).orders[0].orderTotal,
    ).toBe(1225);
  });

  test("does not expose browser read failures", async () => {
    await visitDetail();
    jest.spyOn(page, "locator").mockImplementation(() => {
      throw new Error("PRIVATE_RAW_DOM buyer@example.invalid");
    });
    let failure: unknown;
    try {
      await extractDetailOrderTotal(page, id);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ reason: "DETAIL_TOTAL_READ_FAILED" });
    expect(String(failure)).not.toMatch(/PRIVATE|buyer@/);
  });

  test.each(["missing", "conflicting", "mismatch"])(
    "preserves prior output and safe diagnostics on %s failure",
    async (mode) => {
      if (mode === "missing")
        currentDetail = detailHtml.replace("Grand Total:", "Amount:");
      if (mode === "conflicting")
        currentDetail = detailHtml.replace(
          '<div class="a-row" id="grand-total-row">',
          '<div>Grand Total ₹925.00</div><div class="a-row" id="grand-total-row">',
        );
      if (mode === "mismatch")
        currentDetail = detailHtml.replaceAll("₹1,220.00", "₹1,219.98");
      useSyntheticContext();
      const directory = await makeTestDirectory("amazon-detail-authority-");
      const output = join(directory, "orders.json");
      await writeFile(output, "prior complete export");
      const report = jest.fn(async (_report: unknown) => {});
      const logs: string[] = [];
      try {
        await expect(
          runExport({ ...options, output }, (message) => logs.push(message), {
            list: listOrders,
            extract: extractOrderItems,
            write: validateAndWriteExport,
            report,
            cleanup: async () => {},
          }),
        ).rejects.toMatchObject({
          reason:
            mode === "missing"
              ? "DETAIL_TOTAL_MISSING"
              : mode === "conflicting"
                ? "DETAIL_TOTAL_AMBIGUOUS"
                : "TOTAL_MISMATCH",
        });
        expect(await readFile(output, "utf8")).toBe("prior complete export");
        expect(await readdir(directory)).toEqual(["orders.json"]);
        expect(logs.join(" ")).not.toMatch(/408-|organizer|1225|925|Voucher/);
        expect(report).toHaveBeenCalledTimes(1);
        if (mode === "mismatch")
          expect(report.mock.calls[0][0]).toMatchObject({
            order: { orderIndex: 0, orderTotalPaise: 122500 },
            reconciliation: { differencePaise: -2, tolerancePaise: 1 },
          });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
