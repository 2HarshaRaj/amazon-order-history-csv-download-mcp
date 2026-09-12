#!/usr/bin/env node

import { mkdir, rename, rm, writeFile } from "fs/promises";
import { randomUUID } from "crypto";
import { dirname, isAbsolute, relative, resolve, sep } from "path";
import type { ItemDiagnostics } from "../amazon/extractors/items";

import {
  AuthenticationRequiredError,
  closeBrowser,
  extractOrderItems,
  listOrders,
  parseInputDate,
} from "./hardened-index-v3";

const MAX_ORDERS = 50;
const DEFAULT_MAX_ORDERS = 20;
const CURRENCY = "INR";

type SafeMoney = { amount: number; currency: string };
type ListedOrder = Awaited<ReturnType<typeof listOrders>>["orders"][number];
type ExtractedItems = Awaited<ReturnType<typeof extractOrderItems>>;

export interface CliOptions {
  startDate: string;
  endDate: string;
  maxOrders: number;
  output: string;
}

export interface JsonItem {
  lineIndex: number;
  asin: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  itemTotal: number;
  currency: "INR";
  extractionSource: string;
}

export interface JsonOrder {
  orderId: string;
  orderDate: string;
  orderTotal: number;
  currency: "INR";
  orderUrl: string;
  extractedAt: string;
  items: JsonItem[];
  adjustments: JsonAdjustment[];
}

export interface JsonAdjustment {
  adjustmentIndex: number;
  type:
    | "shipping"
    | "marketplace_fee"
    | "discount"
    | "promotion"
    | "tax"
    | "gift_wrap"
    | "other";
  label: string;
  amount: number;
  currency: "INR";
  extractionSource: "order-detail-summary";
}

export interface JsonExport {
  metadata: { windowStart: string; windowEnd: string; pagesScanned: number };
  orders: JsonOrder[];
}

interface ExportLifecycleDependencies {
  run: (options: CliOptions) => Promise<void>;
  close: () => Promise<void>;
}

interface ExportRunDependencies {
  list: typeof listOrders;
  extract: typeof extractOrderItems;
  write: typeof validateAndWriteExport;
}

interface OutputPathOperations {
  isAbsolute(path: string): boolean;
  relative(from: string, to: string): string;
  resolve(path: string): string;
  sep: string;
}

const AUTH_REQUIRED_MESSAGE =
  "Amazon.in login required. Complete sign-in/OTP in the visible dedicated Chromium window, then rerun the command. The browser has been left open.";

/** Discard extractor diagnostics because they can contain personal order data. */
export const privacySafeItemDiagnostics: ItemDiagnostics = () => {};

function optionValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} requires a value.`);
  return value;
}

export function parseCliOptions(
  argv: string[],
  repositoryRoot = process.cwd(),
): CliOptions {
  const known = new Set([
    "--start-date",
    "--end-date",
    "--max-orders",
    "--output",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    if (!known.has(argv[index]))
      throw new Error(`Unknown argument: ${argv[index] ?? "(missing)"}.`);
  }

  const startDate = optionValue(argv, "--start-date");
  const endDate = optionValue(argv, "--end-date");
  const outputArg = optionValue(argv, "--output");
  if (!startDate || !endDate)
    throw new Error(
      "Both --start-date and --end-date are required (YYYY-MM-DD).",
    );
  if (!outputArg)
    throw new Error(
      "--output is required and must point outside the repository.",
    );
  const startKey = parseInputDate(startDate);
  const endKey = parseInputDate(endDate);
  if (startKey > endKey)
    throw new Error("--start-date must be on or before --end-date.");

  const maxText = optionValue(argv, "--max-orders");
  const maxOrders =
    maxText === undefined ? DEFAULT_MAX_ORDERS : Number(maxText);
  if (!Number.isInteger(maxOrders) || maxOrders < 1 || maxOrders > MAX_ORDERS) {
    throw new Error("--max-orders must be an integer from 1 through 50.");
  }

  const output = validateOutputPath(outputArg, repositoryRoot);
  return { startDate, endDate, maxOrders, output };
}

export function validateOutputPath(
  outputArg: string,
  repositoryRoot: string,
  pathOperations: OutputPathOperations = {
    isAbsolute,
    relative,
    resolve,
    sep,
  },
): string {
  const output = pathOperations.resolve(outputArg);
  const root = pathOperations.resolve(repositoryRoot);
  const fromRoot = pathOperations.relative(root, output);
  if (
    !pathOperations.isAbsolute(outputArg) ||
    fromRoot === "" ||
    (fromRoot !== ".." &&
      !fromRoot.startsWith(`..${pathOperations.sep}`) &&
      !pathOperations.isAbsolute(fromRoot))
  ) {
    throw new Error(
      "--output must be an absolute path outside the repository.",
    );
  }
  return output;
}

function numericMoney(value: SafeMoney | undefined, label: string): number {
  if (
    !value ||
    value.currency !== CURRENCY ||
    !Number.isFinite(value.amount) ||
    value.amount < 0
  ) {
    throw new Error(
      `Export validation failed: ${label} must be a non-negative numeric INR amount.`,
    );
  }
  return value.amount;
}

function adjustmentMoney(value: SafeMoney | undefined): number {
  if (!value || value.currency !== CURRENCY || !Number.isFinite(value.amount)) {
    throw new Error("Export validation failed: invalid order adjustment.");
  }
  return value.amount;
}

export function createExportDocument(
  options: Pick<CliOptions, "startDate" | "endDate">,
  pagesScanned: number,
  orders: Array<{ summary: ListedOrder; detail: ExtractedItems }>,
  extractedAt: string,
): JsonExport {
  if (!Number.isInteger(pagesScanned) || pagesScanned < 0)
    throw new Error("Export validation failed: invalid page count.");
  if (Number.isNaN(Date.parse(extractedAt)))
    throw new Error("Export validation failed: invalid extraction timestamp.");

  const jsonOrders = orders.map(({ summary, detail }): JsonOrder => {
    if (
      !summary.orderId ||
      !summary.orderDate ||
      detail.orderId !== summary.orderId
    ) {
      throw new Error(
        "Export validation failed: missing or mismatched required order facts.",
      );
    }
    const orderTotal = numericMoney(summary.orderTotal, "order total");
    const items = detail.items.map((item, lineIndex): JsonItem => {
      if (
        !item.productName ||
        !Number.isInteger(item.quantity) ||
        item.quantity < 1
      ) {
        throw new Error(
          "Export validation failed: invalid required item facts.",
        );
      }
      return {
        lineIndex,
        asin: item.asin ?? "",
        productName: item.productName,
        quantity: item.quantity,
        unitPrice: numericMoney(item.unitPrice, "unit price"),
        itemTotal: numericMoney(item.itemTotal, "item total"),
        currency: CURRENCY,
        extractionSource: detail.extractionSource,
      };
    });
    if (items.length === 0)
      throw new Error(
        "Export validation failed: an order has no validated item lines.",
      );
    const adjustments = detail.adjustments.map(
      (adjustment, adjustmentIndex): JsonAdjustment => ({
        adjustmentIndex,
        type: adjustment.type,
        label: adjustment.label,
        amount: adjustmentMoney(adjustment.amount),
        currency: CURRENCY,
        extractionSource: adjustment.extractionSource,
      }),
    );
    const itemsPaise = items.reduce(
      (sum, item) => sum + Math.round(item.itemTotal * 100),
      0,
    );
    const adjustmentsPaise = adjustments.reduce(
      (sum, adjustment) => sum + Math.round(adjustment.amount * 100),
      0,
    );
    const orderTotalPaise = Math.round(orderTotal * 100);
    if (Math.abs(itemsPaise + adjustmentsPaise - orderTotalPaise) > 1) {
      throw new Error(
        "Export validation failed: an order does not reconcile within one paise.",
      );
    }
    return {
      orderId: summary.orderId,
      orderDate: summary.orderDate,
      orderTotal,
      currency: CURRENCY,
      orderUrl: `https://www.amazon.in/gp/your-account/order-details?orderID=${encodeURIComponent(summary.orderId)}`,
      extractedAt,
      items,
      adjustments,
    };
  });
  return {
    metadata: {
      windowStart: options.startDate,
      windowEnd: options.endDate,
      pagesScanned,
    },
    orders: jsonOrders,
  };
}

