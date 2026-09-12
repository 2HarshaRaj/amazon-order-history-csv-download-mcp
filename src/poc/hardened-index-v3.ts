import type { Page } from 'playwright';
import { extractOrderAdjustments, type OrderAdjustment } from '../amazon/extractors/order-adjustments';

export type ItemExtractionSource = 'order-detail' | 'invoice-safe-fallback';

export interface HardenedItem {
  lineIndex: number;
  asin?: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  itemTotal: number;
  currency: 'INR';
  extractionSource: ItemExtractionSource;
}

export interface ItemDiagnostics {
  detailItemsFound(count: number): void;
  invoiceFallbackUsed(): void;
}

export interface ExtractOrderItemsOptions {
  extractDetailItems(page: Page): Promise<Omit<HardenedItem, 'lineIndex' | 'extractionSource'>[]>;
  extractInvoiceFallbackItems(page: Page): Promise<Omit<HardenedItem, 'lineIndex' | 'extractionSource'>[]>;
  diagnostics?: ItemDiagnostics;
}

export interface ExtractedOrderItems {
  items: HardenedItem[];
  adjustments: OrderAdjustment[];
  source: ItemExtractionSource;
}

const NOOP_DIAGNOSTICS: ItemDiagnostics = {
  detailItemsFound: () => undefined,
  invoiceFallbackUsed: () => undefined,
};

function withSource(
  items: Omit<HardenedItem, 'lineIndex' | 'extractionSource'>[],
  extractionSource: ItemExtractionSource,
): HardenedItem[] {
  return items.map((item, lineIndex) => ({ ...item, lineIndex, extractionSource }));
}

/**
 * Extract the safe summary while the order-detail document is still loaded.
 * Invoice extraction is deliberately attempted only after this call because it
 * may navigate the page away from `#od-subtotals`.
 */
export async function extractOrderItems(
  page: Page,
  options: ExtractOrderItemsOptions,
): Promise<ExtractedOrderItems> {
  const diagnostics = options.diagnostics ?? NOOP_DIAGNOSTICS;
  const adjustments = await extractOrderAdjustments(page);
  const detailItems = await options.extractDetailItems(page);
  diagnostics.detailItemsFound(detailItems.length);

  if (detailItems.length > 0) {
    return { items: withSource(detailItems, 'order-detail'), adjustments, source: 'order-detail' };
  }

  diagnostics.invoiceFallbackUsed();
  const fallbackItems = await options.extractInvoiceFallbackItems(page);
  return {
    items: withSource(fallbackItems, 'invoice-safe-fallback'),
    adjustments,
    source: 'invoice-safe-fallback',
  };
}
