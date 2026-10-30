# Amazon Order History CSV Download MCP

[![GitHub Actions](https://github.com/marcusquinn/amazon-order-history-csv-download-mcp/workflows/Code%20Quality/badge.svg)](https://github.com/marcusquinn/amazon-order-history-csv-download-mcp/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/Version-0.4.3-blue)](https://github.com/marcusquinn/amazon-order-history-csv-download-mcp/releases)
[![MCP](https://img.shields.io/badge/MCP-Compatible-green.svg)](https://modelcontextprotocol.io)
[![AGENTS.md](https://img.shields.io/badge/AGENTS.md-Compliant-blue.svg)](https://agents.md/)

MCP (Model Context Protocol) server for downloading Amazon order history as CSV files.
Supports orders, items, shipments, and transactions export across 16 Amazon regional sites.

## Features

- **4 Export Types**: Orders summary, item details, shipment tracking, payment transactions
- **16 Amazon Regions**: US, UK, Canada, Germany, France, Spain, Italy, and more
- **Browser Automation**: Uses Playwright for reliable data extraction
- **AI Assistant Integration**: Works with Claude, GPT, and other MCP-compatible assistants
- **Flexible Date Ranges**: Export by year, date range, or recent months

## Quick Start

### Installation

Install the MCP server globally from npm, then install Chromium for Playwright:

```bash
npm install --global amz-order-history-csv-mcp
npx playwright install chromium
```

You can also run the server without a global installation:

```bash
npx --yes playwright install chromium
npx --yes amz-order-history-csv-mcp
```

Node.js 18 or newer is required.

For source development, clone the repository and build it locally:

```bash
git clone https://github.com/marcusquinn/amazon-order-history-csv-download-mcp.git
cd amazon-order-history-csv-download-mcp
npm ci
npm run build
npx playwright install chromium
```

### Configuration

Add to your MCP client configuration (e.g., Claude Desktop):

```json
{
  "mcpServers": {
    "amazon-orders": {
      "command": "npx",
      "args": ["--yes", "amz-order-history-csv-mcp"]
    }
  }
}
```

Source checkouts can instead use `node` with the absolute path to
`dist/index.js`.

### Usage

Once configured, you can ask your AI assistant:

- "Download my Amazon orders from 2024 as CSV"
- "Export all items I purchased on Amazon UK this year"
- "Get shipment tracking for my recent Amazon orders"
- "Export my Amazon payment transactions for tax purposes"
- "What's my Amazon gift card balance?"
- "Show me all my Amazon transactions from last month"

### Hardened Amazon.in local JSON export (POC)

The hardened proof-of-concept can write a bounded Amazon.in/INR export for a
local consumer. In Windows PowerShell, use `npm.cmd` rather than `npm` (the
PowerShell execution policy on some machines blocks the `npm.ps1` shim):

```powershell
npm.cmd run export:poc -- --start-date 2026-09-01 --end-date 2026-09-11 --max-orders 20 --output "$env:LOCALAPPDATA\AmazonOrderExport\amazon-orders.json"
```

Both dates and an absolute output path are required. Dates must be valid
`YYYY-MM-DD` calendar dates, the start must not follow the end, and
`--max-orders` defaults to 20 with a hard limit of 50. The output path must be
outside this repository; normally choose a user configuration, temporary, or
data directory. Missing parent directories are created.

The command launches visible (headful) Chromium using the existing dedicated
profile at `~/.amazon-order-history-poc/browser-data`. Cookies remain in that
local profile and are never included in the export. Sign in and complete any
OTP prompt manually in that window. If authentication is missing or expires,
the command stops without writing an export; finish signing in in the visible
window and rerun it. The command intentionally logs only bounded progress,
counts, and sanitized errors—not order or item payloads.

The UTF-8 JSON contains `metadata` (`windowStart`, `windowEnd`, and the actual
`pagesScanned`) plus an `orders` array. Each raw Amazon OrderID remains a
separate order with its date, numeric INR total, Amazon.in detail URL,
extraction timestamp, and item lines. Each item contains a deterministic
zero-based `lineIndex`, optional/empty ASIN, product name, numeric quantity,
numeric unit and line totals, `INR`, and its safe extraction source. The export
fails closed before file creation if a required fact is absent or invalid.

For conventional priced orders, `orderTotal` comes only from an explicit, visible `Grand Total`
INR label/value pair in the already visited Order Details page's unique
`#od-subtotals` summary. The final HTTPS Amazon.in detail URL must identify the
requested order, and any explicit summary owner must match it. All eligible
Grand Total displays must agree. Missing, unreadable, hidden-only, or conflicting
detail evidence stops export with safe `DETAIL_TOTAL_*` diagnostics; an identity
mismatch uses `DETAIL_ORDER_MISMATCH`. Generic `Total`, subtotals, invoice amounts,
item sums, and payment components cannot substitute for the detail Grand Total.

Amazon Now uses a separate adapter in `src/poc/amazon-now.ts`. The selected
order card supplies its actual HTTPS Amazon.in UFF/tracking details link; the
exporter does not construct a conventional details URL for it. A single bounded
click on the unique visible **View order details** control must open a unique,
visible **Order Details** dialog. Pre-existing sheets are rejected. Committed
UFF/tracking URLs must retain the exact selected Order ID. Before clicking, the
control must share a bounded source region with one independently displayed,
complete labeled tracking Order ID. The dialog must independently display the
full ID once too. Only one optional display-only ASCII `#` is normalized; digits,
hyphens and identity are never repaired. Missing, duplicate, hidden-only or
conflicting ownership stops the export before dispatch or extraction.

The alternate **View details** button has a separate, stricter path. It must be
the sole current details action, with no competing **View order details** action.
Its first labeled common ancestor must be a `DIV` within four parent steps,
at most 500 text characters and 80 elements, containing one exact independently
displayed selected ID and one `Order ID` label. Separate label/ID text nodes are
supported. Page-wide containers, nested order cards, conflicting identities,
hidden/historical source text and duplicate actions cannot authorize the click.
The same captured button and its ownership evidence are revalidated immediately
before one click; locator replacement cannot select another button. All committed
main-frame navigation URLs still undergo the existing allowlist/selected-ID
checks, including intermediate navigations when the final URL is valid.

Two different Amazon Order IDs can share one Amazon Now tracking interface.
Each original link discovered in **Your Orders** identifies its own order and may
open a different delivery tab automatically. Each separately listed ID remains
one JSON order with its own merchandise, bill and line indexes. The exporter
preserves the initial tab selection and never clicks another tab to force a
match. Delivery numbers, visual order and the tracking URL alone do not prove
which order is currently selected: the visible bounded summary ID, its unique
button, the entry/navigation identity and the opened dialog ID must all agree.
Other inactive panels and tracking previews never provide merchandise facts.
No combined delivery manifest, product links in the summary or parent-purchase
aggregation is required or supported.

For the alternate action, coverage is established inside that one verified
**Order Details** dialog. The existing bounded merchandise reader must own every
eligible product image/link, quantity and current price, with no incomplete
semantic item rows, overlapping owners, hidden merchandise or duplicate products.
One independently displayed, current declaration is required: `N item`, `N items`,
`N item in order` or `N items in order`, after whitespace normalization. The
anchored grammar captures only a canonical integer from 1 through 100; the
existing singular/plural behavior is retained. Missing, hidden, historical,
repeated (including mixed formats), malformed or ambiguously owned declarations
fail closed. Product names, tab labels, controls and tracking previews cannot
provide the independent count; unsupported suffixes never authorize extraction.
The observed `in order` wording supports this narrow compatibility correction,
but the precise seventh-order label and successful live extraction remain unverified.
The observed declaration's line-versus-unit meaning has not been independently
established. This correction accepts it only when **both** the validated line
count and purchased-unit sum agree with it. When those interpretations differ,
extraction fails rather than guessing what Amazon meant. Multi-unit alternate
orders with an unqualified count remain unsupported pending owner-local evidence;
the existing ordinary quantity and single-line price-derivation paths retain
their behavior. The declaration never invents missing merchandise.

The selected dialog must have one independently recognized **Bill summary**,
**Items total** and effective **You pay**, with no hidden/conflicting identities
or financial evidence. Items total must agree with validated line totals within
the existing one-paise tolerance; merchandise plus supported signed adjustments
must reconcile independently. You pay must match the selected order's listed
INR total **exactly in integer paise**. A matching total alone is insufficient.
A second order's items or bill cannot supply missing facts. Duplicate selected
order IDs are rejected at JSON validation; different IDs are retained even when
their merchandise or amounts coincide. Any failure preserves prior complete JSON.

The selected-order bill guard collapses a composite ancestor match only when a
matching descendant contains its sole occurrence of that declaration label.
The raw dialog must also contain exactly one occurrence of each required label;
independent repeated text, including fragmented or hidden text in an ancestor,
cannot disappear. Visibility filtering and matching amounts never authorize
deduplication. Bill regions containing or enclosed by semantic merchandise/list
boundaries, product links or quantity signals fail closed. Every bill image/icon
must belong to the existing strictly bounded `Free for` handling-fee annotation;
unowned images and product identifiers are rejected, including hidden images.
The [bill ownership notes](docs/amazon-now-bill-ownership-diagnostic.md) explain
the correction and its limits. The owner's broad merchandise-collision flag
does not establish whether their live scope satisfies these checks. Live
compatibility remains unverified; no collision is assumed harmless.

Fictional offline fixtures exercise a shared interface whose two original links
automatically select separate seven-line and one-line orders, with independent
identities, counts and bills. Their markup is test evidence, not a claim about
live Amazon DOM. The owner-confirmed per-order model supersedes the earlier
combined-manifest assumption. Live compatibility, count semantics beyond the
unambiguous case and any other unsupported presentation require separate
owner-local validation before acceptance is expanded.

For Now, the independent billed total is the unique effective INR **Bill summary
→ You pay** declaration, with internal provenance `amazon-now-you-pay`. Computed
line-through prices and hidden content are excluded. The adapter retains exact
visible product names, explicit `Qty:`/`Quantity:` or `N unit(s)` quantities and
current prices, with an empty ASIN when no valid associated identifier is
available. A supported package descriptor such as `500 g · 1 unit` supplies only
its explicit purchased-unit count; package size is never treated as quantity.
Adjacent rupee and numeric DOM nodes are paired only within their own parent.
Merchandise alone also supports visually rendered adjacent currency/number
elements beneath `aria-hidden="true"`. Both components must belong to exactly
one common bounded merchandise row with an independently visible quantity and
eligible image/product link. The same price view drives row discovery and field
extraction; values are never matched to products by position. Semantic item
boundaries cannot be crossed to borrow a price. Each hidden price field may contain
only the one price or an explicit `Unit price:`, `Item total:` or `Line total:`
field; unknown qualifiers, extra values and unowned currency evidence fail.
`hidden`, display/visibility/opacity hiding and historical strike-through remain
excluded. Identity, names, quantities, images, Bill summary and funding regions
retain their strict visibility/accessibility rules. Accessibility-hidden bills
or identities cannot supply missing required facts.

Anchored grammars are shared by quantity field extraction and snapshot parsing:
`Qty: N`, `Quantity: N`, `N unit(s)`, or a positive mass/volume measurement followed
by `·`, `•` or `|` and the explicit unit count. Supported measurement units remain
mg/g/kg/ml/l/litre(s)/liter(s). Only the final purchased-unit count supplies
quantity; zero/negative package measurements, range endpoints and unbounded
prefixes do not. Discovery retains malformed quantity signals so they fail
validation rather than disappearing.

Separately rendered package metadata is normalized only when a supported positive
mass/volume measurement, a literal ASCII period `.`, and an existing standalone
`N unit(s)`, `Qty: N` or `Quantity: N` declaration are three
adjacent fields sharing a parent inside one independently owned merchandise row.
Only whitespace may separate those siblings. The normalization keeps the final
purchased-unit declaration unchanged; package size never supplies quantity.
The row must then have exactly one original name before that quantity and its
independent price field(s) afterward. It rejects extra/misplaced metadata, unknown
separators, hidden or historical conflicting metadata and product/control evidence
inside the three fields. Product-name punctuation is preserved. Flat snapshot
fragments alone cannot prove this structure and are still rejected by the pure
parser; its name and quantity grammars are unchanged. Hiding or striking through
both metadata fields cannot make the row fall back to a bare purchased count.

The same bounded structure also supports exactly `Pack of N, M Tablets` as its
descriptor, using the fixed capitalization and ASCII comma after existing
whitespace normalization. Both `N` and `M` must be positive safe integers, with no
signs, decimals, leading zeros or exponent notation. Neither count supplies
purchased quantity; only the independent purchased-unit declaration does. Other
pack categories, punctuation, qualifiers and arbitrary retail descriptions are
unsupported. Hidden or historical pack evidence, including malformed/unsupported
`Pack` metadata, cannot disappear to permit a bare-count fallback. The invented
eight-item tablet fixture covers seven measurements plus this descriptor; the
23-item fixtures retain their existing presentations.

The same period-only sibling proof also supports exactly `Pack of N, M g Each`
within the existing 500-character field bound.
`N` is a positive canonical safe integer. `M` uses the existing positive decimal
measurement syntax: no signs, leading zeros, exponent notation or unit changes;
its numeric value must remain positive and below `Number.MAX_SAFE_INTEGER`
(underflow and overflow are rejected). Fixed `Pack of`, ASCII comma, lowercase
`g` and `Each` spelling are required after existing whitespace normalization.
Neither pack count nor per-piece weight supplies purchased quantity. Only the
separate explicit purchased-unit declaration does. The original name remains
unchanged, and only an adjacent literal ASCII period is accepted; middle dots
are not supported for this descriptor. Existing field-count, current visibility,
ownership, hidden/historical Pack rejection, independent price and reconciliation
checks apply. The invented ten-item fixture combines this descriptor with the
previously supported package forms and tests atomic failure preservation.

The same DOM-adjacent normalization also recognizes the case-sensitive piece
packaging descriptors `N Pcs (Approx. X–Y g)` and `N Pcs (X–Y g)`. `N` must be a
positive safe integer with canonical digit syntax. Both gram endpoints must be
positive decimals in strictly increasing order, compared exactly as decimal
strings. The range accepts only an ASCII hyphen `-` or en dash `–` (U+2013).
Only these piece descriptors additionally permit a separate literal middle dot
`·` (U+00B7); the existing ASCII period `.` remains valid. Other package types
retain their period-only split-field rule. No punctuation is ignored.

The descriptor, separator and separate purchased-unit declaration must remain
current, independently bounded adjacent siblings under the existing ownership
checks. Only the final purchased-unit declaration supplies quantity: neither
piece count nor weight endpoints do. Invalid ranges, unknown qualifiers/units,
extra names, duplicate/misplaced fields, nested product/control evidence and
hidden/struck-through piece metadata remain rejected. Names retain their exact
text. The invented five-item piece fixture includes both new descriptors alongside
mass/volume, tablet-pack and single-field approximate-weight regressions.

The additional exact, case-sensitive form is
`Approx. (lower-upper g) separator N unit(s)`. Its prefix includes the literal
ASCII period, its parentheses and range hyphen are ASCII, and its gram endpoints
must be positive decimal values in strictly increasing order. Endpoints are
compared exactly as decimal strings, never rounded or used as purchased counts.
Only the explicit final positive safe-integer `N` supplies quantity. The separator
is exactly one ASCII period `.` (U+002E), middle dot `·` (U+00B7), or bullet `•`
(U+2022), with optional surrounding whitespace. Pipes remain valid for standard
package descriptors but are not accepted for this approximate-weight form.
Other prefixes, units, range punctuation, doubled/unknown separators, missing
counts and non-increasing ranges remain unsupported. The entirely invented
23-item accessibility fixture now uses this approximate gram-range form for its
final row and separate package/period/count fields for the other 22 rows. All 23
products retain their original names, independently sourced prices and billed
total; the previous single-field presentations remain regression fixtures.

Bill values come from individual label-bound rows, including `Inclusive of taxes`
only as a subtitle of `You pay`; no flat sequence of unrelated tokens is paired.
The normal multi-unit path requires both labeled **Unit price** and **Item total**
or **Line total** declarations. One narrow exception supports exactly one current,
independently owned merchandise row, quantity greater than one and exactly one
unlabelled eligible current price. The DOM reader must supply an internal proof
that hidden/historical rows, quantities, names or conflicting financial evidence
have not disappeared. A single visible crossed-out amount is permitted only as
a comparison in the same bounded current-price field or exactly one independently
label-bound bill-row ancestor. Bill comparisons may have layout wrappers, but the
recognized row must be reached within five parent steps from the historical
amount. General membership in Bill summary is insufficient. The entire owning
row must contain exactly one historical comparison candidate, including across
separate wrappers; existing current bill facts remain independently validated.
Merchandise comparisons retain their immediate current-price-field requirement.
The historical value never enters calculations. Actual hiding, labelled historical prices
and extra comparison candidates cannot supply this proof. Existing validated,
visually rendered accessibility-hidden price pairs retain their treatment.

For that exception only, exactly one independent **Items total** and one **You pay**
must each equal the current line price **exactly in integer paise**. Other subtotal
declarations, duplicate/ambiguous charge kinds, unknown charges and any nonzero
fee/discount/promotion reject the exception, even if adjustments net to zero.
The three totals must use canonical positive INR notation, represent safe integer
paise and agree without the usual one-paise reconciliation tolerance. The line
paise must divide exactly by the positive safe-integer purchased count, producing
a positive whole-paise unit amount without rounding. `itemTotal` preserves the
source line total; `unitPrice` is **mathematically derived from that independently
verified line total**, not directly displayed by Amazon. The internal formatted
unit value is marked `Derived INR`; no public JSON field or provenance enum is
added. Multiple product lines, missing proof/totals, non-divisible totals and
ambiguous prices retain strict rejection. Quantity-one pricing and the normal
explicitly labelled multi-unit path retain their behavior.

Quantity declarations bind bounded merchandise rows with
product evidence. All remaining product links, images and current prices must
belong to those rows. Separately named delivery/status/payment regions and
explicitly presentational images do not become products; incomplete rows,
overlap, duplicates and unrecognized image/price ownership fail closed.
Heading-free delivery-time messages can own an isolated single icon without a
status role. This requires a complete delivered-duration message outside item/list
boundaries, with no product links, ASIN candidates or financial evidence in that
container. A separate minimal `div > [img, div]` decoration may contain two
text-only leaves: `Delivered in N minutes` and `Arrived at H:MM AM/PM` (a valid
12-hour clock time). The arrival leaf cannot include unrelated text, controls or
additional images; the recognizer does not climb through the shared merchandise
container to find an icon.

One icon-only dialog control may also be excluded, strictly as
`button > div > img` beside a single content `div` in a two-child `div` frame.
That sibling content must contain Bill summary and every quantity candidate.
Multiple matching controls, extra frame children/text, merchandise boundaries,
quantity declarations, product links, ASIN-like imagery, monetary evidence and
additional images disqualify the exclusion. Both new structures inspect hidden
and historical evidence too. Images in merchandise buttons still require their
normal merchandise owner. Other unowned images still fail closed.

Explicit handling/delivery/shipping fee rows count only their effective charge;
**Free** with a crossed-out fee contributes no adjustment. A handling-fee `Free for`
caption is accepted only in its own bounded caption/icon group; the row must
still declare a separate,
unambiguous effective **Free** or INR charge. The caption cannot replace a missing
charge or hide conflicting current values. Discounts/promotions remain separate
rows with explicit negative INR amounts. Included/qualified fees, refunds,
Now cancellations, unknown bill rows, ambiguous prices and unsupported layouts
stop export. Separate funding sections never supply totals or adjustments.
Now items use `amazon-now-order-details` provenance and adjustments use
`amazon-now-bill-summary`; the JSON field structure and one-paise reconciliation
contract are unchanged. Safe failures use existing identity/validation codes or
`NOW_EXTRACTION_FAILED`. Owner-local reports allowlist the distinct total source.

Now validation in this branch uses invented static and offline Chromium fixtures,
including two complete 23-item presentations and an additional invented component
fixture for heading-free status and explanatory fees. This does not establish
compatibility with every live Now layout. The isolated seventh September-order
check, full September 24-order/wallet regression and October five-order/34-item
regression remain separate owner-authorized live work. Production synchronization,
merge, deployment and scheduler re-enable each require separate owner approval.
The existing Amazon Orders catch-up task must remain **Disabled**.

Order-card header totals remain validated list observations, not authoritative
gross amounts. A syntactically valid list `Total` can differ from the detail
`Grand Total`; the reason for Amazon's display difference is not inferred.
The detail value is used and a bounded `LIST_DETAIL_TOTAL_DIFFER` event is retained
in owner-local failure diagnostics if export later fails, without adding fields
to exported JSON. Diagnostic reconciliation uses the detail gross as its expected
amount; selected-order evidence retains the original list observations. Missing,
invalid, or conflicting list headers still stop export with `LIST_TOTAL_*` reasons.
Duplicate same-order cards, including across scanned pages, must agree on their
date, status, and monetary facts (`LIST_DUPLICATE_CONFLICT`); later cards cannot
silently overwrite earlier observations.

**Verified Amazon Pay Wallet funding cards are excluded before merchandise
selection (Issue #20).** The owner-confirmed proof is one exact current `h3`
`Amazon Pay Wallet` and one exact current `span` `Money added`. Their third parent
must be the same inner `div`, inside the same order card, with distinct `a-row`
branches. Both fields must be unique; hidden, historical or differently owned
copies make the evidence uncertain.

The bounded block must contain exactly two agreeing Amazon.in `/dp/` links: one
single-image link and one title link. These links are permitted wallet-card
structure, not proof by themselves. Absence of `purchasedItems` alone is also
insufficient. Purchased-item regions (including hidden copies), payment widgets,
additional product/image/quantity/price evidence, unsupported block text,
conflicting identities and cancellation/refund markers prevent classification.
The current card must have one complete matching order ID; existing date parsing
and any declared header-total validation remain required. The classifier makes
no request to wallet/detail pages and adds no wallet financial export.

Unknown or ambiguous records retain normal strict selection and extraction.
Products mentioning Amazon Pay Wallet and genuine purchases paid with wallet
balance are not excluded by payment wording or product title. A detail failure
never authorizes a skip. Unsupported layouts can still stop the entire export
without changing prior JSON; no live compatibility beyond the confirmed pattern
is claimed by offline fixtures.

Excluded funding records consume no merchandise slots or indexes. Funding-only
pages continue pagination, and funding dates cannot trigger the merchandise date
cutoff. The existing 50-order cap and 20-page bound remain. New cards beyond an
already full merchandise cap retain the existing non-validation behavior; known
duplicates remain checked across scanned pages. Funding IDs are counted once; conflicting classification, dates or declared header facts
fail closed, including across pages. No funding identity, amount or type flag is
added to public JSON. Independent merchandise totals and one-paise reconciliation
are unchanged.

`LIST_WALLET_FUNDING_EXCLUDED` records the cumulative unique excluded-card count
across scanned pages, with no merchandise order index or funding facts. Existing
`LIST_WALLET_LABEL_UNVERIFIED`, `LIST_WALLET_LABEL_AMBIGUOUS` and
`LIST_WALLET_EVIDENCE_UNAVAILABLE` remain diagnostic-only hints and never authorize
exclusion; in particular the former assumed combined `Amazon Pay Wallet Add
Money` field is not classification proof. Observation errors retain safe codes
without exception messages. No raw labels, DOM snapshots, balances, IDs, amounts,
paths or URLs are added by wallet events; existing private report handling is
unchanged.

Issue #20 remains open for independent inspection of this correction. Any further
owner-local evidence should contain only masked tag/role/stable-attribute
structure, field meanings and uniqueness/visibility counts; do not share personal
HTML, screenshots, IDs, prices, URLs, balances or credentials. Another isolated
live validation, synchronization, merge or deployment needs separate approval.

Confirmed unpriced cancellations retain the existing constrained null-money
representation only when the list has no total, cancellation is independently
confirmed on Order Details, cancelled list items exist, no adjustments exist, and
no visible eligible detail Grand Total is declared. An invalid or conflicting
detail declaration cannot activate this fallback. Unsupported layouts require a
parser update and fail closed.

Purchase totals and tender sources are distinct: vouchers and gift-card balances
fund an order; they are not inferred discounts or additional purchases. Neither
payment sums nor item/fee sums can substitute for an independently extracted
gross total. Reconciliation still requires items plus explicit adjustments to
match that gross total within one paise before atomic output publication.

This local JSON contract excludes recipient names, addresses, payment/card and
gift-card data, tracking data, invoice contents, and browser session data. It
does not upload data or integrate with Google Sheets, Fold, or any consumer
repository.


Failures automatically create a separate, private JSON diagnostic report in
`~/.amazon-order-history-poc/failure-reports/` (on Windows:
`$HOME\.amazon-order-history-poc\failure-reports`). No debug flag is required.
This directory is outside Git repositories and separate from the exported JSON.
Console output and scheduled operational logs contain only stage/reason codes,
counts, and whether the report was saved. Exit status remains 1 on failure;
authentication failures still leave Chromium open for manual sign-in.

Amazon Now adds categorical checkpoints to the existing bounded event list:
`NOW_NAVIGATION`, `NOW_DETAILS_CONTROL`, `NOW_TRACKING_IDENTITY`,
`NOW_DIALOG_OPEN`, `NOW_DIALOG_IDENTITY`, `NOW_BILL_SUMMARY`,
`NOW_ITEMS_FEES`, and `NOW_PARSING`. These record entry into an operation,
not proof that it succeeded. The DOM reader returns only allowlisted failure
categories for diagnostics: `NOW_DOM_BOUNDS_INVALID`,
`NOW_TRACKING_IDENTITY_INVALID`, `NOW_DIALOG_IDENTITY_INVALID`,
`NOW_ORDER_STATUS_UNSUPPORTED`, `NOW_BILL_SUMMARY_INVALID`,
`NOW_BILL_ROW_INVALID`, `NOW_ITEM_OWNERSHIP_INVALID`, and
`NOW_ITEM_FIELDS_INVALID`. Parsing/reconciliation retains its existing exact
reason codes, including `TOTAL_MISMATCH`. Playwright timeouts retain category
`timeout`; unexpected errors use `operation-failed` without their messages or
stacks. A transport failure during the DOM read can only identify the entered
read operation; internal checkpoints are available when the bounded read returns.
These additions contain only fixed codes, elapsed time and the selected order
index, without adding IDs, amounts, product text, URLs or page content. They do
not change extraction acceptance rules or capture partial snapshots as evidence.

Inside `parseNowSnapshot`, item-facts rejections add one fixed event before the
unchanged terminal `items/ITEM_FACTS_INVALID` failure:

| Event reason | Rejected item facts |
| --- | --- |
| `NOW_PARSE_QUANTITY_MISSING` | No quantity-signal field. |
| `NOW_PARSE_QUANTITY_DUPLICATE` | Multiple quantity-signal fields, even if identical. |
| `NOW_PARSE_QUANTITY_INVALID` | The sole quantity field fails the existing explicit grammar, range or positive safe-integer check. |
| `NOW_PARSE_NAME_MISSING` | No product-name field, or a blank sole name. |
| `NOW_PARSE_NAME_DUPLICATE` | Multiple product-name candidates. |
| `NOW_PARSE_IDENTIFIERS_CONFLICT` | Validated image/link identifiers disagree. |

The event includes only fixed stage/reason, elapsed time, the selected order
index when available, and `lineIndex`: the zero-based snapshot item index bounded
to 0–99. The existing report-level `lineIndex` also identifies that failing row;
no partial item facts are captured. Attribution follows the original validation
order and stops at the first rejected row/condition. A quantity-signal field
means the existing conservative recognizer matched, not that its grammar is
valid. Earlier DOM ownership or snapshot-shape failures retain their own codes
without inventing a parser item index. Price and reconciliation failures retain
their existing reasons. These events contain no raw text, identifiers, monetary
values, URLs, selectors, DOM or exception messages. Parser acceptance, wallet
classification, merchandise selection, export JSON and atomic publication are
unchanged.

Merchandise ownership rejections use the following fixed subreasons. The generic
`NOW_ITEM_OWNERSHIP_INVALID` remains allowlisted as a compatibility fallback;
every current ownership abort site has a specific attribution.

| Reason | Existing rejection |
| --- | --- |
| `NOW_NON_ITEM_REGION_INVALID` | A recognized decorative/status/payment region has an invalid boundary or contains merchandise/bill evidence. |
| `NOW_ITEM_QUANTITY_MISSING` | No visible quantity candidates remain after exclusions. |
| `NOW_ITEM_EVIDENCE_EXCESSIVE` | Quantity or image evidence exceeds the existing 100-candidate bound. |
| `NOW_ITEM_QUANTITY_AMBIGUOUS` | A candidate row scope does not contain exactly one quantity. |
| `NOW_ITEM_IMAGE_AMBIGUOUS` | A candidate row scope contains multiple merchandise images. |
| `NOW_ITEM_BOUNDARY_INVALID` | The bounded row search reaches an invalid scope or conflicts with an excluded region. |
| `NOW_ITEM_ROWS_OVERLAP` | Candidate merchandise rows contain or overlap each other. |
| `NOW_ITEM_IMAGE_OWNER_INVALID` | An image does not have exactly one merchandise owner. |
| `NOW_ITEM_LINK_OWNER_INVALID` | A product link does not have exactly one merchandise owner. |
| `NOW_ITEM_PRICE_OWNER_INVALID` | Current price evidence does not have exactly one merchandise owner. |

Attribution follows the existing validation order and stops at the first
rejection. At the evidence-limit check, missing quantities take precedence over
excessive evidence. At the final ownership check, images precede product links,
which precede current prices, independently of their DOM order. These codes add
no counts, text, selectors, DOM snapshots or financial facts. They identify the
rejected condition without explaining its live cause or relaxing any rule.

Reports contain available validated order IDs, dates/cancellation status, the
zero-based selected order index, product names/ASINs, quantities, monetary facts
in integer paise, adjustments, extraction/fallback sources, bounded technical
events and stage timings, and runtime versions where available. Reconciliation
records item and adjustment sums, expected and actual totals, and
`differencePaise = actualPaise - expectedPaise` (tolerance: one paise). Missing
facts stay missing; diagnostics do not infer the cause of the first-order
failure. The export contract and validation rules are unchanged. No additional
payment pages are visited and no payment categories are collected.

**Treat these reports as private purchase records.** Inspect them only on the
owner's machine; do not paste or attach the full report to chat, GitHub, CI,
notifications, shared folders, or cloud-synced storage. Reports exclude raw
HTML/screenshots, raw exception messages/stacks, URLs, credentials, OTPs,
cookies, card/UPI identifiers, recipients and contact/address fields. Only
allowlisted facts are retained; suspicious product text and unrecognized
adjustment labels are omitted. To open the latest report locally on Windows:

```powershell
$diagnosticDir = Join-Path $HOME '.amazon-order-history-poc\failure-reports'
$latestReport = Get-ChildItem -LiteralPath $diagnosticDir -File -Filter 'failure-*.json' |
  Sort-Object Name -Descending | Select-Object -First 1
if ($latestReport) { notepad.exe $latestReport.FullName }
```

For troubleshooting outside the owner's machine, share only `failure.stage`,
`failure.reason`, `failure.category`, and counts after checking them. A message
that the report is unavailable means the local write/cleanup or permission check
failed; the original export failure and exit status are preserved. Check free
disk space and access to the diagnostic directory without posting private paths
or file contents. Reports use owner-only Windows ACLs (via local PowerShell) or
POSIX directory/file modes `0700`/`0600`. If access cannot be restricted, the
report is not written. Do not relax permissions to make reporting work.

On each export, reports aged 30 days are removed, with a maximum of 50 managed
files at 128 KiB each (6.25 MiB total). Reports cap item/adjustment lines at 100
and technical events/timings at 200; `truncated` flags omitted evidence. The
writer validates the complete report against a strict recursive runtime allowlist
before touching the filesystem; unexpected fields or unsafe values reject the
report. It uses exclusive temporary files and atomic rename. Capacity eviction
of valid reports happens only after a new report is published, so a failed
write or rename preserves existing valid evidence. Cleanup only handles
recognized report filenames, skips links and directories, and removes abandoned
temporary files after an hour. Expiry runs when the exporter runs, not as a
background service. To delete evidence sooner, stop the exporter, open the
`failure-reports` folder locally, and delete only its generated
`failure-<timestamp>-<UUID>.json` / `.json.tmp` files. Leave the sibling
`browser-data` profile intact.

## Supported Regions

| Region         | Domain        | Currency |
| -------------- | ------------- | -------- |
| United States  | amazon.com    | USD      |
| United Kingdom | amazon.co.uk  | GBP      |
| Canada         | amazon.ca     | CAD      |
| Germany        | amazon.de     | EUR      |
| France         | amazon.fr     | EUR      |
| Spain          | amazon.es     | EUR      |
| Italy          | amazon.it     | EUR      |
| Netherlands    | amazon.nl     | EUR      |
| Japan          | amazon.co.jp  | JPY      |
| Australia      | amazon.com.au | AUD      |
| Mexico         | amazon.com.mx | MXN      |
| India          | amazon.in     | INR      |
| UAE            | amazon.ae     | AED      |
| Saudi Arabia   | amazon.sa     | SAR      |
| Ireland        | amazon.ie     | EUR      |
| Belgium        | amazon.com.be | EUR      |

## Export Types

### Orders (`export_amazon_orders_csv`)

Fast order summary from the order list page (~0.5s per 10 orders). Best for browsing and basic reporting.

| Column           | Description                                   |
| ---------------- | --------------------------------------------- |
| Order ID         | Amazon order identifier (XXX-XXXXXXX-XXXXXXX) |
| Order Date       | Date order was placed (YYYY-MM-DD)            |
| Total            | Order total amount                            |
| Status           | Delivery status (Delivered, Shipped, etc.)    |
| Items            | Number of items in order                      |
| Address Line 1-7 | Shipping address (up to 7 lines)              |
| Subscribe & Save | Subscription frequency if applicable          |
| Platform         | Always "amazon"                               |
| Region           | Amazon region code (us, uk, de, etc.)         |
| Order URL        | Link to order details page                    |

### Items (`export_amazon_items_csv`)

Detailed item-level export with full order context (~2s per order). Best for expense tracking and accounting.

| Column            | Description                        |
| ----------------- | ---------------------------------- |
| Order ID          | Parent order identifier            |
| Order Date        | Date order was placed              |
| ASIN              | Amazon product identifier          |
| Product Name      | Full product title                 |
| Condition         | New, Used, etc.                    |
| Quantity          | Number of units                    |
| Unit Price        | Price per item                     |
| Item Total        | Quantity × Unit Price              |
| Seller            | Seller/merchant name               |
| Subscribe & Save  | Subscription frequency             |
| Order Subtotal    | Pre-tax/shipping subtotal          |
| Order Shipping    | Shipping cost                      |
| Order Tax         | Sales tax amount                   |
| Order VAT         | VAT amount (UK/EU)                 |
| Order Promotion   | Discount amount                    |
| Order Total       | Final order total                  |
| Order Grand Total | Including all fees                 |
| Order Status      | Delivery status                    |
| Recipient         | Ship-to name                       |
| Address Line 1-7  | Full shipping address              |
| Payment Method    | Card type (Visa, Mastercard, etc.) |
| Card Last 4       | Last 4 digits of card              |
| Product URL       | Link to product page               |
| Image URL         | Product image URL                  |
| Order URL         | Link to order details              |
| Region            | Amazon region code                 |

### Shipments (`export_amazon_shipments_csv`)

Shipment and tracking information (~4s per order, +2s with `fetch_tracking_numbers`). Best for delivery tracking.

| Column            | Description                                |
| ----------------- | ------------------------------------------ |
| Order ID          | Parent order identifier                    |
| Order Date        | Date order was placed                      |
| Shipment ID       | Unique shipment identifier                 |
| Status            | Shipment status text                       |
| Delivered         | Yes/No/Unknown                             |
| Tracking ID       | Carrier tracking number                    |
| Carrier           | Carrier name (Royal Mail, DPD, etc.)       |
| Tracking URL      | Link to carrier tracking                   |
| Items in Shipment | Number of items                            |
| Item Names        | List of product names                      |
| Payment Amount    | Amount charged (falls back to order total) |
| Refund            | Refund amount if any                       |
| Region            | Amazon region code                         |

**Note**: Set `fetch_tracking_numbers: true` to visit ship-track pages and extract actual carrier tracking IDs (e.g., "AZ218181365JE") and carrier names. Without this option, only Amazon's internal tracking URLs are captured.

### Transactions (`export_amazon_transactions_csv`)

Payment transaction details for financial reconciliation.

| Column           | Description         |
| ---------------- | ------------------- |
| Transaction Date | Date of charge      |
| Order ID(s)      | Associated order(s) |
| Payment Method   | Card/payment type   |
| Card Info        | Last 4 digits       |
| Amount           | Transaction amount  |
| Currency         | Currency code       |

### Gift Cards (`export_amazon_gift_cards_csv`)

Gift card activity and balance history.

| Column          | Description               |
| --------------- | ------------------------- |
| Date            | Transaction date          |
| Description     | Activity description      |
| Type            | added/applied/refund      |
| Amount          | Transaction amount        |
| Closing Balance | Balance after transaction |
| Order ID        | Associated order if any   |
| Claim Code      | Gift card claim code      |
| Serial Number   | Gift card serial number   |
| Currency        | Currency code             |
| Region          | Amazon region code        |

## Additional Tools

### Query Tools

| Tool                                | Description                                   |
| ----------------------------------- | --------------------------------------------- |
| `get_amazon_orders`                 | Fetch orders with optional items/shipments    |
| `get_amazon_order_details`          | Get full details for a specific order         |
| `get_amazon_transactions`           | Fetch all transactions from transactions page |
| `get_amazon_gift_card_balance`      | Get current balance and history               |
| `get_amazon_gift_card_transactions` | Get detailed gift card activity               |
| `check_amazon_auth_status`          | Check if browser is logged in                 |

### Invoice PDF download (`download_amazon_invoice`)

Downloads an A4 PDF for one authenticated order after confirming that the print
page contains both the requested order ID and invoice-specific content.

```json
{
  "order_id": "123-4567890-1234567",
  "region": "uk",
  "output_path": "/absolute/path/to/invoice.pdf"
}
```

`output_path` is optional and must be absolute when supplied. The default is
`~/Downloads/amazon-{region}-invoice-{order_id}.pdf`; its parent directory is
created when needed. A successful response reports the saved `path` and exact
`bytes`. Authentication redirects, Amazon error pages, mismatched invoice
identity, rendering failures, and write failures return an MCP error without
publishing a partial PDF or replacing a prior file.

### Transactions Page (`get_amazon_transactions`)

Extracts ALL payment transactions from Amazon's dedicated transactions page (`/cpe/yourpayments/transactions`). Much faster than extracting from individual order pages.

```json
{
  "region": "us",
  "start_date": "2024-01-01",
  "end_date": "2024-12-31"
}
```

### Gift Card Balance (`get_amazon_gift_card_balance`)

Gets your current Amazon gift card balance and recent activity from `/gc/balance`.

```json
{
  "region": "us"
}
```

Returns:

- Current balance
- Recent gift card activity (credits/debits)
- Associated order IDs

### Authentication Check (`check_amazon_auth_status`)

Verify if the browser session is authenticated before running exports.

```json
{
  "region": "uk"
}
```

Returns authentication status, username if logged in, or login URL if not.

## Timeouts & Large Order Histories

When exporting large order histories (100+ orders), the extraction process can take several minutes. MCP clients typically have timeout limits that may need adjustment.

### Estimated Processing Times

| Orders | Estimated Time |
| ------ | -------------- |
| 10     | ~15 seconds    |
| 50     | ~1.5 minutes   |
| 100    | ~3 minutes     |
| 500    | ~15 minutes    |

### Recommendations

1. **Use `max_orders` parameter** to limit extraction scope
2. **Export by year** rather than entire history
3. **Configure client timeouts** if needed (see below)

### Client Timeout Configuration

For OpenCode/Claude Desktop, the timeout is typically set in the MCP client configuration. If you see `MCP error -32001: Maximum total timeout exceeded`, you may need to:

1. Use smaller batches with `max_orders`
2. Configure your MCP client's `maxTotalTimeout` setting (if available)
3. The server sends progress notifications which can reset timeouts if `resetTimeoutOnProgress` is enabled in your client

### Progress Notifications

The server sends progress notifications during extraction:

- `Order X/Y (order-id) - ETA: ~Xm Xs`

These help track progress and can reset client timeouts if configured.

## Development

```bash
# Run in development mode
npm run dev

# Run tests
npm test

# Type checking
npm run typecheck

# Linting
npm run lint
```

### Testing with MCP Inspector

For development and debugging, use the official [MCP Inspector](https://github.com/modelcontextprotocol/inspector) tool instead of running through an AI assistant. This provides:

- **Direct tool invocation** - Call MCP tools directly with custom parameters
- **Real-time response viewing** - See full JSON responses without AI interpretation
- **Faster iteration** - No waiting for AI to process requests
- **Debug visibility** - View raw server output and errors

#### Quick Start

```bash
# Install MCP Inspector globally
npm install -g @modelcontextprotocol/inspector

# Run inspector with this server
npx @modelcontextprotocol/inspector node dist/index.js
```

Then open `http://localhost:5173` in your browser to:

1. See all available tools listed
2. Click a tool to view its schema
3. Fill in parameters and execute
4. View the raw JSON response

#### Example Test Workflow

1. **Test authentication**: Call `check_amazon_auth_status` with `{"region": "uk"}`
2. **Test order fetch**: Call `get_amazon_orders` with a small date range
3. **Test order details**: Call `get_amazon_order_details` with a known order ID
4. **Test exports**: Call any `export_amazon_*_csv` tool

This is the recommended approach for:

- Debugging extraction issues
- Verifying new features work correctly
- Testing region-specific behavior
- Investigating error responses

## Architecture

This project uses a plugin architecture designed for extensibility:

- **Core Framework**: Shared utilities for CSV, dates, currencies, browser automation
- **Platform Plugins**: Amazon-specific extraction logic (future: eBay, AliExpress, etc.)

See [AGENTS.md](AGENTS.md) for detailed architecture documentation.

## Related Projects

- **[QuickFile MCP](https://github.com/marcusquinn/quickfile-mcp)** - MCP server for QuickFile UK accounting software. Use Amazon order exports with QuickFile for expense tracking and VAT reconciliation.
- **[OpenCode](https://opencode.ai)** - Open-source AI coding assistant with MCP support
- **[QuickFile](https://www.quickfile.co.uk/)** - UK accounting software
- **[QuickFile API](https://api.quickfile.co.uk/)** - QuickFile API documentation
- **[Model Context Protocol](https://modelcontextprotocol.io)** - Protocol specification for AI tool integration
- **[AI DevOps Framework](https://github.com/marcusquinn/aidevops)** - Comprehensive AI infrastructure management

## Credits

This project was inspired by [AZAD](https://github.com/philipmulcahy/azad), a Chrome
extension for Amazon order history export. This is an original implementation built
as an MCP server - not a fork or derivative work.

See [CREDITS.md](CREDITS.md) for full acknowledgments.

## License

MIT License - see [LICENSE](LICENSE) for details.

## Contributing

Contributions welcome! Please read [AGENTS.md](AGENTS.md) for development guidelines.
