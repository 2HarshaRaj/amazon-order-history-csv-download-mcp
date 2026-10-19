import { parseHeaderTotalText } from "../../../src/poc/order-total";

// No payment arithmetic is an input to this parser: only a complete header pair.
describe("independent gross header total", () => {
  test.each([
    ["Total\n₹1,225.00", 1225],
    ["Order Total: INR 359.50", 359.5],
    ["Grand Total ₹845.01", 845.01],
    ["TOTAL:₹0.00", 0],
    ["Total\u00a0₹1,22,500.99", 122500.99],
    ["Total ₹1,234,567.89", 1234567.89],
    [" Total ₹19.5 ", 19.5],
  ])("parses a complete INR pair", (text, expected) => {
    expect(parseHeaderTotalText(text)).toMatchObject({
      amount: expected,
      currency: "INR",
    });
  });

  test.each([
    "₹925.00",
    "Gift Cards Total ₹925.00",
    "Total paid ₹925.00",
    "Subtotal ₹1,220.00",
    "Total orders: 6",
    "Order total unavailable",
    "Total ₹12,25.00",
    "Total ₹1,225.001",
    "Total -₹1,225.00",
    "Total £1,225.00",
    "Total 1225",
    "Total ₹1,225.00\nGift Cards ₹925.00",
    "Total ₹925.00\nTotal ₹1,225.00",
    "Total ₹1,225.00 buyer@example.invalid",
    "Total ₹9999999999999999999999999.00",
    "Total ₹NaN",
  ])("rejects partial, malformed, non-INR or unrelated text", (text) => {
    expect(parseHeaderTotalText(text)).toBeUndefined();
  });
});