export async function writeExportFile(
  output: string,
  document: JsonExport,
): Promise<void> {
  const serialized = `${JSON.stringify(document, null, 2)}\n`;
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, serialized, { encoding: "utf8", flag: "wx" });
    await rename(temporary, output);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function validateAndWriteExport(
  output: string,
  options: Pick<CliOptions, "startDate" | "endDate">,
  pagesScanned: number,
  orders: Array<{ summary: ListedOrder; detail: ExtractedItems }>,
  extractedAt: string,
): Promise<JsonExport> {
  // Build and validate the complete payload before creating a directory or file.
  const document = createExportDocument(
    options,
    pagesScanned,
    orders,
    extractedAt,
  );
  await writeExportFile(output, document);
  return document;
}

export async function runExport(
  options: CliOptions,
  log: (message: string) => void = console.error,
  dependencies: ExportRunDependencies = {
    list: listOrders,
    extract: extractOrderItems,
    write: validateAndWriteExport,
  },
): Promise<void> {
  log("Starting bounded Amazon.in export in the visible Chromium window.");
  const listed = await dependencies.list(
    options.startDate,
    options.endDate,
    options.maxOrders,
  );
  log(
    `Inspected ${listed.pagesScanned} order-list page(s); validating ${listed.orders.length} order(s).`,
  );
  const combined: Array<{ summary: ListedOrder; detail: ExtractedItems }> = [];
  for (const summary of listed.orders)
    combined.push({
      summary,
      detail: await dependencies.extract(
        summary.orderId,
        privacySafeItemDiagnostics,
      ),
    });
  const document = await dependencies.write(
    options.output,
    options,
    listed.pagesScanned,
    combined,
    new Date().toISOString(),
  );
  log(
    `Export complete: wrote ${document.orders.length} order(s) to the requested local file.`,
  );
}

export async function runExportWithBrowserLifecycle(
  options: CliOptions,
  dependencies: ExportLifecycleDependencies = {
    run: runExport,
    close: closeBrowser,
  },
): Promise<void> {
  let leaveBrowserOpen = false;
  try {
    await dependencies.run(options);
  } catch (error) {
    leaveBrowserOpen = error instanceof AuthenticationRequiredError;
    throw error;
  } finally {
    if (!leaveBrowserOpen) await dependencies.close();
  }
}

async function main(): Promise<void> {
  let options: CliOptions;
  try {
    options = parseCliOptions(process.argv.slice(2));
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Export failed unexpectedly.",
    );
    process.exitCode = 1;
    return;
  }

  try {
    await runExportWithBrowserLifecycle(options);
  } catch (error) {
    console.error(
      error instanceof AuthenticationRequiredError
        ? AUTH_REQUIRED_MESSAGE
        : "Export failed without writing personal order data to the console. Close the browser if it remains open, then retry.",
    );
    process.exitCode = 1;
  }
}

if (require.main === module) void main();
