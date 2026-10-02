/** Match under the app's existing zh-CN lowercasing policy, then map to original code points. */
export function findCaseInsensitiveTextRange(source: string, query: string): [number, number] | undefined {
  if (!query) return undefined;
  const foldedSource = source.toLocaleLowerCase("zh-CN");
  const foldedQuery = query.toLocaleLowerCase("zh-CN");
  const from = foldedSource.indexOf(foldedQuery);
  if (from < 0) return undefined;
  const to = from + foldedQuery.length;
  let foldedOffset = 0; let codePointOffset = 0;
  let originalStart: number | undefined; let originalEnd: number | undefined;
  for (const character of source) {
    // zh-CN has no tailored casing widths. The whole-string match above still
    // handles contextual substitutions such as final sigma, unlike per-letter matching.
    const next = foldedOffset + character.toLowerCase().length;
    if (next > from && foldedOffset < to) {
      originalStart ??= codePointOffset;
      originalEnd = codePointOffset + 1;
    }
    foldedOffset = next; codePointOffset += 1;
  }
  // Never invent a precise anchor if a future runtime changes width semantics.
  if (foldedOffset !== foldedSource.length || originalStart === undefined || originalEnd === undefined) return undefined;
  return [originalStart, originalEnd];
}
