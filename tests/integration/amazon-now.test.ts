/** Invented fixtures, ephemeral Chromium, every request intercepted. No Amazon access. */
import { existsSync, readFileSync } from "fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { chromium, Browser, BrowserContext, Page } from "playwright";
import { extractNowOrder } from "../../src/poc/amazon-now";
import {
  FailureDiagnostics,
  NOW_OWNERSHIP_FAILURES,
  writeFailureReport,
} from "../../src/poc/failure-diagnostics";
import {
  AuthenticationRequiredError,
  closeBrowser,
  extractOrderItems,
  listOrders,
  parseCurrentOrderPage,
} from "../../src/poc/hardened-index-v3";
import {
  createExportDocument,
  runExport,
  validateAndWriteExport,
} from "../../src/poc/export-json";

const executable = [chromium.executablePath(), "/usr/bin/chromium"].find(
  existsSync,
);
const browserTests = executable ? describe : describe.skip;
const id = "111-2222222-3333333";
const outer = `https://www.amazon.in/uff/your-account/order-details?orderID=${id}`;
const tracking = `https://www.amazon.in/tez/browse/orderTracking?orderId=${id}`;
const original = readFileSync(
  join(__dirname, "fixtures/amazon-now-order.html"),
  "utf8",
);
const splitPackagePrices = readFileSync(
  join(__dirname, "fixtures/amazon-now-a11y-prices.html"),
  "utf8",
);
const tabletOrder = readFileSync(
  join(__dirname, "fixtures/amazon-now-tablets.html"),
  "utf8",
);
const tabletDescriptor = "Pack of 1, 60 Tablets";
const tabletFields = `<span class="package-size">${tabletDescriptor}</span><span class="package-separator">.</span><div class="quantity">1 unit</div>`;
const tabletCases: [string, string][] = [
  ...[
    "Pack of 0, 60 Tablets",
    "Pack of 1, 0 Tablets",
    "Pack of 9007199254740992, 60 Tablets",
    "Pack of 1, 9007199254740992 Tablets",
    "Pack of -1, 60 Tablets",
    "Pack of 1, -60 Tablets",
    "Pack of 1.5, 60 Tablets",
    "Pack of 1, 60.5 Tablets",
    "Pack of 01, 60 Tablets",
    "Pack of 1, 060 Tablets",
    "Pack of +1, 60 Tablets",
    "Pack of 1e2, 60 Tablets",
    "Pack of 1; 60 Tablets",
    "Pack of 1， 60 Tablets",
    "Pack of 1,60 Tablets",
    "Pack of 1, 60 Tablet",
    "Pack of 1, 60 Capsules",
    "Pack of 1, 60 Sheets",
    "Pack of 1, 60 tablets",
    "pack of 1, 60 Tablets",
    "Pack of , 60 Tablets",
    "Pack of 1, Tablets",
    "Pack of 1, 60",
    "60 Tablets, Pack of 1",
    "Pack of 1, 60 Tablets extra",
    "Box of 1, 60 Tablets",
    "Pack of 1, 60 Tablets.",
    "",
  ].map((value): [string, string] => [
    value,
    tabletOrder.replace(tabletDescriptor, value),
  ]),
  [
    "duplicate descriptor",
    tabletOrder.replace(
      tabletFields,
      `<span>${tabletDescriptor}</span>${tabletFields}`,
    ),
  ],
  [
    "reordered fields",
    tabletOrder.replace(
      tabletFields,
      `<span>.</span><span>${tabletDescriptor}</span><div class="quantity">1 unit</div>`,
    ),
  ],
  [
    "missing separator",
    tabletOrder.replace(
      tabletFields,
      `<span>${tabletDescriptor}</span><div class="quantity">1 unit</div>`,
    ),
  ],
  [
    "wrong separator",
    tabletOrder.replace(
      tabletFields,
      tabletFields.replace(
        'class="package-separator">.',
        'class="package-separator">·',
      ),
    ),
  ],
  [
    "duplicate separator",
    tabletOrder.replace(
      tabletFields,
      tabletFields.replace("</span><div", "</span><span>.</span><div"),
    ),
  ],
  [
    "missing count",
    tabletOrder.replace(
      tabletFields,
      tabletFields.replace('<div class="quantity">1 unit</div>', ""),
    ),
  ],
  [
    "duplicate count",
    tabletOrder.replace(tabletFields, `${tabletFields}<div>Qty: 1</div>`),
  ],
  [
    "different parents",
    tabletOrder.replace(
      tabletFields,
      `<div><span>${tabletDescriptor}</span><span>.</span></div><div class="quantity">1 unit</div>`,
    ),
  ],
  [
    "hidden descriptor",
    tabletOrder.replace(
      tabletFields,
      tabletFields.replace(
        'class="package-size"',
        'class="package-size" hidden',
      ),
    ),
  ],
  [
    "hidden descriptor and separator",
    tabletOrder.replace(
      tabletFields,
      tabletFields
        .replace('class="package-size"', 'class="package-size" hidden')
        .replace(
          'class="package-separator"',
          'class="package-separator" hidden',
        ),
    ),
  ],
  [
    "historical descriptor and separator",
    tabletOrder.replace(
      tabletFields,
      `<s>${tabletDescriptor}</s><s>.</s><div class="quantity">1 unit</div>`,
    ),
  ],
  ...[tabletDescriptor, "Pack of 0, 60 Tablets", "Pack of 1, 60 Capsules"].map(
    (value): [string, string] => [
      `hidden extra ${value}`,
      tabletOrder.replace(
        tabletFields,
        `${tabletFields}<span hidden>${value}</span>`,
      ),
    ],
  ),
  [
    "historical extra descriptor",
    tabletOrder.replace(
      tabletFields,
      `${tabletFields}<s>${tabletDescriptor}</s>`,
    ),
  ],
  [
    "hidden qualifier",
    tabletOrder.replace(
      tabletDescriptor,
      `${tabletDescriptor}<span hidden>extra</span>`,
    ),
  ],
  [
    "extra name",
    tabletOrder.replace(
      tabletFields,
      `<div>Extra invented name</div>${tabletFields}`,
    ),
  ],
  [
    "ambiguous descriptor name",
    tabletOrder.replace("Invented tablet-fixture item 08", tabletDescriptor),
  ],
  ["missing name", tabletOrder.replace("Invented tablet-fixture item 08", "")],
  [
    "product link in descriptor",
    tabletOrder.replace(
      tabletDescriptor,
      `${tabletDescriptor}<a href="/dp/B0PACK0008"></a>`,
    ),
  ],
  [
    "unexpected product identity",
    tabletOrder.replace(
      tabletFields,
      `<a href="/dp/B0FAKE0099"></a>${tabletFields}`,
    ),
  ],
  [
    "missing price",
    tabletOrder
      .replace(/<div id="pack-price-8"[^>]*>[\s\S]*?<\/div>/, "")
      .replace("You pay ₹141.00", "You pay ₹120.00"),
  ],
  [
    "two units without unit price",
    tabletOrder.replace(
      tabletFields,
      tabletFields.replace("1 unit", "2 units"),
    ),
  ],
  [
    "invalid billed total",
    tabletOrder.replace("You pay ₹141.00", "You pay ₹141.02"),
  ],
];
// Retain all earlier single-field presentation regressions alongside the updated fixture.
const a11yPrices = splitPackagePrices.replace(
  /<span class="package-size">(400 g|1 kg|500 g|0\.5 l)<\/span><span class="package-separator">\.<\/span><div class="quantity">1 unit<\/div>/g,
  (_field, size: string) =>
    `<div class="quantity">${
      size === "400 g"
        ? "250 g ·"
        : size === "1 kg"
          ? "2 kg •"
          : size === "500 g"
            ? "75 ml |"
            : "0.5 l ·"
    } 1 unit</div>`,
);
const splitPackage =
  '<span class="package-size">400 g</span><span class="package-separator">.</span><div class="quantity">1 unit</div>';
const splitPackageCases: [string, string][] = [
  [
    "hidden descriptor and separator",
    splitPackagePrices.replace(
      splitPackage,
      splitPackage
        .replace('class="package-size"', 'class="package-size" hidden')
        .replace(
          'class="package-separator"',
          'class="package-separator" hidden',
        ),
    ),
  ],
  [
    "historical descriptor and separator",
    splitPackagePrices.replace(
      splitPackage,
      '<s>400 g</s><s>.</s><div class="quantity">1 unit</div>',
    ),
  ],
  ...["unit only", "line only", "mismatched pair"].map(
    (mode): [string, string] => [
      mode,
      splitPackagePrices
        .replace(
          '<div class="quantity">1 unit</div>',
          '<div class="quantity">2 units</div>',
        )
        .replace(
          /<div id="a11y-price-1"[^>]*>[\s\S]*?<\/div>/,
          `<div aria-hidden="true">${mode !== "line only" ? "<div>Unit price: <span>₹</span><span>6.00</span></div>" : ""}${mode !== "unit only" ? "<div>Line total: <span>₹</span><span>11.00</span></div>" : ""}</div>`,
        ),
    ],
  ),
  [
    "two-paise total mismatch",
    splitPackagePrices.replace("You pay ₹506.00", "You pay ₹506.02"),
  ],
  ...[
    "",
    "0 g",
    "-400 g",
    "400 oz",
    "400",
    "g",
    "400-500 g",
    "Approx. 400 g",
    "four hundred g",
    "400 g extra",
    "01 kg",
    "1e3 g",
    "400.001.2 g",
  ].map((size): [string, string] => [
    size,
    splitPackagePrices.replace(
      'class="package-size">400 g',
      `class="package-size">${size}`,
    ),
  ]),
  ...["·", "•", "|", "/", "..", ".·", "∙", ""].map(
    (separator): [string, string] => [
      `separator ${separator}`,
      splitPackagePrices.replace(
        'class="package-separator">.',
        `class="package-separator">${separator}`,
      ),
    ],
  ),
  [
    "duplicate separator",
    splitPackagePrices.replace(
      'class="package-separator">.</span>',
      'class="package-separator">.</span><span>.</span>',
    ),
  ],
  [
    "duplicate measurement",
    splitPackagePrices.replace(
      splitPackage,
      `<span>500 g</span>${splitPackage}`,
    ),
  ],
  [
    "misordered metadata",
    splitPackagePrices.replace(
      splitPackage,
      '<span>.</span><span>400 g</span><div class="quantity">1 unit</div>',
    ),
  ],
  [
    "metadata after quantity",
    splitPackagePrices.replace(
      splitPackage,
      '<div class="quantity">1 unit</div><span>400 g</span><span>.</span>',
    ),
  ],
  [
    "metadata before name",
    splitPackagePrices.replace(
      "<h3>Synthetic access item 01</h3>" + splitPackage,
      splitPackage + "<h3>Synthetic access item 01</h3>",
    ),
  ],
  [
    "unrelated text between fields",
    splitPackagePrices.replace(
      splitPackage,
      splitPackage.replace(
        '<span class="package-separator">',
        'Unknown<span class="package-separator">',
      ),
    ),
  ],
  [
    "extra name",
    splitPackagePrices.replace(
      splitPackage,
      `<div>Additional invented name</div>${splitPackage}`,
    ),
  ],
  [
    "different metadata parents",
    splitPackagePrices.replace(
      splitPackage,
      '<div><span>400 g</span><span>.</span></div><div class="quantity">1 unit</div>',
    ),
  ],
  [
    "hidden descriptor",
    splitPackagePrices.replace(
      'class="package-size"',
      'class="package-size" hidden',
    ),
  ],
  [
    "hidden separator",
    splitPackagePrices.replace(
      'class="package-separator"',
      'class="package-separator" aria-hidden="true"',
    ),
  ],
  [
    "hidden conflicting descriptor",
    splitPackagePrices.replace(
      splitPackage,
      `${splitPackage}<span hidden>500 g</span>`,
    ),
  ],
  [
    "historical conflicting descriptor",
    splitPackagePrices.replace(splitPackage, `${splitPackage}<s>0 kg</s>`),
  ],
  [
    "hidden conflicting separator",
    splitPackagePrices.replace(
      splitPackage,
      `${splitPackage}<span hidden>.</span>`,
    ),
  ],
  [
    "hidden conflicting quantity",
    splitPackagePrices.replace(
      splitPackage,
      `${splitPackage}<span hidden>Qty: 2</span>`,
    ),
  ],
  [
    "hidden field qualifier",
    splitPackagePrices.replace(
      'class="package-size">400 g</span>',
      'class="package-size">400 g<span hidden>extra</span></span>',
    ),
  ],
  [
    "missing name",
    splitPackagePrices.replace("<h3>Synthetic access item 01</h3>", ""),
  ],
  [
    "missing quantity",
    splitPackagePrices.replace('<div class="quantity">1 unit</div>', ""),
  ],
  [
    "duplicate quantity",
    splitPackagePrices.replace(
      splitPackage,
      `${splitPackage}<div>Qty: 1</div>`,
    ),
  ],
  [
    "compound quantity",
    splitPackagePrices.replace(
      '<div class="quantity">1 unit</div>',
      '<div class="quantity">500 g · 1 unit</div>',
    ),
  ],
  [
    "unsafe quantity",
    splitPackagePrices.replace(
      '<div class="quantity">1 unit</div>',
      '<div class="quantity">9007199254740992 units</div>',
    ),
  ],
  [
    "zero quantity",
    splitPackagePrices.replace(
      '<div class="quantity">1 unit</div>',
      '<div class="quantity">0 units</div>',
    ),
  ],
  [
    "two units without prices",
    splitPackagePrices.replace(
      '<div class="quantity">1 unit</div>',
      '<div class="quantity">2 units</div>',
    ),
  ],
  [
    "unexpected product identifier",
    splitPackagePrices.replace(
      splitPackage,
      `<a href="/dp/B0FAKE0099"></a>${splitPackage}`,
    ),
  ],
  [
    "product evidence inside descriptor",
    splitPackagePrices.replace(
      'class="package-size">400 g</span>',
      'class="package-size">400 g<a href="/dp/B0A11Y0001"></a></span>',
    ),
  ],
  [
    "missing price",
    splitPackagePrices
      .replace(/<div id="a11y-price-1"[^>]*>[\s\S]*?<\/div>/, "")
      .replace(/₹506.00/g, "₹495.00"),
  ],
  [
    "bad price",
    splitPackagePrices.replace('class="number">11.00', 'class="number">11.001'),
  ],
  [
    "duplicate price",
    splitPackagePrices.replace(
      "<s>₹18.00</s>",
      "<span>₹11.00</span><s>₹18.00</s>",
    ),
  ],
];
const approximateQuantity = "Approx. (120-180 g) . 1 unit";
const chromeControl =
  /<button type="button" id="a11y-chrome">[\s\S]*?<\/button>/.exec(
    a11yPrices,
  )?.[0] ?? "";
