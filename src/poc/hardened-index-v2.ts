#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, Tool } from "@modelcontextprotocol/sdk/types.js";
import { chromium, BrowserContext, Page } from "playwright";
import { homedir } from "os";
import { join } from "path";

import { AmazonPlugin } from "../amazon/adapter";
import { goToNextPage, hasNextPage } from "../amazon/extractors";
import { extractDataComponentItems } from "../amazon/extractors/items";
import { getInvoiceUrl } from "../amazon/extractors/invoice";
import { Money, parseMoney } from "../core/types/money";
import { OrderHeader } from "../core/types/order";

const REGION = "in";
const DOMAIN = "amazon.in";
const CURRENCY = "INR";
const BROWSER_DATA_DIR = join(homedir(), ".amazon-order-history-poc", "browser-data");

const amazon = new AmazonPlugin();
let browserContext: BrowserContext | null = null;
let page: Page | null = null;

function safeMoney(value: Money | undefined) {
  if (!value) return undefined;
  return { amount: value.amount, currency: value.currency, formatted: value.formatted };
}

function dateKey(value: Date): number {
  return value.getFullYear() * 10000 + (value.getMonth() + 1) * 100 + value.getDate();
}

function parseDateKey(value: string): number {
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
      timeout: 30000,
    });
  }
  if (targetPage.url().includes("/ap/signin") || targetPage.url().includes("/ap/cvf")) return false;
  const signInControls = await targetPage.locator("#signInSubmit, #ap_email, #ap_password").count().catch(() => 0);
  return signInControls === 0;
}

async function requireAuthentication(targetPage: Page): Promise<void> {
  if (!(await isAuthenticated(targetPage))) {
    throw new Error("Amazon.in login required. Complete sign-in in the visible dedicated Chromium window, then retry.");
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

async function listOrders(startDate: string, endDate: string, maxOrders: number) {
  const startKey = parseDateKey(startDate);
  const endKey = parseDateKey(endDate);
  if (startKey > endKey) throw new Error("start_date must be on or before end_date.");

  const targetPage = await getPage();
  await requireAuthentication(targetPage);
  const endYear = Math.floor(endKey / 10000);
  const startYear = Math.floor(startKey / 10000);
  const matches: OrderHeader[] = [];

  for (let year = endYear; year >= startYear && matches.length < maxOrders; year--) {
    await targetPage.goto(amazon.getOrderListUrl(REGION, { year }), {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    await targetPage.waitForSelector('.order-card, [class*="order-card"], .a-box-group', { timeout: 3000 }).catch(() => {});
    await requireAuthentication(targetPage);

    let more = true;
    while (more && matches.length < maxOrders) {
      const headers = await amazon.extractOrderHeaders(targetPage, REGION);
      const dated = headers.filter((h) => h.date);

      for (const header of dated) {
        const key = dateKey(header.date!);
        if (key >= startKey && key <= endKey) {
          matches.push(header);
          if (matches.length >= maxOrders) break;
        }
      }

      // Amazon order history is newest-first. Once a page contains orders older
      // than the requested start date, there is no reason to continue paging.
      const crossedStartBoundary = dated.some((h) => dateKey(h.date!) < startKey);
      if (crossedStartBoundary || matches.length >= maxOrders) break;

      more = await hasNextPage(targetPage);
      if (more && !(await goToNextPage(targetPage))) break;
    }
  }

  return matches.map((h) => ({
    orderId: h.orderId,
    orderDate: h.date ? h.date.toISOString().slice(0, 10) : null,
    orderTotal: safeMoney(h.total),
    itemCount: h.itemCount ?? null,
  }));
}

async function extractOrderItems(orderId: string) {
  const targetPage = await getPage();
  await requireAuthentication(targetPage);
  const header = directHeader(orderId);

  await targetPage.goto(header.detailUrl, { waitUntil: "domcontentloaded", timeout: 20000 });
  await targetPage.waitForSelector('[data-component="purchasedItems"], .a-box, #od-subtotals', { timeout: 2500 }).catch(() => {});

  if (targetPage.url().includes("/ap/signin") || targetPage.url().includes("/ap/cvf")) {
    throw new Error("Amazon.in session expired; sign in again and retry.");
  }

  let items = await amazon.extractItems(targetPage, header).catch(() => []);
  let source = "order-detail";

  if (items.length === 0) {
    await targetPage.goto(getInvoiceUrl(orderId, DOMAIN), { waitUntil: "domcontentloaded", timeout: 15000 });
    await targetPage.waitForSelector('[data-component="purchasedItems"], table', { timeout: 2000 }).catch(() => {});
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
    description: "Quickly list Amazon.in order IDs, dates and totals for a bounded date range without opening each order detail page.",
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
        order_id: { type: "string", description: "Amazon order ID in XXX-XXXXXXX-XXXXXXX format" },
      },
      required: ["order_id"],
    },
  },
];

const server = new Server(
  { name: "amazon-in-orders-hardened-poc-v2", version: "0.2.0-poc" },
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
      const orders = await listOrders(startDate, endDate, maxOrders);
      return { content: [{ type: "text", text: JSON.stringify({ region: REGION, orderCount: orders.length, orders }, null, 2) }] };
    }

    if (request.params.name === "get_amazon_in_order_items") {
      const orderId = String(args?.order_id ?? "");
      if (!/^\d{3}-\d{7}-\d{7}$/.test(orderId)) throw new Error("order_id must use XXX-XXXXXXX-XXXXXXX format.");
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

async function shutdown(): Promise<void> {
  if (browserContext) await browserContext.close().catch(() => {});
  process.exit(0);
}

process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[amazon-in-orders-hardened-poc-v2] Ready. Browser profile: ${BROWSER_DATA_DIR}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
