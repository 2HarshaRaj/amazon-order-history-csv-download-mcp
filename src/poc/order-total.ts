import type { Locator } from "playwright";
import { z } from "zod";
import { Money, parseMoney } from "../core/types/money";
import { DiagnosticError } from "./failure-diagnostics";

// Header regions used by modern and legacy order cards. Never search the card
// body for prices, subtotals, payment balances, or a generic first rupee amount.
const HEADER_SELECTOR =
  '.order-header, .order-info, [data-component="orderHeader"]';
const EXCLUDED_CONTEXT =
  '[data-component="purchasedItems"], [data-component="viewPaymentPlanSummaryWidget"], [data-component="paymentSummary"], .a-popover, .a-popover-content, [role="dialog"], [aria-hidden="true"]';
const TOTAL_CANDIDATE =
  /^(?:(?:order|grand)\s+)?total(?:\s*:|\s*(?:₹|INR\b)|\s*$)/i;
const PAIR =
  /^(?:(?:order|grand)\s+)?total\s*:?\s*(?:₹|INR\s*)\s*((?:\d+|\d{1,3}(?:,\d{3})+|\d{1,2}(?:,\d{2})*,\d{3})(?:\.\d{1,2})?)$/i;
const totalText = z.string().max(200);
const READ_TIMEOUT = 1500;
const MAX_CANDIDATES = 16;

async function containsExcludedContent(scope: Locator): Promise<boolean> {
  const excluded = scope.locator(EXCLUDED_CONTEXT);
  const count = await excluded.count();
  if (count > MAX_CANDIDATES) {
    throw new DiagnosticError(
      "list",
      "LIST_TOTAL_AMBIGUOUS",
      "Order header has ambiguous nested regions.",
    );
  }
  for (let index = 0; index < count; index++) {
    if (await excluded.nth(index).isVisible()) return true;
  }
  return false;
}

/** A complete header label/value pair only, with explicit INR and exact paise. */
export function parseHeaderTotalText(text: string): Money | undefined {
  const validated = totalText.safeParse(text);
  if (!validated.success) return undefined;
  const match = PAIR.exec(validated.data.replace(/\u00a0/g, " ").trim());
  if (!match) return undefined;
  const money = parseMoney(`₹${match[1]}`, "INR");
  return Number.isFinite(money.amount) &&
    money.amount >= 0 &&
    Number.isSafeInteger(Math.round(money.amount * 100))
    ? money
    : undefined;
}

/** Return no total only when no visible header total was declared at all.
 * A declared but unreadable/conflicting total must never become an unpriced
 * cancellation. Every visible candidate must agree; there is no first-match win.
 */
export async function extractHeaderOrderTotal(
  card: Locator,
): Promise<Money | undefined> {
  const headers = card.locator(HEADER_SELECTOR);
  const headerCount = await headers.count();
  if (headerCount > MAX_CANDIDATES)
    throw new DiagnosticError(
      "list",
      "LIST_TOTAL_AMBIGUOUS",
      "Order header has ambiguous total regions.",
    );
  const totals = new Map<number, Money>();
  let count = 0;
  for (let index = 0; index < headerCount; index++) {
    const header = headers.nth(index);
    if (!(await header.isVisible())) continue;
    const candidates = header.getByText(TOTAL_CANDIDATE);
    const candidateCount = await candidates.count();
    count += candidateCount;
    if (count > MAX_CANDIDATES)
      throw new DiagnosticError(
        "list",
        "LIST_TOTAL_AMBIGUOUS",
        "Order header has ambiguous total candidates.",
      );
    for (
      let candidateIndex = 0;
      candidateIndex < candidateCount;
      candidateIndex++
    ) {
      const candidate = candidates.nth(candidateIndex);
      if (!(await candidate.isVisible())) continue;
      if (
        await candidate.evaluate(
          (element, selector) => element.closest(selector) !== null,
          EXCLUDED_CONTEXT,
          { timeout: READ_TIMEOUT },
        )
      )
        continue;
      let scope = candidate;
      let total: Money | undefined;
      // Span pairs and label/value rows can be wrapped in a small header column.
      // Never climb out of a recognized header or accept additional row text.
      for (let depth = 0; depth < 4; depth++) {
        const inHeader = await scope.evaluate(
          (element, selector) => element.closest(selector) !== null,
          HEADER_SELECTOR,
          { timeout: READ_TIMEOUT },
        );
        if (!inHeader) break;
        if (!(await containsExcludedContent(scope))) {
          total = parseHeaderTotalText(
            await scope.innerText({ timeout: READ_TIMEOUT }),
          );
        }
        if (total) break;
        scope = scope.locator("xpath=..");
      }
      if (!total)
        throw new DiagnosticError(
          "list",
          "LIST_TOTAL_INVALID",
          "Order header total is not a validated INR label/value pair.",
        );
      totals.set(Math.round(total.amount * 100), total);
    }
  }
  if (totals.size > 1)
    throw new DiagnosticError(
      "list",
      "LIST_TOTAL_AMBIGUOUS",
      "Order header totals conflict.",
    );
  return totals.values().next().value;
}
