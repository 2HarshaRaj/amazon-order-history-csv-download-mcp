import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { PocOrder, validatePocOrders, writePocOrdersJson } from '../../../src/poc/json-export';

function order(overrides: Partial<PocOrder> = {}): PocOrder {
  return {
    orderId: '408-1111111-2222222',
    orderDate: '2026-09-06',
    orderTotal: 204,
    currency: 'INR',
    orderUrl: 'https://www.amazon.in/gp/your-account/order-details?orderID=sanitized',
    extractedAt: '2026-09-12T00:00:00.000Z',
    items: [{
      lineIndex: 0,
      asin: 'B000TEST00',
      productName: 'Sanitized sample item',
      quantity: 1,
      unitPrice: 199,
      itemTotal: 199,
      currency: 'INR',
      extractionSource: 'order-detail',
    }],
    adjustments: [{
      adjustmentIndex: 0,
      type: 'marketplace_fee',
      label: 'Marketplace Fee',
      amount: 5,
      currency: 'INR',
      extractionSource: 'order-detail-summary',
    }],
    ...overrides,
  };
}

describe('POC JSON reconciliation', () => {
  test('accepts 199 plus the explicit fee of 5 as 204', () => {
    expect(() => validatePocOrders([order()])).not.toThrow();
  });

  test('accepts a negative promotion when it reconciles', () => {
    expect(() => validatePocOrders([order({
      orderTotal: 194,
      adjustments: [{ adjustmentIndex: 0, type: 'promotion', label: 'Promotion', amount: -5,
        currency: 'INR', extractionSource: 'order-detail-summary' }],
    })])).not.toThrow();
  });

  test('rejects non-contiguous or duplicate indexes', () => {
    expect(() => validatePocOrders([order({
      adjustments: [{ adjustmentIndex: 1, type: 'marketplace_fee', label: 'Fee', amount: 5,
        currency: 'INR', extractionSource: 'order-detail-summary' }],
    })])).toThrow('indexes');
  });

  test('fails closed before replacing a file when a residual is unexplained', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'amazon-poc-test-'));
    const output = join(directory, 'orders.json');
    await writeFile(output, 'sentinel', 'utf8');
    await expect(writePocOrdersJson(output, [order({ orderTotal: 204.02 })]))
      .rejects.toThrow('reconciliation failed');
    expect(await readFile(output, 'utf8')).toBe('sentinel');
    await rm(directory, { recursive: true, force: true });
  });
});
