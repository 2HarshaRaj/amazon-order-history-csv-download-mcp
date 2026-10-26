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

/** Pure parser of bounded visible facts. Funding never enters this snapshot. */
export function parseNowSnapshot(
  input: unknown,
  orderId: string,
): NowOrderDetail {
  const result = snapshotSchema.safeParse(input);
  if (!result.success) fail("ITEM_SHAPE_AMBIGUOUS");
  const facts = result.data;
  if (!ID.test(orderId) || facts.orderIds[0] !== orderId) fail();
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
      /^(?:qty|quantity)\s*:/i.test(part),
    );
    if (
      quantities.length !== 1 ||
      !/^(?:qty|quantity)\s*:\s*[1-9]\d*$/i.test(quantities[0])
    )
      fail("ITEM_FACTS_INVALID");
    const quantity = Number(quantities[0].split(":")[1].trim());
    if (!Number.isSafeInteger(quantity)) fail("ITEM_FACTS_INVALID");
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

/** Read semantic relationships, not guessed Amazon CSS classes. All walks, node
 * counts and strings are bounded. Crossed-out prices are removed by computed
 * style (including inherited decorations), not by their position or value.
 */
async function readDialog(
  dialog: Locator,
  orderId: string,
): Promise<NowSnapshot> {
  return dialog.evaluate(
    (root, expected) => {
      const abort = (): never => {
        throw new Error("Unsupported Amazon Now dialog.");
      };
      const elements = [root, ...Array.from(root.querySelectorAll("*"))];
      if (elements.length > 5000) abort();
      const view = root.ownerDocument.defaultView;
      if (!view) return abort();
      const visible = (el: Element): boolean => {
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
        for (
          let node: Element | null = el;
          node && root.contains(node);
          node = node.parentElement
        ) {
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
      const textCache = new Map<Element, string>();
      const text = (el: Element): string => {
        const cached = textCache.get(el);
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
        textCache.set(el, value);
        return value;
      };
      const leaves = (scope: Element): Element[] =>
        [scope, ...Array.from(scope.querySelectorAll("*"))].filter((el) => {
          const value = text(el);
          return (
            value &&
            !Array.from(el.children).some((child) => text(child) === value)
          );
        });
      const exact = (scope: Element, pattern: RegExp): Element[] =>
        leaves(scope).filter((el) => pattern.test(text(el)));
      if (exact(root, /^Order Details$/i).length !== 1) abort();
      const ancestorOwner = root.closest("[data-order-id]");
      if (
        ancestorOwner &&
        ancestorOwner.getAttribute("data-order-id") !== expected
      )
        abort();
      // Reject stale explicit ownership anywhere inside the active sheet.
      if (
        elements.some(
          (el) =>
            visible(el) &&
            el.hasAttribute("data-order-id") &&
            el.getAttribute("data-order-id") !== expected,
        )
      )
        abort();
      if (
        exact(
          root,
          /\b(?:cancelled|canceled|refunded|refund pending|partially refunded)\b/i,
        ).length
      )
        abort();
      const ids = exact(root, /^Order ID\s*:?$/i);
      const identityRows = new Set<Element>();
      for (const label of ids) {
        let scope: Element | null = label;
        for (
          let depth = 0;
          scope && scope !== root && depth < 5;
          depth++, scope = scope.parentElement
        ) {
          const match = /^Order ID(?:\s*:\s*|\s+)(\S+)$/i.exec(text(scope));
          if (match) {
            identityRows.add(scope);
            break;
          }
        }
        if (!scope || !identityRows.has(scope)) abort();
      }
      // Also accept a single complete label/value element, never a substring ID.
      for (const el of exact(root, /^Order ID(?:\s*:\s*|\s+)\S+$/i))
        identityRows.add(el);
      const orderIds = [...identityRows].map((el) =>
        text(el).replace(/^Order ID(?:\s*:\s*|\s+)/i, ""),
      );
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
        bill.querySelector("img") ||
        /payment method|paid (?:using|with)/i.test(text(bill))
      )
        return abort();
      const billRoot = bill;
      // Payment logos are not merchandise. Exclude only a separately bounded,
      // explicitly named funding region; never drop arbitrary unpriced images.
      const fundingRoots = exact(
        root,
        /^Payment (?:method|details|information)$/i,
      ).map((heading) => {
        const semantic = heading.closest('section, [role="group"]');
        const scope =
          semantic && semantic !== root ? semantic : heading.parentElement;
        if (
          !scope ||
          scope === root ||
          scope.contains(billRoot) ||
          /\b(?:qty|quantity)\s*:/i.test(text(scope))
        )
          return abort();
        return scope;
      });
      // Retain complete quantity/price fields and exact title text while allowing
      // arbitrary presentation wrappers. Unknown text is retained for rejection.
      const fields = (el: Element): string[] => {
        const value = text(el);
        if (!value) return [];
        if (
          /^(?:-\s*)?(?:₹|INR\b)/i.test(value) ||
          /^(?:qty|quantity)\s*:\s*\d+$/i.test(value) ||
          /^(?:unit price|item total|line total)\s*:\s*(?:₹|INR\s*)\s*[\d,.]+$/i.test(
            value,
          ) ||
          !/₹|\bINR\b|\b(?:qty|quantity)\s*:/i.test(value)
        )
          return [value];
        return Array.from(el.childNodes).flatMap((node) =>
          node.nodeType === 3
            ? node.textContent?.trim()
              ? [node.textContent.trim()]
              : []
            : node.nodeType === 1
              ? fields(node as Element)
              : [],
        );
      };
      const billParts = fields(billRoot).filter(
        (part) => !/^Bill summary$/i.test(part),
      );
      const billRows: string[] = [];
      for (let index = 0; index < billParts.length; index++) {
        const part = billParts[index];
        if (/₹|\bINR\b|\bFree\b/i.test(part)) billRows.push(part);
        else {
          const value = billParts[++index];
          if (!value) return abort();
          billRows.push(`${part} ${value}`);
        }
      }
      const images = elements.filter(
        (el) =>
          el.tagName === "IMG" &&
          visible(el) &&
          !fundingRoots.some((scope) => scope.contains(el)),
      );
      if (!images.length || images.length > 100) abort();
      const itemRoots = new Set<Element>();
      for (const image of images) {
        let scope = image.parentElement;
        for (
          let depth = 0;
          scope && scope !== root && depth < 7;
          depth++, scope = scope.parentElement
        ) {
          if (images.filter((el) => scope?.contains(el)).length !== 1) abort();
          if (
            /₹|\bINR\b/.test(text(scope)) &&
            /\b(?:qty|quantity)\s*:/i.test(text(scope))
          )
            break;
        }
        if (
          !scope ||
          scope === root ||
          billRoot.contains(scope) ||
          scope.contains(billRoot)
        )
          return abort();
        itemRoots.add(scope);
      }
      // Unassociated quantity declarations indicate an unsupported or missing row.
      if (
        exact(root, /^(?:qty|quantity)\s*:/i).some(
          (el) => ![...itemRoots].some((row) => row.contains(el)),
        )
      )
        abort();
      const items = [...itemRoots].map((row) => {
        const parts = fields(row);
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
      return { orderIds, billRows, items };
    },
    orderId,
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
    await controls.click({ timeout: TIMEOUT });
    await dialogs.first().waitFor({ state: "visible", timeout: TIMEOUT });
    if (invalidNavigation || (await dialogs.count()) !== 1) fail();
    const facts = await readDialog(dialogs.first(), orderId);
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
