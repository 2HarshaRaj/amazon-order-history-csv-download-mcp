# Amazon Now bill declaration ownership

The selected-order reader corrects composite ancestor counting while keeping
independent financial declarations fail-closed. This is a source correction
validated with invented offline fixtures. It does not establish live extraction
compatibility or authorize another owner-local run.

## Why the raw matcher overcounted

The original `readNowDom()` raw-leaf predicate excludes a container only when
one child's entire normalized text equals the container's text. A wrapper that
starts with `Items total` and also contains sibling fee rows therefore remains
a match, alongside the actual declaration and other nested wrappers.

The latest owner-local categorical evidence identifies four nested, current
matches: three without an independently matching directly owned text prefix and
one with such a prefix. This supports a targeted composite correction. The
earlier aggregate count/currentness result alone did not establish ownership.

## What the implementation proves

For each required declaration, a raw ancestor candidate may be collapsed only
when it contains another matching candidate and has exactly one occurrence of
that label in its unfiltered text-node sequence. The descendant therefore contains
that same sole textual declaration. The entire selected dialog must also contain
exactly one occurrence, counted with boundaries between text nodes. This avoids
losing the word boundary in sibling `You pay` / `Inclusive of taxes` elements and
catches independent split labels even when `textContent` concatenates their words.
The boundary scan cannot authorize a declaration absent from the original raw
candidates. These checks
catch independently repeated text placed directly after a child or fragmented
across sibling nodes, including hidden and historical fragments outside the bill.

The remaining candidate must be unique and current. No hidden-element filter,
first-match selection, monetary equality or disjoint-scope assumption supplies
this proof. Hidden/historical duplicates, independent prefixes or suffixes,
conflicting declarations and additional bill headings still cause rejection.
All nonempty hidden text inside the selected bill is rejected, including incomplete
or fragmented adjustment labels without a currency token. Visible strike-through
amounts have a separate proof: exactly one independently recognized label-bound
row must own the comparison within five parent steps, with at most one historical
comparison in that whole row. Actual hiding, extra/unowned comparisons, historical
labels, controls and ambiguous financial evidence remain rejected. The historical
value never enters the effective bill or adjustments. This bill-ownership proof
is shared with the existing single-line price-derivation check; the ordinary
merchandise comparison rules remain unchanged.

## The merchandise collision remains a separate check

The reported `CANDIDATE_MERCHANDISE_COLLISION=YES` came from a broad selector.
It does not identify the matched node or establish whether the scope is safe.
The implementation never treats that flag as evidence of decoration.

Before excluding the selected bill from merchandise discovery, the reader
rejects bill regions containing or enclosed by `article`, `li`, list or list-item
role boundaries, and regions containing product links or quantity signals.
These raw checks include noncurrent nodes. Semantic financial-list layouts are
not newly supported by this correction; an unproven boundary stays rejected.

Every image or SVG inside the bill must be independently owned by the existing
bounded `Free for` handling-fee annotation. For the selected-order path, that
annotation must contain only the raw explanatory text and one rendered icon,
with no links/controls or product identifier in the image's alt text. The
annotation does not supply the fee's effective amount. Unowned images, hidden
images, multiple icons and product evidence cannot disappear through bill
membership or a presentation role. Ordinary `View order details` behavior is
unchanged.

The same bill still needs a unique heading, independently owned effective
`Items total` and `You pay`, complete recognized rows, supported signed
adjustments, merchandise/Items-total agreement within one paise, independent
reconciliation, and exact You-pay/list-total agreement in integer paise.
Selected order, source URL, button and dialog identity, no tab switching, item
coverage/count/quantity/price ownership and atomic JSON publication remain in
force. Other orders and delivery tabs cannot supply facts.

## Unavailable merchandise and package ranges

The alternate-action path recognizes a separately headed `Out of Stock Items`
region before active merchandise ownership discovery. Its entire boundary must
match the constrained unpriced product rows and independently owned refund-initiation
notice described in README. Every product image/name/package/quantity and the one
notice icon must be current and accounted for. The region cannot enclose the bill,
active rows, a count declaration or controls. Duplicate and overlapping active/
unavailable identities, prices, hidden facts and incomplete rows reject extraction.
No unavailable item, package count or refund notice supplies a price or adjustment.
The remaining fulfilled merchandise must independently satisfy the selected order's
purchased-unit count for the qualified `N items in order` presentation (and both
line/unit counts for an unqualified declaration), Items total, exact listed You
pay and reconciliation checks. Every distinct fulfilled row remains accounted for.

Plain positive increasing `lower-upper g` descriptors use the existing bounded
adjacent descriptor/period/purchased-unit proof. Endpoint comparison is exact in
decimal strings and shared with piece-range validation. The pure snapshot parser
still rejects unproven fragments; product names and quantities are not broadened.

The independently observed `1 Pc` package metadata uses that same owned,
current descriptor/period/explicit-purchased-unit proof. A package descriptor
cannot supply purchased quantity. Multi-unit current amounts remain unqualified
until the separate selected-order HTML printable summary independently matches
every tracking ASIN, quantity and gross line total. The bounded source and JSON
contract are documented in README's verified-line-total section. Only the proven
unknown-unit row uses `unitPrice: null` and the per-item reserved source marker;
no gross unit price is derived. Financial declaration ownership and reconciliation
are unchanged, and unavailable, ambiguous or conflicting corroboration rejects
the complete export while preserving prior output.

## Validation and remaining live evidence

The offline fixtures deliberately give a bill multiple composite matches and
one independently validated annotation icon. Adversarial fixtures include real
merchandise boundaries, images and quantities within the bill. These tests do
not establish successful extraction with the corrected implementation on an owner
account. Additional fictional recovery fixtures combine joined bill subtitles,
visible historical amounts, a complete unpriced unavailable region and gram-range
metadata. Adversarial cases cover each boundary and prior-output preservation.
All requests in browser tests are intercepted in ephemeral offline contexts.

If a separately authorized isolated retest fails at a bill-boundary guard,
the missing evidence is the fixed category of the colliding node and its
relationship to the independently validated financial row or annotation owner:
`PRODUCT_LINK`, `QUANTITY`, `SEMANTIC_ITEM_OR_LIST`, `IMAGE_OR_SVG` or
`UNPROVEN`, with `INSIDE`, `ENCLOSING` or `UNKNOWN` relation and
`CURRENT`, `HIDDEN`, `HISTORICAL` or `UNKNOWN` state. A broad collision flag
alone cannot justify another relaxation. Return only fixed categories from the
same bounded synchronous DOM read, preserving the original rejection. Do not
include actual IDs, amounts, text, HTML, selectors, URLs or screenshots in public
diagnostics or fixtures. Owner-authorized private evidence must remain outside Git
in owner-private storage; it is not part of this implementation or a snapshot library.

Any live test needs separate owner authorization. Keep PR #19 Draft and Issues
#18/#20 open. Do not modify the production checkout, synchronize Sheets/Fold,
change the Disabled catch-up task, merge or deploy.
