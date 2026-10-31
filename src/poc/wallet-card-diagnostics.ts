/// <reference lib="dom" />
import type { Locator } from "playwright";
import type { FailureDiagnostics, ReasonCode } from "./failure-diagnostics";

const LABEL = /^Amazon Pay Wallet Add Money$/i;

/** Diagnostic only: no count can prove a funding-only card or authorize a skip. */
export function walletLabelDiagnostic(count: unknown): ReasonCode | undefined {
  if (count === 0) return undefined;
  if (count === 1) return "LIST_WALLET_LABEL_UNVERIFIED";
  if (count === 2) return "LIST_WALLET_LABEL_AMBIGUOUS";
  return "LIST_WALLET_EVIDENCE_UNAVAILABLE";
}

/** Reuse the existing card boundary; no wallet-specific DOM selector is assumed.
 * Raw text stays local, and neither observations nor errors change selection.
 */
export async function recordWalletCardDiagnostic(
  card: Locator,
  cardText: string,
  cardSelector: string,
  diagnostics?: FailureDiagnostics,
): Promise<void> {
  if (!diagnostics) return;
  if (cardText.length > 50000) {
    diagnostics.note("list", "LIST_WALLET_EVIDENCE_UNAVAILABLE");
    return;
  }
  if (
    !cardText
      .split(/\r?\n/)
      .some((line) => LABEL.test(line.replace(/\s+/g, " ").trim()))
  )
    return;
  try {
    const count = await card.evaluate(
      (root, ownerSelector) => {
        const nodes = [root, ...Array.from(root.querySelectorAll("*"))];
        const view = root.ownerDocument.defaultView;
        if (!view || nodes.length > 1000) return -1;
        const current = (element: Element): boolean => {
          for (
            let node: Element | null = element;
            node;
            node = node.parentElement
          ) {
            const style = view.getComputedStyle(node);
            if (
              node.hasAttribute("hidden") ||
              node.getAttribute("aria-hidden") === "true" ||
              ["S", "DEL", "STRIKE"].includes(node.tagName) ||
              style.display === "none" ||
              style.visibility === "hidden" ||
              style.visibility === "collapse" ||
              style.opacity === "0" ||
              style.textDecorationLine.includes("line-through")
            )
              return false;
          }
          return element.getClientRects().length > 0;
        };
        const cache = new Map<Element, string>();
        let boundsExceeded = false;
        const text = (element: Element): string => {
          if (cache.has(element)) return cache.get(element) ?? "";
          if (!current(element)) return "";
          const value = Array.from(element.childNodes)
            .map((node) =>
              node.nodeType === 3
                ? (node.textContent ?? "")
                : node.nodeType === 1
                  ? text(node as Element)
                  : "",
            )
            .join(" ")
            .replace(/\s+/g, " ")
            .trim();
          if (value.length > 50000) boundsExceeded = true;
          cache.set(element, value);
          return value;
        };
        const label = /^Amazon Pay Wallet Add Money$/i;
        let matches = 0;
        for (const node of nodes) {
          if (
            node.closest(ownerSelector) !== root ||
            !current(node) ||
            !label.test(text(node))
          )
            continue;
          // Count the smallest complete visible field, not each equal-text wrapper.
          if (
            Array.from(node.children).some(
              (child) => current(child) && label.test(text(child)),
            )
          )
            continue;
          matches++;
          if (matches === 2) return boundsExceeded ? -1 : 2;
        }
        return boundsExceeded ? -1 : matches;
      },
      cardSelector,
      { timeout: 1500 },
    );
    const code = walletLabelDiagnostic(count);
    if (code)
      diagnostics.note(
        "list",
        code,
        count === 1 || count === 2 ? count : undefined,
      );
  } catch (error) {
    diagnostics.noteFailure("list", "LIST_WALLET_EVIDENCE_UNAVAILABLE", error);
  }
}
