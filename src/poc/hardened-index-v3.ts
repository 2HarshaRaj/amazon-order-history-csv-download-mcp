#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from "@modelcontextprotocol/sdk/types.js";
import { chromium, BrowserContext, Locator, Page } from "playwright";
import { homedir } from "os";
import { join } from "path";

import { extractDataComponentItems, extractItems, ItemDiagnostics } from "../amazon/extractors/items";
import { getInvoiceUrl } from "../amazon/extractors/invoice";
import { extractAsinFromUrl } from "../core/types/item";
import { Money, parseMoney } from "../core/types/money";
import { OrderHeader } from "../core/types/order";

import { DiagnosticError, FailureDiagnostics } from "./failure-diagnostics";
import { extractDetailOrderTotal, extractHeaderOrderTotal } from "./order-total";
import { discoverNowLink, extractNowOrder } from "./amazon-now";
import { recordWalletCardDiagnostic } from "./wallet-card-diagnostics";
import { classifyWalletFundingCard } from "./wallet-card-classification";

const REGION = "in";
const DOMAIN = "amazon.in";
const CURRENCY = "INR";
export const BROWSER_DATA_DIR = join(homedir(), ".amazon-order-history-poc", "browser-data");
const ORDER_CARD_SELECTOR = ".js-order-card, .order-card, [class*=\"order-card\"]";
const MAX_PAGES = 20;

let browserContext: BrowserContext | null = null;
let page: Page | null = null;

export interface CancelledOrderListItem {
  asin: string;
  productName: string;
  quantity: number;
}

export type MinimalOrder = {
  orderId: string;
  orderDate: string;
  orderDateKey: number;
  orderTotal?: ReturnType<typeof safeMoney>;
  status?: "cancelled";
  cancelledItems?: CancelledOrderListItem[];
  nowDetailUrl?: string;
};

export type ListedOrder = Omit<MinimalOrder, "orderDateKey">;

export type AdjustmentType =
  | "shipping"
  | "marketplace_fee"
  | "discount"
  | "promotion"
  | "tax"
  | "gift_wrap"
  | "other";

export interface OrderAdjustment {
  type: AdjustmentType;
  label: string;
  amount: ReturnType<typeof safeMoney>;
  extractionSource: "order-detail-summary" | "amazon-now-bill-summary";
}

const STRUCTURAL_TOTAL_LABEL =
  /^(?:item(?:s|\(s\))?\s+subtotal|subtotal|order\s+total|grand\s+total|total)\s*:?$/i;
const PRIVATE_SUMMARY_LABEL =
  /(?:payment|card|bank|account|upi|cash|credit|debit|billing|gift[ -]?card|claim|recipient|address|phone|e-?mail|tracking|shipment|invoice|tax\s+id|gstin)/i;
const CASH_ON_DELIVERY_FEE_LABEL =
  /^cash\s*\/\s*pay\s+on\s+delivery\s+fee$/i;

function adjustmentType(label: string): AdjustmentType {
  if (CASH_ON_DELIVERY_FEE_LABEL.test(label)) return "other";
  if (/discount/i.test(label)) return "discount";
  if (/promotion|promo/i.test(label)) return "promotion";
  if (/shipping|delivery/i.test(label)) return "shipping";
  if (/marketplace\s+fee/i.test(label)) return "marketplace_fee";
  if (/tax|gst|vat/i.test(label)) return "tax";
  if (/gift\s*wrap/i.test(label)) return "gift_wrap";
  return "other";
}

