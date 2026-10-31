/** Invented HTML only. No verified wallet classifier or exclusion rule exists. */
import { existsSync, readFileSync } from "fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { Browser, BrowserContext, Page, chromium } from "playwright";
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
const label = "Amazon Pay Wallet Add Money";
const walletId = "111-2222222-4444444",
  purchaseId = "111-2222222-3333333",
  otherId = "111-2222222-5555555";
const wallet = readFileSync(
  join(__dirname, "fixtures/order-card-wallet-unverified.html"),
  "utf8",
);
const detailFixture = readFileSync(
  join(__dirname, "fixtures/order-detail-in-grand-total.html"),
  "utf8",
)
  .replaceAll("408-0000000-0000015", purchaseId)
  .replaceAll("1,220.00", "10.00")
  .replaceAll("1,225.00", "10.00")
  .replaceAll("₹5.00", "₹0.00");
const nowFixture = readFileSync(
  join(__dirname, "fixtures/amazon-now-order.html"),
  "utf8",
);
const options = {
  startDate: "2026-10-01",
  endDate: "2026-10-02",
  maxOrders: 3,
};
const purchase = (id = purchaseId, title = "Invented notebook"): string =>
  `<section class="order-card"><div class="order-header"><div>Order placed 1 October 2026</div><div>Total ₹10.00</div><span>${id}</span></div><div data-component="purchasedItems"><div class="a-fixed-left-grid"><a href="/dp/B000000015">${title}</a></div></div><div data-component="paymentSummary">Paid using Amazon Pay balance, Gift Card and wallet balance</div></section>`;
const events = (trace: FailureDiagnostics) =>
  trace
    .report(new Error())
    .events.filter((e) => e.reason.startsWith("LIST_WALLET_"));

