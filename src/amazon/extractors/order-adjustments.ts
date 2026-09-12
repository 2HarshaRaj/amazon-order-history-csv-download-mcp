import { Page } from 'playwright';

export type AdjustmentType =
  | 'shipping'
  | 'marketplace_fee'
  | 'discount'
  | 'promotion'
  | 'tax'
  | 'gift_wrap'
  | 'other';

export interface OrderAdjustment {
  adjustmentIndex: number;
  type: AdjustmentType;
  label: string;
  amount: number;
  currency: 'INR';
  extractionSource: 'order-detail-summary';
}

interface SummaryRow {
  label: string;
  amountText: string;
}

const STRUCTURAL = /^(?:item\s*)?subtotal|^(?:order|grand)\s*total|^total$/i;
const PRIVATE_OR_PAYMENT = /payment|paid|card|visa|mastercard|amex|account|gift[ -]?card|claim|address|recipient|phone|e-?mail|tracking|shipment/i;

function classify(label: string): AdjustmentType | null {
  if (STRUCTURAL.test(label) || PRIVATE_OR_PAYMENT.test(label)) return null;
  if (/shipping|delivery|postage/i.test(label)) return 'shipping';
  if (/marketplace\s*fee/i.test(label)) return 'marketplace_fee';
  if (/discount|saving|coupon/i.test(label)) return 'discount';
  if (/promotion|promo/i.test(label)) return 'promotion';
  if (/tax|gst|vat|iva/i.test(label)) return 'tax';
  if (/gift\s*wrap/i.test(label)) return 'gift_wrap';
  if (/fee|surcharge|charge/i.test(label)) return 'other';
  return null;
}

function parseInrAmount(text: string, type: AdjustmentType): number | null {
  const compact = text.replace(/\s/g, '');
  const match = compact.match(/^(?:-?₹|-?INR)?(-?)(\d[\d,]*(?:\.\d{1,2})?)$/i);
  if (!match) return null;
  const parsed = Number(match[2].replace(/,/g, ''));
  if (!Number.isFinite(parsed)) return null;
  const explicitlyNegative = compact.startsWith('-') || match[1] === '-';
  const reducing = type === 'discount' || type === 'promotion';
  return (explicitlyNegative || reducing ? -1 : 1) * parsed;
}

/** Parse only rows already isolated to Amazon's order-summary safety boundary. */
export function parseOrderSummaryAdjustments(rows: readonly SummaryRow[]): OrderAdjustment[] {
  const adjustments: OrderAdjustment[] = [];
  for (const row of rows) {
    const label = row.label.replace(/\s+/g, ' ').replace(/:\s*$/, '').trim();
    const type = classify(label);
    if (!type) continue;
    const amount = parseInrAmount(row.amountText, type);
    if (amount === null) {
      throw new Error('A displayed order adjustment has an invalid amount.');
    }
    adjustments.push({
      adjustmentIndex: adjustments.length,
      type,
      label,
      amount,
      currency: 'INR',
      extractionSource: 'order-detail-summary',
    });
  }
  return adjustments;
}

/** Extract monetary facts exclusively from the safe detail-page subtotal container. */
export async function extractOrderAdjustments(page: Page): Promise<OrderAdjustment[]> {
  const rows: SummaryRow[] = [];
  for (const row of await page.locator('#od-subtotals .a-row').all()) {
    const cells = (await row.locator(':scope > div, :scope > span').allTextContents())
      .map((cell) => cell.trim());
    rows.push({ label: cells.at(0) ?? '', amountText: cells.at(-1) ?? '' });
  }
  return parseOrderSummaryAdjustments(rows);
}
