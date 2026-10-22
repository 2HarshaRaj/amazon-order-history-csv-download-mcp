/** Headless local HTML fixtures only; never uses the persistent account profile. */
import { existsSync, readFileSync } from "fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { chromium, Browser, Page } from "playwright";
import {
  createExportDocument,
  validateAndWriteExport,
} from "../../src/poc/export-json";
import {
  FailureDiagnostics,
  writeFailureReport,
} from "../../src/poc/failure-diagnostics";
import {
  parseCurrentOrderPage,
  parseOrderSummaryAdjustments,
} from "../../src/poc/hardened-index-v3";

const executable = [
  chromium.executablePath(),
  "/usr/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
].find(existsSync);
const describeWithBrowser = executable ? describe : describe.skip;
const mixed = readFileSync(
  join(__dirname, "fixtures/order-card-in-mixed-tender.html"),
  "utf8",
);
const legacy = readFileSync(
  join(__dirname, "fixtures/order-card-in-legacy-total.html"),
  "utf8",
);
const options = { startDate: "2026-10-01", endDate: "2026-10-02" };
const money = (amount: number) => ({
  amount,
  currency: "INR",
  formatted: `₹${amount}`,
});
function detail(orderId: string, itemTotal = 1220, grossTotal = 1225) {
  return {
    orderId,
    orderTotal: money(grossTotal),
    orderTotalSource: "order-detail-grand-total" as const,
    extractionSource: "order-detail",
    itemCount: 1,
    items: [
      {
        asin: "B000000015",
        productName: "Synthetic desk organizer",
        quantity: 1,
        unitPrice: money(itemTotal),
        itemTotal: money(itemTotal),
      },
    ],
    adjustments: parseOrderSummaryAdjustments([
      "Shipping:  ₹0.00",
      "Marketplace Fee:  ₹5.00",
      "Amazon Shopping Voucher payment:  ₹300.00",
      "Gift Cards payment:  ₹925.00",
    ]),
  };
}

