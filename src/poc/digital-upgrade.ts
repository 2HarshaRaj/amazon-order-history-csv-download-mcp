/// <reference lib="dom" />
import type { Locator, Page } from "playwright";
import { z } from "zod";
import { DiagnosticError } from "./failure-diagnostics";
import { extractHeaderOrderTotal } from "./order-total";

// Public catalogue/service identities, not an owner's order ID or purchase data.
// Issue #22 owner policy: this exact free digital-service activation is an upgrade.
export const ALEXA_UPGRADE = Object.freeze({
  name: "Alexa+",
  asin: "B0H7CM5J66",
  seller: "Alexa IN",
  sellerId: "A2F4ER0CC9L9HZ",
});

function reject(): never {
  throw new DiagnosticError(
    "list",
    "LIST_DIGITAL_UNVERIFIED",
    "Digital order exclusion could not be independently verified.",
  );
}

/** One selected digital service only. Never a general digital-order adapter. */
export async function verifyDigitalUpgrade(
  listing: Page,
  card: Locator,
  orderId: string,
  orderDate: string,
  authenticate: (page: Page) => Promise<void>,
): Promise<void> {
  if (!/^D01-\d{7}-\d{7}$/.test(orderId)) reject();
  const total = await extractHeaderOrderTotal(card);
  if (!total || total.currency !== "INR" || total.amount !== 0) reject();
  const read = async (scope: Locator, detail: boolean): Promise<unknown> =>
    scope.evaluate(
      (root, { service, expected, date, detail }) => {
        const norm = (el: Element): string =>
          (el.textContent ?? "").replace(/\s+/g, " ").trim();
        const sameDate = (value: string): boolean => {
          const months = [
            "january",
            "february",
            "march",
            "april",
            "may",
            "june",
            "july",
            "august",
            "september",
            "october",
            "november",
            "december",
          ];
          const match = /^(\d{1,2}) ([A-Za-z]+) (\d{4})$/.exec(value);
          return Boolean(
            match &&
            months.includes(match[2].toLowerCase()) &&
            date ===
              match[3] +
                "-" +
                String(months.indexOf(match[2].toLowerCase()) + 1).padStart(
                  2,
                  "0",
                ) +
                "-" +
                match[1].padStart(2, "0"),
          );
        };
        const current = (el: Element, a11y = true): boolean => {
          for (let n: Element | null = el; n; n = n.parentElement) {
            const s = getComputedStyle(n);
            if (
              n.hasAttribute("hidden") ||
              (a11y && n.getAttribute("aria-hidden") === "true") ||
              ["S", "DEL", "STRIKE"].includes(n.tagName) ||
              s.display === "none" ||
              ["hidden", "collapse"].includes(s.visibility) ||
              s.opacity === "0" ||
              s.textDecorationLine.includes("line-through")
            )
              return false;
          }
          return el.getClientRects().length > 0;
        };
        const nodes = Array.from(root.querySelectorAll("*"));
        if (nodes.length > 5000) return null;
        const component = (name: string): Element | null => {
          const found = root.querySelectorAll(
            '[data-component="' + name + '"]',
          );
          return found.length === 1 && current(found[0]) ? found[0] : null;
        };
        // Direct text nodes avoid both ancestor double counting and embedded scripts.
        const identityNodes = nodes.filter(
          (el) =>
            !el.closest("script,style,template") &&
            Array.from(el.childNodes).some(
              (n) =>
                n.nodeType === 3 &&
                /\b(?:[A-Z0-9]{3}-\d{7}-\d{7}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\b/i.test(
                  n.textContent ?? "",
                ),
            ),
        );
        const identities = identityNodes.flatMap((el) =>
          Array.from(el.childNodes)
            .filter((n) => n.nodeType === 3)
            .flatMap(
              (n) =>
                (n.textContent ?? "").match(
                  /\b(?:[A-Z0-9]{3}-\d{7}-\d{7}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\b/gi,
                ) ?? [],
            ),
        );
        if (
          identities.length !== 1 ||
          identities[0] !== expected ||
          identityNodes.some((el) => !current(el))
        )
          return null;
        const productLinks = nodes.filter((el) =>
          el.matches('a[href*="/dp/"],a[href*="/gp/product/"]'),
        );
        if (productLinks.length !== 2) return null;
        let title: Element | undefined, image: Element | undefined;
        for (const a of productLinks) {
          const u = new URL(
            a.getAttribute("href") ?? "",
            root.ownerDocument.URL,
          );
          if (
            u.protocol !== "https:" ||
            !["amazon.in", "www.amazon.in"].includes(u.hostname) ||
            u.username ||
            u.password ||
            u.port ||
            u.hash ||
            !new RegExp("^/(?:dp|gp/product)/" + service.asin + "(?:/|$)").test(
              u.pathname,
            ) ||
            !current(a)
          )
            return null;
          if (
            detail &&
            !/^ppx_hzod_(?:title|image)_dt_b_fed_digi_asin_title_\d+_\d+_\d+$/.test(
              u.searchParams.get("ref_") ?? "",
            )
          )
            return null;
          if (
            a.querySelectorAll("img").length === 1 &&
            a.children.length === 1 &&
            !norm(a)
          ) {
            if (image) return null;
            image = a.querySelector("img") ?? undefined;
            if (
              !image ||
              image.getAttribute("alt") !== service.name ||
              !current(image)
            )
              return null;
          } else if (
            norm(a) === service.name &&
            !a.querySelector("img,svg,button,input")
          ) {
            if (title) return null;
            title = a;
          } else return null;
        }
        if (!title || !image) return null;
        const merchandise = title.closest(".a-fixed-left-grid");
        if (
          !merchandise ||
          !merchandise.contains(image) ||
          root.querySelectorAll(".a-fixed-left-grid").length !== 1 ||
          merchandise.querySelectorAll("img").length !== 1 ||
          merchandise.querySelector(
            "script,style,template,input,button,select,textarea,[role=button],[data-component=quantity],.od-item-view-qty",
          )
        )
          return null;
        if (!detail) {
          const raw = nodes
            .filter((el) => !el.closest("script,style,template"))
            .flatMap((el) =>
              Array.from(el.childNodes)
                .filter((n) => n.nodeType === 3)
                .map((n) => n.textContent ?? ""),
            )
            .join(" ");
          if (
            /\b(?:cancelled|canceled|refund|refunded|return|returned)\b/i.test(
              raw,
            )
          )
            return null;
          const headers = root.querySelectorAll(
            ".order-header,.order-info,[data-component=orderHeader]",
          );
          if (
            headers.length !== 1 ||
            !headers[0].contains(identityNodes[0]) ||
            norm(merchandise) !== service.name ||
            nodes.some((el) => el.matches("[data-component=purchasedItems]")) ||
            /\b(?:cancelled|canceled|refund|shipment|tracking)\b/i.test(
              norm(merchandise),
            )
          )
            return null;
          const headerNodes = [
            headers[0],
            ...Array.from(headers[0].querySelectorAll("*")),
          ].filter((el) => !el.closest("script,style,template"));
          const headerText = headerNodes
            .flatMap((el) =>
              Array.from(el.childNodes)
                .filter((n) => n.nodeType === 3)
                .map((n) => n.textContent ?? ""),
            )
            .join(" ")
            .replace(/\s+/g, " ");
          const dates = [
            ...headerText.matchAll(
              /Order placed\s*(\d{1,2} [A-Za-z]+ \d{4})/gi,
            ),
          ];
          const amounts =
            headerText.match(/(?:₹\s*|INR\s+)[0-9][0-9,.]*/g) ?? [];
          if (
            dates.length !== 1 ||
            !sameDate(dates[0][1]) ||
            amounts.length !== 1 ||
            amounts[0] !== "₹0.00"
          )
            return null;
          const actions = Array.from(root.querySelectorAll("a[href]")).filter(
            (a) => norm(a) === "View order details",
          );
          if (actions.length !== 1 || !current(actions[0])) return null;
          return { href: actions[0].getAttribute("href") };
        }
        const id = component("orderId"),
          idLabel = component("orderIdLabel"),
          placed = component("orderDate"),
          placedLabel = component("orderDateLabel");
        const info = component("briefOrderInfoInvoiceLeftGrid");
        if (
          !id ||
          !idLabel ||
          !placed ||
          !placedLabel ||
          !info ||
          ![id, idLabel, placed, placedLabel].every((el) =>
            info.contains(el),
          ) ||
          norm(id) !== expected ||
          norm(idLabel) !== "Order number" ||
          norm(placedLabel) !== "Order placed" ||
          [id, idLabel, placed, placedLabel].some((el) =>
            Array.from(el.querySelectorAll("*")).some(
              (n) => norm(n) && !current(n),
            ),
          )
        )
          return null;
        if (!sameDate(norm(placed))) return null;
        const purchased = component("purchasedItems"),
          merchant = component("orderedMerchant"),
          price = component("unitPrice"),
          name = component("itemTitle");
        if (
          !purchased ||
          !purchased.contains(merchandise) ||
          !merchant ||
          !price ||
          !name ||
          ![merchant, price, name].every((el) => merchandise.contains(el)) ||
          !name.contains(title) ||
          norm(name) !== service.name ||
          norm(purchased) !== norm(merchandise) ||
          purchased.querySelectorAll("img").length !== 1 ||
          norm(merchant) !== "Sold by: " + service.seller
        )
          return null;
        const sellers = merchant.querySelectorAll("a[href]");
        if (
          sellers.length !== 1 ||
          norm(sellers[0]) !== service.seller ||
          !current(sellers[0])
        )
          return null;
        const seller = new URL(
          sellers[0].getAttribute("href") ?? "",
          root.ownerDocument.URL,
        );
        if (
          seller.protocol !== "https:" ||
          !["amazon.in", "www.amazon.in"].includes(seller.hostname) ||
          seller.port ||
          seller.username ||
          seller.password ||
          seller.pathname !== "/gp/aag/main" ||
          seller.searchParams.getAll("seller").length !== 1 ||
          seller.searchParams.get("seller") !== service.sellerId
        )
          return null;
        const prices = price.querySelectorAll(".a-offscreen");
        const box = price.children[0];
        if (
          price.children.length !== 1 ||
          !box?.matches("span.a-price") ||
          box.children.length !== 2 ||
          prices.length !== 1 ||
          !prices[0].matches("span.a-offscreen") ||
          prices[0].children.length !== 0 ||
          norm(prices[0]) !== "₹0.00" ||
          !box.children[1].matches('span[aria-hidden="true"]') ||
          !current(box.children[1], false) ||
          norm(box.children[1]) !== "₹0.00" ||
          norm(price).replace(/\s/g, "") !== "₹0.00₹0.00"
        )
          return null;
        // Complete merchandise accounting: no extra, hidden or stale facts disappear.
        const owned = [name, merchant, price];
        if (
          [merchandise, ...Array.from(merchandise.querySelectorAll("*"))].some(
            (el) =>
              !owned.some((o) => o.contains(el)) &&
              Array.from(el.childNodes).some(
                (n) => n.nodeType === 3 && n.textContent?.trim(),
              ),
          ) ||
          Array.from(merchandise.querySelectorAll("*")).some(
            (el) => !price.contains(el) && norm(el) && !current(el),
          )
        )
          return null;
        const summary = component("chargeSummary");
        if (
          !summary ||
          summary.querySelector(
            "a,img,svg,input,button,script,style,template",
          ) ||
          Array.from(summary.querySelectorAll("*")).some(
            (el) => norm(el) && !current(el),
          )
        )
          return null;
        const headings = summary.querySelectorAll("h5"),
          rows = summary.querySelectorAll(".od-line-item-row");
        if (
          headings.length !== 1 ||
          norm(headings[0]) !== "Order Summary" ||
          rows.length !== 2
        )
          return null;
        for (const [index, row] of Array.from(rows).entries()) {
          if (
            row.children.length !== 2 ||
            !row.children[0].matches(".od-line-item-row-label") ||
            !row.children[1].matches(".od-line-item-row-content") ||
            norm(row.children[0]) !==
              (index === 0 ? "Item(s) Subtotal:" : "Total for this Order:") ||
            norm(row.children[1]) !== "₹0.00"
          )
            return null;
        }
        if (
          norm(summary).replace(/\s/g, "") !==
          "OrderSummaryItem(s)Subtotal:₹0.00TotalforthisOrder:₹0.00"
        )
          return null;
        return { verified: true };
      },
      { service: ALEXA_UPGRADE, expected: orderId, date: orderDate, detail },
      { timeout: 3000 },
    );
  const source = z
    .object({ href: z.string().min(1).max(1000) })
    .strict()
    .safeParse(await read(card, false));
  if (!source.success) reject();
  const allowed = (value: string, final = false): boolean => {
    try {
      const u = new URL(value, listing.url()),
        ids = [...u.searchParams].filter(([k]) => /^orderid$/i.test(k));
      return (
        u.protocol === "https:" &&
        ["amazon.in", "www.amazon.in"].includes(u.hostname) &&
        !u.port &&
        !u.username &&
        !u.password &&
        !u.hash &&
        ids.length === 1 &&
        ids[0][1] === orderId &&
        (final
          ? [
              "/your-orders/order-details",
              "/gp/your-account/order-details",
            ].includes(u.pathname)
          : [
              "/gp/css/order-details",
              "/your-orders/order-details",
              "/gp/your-account/order-details",
            ].includes(u.pathname))
      );
    } catch {
      return false;
    }
  };
  const href = new URL(source.data.href, listing.url()).href;
  if (!allowed(href)) reject();
  const page = await listing.context().newPage();
  let invalid = false,
    auth = false;
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    const u = new URL(frame.url());
    if (
      u.protocol === "https:" &&
      ["amazon.in", "www.amazon.in"].includes(u.hostname) &&
      /^\/ap\/(?:signin|cvf)(?:\/|$)/.test(u.pathname)
    )
      return;
    if (!allowed(frame.url())) invalid = true;
  });
  page.on("response", (response) => {
    if (
      response.request().isNavigationRequest() &&
      response.frame() === page.mainFrame() &&
      response.status() >= 400
    )
      invalid = true;
  });
  try {
    await page.goto(href, { waitUntil: "domcontentloaded", timeout: 15000 });
    await authenticate(page);
    if (invalid || !allowed(page.url(), true)) reject();
    const detailScope = page.locator('[data-component="default"]');
    if ((await detailScope.count()) !== 1) reject();
    const verified = await read(detailScope, true);
    if (
      invalid ||
      !allowed(page.url(), true) ||
      !z
        .object({ verified: z.literal(true) })
        .strict()
        .safeParse(verified).success
    )
      reject();
    // Revalidate the original card and zero header after the separate detail read.
    const fresh = await read(card, false),
      freshTotal = await extractHeaderOrderTotal(card);
    if (
      JSON.stringify(fresh) !== JSON.stringify(source.data) ||
      !freshTotal ||
      freshTotal.amount !== 0 ||
      freshTotal.currency !== "INR"
    )
      reject();
  } catch (error) {
    auth =
      error instanceof Error && error.name === "AuthenticationRequiredError";
    if (auth || error instanceof DiagnosticError) throw error;
    reject();
  } finally {
    if (!auth) await page.close();
  }
}
