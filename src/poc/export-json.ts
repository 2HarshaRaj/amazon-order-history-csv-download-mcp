import { promises as fs } from 'fs';
import { dirname } from 'path';
import { z } from 'zod';
import { OrderAdjustment } from '../amazon/extractors/order-adjustments';

const itemSchema = z.object({
  lineIndex: z.number().int().nonnegative(),
  asin: z.string().optional(),
  productName: z.string(),
  quantity: z.number().int().positive(),
  unitPrice: z.number().finite().nonnegative(),
  itemTotal: z.number().finite(),
  currency: z.literal('INR'),
  extractionSource: z.enum(['order-detail', 'invoice-safe-fallback']),
});

const adjustmentSchema = z.object({
  adjustmentIndex: z.number().int().nonnegative(),
  type: z.enum(['shipping', 'marketplace_fee', 'discount', 'promotion', 'tax', 'gift_wrap', 'other']),
  label: z.string().min(1),
  amount: z.number().finite(),
  currency: z.literal('INR'),
  extractionSource: z.literal('order-detail-summary'),
});

export const pocOrderSchema = z.object({
  orderId: z.string(),
  orderDate: z.string(),
  orderTotal: z.number().finite(),
  currency: z.literal('INR'),
  orderUrl: z.string().url(),
  extractedAt: z.string().datetime(),
  items: z.array(itemSchema),
  adjustments: z.array(adjustmentSchema),
});

export type PocOrder = z.infer<typeof pocOrderSchema>;

function toPaise(amount: number): number {
  return Math.round(amount * 100);
}

export function validatePocOrders(orders: readonly PocOrder[]): void {
  for (const candidate of orders) {
    const result = pocOrderSchema.safeParse(candidate);
    if (!result.success) {
      throw new Error('Order export data is invalid; no export was written.');
    }
    const order = result.data;
    const indexes = order.adjustments.map((entry: OrderAdjustment) => entry.adjustmentIndex);
    if (new Set(indexes).size !== indexes.length || indexes.some((value, index) => value !== index)) {
      throw new Error('Order adjustment indexes are invalid.');
    }
    const calculatedPaise = order.items.reduce((sum, item) => sum + toPaise(item.itemTotal), 0)
      + order.adjustments.reduce((sum, adjustment) => sum + toPaise(adjustment.amount), 0);
    const orderTotalPaise = toPaise(order.orderTotal);
    if (Math.abs(calculatedPaise - orderTotalPaise) > 1) {
      throw new Error('Order reconciliation failed; no export was written.');
    }
  }
}

/** Validate the complete payload before opening or replacing the destination file. */
export async function writePocOrdersJson(outputPath: string, orders: readonly PocOrder[]): Promise<void> {
  validatePocOrders(orders);
  await fs.mkdir(dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, `${JSON.stringify(orders, null, 2)}\n`, { encoding: 'utf8', flag: 'w' });
}