const durationDecoration =
  /<div id="a11y-duration">[\s\S]*?<\/div><\/div><\/div>/.exec(
    a11yPrices,
  )?.[0] ?? "";
const decorationIcon = /<img[^>]+>/.exec(durationDecoration)?.[0] ?? "";
const nonItemImageCases: [string, string][] = [
  [
    "text-bearing button",
    a11yPrices.replace("</button><div", "Unknown</button><div"),
  ],
  [
    "hidden button text",
    a11yPrices.replace(
      "</button><div",
      "<span hidden>Unknown</span></button><div",
    ),
  ],
  [
    "button with extra image",
    a11yPrices.replace(
      chromeControl,
      chromeControl.replace("</button>", `${decorationIcon}</button>`),
    ),
  ],
  [
    "button with historical money",
    a11yPrices.replace(
      chromeControl,
      chromeControl.replace("</div>", "<s>₹1.00</s></div>"),
    ),
  ],
  [
    "button with hidden quantity",
    a11yPrices.replace(
      chromeControl,
      chromeControl.replace("</div>", "<span hidden>Qty: 1</span></div>"),
    ),
  ],
  [
    "button with product link",
    a11yPrices.replace(
      chromeControl,
      chromeControl.replace("</div>", '<a href="/dp/B0FAKE0099"></a></div>'),
    ),
  ],
  [
    "button with ASIN imagery",
    a11yPrices.replace("Invented dialog control", "Product B0FAKE0099 image"),
  ],
  [
    "button on merchandise boundary",
    a11yPrices.replace('id="a11y-chrome"', 'id="a11y-chrome" role="listitem"'),
  ],
  [
    "nested control in button",
    a11yPrices.replace(
      chromeControl,
      chromeControl.replace("<img", '<span role="button"></span><img'),
    ),
  ],
  [
    "extra sibling control",
    a11yPrices.replace(chromeControl, chromeControl.repeat(2)),
  ],
  [
    "extra empty sibling control",
    a11yPrices.replace(chromeControl, `${chromeControl}<button></button>`),
  ],
  [
    "two independently matching chrome controls",
    a11yPrices
      .replace(
        '<div id="a11y-frame">',
        `<div>${chromeControl.replace('id="a11y-chrome"', 'id="a11y-outer-chrome"')}<div><div id="a11y-frame">`,
      )
      .replace("</div></div></section>", "</div></div></div></div></section>"),
  ],
  [
    "button without its observed div wrapper",
    a11yPrices.replace(
      chromeControl,
      chromeControl.replace("<div>", "<span>").replace("</div>", "</span>"),
    ),
  ],
  [
    "quantity outside the sibling content",
    a11yPrices.replace(
      "</div></div></section>",
      "</div></div><div>Qty: 1</div></section>",
    ),
  ],
  [
    "unrelated frame text",
    a11yPrices.replace(chromeControl, `${chromeControl}Unknown`),
  ],
  [
    "unowned merchandise button",
    a11yPrices.replace(
      '<div role="list" id="a11y-merchandise">',
      `<button><div>${decorationIcon.replace("Invented duration icon", "B0FAKE0099")}</div></button><div role="list" id="a11y-merchandise">`,
    ),
  ],
  [
    "button in incomplete merchandise",
    a11yPrices
      .replace("250 g · 1 unit", "")
      .replace('<img alt="B0A11Y0001"', '<button><div><img alt="B0A11Y0001"')
      .replace(
        "<h3>Synthetic access item 01",
        "</div></button><h3>Synthetic access item 01",
      ),
  ],
  ...[
    "Arrived soon",
    "Arrived by 4:26 PM",
    "Arrived at 0:26 PM",
    "Arrived at 13:26 PM",
    "Arrived at 4:60 PM",
    "Arrived at 4:26",
    "Arrived at 4:26 ZZ",
    "Arrived at 4:26 PM extra",
  ].map((value): [string, string] => [
    value,
    a11yPrices.replace("Arrived at 4:26 PM", value),
  ]),
  [
    "unrelated duration suffix",
    a11yPrices.replace(
      "Delivered in 17 minutes",
      "Delivered in 17 minutes extra",
    ),
  ],
  [
    "unverified arrival",
    a11yPrices.replace(
      "<div>Arrived at 4:26 PM</div>",
      "<div>Arrival unavailable</div>",
    ),
  ],
  [
    "hidden arrival",
    a11yPrices.replace("<div>Arrived at", "<div hidden>Arrived at"),
  ],
  [
    "additional arrival leaf",
    a11yPrices.replace(
      "<div>Arrived at 4:26 PM</div>",
      "<div>Arrived at 4:26 PM</div><div>Arrived at 5:26 PM</div>",
    ),
  ],
  [
    "unrelated delivery text",
    a11yPrices.replace("<div>Arrived at", "Unknown<div>Arrived at"),
  ],
  [
    "additional delivery image",
    a11yPrices.replace(decorationIcon, decorationIcon.repeat(2)),
  ],
  [
    "hidden additional image",
    a11yPrices.replace(
      decorationIcon,
      `${decorationIcon}${decorationIcon.replace("<img", "<img hidden")}`,
    ),
  ],
  [
    "delivery product imagery",
    a11yPrices.replace("Invented duration icon", "Product B0FAKE0099 image"),
  ],
  [
    "delivery product link",
    a11yPrices.replace(
      "<div>Arrived at",
      '<a href="/dp/B0FAKE0099"></a><div>Arrived at',
    ),
  ],
  [
    "delivery monetary evidence",
    a11yPrices.replace(
      "<div>Arrived at",
      '<span aria-hidden="true">₹1.00</span><div>Arrived at',
    ),
  ],
  [
    "delivery historical evidence",
    a11yPrices.replace("<div>Arrived at", "<s>$1.00</s><div>Arrived at"),
  ],
  [
    "delivery quantity evidence",
    a11yPrices.replace("<div>Arrived at", "<span>1 unit</span><div>Arrived at"),
  ],
  [
    "delivery merchandise boundary",
    a11yPrices.replace(
      'id="a11y-duration"',
      'id="a11y-duration" role="listitem"',
    ),
  ],
  [
    "delivery nested control",
    a11yPrices.replace(
      "<div>Arrived at 4:26 PM</div>",
      "<button>Arrived at 4:26 PM</button>",
    ),
  ],
  [
    "unowned image in shared ancestor",
    a11yPrices
      .replace(decorationIcon, "")
      .replace(
        '<div role="list" id="a11y-merchandise">',
        `${decorationIcon}<div role="list" id="a11y-merchandise">`,
      ),
  ],
  [
    "missing merchandise",
    a11yPrices.replace(
      /<article role="listitem" id="a11y-row-1">[\s\S]*?<\/article>/,
      "",
    ),
  ],
  [
    "missing merchandise price despite adjusted total",
    a11yPrices
      .replace(/<div id="a11y-price-1"[^>]*>[\s\S]*?<\/div>/, "")
      .replace(/₹506.00/g, "₹495.00"),
  ],
  [
    "invalid billed total",
    a11yPrices.replace("You pay ₹506.00", "You pay ₹506.02"),
  ],
  [
    "invalid fee",
    a11yPrices.replace("Handling fee ₹5.00", "Handling fee ₹5.00 ₹7.00"),
  ],
];
const ownership = readFileSync(
  join(__dirname, "fixtures/amazon-now-ownership.html"),
  "utf8",
);
const ownershipImage = /<img[^>]+>/.exec(ownership)?.[0] ?? "";
const ownershipRow =
  /<article[^>]+>[\s\S]*?<\/article>/.exec(ownership)?.[0] ?? "";
const ownershipLink = '<a href="/dp/B0FAKE0999">Invented unowned link</a>';
const ownershipCases = [
  [
    "decorative region at root",
    "NOW_NON_ITEM_REGION_INVALID",
    ownership.replace("<!-- decoration -->", "<h2>Status</h2>"),
  ],
  [
    "status region containing quantity",
    "NOW_NON_ITEM_REGION_INVALID",
    ownership.replace(
      "<!-- decoration -->",
      '<div role="status"><span>Qty: 1</span></div>',
    ),
  ],
  [
    "payment region containing product link",
    "NOW_NON_ITEM_REGION_INVALID",
    ownership.replace(
      "<div>Invented funding, not a purchase charge</div>",
      ownershipLink,
    ),
  ],
  [
    "payment region containing product image",
    "NOW_NON_ITEM_REGION_INVALID",
    ownership.replace(
      "<div>Invented funding, not a purchase charge</div>",
      ownershipImage.replace(
        'alt="Invented ownership image"',
        'alt="B0FAKE0999"',
      ),
    ),
  ],
  [
    "status region containing bill",
    "NOW_NON_ITEM_REGION_INVALID",
    ownership
      .replace("<!-- decoration -->", '<div role="status">')
      .replace("</section>\n</section>", "</section></div>\n</section>"),
  ],
  [
    "missing quantities",
    "NOW_ITEM_QUANTITY_MISSING",
    ownership.replace("Qty: 1", "Quantity unavailable"),
  ],
  [
    "hidden quantity",
    "NOW_ITEM_QUANTITY_MISSING",
    ownership.replace("<div>Qty: 1</div>", "<div hidden>Qty: 1</div>"),
  ],
  [
    "excessive quantities",
    "NOW_ITEM_EVIDENCE_EXCESSIVE",
    ownership.replace("<!-- decoration -->", "<span>Qty: 1</span>".repeat(100)),
  ],
  [
    "excessive images",
    "NOW_ITEM_EVIDENCE_EXCESSIVE",
    ownership.replace("<!-- decoration -->", ownershipImage.repeat(100)),
  ],
  [
    "ambiguous quantities",
    "NOW_ITEM_QUANTITY_AMBIGUOUS",
    ownership.replace(
      "<div>Qty: 1</div>",
      "<div>Qty: 1</div><div>Quantity: 1</div>",
    ),
  ],
  [
    "ambiguous images",
    "NOW_ITEM_IMAGE_AMBIGUOUS",
    ownership.replace(ownershipImage, ownershipImage.repeat(2)),
  ],
  [
    "missing merchandise evidence at root boundary",
    "NOW_ITEM_BOUNDARY_INVALID",
    ownership.replace(
      ownershipImage,
      ownershipImage.replace("<img", '<img role="presentation"'),
    ),
  ],
  [
    "row encloses an excluded status region",
    "NOW_ITEM_BOUNDARY_INVALID",
    ownership.replace(
      "</article>",
      '<span role="status">Ready</span></article>',
    ),
  ],
  [
    "overlapping rows at bounded ancestor limit",
    "NOW_ITEM_ROWS_OVERLAP",
    ownership.replace(
      /<!-- merchandise -->[\s\S]*?<!-- \/merchandise -->/,
      `<div>${"<div>".repeat(6)}<span>Qty: 1</span>${"</div>".repeat(6)}${ownershipRow}</div>`,
    ),
  ],
  [
    "unowned image",
    "NOW_ITEM_IMAGE_OWNER_INVALID",
    ownership.replace("<!-- decoration -->", ownershipImage),
  ],
  [
    "unowned product link",
    "NOW_ITEM_LINK_OWNER_INVALID",
    ownership.replace("<!-- decoration -->", ownershipLink),
  ],
  [
    "unowned current price",
    "NOW_ITEM_PRICE_OWNER_INVALID",
    ownership.replace("<!-- decoration -->", "<div>₹1.00</div>"),
  ],
  [
    "image before link and price despite DOM order",
    "NOW_ITEM_IMAGE_OWNER_INVALID",
    ownership.replace(
      "<!-- decoration -->",
      `<div>₹1.00</div>${ownershipLink}${ownershipImage}`,
    ),
  ],
  [
    "link before price despite DOM order",
    "NOW_ITEM_LINK_OWNER_INVALID",
    ownership.replace(
      "<!-- decoration -->",
      `<div>₹1.00</div>${ownershipLink}`,
    ),
  ],
  [
    "missing quantity before excessive images",
    "NOW_ITEM_QUANTITY_MISSING",
    ownership
      .replace("Qty: 1", "Quantity unavailable")
      .replace("<!-- decoration -->", ownershipImage.repeat(100)),
  ],
] as const;
const presentation = readFileSync(
  join(__dirname, "fixtures/amazon-now-presentation.html"),
  "utf8",
);
const [plainStatus, explanatoryFee] = readFileSync(
  join(__dirname, "fixtures/amazon-now-status-fee.html"),
  "utf8",
).split("<!-- handling-row -->");
const statusFeePresentation = presentation
  .replace(/<section id="delivery-status">[\s\S]*?<\/section>/, plainStatus)
  .replace(/<div id="handling">[\s\S]*?<\/div>/, explanatoryFee);