/** Parse only label/amount rows already isolated inside the order-detail summary. */
export function parseOrderSummaryAdjustments(
  rows: string[],
  diagnostics?: FailureDiagnostics,
): OrderAdjustment[] {
  diagnostics?.at("adjustments", "ADJUSTMENT_AMOUNT_INVALID");
  const adjustments: OrderAdjustment[] = [];
  for (const [rowIndex, row] of rows.entries()) {
    diagnostics?.adjustment(rowIndex);
    const normalized = row.replace(/\u00a0/g, " ").trim();
    const match = /^([^\n:]{1,80})\s*:?\s*(?:\n|\s{2,})(.+)$/s.exec(normalized);
    if (!match) continue;
    const label = match[1].trim();
    if (
      STRUCTURAL_TOTAL_LABEL.test(label) ||
      (PRIVATE_SUMMARY_LABEL.test(label) &&
        !CASH_ON_DELIVERY_FEE_LABEL.test(label))
    )
      continue;

    const type = adjustmentType(label);
    const amountText = match[2].trim();
    const numeric = amountText.match(
      /^(-)?\s*(?:₹|INR\s*)\s*([\d,]+(?:\.\d{1,2})?)$/i,
    );
    if (!numeric) {
      throw new DiagnosticError(
        "adjustments",
        "ADJUSTMENT_AMOUNT_INVALID",
        "Order-summary adjustment validation failed.",
      );
    }
    const parsed = parseMoney(`₹${numeric[2]}`, CURRENCY);
    if (!parsed)
      throw new DiagnosticError(
        "adjustments",
        "ADJUSTMENT_AMOUNT_INVALID",
        "Order-summary adjustment validation failed.",
      );
    const reducesTotal =
      type === "discount" || type === "promotion" || numeric[1] === "-";
    const amount = {
      ...parsed,
      amount: reducesTotal ? -Math.abs(parsed.amount) : parsed.amount,
    };
    adjustments.push({
      type,
      label,
      amount: safeMoney(amount),
      extractionSource: "order-detail-summary",
    });
    diagnostics?.captureAdjustments(adjustments);
  }
  return adjustments;
}

async function extractOrderSummaryAdjustments(
  targetPage: Page,
  diagnostics?: FailureDiagnostics,
): Promise<OrderAdjustment[]> {
  diagnostics?.at("adjustments", "ADJUSTMENT_READ_FAILED");
  const summary = targetPage.locator("#od-subtotals").first();
  if (
    (await summary.count().catch((error: unknown) => {
      diagnostics?.noteFailure("adjustments", "ADJUSTMENT_READ_FAILED", error);
      return 0;
    })) === 0
  ) {
    diagnostics?.note("adjustments", "SUMMARY_SELECTOR_MISSING");
    return [];
  }
  const rows = await summary
    .locator(".a-row")
    .allInnerTexts()
    .catch((error: unknown) => {
      diagnostics?.noteFailure("adjustments", "ADJUSTMENT_READ_FAILED", error);
      return [];
    });
  return parseOrderSummaryAdjustments(rows, diagnostics);
}

const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

export function safeMoney(value: Money | undefined) {
  if (!value) return undefined;
  const formatted = new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: value.currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value.amount);
  return { amount: value.amount, currency: value.currency, formatted };
}

export function parseInputDate(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid date: ${value}. Use YYYY-MM-DD.`);
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const check = new Date(y, m - 1, d);
  if (check.getFullYear() !== y || check.getMonth() !== m - 1 || check.getDate() !== d) {
    throw new Error(`Invalid date: ${value}. Use YYYY-MM-DD.`);
  }
  return y * 10000 + m * 100 + d;
}

function datePartsToKey(year: number, month: number, day: number): number {
  return year * 10000 + month * 100 + day;
}

function keyToIso(key: number): string {
  const year = Math.trunc(key / 10000);
  const month = Math.trunc((key % 10000) / 100);
  const day = key % 100;
  return `${year.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
}

function parseOrderDateFromText(text: string): number | null {
  const dayFirst = text.match(
    /(?:Order placed|ORDER PLACED)\s*\n?\s*(\d{1,2})\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{4})/i,
  );
  if (dayFirst) {
    const month = MONTHS[dayFirst[2].toLowerCase()];
    return datePartsToKey(Number(dayFirst[3]), month, Number(dayFirst[1]));
  }

  const monthFirst = text.match(
    /(?:Order placed|ORDER PLACED)\s*\n?\s*(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})/i,
  );
  if (monthFirst) {
    const month = MONTHS[monthFirst[1].toLowerCase()];
    return datePartsToKey(Number(monthFirst[3]), month, Number(monthFirst[2]));
  }

  return null;
}

