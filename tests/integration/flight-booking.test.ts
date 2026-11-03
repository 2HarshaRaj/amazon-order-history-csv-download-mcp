/** Fabricated records and offline intercepted pages only. No account profile. */
import { existsSync, readFileSync } from "fs";
import { readFile, readdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import { Browser, BrowserContext, Page, chromium } from "playwright";
import { makeTestDirectory } from "../helpers/temp-directory";
import * as totals from "../../src/poc/order-total";
import {
  FLIGHT_SERVICE_ASIN,
  verifyFlightBookingCard,
} from "../../src/poc/flight-booking";
import { ALEXA_UPGRADE } from "../../src/poc/digital-upgrade";
import {
  closeBrowser,
  listOrders,
  parseCurrentOrderPage,
} from "../../src/poc/hardened-index-v3";
import {
  DiagnosticError,
  FailureDiagnostics,
} from "../../src/poc/failure-diagnostics";
import { runExport, validateAndWriteExport } from "../../src/poc/export-json";

const executable = [chromium.executablePath(), "/usr/bin/chromium"].find(
  existsSync,
);
const browserTests = executable ? describe : describe.skip;
const flightId = "111-0000000-0000026",
  purchaseId = "111-2222222-3333333",
  nowId = "111-2222222-5555555";
const fixture = (name: string): string =>
  readFileSync(join(__dirname, "fixtures", name), "utf8")
    .replaceAll("FLIGHT_ASIN", FLIGHT_SERVICE_ASIN)
    .replaceAll("SERVICE_ASIN", ALEXA_UPGRADE.asin)
    .replaceAll("SERVICE_SELLER", ALEXA_UPGRADE.sellerId);
const flight = fixture("flight-booking-card.html");
const merchandise = (name = "Fictional merchandise", id = purchaseId): string =>
  `<section class="order-card"><div class="order-header">Order placed 2 October 2026<div>Total ₹10.00</div><span>${id}</span></div><a href="/dp/B000000015">${name}</a></section>`;
const nowCard = merchandise("Fictional groceries", nowId).replace(
  "</section>",
  `<a href="/uff/your-account/order-details?orderId=${nowId}">View order details</a></section>`,
);
const next =
  '<ul class="a-pagination"><li class="a-last"><a href="?page=2">Next</a></li></ul>';
const mutate = (code: string): string =>
  flight + "<script>" + code + ";document.currentScript.remove()</script>";

browserTests("verified flight booking list exclusion", () => {
  let browser: Browser,
    context: BrowserContext,
    page: Page,
    html: string,
    page2: string,
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
    html = flight + merchandise();
    page2 = merchandise();
    requests = [];
    context = await browser.newContext({
      offline: true,
      serviceWorkers: "block",
    });
    await context.route("**/*", async (route) => {
      const u = new URL(route.request().url());
      requests.push(u.pathname);
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body:
          u.pathname === "/your-orders/order-details"
            ? fixture("digital-upgrade-detail.html")
            : u.searchParams.has("page")
              ? page2
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
  const listed = async (
    max = 1,
    start = "2026-10-01",
    end = "2026-10-30",
    trace = new FailureDiagnostics(),
  ): ReturnType<typeof listOrders> => {
    jest.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context);
    return listOrders(start, end, max, trace);
  };
  const parse = async (): ReturnType<typeof parseCurrentOrderPage> => {
    await page.goto("https://www.amazon.in/your-orders/orders");
    return parseCurrentOrderPage(page);
  };
  test("requires independent service, ownership, date, status and flight routing; consumes no slot", async () => {
    const trace = new FailureDiagnostics(),
      r = await listed(1, undefined, undefined, trace);
    expect(r.orders.map((o) => o.orderId)).toEqual([purchaseId]);
    expect(r.audit).toEqual({
      flightBookingsExcluded: 1,
      digitalOrdersExcluded: 0,
      walletFundingExcluded: 0,
      unresolvedOrders: 0,
    });
    expect(requests).not.toContain("/pay/transaction-details");
    expect(requests).not.toContain("/flights/");
    const event = trace
      .report(new Error("Fictional"))
      .events.find((e) => e.reason === "LIST_FLIGHT_BOOKING_EXCLUDED");
    expect(event).toMatchObject({ count: 1 });
    expect(event?.orderIndex).toBeUndefined();
    expect(JSON.stringify(event)).not.toMatch(
      /fictional-route-token|Invented service|111-0000000/,
    );
  });
  test("flight then regular and Now merchandise keeps both and their detail dispatch", async () => {
    html = flight + merchandise() + nowCard;
    const r = await listed(2);
    expect(r.orders.map((o) => o.orderId)).toEqual([purchaseId, nowId]);
    expect(r.orders[0].nowDetailUrl).toBeUndefined();
    expect(r.orders[1].nowDetailUrl).toContain(
      "/uff/your-account/order-details?orderId=" + nowId,
    );
  });
  test.each([
    "Flight travel adapter",
    "Flights travel guide",
    "Flight Booking accessory",
  ])("travel product %s stays merchandise", async (name) => {
    html = merchandise(name);
    expect((await listed()).orders.map((o) => o.orderId)).toEqual([purchaseId]);
    expect((await parse()).length).toBe(1);
  });
  test.each([
    "Booking cancelled",
    "Booking canceled",
    "Flight cancelled",
    "Booking not successful",
    "Booking pending",
    "Booking failed",
    "Your flight booking has been cancelled",
    "Booking status: not confirmed",
    "Cancelled",
  ])(
    "rejects independently owned secondary booking state: %s",
    async (secondary) => {
      html =
        flight.replace("Fictional service confirmation", secondary) +
        merchandise();
      await expect(listed()).rejects.toMatchObject({
        reason: "LIST_FLIGHT_UNVERIFIED",
      });
    },
  );
  test("a normal owned secondary confirmation permits exclusion", async () => {
    const r = await listed();
    expect(r.audit.flightBookingsExcluded).toBe(1);
    expect(r.orders.map((o) => o.orderId)).toEqual([purchaseId]);
  });
  test("secondary itinerary confirmation and travel words do not declare a conflicting state", async () => {
    html =
      flight.replace(
        "Fictional service confirmation",
        "Flight itinerary confirmation sent; see the Cancelled Flights travel guide.",
      ) + merchandise();
    expect((await listed()).audit.flightBookingsExcluded).toBe(1);
  });
  test("a product description can mention booking cancellation without declaring booking status", async () => {
    html =
      flight.replaceAll(
        "Invented service description",
        "Booking cancelled: fictional travel guide",
      ) + merchandise();
    expect((await listed()).audit.flightBookingsExcluded).toBe(1);
  });
  test("ordinary merchandise with explicit booking/travel wording remains merchandise", async () => {
    html = merchandise("Flight booking confirmation: a travel guide");
    const r = await listed();
    expect(r.audit.flightBookingsExcluded).toBe(0);
    expect(r.orders.map((o) => o.orderId)).toEqual([purchaseId]);
  });
  test.each([
    "el.hidden=true",
    "el.style.display='none'",
    "el.style.visibility='hidden'",
    "el.style.opacity='0'",
    "el.setAttribute('aria-hidden','true')",
    "el.style.textDecoration='line-through'",
  ])(
    "hidden/historical contradictory status cannot be ignored: %s",
    async (hiding) => {
      html =
        mutate(
          "const el=document.querySelector('.yohtmlc-shipment-status-secondaryText');el.textContent='Booking cancelled';" +
            hiding,
        ) + merchandise();
      await expect(listed()).rejects.toMatchObject({
        reason: "LIST_FLIGHT_UNVERIFIED",
      });
    },
  );
  test("split status text cannot evade the contradictory declaration check", async () => {
    html =
      mutate(
        "document.querySelector('.yohtmlc-shipment-status-secondaryText').innerHTML='<span>Booking</span><span>cancelled</span>'",
      ) + merchandise();
    await expect(listed()).rejects.toMatchObject({
      reason: "LIST_FLIGHT_UNVERIFIED",
    });
  });
  test("a hidden contradiction cannot be concealed by normal visible confirmation", async () => {
    html =
      mutate(
        "document.querySelector('.yohtmlc-shipment-status-secondaryText').insertAdjacentHTML('beforeend','<span hidden>Booking cancelled</span>')",
      ) + merchandise();
    await expect(listed()).rejects.toMatchObject({
      reason: "LIST_FLIGHT_UNVERIFIED",
    });
  });
  test("an inner secondary status role still rejects a contradiction if its wrapper changes", async () => {
    html =
      mutate(
        "document.querySelector('.yohtmlc-shipment-status-secondaryText').className='changed-wrapper';document.querySelector('.delivery-box__secondary-text').textContent='Booking cancelled'",
      ) + merchandise();
    await expect(listed()).rejects.toMatchObject({
      reason: "LIST_FLIGHT_UNVERIFIED",
    });
  });
  test("a secondary status cannot borrow a different delivery-box owner", async () => {
    html =
      mutate(
        "const box=document.createElement('div');box.className='delivery-box';document.querySelector('.delivery-box').append(box);box.append(document.querySelector('.yohtmlc-shipment-status-secondaryText'))",
      ) + merchandise();
    await expect(listed()).rejects.toMatchObject({
      reason: "LIST_FLIGHT_UNVERIFIED",
    });
  });
  test("status roles cannot move into the product region and still supply booking evidence", async () => {
    html =
      mutate(
        "document.querySelector('.yohtmlc-product-title a').append(document.querySelector('.yohtmlc-shipment-status-secondaryText'));document.querySelector('img').alt=document.querySelector('.yohtmlc-product-title a').textContent",
      ) + merchandise();
    await expect(listed()).rejects.toMatchObject({
      reason: "LIST_FLIGHT_UNVERIFIED",
    });
  });
  test("a conflicting later booking card is revalidated instead of accepted from the duplicate cache", async () => {
    html = flight + next;
    page2 =
      flight.replace("Fictional service confirmation", "Booking cancelled") +
      merchandise();
    await expect(listed()).rejects.toMatchObject({
      reason: "LIST_FLIGHT_UNVERIFIED",
    });
  });
  test("a secondary contradiction introduced during the header read invalidates proof", async () => {
    const original = totals.extractHeaderOrderTotal;
    let changed = false;
    jest
      .spyOn(totals, "extractHeaderOrderTotal")
      .mockImplementation(async (card) => {
        const result = await original(card);
        if (!changed && (await card.innerText()).includes(flightId)) {
          changed = true;
          await page
            .locator(".yohtmlc-shipment-status-secondaryText")
            .evaluate((el) => {
              el.textContent = "Booking cancelled";
            });
        }
        return result;
      });
    await expect(listed()).rejects.toMatchObject({
      reason: "LIST_FLIGHT_UNVERIFIED",
    });
  });
  test("a numeric ID and missing item markup never authorize exclusion", async () => {
    html = merchandise("Flight booking");
    const r = await listed();
    expect(r.audit.flightBookingsExcluded).toBe(0);
    expect(r.orders).toHaveLength(1);
  });
  test("large inert application data is excluded from the bounded card evidence", async () => {
    html =
      flight.replace(
        "</section>",
        '<script type="application/json">' +
          JSON.stringify({ fictionalPayload: "x".repeat(160000) }) +
          "</script></section>",
      ) + merchandise();
    const r = await listed();
    expect(r.audit.flightBookingsExcluded).toBe(1);
    expect(r.orders).toHaveLength(1);
  });
  test("oversized actual evidence still fails closed", async () => {
    html = flight.replace(
      "</section>",
      "<div>" + "x".repeat(50001) + "</div></section>",
    );
    await expect(listed()).rejects.toMatchObject({
      reason: "LIST_FLIGHT_UNVERIFIED",
    });
  });
  test("flight-only page continues, duplicate booking revalidates and counts once", async () => {
    html = flight + next;
    page2 = flight + merchandise();
    const r = await listed();
    expect(r.pagesScanned).toBe(2);
    expect(r.audit.flightBookingsExcluded).toBe(1);
    expect(r.orders).toHaveLength(1);
  });
  test("two independent valid bookings do not consume merchandise capacity", async () => {
    html =
      flight +
      flight
        .replaceAll(flightId, "111-0000000-0000027")
        .replaceAll("fictional-route-token", "other-fictional-token") +
      merchandise();
    const r = await listed();
    expect(r.audit.flightBookingsExcluded).toBe(2);
    expect(r.orders).toHaveLength(1);
  });
  test("a newer outside-window booking is accounted but not counted as excluded", async () => {
    html = flight.replace("2 October 2026", "2 November 2026") + merchandise();
    const r = await listed();
    expect(r.audit.flightBookingsExcluded).toBe(0);
    expect(r.orders).toHaveLength(1);
  });
  test("an older flight-only page cannot trigger the merchandise date cutoff", async () => {
    html = flight.replace("2 October 2026", "2 September 2026") + next;
    const r = await listed();
    expect(r.pagesScanned).toBe(2);
    expect(r.orders.map((o) => o.orderId)).toEqual([purchaseId]);
    expect(r.audit.flightBookingsExcluded).toBe(0);
  });
  test.each(["2026-10-02", "2026-10-01"])(
    "inclusive flight date window starts %s",
    async (start) => {
      html = flight;
      const r = await listed(1, start, "2026-10-02");
      expect(r.audit.flightBookingsExcluded).toBe(1);
      expect(r.orders).toEqual([]);
    },
  );
  test("page ceiling is retained on flight-only repeated pages", async () => {
    html = flight + next;
    page2 = flight + next;
    const r = await listed();
    expect(r.pagesScanned).toBe(20);
    expect(r.audit.flightBookingsExcluded).toBe(1);
    expect(r.orders).toEqual([]);
  });
  test("wallet and free Alexa exclusions remain distinct", async () => {
    html =
      flight +
      fixture("order-card-wallet-confirmed.html") +
      fixture("digital-upgrade-card.html") +
      merchandise();
    const r = await listed();
    expect(r.audit).toEqual({
      flightBookingsExcluded: 1,
      digitalOrdersExcluded: 1,
      walletFundingExcluded: 1,
      unresolvedOrders: 0,
    });
    expect(r.orders.map((o) => o.orderId)).toEqual([purchaseId]);
  });
  test.each([
    ["date", flight.replace("2 October 2026", "3 October 2026")],
    ["amount", flight.replace("₹120.00", "₹121.00")],
    [
      "routing identity",
      flight.replace("fictional-route-token", "different-fictional-token"),
    ],
    ["merchandise kind", merchandise("Fictional merchandise", flightId)],
  ])("conflicting duplicate %s fails atomically", async (_name, changed) => {
    html = flight + next;
    page2 = changed + merchandise();
    await expect(listed()).rejects.toMatchObject({
      reason: "LIST_DUPLICATE_CONFLICT",
    });
  });
  test("a prior merchandise card cannot become a flight on another page", async () => {
    html = merchandise("Fictional merchandise", flightId) + next;
    page2 = flight + merchandise();
    await expect(listed(2)).rejects.toMatchObject({
      reason: "LIST_DUPLICATE_CONFLICT",
    });
  });
  test.each([
    [
      "missing identity",
      "document.querySelector('.yohtmlc-order-id').remove()",
    ],
    [
      "hidden identity",
      "document.querySelector('.yohtmlc-order-id').hidden=true",
    ],
    [
      "duplicate identity",
      "document.querySelector('.delivery-box').insertAdjacentHTML('beforeend','<span hidden>111-0000000-0000026</span>')",
    ],
    [
      "conflicting identity",
      "document.querySelector('.delivery-box').insertAdjacentHTML('beforeend','<span>111-0000000-0000099</span>')",
    ],
    [
      "conflicting attribute owner",
      "document.querySelector('.delivery-box').setAttribute('data-order-id','111-0000000-0000099')",
    ],
    [
      "wrong label",
      "document.querySelector('.yohtmlc-order-id span').textContent='Reference'",
    ],
    ["missing date", "document.querySelector('.order-header div').remove()"],
    ["hidden date", "document.querySelector('.order-header div').hidden=true"],
    [
      "duplicate date",
      "document.querySelector('.delivery-box').insertAdjacentHTML('beforeend','<span>Order placed 2 October 2026</span>')",
    ],
    [
      "invalid calendar date",
      "document.querySelector('.order-header div').textContent='Order placed 32 October 2026'",
    ],
    [
      "duplicate header",
      "document.querySelector('.order-card').append(document.querySelector('.order-header').cloneNode(true))",
    ],
    [
      "missing status",
      "document.querySelector('.yohtmlc-shipment-status-primaryText').remove()",
    ],
    [
      "changed status",
      "document.querySelector('.delivery-box__primary-text').textContent='Booking pending'",
    ],
    [
      "hidden status",
      "document.querySelector('.delivery-box__primary-text').style.opacity='0'",
    ],
    [
      "historical status",
      "document.querySelector('.delivery-box__primary-text').style.textDecoration='line-through'",
    ],
    [
      "duplicate status",
      "document.querySelector('.delivery-box').append(document.querySelector('.yohtmlc-shipment-status-primaryText').cloneNode(true))",
    ],
    ["missing image", "document.querySelector('.product-image').remove()"],
    [
      "hidden image",
      "document.querySelector('img').setAttribute('aria-hidden','true')",
    ],
    [
      "changed service",
      "document.querySelectorAll('a[href*=\"/dp/\"]').forEach(a=>a.href=a.href.replace('" +
        FLIGHT_SERVICE_ASIN +
        "','B0OTHER0001'))",
    ],
    [
      "conflicting product",
      "document.querySelector('.delivery-box').insertAdjacentHTML('beforeend','<a href=/dp/B0OTHER0001>Other product</a>')",
    ],
    [
      "hidden extra image",
      "document.querySelector('.delivery-box').insertAdjacentHTML('beforeend','<img hidden alt=other>')",
    ],
    [
      "different title and image",
      "document.querySelector('.yohtmlc-product-title a').textContent='Different fictional description'",
    ],
    [
      "unaccounted item text",
      "document.querySelector('.item-box').append('Other fictional merchandise')",
    ],
    [
      "unowned title text",
      "document.querySelector('.yohtmlc-product-title').append('Other description')",
    ],
    [
      "unowned status text",
      "document.querySelector('.yohtmlc-shipment-status-primaryText').append('Pending')",
    ],
    [
      "extra unknown action",
      "document.querySelector('.delivery-box').insertAdjacentHTML('beforeend','<a href=/pay/transaction-details?useCase=boson_flights>Other details</a>')",
    ],
    [
      "missing rebook",
      "document.querySelector('.yohtmlc-item-level-connections').remove()",
    ],
    [
      "foreign rebook",
      "document.querySelector('a[href*=\"/flights/\"]').href='https://example.invalid/flights/'",
    ],
    [
      "changed rebook path",
      "document.querySelector('a[href*=\"/flights/\"]').href='/travel/'",
    ],
    [
      "unknown rebook query",
      "document.querySelector('a[href*=\"/flights/\"]').href='/flights/?unexpected=true'",
    ],
    [
      "hidden rebook",
      "document.querySelector('.yohtmlc-item-level-connections').hidden=true",
    ],
    [
      "duplicate rebook",
      "document.querySelector('.yohtmlc-item-level-connections').append(document.querySelector('a[href*=\"/flights/\"]').cloneNode(true))",
    ],
    [
      "missing details",
      "document.querySelector('.yohtmlc-order-level-connections a').remove()",
    ],
    [
      "duplicate details",
      "document.querySelector('.yohtmlc-order-level-connections').append(document.querySelector('.yohtmlc-order-level-connections a').cloneNode(true))",
    ],
    [
      "hidden details",
      "document.querySelector('.yohtmlc-order-level-connections').hidden=true",
    ],
    [
      "body details",
      "document.querySelector('.delivery-box').append(document.querySelector('.yohtmlc-order-level-connections a'))",
    ],
    [
      "foreign detail host",
      "document.querySelector('.yohtmlc-order-level-connections a').hostname='example.invalid'",
    ],
    [
      "HTTP details",
      "document.querySelector('.yohtmlc-order-level-connections a').protocol='http:'",
    ],
    [
      "credentialed details",
      "document.querySelector('.yohtmlc-order-level-connections a').username='fictional'",
    ],
    [
      "details port",
      "document.querySelector('.yohtmlc-order-level-connections a').port='444'",
    ],
    [
      "details fragment",
      "document.querySelector('.yohtmlc-order-level-connections a').hash='changed'",
    ],
    [
      "wrong details path",
      "document.querySelector('.yohtmlc-order-level-connections a').pathname='/your-orders/order-details'",
    ],
    [
      "wrong use case",
      "const a=document.querySelector('.yohtmlc-order-level-connections a');a.href=a.href.replace('boson_flights','other_service')",
    ],
    [
      "wrong ingress",
      "const a=document.querySelector('.yohtmlc-order-level-connections a');a.href=a.href.replace('BOSON_ORDER_HISTORY','OTHER_HISTORY')",
    ],
    [
      "wrong details identity",
      "const a=document.querySelector('.yohtmlc-order-level-connections a');a.href=a.href.replace('orderId=111-0000000-0000026','orderId=111-0000000-0000099')",
    ],
    [
      "duplicate details identity",
      "document.querySelector('.yohtmlc-order-level-connections a').href+='&orderId=111-0000000-0000026'",
    ],
    [
      "case-alias identity",
      "document.querySelector('.yohtmlc-order-level-connections a').href+='&orderID=111-0000000-0000026'",
    ],
    [
      "missing opaque route",
      "const a=document.querySelector('.yohtmlc-order-level-connections a');a.href=a.href.replace('idempotencyId=fictional-route-token&','')",
    ],
    [
      "unknown query",
      "document.querySelector('.yohtmlc-order-level-connections a').href+='&redirect=https://example.invalid'",
    ],
    [
      "quantity evidence",
      "document.querySelector('.item-box').insertAdjacentHTML('beforeend','<span data-component=quantity>2</span>')",
    ],
    [
      "purchased item region",
      "document.querySelector('.delivery-box').insertAdjacentHTML('beforeend','<div data-component=purchasedItems>Other merchandise</div>')",
    ],
    [
      "DOM bound",
      "document.querySelector('.item-box').insertAdjacentHTML('beforeend','<span></span>'.repeat(1001))",
    ],
  ])("fails closed for %s", async (_name, code) => {
    html = mutate(code) + merchandise();
    await expect(listed()).rejects.toBeInstanceOf(Error);
    expect(requests).not.toContain("/pay/transaction-details");
  });
  test("duplicate nested records cannot borrow a parent's identity", async () => {
    html = flight.replace("</section>", merchandise() + "</section>");
    await expect(listed()).rejects.toBeInstanceOf(Error);
  });
  test("standalone classifier verifies the caller's exact date", async () => {
    await page.goto("https://www.amazon.in/your-orders/orders");
    const card = page.locator(".order-card").first();
    await expect(
      verifyFlightBookingCard(card, flightId, "2026-10-03", ".order-card"),
    ).rejects.toMatchObject({ reason: "LIST_FLIGHT_UNVERIFIED" });
  });
  test.each(["action", "total"])(
    "revalidates booking %s around the header read",
    async (field) => {
      const original = totals.extractHeaderOrderTotal;
      let changed = false;
      jest
        .spyOn(totals, "extractHeaderOrderTotal")
        .mockImplementation(async (card) => {
          const result = await original(card);
          if (!changed && (await card.innerText()).includes(flightId)) {
            changed = true;
            await page.evaluate((which) => {
              if (which === "action") {
                const a = document.querySelector<HTMLAnchorElement>(
                  ".yohtmlc-order-level-connections a",
                );
                if (a)
                  a.href = a.href.replace("boson_flights", "other_service");
              } else {
                const header = document.querySelector(".order-header");
                if (header)
                  header.innerHTML = header.innerHTML.replace(
                    "₹120.00",
                    "₹121.00",
                  );
              }
            }, field);
          }
          return result;
        });
      await expect(listed()).rejects.toMatchObject({
        reason: "LIST_FLIGHT_UNVERIFIED",
      });
    },
  );
  test("an unverified flight after the merchandise cap cannot silently disappear", async () => {
    html = merchandise() + flight.replace("boson_flights", "other_service");
    await expect(listed(1)).rejects.toMatchObject({
      reason: "LIST_FLIGHT_UNVERIFIED",
    });
  });
  test("unverified flight evidence preserves prior output and never reaches extraction", async () => {
    html = flight.replace("boson_flights", "other_service") + merchandise();
    const dir = await makeTestDirectory("unverified-flight-"),
      output = join(dir, "output.json");
    await writeFile(output, "previous complete fictional export");
    try {
      const extract = jest.fn();
      await expect(
        runExport(
          {
            startDate: "2026-10-01",
            endDate: "2026-10-30",
            maxOrders: 5,
            output,
          },
          () => undefined,
          {
            list: () => listed(5),
            extract,
            write: validateAndWriteExport,
            report: async () => undefined,
            cleanup: async () => undefined,
          },
        ),
      ).rejects.toMatchObject({ reason: "LIST_FLIGHT_UNVERIFIED" });
      expect(extract).not.toHaveBeenCalled();
      expect(await readFile(output, "utf8")).toBe(
        "previous complete fictional export",
      );
      expect(await readdir(dir)).toEqual(["output.json"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("a failed merchandise detail cannot become a flight exclusion or overwrite an output", async () => {
    html = merchandise("Flight travel guide");
    const dir = await makeTestDirectory("flight-atomic-"),
      output = join(dir, "output.json");
    await writeFile(output, "previous fictional output");
    try {
      const extract = jest
        .fn()
        .mockRejectedValue(
          new DiagnosticError(
            "detail",
            "DETAIL_ORDER_MISMATCH",
            "Fictional failure",
          ),
        );
      await expect(
        runExport(
          {
            startDate: "2026-10-01",
            endDate: "2026-10-30",
            maxOrders: 5,
            output,
          },
          () => undefined,
          {
            list: () => listed(5),
            extract,
            write: validateAndWriteExport,
            report: async () => undefined,
            cleanup: async () => undefined,
          },
        ),
      ).rejects.toMatchObject({ reason: "DETAIL_ORDER_MISMATCH" });
      expect(extract).toHaveBeenCalledTimes(1);
      expect(await readFile(output, "utf8")).toBe("previous fictional output");
      expect(await readdir(dir)).toEqual(["output.json"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  test("offline export contains only merchandise with the unchanged JSON contract", async () => {
    html = flight + merchandise() + nowCard;
    const dir = await makeTestDirectory("flight-export-"),
      output = join(dir, "output.json");
    try {
      const extract = jest.fn(async (id: string) => {
        const data = {
          orderId: id,
          orderTotal: { amount: 10, currency: "INR", formatted: "₹10.00" },
          itemCount: 1,
          items: [
            {
              asin: "B000000015",
              productName: "Fictional merchandise",
              quantity: 1,
              unitPrice: { amount: 10, currency: "INR", formatted: "₹10.00" },
              itemTotal: { amount: 10, currency: "INR", formatted: "₹10.00" },
            },
          ],
          adjustments: [],
        };
        return id === nowId
          ? {
              ...data,
              orderTotalSource: "amazon-now-you-pay" as const,
              extractionSource: "amazon-now-order-details" as const,
            }
          : {
              ...data,
              orderTotalSource: "order-detail-grand-total" as const,
              extractionSource: "order-detail",
            };
      });
      await runExport(
        {
          startDate: "2026-10-01",
          endDate: "2026-10-30",
          maxOrders: 2,
          output,
        },
        () => undefined,
        {
          list: () => listed(2),
          extract,
          write: validateAndWriteExport,
          cleanup: async () => undefined,
        },
      );
      const doc = JSON.parse(await readFile(output, "utf8"));
      expect(Object.keys(doc).sort()).toEqual(["metadata", "orders"]);
      expect(doc.orders.map((o: { orderId: string }) => o.orderId)).toEqual([
        purchaseId,
        nowId,
      ]);
      expect(extract.mock.calls.map((c) => c[0])).toEqual([purchaseId, nowId]);
      expect(JSON.stringify(doc)).not.toMatch(
        /111-0000000-0000026|fictional-route-token|flightBookingsExcluded|Invented service description/,
      );
      expect(await readdir(dir)).toEqual(["output.json"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