browserTests(
  "unverified wallet observations preserve strict merchandise selection",
  () => {
    let browser: Browser,
      context: BrowserContext,
      page: Page,
      html: string,
      page2: string,
      detail: string;
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
      html = wallet;
      page2 = purchase(otherId);
      detail = detailFixture;
      requests = [];
      await context.route("**/*", (route) => {
        const url = new URL(route.request().url());
        requests.push(url.pathname + url.search);
        let body = html;
        if (url.pathname.startsWith("/gp/your-account/order-details"))
          body =
            url.searchParams.get("orderID") === walletId
              ? `<div id="od-subtotals" data-order-id="111-2222222-9999999">Order # 111-2222222-9999999<div id="grand-total-row">Grand Total ₹17.00</div></div>`
              : detail;
        else if (url.pathname.startsWith("/uff/"))
          body = `<script>location.replace('https://www.amazon.in/tez/browse/orderTracking?orderId=${purchaseId}')</script>`;
        else if (url.pathname.startsWith("/tez/")) body = nowFixture;
        else if (url.searchParams.get("page") === "2") body = page2;
        return route.fulfill({ contentType: "text/html; charset=utf-8", body });
      });
      page = await context.newPage();
    });
    afterEach(async () => {
      await closeBrowser();
      await context.close();
      jest.restoreAllMocks();
    });
    const parse = async (fixture: string, trace: FailureDiagnostics) => {
      await page.setContent(fixture);
      return parseCurrentOrderPage(page, trace);
    };

    test("even an invented funding-only declaration is unverified and retained", async () => {
      const trace = new FailureDiagnostics();
      const selected = await parse(wallet, trace);
      expect(selected.map((order) => order.orderId)).toEqual([walletId]);
      expect(events(trace)).toEqual([
        expect.objectContaining({
          stage: "list",
          reason: "LIST_WALLET_LABEL_UNVERIFIED",
          count: 1,
          orderIndex: 0,
        }),
      ]);
      expect(JSON.stringify(events(trace))).not.toMatch(
        /111-|PRIVATE_WALLET|Amazon Pay|17\.00|example\.invalid|private\/path/,
      );
    });
    test.each([
      "ordinary",
      "wallet payment",
      "title mention",
      "exact title",
      "refund",
      "cancelled",
    ])("does not skip a purchase with %s", async (mode) => {
      let card = purchase();
      if (mode === "ordinary")
        card = card.replace(
          /<div data-component="paymentSummary">[\s\S]*?<\/div>/,
          "",
        );
      if (mode === "title mention")
        card = purchase(purchaseId, `Invented title mentioning ${label}`);
      if (mode === "exact title") card = purchase(purchaseId, label);
      if (mode === "refund")
        card = card.replace(
          "</section>",
          "<div>Refund information</div></section>",
        );
      if (mode === "cancelled")
        card = card.replace("Invented notebook", "Cancelled invented notebook");
      const trace = new FailureDiagnostics();
      expect((await parse(card, trace)).map((order) => order.orderId)).toEqual([
        purchaseId,
      ]);
      expect(events(trace).map((event) => event.reason)).toEqual(
        mode === "exact title" ? ["LIST_WALLET_LABEL_UNVERIFIED"] : [],
      );
    });
    test.each([
      "hidden",
      "aria-hidden",
      "display",
      "visibility",
      "opacity",
      "struck",
    ])("ignores %s label evidence while retaining the record", async (mode) => {
      const attributes: Record<string, string> = {
        hidden: "hidden",
        "aria-hidden": 'aria-hidden="true"',
        display: 'style="display:none"',
        visibility: 'style="visibility:hidden"',
        opacity: 'style="opacity:0"',
        struck: 'style="text-decoration:line-through"',
      };
      const trace = new FailureDiagnostics();
      expect(
        await parse(
          wallet.replace(
            `<div>${label}</div>`,
            `<div ${attributes[mode]}>${label}</div>`,
          ),
          trace,
        ),
      ).toHaveLength(1);
      expect(events(trace)).toEqual([]);
    });
    test.each([
      "duplicate",
      "hidden duplicate",
      "wrapper",
      "outside card",
      "nested other card",
    ])(
      "bounds %s label ownership without classifying funding",
      async (mode) => {
        let card = wallet;
        if (mode === "duplicate")
          card = wallet.replace(label, `${label}</div><div>${label}`);
        if (mode === "hidden duplicate")
          card = wallet.replace(label, `${label}<span hidden>${label}</span>`);
        if (mode === "wrapper")
          card = wallet.replace(label, `<div><span>${label}</span></div>`);
        if (mode === "outside card")
          card =
            wallet.replace(label, "Unknown transaction") +
            `<div>${label}</div>`;
        if (mode === "nested other card")
          card = wallet.replace(
            label,
            `<div class="order-card"><span>${label}</span></div>`,
          );
        const trace = new FailureDiagnostics();
        expect(await parse(card, trace)).toHaveLength(1);
        expect(events(trace).map((event) => event.reason)).toEqual(
          mode === "outside card" || mode === "nested other card"
            ? []
            : [
                mode === "duplicate"
                  ? "LIST_WALLET_LABEL_AMBIGUOUS"
                  : "LIST_WALLET_LABEL_UNVERIFIED",
              ],
        );
        if (mode === "duplicate") expect(events(trace)[0].count).toBe(2);
      },
    );
    test("bounded diagnostic unavailability leaves selection and total validation intact", async () => {
      const trace = new FailureDiagnostics();
      expect(
        await parse(
          wallet.replace(label, `${label}${"<i></i>".repeat(1001)}`),
          trace,
        ),
      ).toHaveLength(1);
      expect(events(trace)[0]).toMatchObject({
        reason: "LIST_WALLET_EVIDENCE_UNAVAILABLE",
      });
    });
    test("missing header proof still fails instead of triggering a wallet skip", async () => {
      await page.setContent(
        wallet.replace("Total ₹17.00", "No declared total"),
      );
      await expect(
        parseCurrentOrderPage(page, new FailureDiagnostics()),
      ).rejects.toMatchObject({ reason: "LIST_TOTAL_MISSING" });
    });
    test("pagination and duplicate indexes retain unverified records under the existing cap", async () => {
      html =
        wallet +
        purchase() +
        `<ul class="a-pagination"><li class="a-last"><a href="?page=2">Next</a></li></ul>`;
      page2 = wallet + purchase(otherId);
      jest
        .spyOn(chromium, "launchPersistentContext")
        .mockResolvedValue(context);
      const trace = new FailureDiagnostics();
      const selected = await listOrders(
        options.startDate,
        options.endDate,
        3,
        trace,
      );
      expect(selected.pagesScanned).toBe(2);
      expect(selected.orders.map((order) => order.orderId)).toEqual([
        walletId,
        purchaseId,
        otherId,
      ]);
      expect(events(trace).map((event) => event.orderIndex)).toEqual([0, 0]);
    });
    test("unverified funding still consumes the current cap; no speculative exclusion is enabled", async () => {
      html =
        wallet +
        purchase() +
        `<ul class="a-pagination"><li class="a-last"><a href="?page=2">Next</a></li></ul>`;
      jest
        .spyOn(chromium, "launchPersistentContext")
        .mockResolvedValue(context);
      const selected = await listOrders(
        options.startDate,
        options.endDate,
        1,
        new FailureDiagnostics(),
      );
      expect(selected.orders.map((order) => order.orderId)).toEqual([walletId]);
      expect(selected.pagesScanned).toBe(1);
      expect(requests.some((path) => path.includes("page=2"))).toBe(false);
    });
    test("wallet-like duplicates with conflicting totals still fail closed", async () => {
      await page.setContent(wallet + wallet.replace("₹17.00", "₹18.00"));
      await expect(
        parseCurrentOrderPage(page, new FailureDiagnostics()),
      ).rejects.toMatchObject({ reason: "LIST_DUPLICATE_CONFLICT" });
    });
    test("Now routing remains intact alongside wallet hints", async () => {
      html = purchase(purchaseId, label).replace(
        "</section>",
        `<a href="https://www.amazon.in/uff/your-account/order-details?orderID=${purchaseId}">View order details</a></section>`,
      );
      jest
        .spyOn(chromium, "launchPersistentContext")
        .mockResolvedValue(context);
      const trace = new FailureDiagnostics();
      const [summary] = (
        await listOrders(options.startDate, options.endDate, 1, trace)
      ).orders;
      expect(summary.nowDetailUrl).toContain("/uff/");
      const extracted = await extractOrderItems(
        purchaseId,
        undefined,
        summary,
        trace,
      );
      expect(extracted.items).toHaveLength(23);
      expect(extracted.orderTotalSource).toBe("amazon-now-you-pay");
    });
    test("a genuine wallet-paid purchase still publishes unchanged merchandise JSON", async () => {
      html = purchase(purchaseId, label);
      jest
        .spyOn(chromium, "launchPersistentContext")
        .mockResolvedValue(context);
      const directory = await mkdtemp(join(tmpdir(), "wallet-purchase-"));
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
        expect(document.orders[0].items).toHaveLength(1);
        expect(document.orders[0].orderTotal).toBe(10);
        expect(document.orders[0].items[0].lineIndex).toBe(0);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
    test("detail identity failure is never converted into exclusion and preserves prior output with safe events", async () => {
      html = purchase() + wallet;
      jest
        .spyOn(chromium, "launchPersistentContext")
        .mockResolvedValue(context);
      const directory = await mkdtemp(join(tmpdir(), "wallet-failure-"));
      const output = join(directory, "orders.json");
      const reports = join(directory, "reports");
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
              report: (report) => writeFailureReport(report, reports),
              cleanup: async () => {},
            },
          ),
        ).rejects.toMatchObject({
          reason: "DETAIL_ORDER_MISMATCH",
          category: "validation",
        });
        expect(await readFile(output, "utf8")).toBe("prior complete export");
        expect((await readdir(directory)).sort()).toEqual([
          "orders.json",
          "reports",
        ]);
        const [name] = await readdir(reports);
        const serialized = await readFile(join(reports, name), "utf8");
        const report = JSON.parse(serialized);
        expect(report.failure).toEqual({
          stage: "detail",
          reason: "DETAIL_ORDER_MISMATCH",
          category: "validation",
        });
        expect(
          report.events.filter((event: { reason: string }) =>
            event.reason.startsWith("LIST_WALLET_"),
          ),
        ).toEqual([
          expect.objectContaining({
            reason: "LIST_WALLET_LABEL_UNVERIFIED",
            count: 1,
            orderIndex: 1,
          }),
        ]);
        expect(serialized + logs.join(" ")).not.toMatch(
          /PRIVATE_WALLET|person@example|private\/path|Amazon Pay Wallet Add Money|fixture-transaction/,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }, 15000);
  },
);
