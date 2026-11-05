type OrderedVideo = { id: string; title: string; position: number };

function titleNumber(title: string): string | null {
  const digits = /^\s*([0-9]+)(?=$|[\s.\-–—:)])/.exec(title)?.[1];
  return digits === undefined ? null : digits.replace(/^0+(?=\d)/, '');
}
function lexical(a: string, b: string) { return a < b ? -1 : a > b ? 1 : 0; }

/** Preserve the explicit manual order. Within it, numbered lessons precede
 * unnumbered titles and compare numerically (2 = 02 < 10). IDs break ties,
 * independently of source, timestamps, input order and server locale.
 * Call only on rows already admitted by the library's current-access checks. */
export function compareVideoOrder(a: OrderedVideo, b: OrderedVideo): number {
  if (a.position !== b.position) return a.position - b.position;
  const left = titleNumber(a.title), right = titleNumber(b.title);
  if (left !== null && right !== null) {
    const numeric = left.length - right.length || lexical(left, right);
    if (numeric) return numeric;
  } else if (left !== null || right !== null) return left !== null ? -1 : 1;
  return lexical(a.id, b.id);
}
