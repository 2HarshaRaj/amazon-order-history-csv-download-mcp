/// <reference lib="dom" />
import type { Frame, Locator, Page } from "playwright";
import { z } from "zod";
import {
  DiagnosticError,
  FailureDiagnostics,
  NOW_CHECKPOINTS,
  NOW_DOM_FAILURES,
} from "./failure-diagnostics";
import { parseHeaderTotalText } from "./order-total";
import type { OrderAdjustment } from "./hardened-index-v3";

const ID =
  /^(?:\d{3}-\d{7}-\d{7}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/i;
const NOW_PATHS = [
  "/uff/your-account/order-details",
  "/tez/browse/orderTracking",
];
const TIMEOUT = 3000;
// Discovery stays conservative: malformed/duplicate quantity signals must not
// disappear. Only this complete grammar may supply the purchased count.
const QUANTITY_SIGNAL = /^(?:qty|quantity)\s*:|\bunit(?:s|\(s\))?$/i;
const QUANTITY_FIELD =
  /^(?:(?:qty|quantity)\s*:\s*(\d+)|(?:(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)\s*(?:mg|g|kg|ml|l|litres?|liters?)\s*[·•|]\s*)?(\d+)\s+unit(?:s|\(s\))?)$/i;
// Exact approximate-weight qualifier, ASCII range hyphen, one known separator.
// Weight endpoints are package metadata; only capture 3 supplies purchased units.
const APPROX_QUANTITY_FIELD =
  /^Approx\.\s*\(\s*((?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*))\s*-\s*((?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*))\s*g\s*\)\s*[.·•]\s*([1-9]\d*)\s+unit(?:s|\(s\))?$/;
type NowCheckpoint = (typeof NOW_CHECKPOINTS)[number];
function checkpoint(
  trace: FailureDiagnostics | undefined,
  code: NowCheckpoint,
): void {
  trace?.at("detail", code);
  trace?.note("detail", code);
}

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
  const match = QUANTITY_FIELD.exec(value);
  const approximate = APPROX_QUANTITY_FIELD.exec(value);
  if (approximate) {
    // Compare positive decimal strings exactly, without rounding large or close
    // endpoints into a different range. Never convert either endpoint to quantity.
    const [lower, lowerFraction = ""] = approximate[1].split(".");
    const [upper, upperFraction = ""] = approximate[2].split(".");
    const precision = Math.max(lowerFraction.length, upperFraction.length);
    const increasing =
      lower.length !== upper.length
        ? lower.length < upper.length
        : lower !== upper
          ? lower < upper
          : lowerFraction.padEnd(precision, "0") <
            upperFraction.padEnd(precision, "0");
    if (!increasing) fail("ITEM_FACTS_INVALID");
  }
  const count = match?.[1] ?? match?.[2] ?? approximate?.[3];
  if (!count || !/^[1-9]\d*$/.test(count)) fail("ITEM_FACTS_INVALID");
  const quantity = Number(count);
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
    const quantities = parts.filter((part) => QUANTITY_SIGNAL.test(part));
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
  trace?: FailureDiagnostics,
): Promise<NowSnapshot> {
  const result = await anchor.evaluate(
    (
      anchor,
      {
        expected,
        mode,
        quantitySignalSource,
        quantityFieldSource,
        approximateQuantityFieldSource,
      },
    ) => {
      type DomReason = (typeof NOW_DOM_FAILURES)[number];
      type DomCheckpoint =
        | "NOW_DIALOG_IDENTITY"
        | "NOW_BILL_SUMMARY"
        | "NOW_ITEMS_FEES";
      const checkpoints: DomCheckpoint[] = [];
      let reason: DomReason = "NOW_DOM_BOUNDS_INVALID";
      class DomValidationFailure {
        constructor(readonly reason: DomReason) {}
      }
      const abort = (code: DomReason = reason): never => {
        throw new DomValidationFailure(code);
      };
      const read = (): NowSnapshot => {
        let root: Element = anchor;
        const view = root.ownerDocument.defaultView;
        if (!view) return abort();
        const rendered = (el: Element, merchandisePrice = false): boolean => {
          if (mode === "tracking" && el.closest('[role="dialog"]'))
            return false;
          for (let node: Element | null = el; node; node = node.parentElement) {
            const style = view.getComputedStyle(node);
            if (
              (!merchandisePrice &&
                node.getAttribute("aria-hidden") === "true") ||
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
        const visible = (el: Element): boolean => rendered(el);
        const current = (el: Element, merchandisePrice = false): boolean => {
          for (let node: Element | null = el; node; node = node.parentElement) {
            if (
              ["S", "DEL", "STRIKE"].includes(node.tagName) ||
              view
                .getComputedStyle(node)
                .textDecorationLine.includes("line-through")
            )
              return false;
          }
          return rendered(el, merchandisePrice);
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
          if (value.length > 50000) return abort("NOW_DOM_BOUNDS_INVALID");
          cache.set(el, value);
          return value;
        };
        const elements = (scope: Element): Element[] => {
          const nodes = [scope, ...Array.from(scope.querySelectorAll("*"))];
          if (nodes.length > 5000) abort("NOW_DOM_BOUNDS_INVALID");
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
        reason =
          mode === "tracking"
            ? "NOW_TRACKING_IDENTITY_INVALID"
            : "NOW_DIALOG_IDENTITY_INVALID";
        if (mode === "dialog") checkpoints.push("NOW_DIALOG_IDENTITY");
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
        reason = "NOW_ORDER_STATUS_UNSUPPORTED";
        if (
          exact(
            root,
            /\b(?:cancelled|canceled|refunded|refund pending|partially refunded)\b/i,
          ).length
        )
          abort();

        checkpoints.push("NOW_BILL_SUMMARY");
        reason = "NOW_BILL_SUMMARY_INVALID";
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
        reason = "NOW_BILL_ROW_INVALID";
        const billLabel =
          /^(You pay|Items? total|Items? subtotal|Subtotal|Handling (?:fee|charge)s?|Delivery (?:fee|charge)s?|Shipping (?:fee|charge)s?|Discount|Promotion(?: applied)?)(?=\s|:|$)/i;
        const labelCandidates = leaves(billRoot).filter((el) =>
          billLabel.test(text(el)),
        );
        const labels = labelCandidates.filter(
          (el) =>
            !labelCandidates.some(
              (child) => child !== el && el.contains(child),
            ),
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
            if (/₹|\bINR\b|\bFree\b(?!\s+for\b)/i.test(text(scope))) break;
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
          const explanations = exact(row, /^Free for$/i);
          if (explanations.length) {
            // A separate annotation/icon group is not an effective fee value.
            // Never strip amounts, or accept an annotation in place of a charge.
            if (
              !/^Handling (?:fee|charge)s?$/i.test(name) ||
              explanations.length !== 1 ||
              (value.match(/\bFree for\b/gi) ?? []).length !== 1
            )
              return abort();
            let annotation: Element | null = explanations[0];
            let bounded = false;
            for (
              let depth = 0;
              annotation && annotation !== row && depth < 3;
              depth++, annotation = annotation.parentElement
            ) {
              if (!/^Free for$/i.test(text(annotation))) break;
              if (annotation.querySelectorAll("img, svg").length === 1) {
                bounded = true;
                break;
              }
            }
            if (!bounded) return abort();
            value = value
              .replace(/\bFree for\b/i, "")
              .replace(/\s+/g, " ")
              .trim();
          }
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

        checkpoints.push("NOW_ITEMS_FEES");
        reason = "NOW_ITEM_OWNERSHIP_INVALID";
        const quantitySignal = new RegExp(quantitySignalSource, "i");
        const quantityField = new RegExp(quantityFieldSource, "i");
        const approximateQuantityField = new RegExp(
          approximateQuantityFieldSource,
        );
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
            return abort("NOW_NON_ITEM_REGION_INVALID");
          return scope;
        });
        // A heading/role is not required for an isolated delivery-time decoration.
        // Only a complete delivery message plus one icon may form this region;
        // item/list boundaries and any financial/product evidence disqualify it.
        const deliveryMessage =
          /^(?:Order\s+)?delivered\s+in\s+[1-9]\d*\s+(?:min(?:ute)?s?|h(?:ou)?rs?)(?:\s+(?:and\s+)?\d+\s+min(?:ute)?s?)?$/i;
        const merchandiseBoundary = "article, li, [role=list], [role=listitem]";
        const directText = (el: Element): boolean =>
          Array.from(el.childNodes).some(
            (node) => node.nodeType === 3 && node.textContent?.trim(),
          );
        // These additional exclusions require the observed minimal structures.
        // Inspect all images/raw text too: hidden, historical or product evidence
        // must not disappear while establishing a non-merchandise boundary.
        const isolatedIcon = (scope: Element): boolean => {
          const icons = Array.from(scope.querySelectorAll("img"));
          return (
            current(scope) &&
            !scope.closest(merchandiseBoundary) &&
            !scope.querySelector(merchandiseBoundary) &&
            !scope.contains(billRoot) &&
            !scope.closest(productLink) &&
            !scope.querySelector(productLink) &&
            !scope.querySelector(
              "button, [role=button], a, input, select, textarea",
            ) &&
            !/₹|\bINR\b|[$€£¥]|\b(?:qty|quantity)\s*:|\bunit(?:s|\(s\))?\b/i.test(
              scope.textContent ?? "",
            ) &&
            icons.length === 1 &&
            current(icons[0]) &&
            !/\b[A-Z0-9]{10}\b|₹|\bINR\b|[$€£¥]/.test(
              icons[0].getAttribute("alt") ?? "",
            ) &&
            !Array.from(scope.querySelectorAll("*")).some(
              (el) => el.textContent?.trim() && !current(el),
            )
          );
        };
        const allQuantities = exact(root, quantitySignal);
        const chromeControls = nodes.filter((button) => {
          if (
            button.tagName !== "BUTTON" ||
            button.textContent?.trim() ||
            button.children.length !== 1 ||
            !isolatedIcon(button)
          )
            return false;
          const iconWrapper = button.children[0];
          const frame = button.parentElement;
          if (
            iconWrapper.tagName !== "DIV" ||
            iconWrapper.children.length !== 1 ||
            iconWrapper.children[0].tagName !== "IMG" ||
            !frame ||
            frame === root ||
            frame.tagName !== "DIV" ||
            frame.closest(merchandiseBoundary) ||
            frame.children.length !== 2 ||
            directText(frame)
          )
            return false;
          const content = Array.from(frame.children).find(
            (el) => el !== button,
          );
          return (
            content?.tagName === "DIV" &&
            content.contains(billRoot) &&
            allQuantities.length > 0 &&
            allQuantities.every((quantity) => content.contains(quantity))
          );
        });
        // Multiple matching controls are ambiguous; leave every image owned by
        // the normal merchandise checks rather than choosing one by position.
        if (chromeControls.length === 1) nonItemRoots.push(chromeControls[0]);

        const arrivalMessage =
          /^arrived\s+at\s+(?:0?[1-9]|1[0-2]):[0-5]\d\s+(?:am|pm)$/i;
        for (const message of exact(root, deliveryMessage)) {
          const itemAncestor = message.closest(merchandiseBoundary);
          if (itemAncestor && root.contains(itemAncestor)) continue;
          const timing = message.parentElement;
          const decoration = timing?.parentElement;
          if (
            /^delivered\s+in\s+[1-9]\d*\s+minutes$/i.test(text(message)) &&
            message.children.length === 0 &&
            timing?.tagName === "DIV" &&
            timing.children.length === 2 &&
            timing.children[0] === message &&
            timing.children[1].children.length === 0 &&
            arrivalMessage.test(text(timing.children[1])) &&
            !directText(timing) &&
            decoration &&
            decoration !== root &&
            decoration.tagName === "DIV" &&
            decoration.children.length === 2 &&
            decoration.children[0].tagName === "IMG" &&
            decoration.children[1] === timing &&
            !directText(decoration) &&
            isolatedIcon(decoration)
          ) {
            nonItemRoots.push(decoration);
            continue;
          }
          let scope: Element | null = message;
          for (
            let depth = 0;
            scope && scope !== root && depth < 4;
            depth++, scope = scope.parentElement
          ) {
            if (text(scope) !== text(message)) break;
            const icons = Array.from(scope.querySelectorAll("img")).filter(
              visible,
            );
            if (
              icons.length !== 1 ||
              scope.contains(billRoot) ||
              scope.querySelector(merchandiseBoundary) ||
              scope.querySelector(productLink) ||
              Array.from(scope.querySelectorAll("*")).some(
                (el) => el.textContent?.trim() && !current(el),
              ) ||
              /^[A-Z0-9]{10}$/.test(icons[0].getAttribute("alt") ?? "")
            )
              continue;
            nonItemRoots.push(scope);
            break;
          }
        }
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
        if (
          !quantities.length ||
          quantities.length > 100 ||
          images.length > 100
        )
          abort(
            !quantities.length
              ? "NOW_ITEM_QUANTITY_MISSING"
              : "NOW_ITEM_EVIDENCE_EXCESSIVE",
          );
        // Accessibility-hidden price components may still be visually rendered.
        // Keep the exception confined to adjacent currency/number elements. They
        // remain candidates until both have exactly one common merchandise owner.
        const visualCache = new Map<Element, string>();
        const visualPriceText = (el: Element): string => {
          const cached = visualCache.get(el);
          if (cached !== undefined) return cached;
          if (excluded(el) || !current(el, true)) return "";
          const value = Array.from(el.childNodes)
            .map((node) =>
              node.nodeType === 3
                ? (node.textContent ?? "")
                : node.nodeType === 1
                  ? visualPriceText(node as Element)
                  : "",
            )
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
          if (value.length > 50000) return abort("NOW_DOM_BOUNDS_INVALID");
          visualCache.set(el, value);
          return value;
        };
        const priceOverrides = new Map<Element, string>();
        const priceAncestors = new Set<Element>();
        const priceValidationRoots = new Set<Element>();
        const renderedPairs: Array<{ currency: Element; number: Element }> = [];
        const rowBoundary = "article, li, [role=listitem]";
        for (const currency of nodes) {
          if (
            excluded(currency) ||
            !/^(?:-\s*)?(?:₹|INR)$/i.test(visualPriceText(currency))
          )
            continue;
          let sibling = currency.nextSibling;
          while (sibling?.nodeType === 3 && !sibling.textContent?.trim())
            sibling = sibling.nextSibling;
          if (!sibling || sibling.nodeType !== 1) continue;
          const number = sibling as Element;
          const numeric = visualPriceText(number);
          if (!/^[\d,]+(?:\.\d{1,2})?$/.test(numeric)) continue;
          if (current(currency) && current(number)) continue; // Existing strict reader.
          if (currency.closest(rowBoundary) !== number.closest(rowBoundary))
            abort("NOW_ITEM_FIELDS_INVALID");
          const parent = currency.parentElement;
          if (!parent || excluded(number))
            return abort("NOW_ITEM_FIELDS_INVALID");
          const symbol = visualPriceText(currency);
          const value = `${symbol}${/INR$/i.test(symbol) ? " " : ""}${numeric}`;
          if (!current(parent)) {
            // A hidden field may contain one price and an explicit price label.
            // No qualifiers, other amounts, names or quantities may be discarded.
            const field =
              /^(?:(unit price|item total|line total)\s*:\s*)?((?:-\s*)?(?:₹|INR)\s*[\d,]+(?:\.\d{1,2})?)$/i.exec(
                visualPriceText(parent),
              );
            if (!field) return abort("NOW_ITEM_FIELDS_INVALID");
            priceOverrides.set(
              parent,
              field[1] ? `${field[1]}: ${value}` : value,
            );
          } else {
            priceOverrides.set(currency, value);
            priceOverrides.set(number, "");
          }
          renderedPairs.push({ currency, number });
          if (renderedPairs.length > 200) abort("NOW_DOM_BOUNDS_INVALID");
          priceValidationRoots.add(parent);
          for (
            let ancestor: Element | null = parent;
            ancestor && root.contains(ancestor);
            ancestor = ancestor.parentElement
          ) {
            priceAncestors.add(ancestor);
            if (!current(ancestor)) priceValidationRoots.add(ancestor);
          }
        }
        const uncoveredPriceText = (el: Element): string => {
          if (!current(el, true) || priceOverrides.has(el)) return "";
          return Array.from(el.childNodes)
            .map((node) =>
              node.nodeType === 3
                ? current(el)
                  ? ""
                  : (node.textContent ?? "")
                : node.nodeType === 1
                  ? uncoveredPriceText(node as Element)
                  : "",
            )
            .join(" ")
            .trim();
        };
        for (const scope of priceValidationRoots)
          if (uncoveredPriceText(scope)) abort("NOW_ITEM_FIELDS_INVALID");
        // An unsupported rendered currency fact must not vanish behind aria-hidden.
        for (const el of nodes) {
          if (
            excluded(el) ||
            current(el) ||
            !/₹|\bINR\b/i.test(visualPriceText(el))
          )
            continue;
          if (
            Array.from(el.children).some((child) =>
              /₹|\bINR\b/i.test(visualPriceText(child)),
            )
          )
            continue;
          let covered: Element | null = el;
          while (covered && !priceOverrides.has(covered) && covered !== root)
            covered = covered.parentElement;
          if (!covered || !priceOverrides.has(covered))
            abort("NOW_ITEM_FIELDS_INVALID");
        }
        const itemCache = new Map<Element, string>();
        const itemText = (el: Element): string => {
          if (priceOverrides.has(el)) return priceOverrides.get(el) ?? "";
          const cached = itemCache.get(el);
          if (cached !== undefined) return cached;
          if (!current(el) && !priceAncestors.has(el)) return "";
          const value = Array.from(el.childNodes)
            .map((node) =>
              node.nodeType === 3
                ? current(el)
                  ? (node.textContent ?? "")
                  : ""
                : node.nodeType === 1
                  ? itemText(node as Element)
                  : "",
            )
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
          if (value.length > 50000) return abort("NOW_DOM_BOUNDS_INVALID");
          itemCache.set(el, value);
          return value;
        };
        const itemRoots = new Set<Element>();
        for (const quantity of quantities) {
          let scope: Element | null = quantity;
          for (
            let depth = 0;
            scope && scope !== root && depth < 7;
            depth++, scope = scope.parentElement
          ) {
            if (quantities.filter((el) => scope?.contains(el)).length !== 1)
              abort("NOW_ITEM_QUANTITY_AMBIGUOUS");
            if (images.filter((el) => scope?.contains(el)).length > 1)
              abort("NOW_ITEM_IMAGE_AMBIGUOUS");
            if (
              /₹|\bINR\b/.test(itemText(scope)) &&
              (images.some((el) => scope?.contains(el)) ||
                productLinks.some((el) => scope?.contains(el)))
            ) {
              const boundary = quantity.closest(rowBoundary);
              if (
                renderedPairs.some((pair) => scope?.contains(pair.currency)) &&
                boundary &&
                root.contains(boundary) &&
                !boundary.contains(scope)
              )
                abort("NOW_ITEM_BOUNDARY_INVALID");
              break;
            }
          }
          if (
            !scope ||
            scope === root ||
            excluded(scope) ||
            nonItemRoots.some((other) => scope?.contains(other))
          )
            return abort("NOW_ITEM_BOUNDARY_INVALID");
          if (
            [...itemRoots].some(
              (other) => scope?.contains(other) || other.contains(scope),
            )
          )
            return abort("NOW_ITEM_ROWS_OVERLAP");
          itemRoots.add(scope);
        }
        const merchandiseEvidence = [...images, ...productLinks];
        const priceCandidates = nodes.filter(
          (el) => !excluded(el) && /₹|\bINR\b/i.test(itemText(el)),
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
        // Preserve the existing evidence order and exact ownership predicate.
        // Classify only the first rejection; no page-derived fact is reported.
        const unowned = merchandiseEvidence.find(
          (el) => [...itemRoots].filter((row) => row.contains(el)).length !== 1,
        );
        if (unowned)
          abort(
            images.includes(unowned)
              ? "NOW_ITEM_IMAGE_OWNER_INVALID"
              : productLinks.includes(unowned)
                ? "NOW_ITEM_LINK_OWNER_INVALID"
                : "NOW_ITEM_PRICE_OWNER_INVALID",
          );
        for (const pair of renderedPairs)
          if (
            [...itemRoots].filter(
              (row) => row.contains(pair.currency) && row.contains(pair.number),
            ).length !== 1
          )
            abort("NOW_ITEM_PRICE_OWNER_INVALID");
        const amount = /^(?:-\s*)?(?:₹|INR\s*)\s*[\d,]+(?:\.\d{1,2})?$/i;
        reason = "NOW_ITEM_FIELDS_INVALID";
        // Complete fields, or a currency node paired only with its adjacent numeric
        // sibling in the same parent. No cross-row flattening/pairing is allowed.
        const fields = (el: Element): string[] => {
          const value = itemText(el);
          if (!value) return [];
          if (
            amount.test(value) ||
            quantityField.test(value) ||
            approximateQuantityField.test(value) ||
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
                  ? itemText(node as Element)
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
                    ? itemText(sibling as Element)
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
      };
      try {
        return { facts: read(), checkpoints };
      } catch (error) {
        if (error instanceof DomValidationFailure)
          return { failure: error.reason, checkpoints };
        // Unknown DOM errors must never cross the browser boundary with content.
        return { unexpected: true, checkpoints };
      }
    },
    {
      expected: orderId,
      mode,
      quantitySignalSource: QUANTITY_SIGNAL.source,
      quantityFieldSource: QUANTITY_FIELD.source,
      approximateQuantityFieldSource: APPROX_QUANTITY_FIELD.source,
    },
    { timeout: TIMEOUT },
  );
  // Only fixed enums cross into diagnostics. Never inspect Playwright messages.
  for (const code of z
    .array(z.enum(NOW_CHECKPOINTS))
    .max(3)
    .parse(result.checkpoints))
    checkpoint(trace, code);
  if (result.unexpected)
    throw new DiagnosticError(
      "detail",
      result.checkpoints.at(-1) ??
        (mode === "tracking" ? "NOW_TRACKING_IDENTITY" : "NOW_DIALOG_IDENTITY"),
      "Amazon Now DOM read failed.",
      "operation-failed",
    );
  if (result.failure !== undefined) {
    const code = z.enum(NOW_DOM_FAILURES).parse(result.failure);
    throw new DiagnosticError(
      "detail",
      code,
      "Amazon Now DOM validation failed.",
    );
  }
  if (!result.facts)
    throw new DiagnosticError(
      "detail",
      "NOW_EXTRACTION_FAILED",
      "Amazon Now DOM read failed.",
    );
  return result.facts;
}

export async function extractNowOrder(
  page: Page,
  orderId: string,
  outerUrl: string,
  authenticate: () => Promise<void>,
  trace?: FailureDiagnostics,
): Promise<NowOrderDetail> {
  let invalidNavigation = false;
  let phase: NowCheckpoint = "NOW_NAVIGATION";
  const at = (code: NowCheckpoint): void => {
    phase = code;
    checkpoint(trace, code);
  };
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
    at("NOW_NAVIGATION");
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
    at("NOW_DETAILS_CONTROL");
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
    at("NOW_TRACKING_IDENTITY");
    const trackingFacts = await readNowDom(
      controls,
      orderId,
      "tracking",
      trace,
    );
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
    at("NOW_DIALOG_OPEN");
    await controls.click({ timeout: TIMEOUT });
    await dialogs.first().waitFor({ state: "visible", timeout: TIMEOUT });
    if (invalidNavigation || (await dialogs.count()) !== 1) fail();
    at("NOW_DIALOG_IDENTITY");
    const facts = await readNowDom(dialogs.first(), orderId, "dialog", trace);
    if (invalidNavigation || (await dialogs.count()) !== 1) fail();
    validateNowUrl(page.url(), orderId, "/tez/browse/orderTracking");
    at("NOW_PARSING");
    return parseNowSnapshot(facts, orderId);
  } catch (error) {
    // A sign-in redirect after the click must preserve manual-authentication
    // lifecycle behavior, including leaving the dedicated window open.
    let currentUrl: URL | undefined;
    try {
      currentUrl = new URL(page.url());
    } catch {
      /* Unavailable URL is not evidence. */
    }
    if (
      currentUrl?.protocol === "https:" &&
      ["www.amazon.in", "amazon.in"].includes(currentUrl.hostname) &&
      /^\/ap\/(?:signin|cvf)(?:\/|$)/.test(currentUrl.pathname)
    )
      await authenticate().catch((authError: unknown) => {
        if (
          authError instanceof Error &&
          authError.name === "AuthenticationRequiredError"
        ) {
          trace?.note("detail", "AUTHENTICATION_REQUIRED");
          throw authError;
        }
        throw new DiagnosticError(
          "detail",
          phase,
          "Amazon Now authentication check failed.",
          authError instanceof Error && authError.name === "TimeoutError"
            ? "timeout"
            : "operation-failed",
        );
      });
    if (
      error instanceof DiagnosticError ||
      (error instanceof Error && error.name === "AuthenticationRequiredError")
    ) {
      if (error instanceof DiagnosticError)
        trace?.noteFailure(error.stage, error.reason, error);
      else trace?.note("detail", "AUTHENTICATION_REQUIRED");
      throw error;
    }
    // Playwright errors can contain raw DOM and URLs. Keep them out of MCP/logs.
    const safeError = new DiagnosticError(
      "detail",
      phase,
      "Amazon Now extraction could not validate all required facts.",
      error instanceof Error && error.name === "TimeoutError"
        ? "timeout"
        : "operation-failed",
    );
    trace?.noteFailure("detail", phase, safeError);
    throw safeError;
  } finally {
    page.off("framenavigated", checkNavigation);
  }
}
