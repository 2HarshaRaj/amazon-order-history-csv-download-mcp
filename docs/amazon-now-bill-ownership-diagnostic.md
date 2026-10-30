# Amazon Now bill declaration ownership

The selected-order reader now corrects composite ancestor counting while keeping
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
that label in its raw text. The descendant therefore contains that same sole
textual declaration. Separately, the entire raw selected dialog must contain
exactly one occurrence of the label. An additional unfiltered text-node scan
inserts boundaries between nodes for rejection discovery, catching split labels
even when `textContent` would concatenate the words without a space. It cannot
authorize a declaration absent from the original raw candidates. These checks
catch independently repeated text placed directly after a child or fragmented
across sibling nodes, including hidden and historical fragments outside the bill.

The remaining candidate must be unique and current. No hidden-element filter,
first-match selection, monetary equality or disjoint-scope assumption supplies
this proof. Hidden/historical duplicates, independent prefixes or suffixes,
conflicting declarations and additional bill headings still cause rejection.
All nonempty hidden/historical text inside the selected bill is rejected, so
an incomplete or fragmented adjustment label cannot disappear for lack of a
currency token. The ordinary comparison-price path keeps its existing rules.
The existing independent labeled row and amount validators remain necessary.

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

## Remaining live evidence

The offline fixture deliberately gives a bill multiple composite matches and
one independently validated annotation icon. Adversarial fixtures include real
merchandise boundaries, images and quantities within the bill. These tests do
not identify the owner's actual collision or prove their live bill is accepted.

If a separately authorized isolated retest still fails at a bill-boundary guard,
the missing evidence is the fixed category of the colliding node and its
relationship to the independently validated financial row or annotation owner:
`PRODUCT_LINK`, `QUANTITY`, `SEMANTIC_ITEM_OR_LIST`, `IMAGE_OR_SVG` or
`UNPROVEN`, with `INSIDE`, `ENCLOSING` or `UNKNOWN` relation and
`CURRENT`, `HIDDEN`, `HISTORICAL` or `UNKNOWN` state. A broad collision flag
alone cannot justify another relaxation. Return only fixed categories from the
same bounded synchronous DOM read, preserving the original rejection. Do not
collect actual IDs, amounts, text, HTML, selectors, URLs or screenshots.

Any live test needs separate owner authorization. Keep PR #19 Draft and Issues
#18/#20 open. Do not modify the production checkout, synchronize Sheets/Fold,
change the Disabled catch-up task, merge or deploy.
