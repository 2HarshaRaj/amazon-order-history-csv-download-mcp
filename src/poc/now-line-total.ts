/// <reference lib="dom" />
import type { Page } from "playwright";
import { z } from "zod";
import { getInvoiceUrl } from "../amazon/extractors/invoice";
import { DiagnosticError } from "./failure-diagnostics";

export const NOW_LINE_TOTAL_ONLY =
  "amazon-now-verified-line-total-only" as const;
const itemSchema = z
  .object({
    asin: z.string().regex(/^[A-Z0-9]{10}$/),
    quantity: z.number().int().positive().safe(),
    itemTotalPaise: z.number().int().nonnegative().safe(),
  })
  .strict();
export const printableProofSchema = z
  .object({
    source: z.literal("selected-order-printable-summary"),
    orderId: z.string().regex(/^\d{3}-\d{7}-\d{7}$/),
    items: z.array(itemSchema).min(1).max(100),
  })
  .strict();
export type NowPrintableProof = z.infer<typeof printableProofSchema>;
export type NowLineTotalItem = z.infer<typeof itemSchema>;

function reject(identity = false): never {
  throw new DiagnosticError(
    identity ? "detail" : "items",
    identity ? "DETAIL_ORDER_MISMATCH" : "ITEM_SHAPE_AMBIGUOUS",
    "Amazon Now printable line evidence could not be verified.",
  );
}

/** One exact decimal INR field. No float parsing, residuals or price derivation. */
export function nowLinePaise(value: string): number {
  const match =
    /^(?:₹\s*|INR\s+)((?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+|[1-9]\d?(?:,\d{2})*,\d{3})(?:\.\d{1,2})?)$/.exec(
      value,
    );
  if (!match) return reject();
  const [whole, fraction = ""] = match[1].replace(/,/g, "").split(".");
  const paise = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (paise > BigInt(Number.MAX_SAFE_INTEGER)) return reject();
  return Number(paise);
}

export function validateNowPrintableProof(
  input: unknown,
  orderId: string,
  expected: NowLineTotalItem[],
): NowPrintableProof {
  const parsed = printableProofSchema.safeParse(input);
  if (!parsed.success) return reject();
  const proof = parsed.data;
  if (proof.orderId !== orderId) return reject(true);
  if (
    proof.items.length !== expected.length ||
    new Set(proof.items.map((i) => i.asin)).size !== proof.items.length ||
    new Set(expected.map((i) => i.asin)).size !== expected.length
  )
    return reject();
  for (const item of expected) {
    const checked = itemSchema.safeParse(item);
    const observed = proof.items.find((i) => i.asin === item.asin);
    if (
      !checked.success ||
      !observed ||
      observed.quantity !== item.quantity ||
      observed.itemTotalPaise !== item.itemTotalPaise
    )
      return reject();
  }
  return proof;
}

