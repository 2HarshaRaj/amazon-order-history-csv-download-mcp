# Issue #8 — cancelled order detail prices

Implement Issue #8 on this branch, which is based on `poc/harden-amazon-orders`.

## Root cause

The same real Amazon.in cancelled order that motivated PR #7 is now rendered differently by Amazon:
- list summary: cancelled, no order total, valid cancelled item identity/quantity
- detail page: independently confirms cancellation
- detail summary: no adjustments
- detail item extractor now returns one or more priced item rows

PR #7 only returned the existing `cancelled-order-list` fallback when `items.length === 0`, so the new rendering bypasses the fallback and later fails normal reconciliation because the order total is absent.

## Required change

Preserve the PR #7 safety model. When all existing safeguards hold:
1. list status is cancelled;
2. list order total is absent;
3. valid cancelled list items exist;
4. detail page independently confirms cancellation;
5. detail summary has no adjustments;

prefer the existing `cancelled-order-list` representation even if normal detail extraction found priced items.

Keep the existing contract:
- status = cancelled
- orderTotal = null
- item unitPrice/itemTotal = null
- adjustments = []
- preserve item identity/quantity from validated cancelled list data
- never synthesize zero/order totals or residuals
- normal priced orders and one-paise reconciliation remain unchanged

Prefer the smallest change around `src/poc/hardened-index-v3.ts`. Change `src/poc/export-json.ts` only if genuinely needed.

## Tests

Add synthetic regression coverage for priced detail items on an independently confirmed unpriced cancellation. Preserve negative coverage for missing detail confirmation and adjustments. Run build, typecheck, focused tests, and broader relevant tests.

Do not include real order data or secrets. Do not deploy, publish, or bump versions.

## Cleanup

This file is temporary dispatch scaffolding. Delete `.codex/tasks/issue-8-cancelled-priced-detail.md` before completion; it must not remain in the final PR diff.
