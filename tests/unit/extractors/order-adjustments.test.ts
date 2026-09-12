import { parseOrderSummaryAdjustments } from '../../../src/amazon/extractors/order-adjustments';

describe('safe order-summary adjustments', () => {
  test('captures the explicit marketplace fee and zero shipping deterministically', () => {
    const rows = [
      { label: 'Item Subtotal:', amountText: '₹199.00' },
      { label: 'Shipping:', amountText: '₹0.00' },
      { label: 'Marketplace Fee:', amountText: '₹5.00' },
      { label: 'Order Total:', amountText: '₹204.00' },
    ];

    const first = parseOrderSummaryAdjustments(rows);
    expect(first).toEqual([
      {
        adjustmentIndex: 0,
        type: 'shipping',
        label: 'Shipping',
        amount: 0,
        currency: 'INR',
        extractionSource: 'order-detail-summary',
      },
      {
        adjustmentIndex: 1,
        type: 'marketplace_fee',
        label: 'Marketplace Fee',
        amount: 5,
        currency: 'INR',
        extractionSource: 'order-detail-summary',
      },
    ]);
    expect(parseOrderSummaryAdjustments(rows)).toEqual(first);
  });

  test('makes discounts and promotions negative', () => {
    expect(parseOrderSummaryAdjustments([
      { label: 'Promotion Applied', amountText: '₹10.00' },
      { label: 'Discount', amountText: '-₹2.50' },
    ]).map(({ amount }) => amount)).toEqual([-10, -2.5]);
  });

  test('excludes structural totals and privacy-sensitive or payment-like rows', () => {
    const excludedLabels = [
      'Item Subtotal', 'Order Total', 'Grand Total', 'Visa ending in 1111',
      'Gift Card payment', 'Delivery address', 'Shipment tracking', 'Recipient email',
    ];
    expect(parseOrderSummaryAdjustments(
      excludedLabels.map((label) => ({ label, amountText: '₹99.99' }))
    )).toEqual([]);
  });

  test.each(['', 'FREE', '₹unknown', '₹1.234'])('fails safely for invalid amount %p', (amountText) => {
    expect(() => parseOrderSummaryAdjustments([
      { label: 'Marketplace Fee', amountText },
    ])).toThrow('invalid amount');
  });
});