const list = `<div class="order-card"><div class="order-header">Order placed 1 October 2026<div>Total ₹230.00</div><span>${id}</span></div><a href="${outer}">View order details</a></div>`;
const options = {
  startDate: "2026-10-01",
  endDate: "2026-10-02",
  maxOrders: 5,
};

browserTests("integrated Amazon Now extraction", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let html: string;
  let listHtml: string;
  let redirect: string;
  let requests: string[];
  beforeAll(async () => {
    browser = await chromium.launch({
      executablePath: executable,
      headless: true,
    });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    context = await browser.newContext({
      offline: true,
      serviceWorkers: "block",
    });
    html = original;
    listHtml = list;
    redirect = tracking;
    requests = [];
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      requests.push(url.pathname);
      if (url.pathname.startsWith("/uff/"))
        return route.fulfill({
          contentType: "text/html",
          body: `<script>location.replace(${JSON.stringify(redirect)})</script>`,
        });
      return route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: url.pathname.startsWith("/tez/") ? html : listHtml,
      });
    });
    page = await context.newPage();
  });
  afterEach(async () => {
    await closeBrowser();
    await context.close();
    jest.restoreAllMocks();
  });
  const extract = async (trace?: FailureDiagnostics) =>
    extractNowOrder(page, id, outer, async () => {}, trace);

  const a11yPair =
    '<span class="currency">₹</span><span class="number">11.00</span>';
  const firstA11yPrice = (replacement: string): string =>
    a11yPrices.replace(
      /<div id="a11y-price-1"[^>]*>[\s\S]*?<\/div>/,
      replacement,
    );

  test("tablet pack fixture exports eight exact products, adjustments and independent billed total atomically", async () => {
    html = tabletOrder;
    const detail = await extract();
    expect(detail.items.map((item) => item.productName)).toEqual(
      Array.from(
        { length: 8 },
        (_, i) =>
          `Invented tablet-fixture item ${String(i + 1).padStart(2, "0")}`,
      ),
    );
    expect(detail.items.map((item) => item.quantity)).toEqual(Array(8).fill(1));
    expect(detail.items.map((item) => item.unitPrice.amount)).toEqual(
      Array.from({ length: 8 }, (_, i) => i + 14),
    );
    expect(detail.items.map((item) => item.itemTotal.amount)).toEqual(
      Array.from({ length: 8 }, (_, i) => i + 14),
    );
    expect(detail.items.map((item) => item.asin)).toEqual(
      Array.from({ length: 8 }, (_, i) =>
        i === 3 ? "" : `B0PACK${String(i + 1).padStart(4, "0")}`,
      ),
    );
    expect(detail.adjustments.map((item) => item.amount?.amount)).toEqual([
      4, -3,
    ]);
    expect(detail).toMatchObject({
      itemCount: 8,
      orderTotal: { amount: 141 },
      orderTotalSource: "amazon-now-you-pay",
      extractionSource: "amazon-now-order-details",
    });
    jest.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context);
    const directory = await mkdtemp(join(tmpdir(), "now-tablet-complete-"));
    const output = join(directory, "orders.json");
    try {
      await runExport({ ...options, output }, () => {}, {
        list: listOrders,
        extract: extractOrderItems,
        write: validateAndWriteExport,
        report: async () => {},
        cleanup: async () => {},
      });
      const document = JSON.parse(await readFile(output, "utf8"));
      expect(
        document.orders[0].items.map(
          (item: { lineIndex: number }) => item.lineIndex,
        ),
      ).toEqual(Array.from({ length: 8 }, (_, i) => i));
      expect(
        document.orders[0].items.map(
          (item: { productName: string }) => item.productName,
        ),
      ).toEqual(detail.items.map((item) => item.productName));
      expect(document.orders[0].orderTotal).toBe(141);
      expect(await readdir(directory)).toEqual(["orders.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each([
    "Pack of 3, 84 Tablets",
    "Pack of 9007199254740991, 9007199254740991 Tablets",
  ])(
    "tablet pack counts never supply purchased units: %s",
    async (descriptor) => {
      html = tabletOrder.replace(tabletDescriptor, descriptor);
      expect((await extract()).items[7]).toMatchObject({
        quantity: 1,
        unitPrice: { amount: 21 },
        itemTotal: { amount: 21 },
      });
    },
  );

  test.each(["punctuated name", "Pack of name", "two purchased units"])(
    "tablet pack preserves %s",
    async (mode) => {
      html = tabletOrder;
      const name =
        mode === "Pack of name"
          ? "Pack of imaginary sunshine"
          : "Invented. tablet . item 08";
      if (mode !== "two purchased units")
        html = html.replace("Invented tablet-fixture item 08", name);
      else
        html = html
          .replace(tabletFields, tabletFields.replace("1 unit", "2 units"))
          .replace(
            /<div id="pack-price-8"[^>]*>[\s\S]*?<\/div>/,
            '<div aria-hidden="true"><div>Unit price: <span>₹</span><span>10.50</span></div><div>Line total: <span>₹</span><span>21.00</span></div></div>',
          );
      const detail = await extract();
      expect(detail.items).toHaveLength(8);
      expect(detail.items[7].quantity).toBe(
        mode === "two purchased units" ? 2 : 1,
      );
      if (mode !== "two purchased units")
        expect(detail.items[7].productName).toBe(name);
      else
        expect(detail.items[7]).toMatchObject({
          unitPrice: { amount: 10.5 },
          itemTotal: { amount: 21 },
        });
    },
  );

  test.each(tabletCases)(
    "tablet pack invalid %s preserves prior JSON",
    async (_name, fixture) => {
      expect(fixture).not.toBe(tabletOrder);
      html = fixture;
      jest
        .spyOn(chromium, "launchPersistentContext")
        .mockResolvedValue(context);
      const directory = await mkdtemp(join(tmpdir(), "now-tablet-atomic-"));
      const output = join(directory, "orders.json");
      await writeFile(output, "prior complete export");
      const logs: string[] = [];
      try {
        await expect(
          runExport(
            { ...options, output },
            (message) => {
              logs.push(message);
            },
            {
              list: listOrders,
              extract: extractOrderItems,
              write: validateAndWriteExport,
              report: async () => {},
              cleanup: async () => {},
            },
          ),
        ).rejects.toMatchObject({ category: "validation" });
        expect(await readFile(output, "utf8")).toBe("prior complete export");
        expect(await readdir(directory)).toEqual(["orders.json"]);
        expect(logs.join(" ")).not.toMatch(
          /111-|Invented tablet|B0PACK|Pack of|₹|141\.00|amazon\.in/,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    15000,
  );

  test("split package fields preserve the exact 23-item details and all product evidence", async () => {
    expect(
      splitPackagePrices.match(/class="package-size"/g) ?? [],
    ).toHaveLength(22);
    expect(
      splitPackagePrices.match(/class="package-separator"/g) ?? [],
    ).toHaveLength(22);
    html = a11yPrices;
    const previous = await extract();
    html = splitPackagePrices;
    const detail = await extract();
    expect(detail).toEqual(previous);
    expect(detail.items.map((item) => item.productName)).toEqual(
      Array.from(
        { length: 23 },
        (_, i) => `Synthetic access item ${String(i + 1).padStart(2, "0")}`,
      ),
    );
    expect(detail.items.map((item) => item.quantity)).toEqual(
      Array(23).fill(1),
    );
    expect(detail.items.map((item) => item.itemTotal.amount)).toEqual(
      Array.from({ length: 23 }, (_, i) => i + 11),
    );
    expect(detail.orderTotalSource).toBe("amazon-now-you-pay");
    expect(
      detail.adjustments.map((adjustment) => adjustment.amount?.amount),
    ).toEqual([5, -5]);
  });

  test.each(["125 mg", "0.5 kg", "50 ml", "1.25 litres", "2 liters"])(
    "split package metadata uses only the final purchased count: %s",
    async (size) => {
      html = splitPackagePrices.replace(
        'class="package-size">400 g',
        `class="package-size">${size}`,
      );
      expect((await extract()).items[0].quantity).toBe(1);
    },
  );

  test.each([
    "nested group",
    "text period",
    "punctuated name",
    "two units",
    "Qty: 1",
    "Quantity: 1",
  ])(
    "split package normalization supports %s without inventing facts",
    async (mode) => {
      html = splitPackagePrices;
      if (mode === "nested group")
        html = html.replace(splitPackage, `<div>${splitPackage}</div>`);
      if (mode === "text period")
        html = html.replace('<span class="package-separator">.</span>', " . ");
      if (mode === "punctuated name")
        html = html.replace(
          "Synthetic access item 01",
          "Synthetic. item . 400 g",
        );
      if (mode === "Qty: 1" || mode === "Quantity: 1")
        html = html.replace(
          '<div class="quantity">1 unit</div>',
          `<div class="quantity">${mode}</div>`,
        );
      if (mode === "two units")
        html = html
          .replace(
            '<div class="quantity">1 unit</div>',
            '<div class="quantity">2 units</div>',
          )
          .replace(
            /<div id="a11y-price-1"[^>]*>[\s\S]*?<\/div>/,
            '<div aria-hidden="true"><div>Unit price: <span>₹</span><span>5.50</span></div><div>Line total: <span>₹</span><span>11.00</span></div></div>',
          );
      const detail = await extract();
      expect(detail.items).toHaveLength(23);
      expect(detail.items[0].quantity).toBe(mode === "two units" ? 2 : 1);
      expect(detail.items[0].unitPrice.amount).toBe(
        mode === "two units" ? 5.5 : 11,
      );
      expect(detail.items[0].itemTotal.amount).toBe(11);
      if (mode === "punctuated name")
        expect(detail.items[0].productName).toBe("Synthetic. item . 400 g");
    },
  );

  test.each([1, 2])(
    "split package fixture retains the one-paise boundary: %s",
    async (paise) => {
      html = splitPackagePrices.replace(
        "You pay ₹506.00",
        `You pay ₹506.0${paise}`,
      );
      if (paise === 1) expect((await extract()).orderTotal.amount).toBe(506.01);
      else
        await expect(extract()).rejects.toMatchObject({
          reason: "TOTAL_MISMATCH",
        });
    },
  );

  test.each(splitPackageCases)(
    "split package invalid %s preserves prior JSON",
    async (_name, fixture) => {
      expect(fixture).not.toBe(splitPackagePrices);
      html = fixture;
      jest
        .spyOn(chromium, "launchPersistentContext")
        .mockResolvedValue(context);
      const directory = await mkdtemp(join(tmpdir(), "now-split-atomic-"));
      const output = join(directory, "orders.json");
      await writeFile(output, "prior complete export");
      const logs: string[] = [];
      try {
        await expect(
          runExport(
            { ...options, output },
            (message) => {
              logs.push(message);
            },
            {
              list: listOrders,
              extract: extractOrderItems,
              write: validateAndWriteExport,
              report: async () => {},
              cleanup: async () => {},
            },
          ),
        ).rejects.toThrow();
        expect(await readFile(output, "utf8")).toBe("prior complete export");
        expect(await readdir(directory)).toEqual(["orders.json"]);
        expect(logs.join(" ")).not.toMatch(
          /111-|Synthetic access|B0A11Y|₹|506\.00|amazon\.in|400 g/,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    15000,
  );

  test.each(["control only", "duration only", "both"])(
    "bounded non-merchandise images retain identical complete details: %s",
    async (mode) => {
      expect(chromeControl).not.toBe("");
      expect(durationDecoration).not.toBe("");
      html = a11yPrices
        .replace(chromeControl, "")
        .replace(durationDecoration, "");
      const baseline = await extract();
      html = a11yPrices;
      if (mode === "control only") html = html.replace(durationDecoration, "");
      if (mode === "duration only") html = html.replace(chromeControl, "");
      expect(await extract()).toEqual(baseline);
    },
  );

  test.each(["Arrived at 12:00 AM", "arrived at 01:59 pm"])(
    "bounded arrival leaf accepts only a complete clock time: %s",
    async (arrival) => {
      html = a11yPrices.replace("Arrived at 4:26 PM", arrival);
      expect((await extract()).items).toHaveLength(23);
    },
  );

  test("the existing duration-only icon rule retains its behavior", async () => {
    html = a11yPrices.replace("<div>Arrived at 4:26 PM</div>", "");
    expect((await extract()).items).toHaveLength(23);
  });

  test("an image in a complete merchandise button retains its merchandise owner", async () => {
    html = a11yPrices
      .replace('<img alt="B0A11Y0001"', '<button><div><img alt="B0A11Y0001"')
      .replace(
        "<h3>Synthetic access item 01",
        "</div></button><h3>Synthetic access item 01",
      );
    const detail = await extract();
    expect(detail.items).toHaveLength(23);
    expect(detail.items[0]).toMatchObject({
      asin: "B0A11Y0001",
      quantity: 1,
      itemTotal: { amount: 11 },
    });
  });

  test.each(nonItemImageCases)(
    "bounded non-merchandise exclusion rejects %s atomically",
    async (_label, fixture) => {
      expect(fixture).not.toBe(a11yPrices);
      html = fixture;
      jest
        .spyOn(chromium, "launchPersistentContext")
        .mockResolvedValue(context);
      const directory = await mkdtemp(join(tmpdir(), "now-icon-atomic-"));
      const output = join(directory, "orders.json");
      await writeFile(output, "prior complete export");
      const logs: string[] = [];
      try {
        await expect(
          runExport(
            { ...options, output },
            (message) => {
              logs.push(message);
            },
            {
              list: listOrders,
              extract: extractOrderItems,
              write: validateAndWriteExport,
              report: async () => {},
              cleanup: async () => {},
            },
          ),
        ).rejects.toThrow();
        expect(await readFile(output, "utf8")).toBe("prior complete export");
        expect(await readdir(directory)).toEqual(["orders.json"]);
        expect(logs.join(" ")).not.toMatch(
          /111-|Synthetic access|B0A11Y|₹|506\.00|amazon\.in|Arrived at|Delivered in/,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    15000,
  );

  test("accessibility-hidden visual prices keep all 23 independent products and the billed total", async () => {
    html = a11yPrices;
    const detail = await extract();
    expect(detail.items.map((item) => item.productName)).toEqual(
      Array.from(
        { length: 23 },
        (_, i) => `Synthetic access item ${String(i + 1).padStart(2, "0")}`,
      ),
    );
    expect(detail.items.map((item) => item.quantity)).toEqual(
      Array(23).fill(1),
    );
    expect(detail.items.map((item) => item.itemTotal.amount)).toEqual(
      Array.from({ length: 23 }, (_, i) => i + 11),
    );
    expect(detail).toMatchObject({
      itemCount: 23,
      orderTotal: { amount: 506 },
      orderTotalSource: "amazon-now-you-pay",
    });
    expect(
      detail.adjustments.map((adjustment) => adjustment.amount?.amount),
    ).toEqual([5, -5]);
    const document = createExportDocument(
      options,
      1,
      [
        {
          summary: {
            orderId: id,
            orderDate: "2026-10-01",
            nowDetailUrl: outer,
          },
          detail,
        },
      ],
      new Date().toISOString(),
    );
    expect(document.orders[0].items.map((item) => item.lineIndex)).toEqual(
      Array.from({ length: 23 }, (_, i) => i),
    );
    expect(JSON.stringify(document)).not.toMatch(
      /999|777|Gift Card|Voucher|funding/,
    );
  });

  test.each([
    "Approx. (120-180 g) . 1 unit",
    "Approx. (120-180 g) · 1 unit",
    "Approx. (120-180 g) • 1 unit",
    "Approx.(120 - 180g).1 unit(s)",
    "Approx. (0.5-1.25 g) . 1 units",
    "Approx. (120.000000000000000000001-120.000000000000000000002 g) . 1 unit",
  ])("approximate row owns one purchased unit: %s", async (quantity) => {
    html = a11yPrices.replace(approximateQuantity, quantity);
    expect(html).toContain(quantity);
    const detail = await extract();
    expect(detail.items).toHaveLength(23);
    expect(detail.items[22]).toMatchObject({
      productName: "Synthetic access item 23",
      quantity: 1,
      itemTotal: { amount: 33 },
    });
    expect(detail).toMatchObject({
      orderTotal: { amount: 506 },
      orderTotalSource: "amazon-now-you-pay",
    });
  });

  test("split approximate-weight markup remains one complete quantity field", async () => {
    html = a11yPrices.replace(
      approximateQuantity,
      "<span>Approx.</span> ( <span>120</span> - <span>180</span> g ) . <span>1 unit</span>",
    );
    expect((await extract()).items[22].quantity).toBe(1);
  });

  test("approximate two-unit row uses its independent unit and line prices", async () => {
    html = a11yPrices
      .replace(approximateQuantity, "Approx. (120-180 g) . 2 units")
      .replace(
        /<div id="a11y-price-23"[^>]*>[\s\S]*?<\/div>/,
        '<div aria-hidden="true"><div>Unit price: <span>₹</span><span>16.50</span></div><div>Line total: <span>₹</span><span>33.00</span></div></div>',
      );
    expect((await extract()).items[22]).toMatchObject({
      quantity: 2,
      unitPrice: { amount: 16.5 },
      itemTotal: { amount: 33 },
    });
  });

  test("approximate-weight fixture publishes all 23 rows through the atomic JSON pipeline", async () => {
    html = splitPackagePrices;
    jest.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context);
    const directory = await mkdtemp(join(tmpdir(), "now-approx-complete-"));
    const output = join(directory, "orders.json");
    const report = jest.fn(async () => {});
    try {
      await runExport({ ...options, output }, () => {}, {
        list: listOrders,
        extract: extractOrderItems,
        write: validateAndWriteExport,
        report,
        cleanup: async () => {},
      });
      const document = JSON.parse(await readFile(output, "utf8"));
      expect(document.orders).toHaveLength(1);
      expect(document.orders[0].items).toHaveLength(23);
      expect(
        document.orders[0].items.map(
          (item: { lineIndex: number }) => item.lineIndex,
        ),
      ).toEqual(Array.from({ length: 23 }, (_, i) => i));
      expect(
        document.orders[0].items.map(
          (item: { quantity: number }) => item.quantity,
        ),
      ).toEqual(Array(23).fill(1));
      expect(
        document.orders[0].items.map(
          (item: { itemTotal: number }) => item.itemTotal,
        ),
      ).toEqual(Array.from({ length: 23 }, (_, i) => i + 11));
      expect(document.orders[0].orderTotal).toBe(506);
      expect(
        document.orders[0].adjustments.map(
          (adjustment: { amount: number }) => adjustment.amount,
        ),
      ).toEqual([5, -5]);
      expect(report).not.toHaveBeenCalled();
      expect(await readdir(directory)).toEqual(["orders.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each([
    "Approx (120-180 g) . 1 unit",
    "Approximate. (120-180 g) . 1 unit",
    "Estimated. (120-180 g) . 1 unit",
    "approx. (120-180 g) . 1 unit",
    "Approx. (180-120 g) . 1 unit",
    "Approx. (120-120 g) . 1 unit",
    "Approx. (120-120.0 g) . 1 unit",
    "Approx. (120.000000000000000000002-120.000000000000000000001 g) . 1 unit",
    "Approx. (0-180 g) . 1 unit",
    "Approx. (-120-180 g) . 1 unit",
    "Approx. (120-180 kg) . 1 unit",
    "Approx. (120–180 g) . 1 unit",
    "Approx. (120-180 g) 1 unit",
    "Approx. (120-180 g) .. 1 unit",
    "Approx. (120-180 g) .· 1 unit",
    "Approx. (120-180 g) | 1 unit",
    "Approx. (120-180 g) ∙ 1 unit",
    "Approx. (120-180 g) ‧ 1 unit",
    "Approx. (120-180 g) / 1 unit",
    "Approx. (120-180 g) . unit",
    "Approx. (120-180 g) . 0 units",
    "Approx. (120-180 g) . 1.5 units",
    "Approx. (120-180 g) . 9007199254740992 units",
    "Approx. (120-180 g) . 1 unit 2 units",
    "Approx. (120-180 g) . 2 units",
    "duplicate",
    "conflicting",
    "missingQuantity",
    "hiddenQuantity",
    "missingPrice",
    "mismatchedUnitPrice",
  ])(
    "approximate invalid row %s preserves prior JSON",
    async (mode) => {
      html = a11yPrices.replace(approximateQuantity, mode);
      if (mode === "duplicate" || mode === "conflicting")
        html = a11yPrices.replace(
          `<div class="quantity">${approximateQuantity}</div>`,
          `<div class="quantity">${approximateQuantity}</div><div>Qty: ${mode === "duplicate" ? 1 : 2}</div>`,
        );
      if (mode === "missingQuantity")
        html = a11yPrices
          .replace(approximateQuantity, "")
          .replace("You pay ₹506.00", "You pay ₹473.00");
      if (mode === "hiddenQuantity")
        html = a11yPrices
          .replace(
            `<div class="quantity">${approximateQuantity}</div>`,
            `<div class="quantity" hidden>${approximateQuantity}</div>`,
          )
          .replace("You pay ₹506.00", "You pay ₹473.00");
      if (mode === "missingPrice")
        html = a11yPrices
          .replace(/<div id="a11y-price-23"[^>]*>[\s\S]*?<\/div>/, "")
          .replace("You pay ₹506.00", "You pay ₹473.00");
      if (mode === "mismatchedUnitPrice")
        html = a11yPrices
          .replace(approximateQuantity, "Approx. (120-180 g) . 2 units")
          .replace(
            /<div id="a11y-price-23"[^>]*>[\s\S]*?<\/div>/,
            '<div aria-hidden="true"><div>Unit price: <span>₹</span><span>17.00</span></div><div>Line total: <span>₹</span><span>33.00</span></div></div>',
          );
      jest
        .spyOn(chromium, "launchPersistentContext")
        .mockResolvedValue(context);
      const directory = await mkdtemp(join(tmpdir(), "now-approx-atomic-"));
      const output = join(directory, "orders.json");
      const logs: string[] = [];
      await writeFile(output, "prior complete export");
      try {
        await expect(
          runExport(
            { ...options, output },
            (message) => {
              logs.push(message);
            },
            {
              list: listOrders,
              extract: extractOrderItems,
              write: validateAndWriteExport,
              report: async () => {},
              cleanup: async () => {},
            },
          ),
        ).rejects.toThrow();
        expect(await readFile(output, "utf8")).toBe("prior complete export");
        expect(await readdir(directory)).toEqual(["orders.json"]);
        expect(logs.join(" ")).not.toMatch(
          /111-|Synthetic access|Approx\.|120-180|₹|amazon\.in/,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    15000,
  );

  test.each([
    "250 g · 1 unit",
    "2 kg • 1 unit",
    "75 ml | 1 unit",
    "0.5 l · 1 unit",
    "Qty: 1",
    "Quantity: 1",
    "1 unit(s)",
  ])(
    "a11y row uses the complete purchased-unit grammar: %s",
    async (quantity) => {
      html = a11yPrices.replace("250 g · 1 unit", quantity);
      expect((await extract()).items[0].quantity).toBe(1);
    },
  );

  test("multiple purchased units require independently labeled hidden unit and line prices", async () => {
    html = firstA11yPrice(
      `<div aria-hidden="true"><div>Unit price: <span>₹</span><span>5.50</span></div><div>Line total: ${a11yPair}</div></div>`,
    ).replace("250 g · 1 unit", "250 g · 2 units");
    expect((await extract()).items[0]).toMatchObject({
      quantity: 2,
      unitPrice: { amount: 5.5 },
      itemTotal: { amount: 11 },
    });
  });

  test("an accessibility-hidden INR token remains an explicit currency declaration", async () => {
    html = firstA11yPrice(
      `<div aria-hidden="true">${a11yPair.replace(">₹<", ">INR<")}</div>`,
    );
    expect((await extract()).items[0].itemTotal.amount).toBe(11);
  });

  test.each(["currency", "number", "ancestor"])(
    "only merchandise price components may bypass accessibility hiding: %s",
    async (mode) => {
      const pair =
        mode === "ancestor"
          ? `<div aria-hidden="true"><div>${a11yPair}</div></div>`
          : `<div>${a11yPair.replace(`class="${mode}"`, `class="${mode}" aria-hidden="true"`)}</div>`;
      html = firstA11yPrice(pair);
      expect((await extract()).items[0].itemTotal.amount).toBe(11);
    },
  );

  test.each([1, 2])(
    "a11y prices retain the one-paise boundary: %s",
    async (paise) => {
      html = a11yPrices.replace("You pay ₹506.00", `You pay ₹506.0${paise}`);
      if (paise === 1) expect((await extract()).orderTotal.amount).toBe(506.01);
      else
        await expect(extract()).rejects.toMatchObject({
          reason: "TOTAL_MISMATCH",
        });
    },
  );

  test.each([
    "duplicate",
    "conflict",
    "separateDuplicate",
    "missing",
    "historyOnly",
    "computedHistory",
    "hidden",
    "displayNone",
    "visibilityHidden",
    "transparent",
    "hiddenNumber",
    "badDecimals",
    "interveningText",
    "interveningElement",
    "differentRows",
    "unowned",
    "unsupportedWholeAmount",
    "outsideSemanticRow",
    "duplicateQuantity",
    "missingQuantity",
    "hiddenQuantity",
    "hiddenName",
    "hiddenImage",
    "hiddenBillTotal",
    "hiddenTracking",
    "hiddenDialogID",
    "estimatedQualifier",
    "unusualRange",
    "bareRange",
    "unknownSeparator",
    "wildcardPrefix",
    "zeroPackage",
    "missingCount",
    "multipleUnitsWithoutLabels",
    "mismatch",
    "hiddenAncestorQualifier",
    "hiddenExtraNumber",
    "overlap",
  ])(
    "a11y %s fails closed and preserves prior JSON",
    async (mode) => {
      html = a11yPrices;
      if (mode === "duplicate")
        html = firstA11yPrice(
          `<div aria-hidden="true">${a11yPair}${a11yPair}</div>`,
        );
      if (mode === "conflict")
        html = firstA11yPrice(
          `<div aria-hidden="true">${a11yPair}${a11yPair.replace("11.00", "12.00")}</div>`,
        );
      if (mode === "separateDuplicate")
        html = firstA11yPrice(
          `<div><div aria-hidden="true">${a11yPair}</div><div aria-hidden="true">${a11yPair}</div></div>`,
        );
      if (mode === "missing") html = firstA11yPrice("");
      if (mode === "historyOnly")
        html = firstA11yPrice(
          `<div aria-hidden="true"><s>${a11yPair}</s></div>`,
        );
      if (mode === "computedHistory")
        html = firstA11yPrice(
          `<div aria-hidden="true" style="text-decoration:line-through">${a11yPair}</div>`,
        );
      if (mode === "hidden")
        html = firstA11yPrice(
          `<div aria-hidden="true" hidden>${a11yPair}</div>`,
        );
      if (mode === "displayNone")
        html = firstA11yPrice(
          `<div aria-hidden="true" style="display:none">${a11yPair}</div>`,
        );
      if (mode === "visibilityHidden")
        html = firstA11yPrice(
          `<div aria-hidden="true" style="visibility:hidden">${a11yPair}</div>`,
        );
      if (mode === "transparent")
        html = firstA11yPrice(
          `<div aria-hidden="true" style="opacity:0">${a11yPair}</div>`,
        );
      if (mode === "hiddenNumber")
        html = firstA11yPrice(
          `<div aria-hidden="true">${a11yPair.replace('class="number"', 'class="number" hidden')}</div>`,
        );
      if (mode === "badDecimals")
        html = firstA11yPrice(
          `<div aria-hidden="true">${a11yPair.replace("11.00", "11.001")}</div>`,
        );
      if (mode === "interveningText")
        html = firstA11yPrice(
          `<div aria-hidden="true">${a11yPair.replace("</span><span", "</span>unrelated<span")}</div>`,
        );
      if (mode === "interveningElement")
        html = firstA11yPrice(
          `<div aria-hidden="true">${a11yPair.replace("</span><span", "</span><small>note</small><span")}</div>`,
        );
      if (mode === "differentRows")
        html = firstA11yPrice(
          '<div aria-hidden="true"><span>₹</span></div>',
        ).replace(
          /<div id="a11y-price-2"[^>]*>[\s\S]*?<\/div>/,
          '<div aria-hidden="true"><span>11.00</span></div>',
        );
      if (mode === "unowned")
        html = a11yPrices.replace(
          '<section id="a11y-bill">',
          `<div aria-hidden="true">${a11yPair}</div><section id="a11y-bill">`,
        );
      if (mode === "unsupportedWholeAmount")
        html = a11yPrices.replace(
          '<section id="a11y-bill">',
          '<div aria-hidden="true">₹1.00</div><section id="a11y-bill">',
        );
      if (mode === "outsideSemanticRow") {
        html = firstA11yPrice("")
          .replace(
            /<article role="listitem" id="a11y-row-(?:[2-9]|1\d|2[0-3])">[\s\S]*?<\/article>/g,
            "",
          )
          .replace(
            "</article>",
            `</article><div aria-hidden="true">${a11yPair}</div>`,
          )
          .replace(/₹506.00/g, "₹11.00");
      }
      if (mode === "duplicateQuantity")
        html = html.replace(
          "250 g · 1 unit",
          "250 g · 1 unit<div>Qty: 2</div>",
        );
      if (mode === "missingQuantity") html = html.replace("250 g · 1 unit", "");
      if (mode === "hiddenQuantity")
        html = html.replace(
          '<div class="quantity">',
          '<div class="quantity" aria-hidden="true">',
        );
      if (mode === "hiddenName")
        html = html.replace("<h3>", '<h3 aria-hidden="true">');
      if (mode === "hiddenImage")
        html = html.replace(
          '<img alt="B0A11Y0001"',
          '<img aria-hidden="true" alt="B0A11Y0001"',
        );
      if (mode === "hiddenBillTotal")
        html = html.replace(
          'id="a11y-total"',
          'id="a11y-total" aria-hidden="true"',
        );
      if (mode === "hiddenTracking")
        html = html.replace("<main><div>", '<main><div aria-hidden="true">');
      if (mode === "hiddenDialogID")
        html = html.replace(
          'id="a11y-owner"',
          'id="a11y-owner" aria-hidden="true"',
        );
      if (mode === "estimatedQualifier")
        html = firstA11yPrice(
          `<div aria-hidden="true">Estimated ${a11yPair}</div>`,
        );
      if (mode === "unusualRange")
        html = html.replace(
          "250 g · 1 unit",
          "Bundle · (100 - 200 g) · 1 unit",
        );
      if (mode === "bareRange")
        html = html.replace("250 g · 1 unit", "(100-200 g) · 1 unit");
      if (mode === "unknownSeparator")
        html = html.replace("250 g · 1 unit", "250 g / 1 unit");
      if (mode === "wildcardPrefix")
        html = html.replace("250 g · 1 unit", "Unverified descriptor · 1 unit");
      if (mode === "zeroPackage")
        html = html.replace("250 g · 1 unit", "0 g · 1 unit");
      if (mode === "missingCount")
        html = html.replace("250 g · 1 unit", "250 g · unit");
      if (mode === "multipleUnitsWithoutLabels")
        html = html.replace("250 g · 1 unit", "250 g · 2 units");
      if (mode === "mismatch")
        html = html.replace("You pay ₹506.00", "You pay ₹506.02");
      if (mode === "hiddenAncestorQualifier")
        html = firstA11yPrice(
          `<div aria-hidden="true">Estimated<div>${a11yPair}</div></div>`,
        );
      if (mode === "hiddenExtraNumber")
        html = firstA11yPrice(
          `<div aria-hidden="true">${a11yPair}<span>12.00</span></div>`,
        );
      if (mode === "overlap") {
        const row =
          /<article role="listitem" id="a11y-row-1">[\s\S]*?<\/article>/.exec(
            html,
          )?.[0] ?? "";
        expect(row).not.toBe("");
        html = html
          .replace(row, "")
          .replace(
            '<article role="listitem" id="a11y-row-2">',
            `<article role="listitem" id="a11y-row-2">${row}`,
          );
      }
      jest
        .spyOn(chromium, "launchPersistentContext")
        .mockResolvedValue(context);
      const directory = await mkdtemp(join(tmpdir(), "now-a11y-atomic-"));
      const output = join(directory, "orders.json");
      await writeFile(output, "prior complete export");
      const logs: string[] = [];
      try {
        await expect(
          runExport(
            { ...options, output },
            (message) => {
              logs.push(message);
            },
            {
              list: listOrders,
              extract: extractOrderItems,
              write: validateAndWriteExport,
              report: async () => {},
              cleanup: async () => {},
            },
          ),
        ).rejects.toThrow();
        expect(await readFile(output, "utf8")).toBe("prior complete export");
        expect(await readdir(directory)).toEqual(["orders.json"]);
        expect(logs.join(" ")).not.toMatch(
          /111-|Synthetic access|B0A11Y|₹|506\.00|amazon\.in/,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    15000,
  );

  test("ownership fixtures cover every allowlisted subreason", () => {
    expect(ownershipImage).not.toBe("");
    expect(ownershipRow).not.toBe("");
    expect(new Set(ownershipCases.map(([, reason]) => reason))).toEqual(
      new Set(NOW_OWNERSHIP_FAILURES),
    );
  });

  test("invented ownership fixture remains fully extractable", async () => {
    html = ownership;
    const detail = await extract();
    expect(detail).toMatchObject({
      itemCount: 1,
      orderTotal: { amount: 10 },
      adjustments: [],
    });
    expect(detail.items[0]).toMatchObject({
      productName: "Invented ownership item",
      quantity: 1,
      itemTotal: { amount: 10 },
    });
  });

  test.each(ownershipCases)(
    "ownership subreason: %s",
    async (_name, reason, fixture) => {
      html = fixture;
      const trace = new FailureDiagnostics();
      trace.select({ orderId: "not supplied", orderDate: "not supplied" }, 2);
      trace.provenance("amazon-now-order-details");
      const error = await extract(trace).catch((e: unknown) => e);
      expect(error).toMatchObject({
        stage: "detail",
        reason,
        category: "validation",
      });
      const report = trace.report(error);
      expect(report.events.slice(-3)).toMatchObject([
        { reason: "NOW_BILL_SUMMARY", orderIndex: 2 },
        { reason: "NOW_ITEMS_FEES", orderIndex: 2 },
        { reason, orderIndex: 2, category: "validation" },
      ]);
      expect(report.counts).toMatchObject({ items: 0, adjustments: 0 });
      expect(report.items).toEqual([]);
      expect(report.adjustments).toEqual([]);
      expect(report.orderTotalSource).toBeUndefined();
      const directory = await mkdtemp(join(tmpdir(), "now-ownership-report-"));
      try {
        await writeFailureReport(report, directory);
        const names = await readdir(directory);
        expect(names).toHaveLength(1);
        const saved = await readFile(join(directory, names[0]), "utf8");
        expect(JSON.parse(saved).failure).toEqual({
          stage: "detail",
          reason,
          category: "validation",
        });
        expect(saved + String(error)).not.toMatch(
          /111-|Invented|B0FAKE|₹|10\.00|https?:|<html>|Quantity unavailable|Qty:/,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test("ownership failure preserves prior JSON and persists only its categorical additions", async () => {
    html = ownership.replace("<!-- decoration -->", "<div>₹1.00</div>");
    jest.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context);
    const directory = await mkdtemp(join(tmpdir(), "now-ownership-atomic-"));
    const output = join(directory, "orders.json");
    const reports = join(directory, "reports");
    const logs: string[] = [];
    await writeFile(output, "prior complete export");
    try {
      await expect(
        runExport(
          { ...options, output },
          (message) => {
            logs.push(message);
          },
          {
            list: listOrders,
            extract: extractOrderItems,
            write: validateAndWriteExport,
            report: (report) => writeFailureReport(report, reports),
            cleanup: async () => {},
          },
        ),
      ).rejects.toMatchObject({ reason: "NOW_ITEM_PRICE_OWNER_INVALID" });
      expect(await readFile(output, "utf8")).toBe("prior complete export");
      expect((await readdir(directory)).sort()).toEqual([
        "orders.json",
        "reports",
      ]);
      const names = await readdir(reports);
      expect(names).toHaveLength(1);
      const report = JSON.parse(
        await readFile(join(reports, names[0]), "utf8"),
      );
      expect(report.events.at(-1)).toMatchObject({
        reason: "NOW_ITEM_PRICE_OWNER_INVALID",
        orderIndex: 0,
      });
      expect(report.counts).toMatchObject({ items: 0, adjustments: 0 });
      expect(JSON.stringify(report.events) + logs.join(" ")).not.toMatch(
        /111-|Invented|₹|https?:|B0FAKE|10\.00|230\.00/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each(["tracking", "dialog"])(
    "exact %s identity rejection remains attributable without exposing IDs",
    async (mode) => {
      html =
        mode === "tracking"
          ? html.replace(`ORDER ID:${id}`, "ORDER ID:111-2222222-4444444")
          : html.replace(
              `<span>${id}</span>`,
              "<span>111-2222222-4444444</span>",
            );
      const trace = new FailureDiagnostics();
      const error = await extract(trace).catch((e: unknown) => e);
      expect(error).toMatchObject({ reason: "DETAIL_ORDER_MISMATCH" });
      const events = trace.report(error).events;
      expect(
        events.some(
          (event) =>
            event.reason ===
            (mode === "tracking"
              ? "NOW_TRACKING_IDENTITY"
              : "NOW_DIALOG_IDENTITY"),
        ),
      ).toBe(true);
      expect(JSON.stringify(events)).not.toMatch(/111-|https?:|₹/);
      if (mode === "tracking") {
        expect(events.some((event) => event.reason === "NOW_DIALOG_OPEN")).toBe(
          false,
        );
        expect(await page.locator("#now-sheet").isVisible()).toBe(false);
      }
    },
  );

  test("unexpected in-page exceptions are discarded with the last internal checkpoint", async () => {
    html += `<script>
      const image = document.querySelector('#fixture-items img');
      const get = image.getAttribute.bind(image);
      image.getAttribute = (name) => {
        if (name === 'alt') throw new Error('PRIVATE_DOM_EXCEPTION cookie=secret ₹999.99');
        return get(name);
      };
    </script>`;
    const trace = new FailureDiagnostics();
    const error = await extract(trace).catch((e: unknown) => e);
    expect(trace.report(error).failure).toMatchObject({
      reason: "NOW_ITEMS_FEES",
      category: "operation-failed",
    });
    expect(JSON.stringify(trace.report(error)) + String(error)).not.toMatch(
      /PRIVATE_DOM_EXCEPTION|cookie|999\.99|₹|https?:/,
    );
  });

  test.each([
    ["bounds", "NOW_DOM_BOUNDS_INVALID"],
    ["trackingIdentity", "NOW_TRACKING_IDENTITY_INVALID"],
    ["dialogIdentity", "NOW_DIALOG_IDENTITY_INVALID"],
    ["status", "NOW_ORDER_STATUS_UNSUPPORTED"],
    ["billSummary", "NOW_BILL_SUMMARY_INVALID"],
    ["billRow", "NOW_BILL_ROW_INVALID"],
    ["ownership", "NOW_ITEM_IMAGE_OWNER_INVALID"],
    ["fields", "NOW_ITEM_FIELDS_INVALID"],
  ])(
    "categorical DOM failure %s persists without page content",
    async (mode, reason) => {
      if (mode === "bounds")
        html = html.replace("<h1>", `${"<i></i>".repeat(5001)}<h1>`);
      if (mode === "trackingIdentity")
        html = html.replace(`ORDER ID:${id}`, "Tracking information");
      if (mode === "dialogIdentity")
        html = html.replace(
          "<h1>Order Details</h1>",
          `<h1>Order Details</h1><div>Order ID: ${id}</div>`,
        );
      if (mode === "status")
        html = html.replace(
          "<h1>Order Details</h1>",
          "<h1>Order Details</h1><div>Refund pending</div>",
        );
      if (mode === "billSummary")
        html = html.replace("<h2>Bill summary</h2>", "<h2>Other summary</h2>");
      if (mode === "billRow")
        html = html.replace(
          "<h2>Bill summary</h2>",
          "<h2>Bill summary</h2><div>Unknown charged fact ₹9.00</div>",
        );
      if (mode === "ownership") html = html.replace("<div>Qty: 1</div>", "");
      if (mode === "fields")
        html = html.replace(
          "<span>₹10.00</span>",
          "<span>₹</span><span>invalid amount</span>",
        );
      const trace = new FailureDiagnostics();
      trace.select({ orderId: "not supplied", orderDate: "not supplied" }, 2);
      trace.provenance("amazon-now-order-details");
      const error = await extract(trace).catch((e: unknown) => e);
      expect(error).toMatchObject({ reason, category: "validation" });
      const report = trace.report(error);
      expect(report).toMatchObject({
        failure: { reason },
        order: { orderIndex: 2 },
        counts: { items: 0, adjustments: 0 },
      });
      expect(report.events.at(-1)).toMatchObject({
        reason,
        orderIndex: 2,
        category: "validation",
      });
      const directory = await mkdtemp(join(tmpdir(), "now-dom-report-"));
      try {
        await writeFailureReport(report, directory);
        const names = await readdir(directory);
        expect(names).toHaveLength(1);
        const saved = await readFile(join(directory, names[0]), "utf8");
        expect(JSON.parse(saved).failure.reason).toBe(reason);
        expect(saved + String(error)).not.toMatch(
          /111-|Invented|₹|230\.00|https?:|<html>|invalid amount|Unknown charged fact/,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
      if (mode === "trackingIdentity")
        expect(await page.locator("#now-sheet").isVisible()).toBe(false);
    },
  );

  test.each([
    "navigation",
    "control",
    "open",
    "parser",
    "fees",
    "reconciliation",
  ])(
    "checkpoint identifies %s failure without changing rejection",
    async (mode) => {
      if (mode === "navigation")
        redirect = tracking.replace(id, "111-2222222-4444444");
      if (mode === "control")
        html = html.replace(
          "View order details</button>",
          "View order details</button><button>View order details</button>",
        );
      if (mode === "open")
        html = html.replace(
          "document.querySelector('#now-sheet').style.display='block'",
          "void 0",
        );
      if (mode === "parser") html = html.replace("Qty: 1", "Qty: 0");
      if (mode === "fees")
        html = html.replace(
          "Handling fee <span>Free</span>",
          "Handling fee <span>Included ₹5.00</span>",
        );
      if (mode === "reconciliation")
        html = html.replace(
          "<span>₹230.00</span><s>₹460.00</s>",
          "<span>₹230.02</span><s>₹460.00</s>",
        );
      const trace = new FailureDiagnostics();
      const error = await extract(trace).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      const report = trace.report(error);
      const expected =
        mode === "navigation"
          ? "NOW_NAVIGATION"
          : mode === "control"
            ? "NOW_DETAILS_CONTROL"
            : mode === "open"
              ? "NOW_DIALOG_OPEN"
              : "NOW_PARSING";
      expect(report.events.some((event) => event.reason === expected)).toBe(
        true,
      );
      expect(report.failure.category).toBe(
        mode === "open" ? "timeout" : "validation",
      );
      if (mode === "reconciliation")
        expect(report.failure.reason).toBe("TOTAL_MISMATCH");
      expect(JSON.stringify(report)).not.toMatch(
        /111-|Invented|₹|230\.00|https?:|<html>/,
      );
    },
    10000,
  );

  test("integrated exporter persists the categorical checkpoint and preserves prior JSON", async () => {
    html = html.replace(
      "<h2>Bill summary</h2>",
      "<h2>Unsupported summary</h2>",
    );
    jest.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context);
    const directory = await mkdtemp(join(tmpdir(), "now-diagnostic-pipeline-"));
    const output = join(directory, "orders.json");
    const reports = join(directory, "reports");
    await writeFile(output, "prior complete export");
    const logs: string[] = [];
    try {
      await expect(
        runExport(
          { ...options, output },
          (message) => {
            logs.push(message);
          },
          {
            list: listOrders,
            extract: extractOrderItems,
            write: validateAndWriteExport,
            report: (report) => writeFailureReport(report, reports),
            cleanup: async () => {},
          },
        ),
      ).rejects.toMatchObject({ reason: "NOW_BILL_SUMMARY_INVALID" });
      expect(await readFile(output, "utf8")).toBe("prior complete export");
      expect((await readdir(directory)).sort()).toEqual([
        "orders.json",
        "reports",
      ]);
      const names = await readdir(reports);
      expect(names).toHaveLength(1);
      const saved = JSON.parse(await readFile(join(reports, names[0]), "utf8"));
      expect(saved.failure.reason).toBe("NOW_BILL_SUMMARY_INVALID");
      expect(saved.events.at(-1)).toMatchObject({
        reason: "NOW_BILL_SUMMARY_INVALID",
        orderIndex: 0,
      });
      expect(JSON.stringify(saved.events) + logs.join(" ")).not.toMatch(
        /111-|Invented|₹|230\.00|https?:|<html>/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("plain delivery decoration and explanatory waived fee export the complete invented order", async () => {
    html = statusFeePresentation;
    jest.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context);
    const [summary] = (await listOrders(options.startDate, options.endDate, 5))
      .orders;
    const detail = await extractOrderItems(id, undefined, summary);
    expect(
      await page.locator("#plain-delivery-message").getAttribute("role"),
    ).toBeNull();
    expect(
      await page.getByText("Delivery status", { exact: true }).count(),
    ).toBe(0);
    expect(detail.items).toHaveLength(23);
    expect(detail.items.map((item) => item.quantity)).toEqual(
      Array(23).fill(1),
    );
    expect(detail.items.map((item) => item.itemTotal?.amount)).toEqual(
      Array.from({ length: 23 }, (_, index) => index + 21),
    );
    expect(detail.items[0].asin).toBe("B0FAKE0001");
    expect(detail.items[3].asin).toBe("");
    expect(detail.orderTotal?.amount).toBe(736);
    expect(detail.orderTotalSource).toBe("amazon-now-you-pay");
    expect(detail.adjustments).toEqual([]);
    const document = createExportDocument(
      options,
      1,
      [{ summary, detail }],
      new Date().toISOString(),
    );
    expect(document.orders[0].items.map((item) => item.lineIndex)).toEqual(
      Array.from({ length: 23 }, (_, index) => index),
    );
    expect(JSON.stringify(document)).not.toMatch(
      /Free for|Delivery time icon|Voucher|Gift Cards|999/,
    );
  });

  test.each([
    "Delivered in 7 minutes",
    "Delivered in 42 mins",
    "Order delivered in 2 hours and 5 minutes",
    "Delivered in 1 hr",
    "delivered in 18 min",
  ])("isolated icon ownership supports %s", async (message) => {
    html = statusFeePresentation.replace("Delivered in 23 minutes", message);
    expect((await extract()).items).toHaveLength(23);
  });

  test.each([
    "unrecognized",
    "extraIcon",
    "productLink",
    "productAsin",
    "merchandiseBoundary",
    "financialEvidence",
    "otherHistoricalEvidence",
    "hiddenMessage",
    "conflictingOwner",
  ])("plain status cannot conceal %s", async (mode) => {
    let status = plainStatus;
    if (mode === "unrecognized")
      status = status.replace(
        "Delivered in 23 minutes",
        "Delivery information",
      );
    if (mode === "extraIcon") status = status.replace(/(<img[^>]+>)/, "$1$1");
    if (mode === "productLink")
      status = status.replace(
        "<span>Delivered",
        '<a href="/dp/B0FAKE0099"></a><span>Delivered',
      );
    if (mode === "productAsin")
      status = status.replace('alt="Delivery time icon"', 'alt="B0FAKE0099"');
    if (mode === "merchandiseBoundary")
      status = status.replace(
        'id="plain-delivery-message"',
        'id="plain-delivery-message" role="listitem"',
      );
    if (mode === "financialEvidence")
      status = status.replace("</div>", "<s>₹21.00</s></div>");
    if (mode === "otherHistoricalEvidence")
      status = status.replace("</div>", "<s>$21.00</s></div>");
    if (mode === "hiddenMessage")
      status = status.replace("<span>Delivered", "<span hidden>Delivered");
    if (mode === "conflictingOwner")
      status = status.replace(
        'id="plain-delivery-message"',
        'id="plain-delivery-message" data-order-id="111-2222222-4444444"',
      );
    html = statusFeePresentation.replace(plainStatus, status);
    await expect(extract()).rejects.toThrow();
  });

  test("a merchandise row resembling a status decoration is never omitted, even if omission would reconcile", async () => {
    html = statusFeePresentation
      .replace(
        /<article role="listitem" id="invented-row-1">[\s\S]*?<\/article>/,
        (row) =>
          row
            .replace('alt="B0FAKE0001"', 'alt="Delivery time icon"')
            .replace("Fictional market item 01", "Delivered in 31 minutes")
            .replace(/<div class="package">[\s\S]*?<\/div>/, "")
            .replace(/<del>[\s\S]*?<\/del>/, "")
            .replace(
              '<span class="effective-symbol">₹</span><span class="effective-number">21.00</span>',
              "",
            ),
      )
      .replace('id="effective-total">736.00', 'id="effective-total">715.00');
    await expect(extract()).rejects.toMatchObject({
      reason: "NOW_ITEM_IMAGE_OWNER_INVALID",
    });
  });

  test.each(["missingQuantity", "missingPrice", "unownedImage"])(
    "new decorations retain rejection of %s",
    async (mode) => {
      html = statusFeePresentation;
      if (mode === "missingQuantity")
        html = html.replace("500 g · <span>1 unit</span>", "500 g");
      if (mode === "missingPrice")
        html = html.replace(
          '<span class="effective-symbol">₹</span><span class="effective-number">21.00</span>',
          "",
        );
      if (mode === "unownedImage")
        html = html.replace(
          '<div role="list"',
          '<img alt="Unowned merchandise image" width="20" height="20" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="><div role="list"',
        );
      await expect(extract()).rejects.toThrow();
    },
  );

  test.each([
    "missingCharge",
    "hiddenCharge",
    "duplicateFree",
    "freeAndCharge",
    "unmarkedOriginal",
    "annotationAmount",
    "duplicateAnnotation",
    "missingIcon",
    "mergedCharge",
    "unknownAnnotation",
    "annotationOnTotal",
  ])("explanatory handling row rejects %s", async (mode) => {
    let fee = explanatoryFee;
    if (mode === "missingCharge")
      fee = fee.replace('<strong id="effective-handling">Free</strong>', "");
    if (mode === "hiddenCharge")
      fee = fee.replace(
        'id="effective-handling"',
        'id="effective-handling" hidden',
      );
    if (mode === "duplicateFree")
      fee = fee.replace("</strong>", "</strong><span>Free</span>");
    if (mode === "freeAndCharge")
      fee = fee.replace("</strong>", "</strong><span>₹5.00</span>");
    if (mode === "unmarkedOriginal")
      fee = fee.replace("<del>", "<span>").replace("</del>", "</span>");
    if (mode === "annotationAmount")
      fee = fee.replace("</small>", "<span>₹2.00</span></small>");
    if (mode === "duplicateAnnotation")
      fee = fee.replace(
        "</small>",
        '</small><small><span>Free for</span><svg width="12" height="12"></svg></small>',
      );
    if (mode === "missingIcon") fee = fee.replace(/<svg[\s\S]*?<\/svg>/, "");
    if (mode === "mergedCharge")
      fee = fee
        .replace("</small>", "<span>Free</span></small>")
        .replace('<strong id="effective-handling">Free</strong>', "");
    if (mode === "unknownAnnotation")
      fee = fee.replace("Free for", "Free for eligible members");
    html = statusFeePresentation.replace(explanatoryFee, fee);
    if (mode === "annotationOnTotal")
      html = html.replace(
        "<strong>You pay</strong>",
        '<strong>You pay</strong><small>Free for<svg width="12" height="12"></svg></small>',
      );
    await expect(extract()).rejects.toThrow();
  });

  test("a charged handling fee with explanation remains a positive adjustment", async () => {
    html = statusFeePresentation
      .replace('id="effective-handling">Free', 'id="effective-handling">₹5.00')
      .replace('id="effective-total">736.00', 'id="effective-total">741.00');
    expect(
      (await extract()).adjustments.map(
        (adjustment) => adjustment.amount?.amount,
      ),
    ).toEqual([5]);
  });

  test("explained charged handling, delivery and discount keep their signs", async () => {
    html = statusFeePresentation
      .replace('id="effective-handling">Free', 'id="effective-handling">₹5.00')
      .replace("<span>Free</span>", "<span>₹7.00</span>")
      .replace(
        '<div id="billed">',
        '<div>Discount <span>-₹12.00</span></div><div id="billed">',
      );
    expect(
      (await extract()).adjustments.map(
        (adjustment) => adjustment.amount?.amount,
      ),
    ).toEqual([5, 7, -12]);
  });

  test("a decorative annotation icon may be accessibility-hidden without hiding the fee", async () => {
    html = statusFeePresentation.replace(
      "<svg width=",
      '<svg aria-hidden="true" width=',
    );
    expect((await extract()).adjustments).toEqual([]);
  });

  test.each(["incompleteItem", "ambiguousFee", "missingFee"])(
    "compatibility %s failure creates no JSON",
    async (mode) => {
      html = statusFeePresentation;
      if (mode === "incompleteItem")
        html = html.replace("500 g · <span>1 unit</span>", "500 g");
      if (mode === "ambiguousFee")
        html = html.replace(
          'id="effective-handling">Free</strong>',
          'id="effective-handling">Free</strong><span>₹5.00</span>',
        );
      if (mode === "missingFee")
        html = html.replace(
          '<strong id="effective-handling">Free</strong>',
          "",
        );
      jest
        .spyOn(chromium, "launchPersistentContext")
        .mockResolvedValue(context);
      const directory = await mkdtemp(
        join(tmpdir(), "now-compatibility-atomic-"),
      );
      const output = join(directory, "orders.json");
      const logs: string[] = [];
      try {
        await expect(
          runExport(
            { ...options, output },
            (message) => {
              logs.push(message);
            },
            {
              list: listOrders,
              extract: extractOrderItems,
              write: validateAndWriteExport,
              report: async () => {},
              cleanup: async () => {},
            },
          ),
        ).rejects.toThrow();
        expect(await readdir(directory)).toEqual([]);
        expect(logs.join(" ")).not.toMatch(
          /111-|736|Fictional|Free for|amazon\.in/,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test("second invented presentation exports all 23 effective merchandise rows", async () => {
    html = presentation;
    listHtml = list.replace("₹230.00", "₹736.00");
    jest.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context);
    const [summary] = (await listOrders(options.startDate, options.endDate, 5))
      .orders;
    const detail = await extractOrderItems(id, undefined, summary);
    expect(detail.items).toHaveLength(23);
    expect(detail.items.map((item) => item.productName)).toEqual(
      Array.from(
        { length: 23 },
        (_, index) =>
          `Fictional market item ${String(index + 1).padStart(2, "0")}`,
      ),
    );
    expect(detail.items.map((item) => item.quantity)).toEqual(
      Array(23).fill(1),
    );
    expect(detail.items.map((item) => item.itemTotal?.amount)).toEqual(
      Array.from({ length: 23 }, (_, index) => index + 21),
    );
    expect(
      detail.items.every(
        (item) => item.unitPrice?.amount === item.itemTotal?.amount,
      ),
    ).toBe(true);
    expect(detail.items[0].asin).toBe("B0FAKE0001");
    expect(detail.items[3].asin).toBe("");
    expect(detail.orderTotal?.amount).toBe(736);
    expect(detail.orderTotalSource).toBe("amazon-now-you-pay");
    expect(detail.adjustments).toEqual([]);
    const document = createExportDocument(
      options,
      1,
      [{ summary, detail }],
      new Date().toISOString(),
    );
    expect(document.orders[0].items.map((item) => item.lineIndex)).toEqual(
      Array.from({ length: 23 }, (_, index) => index),
    );
    expect(JSON.stringify(document)).not.toMatch(
      /Gift Cards|Voucher|Payment card|Inclusive of taxes|999/,
    );
    expect(await page.locator("button").getAttribute("data-clicked")).toBe(
      "yes",
    );
  });

  test.each([
    "wrong",
    "missing",
    "duplicate",
    "hidden",
    "doubleHash",
    "suffix",
    "wrongOwner",
  ])("tracking %s identity prevents the click", async (mode) => {
    html = presentation;
    if (mode === "wrong")
      html = html.replace(
        `<span>#${id}</span>`,
        "<span>#111-2222222-4444444</span>",
      );
    if (mode === "missing")
      html = html.replace("<b>Order ID</b>", "<b>Reference</b>");
    if (mode === "duplicate")
      html = html.replace(
        "<h1>Order tracking</h1>",
        `<h1>Order tracking</h1><div>Order ID #${id}</div>`,
      );
    if (mode === "hidden")
      html = html.replace('id="tracking-id"', 'id="tracking-id" hidden');
    if (mode === "doubleHash")
      html = html.replace(`<span>#${id}</span>`, `<span>##${id}</span>`);
    if (mode === "suffix")
      html = html.replace(`<span>#${id}</span>`, `<span>#${id}0</span>`);
    if (mode === "wrongOwner")
      html = html.replace(
        `data-order-id="${id}"`,
        'data-order-id="111-2222222-4444444"',
      );
    await expect(extract()).rejects.toThrow();
    expect(
      await page.locator("button").getAttribute("data-clicked"),
    ).toBeNull();
  });

  test.each([
    "wrongSheet",
    "duplicateSheetId",
    "doubleHashSheet",
    "missingQuantity",
    "ambiguousQuantity",
    "duplicateQuantity",
    "quantityTwo",
    "twoCurrentPrices",
    "malformedPrice",
    "unmarkedOldPrice",
    "hiddenPrice",
    "missingBilled",
    "duplicateBilled",
    "conflictingBilled",
    "hiddenBilled",
    "twoBilledValues",
    "unknownSubtitle",
    "includedFee",
    "unknownCharge",
    "unclassifiedImage",
    "merchandiseInPayment",
  ])("presentation rejects %s instead of guessing", async (mode) => {
    html = presentation;
    if (mode === "wrongSheet")
      html = html.replace(
        `<b>Order ID:</b><span>#${id}</span>`,
        "<b>Order ID:</b><span>#111-2222222-4444444</span>",
      );
    if (mode === "duplicateSheetId")
      html = html.replace(
        "<h1>Order Details</h1>",
        `<h1>Order Details</h1><div>Order ID #${id}</div>`,
      );
    if (mode === "doubleHashSheet")
      html = html.replace(
        `<b>Order ID:</b><span>#${id}</span>`,
        `<b>Order ID:</b><span>##${id}</span>`,
      );
    if (mode === "missingQuantity")
      html = html.replace("500 g · <span>1 unit</span>", "500 g");
    if (mode === "ambiguousQuantity")
      html = html.replace(
        "<span>1 unit</span>",
        "<span>1 unit · 2 units</span>",
      );
    if (mode === "duplicateQuantity")
      html = html.replace(
        "<span>1 unit</span>",
        "<span>1 unit</span><span>Qty: 1</span>",
      );
    if (mode === "quantityTwo")
      html = html.replace("<span>1 unit</span>", "<span>2 units</span>");
    if (mode === "twoCurrentPrices")
      html = html.replace(
        'class="effective-number">21.00</span>',
        'class="effective-number">21.00</span><span>₹22.00</span>',
      );
    if (mode === "malformedPrice")
      html = html.replace(
        'class="effective-number">21.00',
        'class="effective-number">21.001',
      );
    if (mode === "unmarkedOldPrice")
      html = html.replace(
        "<del><span>₹</span><span>26.00</span></del>",
        "<div><span>₹</span><span>26.00</span></div>",
      );
    if (mode === "hiddenPrice")
      html = html.replace(
        'class="effective-symbol"',
        'class="effective-symbol" hidden',
      );
    if (mode === "missingBilled")
      html = html.replace(
        "<strong>You pay</strong>",
        "<strong>Other total</strong>",
      );
    if (mode === "duplicateBilled" || mode === "conflictingBilled")
      html = html.replace(
        '<div id="billed">',
        `<div>You pay ₹${mode === "duplicateBilled" ? "736" : "737"}.00</div><div id="billed">`,
      );
    if (mode === "hiddenBilled")
      html = html.replace('id="billed"', 'id="billed" hidden');
    if (mode === "twoBilledValues")
      html = html.replace(
        'id="effective-total">736.00</strong>',
        'id="effective-total">736.00</strong><span>₹735.00</span>',
      );
    if (mode === "unknownSubtitle")
      html = html.replace("Inclusive of taxes", "Tax calculation pending");
    if (mode === "includedFee")
      html = html.replace("Handling fee", "Handling fee included");
    if (mode === "unknownCharge")
      html = html.replace(
        '<div id="handling">',
        '<div>Service fee ₹3.00</div><div id="handling">',
      );
    if (mode === "unclassifiedImage")
      html = html.replace(
        '<div role="list"',
        '<img alt="Unknown icon" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="><div role="list"',
      );
    if (mode === "merchandiseInPayment")
      html = html.replace(
        "<h2>Payment</h2>",
        '<h2>Payment</h2><a href="/dp/B0FAKE0001">Incomplete merchandise</a>',
      );
    await expect(extract()).rejects.toThrow();
  });

  test("hidden duplicate merchandise and totals do not become active facts", async () => {
    html = presentation
      .replace(
        '<div role="list" id="merchandise">',
        '<div role="list" id="merchandise"><article hidden><img alt="B0FAKE0001"><span>Qty: 9</span><span>₹99.00</span></article>',
      )
      .replace(
        '<div id="billed">',
        '<div hidden>You pay ₹999.00</div><div id="billed">',
      );
    expect((await extract()).items).toHaveLength(23);
  });
  test("two units with separate labeled unit/line prices remain independently priced", async () => {
    html = presentation
      .replace("<span>1 unit</span>", "<span>2 units</span>")
      .replace(
        '<span class="effective-symbol">₹</span><span class="effective-number">21.00</span>',
        "<div>Unit price: <span>₹</span><span>10.50</span></div><div>Line total: <span>₹</span><span>21.00</span></div>",
      );
    expect((await extract()).items[0]).toMatchObject({
      quantity: 2,
      unitPrice: { amount: 10.5 },
      itemTotal: { amount: 21 },
    });
  });
  test.each(["Payment method", "Payment details", "Payment information"])(
    "recognizes a separate %s region",
    async (heading) => {
      html = presentation.replace("<h2>Payment</h2>", `<h2>${heading}</h2>`);
      expect((await extract()).items).toHaveLength(23);
    },
  );
  test("an explicit accessibility status region independently owns its icon", async () => {
    html = presentation
      .replace(
        '<section id="delivery-status">',
        '<section role="status" id="delivery-status">',
      )
      .replace("<h2>Delivery status</h2>", "");
    expect((await extract()).items).toHaveLength(23);
  });

  test.each([
    "presentationalImage",
    "missingImage",
    "duplicateProduct",
    "statusMerchandise",
    "rowOverlap",
  ])("merchandise ownership cannot omit %s", async (mode) => {
    html = presentation;
    if (mode === "presentationalImage")
      html = html
        .replace(
          '<img alt="B0FAKE0001"',
          '<img role="presentation" alt="B0FAKE0001"',
        )
        .replace("500 g · <span>1 unit</span>", "500 g");
    if (mode === "missingImage")
      html = html
        .replace(/<img alt="B0FAKE0001"[^>]+>/, "")
        .replace("500 g · <span>1 unit</span>", "500 g");
    if (mode === "duplicateProduct")
      html = html
        .replace("B0FAKE0002", "B0FAKE0001")
        .replace("Fictional market item 02", "Fictional market item 01");
    if (mode === "statusMerchandise")
      html = html.replace(
        "<span>Delivered</span>",
        "<span>Delivered</span><span>Qty: 1</span><span>₹21.00</span>",
      );
    if (mode === "rowOverlap")
      html = html.replace(
        '<article role="listitem" id="invented-row-2">',
        '<article role="listitem" id="invented-row-2"><span>Qty: 1</span>',
      );
    await expect(extract()).rejects.toThrow();
  });

  test("presentation signed discounts and charged fees retain their effective values", async () => {
    html = presentation
      .replace("<strong>Free</strong>", "<strong>₹5.00</strong>")
      .replace("<span>Free</span>", "<span>₹7.00</span>")
      .replace(
        '<div id="billed">',
        '<div><span>Discount</span><span>-₹</span><span>12.00</span></div><div id="billed">',
      );
    expect(
      (await extract()).adjustments.map(
        (adjustment) => adjustment.amount?.amount,
      ),
    ).toEqual([5, 7, -12]);
  });

  test.each([1, 2])(
    "presentation independently declared total has %s paise variance",
    async (paise) => {
      html = presentation.replace(
        'id="effective-total">736.00',
        `id="effective-total">736.0${paise}`,
      );
      if (paise === 1) expect((await extract()).orderTotal.amount).toBe(736.01);
      else
        await expect(extract()).rejects.toMatchObject({
          reason: "TOTAL_MISMATCH",
        });
    },
  );

  test.each(["tracking", "quantity", "total", "price", "incompleteRow"])(
    "presentation %s failure preserves prior JSON and creates no partial export",
    async (mode) => {
      html = presentation;
      if (mode === "tracking")
        html = html.replace(
          `<span>#${id}</span>`,
          "<span>#111-2222222-4444444</span>",
        );
      if (mode === "quantity")
        html = html.replace(
          "500 g · <span>1 unit</span>",
          "500 g · <span>1 unit · 2 units</span>",
        );
      if (mode === "incompleteRow")
        html = html.replace("500 g · <span>1 unit</span>", "500 g");
      if (mode === "total")
        html = html.replace(
          'id="effective-total">736.00',
          'id="effective-total">736.02',
        );
      if (mode === "price")
        html = html.replace(
          'class="effective-number">21.00',
          'class="effective-number">21.001',
        );
      jest
        .spyOn(chromium, "launchPersistentContext")
        .mockResolvedValue(context);
      const directory = await mkdtemp(
        join(tmpdir(), "now-presentation-atomic-"),
      );
      const output = join(directory, "orders.json");
      await writeFile(output, "prior complete export");
      const logs: string[] = [];
      try {
        await expect(
          runExport(
            { ...options, output },
            (message) => {
              logs.push(message);
            },
            {
              list: listOrders,
              extract: extractOrderItems,
              write: validateAndWriteExport,
              report: async () => {},
              cleanup: async () => {},
            },
          ),
        ).rejects.toThrow();
        expect(await readFile(output, "utf8")).toBe("prior complete export");
        expect(await readdir(directory)).toEqual(["orders.json"]);
        expect(logs.join(" ")).not.toMatch(
          /111-|736|Fictional|Voucher|amazon\.in/,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test("production list → selected outer UFF link → tracking → sheet → unchanged JSON", async () => {
    jest.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context);
    const listed = await listOrders(
      options.startDate,
      options.endDate,
      options.maxOrders,
    );
    expect(listed.orders).toHaveLength(1);
    const summary = listed.orders[0];
    expect(summary.nowDetailUrl).toBe(outer);
    const detail = await extractOrderItems(id, undefined, summary);
    expect(detail.orderTotalSource).toBe("amazon-now-you-pay");
    expect(detail.items).toHaveLength(23);
    expect(detail.items[0]).toMatchObject({
      productName: "Invented pantry product 01",
      asin: "B0TEST0001",
      quantity: 1,
      unitPrice: { amount: 10 },
      itemTotal: { amount: 10 },
    });
    expect(detail.items[2].asin).toBe("");
    expect(detail.adjustments).toEqual([]);
    const document = createExportDocument(
      options,
      1,
      [{ summary, detail }],
      new Date().toISOString(),
    );
    expect(document.orders[0].orderTotal).toBe(230);
    expect(document.orders[0].orderUrl).toBe(outer);
    expect(document.orders[0].items.map((item) => item.lineIndex)).toEqual(
      Array.from({ length: 23 }, (_, index) => index),
    );
    expect(JSON.stringify(document)).not.toMatch(
      /Voucher|Gift Card|Payment card|460/,
    );
    expect(requests).toContain("/uff/your-account/order-details");
    expect(requests).not.toContain("/gp/your-account/order-details");
  });

  test.each([
    "wrongId",
    "duplicateId",
    "missingId",
    "duplicateSheet",
    "staleSheet",
    "hiddenSheet",
    "wrongOwner",
    "hiddenOwner",
    "cancelled",
    "refunded",
    "missingQuantity",
    "quantityTwo",
    "duplicateItem",
    "missingTotal",
    "conflictingTotal",
    "duplicateTotal",
    "malformedTotal",
    "subtotalDecoy",
    "includedFee",
    "unsignedDiscount",
    "unclassifiedCharge",
    "twoControls",
    "wrongRoute",
    "duplicateQuery",
    "priceConflict",
  ])(
    "fails closed on %s",
    async (mode) => {
      if (mode === "wrongId")
        html = html.replace(
          `<span>${id}</span>`,
          "<span>111-2222222-4444444</span>",
        );
      if (mode === "duplicateId")
        html = html.replace(
          "<h1>Order Details</h1>",
          `<h1>Order Details</h1><div>Order ID ${id}</div>`,
        );
      if (mode === "missingId") html = html.replace("Order ID", "Reference");
      if (mode === "duplicateSheet")
        html =
          html.replace(
            "style.display='block'",
            "style.display='block';document.querySelector('#duplicate').style.display='block'",
          ) +
          `<section role="dialog" id="duplicate" style="display:none"><h1>Order Details</h1></section>`;
      if (mode === "staleSheet")
        html = html.replace('style="display:none"', 'style="display:block"');
      if (mode === "hiddenSheet")
        html = html.replace("style.display='block'", "style.display='none'");
      if (mode === "wrongOwner")
        html = html.replace(
          'id="fixture-bill"',
          'id="fixture-bill" data-order-id="111-2222222-4444444"',
        );
      if (mode === "hiddenOwner")
        html = html.replace(
          "<span>Order ID</span>",
          '<span style="display:none">Order ID</span>',
        );
      if (mode === "cancelled" || mode === "refunded")
        html = html.replace(
          "<h1>Order Details</h1>",
          `<h1>Order Details</h1><div>${mode}</div>`,
        );
      if (mode === "missingQuantity")
        html = html.replace("Qty: 1", "Quantity unavailable");
      if (mode === "quantityTwo") html = html.replace("Qty: 1", "Qty: 2");
      if (mode === "duplicateItem")
        html = html
          .replace("Invented pantry product 02", "Invented pantry product 01")
          .replace("B0TEST0002", "B0TEST0001");
      if (mode === "missingTotal")
        html = html.replace("You pay", "Other amount");
      if (mode === "conflictingTotal" || mode === "duplicateTotal")
        html = html.replace(
          '<div id="fixture-you-pay">',
          `<div>You pay <span>₹${mode === "duplicateTotal" ? "230" : "231"}.00</span></div><div id="fixture-you-pay">`,
        );
      if (mode === "malformedTotal")
        html = html.replace(
          "<span>₹230.00</span><s>₹460.00</s>",
          "<span>₹230.001</span><s>₹460.00</s>",
        );
      if (mode === "subtotalDecoy")
        html = html.replace(
          "<span>₹230.00</span><s>₹460.00</s>",
          "<span>Unavailable</span><s>₹460.00</s>",
        );
      if (mode === "includedFee")
        html = html.replace("Handling fee", "Handling fee included");
      if (mode === "unsignedDiscount")
        html = html.replace(
          "Handling fee <span>Free</span>",
          "Discount <span>₹5.00</span>",
        );
      if (mode === "unclassifiedCharge")
        html = html.replace("Handling fee", "Service adjustment");
      if (mode === "twoControls")
        html = html.replace(
          "<section role=",
          "<button>View order details</button><section role=",
        );
      if (mode === "wrongRoute")
        redirect = tracking.replace(id, "111-2222222-4444444");
      if (mode === "duplicateQuery") redirect += `&orderID=${id}`;
      if (mode === "priceConflict")
        html = html.replace(
          "<span>₹10.00</span>",
          "<span>₹10.00</span><span>₹11.00</span>",
        );
      await expect(extract()).rejects.toThrow();
    },
    15000,
  );

  test("reads nonzero fees and explicitly negative discounts; ignores mixed funding", async () => {
    html = html
      .replace(
        "Handling fee <span>Free</span>",
        "Handling fee <span>₹5.00</span>",
      )
      .replace(
        "Delivery fee <span>Free</span>",
        "Delivery fee <span>₹7.00</span>",
      )
      .replace(
        '<div id="fixture-you-pay">',
        '<div>Discount <span>-₹12.00</span></div><div id="fixture-you-pay">',
      );
    const detail = await extract();
    expect(
      detail.adjustments.map((adjustment) => adjustment.amount?.amount),
    ).toEqual([5, 7, -12]);
    expect(detail.orderTotal.amount).toBe(230);
  });

  test("accepts quantity two only with independently labeled unit and line prices", async () => {
    html = html
      .replace("Qty: 1", "Quantity: 2")
      .replace(
        "<span>₹10.00</span>",
        "<span>Unit price: ₹5.00</span><span>Line total: ₹10.00</span>",
      );
    const detail = await extract();
    expect(detail.items[0]).toMatchObject({
      quantity: 2,
      unitPrice: { amount: 5 },
      itemTotal: { amount: 10 },
    });
  });

  test("separate funding logos cannot become item anchors", async () => {
    html = html.replace(
      "<h2>Payment method</h2>",
      '<h2>Payment method</h2><img alt="Gift card logo" style="width:20px;height:20px" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">',
    );
    expect((await extract()).items).toHaveLength(23);
  });
  test("accepts complete inline Order ID and You pay label/value declarations", async () => {
    html = html
      .replace(`<span>Order ID</span><span>${id}</span>`, `Order ID:${id}`)
      .replace("<span>You pay</span><span>₹230.00</span>", "You pay ₹230.00");
    expect((await extract()).orderTotal.amount).toBe(230);
  });

  test.each(["outer", "inner"])(
    "preserves manual authentication on %s redirect",
    async (mode) => {
      jest
        .spyOn(chromium, "launchPersistentContext")
        .mockResolvedValue(context);
      if (mode === "outer") redirect = "https://www.amazon.in/ap/signin";
      else
        html = html.replace(
          "document.querySelector('#now-sheet').style.display='block'",
          "location.href='/ap/signin'",
        );
      await expect(
        extractOrderItems(id, undefined, {
          orderId: id,
          orderDate: "2026-10-01",
          nowDetailUrl: outer,
        }),
      ).rejects.toBeInstanceOf(AuthenticationRequiredError);
    },
    15000,
  );

  test("selected Now cancellations never enter conventional fallback", async () => {
    jest.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context);
    await expect(
      extractOrderItems(id, undefined, {
        orderId: id,
        orderDate: "2026-10-01",
        status: "cancelled",
        nowDetailUrl: outer,
      }),
    ).rejects.toMatchObject({ reason: "NOW_EXTRACTION_FAILED" });
    expect(requests).not.toContain("/gp/your-account/order-details");
  });

  test.each(["bad-alt", "missing-alt"])(
    "preserves empty ASIN for %s",
    async (mode) => {
      html = html.replace(
        'alt="B0TEST0001"',
        mode === "bad-alt" ? 'alt="not-an-asin B0TEST0001"' : "",
      );
      expect((await extract()).items[0].asin).toBe("");
    },
  );

  test.each([1, 2])(
    "one-paise reconciliation boundary: %s paise",
    async (paise) => {
      html = html.replace(
        "<span>₹230.00</span><s>₹460.00</s>",
        `<span>₹230.0${paise}</span><s>₹460.00</s>`,
      );
      if (paise === 1) expect((await extract()).orderTotal.amount).toBe(230.01);
      else
        await expect(extract()).rejects.toMatchObject({
          reason: "TOTAL_MISMATCH",
        });
    },
  );

  test.each(["wrongLink", "ambiguousLink", "validOtherOrder"])(
    "selected-card link isolation: %s",
    async (mode) => {
      listHtml =
        mode === "wrongLink"
          ? list.replace(outer, outer.replace(id, "111-2222222-4444444"))
          : mode === "ambiguousLink"
            ? list.replace("</a>", `</a><a href="${tracking}">Details</a>`)
            : list + list.replaceAll(id, "111-2222222-4444444");
      await page.goto("https://www.amazon.in/your-orders/orders");
      if (mode === "validOtherOrder")
        expect((await parseCurrentOrderPage(page))[0].nowDetailUrl).toBe(outer);
      else await expect(parseCurrentOrderPage(page)).rejects.toThrow();
    },
  );
  test("unrelated storefront links do not turn conventional cards into Now orders", async () => {
    listHtml = list
      .replace(outer, `/gp/your-account/order-details?orderID=${id}`)
      .replace("</a>", '</a><a href="/uff/storefront">Shop groceries</a>');
    await page.goto("https://www.amazon.in/your-orders/orders");
    expect((await parseCurrentOrderPage(page))[0].nowDetailUrl).toBeUndefined();
  });

  test.each(["missingTotal", "mismatch"])(
    "runExport never publishes partial JSON on %s",
    async (mode) => {
      html =
        mode === "missingTotal"
          ? html.replace("You pay", "Other amount")
          : html.replace(
              "<span>₹230.00</span><s>₹460.00</s>",
              "<span>₹230.02</span><s>₹460.00</s>",
            );
      jest
        .spyOn(chromium, "launchPersistentContext")
        .mockResolvedValue(context);
      const directory = await mkdtemp(join(tmpdir(), "now-atomic-"));
      const output = join(directory, "orders.json");
      await writeFile(output, "previous complete export");
      const logs: string[] = [];
      const report = jest.fn(async () => {});
      try {
        await expect(
          runExport(
            { ...options, output },
            (message) => {
              logs.push(message);
            },
            {
              list: listOrders,
              extract: extractOrderItems,
              write: validateAndWriteExport,
              report,
              cleanup: async () => {},
            },
          ),
        ).rejects.toThrow();
        expect(await readFile(output, "utf8")).toBe("previous complete export");
        expect(await readdir(directory)).toEqual(["orders.json"]);
        expect(logs.join(" ")).not.toMatch(
          /111-|pantry|Voucher|230|amazon\.in/,
        );
        expect(report).toHaveBeenCalledTimes(1);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});
