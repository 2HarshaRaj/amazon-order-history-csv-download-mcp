import { makeTestDirectory } from "../../helpers/temp-directory";
/** Invented bounded snapshots only; no customer facts or browser access. */
import { readFile, readdir, rm } from "fs/promises";
import { join } from "path";
import { NowSnapshot, parseNowSnapshot } from "../../../src/poc/amazon-now";
import {
  DiagnosticError,
  FailureDiagnostics,
  NOW_PARSER_FAILURES,
  writeFailureReport,
} from "../../../src/poc/failure-diagnostics";

const id = "111-2222222-3333333";
const sentinel = "PRIVATE_ITEM_SENTINEL";
function fixture(count = 3): NowSnapshot {
  return {
    orderIds: [id],
    billRows: [`You pay ₹${count * 10}.00`],
    items: Array.from({ length: count }, (_, i) => ({
      parts: [`${sentinel} ${i}`, "Qty: 1", "₹10.00"],
      alts: [],
      hrefs: [],
    })),
  };
}
const cases: Array<
  [
    (typeof NOW_PARSER_FAILURES)[number],
    (row: NowSnapshot["items"][number]) => void,
  ]
> = [
  [
    "NOW_PARSE_QUANTITY_MISSING",
    (row) => {
      row.parts.splice(1, 1);
    },
  ],
  [
    "NOW_PARSE_QUANTITY_DUPLICATE",
    (row) => {
      row.parts.push("Quantity: 2");
    },
  ],
  [
    "NOW_PARSE_QUANTITY_INVALID",
    (row) => {
      row.parts[1] = "Qty: 0";
    },
  ],
  [
    "NOW_PARSE_NAME_MISSING",
    (row) => {
      row.parts.shift();
    },
  ],
  [
    "NOW_PARSE_NAME_DUPLICATE",
    (row) => {
      row.parts.push("PRIVATE_EXTRA_NAME");
    },
  ],
  [
    "NOW_PARSE_IDENTIFIERS_CONFLICT",
    (row) => {
      row.alts = ["B0DIAG0001"];
      row.hrefs = ["https://www.amazon.in/dp/B0DIAG0002"];
    },
  ],
];
function failure(facts: unknown, trace?: FailureDiagnostics): unknown {
  try {
    parseNowSnapshot(facts, id, trace);
  } catch (error) {
    return error;
  }
  throw new Error("Expected invented fixture rejection");
}

