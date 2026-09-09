#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { chromium, BrowserContext, Page } from "playwright";
import { homedir } from "os";
import { join } from "path";

import { AmazonPlugin } from "../amazon/adapter";
import { extractDataComponentItems } from "../amazon/extractors/items";
import { getInvoiceUrl } from "../amazon/extractors/invoice";
import { goToNextPage, hasNextPage } from "../amazon/extractors";
import { Money, parseMoney } from "../core/types/money";
import { OrderHeader } from "../core/types/order";

const REGION = "in";
const DOMAIN = "amazon.in";
const CURRENCY = "INR";
const BROWSER_DATA_DIR = join(
  homedir(),
  ".amazon-order-history-poc",
  "browser-data",
);

const amazon = new AmazonPlugin();
let browserContext: BrowserContext | null = null;
let page: Page | null = null;

type SafeAmounts = {
  subtotal?: Money;
  shipping?: Money;
  tax?: Money;
  promotion?: Money;
  total?: Money;
};

function safeMoney(value: Money | undefined) {
  if (!value) return undefined;
  return {
    amount: value.amount,
    currency: value.currency,
    formatted: value.formatted,
  };
}

function dateKey(value: Date): number {
  return value.getFullYear() * 10000 + (value.getMonth() + 1) * 100 + value.getDate();
}

