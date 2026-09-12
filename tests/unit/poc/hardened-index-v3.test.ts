import type { Page } from 'playwright';
import { extractOrderItems } from '../../../src/poc/hardened-index-v3';

function summaryPage(events: string[]): Page {
  const row = {
    locator: () => ({
      allTextContents: async (): Promise<string[]> => ['Marketplace Fee', '₹5.00'],
    }),
  };
  return {
    locator: (selector: string) => {
      events.push(selector);
      return { all: async () => [row] };
    },
  } as unknown as Page;
}

const item = {
  productName: 'Sanitized sample item',
  quantity: 1,
  unitPrice: 199,
  itemTotal: 199,
  currency: 'INR' as const,
};

describe('hardened order item flow', () => {
  test('captures adjustments before an invoice fallback and preserves provenance', async () => {
    const events: string[] = [];
    const result = await extractOrderItems(summaryPage(events), {
      extractDetailItems: async () => {
        events.push('detail');
        return [];
      },
      extractInvoiceFallbackItems: async () => {
        events.push('invoice');
        return [item];
      },
    });

    expect(events).toEqual(['#od-subtotals .a-row', 'detail', 'invoice']);
    expect(result.source).toBe('invoice-safe-fallback');
    expect(result.items[0]).toMatchObject({ lineIndex: 0, extractionSource: 'invoice-safe-fallback' });
    expect(result.adjustments).toEqual([expect.objectContaining({
      adjustmentIndex: 0,
      amount: 5,
      extractionSource: 'order-detail-summary',
    })]);
  });
});
