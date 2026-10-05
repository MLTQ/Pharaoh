/**
 * Scene plates on the Pyramid view, stacked in courses that widen downward.
 *
 * A project with a handful of scenes keeps a single row. Past that, scenes
 * fill rows of FIRST_ROW, FIRST_ROW + 1, … in reading order, trimmed from the
 * top so the bottom course stays the widest. A 60-chapter audiobook is
 * then eight courses, not one 12,000 px strip.
 *
 * When scenes carry acts (Fountain `# Act One` sections, or set by hand),
 * each act gets its own course instead — wrapped into balanced rows of at
 * most ACT_ROW_MAX when it's long — and the course is labelled.
 */

export const SINGLE_ROW_MAX = 6;
export const FIRST_ROW = 5;

/** Cards per row, top to bottom (never decreasing). `cards` includes "+ Add scene". */
export function pyramidRows(cards: number): number[] {
  if (cards <= SINGLE_ROW_MAX) return [Math.max(1, cards)];
  const rows: number[] = [];
  let sum = 0;
  while (sum < cards) {
    rows.push(FIRST_ROW + rows.length);
    sum += rows[rows.length - 1];
  }
  // Too many slots: take them back from the top, round-robin, keeping each
  // course at least as wide as the one above it.
  let i = 0;
  while (sum > cards) {
    if (rows[i] > 1 && (i === 0 || rows[i] - 1 >= rows[i - 1])) {
      rows[i] -= 1;
      sum -= 1;
    }
    i = (i + 1) % rows.length;
  }
  return rows;
}

export const ACT_ROW_MAX = 10;

/**
 * Rows for scenes grouped by act, or null when no scene has one. A scene with
 * no act stays with the act before it. `labels[r]` names the act on the first
 * row of each act. The "+ Add scene" card joins the last row.
 */
export function actRows(acts: (string | null | undefined)[]): { counts: number[]; labels: (string | null)[]; actOfRow: (string | null)[] } | null {
  if (!acts.some((a) => a && a.trim())) return null;
  const groups: { act: string | null; n: number }[] = [];
  let current: string | null = null;
  for (const raw of acts) {
    const a = raw?.trim() || null;
    if (a && a !== current) current = a;
    const last = groups[groups.length - 1];
    if (last && last.act === current) last.n += 1;
    else groups.push({ act: current, n: 1 });
  }
  const counts: number[] = [];
  const labels: (string | null)[] = [];
  const actOfRow: (string | null)[] = [];
  for (const g of groups) {
    const rows = Math.ceil(g.n / ACT_ROW_MAX);
    for (let r = 0; r < rows; r++) {
      // Balanced: earlier rows take the remainder.
      counts.push(Math.floor(g.n / rows) + (r < g.n % rows ? 1 : 0));
      labels.push(r === 0 ? g.act : null);
      actOfRow.push(g.act);
    }
  }
  counts[counts.length - 1] += 1; // "+ Add scene"
  return { counts, labels, actOfRow };
}

export interface PlateSlot {
  row: number;
  x: number;
  y: number;
}

export interface PyramidGeometry {
  W: number;
  H: number;
  rows: { left: number; right: number; top: number; count: number }[];
  /** Position of card `i` (scenes in order, then "+ Add scene"). */
  slots: PlateSlot[];
}

export function pyramidGeometry(
  cards: number,
  o: { plateW: number; plateH: number; gap: number; rowGap: number; baseY: number; minW: number; bottom: number },
  /** Explicit row sizes (acts); defaults to the widening courses. */
  rowCounts?: number[],
): PyramidGeometry {
  const counts = rowCounts ?? pyramidRows(cards);
  const widest = Math.max(...counts.map((c) => c * o.plateW + (c - 1) * o.gap));
  const W = Math.max(o.minW, widest + 240);
  const rowH = o.plateH + o.rowGap;
  const rows = counts.map((count, r) => {
    const w = count * o.plateW + (count - 1) * o.gap;
    return { left: (W - w) / 2, right: (W + w) / 2, top: o.baseY + r * rowH, count };
  });
  const slots: PlateSlot[] = [];
  rows.forEach((row, r) => {
    for (let k = 0; k < row.count; k++) slots.push({ row: r, x: row.left + k * (o.plateW + o.gap), y: row.top });
  });
  const H = rows[rows.length - 1].top + o.plateH + o.bottom;
  return { W, H, rows, slots };
}
