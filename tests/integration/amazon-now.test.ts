import { makeTestDirectory } from "../helpers/temp-directory";
/** Invented fixtures, ephemeral Chromium, every request intercepted. No Amazon access. */
import { existsSync, readFileSync } from "fs";
import { readFile, readdir, rm, writeFile } from "fs/promises";
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
const splitDelivery = readFileSync(
  join(__dirname, "fixtures/amazon-now-split-delivery.html"),
  "utf8",
);
const nestedDeclarations = readFileSync(
  join(__dirname, "fixtures/amazon-now-nested-declarations.html"),
  "utf8",
);
const sharedTracking = readFileSync(
  join(__dirname, "fixtures/amazon-now-shared-tracking.html"),
  "utf8",
);
const alterSplit = (code: string): string =>
  splitDelivery + `<script>${code};document.currentScript.remove()</script>`;
const splitPackagePrices = readFileSync(
  join(__dirname, "fixtures/amazon-now-a11y-prices.html"),
  "utf8",
);
const tabletOrder = readFileSync(
  join(__dirname, "fixtures/amazon-now-tablets.html"),
  "utf8",
);
const pieceOrder = readFileSync(
  join(__dirname, "fixtures/amazon-now-pieces.html"),
  "utf8",
);
const pieceApprox = "3 Pcs (Approx. 61.5–93.25 g)";
const piecePlain = "7 Pcs (105-165 g)";
const pieceFields = (
  descriptor: string,
  separator: string,
  units = "1 unit",
): string =>
  `<span class="package-size">${descriptor}</span><span class="package-separator">${separator}</span><div class="quantity">${units}</div>`;
const pieceCases: Array<[string, string]> = [];
for (const [label, descriptor, separator, qualifier] of [
  ["approximate", pieceApprox, ".", "Approx. "],
  ["plain", piecePlain, "·", ""],
]) {
  const fields = pieceFields(descriptor, separator);
  const badDescriptors = [
    ...["0", "-1", "01", "1.5", "9007199254740992"].map(
      (count) => `${count} Pcs (${qualifier}61-93 g)`,
    ),
    ...[
      "0-93",
      "-1-93",
      "93-61",
      "61-61",
      "61.50-61.5",
      "61-0",
      "61--93",
      "01-93",
      "1e1-93",
      "61—93",
      "61/93",
      "61..93",
      "61-NaN",
    ].map((range) => `3 Pcs (${qualifier}${range} g)`),
    `3 Pcs (${qualifier}61-93 kg)`,
    `3 Pieces (${qualifier}61-93 g)`,
    `3 pcs (${qualifier}61-93 g)`,
    `Box 3 Pcs (${qualifier}61-93 g)`,
    `3 Pcs (${qualifier}61-93 g) extra`,
    "3 Pcs (Approx 61-93 g)",
  ];
  for (const bad of badDescriptors)
    pieceCases.push([
      `${label} bad descriptor ${bad}`,
      pieceOrder.replace(descriptor, bad),
    ]);
  const fieldVariants: Array<[string, string]> = [
    ["missing separator", `<span>${descriptor}</span><div>1 unit</div>`],
    ...["•", "|", ":", "..", "··", "．"].map((sep): [string, string] => [
      "wrong separator " + sep,
      pieceFields(descriptor, sep),
    ]),
    [
      "duplicate separator",
      fields.replace("</span><div", "</span><span>.</span><div"),
    ],
    [
      "reordered separator",
      `<span>${separator}</span><span>${descriptor}</span><div>1 unit</div>`,
    ],
    [
      "different parents",
      `<div><span>${descriptor}</span><span>${separator}</span></div><div>1 unit</div>`,
    ],
    [
      "nonadjacent fields",
      fields.replace(
        '</span><span class="package-separator"',
        '</span><span>Unrelated text</span><span class="package-separator"',
      ),
    ],
    [
      "hidden intervening field",
      fields.replace(
        '</span><span class="package-separator"',
        '</span><span hidden>Unrelated text</span><span class="package-separator"',
      ),
    ],
    [
      "missing quantity",
      fields.replace('<div class="quantity">1 unit</div>', ""),
    ],
    ["duplicate quantity", fields + "<div>Quantity: 2</div>"],
    ["duplicate descriptor", `<span>${descriptor}</span>` + fields],
    ["extra name", "<span>Another invented name</span>" + fields],
    ["hidden conflicting count", fields + "<span hidden>Qty: 2</span>"],
    [
      "hidden conflicting descriptor",
      fields + `<span hidden>${descriptor}</span>`,
    ],
    ["historical conflicting descriptor", fields + `<s>${descriptor}</s>`],
    [
      "hidden missing piece count",
      fields + "<span hidden>Pcs (61-93 g)</span>",
    ],
    [
      "hidden fragmented metadata pair",
      `<span hidden><b>3</b><i>Pcs</i><span>(61-93 g)</span></span><span hidden>${separator}</span><div>1 unit</div>`,
    ],
    [
      "hidden malformed descriptor",
      fields + "<span hidden>0 Pcs (93-61 g)</span>",
    ],
    ["historical malformed descriptor", fields + "<s>0 Pcs (93-61 g)</s>"],
    [
      "hidden metadata pair",
      `<span hidden>${descriptor}</span><span hidden>${separator}</span><div>1 unit</div>`,
    ],
    [
      "historical metadata pair",
      `<s>${descriptor}</s><s>${separator}</s><div>1 unit</div>`,
    ],
    [
      "product link in descriptor",
      fields.replace(descriptor, `${descriptor}<a href="/dp/B0PIEC0099"></a>`),
    ],
    [
      "control in descriptor",
      fields.replace(descriptor, `${descriptor}<button>Choice</button>`),
    ],
    [
      "hidden descendant",
      fields.replace(descriptor, `${descriptor}<span hidden>Other</span>`),
    ],
    [
      "merchandise boundary in descriptor",
      fields.replace(descriptor, `${descriptor}<span role="listitem"></span>`),
    ],
    ...["0 units", "2 units", "9007199254740992 units", "Qty: nope"].map(
      (count): [string, string] => [
        "invalid/incomplete quantity " + count,
        pieceFields(descriptor, separator, count),
      ],
    ),
    ...[
      "hidden",
      'aria-hidden="true"',
      'style="opacity:0"',
      'style="text-decoration:line-through"',
    ].map((attr): [string, string] => [
      "noncurrent metadata " + attr,
      fields.replace('class="package-size"', `class="package-size" ${attr}`),
    ]),
  ];
  for (const [name, replacement] of fieldVariants)
    pieceCases.push([
      `${label} ${name}`,
      pieceOrder.replace(fields, replacement),
    ]);
}
const gramOrder = readFileSync(
  join(__dirname, "fixtures/amazon-now-gram-multipack.html"),
  "utf8",
);
const gramDescriptor = "Pack of 6, 0.75 g Each";
const gramFields = pieceFields(gramDescriptor, ".");
const gramCases: Array<[string, string]> = [
  ...[
    ...["0", "-1", "+2", "01", "1.5", "1e2", "9007199254740992", ""].map(
      (count) => `Pack of ${count}, 0.75 g Each`,
    ),
    ...[
      "0",
      "0.00",
      "-1",
      "+1",
      "01",
      "00.75",
      ".75",
      "1.",
      "1e2",
      "NaN",
      "Infinity",
      "9007199254740991",
      "9007199254740992",
      "9".repeat(310),
      "0." + "0".repeat(340) + "1",
    ].map((grams) => `Pack of 6, ${grams} g Each`),
    ...[
      "kg Each",
      "mg Each",
      "grams Each",
      "G Each",
      "g each",
      "g EACH",
      "g Each extra",
      "g",
    ].map((unit) => `Pack of 6, 0.75 ${unit}`),
    "Pack of 6, 1." + "0".repeat(500) + "1 g Each",
    "pack of 6, 0.75 g Each",
    "Pack of 6; 0.75 g Each",
    "Pack of 6， 0.75 g Each",
    "Pack of 6,0.75 g Each",
    "Pack of 6 0.75 g Each",
    "Box of 6, 0.75 g Each",
  ].map((value): [string, string] => [
    "malformed descriptor " + value,
    gramOrder.replace(gramDescriptor, value),
  ]),
  ...(
    [
      ["missing separator", `<span>${gramDescriptor}</span><div>1 unit</div>`],
      ...["·", "•", "|", ":", "..", "．"].map((separator): [string, string] => [
        "unsupported separator " + separator,
        pieceFields(gramDescriptor, separator),
      ]),
      [
        "duplicate separator",
        gramFields.replace("</span><div", "</span><span>.</span><div"),
      ],
      [
        "misplaced period",
        `<span>.</span><span>${gramDescriptor}</span><div>1 unit</div>`,
      ],
      [
        "different parents",
        `<div><span>${gramDescriptor}</span><span>.</span></div><div>1 unit</div>`,
      ],
      [
        "nonadjacent visible field",
        gramFields.replace(
          '</span><span class="package-separator"',
          '</span><span>Unrelated</span><span class="package-separator"',
        ),
      ],
      [
        "nonadjacent hidden field",
        gramFields.replace(
          '</span><span class="package-separator"',
          '</span><span hidden>Unrelated</span><span class="package-separator"',
        ),
      ],
      [
        "missing purchased declaration",
        gramFields.replace('<div class="quantity">1 unit</div>', ""),
      ],
      ["duplicate purchased declaration", gramFields + "<div>Qty: 1</div>"],
      ["duplicate metadata", `<span>${gramDescriptor}</span>` + gramFields],
      ["extra product name", "<span>Another invented name</span>" + gramFields],
      [
        "hidden metadata pair",
        `<span hidden>${gramDescriptor}</span><span hidden>.</span><div>1 unit</div>`,
      ],
      [
        "historical metadata pair",
        `<s>${gramDescriptor}</s><s>.</s><div>1 unit</div>`,
      ],
      [
        "hidden conflicting descriptor",
        gramFields + `<span hidden>${gramDescriptor}</span>`,
      ],
      [
        "historical conflicting descriptor",
        gramFields + `<s>${gramDescriptor}</s>`,
      ],
      [
        "hidden malformed descriptor",
        gramFields + "<span hidden>Pack of 0, 0 g Each</span>",
      ],
      ["hidden quantity conflict", gramFields + "<span hidden>Qty: 2</span>"],
      [
        "nested product link",
        gramFields.replace(
          gramDescriptor,
          gramDescriptor + '<a href="/dp/B0GRAM0099"></a>',
        ),
      ],
      [
        "nested control",
        gramFields.replace(
          gramDescriptor,
          gramDescriptor + "<button>Choice</button>",
        ),
      ],
      [
        "hidden metadata child",
        gramFields.replace(
          gramDescriptor,
          gramDescriptor + "<span hidden>Other</span>",
        ),
      ],
      [
        "nested merchandise boundary",
        gramFields.replace(
          gramDescriptor,
          gramDescriptor + '<span role="listitem"></span>',
        ),
      ],
      ...[
        "hidden",
        'aria-hidden="true"',
        'style="opacity:0"',
        'style="text-decoration:line-through"',
      ].map((attribute): [string, string] => [
        "noncurrent metadata " + attribute,
        gramFields.replace(
          'class="package-size"',
          'class="package-size" ' + attribute,
        ),
      ]),
      ...["0 units", "Qty: nope", "9007199254740992 units", "2 units"].map(
        (quantity): [string, string] => [
          "invalid or incomplete quantity " + quantity,
          pieceFields(gramDescriptor, ".", quantity),
        ],
      ),
    ] as Array<[string, string]>
  ).map(([name, fields]): [string, string] => [
    name,
    gramOrder.replace(gramFields, fields),
  ]),
  ["missing name", gramOrder.replace("Invented. gram-pack item 10", "")],
  [
    "descriptor-shaped name",
    gramOrder.replace("Invented. gram-pack item 10", gramDescriptor),
  ],
  [
    "missing price",
    gramOrder +
      `<script>document.querySelector('#grams-row-10 .price').remove();</script>`,
  ],
  [
    "ambiguous price",
    gramOrder +
      `<script>document.querySelector('#grams-row-10 .price').insertAdjacentHTML('beforeend', '<span>₹12.00</span>');</script>`,
  ],
  [
    "identifier conflict",
    gramOrder +
      `<script>document.querySelector('#grams-row-10').insertAdjacentHTML('beforeend', '<a href="/dp/B0GRAM0099"></a>');</script>`,
  ],
  [
    "billed total conflict",
    gramOrder.replace("You pay ₹76.00", "You pay ₹76.02"),
  ],
];
const singleLineOrder = readFileSync(
  join(__dirname, "fixtures/amazon-now-single-line.html"),
  "utf8",
);
const singleMutation = (script: string): string =>
  singleLineOrder + `<script>${script}</script>`;
