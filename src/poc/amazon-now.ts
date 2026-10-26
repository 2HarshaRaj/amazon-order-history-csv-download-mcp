/// <reference lib="dom" />
import type { Frame, Locator, Page } from "playwright";
import { z } from "zod";
import { DiagnosticError } from "./failure-diagnostics";
import { parseHeaderTotalText } from "./order-total";
import type { OrderAdjustment } from "./hardened-index-v3";

const ID =
  /^(?:\d{3}-\d{7}-\d{7}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i;
const NOW_PATHS = [
  "/uff/your-account/order-details",
  "/tez/browse/orderTracking",
];
const TIMEOUT = 3000;

function fail(
  reason:
    | "DETAIL_ORDER_MISMATCH"
    | "DETAIL_TOTAL_INVALID"
    | "ITEM_FACTS_INVALID"
    | "ADJUSTMENT_AMOUNT_INVALID"
    | "ITEM_SHAPE_AMBIGUOUS" = "DETAIL_ORDER_MISMATCH",
): never {
  throw new DiagnosticError(
    reason.startsWith("ITEM")
      ? "items"
      : reason.startsWith("ADJUSTMENT")
        ? "adjustments"
        : "detail",
    reason,
    "Amazon Now source validation failed.",
  );
}

/** Exact, single identity on an allowlisted HTTPS route; never construct a Now URL. */
export function validateNowUrl(
  value: string,
  orderId: string,
  path?: string,
): string {
  try {
    const url = new URL(value);
    const ids = [...url.searchParams.entries()].filter(([key]) =>
      /^orderid$/i.test(key),
    );
    if (
      !ID.test(orderId) ||
      url.protocol !== "https:" ||
      !["www.amazon.in", "amazon.in"].includes(url.hostname) ||
      url.port ||
      url.username ||
      url.password ||
      url.hash ||
      !(path ? [path] : NOW_PATHS).includes(url.pathname) ||
      ids.length !== 1 ||
      ids[0][1] !== orderId
    )
      fail();
    return url.href;
  } catch {
    return fail();
  }
}

/** Only inspect details links in the selected card. Other orders never supply routes. */
export async function discoverNowLink(
  card: Locator,
  baseUrl: string,
  orderId: string,
): Promise<string | undefined> {
  const links = card.locator(
    'a[href*="/uff/your-account/order-details"], a[href*="/tez/browse/orderTracking"]',
  );
  const count = await links.count();
  if (count > 8) fail();
  const urls = new Set<string>();
  for (let index = 0; index < count; index++) {
    const link = links.nth(index);
    if (!(await link.isVisible())) continue;
    const href = await link.getAttribute("href", { timeout: TIMEOUT });
    if (!href) fail();
    // An unsupported Now details route is an error, never a conventional fallback.
    urls.add(validateNowUrl(new URL(href, baseUrl).href, orderId));
  }
  if (urls.size > 1) fail();
  return urls.values().next().value;
}

const snapshotSchema = z
  .object({
    orderIds: z.array(z.string().max(100)).length(1),
    billRows: z.array(z.string().min(1).max(200)).min(1).max(24),
    items: z
      .array(
        z
          .object({
            parts: z.array(z.string().min(1).max(500)).min(2).max(12),
            alts: z.array(z.string().max(500)).max(4),
            hrefs: z.array(z.string().max(1000)).max(4),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export type NowSnapshot = z.infer<typeof snapshotSchema>;

interface NowMoney {
  amount: number;
  currency: string;
  formatted: string;
}
export interface NowOrderDetail {
  orderId: string;
  orderTotal: NowMoney;
  orderTotalSource: "amazon-now-you-pay";
  extractionSource: "amazon-now-order-details";
  itemCount: number;
  items: Array<{
    asin: string;
    productName: string;
    quantity: number;
    unitPrice: NowMoney;
    itemTotal: NowMoney;
  }>;
  adjustments: OrderAdjustment[];
}

function money(text: string): {
  amount: number;
  currency: string;
  formatted: string;
} {
  const parsed = parseHeaderTotalText(`Total ${text}`);
  if (!parsed) fail("DETAIL_TOTAL_INVALID");
  return { amount: parsed.amount, currency: "INR", formatted: text };
}

/** Normalize only a display prefix; never repair any part of an identifier. */
export function normalizeNowDisplayedId(value: string): string {
  const normalized = value.startsWith("#")
    ? value.slice(1).replace(/^\s+/, "")
    : value;
  if (!ID.test(normalized)) fail();
  return normalized;
}

function explicitQuantity(value: string): number {
  const labeled = /^(?:qty|quantity)\s*:\s*([1-9]\d*)$/i.exec(value);
  const units =
    /^(?:\d+(?:\.\d+)?\s*(?:mg|g|kg|ml|l|litres?|liters?)\s*[·•|]\s*)?([1-9]\d*)\s+unit(?:s|\(s\))?$/i.exec(
      value,
    );
  const quantity = Number((labeled ?? units)?.[1]);
  if (!Number.isSafeInteger(quantity) || quantity < 1)
    fail("ITEM_FACTS_INVALID");
  return quantity;
}

/** Pure parser of bounded visible facts. Funding never enters this snapshot. */
export function parseNowSnapshot(
  input: unknown,
  orderId: string,
): NowOrderDetail {
  const result = snapshotSchema.safeParse(input);
  if (!result.success) fail("ITEM_SHAPE_AMBIGUOUS");
  const facts = result.data;
  if (
    !ID.test(orderId) ||
    normalizeNowDisplayedId(facts.orderIds[0]) !== orderId
  )
    fail();
  let orderTotal: ReturnType<typeof money> | undefined;
  const adjustments: OrderAdjustment[] = [];
  const labels = new Set<string>();
  for (const row of facts.billRows) {
    const pair = /^(.*?)\s*:?\s+((?:-\s*)?(?:₹|INR\b).+|Free)$/i.exec(row);
    if (!pair) fail("ADJUSTMENT_AMOUNT_INVALID");
    const label = pair[1].trim();
    const key = label.toLowerCase();
    if (labels.has(key)) fail("DETAIL_TOTAL_INVALID");
    labels.add(key);
    if (/^you pay$/i.test(label)) {
      orderTotal = money(pair[2]);
      continue;
    }
    if (/^(?:items? total|items? subtotal|subtotal)$/i.test(label)) {
      money(pair[2]); // Validate, but never promote a subtotal to billed total.
      continue;
    }
    // Only explicit additive fees and signed discounts are supported. Included,
    // refundable, estimated or otherwise qualified charges must fail closed.
    const fee = /^(handling|delivery|shipping) (?:fee|charge)s?$/i.exec(label);
    const discount = /^(discount|promotion(?: applied)?)$/i.test(label);
    if (!fee && !discount) fail("ADJUSTMENT_AMOUNT_INVALID");
    if (discount && !/^-\s*(?:₹|INR\b)/i.test(pair[2]))
      fail("ADJUSTMENT_AMOUNT_INVALID");
    if (fee && /^-/.test(pair[2])) fail("ADJUSTMENT_AMOUNT_INVALID");
    const amount =
      /^free$/i.test(pair[2]) && fee
        ? { amount: 0, currency: "INR", formatted: "Free" }
        : money(pair[2].replace(/^-\s*/, ""));
    if (amount.amount !== 0)
      adjustments.push({
        type: discount
          ? /^discount/i.test(label)
            ? "discount"
            : "promotion"
          : /^handling/i.test(label)
            ? "other"
            : "shipping",
        label,
        amount: {
          ...amount,
          amount: discount ? -amount.amount : amount.amount,
        },
        extractionSource: "amazon-now-bill-summary",
      });
  }
  if (!orderTotal) fail("DETAIL_TOTAL_INVALID");
  const seen = new Set<string>();
  const items = facts.items.map(({ parts, alts, hrefs }) => {
    const quantities = parts.filter((part) =>
      /^(?:qty|quantity)\s*:|\bunit(?:s|\(s\))?$/i.test(part),
    );
    if (quantities.length !== 1) fail("ITEM_FACTS_INVALID");
    const quantity = explicitQuantity(quantities[0]);
    const prices = parts.filter((part) => /₹|\bINR\b/i.test(part));
    const names = parts.filter(
      (part) => !quantities.includes(part) && !prices.includes(part),
    );
    if (names.length !== 1 || !names[0].trim()) fail("ITEM_FACTS_INVALID");
    let unitPrice: ReturnType<typeof money>;
    let itemTotal: ReturnType<typeof money>;
    if (quantity === 1 && prices.length === 1) {
      unitPrice = itemTotal = money(
        prices[0].replace(/^(?:unit price|item total|line total)\s*:\s*/i, ""),
      );
    } else {
      const units = prices.filter((part) => /^unit price\s*:/i.test(part));
      const totals = prices.filter((part) =>
        /^(?:item|line) total\s*:/i.test(part),
      );
      if (prices.length !== 2 || units.length !== 1 || totals.length !== 1)
        fail("ITEM_SHAPE_AMBIGUOUS");
      unitPrice = money(units[0].replace(/^unit price\s*:\s*/i, ""));
      itemTotal = money(totals[0].replace(/^(?:item|line) total\s*:\s*/i, ""));
      if (
        !Number.isSafeInteger(Math.round(unitPrice.amount * 100) * quantity) ||
        Math.abs(
          Math.round(unitPrice.amount * 100) * quantity -
            Math.round(itemTotal.amount * 100),
        ) > 1
      )
        fail("ITEM_SHAPE_AMBIGUOUS");
    }
    const identifiers = new Set(
      alts.filter((alt) => /^[A-Z0-9]{10}$/.test(alt)),
    );
    for (const href of hrefs) {
      const match =
        /^https:\/\/(?:www\.)?amazon\.in\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/.exec(
          href,
        );
      if (match) identifiers.add(match[1]);
    }
    if (identifiers.size > 1) fail("ITEM_FACTS_INVALID");
    const asin = identifiers.values().next().value ?? "";
    const productName = names[0];
    const key = `${asin}:${productName}`;
    if (seen.has(key)) fail("ITEM_SHAPE_AMBIGUOUS");
    seen.add(key);
    return { asin, productName, quantity, unitPrice, itemTotal };
  });
  const actualPaise = [
    ...items.map((item) => item.itemTotal.amount),
    ...adjustments.map((adjustment) => adjustment.amount?.amount ?? 0),
  ].reduce((sum, amount) => {
    const total = sum + Math.round(amount * 100);
    if (!Number.isSafeInteger(total)) fail("DETAIL_TOTAL_INVALID");
    return total;
  }, 0);
  if (Math.abs(actualPaise - Math.round(orderTotal.amount * 100)) > 1) {
    throw new DiagnosticError(
      "reconciliation",
      "TOTAL_MISMATCH",
      "Amazon Now order does not reconcile within one paise.",
    );
  }
  return {
    orderId,
    orderTotal,
    orderTotalSource: "amazon-now-you-pay" as const,
    extractionSource: "amazon-now-order-details",
    itemCount: items.length,
    items,
    adjustments,
  };
}

/** One bounded reader for independent tracking identity and the active sheet.
 * No Amazon CSS classes or positional price/quantity assumptions are used.
 */
async function readNowDom(
  anchor: Locator,
  orderId: string,
  mode: "tracking" | "dialog",
): Promise<NowSnapshot> {
  return anchor.evaluate(
    (anchor, { expected, mode }) => {
      const abort = (): never => {
        throw new Error("Unsupported Amazon Now presentation.");
      };
      let root: Element = anchor;
      const view = root.ownerDocument.defaultView;
      if (!view) return abort();
      const visible = (el: Element): boolean => {
        if (mode === "tracking" && el.closest('[role="dialog"]')) return false;
        for (let node: Element | null = el; node; node = node.parentElement) {
          const style = view.getComputedStyle(node);
          if (
            node.getAttribute("aria-hidden") === "true" ||
            node.hasAttribute("hidden") ||
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.visibility === "collapse" ||
            style.opacity === "0"
          )
            return false;
        }
        return el.getClientRects().length > 0;
      };
      const current = (el: Element): boolean => {
        for (let node: Element | null = el; node; node = node.parentElement) {
          if (
            ["S", "DEL", "STRIKE"].includes(node.tagName) ||
            view
              .getComputedStyle(node)
              .textDecorationLine.includes("line-through")
          )
            return false;
        }
        return visible(el);
      };
      const cache = new Map<Element, string>();
      const text = (el: Element): string => {
        const cached = cache.get(el);
        if (cached !== undefined) return cached;
        if (!current(el)) return "";
        const value = Array.from(el.childNodes)
          .map((node) =>
            node.nodeType === 3
              ? (node.textContent ?? "")
              : node.nodeType === 1
                ? text(node as Element)
                : "",
          )
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();
        if (value.length > 50000) return abort();
        cache.set(el, value);
        return value;
      };
      const elements = (scope: Element): Element[] => {
        const nodes = [scope, ...Array.from(scope.querySelectorAll("*"))];
        if (nodes.length > 5000) abort();
        return nodes;
      };
      const leaves = (scope: Element): Element[] =>
        elements(scope).filter((el) => {
          const value = text(el);
          return (
            value &&
            !Array.from(el.children).some((child) => text(child) === value)
          );
        });
      const exact = (scope: Element, pattern: RegExp): Element[] =>
        leaves(scope).filter((el) => pattern.test(text(el)));
      if (mode === "tracking") {
        // The chosen control and the labeled tracking identity must share a small
        // source region. A URL or a hidden sheet never supplies that identity.
        let found = false;
        for (let depth = 0; depth < 8; depth++) {
          if (["BODY", "HTML"].includes(root.tagName)) abort();
          if (exact(root, /^Order ID\b/i).length) {
            found = true;
            break;
          }
          const parent = root.parentElement;
          if (!parent) return abort();
          root = parent;
        }
        if (!found) abort();
      } else if (exact(root, /^Order Details$/i).length !== 1) abort();
      const nodes = elements(root);
      const owner = root.closest("[data-order-id]");
      if (owner && owner.getAttribute("data-order-id") !== expected) abort();
      if (
        nodes.some(
          (el) =>
            visible(el) &&
            el.hasAttribute("data-order-id") &&
            el.getAttribute("data-order-id") !== expected,
        )
      )
        abort();
      const identityRows = new Set<Element>();
      const wholeId = /^Order ID(?:\s*:\s*|\s+)(#?\s*\S+)$/i;
      for (const label of exact(root, /^Order ID\s*:?$/i)) {
        let scope: Element | null = label;
        for (
          let depth = 0;
          scope && depth < 5;
          depth++, scope = scope.parentElement
        ) {
          if (!root.contains(scope)) break;
          if (wholeId.test(text(scope))) {
            identityRows.add(scope);
            break;
          }
        }
        if (!scope || !identityRows.has(scope)) abort();
      }
      for (const el of exact(root, wholeId)) identityRows.add(el);
      const orderIds = [...identityRows].map(
        (el) => wholeId.exec(text(el))?.[1] ?? "",
      );
      if (orderIds.length !== 1) abort();
      if (mode === "tracking") return { orderIds, billRows: [], items: [] };
      if (
        exact(
          root,
          /\b(?:cancelled|canceled|refunded|refund pending|partially refunded)\b/i,
        ).length
      )
        abort();

      const headings = exact(root, /^Bill summary$/i);
      if (headings.length !== 1) abort();
      let bill: Element | null = headings[0].parentElement;
      for (
        let depth = 0;
        bill && bill !== root && depth < 6;
        depth++, bill = bill.parentElement
      ) {
        if (exact(bill, /^You pay\b/i).length) break;
      }
      if (
        !bill ||
        bill === root ||
        /\bPayment(?: method| details| information)?\b/i.test(text(bill))
      )
        return abort();
      const billRoot = bill;
      const billLabel =
        /^(You pay|Items? total|Items? subtotal|Subtotal|Handling (?:fee|charge)s?|Delivery (?:fee|charge)s?|Shipping (?:fee|charge)s?|Discount|Promotion(?: applied)?)(?=\s|:|$)/i;
      const labelCandidates = leaves(billRoot).filter((el) =>
        billLabel.test(text(el)),
      );
      const labels = labelCandidates.filter(
        (el) =>
          !labelCandidates.some((child) => child !== el && el.contains(child)),
      );
      const billRegions = new Set<Element>();
      const billRows = labels.map((label) => {
        const name = billLabel.exec(text(label))?.[1];
        if (!name) return abort();
        let scope: Element | null = label;
        for (
          let depth = 0;
          scope && scope !== billRoot && depth < 5;
          depth++, scope = scope.parentElement
        ) {
          if (/₹|\bINR\b|\bFree\b/i.test(text(scope))) break;
        }
        if (
          !scope ||
          scope === billRoot ||
          labels.filter((el) => scope?.contains(el)).length !== 1
        )
          return abort();
        const row = scope;
        if (
          [...billRegions].some(
            (other) => row.contains(other) || other.contains(row),
          )
        )
          return abort();
        billRegions.add(row);
        let value = text(row)
          .slice(name.length)
          .replace(/^\s*:\s*/, "")
          .trim();
        const subtitles = value.match(/\bInclusive of taxes\b/gi) ?? [];
        if (subtitles.length) {
          if (!/^You pay$/i.test(name) || subtitles.length !== 1)
            return abort();
          value = value
            .replace(/\bInclusive of taxes\b/i, "")
            .replace(/\s+/g, " ")
            .trim();
        }
        return `${name} ${value}`;
      });
      // Every current bill fact must belong to one recognized row or its heading.
      // Unknown charges, standalone values and tender rows cannot disappear.
      const uncovered = (el: Element): string => {
        if (!current(el) || billRegions.has(el) || el === headings[0])
          return "";
        return Array.from(el.childNodes)
          .map((node) =>
            node.nodeType === 3
              ? (node.textContent ?? "")
              : node.nodeType === 1
                ? uncovered(node as Element)
                : "",
          )
          .join(" ")
          .trim();
      };
      if (uncovered(billRoot)) abort();

      const quantitySignal = /^(?:qty|quantity)\s*:|\bunit(?:s|\(s\))?$/i;
      const quantityField =
        /^(?:(?:qty|quantity)\s*:\s*\d+|(?:\d+(?:\.\d+)?\s*(?:mg|g|kg|ml|l|litres?|liters?)\s*[·•|]\s*)?\d+\s+unit(?:s|\(s\))?)$/i;
      const productLink = 'a[href*="/dp/"], a[href*="/gp/product/"]';
      const nonItemHeadings = exact(
        root,
        /^(?:Payment(?: (?:method|details|information))?|Delivery status|Order status|Status)$/i,
      );
      const nonItemRoots = [
        ...nonItemHeadings,
        ...nodes.filter(
          (el) => el.getAttribute("role") === "status" && visible(el),
        ),
      ].map((heading) => {
        const semantic = heading.closest(
          'section, [role="group"], [role="status"]',
        );
        const scope =
          semantic && semantic !== root ? semantic : heading.parentElement;
        if (
          !scope ||
          scope === root ||
          scope.contains(billRoot) ||
          exact(scope, quantitySignal).length ||
          Array.from(scope.querySelectorAll(productLink)).some(visible) ||
          Array.from(scope.querySelectorAll("img")).some(
            (image) =>
              visible(image) &&
              /^[A-Z0-9]{10}$/.test(image.getAttribute("alt") ?? ""),
          )
        )
          return abort();
        return scope;
      });
      nonItemRoots.push(billRoot);
      const excluded = (el: Element): boolean =>
        nonItemRoots.some((scope) => scope.contains(el));
      const images = nodes.filter(
        (el) =>
          el.tagName === "IMG" &&
          visible(el) &&
          !excluded(el) &&
          el.getAttribute("role") !== "presentation",
      );
      const productLinks = nodes.filter(
        (el) => el.matches(productLink) && visible(el) && !excluded(el),
      );
      const quantityCandidates = exact(root, quantitySignal).filter(
        (el) => !excluded(el),
      );
      const quantities = quantityCandidates.filter(
        (el) =>
          !quantityCandidates.some(
            (child) => child !== el && el.contains(child),
          ),
      );
      if (!quantities.length || quantities.length > 100 || images.length > 100)
        abort();
      const itemRoots = new Set<Element>();
      for (const quantity of quantities) {
        let scope: Element | null = quantity;
        for (
          let depth = 0;
          scope && scope !== root && depth < 7;
          depth++, scope = scope.parentElement
        ) {
          if (quantities.filter((el) => scope?.contains(el)).length !== 1)
            abort();
          if (images.filter((el) => scope?.contains(el)).length > 1) abort();
          if (
            /₹|\bINR\b/.test(text(scope)) &&
            (images.some((el) => scope?.contains(el)) ||
              productLinks.some((el) => scope?.contains(el)))
          )
            break;
        }
        if (
          !scope ||
          scope === root ||
          excluded(scope) ||
          nonItemRoots.some((other) => scope?.contains(other))
        )
          return abort();
        if (
          [...itemRoots].some(
            (other) => scope?.contains(other) || other.contains(scope),
          )
        )
          return abort();
        itemRoots.add(scope);
      }
      const merchandiseEvidence = [...images, ...productLinks];
      const priceCandidates = exact(root, /₹|\bINR\b/i).filter(
        (el) => !excluded(el),
      );
      // An incomplete row must not disappear just because its image is marked
      // presentational or missing. Every remaining current price needs an owner.
      merchandiseEvidence.push(
        ...priceCandidates.filter(
          (el) =>
            !priceCandidates.some(
              (child) => child !== el && el.contains(child),
            ),
        ),
      );
      if (
        merchandiseEvidence.some(
          (el) => [...itemRoots].filter((row) => row.contains(el)).length !== 1,
        )
      )
        abort();
      const amount = /^(?:-\s*)?(?:₹|INR\s*)\s*[\d,]+(?:\.\d{1,2})?$/i;
      // Complete fields, or a currency node paired only with its adjacent numeric
      // sibling in the same parent. No cross-row flattening/pairing is allowed.
      const fields = (el: Element): string[] => {
        const value = text(el);
        if (!value) return [];
        if (
          amount.test(value) ||
          quantityField.test(value) ||
          /^(?:unit price|item total|line total)\s*:\s*(?:₹|INR\s*)\s*[\d,.]+$/i.test(
            value,
          ) ||
          !/₹|\bINR\b|\b(?:qty|quantity)\s*:|\b\d+\s+units?\b/i.test(value)
        )
          return [value];
        const children = Array.from(el.childNodes);
        const parts: string[] = [];
        for (let index = 0; index < children.length; index++) {
          const node = children[index];
          const part =
            node.nodeType === 3
              ? (node.textContent ?? "").trim()
              : node.nodeType === 1
                ? text(node as Element)
                : "";
          if (!part) continue;
          if (/^(?:-\s*)?(?:₹|INR)$/i.test(part)) {
            // Whitespace-only text nodes may separate adjacent rendered elements.
            let next = index + 1;
            while (
              next < children.length &&
              children[next].nodeType === 3 &&
              !children[next].textContent?.trim()
            )
              next++;
            const sibling = children[next];
            const number =
              sibling?.nodeType === 3
                ? (sibling.textContent?.trim() ?? "")
                : sibling?.nodeType === 1
                  ? text(sibling as Element)
                  : "";
            if (!/^[\d,]+(?:\.\d{1,2})?$/.test(number)) return abort();
            parts.push(`${part}${number}`);
            index = next;
          } else if (node.nodeType === 1)
            parts.push(...fields(node as Element));
          else parts.push(part);
        }
        return parts;
      };
      const items = [...itemRoots].map((row) => ({
        parts: fields(row),
        alts: images
          .filter((el) => row.contains(el))
          .map((el) => el.getAttribute("alt") ?? ""),
        hrefs: Array.from(row.querySelectorAll("a[href]"))
          .filter(visible)
          .map(
            (el) =>
              new URL(el.getAttribute("href") ?? "", root.ownerDocument.URL)
                .href,
          ),
      }));
      return { orderIds, billRows, items };
    },
    { expected: orderId, mode },
    { timeout: TIMEOUT },
  );
}

export async function extractNowOrder(
  page: Page,
  orderId: string,
  outerUrl: string,
  authenticate: () => Promise<void>,
): Promise<NowOrderDetail> {
  let invalidNavigation = false;
  // Observe only committed main-frame URLs, never requests, responses or tender
  // traffic. Intermediate UFF/tracking pages must retain the selected identity.
  const checkNavigation = (frame: Frame): void => {
    if (frame !== page.mainFrame()) return;
    try {
      const url = new URL(frame.url());
      if (
        url.protocol === "https:" &&
        ["www.amazon.in", "amazon.in"].includes(url.hostname) &&
        /^\/ap\/(?:signin|cvf)(?:\/|$)/.test(url.pathname)
      )
        return;
      validateNowUrl(frame.url(), orderId);
    } catch {
      invalidNavigation = true;
    }
  };
  try {
    validateNowUrl(outerUrl, orderId);
    page.on("framenavigated", checkNavigation);
    await page.goto(outerUrl, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    if (invalidNavigation) fail();
    await authenticate();
    await page.waitForURL(
      (url) =>
        url.pathname === "/tez/browse/orderTracking" ||
        /^\/ap\/(?:signin|cvf)(?:\/|$)/.test(url.pathname),
      { timeout: 5000 },
    );
    if (invalidNavigation) fail();
    await authenticate();
    validateNowUrl(page.url(), orderId, "/tez/browse/orderTracking");
    const dialogs = page
      .locator('[role="dialog"]:visible')
      .filter({ has: page.getByText(/^Order Details$/i) });
    // Never adopt a pre-existing sheet. A single explicit click must open it.
    if (await dialogs.count()) fail();
    const controls = page
      .getByText(/^View order details$/i)
      .filter({ visible: true });
    await controls.first().waitFor({ state: "visible", timeout: TIMEOUT });
    if ((await controls.count()) !== 1) fail();
    const trackingFacts = await readNowDom(controls, orderId, "tracking");
    if (
      trackingFacts.orderIds.length !== 1 ||
      normalizeNowDisplayedId(trackingFacts.orderIds[0]) !== orderId
    )
      fail();
    validateNowUrl(page.url(), orderId, "/tez/browse/orderTracking");
    if (
      invalidNavigation ||
      (await controls.count()) !== 1 ||
      (await dialogs.count())
    )
      fail();
    await controls.click({ timeout: TIMEOUT });
    await dialogs.first().waitFor({ state: "visible", timeout: TIMEOUT });
    if (invalidNavigation || (await dialogs.count()) !== 1) fail();
    const facts = await readNowDom(dialogs.first(), orderId, "dialog");
    if (invalidNavigation || (await dialogs.count()) !== 1) fail();
    validateNowUrl(page.url(), orderId, "/tez/browse/orderTracking");
    return parseNowSnapshot(facts, orderId);
  } catch (error) {
    // A sign-in redirect after the click must preserve manual-authentication
    // lifecycle behavior, including leaving the dedicated window open.
    const currentUrl = new URL(page.url());
    if (
      currentUrl.protocol === "https:" &&
      ["www.amazon.in", "amazon.in"].includes(currentUrl.hostname) &&
      /^\/ap\/(?:signin|cvf)(?:\/|$)/.test(currentUrl.pathname)
    )
      await authenticate();
    if (
      error instanceof DiagnosticError ||
      (error instanceof Error && error.name === "AuthenticationRequiredError")
    )
      throw error;
    // Playwright errors can contain raw DOM and URLs. Keep them out of MCP/logs.
    throw new DiagnosticError(
      "detail",
      "NOW_EXTRACTION_FAILED",
      "Amazon Now extraction could not validate all required facts.",
    );
  } finally {
    page.off("framenavigated", checkNavigation);
  }
}