describeWithBrowser("Amazon.in gross totals from visible card headers", () => {
  let browser: Browser;
  let page: Page;
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
    page = await browser.newPage();
    await page.route("**/*", (route) => route.abort());
  });
  afterEach(async () => {
    await page.close();
  });

  test("captures gross total independently of preceding voucher/gift-card components and reconciles", async () => {
    await page.setContent(mixed);
    const [summary] = await parseCurrentOrderPage(page);
    expect(summary).toMatchObject({
      orderId: "408-0000000-0000015",
      orderDate: "2026-10-01",
      orderTotal: { amount: 1225, currency: "INR" },
    });
    const document = createExportDocument(
      options,
      1,
      [{ summary, detail: detail(summary.orderId) }],
      new Date().toISOString(),
    );
    expect(document.orders[0].orderTotal).toBe(1225);
    expect(document.orders[0].adjustments.map((value) => value.type)).toEqual([
      "shipping",
      "marketplace_fee",
    ]);
    expect(JSON.stringify(document)).not.toMatch(/Voucher|Gift Cards|payment/i);
  });

  test("does not infer the gross amount from tender funding", async () => {
    await page.setContent(
      mixed.replaceAll("925.00", "1.00").replaceAll("300.00", "9,999.00"),
    );
    expect((await parseCurrentOrderPage(page))[0].orderTotal?.amount).toBe(
      1225,
    );
  });

  test("accepts agreeing duplicate header displays", async () => {
    await page.setContent(mixed);
    await page
      .locator(".order-header")
      .evaluate((header) =>
        header.insertAdjacentHTML(
          "beforeend",
          '<div class="order-info"><span>Order Total</span><span>₹1,225.00</span></div>',
        ),
      );
    expect((await parseCurrentOrderPage(page))[0].orderTotal?.amount).toBe(
      1225,
    );
  });

  test.each(["conflicting", "malformed"])(
    "does not turn a %s cancelled header into an unpriced cancellation",
    async (mode) => {
      await page.setContent(
        readFileSync(
          join(__dirname, "fixtures/order-card-in-cancelled.html"),
          "utf8",
        ),
      );
      await page.locator(".order-card").evaluate((card, mode) => {
        card.insertAdjacentHTML(
          "afterbegin",
          mode === "conflicting"
            ? '<div class="order-header"><div>Total ₹10.00</div><div>Total ₹20.00</div></div>'
            : '<div class="order-header">Total: unavailable</div>',
        );
      }, mode);
      await expect(parseCurrentOrderPage(page)).rejects.toMatchObject({
        reason:
          mode === "conflicting"
            ? "LIST_TOTAL_AMBIGUOUS"
            : "LIST_TOTAL_INVALID",
      });
    },
  );

  test("does not borrow a header amount from an excluded payment widget", async () => {
    await page.setContent(mixed);
    await page.locator("#gross-total-cell").evaluate((cell) => {
      cell.innerHTML =
        '<span>Total</span><div data-component="paymentSummary">₹925.00</div>';
    });
    await expect(parseCurrentOrderPage(page)).rejects.toMatchObject({
      reason: "LIST_TOTAL_INVALID",
    });
  });

  describe.each(["ordinary", "cancelled"])("%s order", (status) => {
    test.each([
      "Order Total unavailable",
      "Grand Total pending",
      "Order Total Rs. 1,225.00",
      "Grand Total EUR 1,225.00",
    ])(
      "rejects an explicit but unreadable gross declaration: %s",
      async (text) => {
        const html =
          status === "cancelled"
            ? readFileSync(
                join(__dirname, "fixtures/order-card-in-cancelled.html"),
                "utf8",
              )
            : mixed;
        await page.setContent(html);
        if (status === "cancelled") {
          await page.locator(".order-card").evaluate((card, text) => {
            const header = card.ownerDocument.createElement("div");
            header.className = "order-header";
            header.textContent = text;
            card.prepend(header);
          }, text);
        } else {
          await page.locator("#gross-total-cell").evaluate((cell, text) => {
            cell.textContent = text;
          }, text);
        }
        await expect(parseCurrentOrderPage(page)).rejects.toMatchObject({
          stage: "list",
          reason: "LIST_TOTAL_INVALID",
        });
      },
    );
  });

  test("rejects an unreadable gross declaration alongside a valid total", async () => {
    await page.setContent(mixed);
    await page.locator(".order-header").evaluate((header) => {
      const duplicate = header.ownerDocument.createElement("div");
      duplicate.textContent = "Order Total unavailable";
      header.appendChild(duplicate);
    });
    await expect(parseCurrentOrderPage(page)).rejects.toMatchObject({
      reason: "LIST_TOTAL_INVALID",
    });
  });

  test("ignores hidden popup amounts within an otherwise valid total cell", async () => {
    await page.setContent(mixed);
    await page
      .locator("#gross-total-cell")
      .evaluate((cell) =>
        cell.insertAdjacentHTML(
          "beforeend",
          '<div class="a-popover" style="display:none">Total ₹925.00</div>',
        ),
      );
    expect((await parseCurrentOrderPage(page))[0].orderTotal?.amount).toBe(
      1225,
    );
  });

  test("does not treat hidden card copies as additional selected orders", async () => {
    await page.setContent(
      legacy.replace(
        'class="order-card"',
        'class="order-card" style="display:none"',
      ) + mixed,
    );
    const orders = await parseCurrentOrderPage(page);
    expect(orders).toHaveLength(1);
    expect(orders[0].orderId).toBe("408-0000000-0000015");
  });

  test("captures the legacy header total for an ordinary order", async () => {
    await page.setContent(legacy);
    const [summary] = await parseCurrentOrderPage(page);
    expect(summary.orderTotal?.amount).toBe(359.5);
    expect(
      createExportDocument(
        options,
        1,
        [{ summary, detail: detail(summary.orderId, 354.5, 359.5) }],
        new Date().toISOString(),
      ).orders[0].orderTotal,
    ).toBe(359.5);
  });

  test.each(["Order Total:", "Grand Total", "TOTAL"])(
    "supports alternate gross labels and an inline value",
    async (label) => {
      await page.setContent(mixed);
      await page.locator("#gross-total-cell").evaluate((cell, label) => {
        cell.textContent = `${label} ₹1,225.00`;
      }, label);
      expect((await parseCurrentOrderPage(page))[0].orderTotal?.amount).toBe(
        1225,
      );
    },
  );

  test.each([
    ["missing", "LIST_TOTAL_MISSING"],
    ["conflicting", "LIST_TOTAL_AMBIGUOUS"],
    ["malformed", "LIST_TOTAL_INVALID"],
  ])(
    "fails closed on a %s header total with safe selected-order context",
    async (mode, reason) => {
      await page.setContent(mixed);
      if (mode === "missing")
        await page
          .locator("#gross-total-cell")
          .evaluate((cell) => cell.remove());
      if (mode === "conflicting")
        await page.locator(".order-header").evaluate((header) => {
          const duplicate = header.ownerDocument.createElement("div");
          duplicate.textContent = "Total ₹925.00";
          header.appendChild(duplicate);
        });
      if (mode === "malformed")
        await page.locator("#gross-total-cell").evaluate((cell) => {
          cell.textContent = "Total: ₹unavailable";
        });
      const trace = new FailureDiagnostics();
      let failure: unknown;
      try {
        await parseCurrentOrderPage(page, trace, {
          startKey: 20261001,
          endKey: 20261002,
          orderOffset: 3,
          maxOrders: 50,
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ stage: "list", reason });
      expect(String(failure)).not.toMatch(
        /408-|1225|925|Voucher|Gift|desk organizer/,
      );
      const evidence = trace.report(failure);
      expect(evidence.order).toMatchObject({
        orderId: "408-0000000-0000015",
        orderDate: "2026-10-01",
        orderIndex: 3,
      });
      const directory = await mkdtemp(join(tmpdir(), "amazon-total-report-"));
      try {
        await writeFailureReport(evidence, directory);
        expect(await readdir(directory)).toHaveLength(1);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test("does not validate unselected out-of-window or over-limit cards", async () => {
    const unsupported = mixed
      .replace('class="order-header"', 'class="unknown-header"')
      .replace(/408-0000000-0000015/g, "408-0000000-0000099");
    await page.setContent(
      unsupported
        .replace("1 October 2026", "30 September 2026")
        .replaceAll("408-0000000-0000099", "408-0000000-0000098") +
        mixed +
        unsupported,
    );
    const parsed = await parseCurrentOrderPage(page, undefined, {
      startKey: 20261001,
      endKey: 20261002,
      orderOffset: 0,
      maxOrders: 1,
    });
    expect(
      parsed.find((order) => order.orderId === "408-0000000-0000015")
        ?.orderTotal?.amount,
    ).toBe(1225);
  });

  test("keeps a remaining mismatch on the actual second order and preserves prior output", async () => {
    await page.setContent(legacy + mixed);
    const [first, second] = await parseCurrentOrderPage(page);
    const trace = new FailureDiagnostics();
    trace.listed([first, second], 1);
    const directory = await mkdtemp(join(tmpdir(), "amazon-total-mismatch-"));
    const output = join(directory, "orders.json");
    await writeFile(output, "prior complete export");
    try {
      await expect(
        validateAndWriteExport(
          output,
          options,
          1,
          [
            { summary: first, detail: detail(first.orderId, 354.5, 359.5) },
            { summary: second, detail: detail(second.orderId, 1219.98) },
          ],
          new Date().toISOString(),
          trace,
        ),
      ).rejects.toMatchObject({
        stage: "reconciliation",
        reason: "TOTAL_MISMATCH",
      });
      expect(trace.report(undefined)).toMatchObject({
        order: { orderIndex: 1, orderId: second.orderId },
        reconciliation: { differencePaise: -2, tolerancePaise: 1 },
      });
      expect(await readFile(output, "utf8")).toBe("prior complete export");
      expect(await readdir(directory)).toEqual(["orders.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("still accepts exactly one paise variance without changing the gross amount", async () => {
    await page.setContent(mixed);
    const [summary] = await parseCurrentOrderPage(page);
    expect(
      createExportDocument(
        options,
        1,
        [{ summary, detail: detail(summary.orderId, 1219.99) }],
        new Date().toISOString(),
      ).orders[0].orderTotal,
    ).toBe(1225);
  });
});
