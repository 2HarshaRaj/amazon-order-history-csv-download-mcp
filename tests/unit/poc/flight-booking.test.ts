import type { Locator } from "playwright";
import { readFile, readdir, rm } from "fs/promises";
import { join } from "path";
import { makeTestDirectory } from "../../helpers/temp-directory";
import { verifyFlightBookingCard } from "../../../src/poc/flight-booking";
import {
  DiagnosticError,
  FailureDiagnostics,
  writeFailureReport,
} from "../../../src/poc/failure-diagnostics";

describe("flight proof boundary and private audit events", () => {
  const id = "111-0000000-0000026";
  test.each(["Error", "TimeoutError"])(
    "%s observation failure never becomes an exclusion or leaks its message",
    async (name) => {
      const card = {
        evaluate: async () => {
          throw Object.assign(
            new Error(
              "PRIVATE fictional itinerary cookie=secret /private/path",
            ),
            { name },
          );
        },
      } as unknown as Locator;
      let caught: unknown;
      try {
        await verifyFlightBookingCard(card, id, "2026-10-02", ".order-card");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(DiagnosticError);
      expect(caught).toMatchObject({
        stage: "list",
        reason: "LIST_FLIGHT_UNVERIFIED",
      });
      expect((caught as Error).message).not.toMatch(
        /PRIVATE|cookie|itinerary|private\/path/,
      );
    },
  );
  test.each([
    true,
    false,
    null,
    undefined,
    {},
    { kind: "verified" },
    { kind: "verified", routingKey: 1 },
    { kind: "verified", routingKey: "x", itinerary: "PRIVATE" },
    { kind: "none", routingKey: "x" },
  ])("malformed proof %j fails closed", async (value) => {
    const card = { evaluate: async () => value } as unknown as Locator;
    await expect(
      verifyFlightBookingCard(card, id, "2026-10-02", ".order-card"),
    ).rejects.toMatchObject({ reason: "LIST_FLIGHT_UNVERIFIED" });
  });
  test.each([0, -1, 1.5, NaN, Infinity])(
    "invalid exclusion count %s is not recorded",
    (count) => {
      const trace = new FailureDiagnostics();
      trace.listAudit("LIST_FLIGHT_BOOKING_EXCLUDED", count);
      expect(trace.report(new Error()).events).toEqual([]);
    },
  );
  test("flight count has no inherited merchandise index", () => {
    const trace = new FailureDiagnostics();
    trace.select(
      { orderId: "111-2222222-3333333", orderDate: "2026-10-02" },
      3,
    );
    trace.listAudit("LIST_FLIGHT_BOOKING_EXCLUDED", 1);
    const e = trace.report(new Error()).events[0];
    expect(e).toMatchObject({
      stage: "list",
      reason: "LIST_FLIGHT_BOOKING_EXCLUDED",
      count: 1,
    });
    expect(e.orderIndex).toBeUndefined();
  });
  test("strict persisted diagnostics accept the categorical event without booking facts", async () => {
    const trace = new FailureDiagnostics();
    trace.listAudit("LIST_FLIGHT_BOOKING_EXCLUDED", 2);
    const dir = await makeTestDirectory("flight-diagnostic-");
    try {
      await writeFailureReport(
        trace.report(
          new DiagnosticError(
            "list",
            "LIST_FLIGHT_UNVERIFIED",
            "PRIVATE fictional",
          ),
        ),
        dir,
      );
      const files = await readdir(dir);
      expect(files).toHaveLength(1);
      const text = await readFile(join(dir, files[0]), "utf8"),
        report = JSON.parse(text);
      expect(report.selectedOrders).toEqual([]);
      expect(report.order).toBeUndefined();
      expect(report.failure.reason).toBe("LIST_FLIGHT_UNVERIFIED");
      expect(report.events[0]).toMatchObject({
        reason: "LIST_FLIGHT_BOOKING_EXCLUDED",
        count: 2,
      });
      expect(text).not.toMatch(
        /111-|PRIVATE|fictional-route|itinerary|boson_flights|transaction-details/,
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
