import { listedOrderId } from "../../../src/poc/order-identifiers";

describe("complete list identifier discovery", () => {
  test.each(["Order ID unavailable", "Order number UNKNOWN"])(
    "unfamiliar labelled header %s cannot borrow another body ID",
    (label) => {
      expect(listedOrderId(label + "\n111-2222222-3333333")).toBeUndefined();
    },
  );
  test.each([
    "111-2222222-3333333",
    "D01-0000000-0000001",
    "12345678-abcd-abcd-abcd-123456789abc",
  ])("recognizes %s without granting eligibility", (id) => {
    expect(listedOrderId("Order placed 2 October 2026\nORDER # " + id)).toBe(
      id,
    );
  });
  test.each([
    "D02-0000000-0000001",
    "ABC-0000000-0000001",
    "d01-0000000-0000001",
    "D01-0000000-000001",
    "D01-00000000-0000001",
    "unknown",
    "",
    "ORDER # unavailable\n111-2222222-3333333",
    "D01-0000000-0000001 111-2222222-3333333",
    "D01-0000000-0000001 D02-0000000-0000001",
  ])("does not silently resolve %s", (text) => {
    expect(listedOrderId(text)).toBeUndefined();
  });
  test("agreeing duplicate text is one discovered identity, not multiple orders", () => {
    expect(
      listedOrderId("ORDER # D01-0000000-0000001\nD01-0000000-0000001"),
    ).toBe("D01-0000000-0000001");
  });
});