describe("Amazon Now parser failure attribution", () => {
  test.each(cases)(
    "%s preserves terminal failure, index and persisted privacy",
    async (reason, change) => {
      const facts = fixture();
      change(facts.items[2]);
      const trace = new FailureDiagnostics();
      trace.select({ orderId: "not supplied", orderDate: "not supplied" }, 2);
      trace.provenance("amazon-now-order-details");
      const error = failure(facts, trace);
      expect(error).toBeInstanceOf(DiagnosticError);
      expect(error).toMatchObject({
        stage: "items",
        reason: "ITEM_FACTS_INVALID",
        category: "validation",
      });
      expect(failure(facts)).toMatchObject({
        stage: "items",
        reason: "ITEM_FACTS_INVALID",
        message: (error as Error).message,
      });
      const report = trace.report(error);
      expect(report).toMatchObject({
        failure: { stage: "items", reason: "ITEM_FACTS_INVALID" },
        lineIndex: 2,
        counts: { items: 0, adjustments: 0 },
        items: [],
        adjustments: [],
        events: [{ stage: "items", reason, lineIndex: 2, orderIndex: 2 }],
        truncated: false,
      });
      const directory = await makeTestDirectory("now-parser-report-");
      try {
        await writeFailureReport(report, directory);
        const names = await readdir(directory);
        expect(names).toHaveLength(1);
        const serialized = await readFile(join(directory, names[0]), "utf8");
        expect(JSON.parse(serialized).events[0]).toEqual({
          stage: "items",
          reason,
          lineIndex: 2,
          orderIndex: 2,
          elapsedMs: expect.any(Number),
        });
        expect(serialized + String(error)).not.toMatch(
          /PRIVATE_|111-|B0DIAG|₹|10\.00|https?:|<html>|Qty:|Quantity:/,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test.each([
    "Qty: nope",
    "Qty: 01",
    "Qty: 9007199254740992",
    "0 units",
    "Mystery 1 unit",
    "Approx. (180-120 g) . 1 unit",
    "Approx. (120-120 g) . 1 unit",
    "Approx. (120-180 g) ? 1 unit",
  ])("invalid grammar %s retains attribution", (quantity) => {
    const facts = fixture();
    facts.items[1].parts[1] = quantity;
    const trace = new FailureDiagnostics();
    expect(failure(facts, trace)).toMatchObject({
      reason: "ITEM_FACTS_INVALID",
    });
    expect(trace.report(undefined).events).toMatchObject([
      { reason: "NOW_PARSE_QUANTITY_INVALID", lineIndex: 1 },
    ]);
  });
  test("identical repeated quantities are still duplicate fields", () => {
    const facts = fixture();
    facts.items[0].parts.push("Qty: 1");
    const trace = new FailureDiagnostics();
    failure(facts, trace);
    expect(trace.report(undefined).events).toMatchObject([
      { reason: "NOW_PARSE_QUANTITY_DUPLICATE", lineIndex: 0 },
    ]);
  });
  test("blank sole name is still missing", () => {
    const facts = fixture();
    facts.items[0].parts[0] = " ";
    const trace = new FailureDiagnostics();
    failure(facts, trace);
    expect(trace.report(undefined).events[0].reason).toBe(
      "NOW_PARSE_NAME_MISSING",
    );
  });
  test.each([0, 99])("bounded row index %i is recorded", (index) => {
    const facts = fixture(100);
    facts.items[index].parts[1] = "Qty: 0";
    const trace = new FailureDiagnostics();
    failure(facts, trace);
    expect(trace.report(undefined).lineIndex).toBe(index);
    expect(trace.report(undefined).events[0].lineIndex).toBe(index);
  });
  test("first failing row and original validation precedence win", () => {
    const facts = fixture();
    facts.items[1].parts = ["Qty: 0", "Quantity: 2", "₹10.00"];
    facts.items[1].alts = ["B0DIAG0001", "B0DIAG0002"];
    facts.items[2].parts[1] = "Qty: 0";
    const trace = new FailureDiagnostics();
    failure(facts, trace);
    expect(trace.report(undefined).events).toMatchObject([
      { reason: "NOW_PARSE_QUANTITY_DUPLICATE", lineIndex: 1 },
    ]);
  });
  test("snapshot, price and reconciliation failures retain their codes without item-facts subreasons", () => {
    for (const [facts, expected] of [
      [{ ...fixture(), items: [] }, "ITEM_SHAPE_AMBIGUOUS"],
      [
        (() => {
          const f = fixture();
          f.items[0].parts[2] = "₹invalid";
          return f;
        })(),
        "DETAIL_TOTAL_INVALID",
      ],
      [{ ...fixture(), billRows: ["You pay ₹31.00"] }, "TOTAL_MISMATCH"],
    ] as const) {
      const trace = new FailureDiagnostics();
      expect(failure(facts, trace)).toMatchObject({ reason: expected });
      expect(trace.report(undefined).events).toEqual([]);
      expect(trace.report(undefined).lineIndex).toBeUndefined();
    }
  });
  test("success produces identical facts with no new events", () => {
    const trace = new FailureDiagnostics();
    expect(parseNowSnapshot(fixture(), id, trace)).toEqual(
      parseNowSnapshot(fixture(), id),
    );
    expect(trace.report(undefined).events).toEqual([]);
    expect(trace.report(undefined).lineIndex).toBeUndefined();
  });
  test.each([-1, 100, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])(
    "invalid diagnostic index %s is not recorded",
    (index) => {
      const trace = new FailureDiagnostics();
      trace.nowParserFailure("NOW_PARSE_NAME_MISSING", index);
      expect(trace.report(undefined).events).toEqual([]);
      expect(trace.report(undefined).lineIndex).toBeUndefined();
    },
  );
  test("unallowlisted reasons are never recorded", () => {
    const trace = new FailureDiagnostics();
    trace.nowParserFailure(sentinel as (typeof NOW_PARSER_FAILURES)[number], 0);
    expect(trace.report(undefined).events).toEqual([]);
  });
  test("persistence rejects unbounded or private event fields", async () => {
    const trace = new FailureDiagnostics();
    trace.nowParserFailure("NOW_PARSE_NAME_MISSING", 0);
    const report = trace.report(
      new DiagnosticError("items", "ITEM_FACTS_INVALID", sentinel),
    );
    const directory = await makeTestDirectory("now-parser-safety-");
    try {
      for (const extra of [
        { lineIndex: 100 },
        { lineIndex: -1 },
        { lineIndex: 0.5 },
        { text: sentinel },
        { reason: sentinel },
      ]) {
        await expect(
          writeFailureReport(
            { ...report, events: [{ ...report.events[0], ...extra }] },
            directory,
          ),
        ).rejects.toThrow("safety validation");
      }
      expect(await readdir(directory)).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
