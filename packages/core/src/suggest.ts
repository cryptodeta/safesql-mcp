/** Levenshtein distance, early exit when above max. */
export function distance(a: string, b: string, max = 99): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < best) best = v;
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/** Closest candidates to `input` (case-insensitive), best first. */
export function suggest(input: string, candidates: Iterable<string>, limit = 3): string[] {
  const needle = input.toLowerCase();
  const scored: { c: string; d: number }[] = [];
  for (const c of candidates) {
    const lc = c.toLowerCase();
    const max = Math.max(2, Math.floor(needle.length / 3));
    let d = distance(needle, lc, max);
    if (lc.includes(needle) || needle.includes(lc)) d = Math.min(d, 1);
    // plural/singular
    if (lc === `${needle}s` || needle === `${lc}s`) d = 0.5;
    if (d <= max) scored.push({ c, d });
  }
  return scored
    .sort((x, y) => x.d - y.d || x.c.localeCompare(y.c))
    .slice(0, limit)
    .map((s) => s.c);
}
