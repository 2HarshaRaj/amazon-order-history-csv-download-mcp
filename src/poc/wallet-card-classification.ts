/// <reference lib="dom" />
import type { Locator } from "playwright";

export type WalletCardClassification =
  | "not-observed"
  | "unverified"
  | "funding-only"
  | "unavailable";

/** Owner-confirmed list-card structure only. No detail failure authorizes a skip. */
export async function classifyWalletFundingCard(
  card: Locator,
  cardText: string,
  orderId: string,
  cardSelector: string,
): Promise<WalletCardClassification> {
  if (
    !cardText.includes("Amazon Pay Wallet") ||
    !cardText.includes("Money added")
  )
    return "not-observed";
  if (cardText.length > 50000) return "unavailable";
  try {
    const verified = await card.evaluate(
      (root, { expected, ownerSelector }) => {
        const nodes = [root, ...Array.from(root.querySelectorAll("*"))];
        const view = root.ownerDocument.defaultView;
        if (!view || nodes.length > 1000) return -1;
        const raw = (el: Element): string =>
          (el.textContent ?? "").replace(/\s+/g, " ").trim();
        if (/\b(?:cancelled|canceled|refund(?:ed)?)\b/i.test(raw(root)))
          return false;
        const current = (el: Element): boolean => {
          for (let node: Element | null = el; node; node = node.parentElement) {
            const style = view.getComputedStyle(node);
            if (
              node.hasAttribute("hidden") ||
              node.getAttribute("aria-hidden") === "true" ||
              ["S", "DEL", "STRIKE"].includes(node.tagName) ||
              style.display === "none" ||
              ["hidden", "collapse"].includes(style.visibility) ||
              style.opacity === "0" ||
              style.textDecorationLine.includes("line-through")
            )
              return false;
          }
          return el.getClientRects().length > 0;
        };
        const owned = (el: Element): boolean =>
          el.closest(ownerSelector) === root;
        // Raw matches include stale/hidden duplicates; they cannot supply or obscure proof.
        const headings = nodes.filter(
          (el) => el.tagName === "H3" && raw(el) === "Amazon Pay Wallet",
        );
        const statuses = nodes.filter(
          (el) => el.tagName === "SPAN" && raw(el) === "Money added",
        );
        if (headings.length !== 1 || statuses.length !== 1) return false;
        const heading = headings[0],
          status = statuses[0];
        if (![heading, status].every((el) => current(el) && owned(el)))
          return false;
        const thirdParent = (el: Element): Element | null =>
          el.parentElement?.parentElement?.parentElement ?? null;
        const block = thirdParent(heading);
        if (
          !block ||
          block === root ||
          block.tagName !== "DIV" ||
          thirdParent(status) !== block ||
          !root.contains(block) ||
          !owned(block) ||
          !current(block)
        )
          return false;
        const headingRow = heading.closest(".a-row"),
          statusRow = status.closest(".a-row");
        if (
          !headingRow ||
          !statusRow ||
          headingRow === statusRow ||
          !block.contains(headingRow) ||
          !block.contains(statusRow) ||
          headingRow.contains(statusRow) ||
          statusRow.contains(headingRow)
        )
          return false;
        if (
          block.closest(
            '[data-component="paymentSummary"], [data-component="viewPaymentPlanSummaryWidget"], [role="dialog"]',
          )
        )
          return false;
        if (
          nodes.some(
            (el) =>
              el.hasAttribute("data-order-id") &&
              el.getAttribute("data-order-id") !== expected,
          )
        )
          return false;
        const identityText = nodes
          .flatMap((el) =>
            Array.from(el.childNodes)
              .filter((node) => node.nodeType === 3)
              .map((node) => node.textContent ?? ""),
          )
          .join(" ");
        const ids =
          identityText.match(
            /\b(?:\d{3}-\d{7}-\d{7}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\b/gi,
          ) ?? [];
        if (ids.length !== 1 || ids[0] !== expected) return false;
        if (
          root.querySelector(
            '[data-component="purchasedItems"], [data-component="itemTitle"], [data-component="unitPrice"], [data-component="quantity"]',
          )
        )
          return false;
        const links = Array.from(
          root.querySelectorAll('a[href*="/dp/"], a[href*="/gp/product/"]'),
        );
        if (
          links.length !== 2 ||
          block.querySelectorAll("a").length !== 2 ||
          !links.every((el) => block.contains(el) && owned(el) && current(el))
        )
          return false;
        const asin = (el: Element): string | undefined => {
          try {
            const url = new URL(
              el.getAttribute("href") ?? "",
              root.ownerDocument.URL,
            );
            if (
              url.protocol !== "https:" ||
              !["www.amazon.in", "amazon.in"].includes(url.hostname) ||
              url.port ||
              url.username ||
              url.password ||
              url.hash
            )
              return undefined;
            return /^\/dp\/([A-Z0-9]{10})(?:\/|$)/.exec(url.pathname)?.[1];
          } catch {
            return undefined;
          }
        };
        const linkAsin = asin(links[0]);
        if (!linkAsin || asin(links[1]) !== linkAsin) return false;
        const images = Array.from(root.querySelectorAll("img"));
        if (
          images.length !== 1 ||
          !current(images[0]) ||
          !owned(images[0]) ||
          !block.contains(images[0])
        )
          return false;
        const imageLink = links.find((el) => el.contains(images[0]));
        const titleLink = links.find((el) => el !== imageLink);
        if (
          !imageLink ||
          !titleLink ||
          raw(imageLink) ||
          raw(titleLink) !== "Amazon Pay Wallet" ||
          titleLink.querySelector("img")
        )
          return false;
        const imageAsin = /\b[A-Z0-9]{10}\b/.exec(
          images[0].getAttribute("alt") ?? "",
        )?.[0];
        if (imageAsin && imageAsin !== linkAsin) return false;
        // No other text/control/financial/quantity evidence may hide inside the content block.
        const allowed = new Set([heading, status, imageLink, titleLink]);
        const uncovered = (el: Element): string =>
          allowed.has(el)
            ? ""
            : Array.from(el.childNodes)
                .map((node) =>
                  node.nodeType === 3
                    ? (node.textContent ?? "")
                    : node.nodeType === 1
                      ? uncovered(node as Element)
                      : "",
                )
                .join(" ")
                .trim();
        if (
          uncovered(block) ||
          block.querySelector("button, input, select, textarea")
        )
          return false;
        if (
          Array.from(block.querySelectorAll("*")).some(
            (el) => !current(el) && (raw(el) || el.tagName === "IMG"),
          )
        )
          return false;
        // Merchandise/payment context outside the recognized block is uncertain.
        const headers =
          '.order-header, .order-info, [data-component="orderHeader"]';
        if (
          nodes.some(
            (el) =>
              !block.contains(el) &&
              !el.contains(block) &&
              !el.closest(headers) &&
              raw(el) &&
              raw(el) !== expected &&
              raw(el) !== `Order # ${expected}`,
          )
        )
          return false;
        return true;
      },
      { expected: orderId, ownerSelector: cardSelector },
      { timeout: 1500 },
    );
    return verified === true
      ? "funding-only"
      : verified === false
        ? "unverified"
        : "unavailable";
  } catch {
    // No raw exceptions, URLs or DOM facts cross into diagnostics.
    return "unavailable";
  }
}
