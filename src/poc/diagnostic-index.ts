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

const DOMAIN = "amazon.in";
const BROWSER_DATA_DIR = join(
  homedir(),
  ".amazon-order-history-poc",
  "browser-data",
);

let browserContext: BrowserContext | null = null;
let page: Page | null = null;

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
    await targetPage
      .goto(`https://www.${DOMAIN}/gp/css/order-history`, {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      })
      .catch(() => null);
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

async function diagnoseOrderList(year: number) {
  const targetPage = await getPage();
  const authenticated = await isAuthenticated(targetPage);
  if (!authenticated) {
    return {
      authenticated: false,
      message: "Amazon.in login required",
    };
  }

  const requestedUrl = `https://www.${DOMAIN}/your-orders/orders?timeFilter=year-${year}&language=en_GB`;
  const startedAt = Date.now();
  let navigationError: string | null = null;

  try {
    await targetPage.goto(requestedUrl, {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
  } catch (error) {
    navigationError = error instanceof Error ? error.message : String(error);
  }

  const navigationElapsedMs = Date.now() - startedAt;
  await targetPage.waitForTimeout(500);

  const selectors = [
    '[data-component="orderCard"]',
    ".js-order-card",
    ".order-card",
    "#orderCard",
    ".a-box-group.order",
    '[class*="order-card"]',
    ".your-orders-content-container .a-box-group",
    ".order-row",
    '[data-testid="order-card"]',
  ];

  const selectorCounts: Record<string, number> = {};
  for (const selector of selectors) {
    selectorCounts[selector] = await targetPage
      .locator(selector)
      .count()
      .catch(() => -1);
  }

  const nextPageCount = await targetPage
    .locator(
      "ul.a-pagination li.a-last:not(.a-disabled) a, .a-pagination .a-last:not(.a-disabled) a",
    )
    .count()
    .catch(() => -1);

  const title = await targetPage.title().catch(() => "");
  const readyState = await targetPage
    .evaluate("document.readyState")
    .catch(() => "unknown");
  const bodyText = await targetPage
    .locator("body")
    .innerText({ timeout: 2000 })
    .catch(() => "");

  const standardOrderIdCount = (
    bodyText.match(/\b\d{3}-\d{7}-\d{7}\b/g) || []
  ).length;
  const uuidOrderIdCount = (
    bodyText.match(
      /\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/gi,
    ) || []
  ).length;

  return {
    authenticated: true,
    requestedYear: year,
    navigationElapsedMs,
    navigationTimedOut: Boolean(navigationError),
    navigationError,
    finalUrl: targetPage.url(),
    title,
    readyState,
    selectorCounts,
    nextPageCount,
    standardOrderIdCount,
    uuidOrderIdCount,
    signInControlCount: await targetPage
      .locator("#signInSubmit, #ap_email, #ap_password")
      .count()
      .catch(() => -1),
  };
}

const tools: Tool[] = [
  {
    name: "check_amazon_in_auth_status",
    description: "Check whether the dedicated local Chromium session is signed in to Amazon.in.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "diagnose_amazon_in_order_list",
    description:
      "Safely diagnose Amazon.in order-list loading using only URL/title, selector counts, order-ID counts and timing. Returns no order contents, addresses, recipient, payment, card or gift-card data.",
    inputSchema: {
      type: "object",
      properties: {
        year: {
          type: "number",
          description: "Order-history year to inspect; default 2026",
          default: 2026,
        },
      },
    },
  },
];

const server = new Server(
  { name: "amazon-in-orders-diagnostic-poc", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    if (request.params.name === "check_amazon_in_auth_status") {
      const authenticated = await isAuthenticated(await getPage());
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ region: "in", authenticated }, null, 2),
          },
        ],
      };
    }

    if (request.params.name === "diagnose_amazon_in_order_list") {
      const args = request.params.arguments as Record<string, unknown> | undefined;
      const requestedYear = Number(args?.year ?? 2026);
      const year = Math.max(2000, Math.min(2100, Math.trunc(requestedYear)));
      const result = await diagnoseOrderList(year);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    }

    throw new Error(`Unknown tool: ${request.params.name}`);
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
    `[amazon-in-orders-diagnostic-poc] Ready. Browser profile: ${BROWSER_DATA_DIR}`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