function parseDateKey(value: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid date: ${value}. Use YYYY-MM-DD.`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const check = new Date(year, month - 1, day);
  if (
    check.getFullYear() !== year ||
    check.getMonth() !== month - 1 ||
    check.getDate() !== day
  ) {
    throw new Error(`Invalid date: ${value}. Use YYYY-MM-DD.`);
  }
  return year * 10000 + month * 100 + day;
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
      timeout: 60000,
    });
  }

  if (
    targetPage.url().includes("/ap/signin") ||
    targetPage.url().includes("/ap/cvf")
  ) {
    return false;
  }

  const signInControls = await targetPage
    .locator("#signInSubmit, #ap_email, #ap_password")
    .count()
    .catch(() => 0);
  return signInControls === 0;
}

async function requireAuthentication(targetPage: Page): Promise<void> {
  if (!(await isAuthenticated(targetPage))) {
    throw new Error(
      "Amazon.in login required. Complete sign-in in the visible dedicated Chromium window, then retry.",
    );
  }
}

async function extractSafeAmounts(targetPage: Page): Promise<SafeAmounts> {
  const result: SafeAmounts = {};
  const summary = targetPage.locator('[data-component="chargeSummary"]').first();

  if ((await summary.count().catch(() => 0)) > 0) {
    const rows = await summary.locator(".od-line-item-row").all();
    for (const row of rows) {
      const label =
        (await row
          .locator(".od-line-item-row-label")
          .textContent({ timeout: 300 })
          .catch(() => "")) || "";
      const amount =
        (await row
          .locator(".od-line-item-row-content")
          .textContent({ timeout: 300 })
          .catch(() => "")) || "";
      const normalized = label.toLowerCase();
      const parsed = parseMoney(amount.trim(), CURRENCY);

      if (normalized.includes("subtotal") && !normalized.includes("before")) {
        result.subtotal = parsed;
      } else if (
        normalized.includes("shipping") ||
        normalized.includes("postage") ||
        normalized.includes("delivery")
      ) {
        result.shipping = parsed;
      } else if (
        normalized.includes("tax") ||
        normalized.includes("gst") ||
        normalized.includes("vat")
      ) {
        result.tax = parsed;
      } else if (
        normalized.includes("promotion") ||
        normalized.includes("discount")
      ) {
        result.promotion = parsed;
      } else if (
        normalized.includes("grand total") ||
        (normalized.includes("total") && !normalized.includes("subtotal"))
      ) {
        result.total = parsed;
      }
    }
  }

  if (!result.total) {
    const bodyText = (await targetPage.textContent("body").catch(() => "")) || "";
    const totalMatch = bodyText.match(
      /(?:Grand\s*Total|Order\s*Total|Total\s*for\s*this\s*Order)\s*:?\s*(₹\s*[\d,]+(?:\.\d{1,2})?)/i,
    );
    if (totalMatch) result.total = parseMoney(totalMatch[1], CURRENCY);
  }

  return result;
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

async function extractSafeOrder(header: OrderHeader) {
  const targetPage = await getPage();
  await requireAuthentication(targetPage);

  await targetPage.goto(header.detailUrl, {
    waitUntil: "domcontentloaded",
    timeout: 30000,
  });
  await targetPage
    .waitForSelector('[data-component="purchasedItems"], .a-box, #od-subtotals', {
      timeout: 3000,
    })
    .catch(() => {});

  if (
    targetPage.url().includes("/ap/signin") ||
    targetPage.url().includes("/ap/cvf")
  ) {
    throw new Error("Amazon.in session expired; sign in again and retry.");
  }

  let items = await amazon.extractItems(targetPage, header).catch(() => []);
  let amounts = await extractSafeAmounts(targetPage);
  let extractionSource = "order-detail";

  if (items.length === 0) {
    const invoiceUrl = getInvoiceUrl(header.orderId, DOMAIN);
    await targetPage.goto(invoiceUrl, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    await targetPage
      .waitForSelector('[data-component="purchasedItems"], [data-component="chargeSummary"], table', {
        timeout: 3000,
      })
      .catch(() => {});

    const invoiceItems = await extractDataComponentItems(
      targetPage,
      header,
      CURRENCY,
    ).catch(() => null);
    if (invoiceItems && invoiceItems.length > 0) {
      items = invoiceItems;
      extractionSource = "invoice-safe-fallback";
    }

    const invoiceAmounts = await extractSafeAmounts(targetPage);
    amounts = {
      subtotal: invoiceAmounts.subtotal ?? amounts.subtotal,
      shipping: invoiceAmounts.shipping ?? amounts.shipping,
      tax: invoiceAmounts.tax ?? amounts.tax,
      promotion: invoiceAmounts.promotion ?? amounts.promotion,
      total: invoiceAmounts.total ?? amounts.total,
    };
  }

  const orderTotal =
    header.total.amount > 0 ? header.total : amounts.total;

  return {
    orderId: header.orderId,
    orderDate: header.date ? header.date.toISOString().slice(0, 10) : null,
    orderTotal: safeMoney(orderTotal),
    subtotal: safeMoney(amounts.subtotal),
    shipping: safeMoney(amounts.shipping),
    tax: safeMoney(amounts.tax),
    promotion: safeMoney(amounts.promotion),
    extractionSource,
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

async function findRecentHeaders(
  startDate: string,
  endDate: string,
  maxOrders: number,
): Promise<OrderHeader[]> {
  const startKey = parseDateKey(startDate);
  const endKey = parseDateKey(endDate);
  if (startKey > endKey) throw new Error("start_date must be on or before end_date.");

  const startYear = Math.floor(startKey / 10000);
  const endYear = Math.floor(endKey / 10000);
  const targetPage = await getPage();
  await requireAuthentication(targetPage);
  const headers: OrderHeader[] = [];

  for (let year = endYear; year >= startYear && headers.length < maxOrders; year--) {
    await targetPage.goto(amazon.getOrderListUrl(REGION, { year }), {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
    await targetPage
      .waitForSelector('.order-card, [class*="order-card"], .a-box-group', {
        timeout: 3000,
      })
      .catch(() => {});
    await requireAuthentication(targetPage);

    let morePages = true;
    while (morePages && headers.length < maxOrders) {
      const pageHeaders = await amazon.extractOrderHeaders(targetPage, REGION);
      for (const header of pageHeaders) {
        if (!header.date) continue;
        const key = dateKey(header.date);
        if (key >= startKey && key <= endKey) {
          headers.push(header);
          if (headers.length >= maxOrders) break;
        }
      }

      if (headers.length >= maxOrders) break;
      morePages = await hasNextPage(targetPage);
      if (morePages && !(await goToNextPage(targetPage))) break;
    }
  }

  return headers;
}

const tools: Tool[] = [
  {
    name: "check_amazon_in_auth_status",
    description:
      "Check whether the dedicated local Chromium session is signed in to Amazon.in. Returns no username, address, payment method, or card data.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_amazon_in_order_items",
    description:
      "Read item names, quantities, item prices, and safe order totals for one Amazon.in order. Excludes recipient, address, payment method, card data, gift cards, tracking, and invoice downloads.",
    inputSchema: {
      type: "object",
      properties: {
        order_id: {
          type: "string",
          description: "Amazon order ID in XXX-XXXXXXX-XXXXXXX format",
        },
      },
      required: ["order_id"],
    },
  },
  {
    name: "get_recent_amazon_in_items",
    description:
      "Read Amazon.in orders and item-level prices for a bounded date range for Fold reconciliation. Excludes recipient, address, payment method, card data, gift cards, tracking, and invoice downloads.",
    inputSchema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "YYYY-MM-DD" },
        end_date: { type: "string", description: "YYYY-MM-DD" },
        max_orders: {
          type: "number",
          description: "Maximum orders to inspect; default 20, hard maximum 50",
          default: 20,
        },
      },
      required: ["start_date", "end_date"],
    },
  },
];

const server = new Server(
  { name: "amazon-in-orders-hardened-poc", version: "0.1.0-poc" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const name = request.params.name;
    const args = request.params.arguments as Record<string, unknown> | undefined;

    if (name === "check_amazon_in_auth_status") {
      const authenticated = await isAuthenticated(await getPage());
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ region: REGION, authenticated }, null, 2),
          },
        ],
      };
    }

    if (name === "get_amazon_in_order_items") {
      const orderId = String(args?.order_id ?? "");
      if (!/^\d{3}-\d{7}-\d{7}$/.test(orderId)) {
        throw new Error("order_id must use XXX-XXXXXXX-XXXXXXX format.");
      }
      const order = await extractSafeOrder(directHeader(orderId));
      return {
        content: [{ type: "text", text: JSON.stringify(order, null, 2) }],
      };
    }

    if (name === "get_recent_amazon_in_items") {
      const startDate = String(args?.start_date ?? "");
      const endDate = String(args?.end_date ?? "");
      const requestedMax = Number(args?.max_orders ?? 20);
      const maxOrders = Math.max(1, Math.min(50, Math.trunc(requestedMax || 20)));
      const headers = await findRecentHeaders(startDate, endDate, maxOrders);
      const orders = [];
      for (const header of headers) orders.push(await extractSafeOrder(header));
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { region: REGION, orderCount: orders.length, orders },
              null,
              2,
            ),
          },
        ],
      };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: error instanceof Error ? error.message : String(error),
        },
      ],
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
  console.error(
    `[amazon-in-orders-hardened-poc] Ready. Browser profile: ${BROWSER_DATA_DIR}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
