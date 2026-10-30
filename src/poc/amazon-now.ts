/// <reference lib="dom" />
import type { ElementHandle, Frame, Locator, Page } from "playwright";
import { z } from "zod";
import {
  DiagnosticError,
  FailureDiagnostics,
  NOW_CHECKPOINTS,
  NOW_DOM_FAILURES,
  NOW_PARSER_FAILURES,
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
// Applied only after the DOM reader's existing whitespace normalization.
// Singular/plural agreement remains display-only, as with the original grammar.
export const NOW_ITEM_COUNT_LABEL = /^([1-9]\d?|100) items?(?: in order)?$/i;
// Discover malformed numeric declarations and known unsupported suffixes too,
// so conflicting evidence cannot disappear. This signal never authorizes a count.
const ITEM_COUNT_SIGNAL =
  /^(?:[+-]?(?:\d[\d.,eE+-]*|\.\d+)|NaN|Infinity) items?(?: in (?:order|delivery)(?: today)?)?$/i;
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
    singleLinePriceDomVerified: z.literal(true).optional(),
    // Internal dialog evidence only; never serialized into merchandise JSON.
    declaredItemCount: z.number().int().positive().max(100).optional(),
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

function explicitQuantity(value: string, invalid: () => never): number {
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
    if (!increasing) invalid();
  }
  const count = match?.[1] ?? match?.[2] ?? approximate?.[3];
  if (!count || !/^[1-9]\d*$/.test(count)) invalid();
  const quantity = Number(count);
  if (!Number.isSafeInteger(quantity) || quantity < 1) invalid();
  return quantity;
}

