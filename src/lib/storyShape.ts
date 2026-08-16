/**
 * Story-shape curve math.
 *
 * Turns a sparse list of authored per-scene tension values into a smooth
 * polyline for the shape view. Pure — no React, no DOM, no store access.
 *
 * Monotone cubic (Fritsch–Carlson) rather than Catmull-Rom: a plain spline
 * overshoots between beats, inventing peaks and troughs the writer never
 * authored. For a tool whose entire premise is "show me the shape I actually
 * made", inventing shape is the one unacceptable failure.
 */

/** One authored point. `index` is the scene's position in storyboard order. */
export interface ShapePoint {
  index: number;
  tension: number;
}

/** A run of samples between two authored points. */
export interface CurveSegment {
  /** True when unshaped scenes sit between the two endpoints — the renderer
   *  dashes these so an interpolation is never mistaken for authorship. */
  spansGap: boolean;
  samples: { x: number; y: number }[];
}

/** Collect authored points from scenes in storyboard order. Scenes with a
 *  null/undefined/non-finite tension are skipped, not coerced to zero. */
export function toShapePoints(
  scenes: { tension?: number | null }[],
): ShapePoint[] {
  const pts: ShapePoint[] = [];
  scenes.forEach((s, index) => {
    const t = s.tension;
    if (t == null || !Number.isFinite(t)) return;
    pts.push({ index, tension: clamp01(t) });
  });
  return pts;
}

export function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Fritsch–Carlson tangents: monotone between consecutive points, so the curve
 * cannot overshoot the authored values.
 */
function monotoneTangents(xs: number[], ys: number[]): number[] {
  const n = xs.length;
  if (n < 2) return new Array(n).fill(0);

  const secants = new Array<number>(n - 1);
  for (let i = 0; i < n - 1; i++) {
    secants[i] = (ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]);
  }

  const m = new Array<number>(n);
  m[0] = secants[0];
  m[n - 1] = secants[n - 2];
  for (let i = 1; i < n - 1; i++) {
    // Sign change (a local extremum) — flatten so we don't overshoot past it.
    m[i] = secants[i - 1] * secants[i] <= 0 ? 0 : (secants[i - 1] + secants[i]) / 2;
  }

  // Clamp tangents into the monotonicity region (circle of radius 3).
  for (let i = 0; i < n - 1; i++) {
    if (secants[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i] / secants[i];
    const b = m[i + 1] / secants[i];
    const s = a * a + b * b;
    if (s > 9) {
      const t = 3 / Math.sqrt(s);
      m[i] = t * a * secants[i];
      m[i + 1] = t * b * secants[i];
    }
  }
  return m;
}

/**
 * Build the curve through the authored points.
 *
 * Returns one segment per adjacent pair. Zero points → no segments (an empty
 * shape view is correct for an unshaped project — we draw nothing rather than
 * a flat line that reads as "all scenes at zero"). One point → no segments;
 * the renderer still draws its node.
 */
export function buildCurve(
  points: ShapePoint[],
  samplesPerSegment = 24,
): CurveSegment[] {
  if (points.length < 2) return [];

  const xs = points.map((p) => p.index);
  const ys = points.map((p) => p.tension);
  const m = monotoneTangents(xs, ys);
  const steps = Math.max(1, Math.floor(samplesPerSegment));

  const segments: CurveSegment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const h = xs[i + 1] - xs[i];
    const samples: { x: number; y: number }[] = [];
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      // Cubic Hermite basis.
      const h00 = 2 * t3 - 3 * t2 + 1;
      const h10 = t3 - 2 * t2 + t;
      const h01 = -2 * t3 + 3 * t2;
      const h11 = t3 - t2;
      samples.push({
        x: xs[i] + t * h,
        y: h00 * ys[i] + h10 * h * m[i] + h01 * ys[i + 1] + h11 * h * m[i + 1],
      });
    }
    segments.push({ spansGap: h > 1, samples });
  }
  return segments;
}

/**
 * Default tension for a newly inserted scene: interpolate from the nearest
 * authored neighbours on each side so an insert never punches a hole in a
 * shaped curve. Returns null when nothing is authored yet (stay unshaped) —
 * inserting into an unshaped project must not silently start shaping it.
 */
export function interpolatedDefault(
  points: ShapePoint[],
  index: number,
): number | null {
  if (points.length === 0) return null;

  let before: ShapePoint | undefined;
  let after: ShapePoint | undefined;
  for (const p of points) {
    if (p.index < index) before = p;
    else if (p.index > index && after === undefined) after = p;
  }

  if (before && after) {
    const t = (index - before.index) / (after.index - before.index);
    return clamp01(before.tension + t * (after.tension - before.tension));
  }
  // Past an end — hold the nearest authored value rather than inventing a ramp.
  return (before ?? after)!.tension;
}
