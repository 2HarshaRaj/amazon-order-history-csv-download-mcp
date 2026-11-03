/// <reference lib="dom" />
import type { Locator } from "playwright";
import { z } from "zod";
import { DiagnosticError } from "./failure-diagnostics";

// Public service catalogue identity observed independently of any owner booking.
export const FLIGHT_SERVICE_ASIN = "B07KZ5RJ29";

function reject(): never {
  throw new DiagnosticError(
    "list",
    "LIST_FLIGHT_UNVERIFIED",
    "Flight booking card could not be independently verified.",
  );
}

/** List-card proof only. Never navigate transaction pages or return itinerary text. */
export async function verifyFlightBookingCard(
  card: Locator,
  orderId: string,
  orderDate: string,
  cardSelector: string,
): Promise<{ routingKey: string } | undefined> {
  let observed: unknown;
  try {
    observed = await card.evaluate(
      (root, { expected, date, ownerSelector, asin }) => {
        const norm = (el: Element): string =>
          (el.textContent ?? "").replace(/\s+/g, " ").trim();
        const url = (el: Element): URL | undefined => {
          try {
            return new URL(
              el.getAttribute("href") ?? "",
              root.ownerDocument.URL,
            );
          } catch {
            return undefined;
          }
        };
        const anchors = Array.from(root.querySelectorAll("a[href]"));
        const isProduct = (u: URL | undefined): boolean =>
          Boolean(
            u &&
            new RegExp("^/(?:dp|gp/product)/" + asin + "(?:/|$)").test(
              u.pathname,
            ),
          );
        // Positive structural candidates remain candidates when another required signal
        // is missing. Travel words and numeric order IDs are never candidate signals.
        const candidate = anchors.some((a) => {
          const u = url(a);
          return (
            isProduct(u) ||
            u?.pathname === "/flights/" ||
            u?.searchParams.getAll("useCase").some((v) => v === "boson_flights")
          );
        });
        if (!candidate) return { kind: "none" };
        const invalid = { kind: "invalid" };
        const nodes = [root, ...Array.from(root.querySelectorAll("*"))];
        if (nodes.length > 1000 || anchors.length > 20) return invalid;
        const current = (el: Element): boolean => {
          if (el.closest(ownerSelector) !== root) return false;
          for (let n: Element | null = el; n; n = n.parentElement) {
            const s = getComputedStyle(n);
            if (
              n.hasAttribute("hidden") ||
              n.getAttribute("aria-hidden") === "true" ||
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
        const single = (selector: string): Element | undefined => {
          const found = root.querySelectorAll(selector);
          return found.length === 1 && current(found[0]) ? found[0] : undefined;
        };
        const safe = (u: URL | undefined): u is URL =>
          Boolean(
            u &&
            u.protocol === "https:" &&
            ["amazon.in", "www.amazon.in"].includes(u.hostname) &&
            !u.port &&
            !u.username &&
            !u.password &&
            !u.hash,
          );
        const publicRefOnly = (u: URL): boolean =>
          [...u.searchParams].every(
            ([k, v]) => k === "ref" && /^[A-Za-z0-9_-]{1,160}$/.test(v),
          ) && u.searchParams.getAll("ref").length <= 1;
        if (
          !/^\d{3}-\d{7}-\d{7}$/.test(expected) ||
          root.querySelector(ownerSelector) ||
          nodes.some(
            (el) =>
              el.hasAttribute("data-order-id") &&
              el.getAttribute("data-order-id") !== expected,
          )
        )
          return invalid;
        const header = single(
          '.order-header,.order-info,[data-component="orderHeader"]',
        );
        const identity = single(".yohtmlc-order-id");
        if (
          !header ||
          !identity ||
          !header.contains(identity) ||
          identity.children.length !== 2 ||
          norm(identity.children[0]) !== "Order #" ||
          norm(identity.children[1]) !== expected ||
          !Array.from(identity.children).every(current)
        )
          return invalid;
        // Count direct text copies, including hidden/stale contradictions, once each.
        const texts = nodes
          .filter((el) => !el.closest("script,style,template"))
          .flatMap((el) =>
            Array.from(el.childNodes)
              .filter((n) => n.nodeType === 3)
              .map((n) => ({ owner: el, text: n.textContent ?? "" })),
          );
        // Inert inline application data is not identity evidence or rendered card text.
        // Keep the same text bound on direct evidence nodes, without counting scripts.
        if (texts.reduce((size, t) => size + t.text.length, 0) > 50000)
          return invalid;
        const identities = texts.flatMap((t) =>
          (
            t.text.match(
              /\b(?:[A-Z0-9]{3}-\d{7}-\d{7}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\b/gi,
            ) ?? []
          ).map((value) => ({ owner: t.owner, value })),
        );
        if (
          identities.length !== 1 ||
          identities[0].value !== expected ||
          !identity.contains(identities[0].owner) ||
          !current(identities[0].owner)
        )
          return invalid;
        const raw = texts
          .map((t) => t.text)
          .join(" ")
          .replace(/\s+/g, " ");
        const placed = [
          ...raw.matchAll(/\bOrder placed\s+(\d{1,2}) ([A-Za-z]+) (\d{4})\b/gi),
        ];
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
        const parts = placed[0];
        if (
          placed.length !== 1 ||
          !parts ||
          !months.includes(parts[2].toLowerCase()) ||
          date !==
            parts[3] +
              "-" +
              String(months.indexOf(parts[2].toLowerCase()) + 1).padStart(
                2,
                "0",
              ) +
              "-" +
              parts[1].padStart(2, "0")
        )
          return invalid;
        const calendar = new Date(
          Date.UTC(
            Number(parts[3]),
            months.indexOf(parts[2].toLowerCase()),
            Number(parts[1]),
          ),
        );
        if (
          !Number.isFinite(calendar.getTime()) ||
          calendar.toISOString().slice(0, 10) !== date
        )
          return invalid;
        const headerText = texts.filter((t) => header.contains(t.owner));
        if (
          !headerText.every((t) => !t.text.trim() || current(t.owner)) ||
          !/\bOrder placed\s+\d{1,2} [A-Za-z]+ \d{4}\b/i.test(
            headerText
              .map((t) => t.text)
              .join(" ")
              .replace(/\s+/g, " "),
          )
        )
          return invalid;
        const details = anchors.filter((a) => norm(a) === "View order details");
        const action = details[0],
          destination = action && url(action);
        if (
          details.length !== 1 ||
          !action ||
          !current(action) ||
          !header.contains(action) ||
          !action.closest(".yohtmlc-order-level-connections") ||
          !safe(destination) ||
          destination.pathname !== "/pay/transaction-details"
        )
          return invalid;
        const allowed = [
          "ingress",
          "idempotencyId",
          "useCase",
          "orderId",
          "ref",
        ];
        if (
          [...destination.searchParams.keys()].some(
            (k) => !allowed.includes(k),
          ) ||
          allowed.some((k) => destination.searchParams.getAll(k).length > 1) ||
          destination.searchParams.get("orderId") !== expected ||
          destination.searchParams.get("useCase") !== "boson_flights" ||
          destination.searchParams.get("ingress") !== "BOSON_ORDER_HISTORY"
        )
          return invalid;
        const routingKey = destination.searchParams.get("idempotencyId");
        if (
          !routingKey ||
          routingKey.length > 512 ||
          Array.from(routingKey).some(
            (character) =>
              /\s/.test(character) ||
              character.charCodeAt(0) < 32 ||
              character.charCodeAt(0) === 127,
          )
        )
          return invalid;
        const delivery = single(".delivery-box"),
          item = single(".item-box.yo-enhanced-items");
        const status = single(
          ".yohtmlc-shipment-status-primaryText .delivery-box__primary-text",
        );
        const title = single(".yohtmlc-product-title a[href]"),
          image = single(".product-image img");
        if (
          !delivery ||
          !item ||
          !status ||
          !title ||
          !image ||
          !delivery.contains(item) ||
          !delivery.contains(status) ||
          norm(status) !== "Booking successful" ||
          !item.contains(title) ||
          !item.contains(image) ||
          !norm(title) ||
          norm(title).length > 300 ||
          norm(title) !==
            (image.getAttribute("alt") ?? "").replace(/\s+/g, " ").trim() ||
          root.querySelectorAll("img").length !== 1 ||
          root.querySelectorAll(".item-box").length !== 1 ||
          norm(title.closest(".yohtmlc-product-title") ?? title) !==
            norm(title) ||
          norm(
            status.closest(".yohtmlc-shipment-status-primaryText") ?? status,
          ) !== "Booking successful" ||
          root.querySelector(
            "input,button,select,textarea,[data-component=purchasedItems],[data-component=quantity],.od-item-view-qty",
          )
        )
          return invalid;
        // Only independently owned status roles declare booking state. Never scan
        // itinerary/product text for travel words. A hidden contradictory declaration
        // is still ambiguous evidence, so do not discard it as stale or non-current.
        const statusFields = Array.from(
          root.querySelectorAll(
            ".yohtmlc-shipment-status-primaryText,.yohtmlc-shipment-status-secondaryText,.delivery-box__primary-text,.delivery-box__secondary-text",
          ),
        );
        const nonSuccessState =
          "(?:cancelled|canceled|pending|failed|unsuccessful|declined|rejected|expired|in\\s+progress|on\\s+hold|not\\s+(?:successful|confirmed))";
        const contradictoryBooking = new RegExp(
          "\\b(?:flight(?:\\s+booking)?|booking)(?:\\s+status)?\\s*:?\\s*(?:(?:is|was|has\\s+been)\\s+)?" +
            nonSuccessState +
            "\\b",
          "i",
        );
        const contradictoryBareState = new RegExp(
          "^" + nonSuccessState + "[.!]?$",
          "i",
        );
        for (const field of statusFields) {
          if (
            field.closest(ownerSelector) !== root ||
            field.closest(".delivery-box") !== delivery ||
            header.contains(field) ||
            item.contains(field) ||
            field.contains(item)
          )
            return invalid;
          // Direct text-node boundaries retain split declarations without borrowing
          // text from another card or interpreting hidden content as positive proof.
          const declaration = texts
            .filter((t) => field.contains(t.owner))
            .map((t) => t.text)
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
          if (
            contradictoryBooking.test(declaration) ||
            contradictoryBareState.test(declaration)
          )
            return invalid;
        }
        const products = anchors.filter((a) =>
          /\/(?:dp|gp\/product)\//.test(url(a)?.pathname ?? ""),
        );
        if (
          products.length !== 2 ||
          !products.every(
            (a) =>
              current(a) &&
              item.contains(a) &&
              safe(url(a)) &&
              isProduct(url(a)),
          )
        )
          return invalid;
        const imageLink = image.closest("a");
        if (
          !imageLink ||
          !products.includes(imageLink as HTMLAnchorElement) ||
          !products.includes(title as HTMLAnchorElement) ||
          imageLink === title ||
          imageLink.children.length !== 1 ||
          imageLink.children[0] !== image ||
          norm(imageLink) ||
          title.querySelector("img,svg,script,style,template") ||
          [status, title].some((el) =>
            Array.from(el.querySelectorAll("*")).some(
              (n) => norm(n) && !current(n),
            ),
          )
        )
          return invalid;
        const rebooks = anchors.filter((a) => url(a)?.pathname === "/flights/");
        const rebook = rebooks[0],
          rebookUrl = rebook && url(rebook);
        if (
          rebooks.length !== 1 ||
          !rebook ||
          !current(rebook) ||
          !item.contains(rebook) ||
          !rebook.closest(".yohtmlc-item-level-connections") ||
          !norm(rebook) ||
          !safe(rebookUrl) ||
          !publicRefOnly(rebookUrl) ||
          item.querySelectorAll("a[href]").length !== 3
        )
          return invalid;
        const otherAnchors = anchors.filter(
          (a) => a !== action && !item.contains(a),
        );
        if (
          otherAnchors.some(
            (a) =>
              a.getAttribute("href") !== "javascript:void(0)" ||
              a.getAttribute("data-action") !== "a-expander-toggle" ||
              !a.closest(".yo-collapsible-actions__expander") ||
              norm(a) !== "More options",
          ) ||
          otherAnchors.length > 1
        )
          return invalid;
        const itemTexts = texts.filter(
          (t) => item.contains(t.owner) && t.text.trim(),
        );
        if (
          itemTexts.some(
            (t) => !title.contains(t.owner) && !rebook.contains(t.owner),
          )
        )
          return invalid;
        // Only an opaque route discriminator crosses this boundary, in memory, for
        // duplicate consistency. Never return service title/alt, itinerary or totals.
        return { kind: "verified", routingKey };
      },
      {
        expected: orderId,
        date: orderDate,
        ownerSelector: cardSelector,
        asin: FLIGHT_SERVICE_ASIN,
      },
      { timeout: 2000 },
    );
  } catch {
    reject();
  }
  if (
    z
      .object({ kind: z.literal("none") })
      .strict()
      .safeParse(observed).success
  )
    return undefined;
  const proof = z
    .object({
      kind: z.literal("verified"),
      routingKey: z.string().min(1).max(512),
    })
    .strict()
    .safeParse(observed);
  if (!proof.success) reject();
  return { routingKey: proof.data.routingKey };
}