const nestedBillOrder = readFileSync(
  join(__dirname, "fixtures/amazon-now-nested-bill-comparison.html"),
  "utf8",
);
const nestedReference = (wrappers: number, value = "₹37.00"): string =>
  "<div>".repeat(wrappers) +
  `<p style="text-decoration:line-through">${value}</p>` +
  "</div>".repeat(wrappers);
const nestedInBill = (markup: string, row = "single-you-pay"): string =>
  singleMutation(
    `document.querySelector('#${row}').insertAdjacentHTML('beforeend',${JSON.stringify(markup)});`,
  );
const nestedBillCases: Array<[string, string]> = [
  [
    "no recognized row",
    singleMutation(
      `document.querySelector('#single-bill').insertAdjacentHTML('beforeend',${JSON.stringify(nestedReference(1))});`,
    ),
  ],
  ["beyond five parent steps", nestedInBill(nestedReference(5))],
  [
    "two nested comparisons",
    nestedInBill(nestedReference(1) + nestedReference(2, "₹49.00")),
  ],
  [
    "nested and direct comparisons",
    nestedInBill(nestedReference(1) + "<s>₹49.00</s>"),
  ],
  [
    "nested overlapping bill rows",
    nestedInBill("<div>Shipping fee Free" + nestedReference(1) + "</div>"),
  ],
  [
    "multiple labels in owner",
    nestedInBill("Discount -₹0.00" + nestedReference(1)),
  ],
  [
    "shared bill container without row ownership",
    singleMutation(
      `const box=document.createElement('div'); const bill=document.querySelector('#single-bill'); box.append(document.querySelector('#single-subtotal'),document.querySelector('#single-you-pay')); box.insertAdjacentHTML('beforeend',${JSON.stringify(nestedReference(1))}); bill.append(box);`,
    ),
  ],
  [
    "hidden historical amount",
    nestedInBill(nestedReference(1).replace("<p ", "<p hidden ")),
  ],
  [
    "hidden comparison wrapper",
    nestedInBill(nestedReference(1).replace("<div>", "<div hidden>")),
  ],
  [
    "aria-hidden comparison wrapper",
    nestedInBill(
      nestedReference(1).replace("<div>", '<div aria-hidden="true">'),
    ),
  ],
  [
    "historical row instead of current owner",
    singleMutation(
      `const copy=document.querySelector('#single-you-pay').cloneNode(true); copy.style.textDecoration='line-through'; copy.insertAdjacentHTML('beforeend',${JSON.stringify(nestedReference(1))}); document.querySelector('#single-bill').append(copy);`,
    ),
  ],
  [
    "hidden conflicting financial fact",
    nestedInBill(nestedReference(1) + "<span hidden>₹49.00</span>"),
  ],
  [
    "unknown hidden bill token",
    nestedInBill(nestedReference(1) + "<span hidden>Unknown charge</span>"),
  ],
  [
    "unknown current bill token",
    nestedInBill(nestedReference(1) + "<span>Unknown charge ₹1.00</span>"),
  ],
  [
    "extra current amount",
    nestedInBill(nestedReference(1) + "<span>₹49.00</span>"),
  ],
  [
    "labelled historical charge",
    nestedInBill(nestedReference(1, "Shipping fee ₹49.00")),
  ],
  [
    "product descendant in historical amount",
    nestedInBill(nestedReference(1, '₹37.00<a href="/dp/B0SOLO0099"></a>')),
  ],
  [
    "control descendant in historical amount",
    nestedInBill(nestedReference(1, "₹37.00<button></button>")),
  ],
  [
    "unstruck reference",
    nestedInBill(
      nestedReference(1).replace('style="text-decoration:line-through"', ""),
    ),
  ],
  ["malformed reference amount", nestedInBill(nestedReference(1, "₹37.001"))],
  [
    "one paise conflicting current total",
    nestedInBill(nestedReference(1)) +
      `<script>document.querySelector('#single-you-pay span').textContent='₹18.51';</script>`,
  ],
  [
    "nonzero effective adjustment",
    nestedInBill(nestedReference(1)) +
      `<script>document.querySelector('#single-handling').innerHTML='Handling fee ₹1.00';</script>`,
  ],
  [
    "nondivisible current line total",
    nestedInBill(nestedReference(1)).replaceAll("₹18.50", "₹18.51"),
  ],
  [
    "nested merchandise comparison without current-field ownership",
    singleMutation(
      `document.querySelector('#single-price s').remove(); document.querySelector('#single-price').insertAdjacentHTML('beforeend',${JSON.stringify(nestedReference(1))});`,
    ),
  ],
];
const singleLineCases: Array<[string, string]> = [
  ...["single-subtotal", "single-you-pay"].flatMap(
    (id): Array<[string, string]> => [
      [
        "missing " + id,
        singleMutation(`document.querySelector('#${id}').remove();`),
      ],
      [
        "duplicate " + id,
        singleMutation(
          `const row=document.querySelector('#${id}'); row.after(row.cloneNode(true));`,
        ),
      ],
      [
        "hidden duplicate " + id,
        singleMutation(
          `const row=document.querySelector('#${id}'); const copy=row.cloneNode(true); copy.hidden=true; row.after(copy);`,
        ),
      ],
      [
        "historical duplicate " + id,
        singleMutation(
          `const row=document.querySelector('#${id}'); const copy=row.cloneNode(true); copy.style.textDecoration='line-through'; row.after(copy);`,
        ),
      ],
      [
        "hidden required " + id,
        singleMutation(`document.querySelector('#${id}').hidden=true;`),
      ],
      [
        "aria-hidden required " + id,
        singleMutation(
          `document.querySelector('#${id}').setAttribute('aria-hidden','true');`,
        ),
      ],
      [
        "one paise conflict " + id,
        singleMutation(
          `document.querySelector('#${id} span').textContent='₹18.51';`,
        ),
      ],
      [
        "hidden conflicting amount " + id,
        singleMutation(
          `document.querySelector('#${id}').insertAdjacentHTML('beforeend','<span hidden>₹99.00</span>');`,
        ),
      ],
    ],
  ),
  ["subtotal alias", singleLineOrder.replace("Items total", "Items subtotal")],
  [
    "additional subtotal declaration",
    singleMutation(
      `document.querySelector('#single-bill').insertAdjacentHTML('beforeend','<div>Subtotal ₹18.50</div>');`,
    ),
  ],
  [
    "duplicate free fee aliases",
    singleMutation(
      `document.querySelector('#single-bill').insertAdjacentHTML('beforeend','<div>Handling charge Free</div>');`,
    ),
  ],
  ...[
    "Handling fee ₹1.00",
    "Delivery fee ₹1.00",
    "Shipping fee ₹1.00",
    "Discount -₹1.00",
    "Promotion -₹1.00",
    "Unknown charge ₹0.00",
    "Tax ₹0.00",
  ].map((bill): [string, string] => [
    "nonzero/unknown adjustment " + bill,
    singleMutation(
      `document.querySelector('#single-handling').remove(); document.querySelector('#single-delivery').remove(); document.querySelector('#single-bill').insertAdjacentHTML('beforeend',${JSON.stringify("<div>" + bill + "</div>")});`,
    ),
  ]),
  [
    "adjustments net to zero",
    singleMutation(
      `document.querySelector('#single-handling').innerHTML='Handling fee ₹1.00'; document.querySelector('#single-bill').insertAdjacentHTML('beforeend','<div>Discount -₹1.00</div>');`,
    ),
  ],
  [
    "hidden unknown charge",
    singleMutation(
      `document.querySelector('#single-bill').insertAdjacentHTML('beforeend','<div hidden>Unknown charge ₹1.00</div>');`,
    ),
  ],
  [
    "hidden discount",
    singleMutation(
      `document.querySelector('#single-bill').insertAdjacentHTML('beforeend','<div hidden>Discount -₹1.00</div>');`,
    ),
  ],
  ...[
    "₹18.51",
    "₹0.01",
    "₹0",
    "₹-18.50",
    "-₹18.50",
    "₹018.50",
    "₹18.500",
    "₹1e2",
    "₹+18.50",
    "₹1,20.00",
    "₹90071992547409.92",
  ].map((value): [string, string] => [
    "invalid/nondivisible price " + value,
    singleLineOrder.replaceAll("₹18.50", value),
  ]),
  ...[
    "0 units",
    "-2 units",
    "02 units",
    "2.0 units",
    "Qty: unknown",
    "9007199254740992 units",
    "9007199254740991 units",
  ].map((value): [string, string] => [
    "invalid/nondivisible quantity " + value,
    singleLineOrder.replace("2 units", value),
  ]),
  [
    "missing quantity",
    singleMutation(`document.querySelector('#single-row .quantity').remove();`),
  ],
  [
    "duplicate quantity",
    singleMutation(
      `document.querySelector('#single-row').insertAdjacentHTML('beforeend','<div>Qty: 2</div>');`,
    ),
  ],
  [
    "missing name",
    singleMutation(`document.querySelector('#single-row h3').remove();`),
  ],
  [
    "duplicate name",
    singleMutation(
      `document.querySelector('#single-row h3').insertAdjacentHTML('afterend','<h3>Second invented name</h3>');`,
    ),
  ],
  [
    "conflicting identifier",
    singleMutation(
      `document.querySelector('#single-row').insertAdjacentHTML('beforeend','<a href="/dp/B0SOLO0002"></a>');`,
    ),
  ],
  [
    "extra current price",
    singleMutation(
      `document.querySelector('#single-price').insertAdjacentHTML('beforeend','<span>₹9.25</span>');`,
    ),
  ],
  [
    "unowned current price",
    singleMutation(
      `document.querySelector('#single-items').insertAdjacentHTML('afterend','<span>₹18.50</span>');`,
    ),
  ],
  [
    "hidden current price",
    singleMutation(`document.querySelector('#single-price span').hidden=true;`),
  ],
  [
    "only historical prices",
    singleMutation(
      `document.querySelector('#single-price span').style.textDecoration='line-through';`,
    ),
  ],
  [
    "hidden conflicting price",
    singleMutation(
      `document.querySelector('#single-price').insertAdjacentHTML('beforeend','<span hidden>₹99.00</span>');`,
    ),
  ],
  [
    "historical labelled unit price",
    singleMutation(
      `document.querySelector('#single-price').insertAdjacentHTML('beforeend','<s>Unit price: ₹9.25</s>');`,
    ),
  ],
  [
    "extra historical reference",
    singleMutation(
      `document.querySelector('#single-price').insertAdjacentHTML('beforeend','<s>₹99.00</s>');`,
    ),
  ],
  [
    "unbounded historical price",
    singleMutation(
      `document.querySelector('#single-row').insertAdjacentHTML('beforeend','<s>₹99.00</s>');`,
    ),
  ],
  [
    "actually hidden reference",
    singleMutation(`document.querySelector('#single-price s').hidden=true;`),
  ],
  [
    "hidden quantity",
    singleMutation(
      `document.querySelector('#single-row').insertAdjacentHTML('beforeend','<span hidden>Qty: 2</span>');`,
    ),
  ],
  [
    "historical quantity",
    singleMutation(
      `document.querySelector('#single-row').insertAdjacentHTML('beforeend','<s>Qty: 2</s>');`,
    ),
  ],
  [
    "aria-hidden name",
    singleMutation(
      `document.querySelector('#single-row').insertAdjacentHTML('beforeend','<h3 aria-hidden="true">Hidden invented name</h3>');`,
    ),
  ],
  [
    "aria-hidden quantity",
    singleMutation(
      `document.querySelector('#single-row').insertAdjacentHTML('beforeend','<span aria-hidden="true">Qty: 2</span>');`,
    ),
  ],
  [
    "extra bill comparisons",
    singleMutation(
      `document.querySelector('#single-you-pay').insertAdjacentHTML('beforeend','<s>₹37.00</s><s>₹99.00</s>');`,
    ),
  ],
  [
    "hidden name",
    singleMutation(
      `document.querySelector('#single-row').insertAdjacentHTML('beforeend','<h3 hidden>Hidden invented name</h3>');`,
    ),
  ],
  [
    "hidden merchandise row",
    singleMutation(
      `const row=document.querySelector('#single-row'); const copy=row.cloneNode(true); copy.hidden=true; row.after(copy);`,
    ),
  ],
  [
    "historical merchandise row",
    singleMutation(
      `const row=document.querySelector('#single-row'); const copy=row.cloneNode(true); copy.style.textDecoration='line-through'; row.after(copy);`,
    ),
  ],
  [
    "hidden merchandise inside funding",
    singleMutation(
      `const copy=document.querySelector('#single-row').cloneNode(true); copy.hidden=true; document.querySelector('#single-funding').append(copy);`,
    ),
  ],
  [
    "hidden quantity inside funding",
    singleMutation(
      `document.querySelector('#single-funding').insertAdjacentHTML('beforeend','<span hidden>Qty: 2</span>');`,
    ),
  ],
  [
    "unowned semantic product name",
    singleMutation(
      `const row=document.querySelector('#single-row'); const inner=document.createElement('div'); while(row.firstChild) inner.append(row.firstChild); row.append(inner); row.insertAdjacentHTML('beforeend','<h3>Another invented name</h3>');`,
    ),
  ],
  [
    "hidden unowned semantic product name",
    singleMutation(
      `const row=document.querySelector('#single-row'); const inner=document.createElement('div'); while(row.firstChild) inner.append(row.firstChild); row.append(inner); row.insertAdjacentHTML('beforeend','<h3 hidden>Another invented name</h3>');`,
    ),
  ],
  [
    "incomplete semantic merchandise row",
    singleMutation(
      `document.querySelector('#single-items').insertAdjacentHTML('beforeend','<article role="listitem"><h3>Incomplete invented item</h3><img role="presentation" alt="Invented item image" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="></article>');`,
    ),
  ],
  [
    "two current merchandise lines",
    singleMutation(
      `const row=document.querySelector('#single-row'); row.after(row.cloneNode(true)); document.querySelector('#single-subtotal span').textContent='₹37.00'; document.querySelector('#single-you-pay span').textContent='₹37.00';`,
    ),
  ],
];
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
    "500-400 g",
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

  test("source-owned alternate action publishes only the selected order without tracking manifests", async () => {
    html = splitDelivery;
    listHtml = list.replace("₹230.00", "₹30.00");
    jest.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context);
    const directory = await makeTestDirectory("now-deliveries-complete-");
    const output = join(directory, "orders.json");
    try {
      await runExport({ ...options, output }, () => {}, {
        list: listOrders,
        extract: extractOrderItems,
        write: validateAndWriteExport,
        report: async () => {},
        cleanup: async () => {},
      });
      const saved = JSON.parse(await readFile(output, "utf8"));
      expect(saved.orders).toHaveLength(1);
      expect(saved.orders[0]).toMatchObject({
        orderId: id,
        orderTotal: 30,
        items: [
          {
            lineIndex: 0,
            asin: "B0SPLT0001",
            productName: "Invented split lentils",
            quantity: 1,
            unitPrice: 11,
            itemTotal: 11,
          },
          {
            lineIndex: 1,
            asin: "B0SPLT0002",
            productName: "Invented split rice",
            quantity: 1,
            unitPrice: 17,
            itemTotal: 17,
          },
        ],
        adjustments: [
          {
            adjustmentIndex: 0,
            amount: 2,
            extractionSource: "amazon-now-bill-summary",
          },
        ],
      });
      expect(
        await page.locator("#split-action").getAttribute("data-clicked"),
      ).toBe("yes");
      expect(
        await page.locator("#split-action").getAttribute("data-clicks"),
      ).toBe("1");
      expect(JSON.stringify(saved)).not.toMatch(
        /sourceItems|splitScope|voucher|Delivery [12]/,
      );
      expect(await readdir(directory)).toEqual(["orders.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each([
    "nested",
    "deep",
    "split label",
    "annotation image",
    "ordinary action",
    "nested You pay",
  ])(
    "bill declaration ownership accepts proven composites: %s",
    async (mode) => {
      const mutation = {
        nested: "",
        deep: `const inner=document.querySelector('#nested-inner');for(let i=0;i<20;i++){const wrap=document.createElement('div');while(inner.firstChild)wrap.append(inner.firstChild);inner.append(wrap)}`,
        "split label": `document.querySelector('#nested-items-total').innerHTML='<span>Items <b>total</b></span><span>₹28.00</span>'`,
        "annotation image": `document.querySelector('#nested-annotation svg').outerHTML='<img alt="Fictional membership mark" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">'`,
        "ordinary action": `document.querySelector('#split-action').textContent='View order details'`,
        "nested You pay": `document.querySelector('#nested-outer').prepend(document.querySelector('#nested-you-pay'))`,
      }[mode];
      html =
        nestedDeclarations +
        `<script>${mutation};document.currentScript.remove()</script>`;
      const detail = await extractNowOrder(
        page,
        id,
        outer,
        async () => {},
        undefined,
        { amount: 30, currency: "INR" },
      );
      expect(detail.items.map((item) => item.productName)).toEqual([
        "Invented split lentils",
        "Invented split rice",
      ]);
      expect(detail.items.map((item) => item.quantity)).toEqual([1, 1]);
      expect(detail.items.map((item) => item.itemTotal.amount)).toEqual([
        11, 17,
      ]);
      expect(detail.orderTotal?.amount).toBe(30);
      expect(
        detail.adjustments.map((adjustment) => adjustment.amount?.amount),
      ).toEqual([2]);
      expect(
        await page.locator("#split-action").getAttribute("data-clicks"),
      ).toBe("1");
      // Verify that the invented fixture actually exercises the old overcount.
      const evidence = await page.locator("#split-bill").evaluate((bill) => {
        const raw = (el: Element): string =>
          el.textContent?.replace(/\s+/g, " ").trim() ?? "";
        const nodes = [bill, ...Array.from(bill.querySelectorAll("*"))];
        return {
          matches: nodes.filter(
            (el) =>
              /^Items total\b/i.test(raw(el)) &&
              !Array.from(el.children).some((child) => raw(child) === raw(el)),
          ).length,
          hasIcon: !!bill.querySelector("img, svg"),
        };
      });
      expect(evidence).toEqual({
        matches: mode === "split label" ? 5 : mode === "nested You pay" ? 3 : 4,
        hasIcon: true,
      });
      const saved = createExportDocument(
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
      expect(saved.orders[0].items.map((item) => item.lineIndex)).toEqual([
        0, 1,
      ]);
    },
  );

  const billOwnershipFailures: Array<[string, string]> = [
    [
      "hidden fee label without amount",
      `document.querySelector('#nested-inner').insertAdjacentHTML('beforeend','<div hidden>Handling fee</div>')`,
    ],
    [
      "historical fragmented discount label without amount",
      `document.querySelector('#nested-inner').insertAdjacentHTML('beforeend','<s><span>Dis</span><span>count</span></s>')`,
    ],
    [
      "unspaced fragmented dialog label",
      `document.querySelector('#split-sheet').insertAdjacentHTML('beforeend','<span>Items</span><span>total</span>')`,
    ],
    [
      "hidden unspaced fragmented dialog label",
      `document.querySelector('#split-sheet').insertAdjacentHTML('beforeend','<div hidden><span>Items</span><span>total</span></div>')`,
    ],
    [
      "historical unspaced fragmented dialog label",
      `document.querySelector('#split-sheet').insertAdjacentHTML('beforeend','<s><span>Items</span><span>total</span></s>')`,
    ],
    [
      "independent ancestor prefix",
      `document.querySelector('#nested-inner').prepend('Items total ₹28.00')`,
    ],
    [
      "independent ancestor suffix",
      `document.querySelector('#nested-inner').append('Items total ₹28.00')`,
    ],
    [
      "fragmented ancestor suffix",
      `document.querySelector('#nested-inner').insertAdjacentHTML('beforeend','Items <b>total</b> ₹28.00')`,
    ],
    [
      "direct dialog suffix",
      `document.querySelector('#split-sheet').append('Items total ₹28.00')`,
    ],
    [
      "fragmented dialog suffix",
      `document.querySelector('#split-sheet').insertAdjacentHTML('beforeend','Items <b>total</b> ₹28.00')`,
    ],
    [
      "duplicate bill row",
      `document.querySelector('#nested-inner').append(document.querySelector('#nested-items-total').cloneNode(true))`,
    ],
    [
      "hidden duplicate",
      `document.querySelector('#nested-inner').insertAdjacentHTML('beforeend','<div hidden>Items total ₹28.00</div>')`,
    ],
    [
      "historical duplicate",
      `document.querySelector('#nested-inner').insertAdjacentHTML('beforeend','<s>Items total ₹28.00</s>')`,
    ],
    [
      "hidden ancestor prefix",
      `document.querySelector('#nested-inner').insertAdjacentHTML('afterbegin','<span hidden>Items total ₹28.00</span>')`,
    ],
    [
      "historical ancestor suffix",
      `document.querySelector('#nested-inner').insertAdjacentHTML('beforeend','<span style="text-decoration:line-through">Items total ₹28.00</span>')`,
    ],
    [
      "noncurrent sole declaration",
      `document.querySelector('#nested-items-total').hidden=true`,
    ],
    [
      "conflicting declaration",
      `document.querySelector('#nested-inner').insertAdjacentHTML('beforeend','<div>Items total ₹29.00</div>')`,
    ],
    [
      "wrong Items total",
      `document.querySelector('#nested-items-total span').textContent='₹29.00'`,
    ],
    [
      "wrong You pay",
      `document.querySelector('#nested-you-pay span').textContent='₹31.00'`,
    ],
    [
      "duplicate You pay",
      `document.querySelector('#nested-outer').append('You pay ₹30.00')`,
    ],
    [
      "hidden You pay",
      `document.querySelector('#nested-outer').insertAdjacentHTML('beforeend','<span hidden>You pay ₹30.00</span>')`,
    ],
    [
      "second bill",
      `document.querySelector('#split-sheet').append(document.querySelector('#split-bill').cloneNode(true))`,
    ],
    [
      "hidden second bill",
      `const bill=document.querySelector('#split-bill').cloneNode(true);bill.hidden=true;document.querySelector('#split-sheet').append(bill)`,
    ],
    [
      "hidden second heading",
      `document.querySelector('#split-bill').insertAdjacentHTML('beforeend','<h2 hidden>Bill summary</h2>')`,
    ],
    [
      "wrong bill order",
      `document.querySelector('#split-bill').setAttribute('data-order-id','111-2222222-4444444')`,
    ],
    [
      "bill contains genuine merchandise",
      `document.querySelector('#split-bill').append(document.querySelector('#split-items'))`,
    ],
    [
      "bill row contains genuine merchandise",
      `document.querySelector('#nested-items-total').append(document.querySelector('#split-row-1'))`,
    ],
    [
      "merchandise boundary wraps bill",
      `const row=document.createElement('article');document.querySelector('#split-bill').before(row);row.append(document.querySelector('#split-bill'))`,
    ],
    [
      "incomplete semantic item",
      `document.querySelector('#split-bill').insertAdjacentHTML('beforeend','<article></article>')`,
    ],
    [
      "list boundary in bill",
      `document.querySelector('#split-bill').insertAdjacentHTML('beforeend','<div role="listitem"></div>')`,
    ],
    [
      "product image inside financial row",
      `document.querySelector('#nested-items-total').append(document.querySelector('#split-row-1 img').cloneNode(true))`,
    ],
    [
      "presentation product image",
      `const img=document.querySelector('#split-row-1 img').cloneNode(true);img.setAttribute('role','presentation');document.querySelector('#nested-items-total').append(img)`,
    ],
    [
      "hidden product image",
      `const img=document.querySelector('#split-row-1 img').cloneNode(true);img.hidden=true;document.querySelector('#nested-items-total').append(img)`,
    ],
    [
      "product link in financial row",
      `document.querySelector('#nested-items-total').insertAdjacentHTML('beforeend','<a href="/dp/B0SPLT0001"></a>')`,
    ],
    [
      "quantity in financial row",
      `document.querySelector('#nested-items-total').insertAdjacentHTML('beforeend','<span>Qty: 1</span>')`,
    ],
    [
      "unowned non-ASIN image",
      `document.querySelector('#nested-you-pay').insertAdjacentHTML('beforeend','<img alt="Fictional unexplained icon">')`,
    ],
    [
      "annotation has product identifier",
      `document.querySelector('#nested-annotation svg').outerHTML='<img alt="B0SPLT0001">'`,
    ],
    [
      "annotation contains control",
      `document.querySelector('#nested-annotation').insertAdjacentHTML('beforeend','<button></button>')`,
    ],
    [
      "annotation has second icon",
      `document.querySelector('#nested-annotation').append(document.querySelector('#nested-annotation svg').cloneNode(true))`,
    ],
    [
      "annotation hidden extra text",
      `document.querySelector('#nested-annotation').insertAdjacentHTML('beforeend','<span hidden>Invented hidden fact</span>')`,
    ],
    [
      "duplicate signed adjustment",
      `document.querySelector('#nested-inner').insertAdjacentHTML('beforeend','<div>Handling fee ₹2.00</div>')`,
    ],
  ];
  test.each(billOwnershipFailures)(
    "bill declaration ownership rejects %s and preserves prior JSON",
    async (_name, mutation) => {
      html =
        nestedDeclarations +
        `<script>${mutation};document.currentScript.remove()</script>`;
      listHtml = list.replace("₹230.00", "₹30.00");
      jest
        .spyOn(chromium, "launchPersistentContext")
        .mockResolvedValue(context);
      const directory = await makeTestDirectory("now-bill-ownership-");
      const output = join(directory, "orders.json");
      await writeFile(output, "previous complete export");
      try {
        await expect(
          runExport({ ...options, output }, () => {}, {
            list: listOrders,
            extract: extractOrderItems,
            write: validateAndWriteExport,
            report: async () => {},
            cleanup: async () => {},
          }),
        ).rejects.toThrow();
        expect(await readFile(output, "utf8")).toBe("previous complete export");
        expect(await readdir(directory)).toEqual(["orders.json"]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  const secondId = "111-2222222-4444444";
  const prepareShared = async (mutation = ""): Promise<void> => {
    listHtml =
      list.replace("₹230.00", "₹69.00") +
      list.replaceAll(id, secondId).replace("₹230.00", "₹14.00");
    await context.route("**/uff/**", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<script>location.replace(${JSON.stringify(tracking.replace(id, new URL(route.request().url()).searchParams.get("orderID")!))})</script>`,
      }),
    );
    await context.route("**/tez/**", (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body:
          sharedTracking +
          (mutation
            ? `<script>${mutation};document.currentScript.remove()</script>`
            : ""),
      }),
    );
    jest.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context);
  };
  test("shared tracking links select and publish seven-line and one-line orders independently", async () => {
    await prepareShared();
    const listed = await listOrders(
      options.startDate,
      options.endDate,
      options.maxOrders,
    );
    expect(listed.orders.map((order) => order.orderId)).toEqual([id, secondId]);
    const combined = [];
    for (const [index, summary] of listed.orders.entries()) {
      const detail = await extractOrderItems(
        summary.orderId,
        undefined,
        summary,
      );
      expect(detail.orderId).toBe(summary.orderId);
      expect(detail.items).toHaveLength(index ? 1 : 7);
      expect(detail.orderTotal?.amount).toBe(index ? 14 : 69);
      expect(await page.locator(`#panel-${index + 1}`).isVisible()).toBe(true);
      expect(
        await page.evaluate(() => ({
          tabs: (window as unknown as { tabClicks: number }).tabClicks,
          details: (window as unknown as { detailClicks: number }).detailClicks,
        })),
      ).toEqual({ tabs: 0, details: 1 });
      combined.push({ summary, detail });
    }
    const directory = await makeTestDirectory("now-shared-complete-");
    try {
      const output = join(directory, "orders.json");
      await validateAndWriteExport(
        output,
        options,
        1,
        combined,
        new Date().toISOString(),
      );
      const saved = JSON.parse(await readFile(output, "utf8"));
      expect(
        saved.orders.map((order: { orderId: string }) => order.orderId),
      ).toEqual([id, secondId]);
      expect(
        saved.orders.map((order: { orderTotal: number }) => order.orderTotal),
      ).toEqual([69, 14]);
      expect(
        saved.orders[0].items.map(
          (item: { lineIndex: number }) => item.lineIndex,
        ),
      ).toEqual([0, 1, 2, 3, 4, 5, 6]);
      expect(saved.orders[1].items).toEqual([
        expect.objectContaining({
          lineIndex: 0,
          asin: "B0SHRD0008",
          productName: "Fictional shared order two item",
          quantity: 1,
          unitPrice: 13,
          itemTotal: 13,
        }),
      ]);
      expect(
        saved.orders[0].items.map((item: { asin: string }) => item.asin),
      ).toEqual(Array.from({ length: 7 }, (_, i) => `B0SHRD000${i + 1}`));
      expect(JSON.stringify(saved)).not.toMatch(
        /declaredItemCount|actionProof|tabClicks/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  test.each([
    "wrongTab",
    "wrongSummary",
    "wrongDialog",
    "borrowedItem",
    "borrowedBill",
    "missingCount",
    "conflictingCount",
    "incomplete",
    "duplicateItem",
    "mixedOrders",
    "competingControls",
    "navigation",
    "duplicateOrder",
  ])(
    "shared tracking rejects %s and preserves prior complete JSON",
    async (mode) => {
      const mutations: Record<string, string> = {
        wrongTab: "selectOrder(1)",
        wrongSummary:
          "document.querySelector('#shared-owner-1 span').textContent=ids[1]",
        wrongDialog:
          "window.openDetails=()=>{detailClicks++;const sheet=document.querySelector('#shared-sheet');sheet.innerHTML=details[ids[1]];sheet.hidden=false}",
        borrowedItem:
          "const open=openDetails;window.openDetails=id=>{open(id);document.querySelector('#shared-items article').setAttribute('data-order-id',ids[1])}",
        borrowedBill:
          "const open=openDetails;window.openDetails=id=>{open(id);document.querySelector('#shared-bill').outerHTML=new DOMParser().parseFromString(details[ids[1]],'text/html').querySelector('#shared-bill').outerHTML}",
        missingCount:
          "const open=openDetails;window.openDetails=id=>{open(id);document.querySelector('#shared-count').remove()}",
        conflictingCount:
          "const open=openDetails;window.openDetails=id=>{open(id);document.querySelector('#shared-count').textContent='1 item'}",
        incomplete:
          "const open=openDetails;window.openDetails=id=>{open(id);document.querySelector('#shared-items article').remove()}",
        duplicateItem:
          "const open=openDetails;window.openDetails=id=>{open(id);const rows=document.querySelectorAll('#shared-items article');rows[1].replaceWith(rows[0].cloneNode(true))}",
        mixedOrders:
          "const open=openDetails;window.openDetails=id=>{open(id);document.querySelector('#shared-sheet').insertAdjacentHTML('beforeend',details[ids[1]])}",
        competingControls: "document.querySelector('#panel-2').hidden=false",
        navigation:
          "history.replaceState({},'',location.href.replace(ids[0],ids[1]))",
      };
      await prepareShared(mutations[mode] ?? "");
      const directory = await makeTestDirectory("now-shared-failure-");
      const output = join(directory, "orders.json");
      await writeFile(output, "previous complete export");
      const listDependency: typeof listOrders = async (...args) => {
        const result = await listOrders(...args);
        if (mode === "duplicateOrder") result.orders.push(result.orders[0]);
        return result;
      };
      try {
        await expect(
          runExport({ ...options, output }, () => {}, {
            list: listDependency,
            extract: extractOrderItems,
            write: validateAndWriteExport,
            report: async () => {},
            cleanup: async () => {},
          }),
        ).rejects.toThrow();
        expect(await readFile(output, "utf8")).toBe("previous complete export");
        expect(await readdir(directory)).toEqual(["orders.json"]);
        expect(
          await page.evaluate(
            () => (window as unknown as { tabClicks: number }).tabClicks,
          ),
        ).toBe(0);
        if (
          [
            "wrongTab",
            "wrongSummary",
            "competingControls",
            "navigation",
          ].includes(mode)
        )
          expect(
            await page.evaluate(
              () =>
                (window as unknown as { detailClicks: number }).detailClicks,
            ),
          ).toBe(0);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test.each([
    ["7 items", "1 items"],
    ["7 items in order", "1 item in order"],
    ["7 item in order", "1 items in order"],
    [" \n7\titems\u00a0in\norder ", " 1\titem "],
  ])(
    "count-label formats %j / %j preserve separate shared orders",
    async (first, second) => {
      const labels = JSON.stringify([first, second]);
      await prepareShared(
        `const open=openDetails;window.openDetails=id=>{open(id);document.querySelector('#shared-count').textContent=${labels}[id===ids[0]?0:1]}`,
      );
      const listed = await listOrders(
        options.startDate,
        options.endDate,
        options.maxOrders,
      );
      const combined = [];
      for (const [index, summary] of listed.orders.entries()) {
        const detail = await extractOrderItems(
          summary.orderId,
          undefined,
          summary,
        );
        expect(detail.items).toHaveLength(index ? 1 : 7);
        expect(detail.orderTotal?.amount).toBe(index ? 14 : 69);
        expect(
          await page.evaluate(
            () => (window as unknown as { tabClicks: number }).tabClicks,
          ),
        ).toBe(0);
        combined.push({ summary, detail });
      }
      const saved = createExportDocument(
        options,
        1,
        combined,
        new Date().toISOString(),
      );
      expect(saved.orders.map((order) => order.orderId)).toEqual([
        id,
        secondId,
      ]);
      expect(
        saved.orders.map((order) => order.items.map((item) => item.lineIndex)),
      ).toEqual([[0, 1, 2, 3, 4, 5, 6], [0]]);
    },
  );

  const countLabelFailures: Array<[string, string]> = [
    ["missing", "document.querySelector('#split-count').remove()"],
    [
      "identical duplicates",
      "document.querySelector('#split-count').after(document.querySelector('#split-count').cloneNode(true))",
    ],
    [
      "mixed old and new",
      "document.querySelector('#split-count').insertAdjacentHTML('afterend','<p>2 items</p>')",
    ],
    ["hidden", "document.querySelector('#split-count').hidden=true"],
    [
      "historical",
      "document.querySelector('#split-count').style.textDecoration='line-through'",
    ],
    [
      "hidden conflicting old",
      "document.querySelector('#split-count').insertAdjacentHTML('afterend','<p hidden>1 item</p>')",
    ],
    [
      "hidden conflicting new",
      "document.querySelector('#split-count').insertAdjacentHTML('afterend','<p hidden>1 item in order</p>')",
    ],
    ...[
      "02 items in order",
      "0 items in order",
      "-2 items in order",
      "2.0 items in order",
      "2e0 items in order",
      "101 items in order",
      `${"9".repeat(310)} items in order`,
      "2 items in delivery",
      "2 items in order today",
    ].map((label): [string, string] => [
      label,
      `document.querySelector('#split-count').textContent=${JSON.stringify(label)}`,
    ]),
    [
      "malformed duplicate",
      "document.querySelector('#split-count').insertAdjacentHTML('afterend','<p>-2 items in order</p>')",
    ],
    [
      "unsupported-suffix duplicate",
      "document.querySelector('#split-count').insertAdjacentHTML('afterend','<p>2 items in delivery</p>')",
    ],
    [
      "merchandise name cannot supply count",
      "document.querySelector('#split-count').remove();document.querySelector('#split-row-1 > span').textContent='2 items in order'",
    ],
    [
      "control cannot supply count",
      "document.querySelector('#split-count').innerHTML='<button>2 items in order</button>'",
    ],
    [
      "tracking tab cannot supply count",
      "document.querySelector('#split-count').remove();document.querySelector('main').insertAdjacentHTML('beforeend','<div role=tab>2 items in order</div>')",
    ],
    [
      "line mismatch",
      "document.querySelector('#split-count').textContent='1 item in order'",
    ],
    [
      "unit-sum mismatch",
      "const row=document.querySelector('#split-row-1');row.querySelectorAll('span')[1].textContent='Qty: 2';row.querySelectorAll('span')[2].outerHTML='<div>Unit price: ₹5.50</div><div>Line total: ₹11.00</div>'",
    ],
    [
      "wrong-order dialog",
      "document.querySelector('#split-sheet b').nextElementSibling.textContent='111-2222222-4444444'",
    ],
    [
      "hidden conflicting identity",
      "document.querySelector('#split-sheet').insertAdjacentHTML('beforeend','<span hidden>111-2222222-4444444</span>')",
    ],
    [
      "incomplete merchandise",
      "document.querySelector('#split-row-2').remove()",
    ],
    [
      "financial mismatch",
      "document.querySelector('#split-bill > div:last-child span').textContent='₹31.00'",
    ],
  ];
  test.each(countLabelFailures)(
    "count-label extraction rejects %s and preserves prior JSON",
    async (_name, mutation) => {
      html = alterSplit(
        `document.querySelector('#split-count').textContent='2 items in order';${mutation}`,
      );
      listHtml = list.replace("₹230.00", "₹30.00");
      jest
        .spyOn(chromium, "launchPersistentContext")
        .mockResolvedValue(context);
      const directory = await makeTestDirectory("now-count-label-");
      const output = join(directory, "orders.json");
      await writeFile(output, "previous complete export");
      try {
        await expect(
          runExport({ ...options, output }, () => {}, {
            list: listOrders,
            extract: extractOrderItems,
            write: validateAndWriteExport,
            report: async () => {},
            cleanup: async () => {},
          }),
        ).rejects.toThrow();
        expect(await readFile(output, "utf8")).toBe("previous complete export");
        expect(await readdir(directory)).toEqual(["orders.json"]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test("delayed source-owned View details is awaited before ownership validation", async () => {
    html = alterSplit(
      `const action=document.querySelector('#split-action');action.remove();setTimeout(()=>document.querySelector('#split-id').after(action),300)`,
    );
    const detail = await extractNowOrder(
      page,
      id,
      outer,
      async () => {},
      undefined,
      { amount: 30, currency: "INR" },
    );
    expect(detail.items).toHaveLength(2);
    expect(
      await page.locator("#split-action").getAttribute("data-clicks"),
    ).toBe("1");
  });

  const splitFailures: Array<[string, string, boolean]> = [
    [
      "historical source identity",
      `document.querySelector('#split-id span').style.textDecoration='line-through'`,
      false,
    ],
    [
      "hidden conflicting source identity",
      `document.querySelector('#split-owner').insertAdjacentHTML('beforeend','<span hidden>111-2222222-4444444</span>')`,
      false,
    ],
    [
      "historical dialog identity",
      `document.querySelector('#split-sheet b').nextElementSibling.style.textDecoration='line-through'`,
      true,
    ],
    ...[2, 3].map((count): [string, string, boolean] => [
      `ambiguous line-versus-unit count ${count}`,
      `document.querySelector('#split-count').textContent='${count} items';const row=document.querySelector('#split-row-1');row.querySelectorAll('span')[1].textContent='Qty: 2';row.querySelectorAll('span')[2].outerHTML='<div>Unit price: ₹5.50</div><div>Line total: ₹11.00</div>'`,
      true,
    ]),
    [
      "missing item count",
      `document.querySelector('#split-count').remove()`,
      true,
    ],
    [
      "borrowed merchandise owner",
      `document.querySelector('#split-row-1').setAttribute('data-order-id','111-2222222-4444444')`,
      true,
    ],
    [
      "incomplete semantic row",
      `document.querySelector('#split-items').insertAdjacentHTML('beforeend','<article>Unverified invented merchandise</article>')`,
      true,
    ],
    [
      "contradicting item count",
      `document.querySelector('#split-count').textContent='3 items'`,
      true,
    ],
    [
      "hidden item count",
      `document.querySelector('#split-count').hidden=true`,
      true,
    ],
    [
      "duplicate item count",
      `document.querySelector('#split-count').after(document.querySelector('#split-count').cloneNode(true))`,
      true,
    ],
    [
      "noncanonical item count",
      `document.querySelector('#split-count').textContent='02 items'`,
      true,
    ],
    [
      "nested source ancestors",
      `const main=document.querySelector('main');main.innerHTML='<div class="order-card"><div class="order-card">'+main.innerHTML+'</div></div>'`,
      false,
    ],
    [
      "hidden extra dialog row",
      `const row=document.querySelector('#split-row-2').cloneNode(true);row.hidden=true;document.querySelector('#split-items').append(row)`,
      true,
    ],
    [
      "hidden unowned dialog quantity",
      `document.querySelector('#split-items').insertAdjacentHTML('beforeend','<span hidden>Qty: 1</span>')`,
      true,
    ],
    ["listed total mismatch alone", "", true],
    [
      "duplicate plural fee",
      `document.querySelector('#split-bill').insertAdjacentHTML('beforeend','<div>Delivery fees Free</div>')`,
      true,
    ],
    [
      "hidden extra identity label",
      `document.querySelector('#split-sheet').insertAdjacentHTML('beforeend','<b hidden>Order ID</b>')`,
      true,
    ],
    [
      "hidden conflicting dialog owner",
      `document.querySelector('#split-sheet').insertAdjacentHTML('beforeend','<span hidden data-order-id="111-2222222-4444444"></span>')`,
      true,
    ],
    [
      "other order owns action",
      `document.querySelector('#split-id span').textContent='111-2222222-4444444'`,
      false,
    ],
    [
      "conflicting source identity",
      `document.querySelector('#split-id').insertAdjacentHTML('beforeend','<span>111-2222222-4444444</span>')`,
      false,
    ],
    [
      "hidden source identity",
      `document.querySelector('#split-id span').hidden=true`,
      false,
    ],
    [
      "missing source identity",
      `document.querySelector('#split-id span').remove()`,
      false,
    ],
    [
      "hidden action",
      `document.querySelector('#split-action').hidden=true`,
      false,
    ],
    [
      "accessible-hidden action",
      `document.querySelector('#split-action').setAttribute('aria-hidden','true')`,
      false,
    ],
    [
      "nonbutton action",
      `document.querySelector('#split-action').outerHTML='<a id="split-action">View details</a>'`,
      false,
    ],
    [
      "oversized common container",
      `document.querySelector('#split-owner').append('x'.repeat(501))`,
      false,
    ],
    [
      "page-wide common container",
      `document.querySelector('#split-owner').outerHTML=document.querySelector('#split-owner').innerHTML`,
      false,
    ],
    [
      "deep unowned action",
      `document.querySelector('#split-action').outerHTML='<div><div><div><div><div>'+document.querySelector('#split-action').outerHTML+'</div></div></div></div></div>'`,
      false,
    ],
    [
      "duplicate actions",
      `document.querySelector('#split-owner').append(document.querySelector('#split-action').cloneNode(true))`,
      false,
    ],
    [
      "competing old action",
      `document.querySelector('#split-owner').insertAdjacentHTML('beforeend','<button>View order details</button>')`,
      false,
    ],
    [
      "hidden duplicate action",
      `const clone=document.querySelector('#split-action').cloneNode(true);clone.hidden=true;document.querySelector('#split-owner').append(clone)`,
      false,
    ],
    [
      "nested delivery card",
      `document.querySelector('#split-owner').insertAdjacentHTML('beforeend','<div data-order-id="111-2222222-4444444"></div>')`,
      false,
    ],
    [
      "ambiguous competing cards",
      `const clone=document.querySelector('#split-owner').cloneNode(true);document.querySelector('main').append(clone)`,
      false,
    ],
    [
      "preexisting dialog",
      `document.querySelector('#split-sheet').hidden=false`,
      false,
    ],
    [
      "wrong-order dialog",
      `document.querySelector('#split-sheet b').nextElementSibling.textContent='111-2222222-4444444'`,
      true,
    ],
    [
      "hidden duplicate dialog identity",
      `document.querySelector('#split-sheet').insertAdjacentHTML('beforeend','<span hidden>111-2222222-3333333</span>')`,
      true,
    ],
    [
      "hidden wrong dialog identity",
      `document.querySelector('#split-sheet').insertAdjacentHTML('beforeend','<span hidden>111-2222222-4444444</span>')`,
      true,
    ],
    [
      "hidden dialog identity",
      `document.querySelector('#split-sheet b').nextElementSibling.hidden=true`,
      true,
    ],
    [
      "non-dialog view",
      `document.querySelector('#split-sheet').removeAttribute('role')`,
      true,
    ],
    [
      "duplicate dialog",
      `document.querySelector('#split-action').onclick=()=>{const sheet=document.querySelector('#split-sheet');sheet.hidden=false;document.body.append(sheet.cloneNode(true));document.querySelector('#split-action').dataset.clicked='yes'}`,
      true,
    ],
    [
      "missing dialog merchandise",
      `document.querySelector('#split-row-2').remove()`,
      true,
    ],
    [
      "duplicate dialog merchandise",
      `document.querySelector('#split-items').append(document.querySelector('#split-row-1').cloneNode(true))`,
      true,
    ],
    [
      "delivery segment reconciles but disagrees with list",
      `document.querySelector('#split-row-2').remove();document.querySelector('#split-bill').innerHTML='<h2>Bill summary</h2><div>Items total ₹11.00</div><div>You pay ₹11.00</div>'`,
      true,
    ],
    [
      "hidden Items total",
      `document.querySelector('#split-bill > div').hidden=true`,
      true,
    ],
    [
      "missing Items total",
      `document.querySelector('#split-bill > div').remove()`,
      true,
    ],
    [
      "wrong Items total",
      `document.querySelector('#split-bill > div span').textContent='₹11.00'`,
      true,
    ],
    [
      "duplicate Items total",
      `document.querySelector('#split-bill').append(document.querySelector('#split-bill > div').cloneNode(true))`,
      true,
    ],
    [
      "hidden conflicting Items total",
      `document.querySelector('#split-bill').insertAdjacentHTML('beforeend','<div hidden>Items total ₹11.00</div>')`,
      true,
    ],
    [
      "hidden You pay",
      `document.querySelector('#split-bill > div:last-child').hidden=true`,
      true,
    ],
    [
      "missing You pay",
      `document.querySelector('#split-bill > div:last-child').remove()`,
      true,
    ],
    [
      "hidden conflicting You pay",
      `document.querySelector('#split-bill').insertAdjacentHTML('beforeend','<div hidden>You pay ₹11.00</div>')`,
      true,
    ],
    [
      "duplicate financial fact",
      `document.querySelector('#split-bill').insertAdjacentHTML('beforeend','<div>Shipping fee Free</div>')`,
      true,
    ],
    [
      "unreconciled bill",
      `document.querySelector('#split-bill > div:last-child span').textContent='₹31.00'`,
      true,
    ],
    [
      "unsupported adjustment",
      `document.querySelector('#split-bill').insertAdjacentHTML('beforeend','<div>Refund ₹1.00</div>')`,
      true,
    ],
  ];
  test.each(splitFailures)(
    "split delivery rejects %s and preserves prior JSON",
    async (name, code, clicked) => {
      html = alterSplit(code);
      listHtml = list.replace(
        "₹230.00",
        name === "listed total mismatch alone" ? "₹31.00" : "₹30.00",
      );
      jest
        .spyOn(chromium, "launchPersistentContext")
        .mockResolvedValue(context);
      const directory = await makeTestDirectory("now-deliveries-failure-");
      const output = join(directory, "orders.json");
      await writeFile(output, "previous complete export");
      const reports: unknown[] = [];
      try {
        await expect(
          runExport({ ...options, output }, () => {}, {
            list: listOrders,
            extract: extractOrderItems,
            write: validateAndWriteExport,
            report: async (report) => {
              reports.push(report);
            },
            cleanup: async () => {},
          }),
        ).rejects.toThrow();
        expect(await readFile(output, "utf8")).toBe("previous complete export");
        expect(await readdir(directory)).toEqual(["orders.json"]);
        expect(
          await page
            .locator("#split-action")
            .first()
            .getAttribute("data-clicked"),
        ).toBe(clicked ? "yes" : null);
        expect(
          JSON.stringify(
            reports.map((report) => (report as { events: unknown[] }).events),
          ),
        ).not.toMatch(/Invented split|111-|₹|amazon\.in|<html/);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test.each(["valid", "wrongId", "invalidPath"])(
    "split click retains all committed navigation checks: %s",
    async (mode) => {
      const target =
        mode === "wrongId"
          ? tracking.replace(id, "111-2222222-4444444")
          : mode === "invalidPath"
            ? "https://www.amazon.in/unsupported-order-view"
            : tracking;
      html = alterSplit(
        `const action=document.querySelector('#split-action');const open=action.onclick;action.onclick=()=>{history.pushState({},'',${JSON.stringify(target)});history.pushState({},'',${JSON.stringify(tracking)});open.call(action)}`,
      );
      const invoke = (): ReturnType<typeof extractNowOrder> =>
        extractNowOrder(page, id, outer, async () => {}, undefined, {
          amount: 30,
          currency: "INR",
        });
      if (mode === "valid") {
        const detail = await invoke();
        expect(detail.items).toHaveLength(2);
      } else
        await expect(invoke()).rejects.toMatchObject({
          reason: "DETAIL_ORDER_MISMATCH",
        });
    },
  );

  test.each(["identity", "summary", "replacement", "navigation"])(
    "immediate split ownership revalidation rejects changed %s before clicking",
    async (mode) => {
      html = splitDelivery;
      const getByText = page.getByText.bind(page);
      jest.spyOn(page, "getByText").mockImplementation((text, options) => {
        const locator = getByText(text, options);
        // filter() returns a new locator, so intercept its result too.
        if (text instanceof RegExp && text.source === "^View details$") {
          const filter = locator.filter.bind(locator);
          jest.spyOn(locator, "filter").mockImplementation((options) => {
            const filtered = filter(options);
            const elementHandle = filtered.elementHandle.bind(filtered);
            jest
              .spyOn(filtered, "elementHandle")
              .mockImplementation(async (...args) => {
                const handle = await elementHandle(...args);
                const evaluate = handle!.evaluate.bind(handle!);
                let reads = 0;
                jest
                  .spyOn(handle!, "evaluate")
                  .mockImplementation(
                    async (...params: Parameters<typeof evaluate>) => {
                      if (++reads === 2)
                        await page.evaluate((mode) => {
                          if (mode === "navigation")
                            history.replaceState(
                              {},
                              "",
                              "?orderId=111-2222222-4444444",
                            );
                          if (mode === "identity")
                            document.querySelector(
                              "#split-id span",
                            )!.textContent = "111-2222222-4444444";
                          if (mode === "summary")
                            document
                              .querySelector("#split-owner")!
                              .append("Changed summary evidence");
                          if (mode === "replacement")
                            document
                              .querySelector("#split-action")!
                              .replaceWith(
                                document
                                  .querySelector("#split-action")!
                                  .cloneNode(true),
                              );
                        }, mode);
                      return evaluate(...params);
                    },
                  );
                return handle;
              });
            return filtered;
          });
        }
        return locator;
      });
      await expect(extract()).rejects.toThrow();
      expect(
        await page.locator("#split-action").getAttribute("data-clicked"),
      ).toBeNull();
    },
  );

  test("nested bill comparison fixture retains exact one-line derivation and atomic publication", async () => {
    html = nestedBillOrder;
    const detail = await extract();
    expect(detail).toMatchObject({
      itemCount: 1,
      orderTotalSource: "amazon-now-you-pay",
      orderTotal: { amount: 18.5 },
      adjustments: [],
    });
    expect(detail.items[0]).toMatchObject({
      productName: "Invented. single-line item",
      quantity: 2,
      unitPrice: { amount: 9.25, formatted: "Derived INR 9.25" },
      itemTotal: { amount: 18.5 },
    });
    jest.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context);
    const directory = await makeTestDirectory("now-nested-bill-complete-");
    const output = join(directory, "orders.json");
    try {
      await runExport({ ...options, output }, () => {}, {
        list: listOrders,
        extract: extractOrderItems,
        write: validateAndWriteExport,
        report: async () => {},
        cleanup: async () => {},
      });
      const saved = JSON.parse(await readFile(output, "utf8"));
      expect(saved.orders[0].items).toHaveLength(1);
      expect(saved.orders[0].items[0]).toMatchObject({
        lineIndex: 0,
        productName: "Invented. single-line item",
        quantity: 2,
        unitPrice: 9.25,
        itemTotal: 18.5,
      });
      expect(saved.orders[0].orderTotal).toBe(18.5);
      expect(await readdir(directory)).toEqual(["orders.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  test.each([
    ["direct child", nestedInBill(nestedReference(0))],
    ["five-parent boundary", nestedInBill(nestedReference(4))],
    ["changed old amount", nestedInBill(nestedReference(2, "₹99.99"))],
    [
      "nested text inside historical paragraph",
      nestedInBill(nestedReference(1, "<span>₹37.00</span>")),
    ],
    ["Items total owner", nestedInBill(nestedReference(2), "single-subtotal")],
    [
      "waived fee owner",
      singleLineOrder.replace("<s>₹3.00</s>", nestedReference(1, "₹3.00")),
    ],
    [
      "merchandise minimal current field",
      singleLineOrder.replace(
        "<span>₹18.50</span><s>₹37.00</s>",
        '<div><span>₹18.50</span><p style="text-decoration:line-through">₹37.00</p></div>',
      ),
    ],
  ])("nested bill comparison preserves %s", async (_name, fixture) => {
    html = fixture;
    expect((await extract()).items[0]).toMatchObject({
      quantity: 2,
      unitPrice: { amount: 9.25 },
      itemTotal: { amount: 18.5 },
    });
  });
  test.each(nestedBillCases)(
    "nested bill comparison rejects %s and preserves prior JSON",
    async (_name, fixture) => {
      expect(fixture).not.toBe(singleLineOrder);
      html = fixture;
      jest
        .spyOn(chromium, "launchPersistentContext")
        .mockResolvedValue(context);
      const directory = await makeTestDirectory("now-nested-bill-atomic-");
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
          /111-|Invented|B0SOLO|₹|18\.50|amazon\.in/,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test("verified single-line derivation publishes one product line with two units and exact derived price", async () => {
    html = singleLineOrder;
    listHtml = list.replace("230.00", "18.50");
    const detail = await extract();
    expect(detail).toMatchObject({
      itemCount: 1,
      orderTotal: { amount: 18.5 },
      orderTotalSource: "amazon-now-you-pay",
      extractionSource: "amazon-now-order-details",
      adjustments: [],
    });
    expect(detail.items).toEqual([
      {
        productName: "Invented. single-line item",
        asin: "B0SOLO0001",
        quantity: 2,
        itemTotal: { amount: 18.5, currency: "INR", formatted: "₹18.50" },
        unitPrice: {
          amount: 9.25,
          currency: "INR",
          formatted: "Derived INR 9.25",
        },
      },
    ]);
    jest.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context);
    const directory = await makeTestDirectory("now-single-complete-");
    const output = join(directory, "orders.json");
    try {
      await runExport({ ...options, output }, () => {}, {
        list: listOrders,
        extract: extractOrderItems,
        write: validateAndWriteExport,
        report: async () => {},
        cleanup: async () => {},
      });
      const saved = JSON.parse(await readFile(output, "utf8"));
      expect(saved.orders).toHaveLength(1);
      expect(saved.orders[0].items).toHaveLength(1);
      expect(saved.orders[0].items[0]).toMatchObject({
        lineIndex: 0,
        productName: "Invented. single-line item",
        quantity: 2,
        unitPrice: 9.25,
        itemTotal: 18.5,
      });
      expect(saved.orders[0].orderTotal).toBe(18.5);
      expect(JSON.stringify(saved)).not.toMatch(
        /singleLinePriceDomVerified|Derived INR/,
      );
      expect(await readdir(directory)).toEqual(["orders.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  test.each([
    [
      "bill comparisons",
      singleMutation(
        `document.querySelector('#single-subtotal').insertAdjacentHTML('beforeend','<s>₹37.00</s>'); document.querySelector('#single-you-pay').insertAdjacentHTML('beforeend','<s>₹37.00</s>');`,
      ),
    ],
    [
      "wrapped merchandise content",
      singleMutation(
        `const row=document.querySelector('#single-row'); const inner=document.createElement('div'); while(row.firstChild) inner.append(row.firstChild); row.append(inner);`,
      ),
    ],
    ["changed comparison", singleLineOrder.replace("₹37.00", "₹99.99")],
    [
      "DEL comparison",
      singleLineOrder.replace("<s>₹37.00</s>", "<del>₹37.00</del>"),
    ],
    [
      "CSS comparison",
      singleLineOrder.replace(
        "<s>₹37.00</s>",
        '<span style="text-decoration:line-through">₹37.00</span>',
      ),
    ],
    [
      "accessibility-hidden adjacent price",
      singleLineOrder.replace(
        '<div id="single-price"><span>₹18.50</span>',
        '<div id="single-price" aria-hidden="true"><span>₹</span><span>18.50</span>',
      ),
    ],
    [
      "visible adjacent price",
      singleLineOrder.replace(
        "<span>₹18.50</span><s>₹37.00",
        "<span>₹</span><span>18.50</span><s>₹37.00",
      ),
    ],
    [
      "zero charged fee",
      singleLineOrder.replace(
        "Handling fee <span>Free</span>",
        "Handling fee <span>₹0.00</span>",
      ),
    ],
  ])("verified single-line derivation retains %s", async (_name, fixture) => {
    html = fixture;
    expect((await extract()).items[0]).toMatchObject({
      quantity: 2,
      unitPrice: { amount: 9.25 },
      itemTotal: { amount: 18.5 },
    });
  });
  test.each([
    ["₹18.51", "3 units", 6.17],
    ["INR 1,200.00", "2 units", 600],
    ["₹0.06", "6 units", 0.01],
  ])(
    "verified single-line derivation divides %s by %s without rounding",
    async (price, quantity, amount) => {
      html = singleLineOrder
        .replaceAll("₹18.50", price)
        .replace("2 units", quantity);
      expect((await extract()).items[0].unitPrice?.amount).toBe(amount);
    },
  );
  test.each(["quantity one", "labelled multi-unit"])(
    "single-line normal path remains unchanged: %s",
    async (mode) => {
      html = singleLineOrder;
      if (mode === "quantity one") html = html.replace("2 units", "1 unit");
      else
        html += `<script>document.querySelector('#single-price').innerHTML='<div>Unit price: ₹9.25</div><div>Line total: ₹18.50</div>';</script>`;
      html += `<script>document.querySelector('#single-handling').innerHTML='Handling fee ₹1.00'; document.querySelector('#single-you-pay span').textContent='₹19.51';</script>`;
      const detail = await extract();
      expect(detail.items[0].unitPrice?.formatted).not.toContain("Derived");
      expect(detail.adjustments[0].amount?.amount).toBe(1);
      expect(detail.orderTotal.amount).toBe(19.51);
    },
  );
  test.each(singleLineCases)(
    "verified single-line derivation rejects %s and preserves prior JSON",
    async (_name, fixture) => {
      expect(fixture).not.toBe(singleLineOrder);
      html = fixture;
      jest
        .spyOn(chromium, "launchPersistentContext")
        .mockResolvedValue(context);
      const directory = await makeTestDirectory("now-single-atomic-");
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
          /111-|Invented|B0SOLO|₹|18\.50|amazon\.in/,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test("gram multipack fixture preserves all ten items, exact names, quantities, provenance and atomic output", async () => {
    html = gramOrder;
    listHtml = list.replace("230.00", "76.00");
    const detail = await extract();
    const names = Array.from({ length: 10 }, (_, i) =>
      i === 9
        ? "Invented. gram-pack item 10"
        : `Invented gram-pack item ${String(i + 1).padStart(2, "0")}`,
    );
    const prices = Array.from({ length: 10 }, (_, i) => i + 3);
    expect(detail.items.map((item) => item.productName)).toEqual(names);
    expect(detail.items.map((item) => item.quantity)).toEqual(
      Array(10).fill(1),
    );
    expect(detail.items.map((item) => item.asin)).toEqual(
      Array.from({ length: 10 }, (_, i) =>
        i === 2 ? "" : `B0GRAM${String(i + 1).padStart(4, "0")}`,
      ),
    );
    expect(detail.items.map((item) => item.unitPrice?.amount)).toEqual(prices);
    expect(detail.items.map((item) => item.itemTotal.amount)).toEqual(prices);
    expect(detail.adjustments.map((item) => item.amount?.amount)).toEqual([
      4, -3,
    ]);
    expect(detail).toMatchObject({
      itemCount: 10,
      orderTotal: { amount: 76 },
      orderTotalSource: "amazon-now-you-pay",
      extractionSource: "amazon-now-order-details",
    });
    jest.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context);
    const directory = await makeTestDirectory("now-grams-complete-");
    const output = join(directory, "orders.json");
    try {
      await runExport({ ...options, output }, () => {}, {
        list: listOrders,
        extract: extractOrderItems,
        write: validateAndWriteExport,
        report: async () => {},
        cleanup: async () => {},
      });
      const saved = JSON.parse(await readFile(output, "utf8"));
      expect(saved.orders).toHaveLength(1);
      expect(
        saved.orders[0].items.map(
          (item: { productName: string }) => item.productName,
        ),
      ).toEqual(names);
      expect(
        saved.orders[0].items.map(
          (item: { lineIndex: number }) => item.lineIndex,
        ),
      ).toEqual(Array.from({ length: 10 }, (_, i) => i));
      expect(saved.orders[0].orderTotal).toBe(76);
      expect(await readdir(directory)).toEqual(["orders.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  test.each([
    "Pack of 4, 3 g Each",
    "Pack of 9007199254740991, 0.125 g Each",
    "Pack of 1, 1.50 g Each",
    "Pack of 2, 9007199254740990 g Each",
  ])(
    "gram multipack metadata never supplies quantity: %s",
    async (descriptor) => {
      html = gramOrder.replace(gramDescriptor, descriptor);
      expect((await extract()).items[9]).toMatchObject({
        productName: "Invented. gram-pack item 10",
        quantity: 1,
        unitPrice: { amount: 12 },
        itemTotal: { amount: 12 },
      });
    },
  );
  test.each(["2 units", "Qty: 2", "Quantity: 2"])(
    "gram multipack uses independent unit and line prices for %s",
    async (quantity) => {
      html = gramOrder.replace(
        gramFields,
        pieceFields(gramDescriptor, ".", quantity),
      );
      html += `<script>document.querySelector('#grams-row-10 .price').innerHTML = '<div>Unit price: <span>₹</span><span>6.00</span></div><div>Line total: <span>₹</span><span>12.00</span></div>';</script>`;
      expect((await extract()).items[9]).toMatchObject({
        quantity: 2,
        unitPrice: { amount: 6 },
        itemTotal: { amount: 12 },
      });
    },
  );
  test.each(gramCases)(
    "gram multipack invalid %s preserves prior JSON",
    async (_name, fixture) => {
      expect(fixture).not.toBe(gramOrder);
      html = fixture;
      jest
        .spyOn(chromium, "launchPersistentContext")
        .mockResolvedValue(context);
      const directory = await makeTestDirectory("now-grams-atomic-");
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
          /111-|Invented|B0GRAM|Pack of|₹|76\.00|amazon\.in/,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test("piece packaging fixture exports all five exact names, purchased quantities and independent totals", async () => {
    html = pieceOrder;
    listHtml = list.replace("230.00", "81.00");
    const detail = await extract();
    const names = [
      "Invented piece-fixture item 01",
      "Invented piece-fixture item 02",
      "Invented piece-fixture item 03",
      "Invented. piece bundle 04",
      "Invented piece bundle 05",
    ];
    expect(detail.items.map((item) => item.productName)).toEqual(names);
    expect(detail.items.map((item) => item.quantity)).toEqual([1, 1, 1, 1, 1]);
    expect(detail.items.map((item) => item.asin)).toEqual([
      "B0PIEC0001",
      "B0PIEC0002",
      "",
      "B0PIEC0004",
      "B0PIEC0005",
    ]);
    expect(detail.items.map((item) => item.unitPrice?.amount)).toEqual([
      8, 12, 16, 20, 24,
    ]);
    expect(detail.items.map((item) => item.itemTotal.amount)).toEqual([
      8, 12, 16, 20, 24,
    ]);
    expect(detail.adjustments.map((entry) => entry.amount?.amount)).toEqual([
      3, -2,
    ]);
    expect(detail).toMatchObject({
      itemCount: 5,
      orderTotal: { amount: 81 },
      orderTotalSource: "amazon-now-you-pay",
      extractionSource: "amazon-now-order-details",
    });
    jest.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context);
    const directory = await makeTestDirectory("now-pieces-complete-");
    const output = join(directory, "orders.json");
    try {
      await runExport({ ...options, output }, () => {}, {
        list: listOrders,
        extract: extractOrderItems,
        write: validateAndWriteExport,
        report: async () => {},
        cleanup: async () => {},
      });
      const saved = JSON.parse(await readFile(output, "utf8"));
      expect(saved.orders).toHaveLength(1);
      expect(
        saved.orders[0].items.map(
          (item: { productName: string }) => item.productName,
        ),
      ).toEqual(names);
      expect(
        saved.orders[0].items.map(
          (item: { lineIndex: number }) => item.lineIndex,
        ),
      ).toEqual([0, 1, 2, 3, 4]);
      expect(saved.orders[0].orderTotal).toBe(81);
      expect(
        saved.orders[0].items.every(
          (item: { extractionSource: string }) =>
            item.extractionSource === "amazon-now-order-details",
        ),
      ).toBe(true);
      expect(await readdir(directory)).toEqual(["orders.json"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test.each([
    ["3 Pcs (Approx. 61-93 g)", "."],
    ["3 Pcs (Approx. 61–93 g)", "·"],
    ["3 Pcs (61-93 g)", "."],
    ["3 Pcs (61–93 g)", "·"],
    [
      "9007199254740991 Pcs (Approx. 0.1000000000000000001–0.1000000000000000002 g)",
      ".",
    ],
    ["3 Pcs (61.500 - 61.501 g)", "·"],
  ])(
    "piece packaging keeps purchased count for %s with %s",
    async (descriptor, separator) => {
      html = pieceOrder.replace(
        pieceFields(pieceApprox, "."),
        pieceFields(descriptor, separator),
      );
      expect((await extract()).items[3]).toMatchObject({
        productName: "Invented. piece bundle 04",
        quantity: 1,
        unitPrice: { amount: 20 },
        itemTotal: { amount: 20 },
      });
    },
  );

  test("piece packaging uses independently declared unit and line prices for multiple purchased units", async () => {
    html = pieceOrder.replace(
      pieceFields(piecePlain, "·"),
      pieceFields(piecePlain, "·", "2 units"),
    );
    html += `<script>document.querySelector('#pieces-row-5 .price').innerHTML = '<div>Unit price: <span>₹</span><span>12.00</span></div><div>Line total: <span>₹</span><span>24.00</span></div>';</script>`;
    expect((await extract()).items[4]).toMatchObject({
      productName: "Invented piece bundle 05",
      quantity: 2,
      unitPrice: { amount: 12 },
      itemTotal: { amount: 24 },
    });
  });

  test.each([
    [
      "missing product name",
      pieceOrder.replace("Invented. piece bundle 04", ""),
    ],
    [
      "descriptor-shaped ambiguous name",
      pieceOrder.replace("Invented. piece bundle 04", pieceApprox),
    ],
    [
      "unowned product image",
      pieceOrder.replace(
        "<h1>",
        '<img alt="B0PIEC0099" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="><h1>',
      ),
    ],
    [
      "missing price",
      pieceOrder +
        `<script>document.querySelector('#pieces-row-5 .price').remove();</script>`,
    ],
    [
      "conflicting identifier",
      pieceOrder +
        `<script>document.querySelector('#pieces-row-5').insertAdjacentHTML('beforeend', '<a href="/dp/B0PIEC0099"></a>');</script>`,
    ],
    [
      "invalid financial evidence",
      pieceOrder.replace("You pay ₹81.00", "You pay ₹81.02"),
    ],
    ...pieceCases,
  ])(
    "piece packaging invalid %s preserves prior JSON",
    async (_name, fixture) => {
      expect(fixture).not.toBe(pieceOrder);
      html = fixture;
      jest
        .spyOn(chromium, "launchPersistentContext")
        .mockResolvedValue(context);
      const directory = await makeTestDirectory("now-pieces-atomic-");
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
          /111-|Invented|B0PIEC|Pcs|₹|81\.00|amazon\.in/,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
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
    expect(detail.items.map((item) => item.unitPrice?.amount)).toEqual(
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
    const directory = await makeTestDirectory("now-tablet-complete-");
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
      const directory = await makeTestDirectory("now-tablet-atomic-");
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
      expect(detail.items[0].unitPrice?.amount).toBe(
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
      const directory = await makeTestDirectory("now-split-atomic-");
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
      const directory = await makeTestDirectory("now-icon-atomic-");
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
    const directory = await makeTestDirectory("now-approx-complete-");
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
      const directory = await makeTestDirectory("now-approx-atomic-");
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
      const directory = await makeTestDirectory("now-a11y-atomic-");
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
      const directory = await makeTestDirectory("now-ownership-report-");
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
    const directory = await makeTestDirectory("now-ownership-atomic-");
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
      // A legitimate UUID can contain "111-" inside a four-digit hex group.
      // Keep that case deterministic while still forbidding the full source ID.
      report.runId = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
      expect(report.events.at(-1)).toMatchObject({
        reason,
        orderIndex: 2,
        category: "validation",
      });
      const directory = await makeTestDirectory("now-dom-report-");
      try {
        await writeFailureReport(report, directory);
        const names = await readdir(directory);
        expect(names).toHaveLength(1);
        const saved = await readFile(join(directory, names[0]), "utf8");
        expect(JSON.parse(saved).failure.reason).toBe(reason);
        expect(saved + String(error)).not.toContain(id);
        expect(saved + String(error)).not.toMatch(
          /\b111-|Invented|₹|230\.00|https?:|<html>|invalid amount|Unknown charged fact/,
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

  test.each([
    ["invalid quantity", "NOW_PARSE_QUANTITY_INVALID"],
    ["missing name", "NOW_PARSE_NAME_MISSING"],
    ["duplicate name", "NOW_PARSE_NAME_DUPLICATE"],
    ["conflicting identifiers", "NOW_PARSE_IDENTIFIERS_CONFLICT"],
  ])(
    "parser attribution for %s retains terminal reason and atomic output",
    async (mode, reason) => {
      // Mutate only the fifth row of the invented 23-item fixture. Earlier rows
      // remain valid, proving the index is the rejected snapshot row, not zero.
      html += `<script>
      const row = document.querySelectorAll('.fixture-item')[4];
      const mode = ${JSON.stringify(mode)};
      if (mode === 'invalid quantity') row.querySelector('div').querySelector('div').textContent = 'Qty: 0';
      if (mode === 'missing name') row.querySelector('div > span').remove();
      if (mode === 'duplicate name') {
        const name = document.createElement('span');
        name.textContent = 'PRIVATE_EXTRA_NAME';
        row.querySelector('div').prepend(name);
      }
      if (mode === 'conflicting identifiers') {
        const link = document.createElement('a');
        link.href = '/dp/B0DIAG0002';
        row.append(link);
      }
    </script>`;
      const trace = new FailureDiagnostics();
      trace.select({ orderId: "not supplied", orderDate: "not supplied" }, 2);
      trace.provenance("amazon-now-order-details");
      const error = await extract(trace).catch((e: unknown) => e);
      expect(error).toMatchObject({
        stage: "items",
        reason: "ITEM_FACTS_INVALID",
      });
      const report = trace.report(error);
      expect(report).toMatchObject({
        lineIndex: 4,
        counts: { items: 0, adjustments: 0 },
        truncated: false,
      });
      expect(report.events.slice(-3)).toMatchObject([
        { reason: "NOW_PARSING" },
        { stage: "items", reason, lineIndex: 4, orderIndex: 2 },
        {
          stage: "items",
          reason: "ITEM_FACTS_INVALID",
          category: "validation",
        },
      ]);
      const directory = await makeTestDirectory("now-parser-pipeline-");
      const output = join(directory, "orders.json");
      const reports = join(directory, "reports");
      try {
        await writeFailureReport(report, join(directory, "sanitized"));
        const names = await readdir(join(directory, "sanitized"));
        const saved = await readFile(
          join(directory, "sanitized", names[0]),
          "utf8",
        );
        expect(JSON.parse(saved).lineIndex).toBe(4);
        expect(saved + String(error)).not.toMatch(
          /PRIVATE_|Invented|111-|B0TEST|B0DIAG|₹|10\.00|https?:|<html>|Qty:/,
        );
        await writeFile(output, "prior complete export");
        jest
          .spyOn(chromium, "launchPersistentContext")
          .mockResolvedValue(context);
        const logs: string[] = [];
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
              report: (failure) => writeFailureReport(failure, reports),
              cleanup: async () => {},
            },
          ),
        ).rejects.toMatchObject({
          stage: "items",
          reason: "ITEM_FACTS_INVALID",
        });
        expect(await readFile(output, "utf8")).toBe("prior complete export");
        expect((await readdir(directory)).sort()).toEqual([
          "orders.json",
          "reports",
          "sanitized",
        ]);
        const persisted = JSON.parse(
          await readFile(join(reports, (await readdir(reports))[0]), "utf8"),
        );
        expect(persisted).toMatchObject({
          failure: { reason: "ITEM_FACTS_INVALID" },
          lineIndex: 4,
          counts: { items: 0 },
        });
        expect(persisted.events).toContainEqual(
          expect.objectContaining({ reason, lineIndex: 4, orderIndex: 0 }),
        );
        expect(JSON.stringify(persisted.events) + logs.join(" ")).not.toMatch(
          /PRIVATE_|Invented|111-|B0TEST|B0DIAG|₹|10\.00|https?:|<html>|Qty:/,
        );
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  test.each(["missing", "duplicate"])(
    "%s DOM quantity remains an earlier ownership rejection",
    async (mode) => {
      html += `<script>
      const quantity = document.querySelectorAll('.fixture-item')[4].querySelector('div').querySelector('div');
      if (${JSON.stringify(mode)} === 'missing') quantity.remove();
      else quantity.insertAdjacentHTML('afterend', '<div>Quantity: 2</div>');
    </script>`;
      const trace = new FailureDiagnostics();
      const error = await extract(trace).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Error);
      expect(trace.report(error).failure.reason).not.toBe("ITEM_FACTS_INVALID");
      expect(
        trace
          .report(error)
          .events.some((event) => event.reason.startsWith("NOW_PARSE_")),
      ).toBe(false);
      expect(trace.report(error).lineIndex).toBeUndefined();
    },
  );

  test("integrated exporter persists the categorical checkpoint and preserves prior JSON", async () => {
    html = html.replace(
      "<h2>Bill summary</h2>",
      "<h2>Unsupported summary</h2>",
    );
    jest.spyOn(chromium, "launchPersistentContext").mockResolvedValue(context);
    const directory = await makeTestDirectory("now-diagnostic-pipeline-");
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
      const directory = await makeTestDirectory("now-compatibility-atomic-");
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
      const directory = await makeTestDirectory("now-presentation-atomic-");
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
      const directory = await makeTestDirectory("now-atomic-");
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
