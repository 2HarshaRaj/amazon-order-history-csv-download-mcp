/** List discovery only. D01 recognition does not authorize extraction/exclusion. */
export function listedOrderId(text: string): string | undefined {
  const ids = [
    ...new Set(
      text.match(
        /\b(?:D01|\d{3})-\d{7}-\d{7}\b|\b[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\b/gi,
      ) ?? [],
    ),
  ];
  if (ids.length !== 1) return undefined;
  const id = ids[0];
  if (/^d01/i.test(id) && !/^D01-/.test(id)) return undefined;
  const shaped = text.match(/\b[A-Z0-9]{3}-\d{7}-\d{7}\b/gi) ?? [];
  if (shaped.some((value) => value !== id)) return undefined;
  const labels = [
    ...text.matchAll(/\border\s*(?:#|ID\b|number\b)\s*:?\s*#?\s*(\S+)/gi),
  ];
  if (labels.some((match) => match[1] !== id)) return undefined;
  return id;
}