/** Pure parser of bounded visible facts. Funding never enters this snapshot. */
export function parseNowSnapshot(
  input: unknown,
  orderId: string,
  trace?: FailureDiagnostics,
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
  let itemsTotal: ReturnType<typeof money> | undefined;
  let subtotalDeclarations = 0;
  const adjustmentKinds = new Set<string>();
  let duplicateAdjustment = false;
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
      const subtotal = money(pair[2]); // Never promote a subtotal to billed total.
      subtotalDeclarations++;
      if (/^items total$/i.test(label)) itemsTotal = subtotal;
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
    const kind =
      fee?.[1].toLowerCase() ??
      (/^discount/i.test(label) ? "discount" : "promotion");
    if (adjustmentKinds.has(kind)) duplicateAdjustment = true;
    adjustmentKinds.add(kind);
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
  const items = facts.items.map(({ parts, alts, hrefs }, lineIndex) => {
    const invalid = (reason: (typeof NOW_PARSER_FAILURES)[number]): never => {
      trace?.nowParserFailure(reason, lineIndex);
      return fail("ITEM_FACTS_INVALID");
    };
    const quantities = parts.filter((part) => QUANTITY_SIGNAL.test(part));
    if (quantities.length !== 1)
      invalid(
        quantities.length === 0
          ? "NOW_PARSE_QUANTITY_MISSING"
          : "NOW_PARSE_QUANTITY_DUPLICATE",
      );
    const quantity = explicitQuantity(quantities[0], () =>
      invalid("NOW_PARSE_QUANTITY_INVALID"),
    );
    const prices = parts.filter((part) => /₹|\bINR\b/i.test(part));
    const names = parts.filter(
      (part) => !quantities.includes(part) && !prices.includes(part),
    );
    if (names.length !== 1 || !names[0].trim())
      invalid(
        names.length > 1
          ? "NOW_PARSE_NAME_DUPLICATE"
          : "NOW_PARSE_NAME_MISSING",
      );
    let unitPrice: ReturnType<typeof money>;
    let itemTotal: ReturnType<typeof money>;
    if (quantity === 1 && prices.length === 1) {
      unitPrice = itemTotal = money(
        prices[0].replace(/^(?:unit price|item total|line total)\s*:\s*/i, ""),
      );
    } else if (
      facts.singleLinePriceDomVerified === true &&
      facts.items.length === 1 &&
      quantity > 1 &&
      prices.length === 1
    ) {
      if (
        !itemsTotal ||
        subtotalDeclarations !== 1 ||
        adjustments.length ||
        duplicateAdjustment
      )
        fail("ITEM_SHAPE_AMBIGUOUS");
      // This exception accepts only canonical unlabelled INR values. Parse the
      // declared decimal strings into exact paise before comparing or dividing.
      const exactPaise = (value: string): number => {
        const match =
          /^(?:₹\s*|INR\s+)((?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+|[1-9]\d?(?:,\d{2})*,\d{3})(?:\.\d{1,2})?)$/.exec(
            value,
          );
        if (!match) return fail("ITEM_SHAPE_AMBIGUOUS");
        const [whole, fraction = ""] = match[1].replace(/,/g, "").split(".");
        const paise = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
        if (paise <= 0n || paise > BigInt(Number.MAX_SAFE_INTEGER))
          fail("ITEM_SHAPE_AMBIGUOUS");
        return Number(paise);
      };
      const linePaise = exactPaise(prices[0]);
      if (
        linePaise !== exactPaise(itemsTotal.formatted) ||
        linePaise !== exactPaise(orderTotal.formatted) ||
        BigInt(linePaise) % BigInt(quantity) !== 0n
      )
        fail("ITEM_SHAPE_AMBIGUOUS");
      const unitPaise = Number(BigInt(linePaise) / BigInt(quantity));
      itemTotal = money(prices[0]);
      if (
        !Number.isSafeInteger(unitPaise) ||
        unitPaise <= 0 ||
        Math.round(itemTotal.amount * 100) !== linePaise ||
        Math.round((unitPaise / 100) * 100) !== unitPaise
      )
        fail("ITEM_SHAPE_AMBIGUOUS");
      unitPrice = {
        amount: unitPaise / 100,
        currency: "INR",
        formatted: `Derived INR ${BigInt(unitPaise) / 100n}.${String(BigInt(unitPaise) % 100n).padStart(2, "0")}`,
      };
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
    if (identifiers.size > 1) invalid("NOW_PARSE_IDENTIFIERS_CONFLICT");
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
  selectedOrderScope = false,
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
        countLabelSource,
        countSignalSource,
        selectedOrderScope,
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
        const rawText = (el: Element): string =>
          el.textContent?.replace(/\s+/g, " ").trim() ?? "";
        const historical = (el: Element): Element | undefined => {
          let result: Element | undefined;
          for (
            let node: Element | null = el;
            node && node !== root;
            node = node.parentElement
          )
            if (
              ["S", "DEL", "STRIKE"].includes(node.tagName) ||
              view
                .getComputedStyle(node)
                .textDecorationLine.includes("line-through")
            )
              result = node;
          return result;
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
        let declaredItemCount: number | undefined;
        let countDeclaration: Element | undefined;
        if (selectedOrderScope) {
          // The dialog belongs to one independently listed order, regardless of
          // delivery tabs elsewhere in the shared tracking interface.
          // Inspect raw leaves as well: hidden/historical identities and bill
          // declarations cannot disappear through the normal current-text view.
          const raw = (el: Element): string =>
            el.textContent?.replace(/\s+/g, " ").trim() ?? "";
          const rawLeaves = nodes.filter(
            (el) =>
              !Array.from(el.children).some((child) => raw(child) === raw(el)),
          );
          // Require independent count evidence, without assigning its meaning
          // to either lines or units here. The parsed facts must corroborate both.
          const countDeclarations = rawLeaves.filter((el) =>
            new RegExp(countSignalSource, "i").test(raw(el)),
          );
          const countMatch =
            countDeclarations.length === 1
              ? new RegExp(countLabelSource, "i").exec(
                  raw(countDeclarations[0]),
                )
              : null;
          if (
            countDeclarations.length !== 1 ||
            !current(countDeclarations[0]) ||
            !countMatch
          )
            abort("NOW_ITEM_FIELDS_INVALID");
          countDeclaration = countDeclarations[0];
          declaredItemCount = Number(countMatch?.[1]);
          if (
            !Number.isSafeInteger(declaredItemCount) ||
            declaredItemCount > 100
          )
            abort("NOW_ITEM_FIELDS_INVALID");
          const identities = nodes.flatMap((el) =>
            Array.from(el.childNodes).flatMap((node) =>
              node.nodeType === 3
                ? [
                    ...(node.textContent ?? "").matchAll(
                      /\b(?:\d{3}-\d{7}-\d{7}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\b/gi,
                    ),
                  ].map((match) => ({ el, id: match[0] }))
                : [],
            ),
          );
          const identityLabels = nodes.filter(
            (el) =>
              /^Order ID\b/i.test(raw(el)) &&
              !Array.from(el.children).some((child) =>
                /^Order ID\b/i.test(raw(child)),
              ),
          );
          if (
            identityLabels.length !== 1 ||
            !current(identityLabels[0]) ||
            identities.length !== 1 ||
            identities[0].id !== expected ||
            !current(identities[0].el) ||
            nodes.some(
              (el) =>
                el.hasAttribute("data-order-id") &&
                el.getAttribute("data-order-id") !== expected,
            )
          )
            abort("NOW_DIALOG_IDENTITY_INVALID");
          // Discovery only: textContent concatenates sibling elements without
          // spaces. Also inspect raw text-node boundaries so an independent
          // split label cannot hide outside the candidate bill, even if hidden
          // or historical. This never authorizes a label absent from rawLeaves.
          const separated = (scope: Element): string => {
            const parts: string[] = [];
            const walker = root.ownerDocument.createTreeWalker(scope, 4);
            while (walker.nextNode())
              parts.push(walker.currentNode.textContent ?? "");
            return parts.join(" ").replace(/\s+/g, " ").trim();
          };
          const separatedRaw = separated(root);
          for (const label of [
            /^Items total\b/i,
            /^You pay\b/i,
            /^Bill summary$/i,
          ]) {
            const candidates = rawLeaves.filter((el) => label.test(raw(el)));
            // A composite may start with its descendant's declaration and also
            // contain sibling rows. Collapse it only when the descendant owns
            // its sole occurrence of this label. Independent text before/after
            // that descendant (including hidden or fragmented text) stays fatal.
            // No leading word boundary: adjacent DOM text may join two labels.
            const occurrence = new RegExp(
              label.source.replace(/^\^/, "").replace(/\$$/, ""),
              "gi",
            );
            const declarations = candidates.filter(
              (el) =>
                (separated(el).match(occurrence) ?? []).length !== 1 ||
                !candidates.some((child) => child !== el && el.contains(child)),
            );
            if (
              declarations.length !== 1 ||
              !current(declarations[0]) ||
              // Include independently repeated text even when it follows an
              // element in a composite, or is fragmented across sibling nodes.
              (separatedRaw.match(occurrence) ?? []).length !== 1
            )
              abort("NOW_BILL_SUMMARY_INVALID");
          }
          if (
            nodes.some(
              (el) =>
                !current(el) &&
                (el.matches(
                  'article, li, [role="listitem"], img, a[href*="/dp/"], a[href*="/gp/product/"]',
                ) ||
                  new RegExp(quantitySignalSource, "i").test(raw(el))),
            )
          )
            abort("NOW_ITEM_FIELDS_INVALID");
        }
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
        // Establish this boundary before bill membership can exclude item facts.
        // Even a financial-looking list remains unproven here; do not conceal
        // semantic item rows, product links or raw purchased-quantity evidence.
        if (
          selectedOrderScope &&
          (billRoot.closest('article, li, [role="list"], [role="listitem"]') ||
            elements(billRoot).some(
              (el) =>
                el.matches(
                  'article, li, [role="list"], [role="listitem"], a[href*="/dp/"], a[href*="/gp/product/"]',
                ) ||
                new RegExp(quantitySignalSource, "i").test(
                  el.textContent?.replace(/\s+/g, " ").trim() ?? "",
                ),
            ))
        )
          abort("NOW_BILL_SUMMARY_INVALID");
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
        const billAnnotationIcons = new Set<Element>();
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
                if (selectedOrderScope) {
                  const icon = annotation.querySelector("img, svg");
                  if (!icon) return abort();
                  if (
                    !/^Free for$/i.test(
                      annotation.textContent?.replace(/\s+/g, " ").trim() ?? "",
                    ) ||
                    annotation.querySelector(
                      'a, button, [role="button"], input, select, textarea',
                    ) ||
                    !rendered(icon, true) ||
                    /\b[A-Z0-9]{10}\b/.test(icon.getAttribute("alt") ?? "")
                  )
                    return abort();
                  billAnnotationIcons.add(icon);
                }
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
        // A visible old amount needs one independently label-bound row owner.
        // Neither bill membership nor a matching current amount supplies proof.
        const billComparison = (
          el: Element,
          accessiblePrice = false,
        ): boolean => {
          const old = historical(el);
          if (
            !old ||
            !old.parentElement ||
            !rendered(old, accessiblePrice) ||
            !/^(?:₹|INR\s*)\s*[\d,]+(?:\.\d{1,2})?$/i.test(rawText(old)) ||
            old.querySelector(
              'img, svg, a, button, input, select, textarea, article, li, [role="list"], [role="listitem"]',
            )
          )
            return false;
          const owners = [...billRegions].filter((row) => row.contains(old));
          if (owners.length !== 1) return false;
          let bounded = false;
          for (
            let scope: Element | null = old.parentElement, depth = 0;
            scope && scope !== billRoot && depth < 5;
            scope = scope.parentElement, depth++
          )
            if (scope === owners[0]) bounded = true;
          return (
            bounded &&
            elements(owners[0]).filter(
              (node) =>
                historical(node) === node && /₹|\bINR\b/i.test(rawText(node)),
            ).length === 1
          );
        };
        if (
          selectedOrderScope &&
          elements(billRoot).some(
            (el) =>
              !current(el) &&
              Array.from(el.childNodes).some(
                (node) => node.nodeType === 3 && node.textContent?.trim(),
              ) &&
              !billComparison(el),
          )
        )
          abort("NOW_BILL_ROW_INVALID");
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
        // Bill membership must not conceal merchandise images. Only the
        // independently bounded annotation above can own an icon here. Inspect
        // raw nodes too; hiding an image never supplies an exemption.
        if (
          selectedOrderScope &&
          elements(billRoot).some(
            (el) => el.matches("img, svg") && !billAnnotationIcons.has(el),
          )
        )
          abort("NOW_BILL_SUMMARY_INVALID");

        checkpoints.push("NOW_ITEMS_FEES");
        reason = "NOW_ITEM_OWNERSHIP_INVALID";
        const quantitySignal = new RegExp(quantitySignalSource, "i");
        const quantityField = new RegExp(quantityFieldSource, "i");
        const approximateQuantityField = new RegExp(
          approximateQuantityFieldSource,
        );
        const productLink = 'a[href*="/dp/"], a[href*="/gp/product/"]';
        // The observed unavailable layout is a separate, entirely unpriced
        // region. Prove its whole shape before excluding any quantity/image.
        const unavailableLabels = nodes.filter(
          (el) =>
            /^Out of Stock Items$/i.test(rawText(el)) &&
            !Array.from(el.children).some(
              (child) => rawText(child) === rawText(el),
            ),
        );
        let unavailableRoot: Element | undefined;
        const unavailableAsins = new Set<string>();
        const unavailableNames = new Set<string>();
        if (unavailableLabels.length) {
          const heading = unavailableLabels[0];
          const region = heading.parentElement;
          const rejectUnavailable = (): never =>
            abort("NOW_NON_ITEM_REGION_INVALID");
          const noDirectText = (el: Element): boolean =>
            !Array.from(el.childNodes).some(
              (node) => node.nodeType === 3 && node.textContent?.trim(),
            );
          if (
            !selectedOrderScope ||
            unavailableLabels.length !== 1 ||
            heading.tagName !== "P" ||
            heading.children.length ||
            !region ||
            region === root ||
            region.tagName !== "DIV" ||
            region.children.length !== 3 ||
            region.children[0] !== heading ||
            !noDirectText(region) ||
            region.contains(billRoot) ||
            billRoot.contains(region) ||
            region.closest('article, li, [role="list"], [role="listitem"]') ||
            region.querySelector(
              'article, li, [role="list"], [role="listitem"], a, button, input, select, textarea, svg, [role="button"], [data-component="purchasedItems"], [data-component="itemTitle"], [data-component="unitPrice"], [data-component="quantity"]',
            ) ||
            elements(region).length > 500 ||
            elements(region).some(
              (el) =>
                !current(el) ||
                /₹|\bINR\b|[$€£¥]/i.test(rawText(el)) ||
                /₹|\bINR\b|[$€£¥]/i.test(el.getAttribute("aria-label") ?? ""),
            )
          )
            return rejectUnavailable();
          const products = region.children[1],
            notice = region.children[2];
          if (
            products.tagName !== "DIV" ||
            !noDirectText(products) ||
            products.children.length < 1 ||
            products.children.length > 100 ||
            notice.tagName !== "DIV" ||
            notice.children.length !== 2 ||
            !noDirectText(notice)
          )
            return rejectUnavailable();
          const icon = notice.children[0],
            explanation = notice.children[1];
          if (
            icon.tagName !== "IMG" ||
            icon.getAttribute("alt") !== "refund-icon" ||
            icon.getAttribute("role") !== "img" ||
            explanation.tagName !== "DIV" ||
            explanation.children.length !== 2 ||
            !noDirectText(explanation) ||
            Array.from(explanation.children).some(
              (el) => el.tagName !== "P" || el.children.length,
            ) ||
            rawText(explanation.children[0]) !==
              "Refund for these items initiated" ||
            rawText(explanation.children[1]) !==
              "It may take up to 3-5 business days for the refund to show in your account"
          )
            return rejectUnavailable();
          for (const row of Array.from(products.children)) {
            if (
              row.tagName !== "DIV" ||
              row.children.length !== 2 ||
              !noDirectText(row)
            )
              return rejectUnavailable();
            const picture = row.children[0],
              facts = row.children[1];
            const image = picture.children[0];
            if (
              picture.tagName !== "SPAN" ||
              picture.children.length !== 1 ||
              !noDirectText(picture) ||
              !image ||
              image.tagName !== "IMG" ||
              facts.tagName !== "DIV" ||
              facts.children.length !== 2 ||
              !noDirectText(facts)
            )
              return rejectUnavailable();
            const name = facts.children[0],
              descriptor = facts.children[1];
            const asin = image.getAttribute("alt") ?? "";
            const parts = Array.from(descriptor.childNodes).filter(
              (node) => node.nodeType !== 3 || node.textContent?.trim(),
            );
            const pack = /^Pack of ([1-9]\d*), ([1-9]\d*) Pcs$/.exec(
              parts[0]?.textContent?.trim() ?? "",
            );
            const units = /^([1-9]\d*) unit(?:s|\(s\))?$/.exec(
              parts[2]?.textContent?.trim() ?? "",
            );
            if (
              name.tagName !== "P" ||
              name.children.length ||
              !rawText(name) ||
              rawText(name).length > 500 ||
              /₹|\bINR\b|\b(?:qty|quantity)\s*:|\bunit(?:s|\(s\))?\b/i.test(
                rawText(name),
              ) ||
              descriptor.tagName !== "P" ||
              parts.length !== 3 ||
              parts[0].nodeType !== 3 ||
              parts[2].nodeType !== 3 ||
              parts[1].nodeType !== 1 ||
              (parts[1] as Element).tagName !== "SPAN" ||
              (parts[1] as Element).children.length ||
              parts[1].textContent?.trim() !== "." ||
              !pack ||
              !units ||
              [...pack.slice(1), units[1]].some(
                (n) => !Number.isSafeInteger(Number(n)),
              ) ||
              !/^[A-Z0-9]{10}$/.test(asin) ||
              unavailableAsins.has(asin) ||
              unavailableNames.has(rawText(name))
            )
              return rejectUnavailable();
            unavailableAsins.add(asin);
            unavailableNames.add(rawText(name));
          }
          // No additional refund/unavailability claim elsewhere can be silently
          // covered by this one recognized notice.
          if (
            nodes.some(
              (el) =>
                !region.contains(el) &&
                Array.from(el.childNodes).some(
                  (node) =>
                    node.nodeType === 3 &&
                    /\b(?:refund|out of stock)\b/i.test(node.textContent ?? ""),
                ),
            )
          )
            return rejectUnavailable();
          unavailableRoot = region;
        }
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
        if (unavailableRoot) nonItemRoots.push(unavailableRoot);
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
        if (countDeclaration) {
          const declaration = countDeclaration;
          const semanticOwner = declaration.closest(
            'article, li, [role="listitem"], a, button, [role="tab"]',
          );
          if (
            [...itemRoots, ...nonItemRoots].some((region) =>
              region.contains(declaration),
            ) ||
            (semanticOwner &&
              semanticOwner !== root &&
              root.contains(semanticOwner))
          )
            abort("NOW_ITEM_FIELDS_INVALID");
        }
        const amount = /^(?:-\s*)?(?:₹|INR\s*)\s*[\d,]+(?:\.\d{1,2})?$/i;
        reason = "NOW_ITEM_FIELDS_INVALID";
        const packageSize =
          /^(?:[1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)\s*(?:mg|g|kg|ml|l|litres?|liters?)$/i;
        const increasingRange = (
          lowerValue: string,
          upperValue: string,
        ): boolean => {
          const [lower, lowerFraction = ""] = lowerValue.split(".");
          const [upper, upperFraction = ""] = upperValue.split(".");
          const precision = Math.max(
            lowerFraction.length,
            upperFraction.length,
          );
          return lower.length !== upper.length
            ? lower.length < upper.length
            : lower !== upper
              ? lower < upper
              : lowerFraction.padEnd(precision, "0") <
                upperFraction.padEnd(precision, "0");
        };
        const piecePackage =
          /^([1-9]\d*) Pcs \((?:Approx\. )?([1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)\s*[-–]\s*([1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*) g\)$/;
        // Discovery for hidden/historical conflicts only, never acceptance.
        const piecePackageSignal =
          /^(?:[+-]?(?:\d[\d.,eE+-]*|\.\d+)\s*)?Pcs\b/i;
        const pieceDescriptor = (value: string): boolean => {
          const pieces = piecePackage.exec(value);
          if (!pieces || !Number.isSafeInteger(Number(pieces[1]))) return false;
          // Compare decimal strings exactly, as with the existing Approx.
          // quantity grammar. Neither the pieces nor weights supply quantity.
          return increasingRange(pieces[2], pieces[3]);
        };
        const packageDescriptor = (value: string): boolean => {
          if (packageSize.test(value) || pieceDescriptor(value)) return true;
          const range =
            /^([1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*)-([1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*) g$/.exec(
              value,
            );
          if (range) return increasingRange(range[1], range[2]);
          const grams =
            value.length <= 500
              ? /^Pack of ([1-9]\d*), ([1-9]\d*(?:\.\d+)?|0\.\d*[1-9]\d*) g Each$/.exec(
                  value,
                )
              : null;
          if (grams) {
            const weight = Number(grams[2]);
            return (
              Number.isSafeInteger(Number(grams[1])) &&
              weight > 0 &&
              weight < Number.MAX_SAFE_INTEGER
            );
          }
          const tablets = /^Pack of ([1-9]\d*), ([1-9]\d*) Tablets$/.exec(
            value,
          );
          // Pack size and tablet count are metadata, never purchased units.
          return (
            tablets !== null &&
            tablets
              .slice(1)
              .every((count) => Number.isSafeInteger(Number(count)))
          );
        };
        const purchasedUnits =
          /^(?:(?:qty|quantity)\s*:\s*[1-9]\d*|[1-9]\d*\s+unit(?:s|\(s\))?)$/i;
        const fieldText = (node: Node | undefined): string =>
          node?.nodeType === 3
            ? (node.textContent?.trim() ?? "")
            : node?.nodeType === 1
              ? itemText(node as Element)
              : "";
        const boundedPackageField = (node: Node): boolean =>
          node.nodeType === 3 ||
          (node.nodeType === 1 &&
            elements(node as Element).every(
              (el) =>
                current(el) &&
                !el.matches(
                  `${merchandiseBoundary}, img, a, button, [role=button], input, select, textarea`,
                ),
            ));
        // Complete fields, or a currency node paired only with its adjacent numeric
        // sibling in the same parent. No cross-row flattening/pairing is allowed.
        const fields = (el: Element, split: Node[]): string[] => {
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
            if (packageDescriptor(part)) {
              const nextField = (start: number): number => {
                while (
                  start < children.length &&
                  children[start].nodeType === 3 &&
                  !children[start].textContent?.trim()
                )
                  start++;
                return start;
              };
              const separator = nextField(index + 1);
              const declaration = nextField(separator + 1);
              const units = fieldText(children[declaration]);
              if (
                (fieldText(children[separator]) === "." ||
                  (pieceDescriptor(part) &&
                    fieldText(children[separator]) === "·")) &&
                purchasedUnits.test(units) &&
                [node, children[separator], children[declaration]].every(
                  boundedPackageField,
                )
              ) {
                if (split.length) return abort();
                split.push(node, children[separator], children[declaration]);
                // Discard only this proven adjacent package/separator pair. Keep
                // the purchased declaration unchanged for the strict parser.
                parts.push(units);
                index = declaration;
                continue;
              }
            }
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
              parts.push(...fields(node as Element, split));
            else parts.push(part);
          }
          return parts;
        };
        const items = [...itemRoots].map((row) => {
          const split: Node[] = [];
          const parts = fields(row, split);
          // Both metadata nodes can be hidden/struck through, leaving a bare
          // purchased declaration. They must not bypass the split-row guard.
          if (
            (split.length || parts.some((part) => purchasedUnits.test(part))) &&
            elements(row).some((el) => {
              const raw = el.textContent?.replace(/\s+/g, " ").trim() ?? "";
              return (
                (/^pack\b/i.test(raw) ||
                  piecePackageSignal.test(raw) ||
                  /^[+-]?(?:\d[\d.,eE+-]*|\.\d+)\s*[a-z]+$/i.test(raw) ||
                  (split.length &&
                    (quantitySignal.test(raw) || /^[.·•|:;/]+$/.test(raw)))) &&
                !current(el)
              );
            })
          )
            return abort();
          if (split.length) {
            if (
              ![3, 4].includes(parts.length) ||
              packageDescriptor(parts[0]) ||
              parts[0] === "." ||
              /₹|\bINR\b/i.test(parts[0]) ||
              !purchasedUnits.test(parts[1]) ||
              !parts.slice(2).every((part) => /₹|\bINR\b/i.test(part))
            )
              return abort();
          }
          return {
            parts,
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
          };
        });
        if (
          items.some(
            (item) =>
              item.alts.some((alt) => unavailableAsins.has(alt)) ||
              item.parts.some((part) => unavailableNames.has(part)) ||
              item.hrefs.some((href) =>
                Array.from(unavailableAsins).some((asin) =>
                  new RegExp(`/(?:dp|gp/product)/${asin}(?:[/?]|$)`).test(href),
                ),
              ),
          )
        )
          abort("NOW_ITEM_OWNERSHIP_INVALID");
        if (
          selectedOrderScope &&
          nodes.some(
            (el) =>
              el.matches(rowBoundary) &&
              !nonItemRoots.some((region) => region.contains(el)) &&
              [...itemRoots].filter((row) => el.contains(row)).length !== 1,
          )
        )
          abort("NOW_ITEM_FIELDS_INVALID");
        const single = items.length === 1 ? items[0] : undefined;
        const declaration = single?.parts.filter((part) =>
          quantitySignal.test(part),
        );
        const declared = declaration?.length === 1 ? declaration[0] : "";
        const quantityMatch = quantityField.exec(declared);
        const count = Number(
          quantityMatch?.[1] ??
            quantityMatch?.[2] ??
            approximateQuantityField.exec(declared)?.[3],
        );
        const prices =
          single?.parts.filter((part) => /₹|\bINR\b/i.test(part)) ?? [];
        const singleLinePriceDomVerified =
          Number.isSafeInteger(count) &&
          count > 1 &&
          prices.length === 1 &&
          /^(?:₹|INR\b)/.test(prices[0]);
        if (singleLinePriceDomVerified) {
          const row = [...itemRoots][0];
          const merchandise = row.closest(rowBoundary) ?? row;
          if (itemText(merchandise) !== itemText(row)) return abort();
          // Incomplete semantic rows must not disappear merely because their
          // image is presentational and quantity/price evidence is missing.
          if (
            nodes.some(
              (el) =>
                el.matches(rowBoundary) &&
                !el.contains(row) &&
                !nonItemRoots.some((region) => region.contains(el)),
            )
          )
            return abort();
          const raw = (el: Element): string =>
            el.textContent?.replace(/\s+/g, " ").trim() ?? "";
          const comparison = (el: Element): boolean => {
            if (billRoot.contains(el)) return billComparison(el, true);
            const old = historical(el);
            const parent = old?.parentElement;
            if (
              !old ||
              !parent ||
              !rendered(old, true) ||
              !/^(?:₹|INR\s*)\s*[\d,]+(?:\.\d{1,2})?$/i.test(raw(old)) ||
              old.querySelector(`img, a, button, ${merchandiseBoundary}`)
            )
              return false;
            // One visible historical price may be a comparison only inside the
            // same minimal field/label-bound bill row as its current value.
            const owner =
              row.contains(parent) && itemText(parent) === prices[0];
            const field = owner ? parent : undefined;
            return (
              !!field &&
              elements(field).filter(
                (node) =>
                  historical(node) === node && /₹|\bINR\b/i.test(raw(node)),
              ).length === 1
            );
          };
          for (const el of nodes) {
            if (current(el)) continue;
            const value = raw(el);
            const inBill = billRoot.contains(el);
            const nonItem = nonItemRoots.some(
              (region) => region !== billRoot && region.contains(el),
            );
            if (
              !inBill &&
              (quantitySignal.test(value) ||
                el.matches(`${rowBoundary}, ${productLink}`) ||
                (el.tagName === "IMG" &&
                  (!nonItem ||
                    /^[A-Z0-9]{10}$/.test(el.getAttribute("alt") ?? "") ||
                    el.closest(rowBoundary))))
            )
              return abort();
            if (nonItem) continue;
            if (
              ((inBill || merchandise.contains(el)) &&
                directText(el) &&
                value) ||
              /₹|\bINR\b/i.test(value)
            ) {
              // Existing proven, visually rendered aria-hidden price pairs are
              // current evidence. Actual hiding and labelled historical facts
              // cannot authorize the exception.
              if (
                !inBill &&
                current(el, true) &&
                (priceOverrides.has(el) ||
                  priceAncestors.has(el) ||
                  renderedPairs.some(
                    (pair) =>
                      pair.currency.contains(el) || pair.number.contains(el),
                  ))
              )
                continue;
              if (!comparison(el)) return abort();
            }
          }
        }
        return {
          orderIds,
          billRows,
          items,
          ...(declaredItemCount !== undefined ? { declaredItemCount } : {}),
          ...(singleLinePriceDomVerified
            ? { singleLinePriceDomVerified: true as const }
            : {}),
        };
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
      countLabelSource: NOW_ITEM_COUNT_LABEL.source,
      countSignalSource: ITEM_COUNT_SIGNAL.source,
      selectedOrderScope,
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

/** Prove the currently visible summary owns this action for the requested order.
 * Other delivery tabs and their merchandise never supply ownership or coverage.
 */
async function readAlternateAction(
  action: ElementHandle<HTMLElement | SVGElement>,
  expected: string,
  expectedUrl: string,
): Promise<string> {
  const result = await action.evaluate(
    (button, { expected, expectedUrl }) => {
      const doc = button.ownerDocument;
      const view = doc.defaultView;
      const raw = (el: Element): string =>
        el.textContent?.replace(/\s+/g, " ").trim() ?? "";
      const current = (el: Element): boolean => {
        if (!view || !el.getClientRects().length) return false;
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
        return true;
      };
      const all = Array.from(doc.querySelectorAll("*"));
      if (
        all.length > 5000 ||
        doc.URL !== expectedUrl ||
        !button.isConnected ||
        button.tagName !== "BUTTON" ||
        button.hasAttribute("disabled") ||
        button.getAttribute("aria-disabled") === "true" ||
        !current(button) ||
        raw(button) !== "View details"
      )
        return null;
      const actions = all.filter(
        (el) =>
          /^(?:View order details|View details)$/i.test(raw(el)) &&
          !Array.from(el.children).some((child) => raw(child) === raw(el)) &&
          current(el),
      );
      if (actions.length !== 1 || !button.contains(actions[0])) return null;
      const texts = (scope: Element): Array<{ el: Element; value: string }> =>
        [scope, ...Array.from(scope.querySelectorAll("*"))].flatMap((el) =>
          Array.from(el.childNodes)
            .filter((node) => node.nodeType === 3 && node.textContent?.trim())
            .map((node) => ({
              el,
              value: (node.textContent ?? "").replace(/\s+/g, " ").trim(),
            })),
        );
      const selectedSources = all
        .filter((el) => !el.closest('[role="dialog"]') && current(el))
        .flatMap((el) =>
          Array.from(el.childNodes).filter(
            (node) =>
              node.nodeType === 3 && node.textContent?.includes(expected),
          ),
        );
      if (selectedSources.length !== 1) return null;
      let owner: Element | null = button.parentElement;
      for (
        let depth = 0;
        owner && depth < 4;
        depth++, owner = owner.parentElement
      ) {
        if (["BODY", "HTML", "MAIN"].includes(owner.tagName)) return null;
        const tokens = texts(owner);
        if (!tokens.some(({ value }) => /^Order ID\s*:?$/i.test(value)))
          continue;
        // The first labeled common ancestor must satisfy every bound. Do not skip
        // a conflicting small card in search of a more convenient larger owner.
        const ids = tokens.filter(({ value }) =>
          /\b(?:\d{3}-\d{7}-\d{7}|[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\b/i.test(
            value,
          ),
        );
        const nodes = [owner, ...Array.from(owner.querySelectorAll("*"))];
        if (
          owner.tagName !== "DIV" ||
          raw(owner).length > 500 ||
          nodes.length > 80 ||
          ids.length !== 1 ||
          !new RegExp("^#?\\s*" + expected + "$", "i").test(ids[0].value) ||
          !current(ids[0].el) ||
          tokens.filter(({ value }) => /^Order ID\s*:?$/i.test(value))
            .length !== 1 ||
          tokens.some(({ el }) => !current(el)) ||
          owner.querySelector(
            "main, nav, aside, header, footer, article, [role=dialog], [data-order-id], .order-card, .order",
          ) ||
          nodes.filter(
            (el) =>
              /^(?:View order details|View details)$/i.test(raw(el)) &&
              !Array.from(el.children).some((child) => raw(child) === raw(el)),
          ).length !== 1
        )
          return null;
        let cardOwners = 0;
        for (
          let ancestor: Element | null = owner;
          ancestor;
          ancestor = ancestor.parentElement
        ) {
          if (
            ancestor.matches(
              'article, li, [role="listitem"], [data-order-id], .order-card, .order',
            )
          )
            cardOwners++;
          if (
            ancestor.hasAttribute("data-order-id") &&
            ancestor.getAttribute("data-order-id") !== expected
          )
            return null;
        }
        if (cardOwners > 1) return null;
        return raw(owner);
      }
      return null;
    },
    { expected, expectedUrl },
  );
  if (!result) fail();
  return result;
}

/** Validate one selected order's independent count and bill. No delivery merge.
 * Unqualified counts are accepted only when line and unit interpretations agree;
 * unresolved multi-unit count semantics must not authorize incomplete coverage.
 */
export function validateNowSelectedOrder(
  facts: NowSnapshot,
  detail: NowOrderDetail,
  listedTotal?: { amount: number; currency: string },
): void {
  const count = facts.declaredItemCount;
  const units = detail.items.reduce((sum, item) => sum + item.quantity, 0);
  if (
    !count ||
    !Number.isSafeInteger(count) ||
    count > 100 ||
    count !== detail.items.length ||
    count !== units ||
    facts.items.length !== detail.items.length
  )
    fail("ITEM_SHAPE_AMBIGUOUS");
  const itemsTotals = facts.billRows.filter((row) =>
    /^Items total\s/i.test(row),
  );
  if (
    itemsTotals.length !== 1 ||
    facts.billRows.some((row) =>
      /^(?:Item total|Items? subtotal|Subtotal)\b/i.test(row),
    )
  )
    fail("DETAIL_TOTAL_INVALID");
  const declared = money(itemsTotals[0].replace(/^Items total\s+/i, ""));
  const lines = detail.items.reduce(
    (sum, item) => sum + Math.round(item.itemTotal.amount * 100),
    0,
  );
  if (
    !Number.isSafeInteger(lines) ||
    Math.abs(lines - Math.round(declared.amount * 100)) > 1 ||
    !listedTotal ||
    listedTotal.currency !== "INR" ||
    !Number.isFinite(listedTotal.amount) ||
    listedTotal.amount <= 0 ||
    !Number.isSafeInteger(Math.round(listedTotal.amount * 100)) ||
    Math.round(listedTotal.amount * 100) !==
      Math.round(detail.orderTotal.amount * 100)
  )
    fail("DETAIL_TOTAL_INVALID");
  const kinds = facts.billRows.map((row) =>
    row
      .replace(/\s+(?:-\s*)?(?:₹|INR|Free).*$/i, "")
      .toLowerCase()
      .replace(/charges?$/, "fee")
      .replace(/fees$/, "fee")
      .replace(/^promotion applied$/, "promotion")
      .replace(/^shipping /, "delivery "),
  );
  if (new Set(kinds).size !== kinds.length) fail("DETAIL_TOTAL_INVALID");
}

export async function extractNowOrder(
  page: Page,
  orderId: string,
  outerUrl: string,
  authenticate: () => Promise<void>,
  trace?: FailureDiagnostics,
  listedTotal?: { amount: number; currency: string },
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
    // Wait for either presentation to render. This discovers only availability;
    // it never chooses an alternate element or grants permission to click it.
    await page.waitForFunction(
      () => {
        const nodes = Array.from(document.querySelectorAll("*"));
        return nodes.some(
          (el) =>
            /^(?:View order details|View details)$/i.test(
              el.textContent?.replace(/\s+/g, " ").trim() ?? "",
            ) &&
            el.getClientRects().length > 0 &&
            getComputedStyle(el).visibility === "visible",
        );
      },
      undefined,
      { timeout: TIMEOUT },
    );
    const controls = page
      .getByText(/^View order details$/i)
      .filter({ visible: true });
    const alternate = page
      .getByText(/^View details$/i)
      .filter({ visible: true });
    let action: ElementHandle<HTMLElement | SVGElement> | null = null;
    let actionProof: string | undefined;
    if (await alternate.count()) {
      if ((await controls.count()) || (await alternate.count()) !== 1) fail();
      action = await alternate.elementHandle();
      if (!action) fail();
      actionProof = await readAlternateAction(action, orderId, page.url());
      at("NOW_TRACKING_IDENTITY");
    } else {
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
    }
    validateNowUrl(page.url(), orderId, "/tez/browse/orderTracking");
    if (
      invalidNavigation ||
      (actionProof === undefined
        ? (await controls.count()) !== 1
        : (await controls.count()) !== 0 || (await alternate.count()) !== 1) ||
      (await dialogs.count())
    )
      fail();
    if (action) {
      const fresh = await readAlternateAction(action, orderId, page.url());
      if (fresh !== actionProof) fail();
      if (await dialogs.count()) fail();
      validateNowUrl(page.url(), orderId, "/tez/browse/orderTracking");
      if (invalidNavigation) fail();
    }
    at("NOW_DIALOG_OPEN");
    // A captured element prevents locator re-targeting to a replacement action.
    await (action ?? controls).click({ timeout: TIMEOUT });
    await dialogs.first().waitFor({ state: "visible", timeout: TIMEOUT });
    if (invalidNavigation || (await dialogs.count()) !== 1) fail();
    at("NOW_DIALOG_IDENTITY");
    const facts = await readNowDom(
      dialogs.first(),
      orderId,
      "dialog",
      trace,
      actionProof !== undefined,
    );
    if (invalidNavigation || (await dialogs.count()) !== 1) fail();
    validateNowUrl(page.url(), orderId, "/tez/browse/orderTracking");
    at("NOW_PARSING");
    const detail = parseNowSnapshot(facts, orderId, trace);
    if (actionProof !== undefined)
      validateNowSelectedOrder(facts, detail, listedTotal);
    return detail;
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
