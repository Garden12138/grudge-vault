export const RECORD_TEXT_LIMIT = 50_000;
export const RECORD_QUERY_TEXT_LIMIT = 500;

/** Source anchors and input limits count Unicode code points, not UTF-16 units. */
export function codePointLength(value: string): number {
  let length = 0;
  const characters = value[Symbol.iterator]();
  while (!characters.next().done) length += 1;
  return length;
}
