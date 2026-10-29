# Amazon Now bill ownership: evidence needed before a correction

The bill-summary failure remains unresolved. Preserve the current implementation
until independent ownership evidence distinguishes an actual bill conflict from
an unrelated label or an ancestor-derived match. This document proposes one
owner-local diagnostic; it does not authorize or implement a live run.

## What the existing evidence establishes

At commit `63be44f3e0337bd43d2b347437613952b7903be1`, the owner-local diagnostic
stopped at `RAW_ITEMS_TOTAL_COUNT`: multiple raw `Items total` matches, one
`You pay` match, one `Bill summary` match, and a false aggregate currentness
result. A candidate bill ancestor was found without a payment-scope collision.
The original run failed closed without publishing merchandise JSON.

In `src/poc/amazon-now.ts`, `readNowDom()` performs this raw scan over the entire
selected Order Details dialog in `selectedOrderScope`. The bounded heading-to-
`You pay` bill search occurs later. Thus the early scan is broader than the
candidate bill. Its raw-leaf predicate can also count a composite ancestor whose
text begins with the same label as a descendant. Neither observation proves
which case occurred on the owner's page.

The aggregate result does not locate individual matches, identify which match
is noncurrent, prove that a candidate bill uniquely owns its declarations, or
exclude a second bill. Moving the scan inside that candidate or selecting only
visible matches could conceal conflicting financial evidence.

Invented offline Chromium probes confirmed that a hidden duplicate inside the
bill, an unowned hidden label elsewhere in the dialog, and a second hidden bill
can all produce multiple raw matches with aggregate currentness false. An
ancestor wrapper can also create multiple raw matches. These probes demonstrate
ambiguity; they do not establish the owner's live layout or a safe exclusion.

## Smallest proposed owner-local diagnostic

Use one separately authorized isolated attempt on the same selected order, pinned
to a reviewed commit. Retain the existing clean-checkout, historical-selection,
source-link, summary/button/dialog identity and navigation prechecks. Keep the
original source-owned action and its single permitted click. Do not switch tabs,
retry another order, or navigate to additional financial pages.

At the existing raw-count failure site, collect only the following categories
from the same verified dialog, in memory. Preserve the exact raw matcher,
normalization, currentness predicate, node limit and traversal bounds. Do not
continue past the original failure or change any acceptance predicate.
Capture these facts in the same synchronous DOM read as the failed guard;
a later page inspection cannot establish the state at failure.

| Evidence | Fixed output categories |
| --- | --- |
| Match counts for each of `Items total`, `You pay`, `Bill summary` | `ZERO`, `ONE`, `TWO_PLUS`, for raw and current matches separately. |
| Candidate bill search using the existing bounded heading-to-`You pay` rule | `NONE`, `ONE`, `AMBIGUOUS`, `BOUNDS_EXCEEDED`; separately flag payment, merchandise or identity boundary collisions. A candidate is not yet a proven bill owner. |
| Each raw financial match's relation to the candidate | `INSIDE`, `CONTAINING_ANCESTOR`, `DISJOINT`, `UNKNOWN`; use `UNKNOWN` when the candidate is unavailable or ambiguous. |
| Each match's state using the original predicates | `CURRENT`, `HIDDEN`, `HISTORICAL`, `HIDDEN_AND_HISTORICAL`, `UNKNOWN`. Inspect ancestors as the extractor does. |
| Ancestor/descendant matches for the same label | Nested match `YES`/`NO`; independent matching prefix text outside that descendant `YES`/`NO`/`UNKNOWN`. Containment alone does not prove one declaration. |
| Ownership of a disjoint match | Independently established owner count `ZERO`/`ONE`/`TWO_PLUS` and a fixed kind: `BILL_CANDIDATE`, `MERCHANDISE_ROW`, `PAYMENT_REGION`, `STATUS_REGION`, `CONTROL`, `UNPROVEN`. A DOM tag, CSS class, proximity or disjointness alone is not ownership proof. |
| Evidence that could identify another bill or order | Within each candidate owner, raw/current bill-heading and `You pay` count buckets, financial-row presence `YES`/`NO`/`UNKNOWN`, and order binding `SELECTED`/`CONFLICTING`/`ABSENT`/`AMBIGUOUS`. Inspect hidden/historical evidence too. |

For an owner kind to be independently established, the diagnostic must cite a
fixed, reviewed ownership predicate and whether it passed. Reuse existing
validated boundaries where applicable; do not invent a new exclusion from an
observed tag or region name. If the available reader has not validated that
boundary at this failure point, report `UNPROVEN`. A payment, status, control or
merchandise classification is evidence for review, not permission to ignore a
financial declaration.

Inspect all matches within the existing bounded dialog, including hidden and
historical nodes. Bound the report to eight entries per label kind, using only
local ordinal indexes for relationships; set a fixed truncation flag if more
exist. Truncation, unavailable predicates or ambiguous owners leave the result
unresolved. Never infer that omitted entries are harmless.

No monetary values are needed for this ownership check. If two independently
label-bound financial rows can already be compared under the existing rules,
an optional `SAME`/`DIFFERENT`/`UNAVAILABLE` result is sufficient. Equality alone
does not authorize deduplication or prove completeness. Do not reconstruct
unverified amounts merely to populate this field.

Return only an allowlisted categorical report and the original failed-closed
outcome. Do not return raw DOM, HTML, text snippets, selectors, attribute values,
URLs, order IDs, product facts, amounts, screenshots, credentials, errors or
stacks. Keep any reviewed instrumentation in an isolated diagnostic copy;
do not modify the production checkout or ordinary diagnostic/export contract.
Do not create merchandise output, synchronize Sheets/Fold, change the scheduler,
merge or deploy. The catch-up task must stay Disabled.

## How the evidence governs the next decision

- A distinct duplicate, hidden, historical, conflicting or ambiguous declaration
  belonging to the bill must continue to fail closed, even when amounts agree.
- An ancestor-derived match is only a possible scanner correction when text
  ownership proves it repeats one declaration without independent financial
  evidence. Do not drop an ancestor merely because it contains another match.
- A disjoint match may be excluded only after independent ownership proves it
  unrelated to the selected bill and rules out a second bill or another order.
- Unproven ownership, conflicting identity, multiple bills or incomplete evidence
  requires rejection and a precise unresolved category.

Any later correction needs separate authorization, invented positive/negative
fixtures, and fresh validation. Keep exact selected-order identity, unique
dialog/button ownership, no tab switching, merchandise coverage and count
corroboration, quantity/current-price ownership, adjustments, exact listed-total
agreement, one-paise reconciliation and atomic JSON preservation unchanged.
Keep PR #19 Draft and Issues #18/#20 open. Offline probes do not establish live
extraction compatibility.
