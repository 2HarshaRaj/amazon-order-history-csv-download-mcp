/**
 * Amazon extractors barrel export.
 */

// Order list extraction
export {
  extractOrderList,
  extractOrderHeaders,
  extractExpectedOrderCount,
  hasNextPage,
  goToNextPage,
} from "./order-list";

// Order details extraction
export { extractOrderDetails, extractOrderHeader } from "./order-details";
export { extractOrderAdjustments, parseOrderSummaryAdjustments } from './order-adjustments';
export type { AdjustmentType, OrderAdjustment } from './order-adjustments';

// Item extraction
export { extractItems } from "./items";

// Shipment extraction
export {
  extractShipments,
  isFullyDelivered,
  getTrackingIds,
} from "./shipments";

// Transaction extraction (from order detail pages)
export {
  extractTransactions,
  calculateTotalAmount,
  getPaymentMethods,
} from "./transactions";

// Transactions page extraction (bulk extraction from /cpe/yourpayments/transactions)
export {
  extractTransactionsFromPage,
  getTransactionsPageUrl,
} from "./transactions-page";

// Invoice extraction
export {
  extractFromInvoice,
  getInvoiceUrl,
  invoiceItemToItem,
} from "./invoice";

// Gift card balance and transaction extraction
export {
  extractGiftCardData,
  extractGiftCardTransactionsFromHtml,
  getGiftCardPageUrl,
} from "./gift-card";
export type {
  GiftCardBalance,
  GiftCardTransaction,
  GiftCardTransactionType,
  GiftCardData,
  GiftCardExtractionOptions,
  // Legacy alias
  GiftCardActivity,
} from "./gift-card";
