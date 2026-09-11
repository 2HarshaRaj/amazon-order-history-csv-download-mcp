import { promises as fs } from "fs";
import * as path from "path";
import { z } from "zod";
import { Money } from "../core/types/money";
import { Item } from "../core/types/item";
import { EnrichedOrder, FetchOrdersResult } from "../tools/fetch-orders";

const isoDate = /^\d{4}-\d{2}-\d{2}$/;

const exportItemSchema = z.object({
  lineIndex: z.number().int().nonnegative(),
  asin: z.string(),
  productName: z.string().min(1),
  quantity: z.number().int().positive(),
  unitPrice: z.number().finite().nonnegative(),
  itemTotal: z.number().finite().nonnegative(),
  currency: z.literal("INR"),
  extractionSource: z.string().min(1),
});

const exportOrderSchema = z.object({
  orderId: z.string().min(1),
  orderDate: z.string().regex(isoDate),
  orderTotal: z.number().finite().nonnegative(),
  currency: z.literal("INR"),
  orderUrl: z.string().url(),
  extractedAt: z.string().datetime(),
  items: z.array(exportItemSchema),
});

export const pocExportSchema = z.object({
  metadata: z.object({
    windowStart: z.string().regex(isoDate),
    windowEnd: z.string().regex(isoDate),
    pagesScanned: z.number().int().nonnegative(),
  }),
  orders: z.array(exportOrderSchema),
});

export type PocExport = z.infer<typeof pocExportSchema>;

function amount(value: Money | undefined, label: string): number {
  if (!value || value.currency !== "INR" || !Number.isFinite(value.amount)) {
    throw new Error(`Missing or invalid INR ${label}`);
  }
  return value.amount;
}

function dateOnly(value: Date | null): string {
  if (!value || Number.isNaN(value.getTime())) {
    throw new Error("Missing or invalid order date");
  }
  return [
    value.getFullYear().toString().padStart(4, "0"),
    (value.getMonth() + 1).toString().padStart(2, "0"),
    value.getDate().toString().padStart(2, "0"),
  ].join("-");
}

function orderItems(order: EnrichedOrder, allItems: Item[]): Item[] {
  const items =
    order.items ??
    allItems.filter((item) => item.orderHeader.orderId === order.orderId);
  // Extraction order is the only stable information available for duplicate/ASIN-less lines.
  return items;
}

export function createPocExport(
  result: FetchOrdersResult,
  windowStart: string,
  windowEnd: string,
  extractedAt = new Date(),
): PocExport {
  const payload = {
    metadata: { windowStart, windowEnd, pagesScanned: result.pagesScanned },
    orders: result.orders.map((order) => ({
      orderId: order.orderId,
      orderDate: dateOnly(order.date),
      orderTotal: amount(order.grandTotal ?? order.total, "order total"),
      currency: "INR" as const,
      orderUrl: order.detailUrl,
      extractedAt: extractedAt.toISOString(),
      items: orderItems(order, result.items).map((item, lineIndex) => ({
        lineIndex,
        asin: item.asin ?? "",
        productName: item.name,
        quantity: item.quantity,
        unitPrice: amount(item.unitPrice, "item unit price"),
        itemTotal: amount(item.totalPrice, "item total"),
        currency: "INR" as const,
        extractionSource:
          typeof item.platformData.source === "string"
            ? item.platformData.source
            : "order-detail",
      })),
    })),
  };
  return pocExportSchema.parse(payload);
}

/** Validate completely, then atomically replace the destination file. */
export async function writePocExport(
  outputPath: string,
  payload: PocExport,
): Promise<void> {
  const validated = pocExportSchema.parse(payload);
  const parent = path.dirname(outputPath);
  await fs.mkdir(parent, { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  try {
    await fs.writeFile(
      temporaryPath,
      `${JSON.stringify(validated, null, 2)}\n`,
      "utf8",
    );
    await fs.rename(temporaryPath, outputPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}