/** Separate HTML source only; never reads scripts, invoice PDFs or payment data. */
export async function readNowPrintableProof(
  trackingPage: Page,
  orderId: string,
  expected: NowLineTotalItem[],
  authenticate: (page?: Page) => Promise<void>,
): Promise<NowPrintableProof> {
  if (!/^\d{3}-\d{7}-\d{7}$/.test(orderId)) return reject(true);
  const page = await trackingPage.context().newPage();
  let invalidNavigation = false,
    leaveForAuthentication = false;
  const validUrl = (value: string, final = false): boolean => {
    try {
      const u = new URL(value);
      const ids = [...u.searchParams].filter(([key]) => /^orderid$/i.test(key));
      return (
        u.protocol === "https:" &&
        ["www.amazon.in", "amazon.in"].includes(u.hostname) &&
        !u.port &&
        !u.username &&
        !u.password &&
        !u.hash &&
        ids.length === 1 &&
        ids[0][1] === orderId &&
        ((!final && u.pathname === "/gp/css/summary/print.html") ||
          /^\/uff\/your-account\/order-details\/printable(?:\/ref=[A-Za-z0-9_]+)?$/.test(
            u.pathname,
          ))
      );
    } catch {
      return false;
    }
  };
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    try {
      const u = new URL(frame.url());
      if (
        u.protocol === "https:" &&
        ["www.amazon.in", "amazon.in"].includes(u.hostname) &&
        /^\/ap\/(?:signin|cvf)(?:\/|$)/.test(u.pathname)
      )
        return;
      if (!validUrl(frame.url())) invalidNavigation = true;
    } catch {
      invalidNavigation = true;
    }
  });
  page.on("response", (response) => {
    if (
      response.request().isNavigationRequest() &&
      response.frame() === page.mainFrame() &&
      response.status() >= 400
    )
      invalidNavigation = true;
  });
  try {
    await page.goto(getInvoiceUrl(orderId, "amazon.in"), {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    await authenticate(page);
    await page.waitForURL(
      (url) =>
        validUrl(url.href, true) ||
        /^\/ap\/(?:signin|cvf)(?:\/|$)/.test(url.pathname),
      { timeout: 3000 },
    );
    await authenticate(page);
    if (invalidNavigation || !validUrl(page.url(), true)) return reject(true);
    await page
      .locator(".a-grid-vertical-align")
      .first()
      .waitFor({ state: "visible", timeout: 3000 });
    const result = await page.evaluate((expectedId) => {
      const norm = (el: Element): string =>
        (el.textContent ?? "").replace(/\s+/g, " ").trim();
      const active = (el: Element): boolean => {
        for (let n: Element | null = el; n; n = n.parentElement) {
          const s = getComputedStyle(n);
          if (
            n.hasAttribute("hidden") ||
            n.getAttribute("aria-hidden") === "true" ||
            ["S", "DEL", "STRIKE"].includes(n.tagName) ||
            s.display === "none" ||
            ["hidden", "collapse"].includes(s.visibility) ||
            s.opacity === "0" ||
            s.textDecorationLine.includes("line-through")
          )
            return false;
        }
        return el.getClientRects().length > 0;
      };
      const nodes = Array.from(document.querySelectorAll("*"));
      if (nodes.length > 5000) return null;
      // Inspect only explicit non-script labels. Print/screen duplicate headings
      // are allowed only when all copies name this same independently linked order.
      const identities = nodes.filter(
        (el) =>
          !el.children.length &&
          !el.closest("script,style,template") &&
          /^Order\s*(?:#|ID|number)\s*:/i.test(norm(el)),
      );
      if (
        !identities.length ||
        !identities.some(active) ||
        identities.some(
          (el) =>
            el.tagName !== "SPAN" || norm(el) !== `Order #: ${expectedId}`,
        )
      )
        return null;
      const grids = nodes.filter((el) =>
        el.matches("div.a-row.a-grid-vertical-align.a-grid-center"),
      );
      const headers = grids.filter((row) => {
        if (row.querySelector("script,style,template")) return false;
        const q = row.querySelector(":scope > .a-span1");
        const t = row.querySelector(":scope > .a-span2");
        return q && t && norm(q) === "Quantity" && norm(t) === "Total";
      });
      if (
        headers.length !== 1 ||
        !active(headers[0]) ||
        headers[0].children.length !== 4 ||
        headers[0].querySelector(
          "a,img,svg,button,input,select,textarea,[role=button]",
        )
      )
        return null;
      const header = headers[0];
      const links = nodes.filter((el) =>
        el.matches('a[href*="/dp/"],a[href*="/gp/product/"]'),
      );
      if (!links.length || links.length > 100) return null;
      const candidates = [
        ...new Set(
          links.map((el) =>
            el.closest("div.a-row.a-grid-vertical-align.a-grid-center"),
          ),
        ),
      ];
      if (candidates.some((row) => !row || row === header)) return null;
      const rows = candidates.filter((row): row is Element => row !== null);
      const scope = header.closest("div.ufpo-item-list-table");
      if (
        !scope ||
        document.querySelectorAll("div.ufpo-item-list-table").length !== 1 ||
        !rows.every((row) => scope.contains(row)) ||
        identities.some((el) => scope.contains(el))
      )
        return null;
      if (scope.querySelector("script,style,template")) return null;
      const coveredRoots: Element[] = [header, ...rows];
      const wrappers: Element[] = [];
      const facts: Array<{
        asin: string;
        quantity: number;
        amount: string;
        refundAmount?: string;
      }> = [];
      // Each actual printable row has a disjoint image column and a detail
      // column. Account for both, including the header's empty image column.
      for (const row of [header, ...rows]) {
        const detail = row.parentElement,
          wrapper = detail?.parentElement;
        if (
          !detail ||
          !wrapper ||
          wrapper.parentElement !== scope ||
          !wrapper.matches("div.a-row.a-grid-vertical-align.a-grid-center") ||
          wrapper.children.length !== 2 ||
          wrapper.children[1] !== detail ||
          !detail.matches("div.a-column.a-span11") ||
          detail.children[0] !== row ||
          !(row === header ? [1] : [1, 2]).includes(detail.children.length)
        )
          return null;
        const image = wrapper.children[0];
        if (
          !image.matches("div.a-column.a-span1.ufpo-item-image-column") ||
          norm(image) ||
          image.querySelector("a,svg,button,input,[role=button]") ||
          image.children.length !== (row === header ? 0 : 1)
        )
          return null;
        if (row !== header) {
          const img = image.children[0];
          const name = row.querySelector(".a-span6 a");
          if (
            !img.matches("img") ||
            img.children.length ||
            !active(img) ||
            !name ||
            img.getAttribute("alt") !== norm(name)
          )
            return null;
        }
        coveredRoots.push(image);
        wrappers.push(wrapper);
      }
      // Exactly the complete owned rows separated by empty dividers, in order.
      const children = Array.from(scope.children);
      if (
        new Set(wrappers).size !== wrappers.length ||
        ![wrappers.length * 2 - 1, wrappers.length * 2].includes(
          children.length,
        ) ||
        children.some((el, index) =>
          index % 2 === 0
            ? el !== wrappers[index / 2]
            : el.tagName !== "HR" ||
              el.children.length > 0 ||
              Boolean(norm(el)),
        )
      )
        return null;
      for (const row of rows) {
        if (!row || !active(row) || row.children.length !== 4) return null;
        const [product, qty, weight, total] = Array.from(row.children);
        if (
          ![product, qty, total].every(
            (el) => el.matches("div.a-column") && active(el),
          ) ||
          !weight.matches("div.a-column") ||
          !product.matches(".a-span6") ||
          !qty.matches(".a-span1") ||
          !weight.matches(".a-span3") ||
          !total.matches(".a-span2") ||
          norm(weight) ||
          row.querySelector(
            "script,style,template,img,svg,input,button,select,textarea,[role=button]",
          )
        )
          return null;
        if (product.querySelector("img,svg")) return null;
        const a = product.querySelectorAll("a[href]");
        if (
          a.length !== 1 ||
          !norm(a[0]) ||
          norm(a[0]).length > 500 ||
          norm(product) !== norm(a[0])
        )
          return null;
        const u = new URL(a[0].getAttribute("href") ?? "", document.URL);
        const asin = /^\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:\/|$)/.exec(
          u.pathname,
        )?.[1];
        if (
          !asin ||
          u.protocol !== "https:" ||
          !["www.amazon.in", "amazon.in"].includes(u.hostname) ||
          u.port ||
          u.username ||
          u.password
        )
          return null;
        if (
          !/^[1-9]\d*$/.test(norm(qty)) ||
          !Number.isSafeInteger(Number(norm(qty))) ||
          qty.querySelector("a,img,svg") ||
          total.querySelector("a,img,svg") ||
          Array.from(row.querySelectorAll("*")).some(
            (el) => norm(el) && !active(el),
          )
        )
          return null;
        const quantity = Number(norm(qty));
        const status = row.parentElement?.children[1];
        if (
          status &&
          (!status.matches("div.a-row.a-grid-vertical-align.a-grid-center") ||
            status.children.length !== 2 ||
            !status.children[0].matches(".a-column.a-span8") ||
            norm(status.children[0]) ||
            !status.children[1].matches(
              ".a-column.a-span4.ufpo-item-status-column",
            ) ||
            status.querySelector(
              "a,img,svg,button,input,select,textarea,[role=button]",
            ) ||
            Array.from(status.querySelectorAll("*")).some(
              (el) => norm(el) && !active(el),
            ))
        )
          return null;
        let refundAmount: string | undefined;
        if (status && norm(status)) {
          const column = status.children[1],
            box = column.children[0],
            inner = box?.children[0],
            refund = inner?.children[0];
          if (
            column.children.length !== 1 ||
            !box?.matches("div.a-box.ufpo-item-status") ||
            box.children.length !== 1 ||
            !inner?.matches("div.a-box-inner") ||
            inner.children.length !== 1 ||
            !refund?.matches("div.a-row") ||
            refund.children.length !== 2 ||
            !refund.children[0].matches("div.a-column.a-span8") ||
            !refund.children[1].matches(
              "div.a-column.a-span3.ufpo-item-status-price",
            ) ||
            !Array.from(refund.children).every(
              (el) =>
                el.children.length === 1 &&
                el.children[0].matches("span") &&
                el.children[0].children.length === 0,
            )
          )
            return null;
          const count = /^Refunded \(([1-9]\d*)\)$/.exec(
            norm(refund.children[0]),
          );
          if (
            !count ||
            !Number.isSafeInteger(Number(count[1])) ||
            Number(count[1]) > quantity ||
            !/^-(?:₹|INR\s+)/.test(norm(refund.children[1])) ||
            norm(status) !== norm(refund)
          )
            return null;
          // This separately labelled status never changes the original purchased
          // quantity/Total, creates an adjustment, or establishes a unit price.
          refundAmount = norm(refund.children[1]).slice(1);
        }
        if (status) coveredRoots.push(status);
        facts.push({
          asin,
          quantity,
          amount: norm(total),
          ...(refundAmount ? { refundAmount } : {}),
        });
      }
      const covered = (el: Element): boolean =>
        coveredRoots.some((root) => root.contains(el));
      if (
        [scope, ...Array.from(scope.querySelectorAll("*"))].some(
          (el) =>
            !covered(el) &&
            (Array.from(el.childNodes).some(
              (n) => n.nodeType === 3 && n.textContent?.trim(),
            ) ||
              el.matches(
                "a,img,svg,button,input,select,textarea,[role=button]",
              )),
        )
      )
        return null;
      return facts;
    }, orderId);
    if (invalidNavigation || !validUrl(page.url(), true) || !result)
      return reject();
    for (const item of result) {
      if (
        item.refundAmount !== undefined &&
        (nowLinePaise(item.refundAmount) <= 0 ||
          nowLinePaise(item.refundAmount) > nowLinePaise(item.amount))
      )
        return reject();
    }
    return validateNowPrintableProof(
      {
        source: "selected-order-printable-summary",
        orderId,
        items: result.map((item) => ({
          asin: item.asin,
          quantity: item.quantity,
          itemTotalPaise: nowLinePaise(item.amount),
        })),
      },
      orderId,
      expected,
    );
  } catch (error) {
    leaveForAuthentication =
      error instanceof Error && error.name === "AuthenticationRequiredError";
    throw error;
  } finally {
    if (!leaveForAuthentication) await page.close();
  }
}
