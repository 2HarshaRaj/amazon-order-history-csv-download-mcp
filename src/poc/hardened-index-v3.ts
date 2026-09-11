#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from "@modelcontextprotocol/sdk/types.js";
import { chromium, BrowserContext, Page } from "playwright";
import { homedir } from "os";
import { join } from "path";

import { AmazonPlugin } from "../amazon/adapter";
import { extractDataComponentItems } from "../amazon/extractors/items";
import { getInvoiceUrl } from "../amazon/extractors/invoice";
import { Money, parseMoney } from "../core/types/money";
import { OrderHeader } from "../core/types/order";

const REGION = "in";
const DOMAIN = "amazon.in";
const CURRENCY = "INR";
export const BROWSER_DATA_DIR = join(homedir(), ".amazon-order-history-poc", "browser-data");
const ORDER_CARD_SELECTOR = ".js-order-card, .order-card, [class*=\"order-card\"]";
const MAX_PAGES = 20;

const amazon = new AmazonPlugin();
let browserContext: BrowserContext | null = null;
let page: Page | null = null;

type MinimalOrder = {
  orderId: string;
  orderDate: string;
  orderDateKey: number;
  orderTotal?: ReturnType<typeof safeMoney>;
};

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

function parseOrderTotalFromText(text: string): Money | undefined {
  const labeled = text.match(
    /(?:Order\s*Total|Total)\s*\n?\s*(?:₹|INR\s*)?\s*([\d,]+(?:\.\d{1,2})?)/i,
  );
  if (labeled) return parseMoney(`₹${labeled[1]}`, CURRENCY);

  const rupee = text.match(/₹\s*([\d,]+(?:\.\d{1,2})?)/);
  return rupee ? parseMoney(`₹${rupee[1]}`, CURRENCY) : undefined;
}

async function getBrowserContext(): Promise<BrowserContext> {
  if (!browserContext) {
    browserContext = await chromium.launchPersistentContext(BROWSER_DATA_DIR, {
      headless: false,
      viewport: { width: 1280, height: 800 },
    });
    browserContext.on("close", () => {
      browserContext = null;
      page = null;
    });
  }
  return browserContext;
}

async function getPage(): Promise<Page> {
  const context = await getBrowserContext();
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

async function parseCurrentOrderPage(targetPage: Page): Promise<MinimalOrder[]> {
  const cards = targetPage.locator(ORDER_CARD_SELECTOR);
  const count = await cards.count();
  const dedupe = new Map<string, MinimalOrder>();

  for (let i = 0; i < count; i++) {
    const text = await cards.nth(i).innerText({ timeout: 1500 }).catch(() => "");
    if (!text) continue;

    const orderId = parseOrderIdFromText(text);
    const orderDateKey = parseOrderDateFromText(text);
    if (!orderId || orderDateKey === null) continue;

    dedupe.set(orderId, {
      orderId,
      orderDate: keyToIso(orderDateKey),
      orderDateKey,
      orderTotal: safeMoney(parseOrderTotalFromText(text)),
    });
  }

  return [...dedupe.values()];
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

export async function listOrders(startDate: string, endDate: string, maxOrders: number) {
  const startKey = parseInputDate(startDate);
  const endKey = parseInputDate(endDate);
  if (startKey > endKey) throw new Error("start_date must be on or before end_date.");

  const year = Math.trunc(endKey / 10000);
  if (Math.trunc(startKey / 10000) !== year) {
    throw new Error("POC currently supports a date range within one calendar year.");
  }

  const targetPage = await getPage();
  await requireAuthentication(targetPage);

  let url: string | null = `https://www.${DOMAIN}/your-orders/orders?timeFilter=year-${year}&language=en_GB`;
  const matches: MinimalOrder[] = [];
  let pagesScanned = 0;

  while (url && pagesScanned < MAX_PAGES && matches.length < maxOrders) {
    await targetPage.goto(url, { waitUntil: "domcontentloaded", timeout: 15000 });
    await requireAuthentication(targetPage);
    await targetPage.waitForSelector(ORDER_CARD_SELECTOR, { timeout: 3000 });

    const pageOrders = await parseCurrentOrderPage(targetPage);
    pagesScanned += 1;

    if (pageOrders.length === 0) {
      throw new Error(
        `Found order cards on page ${pagesScanned} but could not parse any order IDs/dates. Stop rather than scanning the whole year.`,
      );
    }

    for (const order of pageOrders) {
      if (order.orderDateKey >= startKey && order.orderDateKey <= endKey) {
        matches.push(order);
        if (matches.length >= maxOrders) break;
      }
    }

    const oldestKey = Math.min(...pageOrders.map((order) => order.orderDateKey));
    if (oldestKey < startKey || matches.length >= maxOrders) break;

    url = await getNextPageUrl(targetPage);
  }

  return {
    pagesScanned,
    orders: matches.map(({ orderDateKey: _orderDateKey, ...order }) => order),
  };
}

export async function extractOrderItems(orderId: string) {
  const targetPage = await getPage();
  await requireAuthentication(targetPage);
  const header = directHeader(orderId);

  await targetPage.goto(header.detailUrl, { waitUntil: "domcontentloaded", timeout: 15000 });
  await requireAuthentication(targetPage);
  await targetPage
    .waitForSelector('[data-component="purchasedItems"], .a-box, #od-subtotals', { timeout: 2500 })
    .catch(() => {});

  let items = await amazon.extractItems(targetPage, header).catch(() => []);
  let source = "order-detail";

  if (items.length === 0) {
    await targetPage.goto(getInvoiceUrl(orderId, DOMAIN), {
      waitUntil: "domcontentloaded",
      timeout: 12000,
    });
    await requireAuthentication(targetPage);
    await targetPage
      .waitForSelector('[data-component="purchasedItems"], table', { timeout: 2000 })
      .catch(() => {});
    const invoiceItems = await extractDataComponentItems(targetPage, header, CURRENCY).catch(() => null);
    if (invoiceItems && invoiceItems.length > 0) {
      items = invoiceItems;
      source = "invoice-safe-fallback";
    }
  }

  return {
    orderId,
    extractionSource: source,
    itemCount: items.length,
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
    description: "List Amazon.in order IDs, dates and totals for a bounded date range using an India-specific minimal parser. Returns no address, recipient or payment data.",
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