function parseOrderIdFromText(text: string): string | null {
  const standard = text.match(/\b(\d{3}-\d{7}-\d{7})\b/);
  if (standard) return standard[1];

  const uuid = text.match(
    /\b([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\b/i,
  );
  return uuid ? uuid[1] : null;
}

async function extractCancelledOrderListItems(
  card: Locator,
): Promise<CancelledOrderListItem[]> {
  const links = await card
    .locator('a[href*="/dp/"], a[href*="/gp/product/"]')
    .all();
  const dedupe = new Map<string, CancelledOrderListItem>();

  for (const link of links) {
    const productName = (await link.innerText().catch(() => "")).trim();
    const href = await link.getAttribute("href").catch(() => null);
    if (!productName || !href) continue;

    const asin = extractAsinFromUrl(href);
    if (!asin || dedupe.has(asin)) continue;

    const row = link.locator(
      "xpath=ancestor::*[contains(@class, 'a-fixed-left-grid')][1]",
    );
    const rowText = await row.innerText().catch(() => "");
    const quantityText = rowText.match(/\b(?:qty|quantity)\s*:?\s*(\d+)\b/i);
    const quantity = quantityText ? Number(quantityText[1]) : 1;
    if (!Number.isInteger(quantity) || quantity < 1) continue;

    dedupe.set(asin, { asin, productName, quantity });
  }

  return [...dedupe.values()];
}

async function getBrowserContext(
  diagnostics?: FailureDiagnostics,
): Promise<BrowserContext> {
  if (!browserContext) {
    diagnostics?.at("browser", "BROWSER_OPEN_FAILED");
    browserContext = await chromium.launchPersistentContext(BROWSER_DATA_DIR, {
      headless: false,
      viewport: { width: 1280, height: 800 },
    });
    browserContext.on("close", () => {
      browserContext = null;
      page = null;
    });
  }
  diagnostics?.browserVersion(browserContext.browser()?.version());
  return browserContext;
}

async function getPage(diagnostics?: FailureDiagnostics): Promise<Page> {
  const context = await getBrowserContext(diagnostics);
  if (!page || page.isClosed()) {
    const pages = context.pages();
    page = pages[0] || (await context.newPage());
  }
  return page;
}

async function isAuthenticated(targetPage: Page): Promise<boolean> {
  if (!targetPage.url().includes(DOMAIN)) {
    await targetPage.goto(`https://www.${DOMAIN}/gp/css/order-history`, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
  }

  if (isAuthenticationRedirect(targetPage.url())) {
    return false;
  }

  const signInControls = await targetPage
    .locator("#signInSubmit, #ap_email, #ap_password")
    .count()
    .catch(() => 0);
  return signInControls === 0;
}

export class AuthenticationRequiredError extends Error {
  constructor() {
    super("Amazon.in login required. Complete sign-in in the visible dedicated Chromium window, then retry.");
    this.name = "AuthenticationRequiredError";
  }
}

export function isAuthenticationRedirect(url: string): boolean {
  try {
    const pathname = new URL(url).pathname;
    return ["/ap/signin", "/ap/cvf"].some(
      (authPath) => pathname === authPath || pathname.startsWith(`${authPath}/`),
    );
  } catch {
    return false;
  }
}

async function requireAuthentication(targetPage: Page): Promise<void> {
  if (!(await isAuthenticated(targetPage))) {
    throw new AuthenticationRequiredError();
  }
}

function directHeader(orderId: string): OrderHeader {
  return {
    id: orderId,
    orderId,
    date: null,
    total: parseMoney("0", CURRENCY),
    detailUrl: `https://www.${DOMAIN}/gp/your-account/order-details?orderID=${orderId}`,
    platform: "amazon",
    region: REGION,
  };
}

type ListedCardKind = { funding: boolean; date: number; amount?: number };

interface OrderPageSelection {
  startKey: number;
  endKey: number;
  orderOffset: number;
  maxOrders: number;
  previousOrders?: MinimalOrder[];
  cardKinds?: Map<string, ListedCardKind>;
}

function assertMatchingListedFacts(
  previous: MinimalOrder,
  current: MinimalOrder,
): void {
  const amount = (order: MinimalOrder): number | undefined =>
    order.orderTotal === undefined ? undefined : Math.round(order.orderTotal.amount * 100);
  if (
    previous.orderDate !== current.orderDate ||
    previous.status !== current.status ||
    amount(previous) !== amount(current) ||
    previous.nowDetailUrl !== current.nowDetailUrl
  ) {
    throw new DiagnosticError(
      "list", "LIST_DUPLICATE_CONFLICT",
      "Duplicate order cards have conflicting facts.",
    );
  }
}

export async function parseCurrentOrderPage(
  targetPage: Page,
  diagnostics?: FailureDiagnostics,
  selection?: OrderPageSelection,
): Promise<MinimalOrder[]> {
  return (await readCurrentOrderPage(targetPage, diagnostics, selection)).orders;
}

async function readCurrentOrderPage(
  targetPage: Page,
  diagnostics?: FailureDiagnostics,
  selection?: OrderPageSelection,
): Promise<{ orders: MinimalOrder[]; dates: number[] }> {
  const cards = targetPage.locator(ORDER_CARD_SELECTOR);
  const count = await cards.count();
  const dedupe = new Map<string, MinimalOrder>();
  const known = new Map(selection?.previousOrders?.map((order) => [order.orderId, order]));
  const selectedIndexes = new Map(selection?.previousOrders?.map((order, index) => [order.orderId, index]));
  const previousCount = selectedIndexes.size;
  const cardKinds = selection?.cardKinds ?? new Map<string, ListedCardKind>();
  const dates: number[] = [];

  for (let i = 0; i < count; i++) {
    const card = cards.nth(i);
    if (!(await card.isVisible())) continue;
    const text = await card.innerText({ timeout: 1500 }).catch(() => "");
    if (!text) continue;

    const orderId = parseOrderIdFromText(text);
    const orderDateKey = parseOrderDateFromText(text);
    if (!orderId || orderDateKey === null) continue;
    const candidateIndex = selectedIndexes.get(orderId) ??
      ((selection?.orderOffset ?? 0) + selectedIndexes.size - previousCount);
    const inspectKind = !selection || candidateIndex < selection.maxOrders ||
      selectedIndexes.has(orderId) || cardKinds.has(orderId);
    const wallet = inspectKind
      ? await classifyWalletFundingCard(card, text, orderId, ORDER_CARD_SELECTOR)
      : "not-observed";
    const funding = wallet === "funding-only";
    const fundingTotal = funding ? await extractHeaderOrderTotal(card) : undefined;
    const fundingAmount = fundingTotal === undefined
      ? undefined : Math.round(fundingTotal.amount * 100);
    const previousKind = cardKinds.get(orderId);
    if (
      (previousKind && (
        previousKind.funding !== funding ||
        (funding && (
          previousKind.date !== orderDateKey ||
          previousKind.amount !== fundingAmount
        ))
      )) ||
      (funding && known.has(orderId))
    ) {
      throw new DiagnosticError(
        "list", "LIST_DUPLICATE_CONFLICT",
        "Duplicate order cards have conflicting facts or classification.",
      );
    }
    if (inspectKind) cardKinds.set(orderId, { funding, date: orderDateKey, amount: fundingAmount });
    dates.push(orderDateKey);
    if (funding) {
      if (!previousKind) {
        diagnostics?.walletFundingExcluded(
          [...cardKinds.values()].filter(kind => kind.funding).length,
        );
      }
      continue;
    }

    // Fully cancelled legacy cards omit totals and data-component item markup,
    // but retain paired image/title product links.
    const cancelled = /\b(?:cancelled|canceled)\b/i.test(text);
    const cancelledItems = cancelled
      ? await extractCancelledOrderListItems(card)
      : [];
    const order: MinimalOrder = {
      orderId,
      orderDate: keyToIso(orderDateKey),
      orderDateKey,
      status: cancelled ? "cancelled" : undefined,
      cancelledItems: cancelled ? cancelledItems : undefined,
    };
    const orderIndex = selectedIndexes.get(orderId) ??
      ((selection?.orderOffset ?? 0) + selectedIndexes.size - previousCount);
    const selected = selectedIndexes.has(orderId) || !selection || (
      orderDateKey >= selection.startKey &&
      orderDateKey <= selection.endKey &&
      orderIndex < selection.maxOrders
    );
    if (selected) {
      selectedIndexes.set(orderId, orderIndex);
      diagnostics?.select(order, orderIndex);
      if (wallet === "unverified") diagnostics?.note("list", "LIST_WALLET_LABEL_UNVERIFIED");
      if (wallet === "unavailable") diagnostics?.note("list", "LIST_WALLET_EVIDENCE_UNAVAILABLE");
      await recordWalletCardDiagnostic(card, text, ORDER_CARD_SELECTOR, diagnostics);
      diagnostics?.at("list", "LIST_TOTAL_READ_FAILED");
      order.nowDetailUrl = await discoverNowLink(card, targetPage.url(), orderId);
      const total = await extractHeaderOrderTotal(card);
      if (!total && !cancelled) {
        throw new DiagnosticError(
          "list", "LIST_TOTAL_MISSING",
          "Order card has no independently validated header total.",
        );
      }
      order.orderTotal = safeMoney(total);
    }
    const previous = dedupe.get(orderId) ?? known.get(orderId);
    if (previous && selected) assertMatchingListedFacts(previous, order);
    if (!dedupe.has(orderId)) dedupe.set(orderId, previous ?? order);
  }

  return { orders: [...dedupe.values()], dates };
}

async function getNextPageUrl(targetPage: Page): Promise<string | null> {
  const next = targetPage
    .locator("ul.a-pagination li.a-last:not(.a-disabled) a, .a-pagination .a-last:not(.a-disabled) a")
    .first();
  if ((await next.count().catch(() => 0)) === 0) return null;
  const href = await next.getAttribute("href").catch(() => null);
  if (!href) return null;
  return new URL(href, targetPage.url()).toString();
}

export async function listOrders(
  startDate: string,
  endDate: string,
  maxOrders: number,
  diagnostics?: FailureDiagnostics,
) {
  const startKey = parseInputDate(startDate);
  const endKey = parseInputDate(endDate);
  if (startKey > endKey)
    throw new Error("start_date must be on or before end_date.");

  const year = Math.trunc(endKey / 10000);
  if (Math.trunc(startKey / 10000) !== year) {
    throw new DiagnosticError(
      "list",
      "DATE_RANGE_UNSUPPORTED",
      "POC currently supports a date range within one calendar year.",
    );
  }

  const targetPage = await getPage(diagnostics);
  diagnostics?.at("list", "LIST_NAVIGATION_FAILED");
  await requireAuthentication(targetPage);

  let url: string | null =
    `https://www.${DOMAIN}/your-orders/orders?timeFilter=year-${year}&language=en_GB`;
  const matches: MinimalOrder[] = [];
  let pagesScanned = 0;
  const cardKinds = new Map<string, ListedCardKind>();

  while (url && pagesScanned < MAX_PAGES && matches.length < maxOrders) {
    diagnostics?.at("list", "LIST_NAVIGATION_FAILED");
    await targetPage.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    await requireAuthentication(targetPage);
    diagnostics?.at("list", "LIST_SELECTOR_MISSING");
    await targetPage.waitForSelector(ORDER_CARD_SELECTOR, { timeout: 3000 });
    diagnostics?.at("list", "LIST_FACTS_MISSING");

    diagnostics?.listed(matches, pagesScanned + 1);
    const parsed = await readCurrentOrderPage(targetPage, diagnostics, {
      startKey,
      endKey,
      orderOffset: matches.length,
      maxOrders,
      previousOrders: matches,
      cardKinds,
    });
    const pageOrders = parsed.orders;
    pagesScanned += 1;

    if (parsed.dates.length === 0) {
      throw new DiagnosticError(
        "list",
        "LIST_FACTS_MISSING",
        `Found order cards on page ${pagesScanned} but could not parse any order IDs/dates. Stop rather than scanning the whole year.`,
      );
    }

    for (const order of pageOrders) {
      if (order.orderDateKey >= startKey && order.orderDateKey <= endKey) {
        if (matches.some((previous) => previous.orderId === order.orderId)) continue;
        matches.push(order);
        if (matches.length >= maxOrders) break;
      }
    }

    diagnostics?.listed(matches, pagesScanned);
    const oldestKey = Math.min(
      ...pageOrders.map((order) => order.orderDateKey),
    );
    if (oldestKey < startKey || matches.length >= maxOrders) break;

    url = await getNextPageUrl(targetPage);
  }

  return {
    pagesScanned,
    orders: matches.map(({ orderDateKey: _orderDateKey, ...order }) => order),
  };
}

export function createCancelledOrderListDetail(
  orderId: string,
  listedOrder: ListedOrder | undefined,
  cancellationConfirmed: boolean,
  adjustments: OrderAdjustment[],
  detailOrderTotal?: Money,
) {
  // Require independent list/detail cancellation signals and no monetary rows.
  // The missing values remain missing; this does not synthesize a zero balance.
  if (
    !cancellationConfirmed ||
    listedOrder?.status !== "cancelled" ||
    listedOrder.orderTotal !== undefined ||
    !listedOrder.cancelledItems?.length ||
    adjustments.length !== 0 ||
    detailOrderTotal !== undefined
  ) {
    return null;
  }

  return {
    orderId,
    orderTotal: undefined,
    orderTotalSource: undefined,
    extractionSource: "cancelled-order-list",
    itemCount: listedOrder.cancelledItems.length,
    adjustments,
    items: listedOrder.cancelledItems.map((item) => ({
      asin: item.asin,
      productName: item.productName,
      quantity: item.quantity,
      unitPrice: undefined,
      itemTotal: undefined,
    })),
  };
}

export function preferCancelledOrderListDetail<T>(
  cancelledOrderListDetail: ReturnType<typeof createCancelledOrderListDetail>,
  _pricedDetailItems: T[],
): ReturnType<typeof createCancelledOrderListDetail> {
  // Once all cancellation safeguards produced this representation, detail-page
  // prices are not authoritative and must not displace the validated list data.
  return cancelledOrderListDetail;
}

export async function extractOrderItems(
  orderId: string,
  diagnostics?: ItemDiagnostics,
  listedOrder?: ListedOrder,
  trace?: FailureDiagnostics,
) {
  const targetPage = await getPage(trace);
  trace?.at("detail", "DETAIL_NAVIGATION_FAILED");
  await requireAuthentication(targetPage);
  if (listedOrder?.nowDetailUrl) {
    if (listedOrder.orderId !== orderId) {
      throw new DiagnosticError("detail", "DETAIL_ORDER_MISMATCH", "Selected order identity does not match.");
    }
    if (listedOrder.status === "cancelled") {
      throw new DiagnosticError("detail", "NOW_EXTRACTION_FAILED", "Amazon Now cancellation requires independently supported order facts.");
    }
    trace?.provenance("amazon-now-order-details");
    const detail = await extractNowOrder(targetPage, orderId, listedOrder.nowDetailUrl,
      () => requireAuthentication(targetPage), trace, listedOrder.orderTotal);
    trace?.detail(detail);
    return detail;
  }
  const header = directHeader(orderId);

  await targetPage.goto(header.detailUrl, {
    waitUntil: "domcontentloaded",
    timeout: 15000,
  });
  await requireAuthentication(targetPage);
  trace?.at("detail", "DETAIL_SELECTOR_MISSING");
  await targetPage
    .waitForSelector(
      '[data-component="purchasedItems"], .a-box, #od-subtotals',
      { timeout: 2500 },
    )
    .catch((error: unknown) => {
      trace?.noteFailure("detail", "DETAIL_SELECTOR_MISSING", error);
    });

  // Capture the bounded order summary before invoice fallback can navigate away.
  const adjustments = await extractOrderSummaryAdjustments(targetPage, trace);
  trace?.captureAdjustments(adjustments);
  const cancellationConfirmed =
    listedOrder?.status === "cancelled" &&
    (await targetPage
      .locator(
        '[data-component="cancelled"], [data-component="cancelledOrderBanner"]',
      )
      .count()
      .catch(() => 0)) > 0;

  // The list's TOTAL is an observation, not proof of gross purchase value.
  // Validate the detail source even for cancellations before admitting nulls.
  trace?.at("detail", "DETAIL_TOTAL_READ_FAILED");
  const allowMissingTotal = createCancelledOrderListDetail(
    orderId, listedOrder, cancellationConfirmed, adjustments,
  ) !== null;
  const detailOrderTotal = await extractDetailOrderTotal(
    targetPage, orderId, allowMissingTotal,
  );
  trace?.authoritativeTotal(detailOrderTotal);

  trace?.provenance("order-detail");
  trace?.at("items", "ITEM_EXTRACTION_FAILED");
  let items = await extractItems(targetPage, header, diagnostics).catch((error: unknown) => {
    trace?.noteFailure("items", "ITEM_EXTRACTION_FAILED", error);
    return [];
  });
  trace?.captureItems(
    items.map((item) => ({
      asin: item.asin,
      productName: item.name,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      itemTotal: item.totalPrice,
    })),
  );
  if (!items.length) trace?.note("items", "ITEMS_EMPTY");
  let source = "order-detail";

  const cancelledOrderListDetail = createCancelledOrderListDetail(
    orderId,
    listedOrder,
    cancellationConfirmed,
    adjustments,
    detailOrderTotal,
  );
  const preferredCancelledDetail = preferCancelledOrderListDetail(
    cancelledOrderListDetail,
    items,
  );
  if (preferredCancelledDetail) {
    trace?.note("items", "CANCELLED_LIST_USED");
    trace?.detail(preferredCancelledDetail);
    return preferredCancelledDetail;
  }

  if (items.length === 0) {
    trace?.provenance("invoice-safe-fallback");
    trace?.at("invoice", "INVOICE_NAVIGATION_FAILED");
    await targetPage.goto(getInvoiceUrl(orderId, DOMAIN), {
      waitUntil: "domcontentloaded",
      timeout: 12000,
    });
    await requireAuthentication(targetPage);
    trace?.at("invoice", "INVOICE_SELECTOR_MISSING");
    await targetPage
      .waitForSelector('[data-component="purchasedItems"], table', {
        timeout: 2000,
      })
      .catch((error: unknown) => {
        trace?.noteFailure("invoice", "INVOICE_SELECTOR_MISSING", error);
      });
    trace?.at("invoice", "INVOICE_EXTRACTION_FAILED");
    const invoiceItems = await extractDataComponentItems(
      targetPage,
      header,
      CURRENCY,
      diagnostics,
    ).catch((error: unknown) => {
      trace?.noteFailure("invoice", "INVOICE_EXTRACTION_FAILED", error);
      return null;
    });
    if (invoiceItems && invoiceItems.length > 0) {
      items = invoiceItems;
      source = "invoice-safe-fallback";
      trace?.note("invoice", "INVOICE_FALLBACK_USED");
    } else {
      trace?.note("invoice", "INVOICE_ITEMS_EMPTY");
    }
  }

  return {
    orderId,
    orderTotal: safeMoney(detailOrderTotal),
    orderTotalSource: "order-detail-grand-total" as const,
    extractionSource: source,
    itemCount: items.length,
    adjustments,
    items: items.map((item) => ({
      asin: item.asin,
      productName: item.name,
      quantity: item.quantity,
      unitPrice: safeMoney(item.unitPrice),
      itemTotal: safeMoney(item.totalPrice),
    })),
  };
}

const tools: Tool[] = [
  {
    name: "check_amazon_in_auth_status",
    description: "Check whether the dedicated local Chromium session is signed in to Amazon.in.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_amazon_in_orders",
    description: "List Amazon.in order IDs, dates and order-card total observations for a bounded date range. Priced JSON exports independently validate Order Details Grand Total. Returns no address, recipient or payment data.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "YYYY-MM-DD" },
        end_date: { type: "string", description: "YYYY-MM-DD" },
        max_orders: { type: "number", default: 20, description: "Default 20; hard maximum 50" },
      },
      required: ["start_date", "end_date"],
    },
  },
  {
    name: "get_amazon_in_order_items",
    description: "Read safe item-level details for one exact Amazon.in order ID. Excludes address, recipient, payment/card, gift-card and tracking data.",
    inputSchema: {
      type: "object",
      properties: {
        order_id: { type: "string", description: "Amazon order ID (standard 3-7-7 or Amazon Fresh UUID format)" },
      },
      required: ["order_id"],
    },
  },
];

const server = new Server(
  { name: "amazon-in-orders-hardened-poc-v3", version: "0.3.0-poc" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const args = request.params.arguments as Record<string, unknown> | undefined;

    if (request.params.name === "check_amazon_in_auth_status") {
      const authenticated = await isAuthenticated(await getPage());
      return { content: [{ type: "text", text: JSON.stringify({ region: REGION, authenticated }, null, 2) }] };
    }

    if (request.params.name === "list_amazon_in_orders") {
      const startDate = String(args?.start_date ?? "");
      const endDate = String(args?.end_date ?? "");
      const requestedMax = Number(args?.max_orders ?? 20);
      const maxOrders = Math.max(1, Math.min(50, Math.trunc(requestedMax || 20)));
      const result = await listOrders(startDate, endDate, maxOrders);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { region: REGION, pagesScanned: result.pagesScanned, orderCount: result.orders.length, orders: result.orders },
              null,
              2,
            ),
          },
        ],
      };
    }

    if (request.params.name === "get_amazon_in_order_items") {
      const orderId = String(args?.order_id ?? "");
      const standard = /^\d{3}-\d{7}-\d{7}$/;
      const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
      if (!standard.test(orderId) && !uuid.test(orderId)) {
        throw new Error("order_id must be a standard Amazon order ID or Amazon Fresh UUID.");
      }
      const result = await extractOrderItems(orderId);
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    }

    throw new Error(`Unknown tool: ${request.params.name}`);
  } catch (error) {
    return {
      isError: true,
      content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
    };
  }
});

export async function closeBrowser(): Promise<void> {
  if (browserContext) await browserContext.close().catch(() => {});
}

async function shutdown(): Promise<void> {
  await closeBrowser();
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[amazon-in-orders-hardened-poc-v3] Ready. Browser profile: ${BROWSER_DATA_DIR}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Unexpected POC error.");
    process.exit(1);
  });
}
