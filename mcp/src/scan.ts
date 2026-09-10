/**
 * Deterministic image scanning — the shared core behind `measure_reference`
 * and `score_render`.
 *
 * This is the TypeScript port of the skill's `scripts/measure_reference.py`,
 * upgraded with everything the two acceptance-test runs paid to learn:
 *
 *  - PER-ROW sky model, interpolated between the frame margins. A single sky
 *    sample fails on any graded sky (dusk, haze) and silently mislabels half
 *    the frame — the exact failure that pinned `widthFrac` at its saturation
 *    value in the field.
 *  - Banded floor-pitch autocorrelation with a high-pass, reporting LOCAL
 *    maxima per height band — a pitch that drifts between bands means
 *    perspective is non-linear and a global pixel->metre scale is unsafe.
 *  - Pure-JS decoding (pngjs / jpeg-js): no native deps, no Python, no broken
 *    Pillow wheels.
 *
 * Everything here reports MEASUREMENTS, not conclusions.
 */
import fs from "node:fs";
import path from "node:path";
import jpeg from "jpeg-js";
import { PNG } from "pngjs";

export interface Bitmap {
  w: number;
  h: number;
  /** RGBA, row-major */
  data: Uint8Array;
}

export function decodeImage(path: string): Bitmap {
  const buf = fs.readFileSync(path);
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) {
    const png = PNG.sync.read(buf);
    return { w: png.width, h: png.height, data: new Uint8Array(png.data) };
  }
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    const img = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 1024 });
    return { w: img.width, h: img.height, data: new Uint8Array(img.data) };
  }
  throw new Error(`Unsupported image type: ${path} (png/jpg only)`);
}

/**
 * A region of the ORIGINAL image, in original pixels.
 *
 * The division of labour this enables is the whole point: the agent decides
 * where to look (judgement, and it is good at it — it crops by hand within
 * minutes), the scanner measures what is there (determinism). The shipped
 * sky-margin detectors failed on 4 of 4 real field photographs — dusk
 * gradient, sea horizon, vegetation, hero-crop margins — not because the
 * measurement was wrong but because nobody had aimed it.
 */
export interface Crop {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface Cropped {
  im: Bitmap;
  /** Add these to any measured coordinate to return to full-image space. */
  ox: number;
  oy: number;
}

/** Clamp a crop to the image and cut it out; identity when no crop is given. */
export function applyCrop(im: Bitmap, c?: Crop): Cropped {
  if (!c) return { im, ox: 0, oy: 0 };
  const x0 = Math.max(0, Math.min(im.w - 1, Math.round(Math.min(c.x0, c.x1))));
  const x1 = Math.max(x0 + 1, Math.min(im.w, Math.round(Math.max(c.x0, c.x1))));
  const y0 = Math.max(0, Math.min(im.h - 1, Math.round(Math.min(c.y0, c.y1))));
  const y1 = Math.max(y0 + 1, Math.min(im.h, Math.round(Math.max(c.y0, c.y1))));
  const w = x1 - x0, h = y1 - y0;
  if (w < 8 || h < 8) {
    throw new Error(
      `Crop [${x0},${y0},${x1},${y1}] is ${w}x${h} px — too small to measure (need 8x8 or more)`,
    );
  }
  const data = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = ((y + y0) * im.w + x0) * 4;
    data.set(im.data.subarray(src, src + w * 4), y * w * 4);
  }
  return { im: { w, h, data }, ox: x0, oy: y0 };
}

/** Bilinear resize — good enough for silhouette work at comparable sizes. */
export function resize(src: Bitmap, w: number, h: number): Bitmap {
  if (src.w === w && src.h === h) return src;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const sy = (y * (src.h - 1)) / (h - 1);
    const y0 = Math.floor(sy), y1 = Math.min(src.h - 1, y0 + 1), fy = sy - y0;
    for (let x = 0; x < w; x++) {
      const sx = (x * (src.w - 1)) / (w - 1);
      const x0 = Math.floor(sx), x1 = Math.min(src.w - 1, x0 + 1), fx = sx - x0;
      for (let c = 0; c < 4; c++) {
        const a = src.data[(y0 * src.w + x0) * 4 + c];
        const b = src.data[(y0 * src.w + x1) * 4 + c];
        const d = src.data[(y1 * src.w + x0) * 4 + c];
        const e = src.data[(y1 * src.w + x1) * 4 + c];
        out[(y * w + x) * 4 + c] =
          (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
      }
    }
  }
  return { w, h, data: out };
}

const px = (im: Bitmap, x: number, y: number): [number, number, number] => {
  const i = (y * im.w + x) * 4;
  return [im.data[i], im.data[i + 1], im.data[i + 2]];
};

export const luma = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[n >> 1] : 0.5 * (s[(n >> 1) - 1] + s[n >> 1]);
}

/** Per-row sky estimate at BOTH margins. Real skies grade in both axes (a
 *  dusk glow is brighter on one side), so a pixel must be compared against
 *  the sky interpolated horizontally between the margins — pooling the two
 *  margins into one estimate matches neither side and flags whole rows.
 *  Limitation (documented, not hidden): a row where the subject or foreground
 *  spans BOTH margins gets a poisoned estimate. */
function rowSkyLR(im: Bitmap, y: number): { l: [number, number, number]; r: [number, number, number] } {
  const side = (x0: number, x1: number): [number, number, number] => {
    const ch: number[][] = [[], [], []];
    for (let x = x0; x < x1; x++) {
      const p = px(im, x, y);
      ch[0].push(p[0]); ch[1].push(p[1]); ch[2].push(p[2]);
    }
    return [median(ch[0]), median(ch[1]), median(ch[2])];
  };
  return {
    l: side(2, Math.min(14, im.w)),
    r: side(Math.max(0, im.w - 14), im.w - 2),
  };
}

/** Sky colour at (x, y): horizontal interpolation between the margin medians. */
function skyAtX(sky: ReturnType<typeof rowSkyLR>, x: number, w: number): [number, number, number] {
  const t = x / (w - 1);
  return [
    sky.l[0] + (sky.r[0] - sky.l[0]) * t,
    sky.l[1] + (sky.r[1] - sky.l[1]) * t,
    sky.l[2] + (sky.r[2] - sky.l[2]) * t,
  ];
}

export interface SilRow {
  left: number;
  right: number;
  width: number;
}

/** Per row: widest sky-contrasting run; (-1,-1,0) when none. */
export function silhouette(im: Bitmap, tol = 42): SilRow[] {
  const rows: SilRow[] = [];
  for (let y = 0; y < im.h; y++) {
    const sky = rowSkyLR(im, y);
    const isSubject = (x: number) => {
      const p = px(im, x, y);
      const s = skyAtX(sky, x, im.w);
      const d = Math.hypot(p[0] - s[0], p[1] - s[1], p[2] - s[2]);
      return d > tol;
    };
    let left = -1, right = -1;
    for (let x = 0; x < im.w; x++) if (isSubject(x)) { left = x; break; }
    if (left >= 0) for (let x = im.w - 1; x >= left; x--) if (isSubject(x)) { right = x; break; }
    rows.push({ left, right, width: left >= 0 && right >= 0 ? right - left + 1 : 0 });
  }
  return rows;
}

/** Rows that are sky-bounded on both sides — the only rows safe to measure.
 *  The margin is 3% of width, not 1 px: a run starting a few pixels off the
 *  frame edge is foreground (jetties, wave foam) that happens to clear it. */
export function boundedRows(sil: SilRow[], w: number): number[] {
  const m = Math.max(1, Math.round(w * 0.03));
  const out: number[] = [];
  for (let y = 0; y < sil.length; y++) {
    const r = sil[y];
    if (r.width > w * 0.05 && r.left > m && r.right < w - 1 - m) out.push(y);
  }
  return out;
}

/**
 * Below this, an autocorrelation peak is as likely to be JPEG block structure
 * or sensor noise as a real repeating element. Every consumer of a pitch must
 * apply it — measuring it in one place and forgetting it in another is how a
 * 5 px artefact became a confident "a second face is visible" claim on the
 * Empire State photograph.
 */
export const NOISE_FLOOR_PX = 8;

export interface PitchBand {
  band: "top" | "middle" | "bottom";
  rows: number;
  peaks: { pitch_px: number; score: number }[];
  /** Strongest peak is at or under the noise floor — do not build on it. */
  unreliable?: boolean;
}

/** Banded autocorrelation of a vertical luminance profile down the subject. */
export function floorPitch(im: Bitmap, sil: SilRow[]): PitchBand[] {
  const rows = boundedRows(sil, im.w);
  if (rows.length < 40) return [];
  const names: PitchBand["band"][] = ["top", "middle", "bottom"];
  const third = Math.floor(rows.length / 3);
  const out: PitchBand[] = [];
  for (let b = 0; b < 3; b++) {
    const band = rows.slice(b * third, b === 2 ? rows.length : (b + 1) * third);
    const prof: number[] = [];
    for (const y of band) {
      const { left, right } = sil[y];
      const xc = (left + right) >> 1, q = (right - left) >> 2;
      let sum = 0, n = 0;
      for (let x = Math.max(left, xc - q); x <= Math.min(right, xc + q); x++) {
        const p = px(im, x, y);
        sum += luma(p[0], p[1], p[2]); n++;
      }
      prof.push(sum / Math.max(1, n));
    }
    const peaks = autocorrPeaks(prof);
    if (peaks !== null) {
      const band: PitchBand = { band: names[b], rows: prof.length, peaks };
      const best = peaks[0]?.pitch_px;
      if (best !== undefined && best < NOISE_FLOOR_PX) band.unreliable = true;
      out.push(band);
    }
  }
  return out;
}

/** High-pass + autocorrelate a 1-D profile; return local-maxima peaks.
 *  The high-pass matters: a smooth gradient autocorrelates at every small lag
 *  and buries the repeating rhythm. */
export function autocorrPeaks(prof: number[]): { pitch_px: number; score: number }[] | null {
  const n = prof.length;
  if (n < 30) return null;
  const HP = 15;
  const dev = prof.map((v, i) => {
    const lo = Math.max(0, i - HP), hi = Math.min(n, i + HP + 1);
    let s = 0;
    for (let j = lo; j < hi; j++) s += prof[j];
    return v - s / (hi - lo);
  });
  const denom = dev.reduce((s, d) => s + d * d, 0) || 1;
  const corr = new Map<number, number>();
  for (let lag = 4; lag < Math.min(120, n >> 1); lag++) {
    let c = 0;
    for (let i = 0; i < n - lag; i++) c += dev[i] * dev[i + lag];
    corr.set(lag, c / denom);
  }
  const peaks: { pitch_px: number; score: number }[] = [];
  for (const [lag, c] of corr) {
    const a = corr.get(lag - 1), z = corr.get(lag + 1);
    if (a !== undefined && z !== undefined && c > a && c > z && c > 0.1) {
      peaks.push({ pitch_px: lag, score: Math.round(c * 1000) / 1000 });
    }
  }
  peaks.sort((p, q) => q.score - p.score);
  return peaks.slice(0, 4);
}

/** Left/right band luma inside the silhouette. On a corner view these are the
 *  two faces; on a square-on symmetric subject they are NOT (checklist 13). */
export function bandStats(im: Bitmap, sil: SilRow[]) {
  const ls: number[] = [], rs: number[] = [];
  for (let y = 0; y < im.h; y++) {
    const { left, right, width } = sil[y];
    if (width < im.w * 0.05) continue;
    const third = Math.max(1, width / 3 | 0);
    for (let x = left; x < Math.min(left + third, im.w); x++) {
      const p = px(im, x, y); ls.push(luma(p[0], p[1], p[2]));
    }
    for (let x = Math.max(right - third, 0); x < right; x++) {
      const p = px(im, x, y); rs.push(luma(p[0], p[1], p[2]));
    }
  }
  if (!ls.length || !rs.length) return null;
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const a = mean(ls), b = mean(rs);
  return {
    left_band_luma: Math.round(a * 10) / 10,
    right_band_luma: Math.round(b * 10) / 10,
    lit_over_shadow_ratio: Math.round((Math.max(a, b) / Math.max(1, Math.min(a, b))) * 1000) / 1000,
  };
}

export function measureImage(path: string, crop?: Crop) {
  const full = decodeImage(path);
  const { im, ox, oy } = applyCrop(full, crop);
  const sil = silhouette(im);
  const bounded = boundedRows(sil, im.w);
  const widths = bounded.map((y) => sil[y].width);
  const subjectRows = sil
    .map((r, y) => ({ r, y }))
    .filter(({ r }) => r.width > im.w * 0.05)
    .map(({ y }) => y);
  const top = subjectRows[0], bottom = subjectRows[subjectRows.length - 1];
  return {
    image: path,
    size: [full.w, full.h],
    // Rows come back in FULL-image space so they stay comparable with every
    // other measurement of this photograph, cropped or not.
    scanned_region: crop ? { x0: ox, y0: oy, x1: ox + im.w, y1: oy + im.h } : null,
    aspect: Math.round((im.w / im.h) * 10000) / 10000,
    subject_top_row: top === undefined ? null : top + oy,
    subject_bottom_row: bottom === undefined ? null : bottom + oy,
    sky_bounded_rows: bounded.length,
    median_width_px: median(widths),
    floor_pitch: floorPitch(im, sil),
    bands: bandStats(im, sil),
    notes:
      "Pitch that drifts between bands = non-linear perspective; use local ratios. " +
      "Fine pitches near the JPEG noise floor need a magnified band-local crop. " +
      (crop
        ? "Rows are in full-image coordinates; widths are within the crop."
        : "Few sky-bounded rows on a cluttered photograph means the detector could not " +
          "see, not that the subject is absent — re-run with a crop that excludes the " +
          "occluding foreground."),
  };
}

/**
 * measure_pitch core: autocorrelation, aimed.
 *
 * `floorPitch` autocorrelates down the whole subject, which answers "what is
 * the floor rhythm" and nothing else. The recurring field need is the same
 * measurement pointed at a chosen region and axis — baluster spacing, tile
 * courses, bay rhythm, and the per-face end-pitch comparison (call twice with
 * two crops). Same engine, aimable.
 */
export function measurePitch(path: string, axis: "vertical" | "horizontal", crop?: Crop) {
  const full = decodeImage(path);
  const { im, ox, oy } = applyCrop(full, crop);

  // "vertical" means the rhythm runs down the image (floors, courses), so the
  // profile is one luma sample per ROW; "horizontal" is per column.
  const prof: number[] = [];
  if (axis === "vertical") {
    for (let y = 0; y < im.h; y++) {
      let s = 0;
      for (let x = 0; x < im.w; x++) { const p = px(im, x, y); s += luma(p[0], p[1], p[2]); }
      prof.push(s / im.w);
    }
  } else {
    for (let x = 0; x < im.w; x++) {
      let s = 0;
      for (let y = 0; y < im.h; y++) { const p = px(im, x, y); s += luma(p[0], p[1], p[2]); }
      prof.push(s / im.h);
    }
  }

  const peaks = autocorrPeaks(prof);
  const span = prof.length;
  const best = peaks?.[0]?.pitch_px;
  const warnings: string[] = [];
  if (peaks === null) {
    warnings.push(
      `profile is ${span} samples — autocorrelation needs 30+; enlarge the crop along the ${axis} axis`,
    );
  } else if (peaks.length === 0) {
    warnings.push(
      "no repeating rhythm found — either there is none here, or the contrast is too low; " +
      "try a crop tight on the repeating elements only",
    );
  }
  if (best !== undefined && best < 8) {
    warnings.push(
      `strongest pitch is ${best} px, at or below the JPEG noise floor (~8 px) — treat as ` +
      "unreliable; measure it on a magnified crop of a few units and divide instead",
    );
  }
  if (best !== undefined && best > span / 3) {
    warnings.push(
      `strongest pitch (${best} px) spans more than a third of the ${span} px profile — ` +
      "fewer than ~3 repeats is not a rhythm, it is a coincidence",
    );
  }

  return {
    image: path,
    axis,
    size: [full.w, full.h],
    scanned_region: { x0: ox, y0: oy, x1: ox + im.w, y1: oy + im.h },
    profile_samples: span,
    peaks: peaks ?? [],
    units_across_span: best ? Math.round((span / best) * 10) / 10 : null,
    warnings,
    notes:
      "Pitch is in ORIGINAL image pixels along the chosen axis. A pitch measured on a " +
      "perspective-compressed region is a local value — do not extrapolate it across the " +
      "whole facade without checking a second band.",
  };
}

/** Write an RGBA bitmap out as a PNG. */
function writePng(file: string, im: Bitmap): void {
  const png = new PNG({ width: im.w, height: im.h });
  png.data = Buffer.from(im.data);
  fs.writeFileSync(file, PNG.sync.write(png));
}

const clone = (im: Bitmap): Bitmap => ({ w: im.w, h: im.h, data: new Uint8Array(im.data) });

function setPx(im: Bitmap, x: number, y: number, c: [number, number, number]): void {
  if (x < 0 || y < 0 || x >= im.w || y >= im.h) return;
  const i = (y * im.w + x) * 4;
  im.data[i] = c[0]; im.data[i + 1] = c[1]; im.data[i + 2] = c[2]; im.data[i + 3] = 255;
}

/**
 * compare_images core: the evidence pack, in one call.
 *
 * Every run so far hand-built these — blends, wipes, side-by-sides — and the
 * building of them is not where the thinking is. Three images, because each
 * answers a different question: the blend shows drift everywhere at once, the
 * wipe shows detail alignment without transparency muddying it, and the edge
 * plot isolates silhouette disagreement from shading disagreement.
 */
export function compareImages(imageA: string, imageB: string, outDir: string) {
  const a = decodeImage(imageA);
  const b = resize(decodeImage(imageB), a.w, a.h);
  fs.mkdirSync(outDir, { recursive: true });

  const overlay = clone(a);
  for (let i = 0; i < overlay.data.length; i += 4) {
    for (let c = 0; c < 3; c++) overlay.data[i + c] = (a.data[i + c] + b.data[i + c]) >> 1;
    overlay.data[i + 3] = 255;
  }

  const wipe = clone(a);
  const split = a.w >> 1;
  for (let y = 0; y < a.h; y++) {
    for (let x = split; x < a.w; x++) {
      const i = (y * a.w + x) * 4;
      for (let c = 0; c < 3; c++) wipe.data[i + c] = b.data[i + c];
      wipe.data[i + 3] = 255;
    }
    setPx(wipe, split, y, [255, 230, 0]);
  }

  // Both silhouettes on A: A's edges cyan, B's magenta. Where they coincide
  // the magenta lands on top of the cyan — agreement reads as one colour.
  const sA = silhouette(a);
  const sB = silhouette(b);
  const edge = clone(a);
  for (let y = 0; y < a.h; y++) {
    for (const [s, col] of [[sA, [0, 220, 255]], [sB, [255, 0, 200]]] as [SilRow[], [number, number, number]][]) {
      const r = s[y];
      if (r.width <= 0) continue;
      for (const x of [r.left, r.right]) {
        setPx(edge, x, y, col);
        setPx(edge, x + 1, y, col);
      }
    }
  }

  const paths = {
    overlay: path.join(outDir, "overlay.png"),
    wipe: path.join(outDir, "wipe.png"),
    edge_diff: path.join(outDir, "edge_diff.png"),
  };
  writePng(paths.overlay, overlay);
  writePng(paths.wipe, wipe);
  writePng(paths.edge_diff, edge);

  return {
    imageA,
    imageB,
    compared_at: [a.w, a.h],
    images: paths,
    legend: {
      overlay: "50% blend — ghosting shows where the two disagree, everywhere at once",
      wipe: `left half A, right half B, split at x=${split} (yellow line)`,
      edge_diff: "A as base; A silhouette cyan, B silhouette magenta — one colour = agreement",
    },
    // The numbers and the pictures come from the SAME detector, so a defect
    // you can see in edge_diff is the defect the score is counting.
    score: scoreImages(imageB, imageA),
    notes:
      "B is resized to A before comparison. A is the base/reference; pass the photograph " +
      "as imageA and the render as imageB to keep the score's sign conventions meaningful.",
  };
}

/**
 * classify_reference core: evidence for reference class and view topology.
 * Reports MEASUREMENTS with hints, never a bare verdict — classification is
 * Step 1's judgement; this makes the judgement cheap and grounded.
 */
export function classifyReference(path: string, crop?: Crop): Record<string, unknown> {
  const full = decodeImage(path);
  const { im, ox, oy } = applyCrop(full, crop);
  const sil = silhouette(im);
  const allRows = boundedRows(sil, im.w);
  const pitch = floorPitch(im, sil);

  // Work on the largest CONTIGUOUS bounded run — detached bounded bands are
  // foreground (trees, clutter) that happens to clear the margins.
  const runs: number[][] = [];
  for (const y of allRows) {
    const cur = runs[runs.length - 1];
    if (cur && y - cur[cur.length - 1] <= 3) cur.push(y);
    else runs.push([y]);
  }
  const rows = runs.reduce((a, b) => (b.length > a.length ? b : a), [] as number[]);

  // Vertical-edge slopes, Theil–Sen (median of pairwise slopes): a foreground
  // canopy crossing the edge is an outlier to a median, a disaster to least
  // squares.
  const fit = (side: "left" | "right") => {
    if (rows.length < 20) return null;
    const step = Math.max(1, (rows.length / 40) | 0);
    const pts: [number, number][] = [];
    for (let i = 0; i < rows.length; i += step) pts.push([rows[i], sil[rows[i]][side]]);
    const slopes: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const dy = pts[j][0] - pts[i][0];
        if (Math.abs(dy) > 20) slopes.push((pts[j][1] - pts[i][1]) / dy);
      }
    }
    return slopes.length ? Math.round(median(slopes) * 10000) / 10000 : null;
  };
  const leftSlope = fit("left"), rightSlope = fit("right");

  // End-pitch asymmetry: column-luma profile across the subject at mid-height,
  // autocorrelated separately for the left and right halves. Tighter pitch at
  // one end = that end recedes = a second face is visible (Step 1's topology
  // falsification, as a number).
  let endPitch: { left: ReturnType<typeof autocorrPeaks>; right: ReturnType<typeof autocorrPeaks> } | null = null;
  if (rows.length > 60) {
    const midRows = rows.slice((rows.length * 0.45) | 0, (rows.length * 0.65) | 0);
    // Median edges, not extrema: one occluded row must not collapse the span.
    const l0 = Math.round(median(midRows.map((y) => sil[y].left)));
    const r0 = Math.round(median(midRows.map((y) => sil[y].right)));
    if (r0 - l0 > 80) {
      const prof: number[] = [];
      for (let x = l0; x <= r0; x++) {
        let s = 0;
        for (const y of midRows) {
          const p = px(im, x, y);
          s += luma(p[0], p[1], p[2]);
        }
        prof.push(s / midRows.length);
      }
      const half = prof.length >> 1;
      endPitch = {
        left: autocorrPeaks(prof.slice(0, half)),
        right: autocorrPeaks(prof.slice(half)),
      };
    }
  }

  const hints: string[] = [];
  if (rows.length < 20) {
    hints.push(
      "sky-bounded detection failed (occluded or cluttered margins) — the numeric " +
      "evidence below is unavailable; classify by eye per Step 1 and say so" +
      (crop
        ? ", or move the crop off the occluding foreground"
        : ". Aim it: re-run with `crop` around the clear part of the subject — that " +
          "converts a blind detector into a measured one"),
    );
  }
  // Does the silhouette narrow towards the top? If so its side edges are a
  // roof or a taper, not walls, and their slope says nothing about camera
  // tilt. Worth testing explicitly: a gable seen through a crop produces the
  // exact convergence signature of a tilted camera, and the two calls for
  // opposite responses.
  let taper: number | null = null;
  if (rows.length > 40) {
    const w = (ys: number[]) => median(ys.map((y) => sil[y].width));
    const topW = w(rows.slice(0, Math.max(4, (rows.length * 0.2) | 0)));
    const botW = w(rows.slice(-Math.max(4, (rows.length * 0.2) | 0)));
    if (botW > 0) taper = Math.round((topW / botW) * 1000) / 1000;
  }
  const tapers = taper !== null && taper < 0.75;

  if (leftSlope !== null && rightSlope !== null) {
    if (Math.abs(leftSlope) < 0.02 && Math.abs(rightSlope) < 0.02) {
      hints.push("verticals ~parallel: no tilt — archviz/elevated behaviour, shifted lens possible");
    } else if (leftSlope < -0.03 && rightSlope > 0.03) {
      hints.push(
        tapers
          ? `edges converge upward, but the silhouette is only ${Math.round(taper! * 100)}% as wide ` +
            "at the top as at the bottom — these side edges are a ROOF SLOPE or a taper, not " +
            "walls, so this says nothing about camera tilt. Judge tilt from the wall verticals " +
            "instead (crop below the eaves and re-run)."
          : "edges converge upward: tilted ground-level camera — solve the camera before measuring",
      );
    }
  }
  const strongest = (b?: PitchBand) => b?.peaks?.[0]?.pitch_px;
  const top = strongest(pitch.find((b) => b.band === "top"));
  const bottom = strongest(pitch.find((b) => b.band === "bottom"));
  const solid = (v?: number): v is number => v !== undefined && v >= NOISE_FLOOR_PX;
  if (solid(top) && solid(bottom) && Math.abs(bottom / top - 1) > 0.15) {
    hints.push(`vertical pitch drifts ${top}→${bottom} px between bands: non-linear perspective — use local ratios, not one global scale`);
  } else if ((top !== undefined && top < NOISE_FLOOR_PX) || (bottom !== undefined && bottom < NOISE_FLOOR_PX)) {
    hints.push(
      `a band's strongest pitch (${[top, bottom].filter((v) => v !== undefined && v < NOISE_FLOOR_PX).join(", ")} px) is at the ` +
      `~${NOISE_FLOOR_PX} px noise floor, so the linearity test is inconclusive there — ` +
      "re-measure that band with measure_pitch on a magnified crop before concluding anything",
    );
  }

  const epL = endPitch?.left?.[0]?.pitch_px, epR = endPitch?.right?.[0]?.pitch_px;
  const epRatio = solid(epL) && solid(epR) ? Math.max(epL, epR) / Math.min(epL, epR) : null;
  if (epRatio !== null && epRatio > 4) {
    // Foreshortening between two faces of one building is a factor of ~1.2–3.
    // Beyond 4x the two ends are not measuring the same kind of thing — one
    // is picking up a different feature, or sky, or noise.
    hints.push(
      `end pitches differ by ${Math.round(epRatio * 10) / 10}x (${epL} vs ${epR} px), which is too ` +
      "extreme for perspective between two faces of one building — one end is likely " +
      "measuring a different feature or empty sky. Treat the two-faces question as open " +
      "and test it with measure_pitch (axis 'horizontal') on each end separately.",
    );
  } else if (epRatio !== null && Math.abs(epL! / epR! - 1) > 0.15) {
    hints.push(`repeating-unit pitch differs between ends (${epL} vs ${epR} px): a second face is likely visible — run the corner→yaw recipe`);
  } else if ((epL !== undefined && epL < NOISE_FLOOR_PX) || (epR !== undefined && epR < NOISE_FLOOR_PX)) {
    // The asymmetry test compares two numbers; if either is noise the ratio
    // between them is noise too, however large and convincing it looks.
    hints.push(
      `end-pitch comparison skipped: one end measured ${Math.min(epL ?? 99, epR ?? 99)} px, at the ` +
      `~${NOISE_FLOOR_PX} px noise floor. The ratio would be meaningless — aim measure_pitch ` +
      "(axis 'horizontal') at each end separately to test for a second face.",
    );
  }

  // Failed first contact loses the agent — the field run that saw "5 usable
  // rows" never called this tool again and rebuilt its own scanners. So when
  // the full-frame scan is blind and nobody aimed us, aim ourselves: retry on
  // interior crops (occluders live at the margins) and keep the best answer.
  // Judgement still beats this — an agent-aimed crop found 279 rows where the
  // best auto-crop finds fewer — but a partial answer keeps the conversation
  // going where a blind failure ended it.
  if (!crop && rows.length < 20) {
    let best: { result: Record<string, unknown>; rows: number; region: Crop } | null = null;
    for (const inset of [0.12, 0.24]) {
      const region: Crop = {
        x0: full.w * inset, y0: full.h * inset,
        x1: full.w * (1 - inset), y1: full.h * (1 - inset),
      };
      const candidate = classifyReference(path, region);
      const cRows = (candidate.evidence as { sky_bounded_rows: number }).sky_bounded_rows;
      if (cRows >= 20 && (!best || cRows > best.rows)) best = { result: candidate, rows: cRows, region };
    }
    if (best) {
      const r = best.result;
      (r.hints as string[]).unshift(
        `full-frame scan was blind (${rows.length} usable rows — occluded margins); this result ` +
        `comes from an automatic interior crop [${Math.round(best.region.x0)},${Math.round(best.region.y0)},` +
        `${Math.round(best.region.x1)},${Math.round(best.region.y1)}] which found ${best.rows}. ` +
        "An aimed crop around the clear part of the subject will beat this — re-run with `crop` if " +
        "these numbers look partial.",
      );
      r.auto_cropped = true;
      return r;
    }
  }

  return {
    image: path,
    size: [full.w, full.h],
    scanned_region: crop ? { x0: ox, y0: oy, x1: ox + im.w, y1: oy + im.h } : null,
    evidence: {
      sky_bounded_rows: rows.length,
      vertical_edge_slopes: { left: leftSlope, right: rightSlope },
      /** Top width / bottom width. Well under 1 means the side edges are a
       *  roof or taper, so their slope is not evidence about camera tilt. */
      silhouette_taper_top_over_bottom: taper,
      vertical_pitch_bands: pitch,
      end_pitch_mid_band: endPitch,
    },
    hints,
    notes:
      "Evidence, not a verdict: Step 1 owns the classification. Missing evidence " +
      "(few sky-bounded rows, no repeating elements) means the detectors could not " +
      "see — not that the property is absent.",
  };
}

/**
 * Per-column skyline — the TRANSPOSE of the row-wise silhouette. Wide
 * subjects (houses) are sky-bounded in almost no rows, so the row scan comes
 * back empty on them while a column scan of the same image yields hundreds of
 * comparable columns. Field-discovered (the run's silh.py); also lives in the
 * workspace gate's scripts/score.mjs — keep the two in step.
 */
function skyline(im: Bitmap, tol = 42): number[] {
  const out = new Array<number>(im.w).fill(-1);
  const yMax = Math.min(14, im.h);
  for (let x = 0; x < im.w; x++) {
    const ch: number[][] = [[], [], []];
    for (let y = 2; y < yMax; y++) {
      const p = px(im, x, y);
      ch[0].push(p[0]); ch[1].push(p[1]); ch[2].push(p[2]);
    }
    const sky = [median(ch[0]), median(ch[1]), median(ch[2])];
    let run = 0;
    for (let y = 2; y < im.h; y++) {
      const p = px(im, x, y);
      const d = Math.hypot(p[0] - sky[0], p[1] - sky[1], p[2] - sky[2]);
      run = d > tol ? run + 1 : 0;
      if (run >= 4) { out[x] = y - 3; break; }
    }
  }
  return out;
}

type WorstSegment = {
  x0: number; x1: number; columns: number; mean_err_px: number; direction: string;
};

/**
 * The worst contiguous stretches of skyline, with a direction for each.
 *
 * The score says HOW MUCH is wrong; nothing said WHERE. Refinement passes cost
 * 6-10 minutes each and most of that is LOOKING — opening the evidence pack and
 * deciding which element is off. The agent already knows which element spans
 * columns 1180-1400 (it measured them), so a located error turns a judgement
 * call into a lookup. Mirrored in the workspace gate's scripts/score.mjs —
 * keep the two in step.
 *
 * Signed convention: image y grows DOWNWARD, so a render row SMALLER than the
 * photograph's means the render's top edge sits HIGHER in the frame.
 */
function worstSegments(cols: number[], signed: number[], limit = 3): WorstSegment[] | null {
  const abs = signed.map((v) => Math.abs(v));
  // Noise floor: 4 px, or 60% of the MEAN column error. The first version used
  // 1.5x the median, which went silent exactly when localisation mattered most:
  // on a first massing whose whole silhouette was wrong (mean 381 px), the
  // median-based threshold rose past every column and worst_segments came back
  // null. Mean-relative keeps the floor above noise on a converged render
  // (mean ~0 -> floor 4 px) while still naming the worst regions of a disaster.
  const mean = abs.length ? abs.reduce((a, b) => a + b, 0) / abs.length : 0;
  const thr = Math.max(4, mean * 0.6);
  type Run = { x0: number; x1: number; sign: number; errs: number[] };
  const segs: Run[] = [];
  let cur: Run | null = null;
  for (let i = 0; i < cols.length; i++) {
    if (abs[i] <= thr) continue;
    const sign = Math.sign(signed[i]);
    // Bridge small gaps, never a sign flip: two adjacent errors in opposite
    // directions are two different fixes.
    if (cur && cols[i] - cur.x1 <= 12 && cur.sign === sign) {
      cur.errs.push(abs[i]);
      cur.x1 = cols[i];
    } else {
      if (cur) segs.push(cur);
      cur = { x0: cols[i], x1: cols[i], sign, errs: [abs[i]] };
    }
  }
  if (cur) segs.push(cur);
  const out = segs
    .filter((s) => s.errs.length >= 12)
    .map((s) => {
      const meanAbs = s.errs.reduce((a, b) => a + b, 0) / s.errs.length;
      return {
        seg: {
          x0: s.x0,
          x1: s.x1,
          columns: s.errs.length,
          mean_err_px: Math.round(meanAbs * 10) / 10,
          direction:
            s.sign < 0
              ? "render skyline too HIGH (render top edge is above the photograph's)"
              : "render skyline too LOW (render top edge is below the photograph's)",
        },
        // Rank by total error mass, not peak: a 300-column band off by 20 px is
        // a bigger fix than a 15-column spike off by 40.
        mass: meanAbs * s.errs.length,
      };
    })
    .sort((a, b) => b.mass - a.mass)
    .slice(0, limit)
    .map((e) => e.seg);
  return out.length ? out : null;
}

function skylineScore(ref: Bitmap, ren: Bitmap) {
  const a = skyline(ref), b = skyline(ren);
  const errs: number[] = [];
  const signed: number[] = [];
  const cols: number[] = [];
  for (let x = Math.round(ref.w * 0.03); x < ref.w * 0.97; x++) {
    if (a[x] >= 0 && b[x] >= 0) { errs.push(Math.abs(a[x] - b[x])); signed.push(b[x] - a[x]); cols.push(x); }
  }
  if (!errs.length) return null;
  const mean = (v: number[]) => (v.length ? Math.round((v.reduce((s, e) => s + e, 0) / v.length) * 10) / 10 : null);
  const third = Math.floor(errs.length / 3);
  const worst = worstSegments(cols, signed);
  return {
    mean_top_error_px: mean(errs),
    top_error_by_band: {
      left: mean(errs.slice(0, third)),
      middle: mean(errs.slice(third, 2 * third)),
      right: mean(errs.slice(2 * third)),
    },
    max_top_error_px: Math.max(...errs),
    columns_compared: errs.length,
    /** WHERE the error is, in original-image columns. Fix the top one first. */
    worst_segments: worst,
    ...(worst
      ? { worst_segments_note: "x0/x1 are image columns. Identify which element spans them (you measured it), fix that element, re-render." }
      : {}),
  };
}

/** Score a render against a reference: both scanned with the SAME detector. */
export function scoreImages(renderPath: string, refPath: string) {
  const ref = decodeImage(refPath);
  const ren = resize(decodeImage(renderPath), ref.w, ref.h);
  const sRef = silhouette(ref);
  const sRen = silhouette(ren);

  const bRef = new Set(boundedRows(sRef, ref.w));
  const bRen = new Set(boundedRows(sRen, ren.w));
  const bothAll = [...bRef].filter((y) => bRen.has(y)).sort((a, b) => a - b);

  // Compare only the largest CONTIGUOUS run of mutually sky-bounded rows —
  // that is the subject. Detached bounded bands elsewhere are foreground
  // texture (sea foam, street clutter) that happens to contrast with the
  // margins, and comparing them scores the staging, not the building.
  const runs: number[][] = [];
  for (const y of bothAll) {
    const cur = runs[runs.length - 1];
    if (cur && y - cur[cur.length - 1] <= 3) cur.push(y);
    else runs.push([y]);
  }
  const both = runs.reduce((a, b) => (b.length > a.length ? b : a), [] as number[]);

  let edgeErr = 0, edgeMax = 0, n = 0;
  const perRow: number[] = [];
  for (const y of both) {
    const e = (Math.abs(sRef[y].left - sRen[y].left) + Math.abs(sRef[y].right - sRen[y].right)) / 2;
    edgeErr += e; edgeMax = Math.max(edgeMax, e); n++;
    perRow.push(e);
  }
  // Thirds of the compared span — a mean that is fine in one band and wild in
  // another localises the defect (top assembly vs shaft vs base).
  const bandMean = (a: number[]) =>
    a.length ? Math.round((a.reduce((s, v) => s + v, 0) / a.length) * 10) / 10 : null;
  const third = Math.floor(perRow.length / 3);
  const edgeByBand = {
    top: bandMean(perRow.slice(0, third)),
    middle: bandMean(perRow.slice(third, 2 * third)),
    bottom: bandMean(perRow.slice(2 * third)),
  };

  const area = (s: SilRow[]) => both.reduce((sum, y) => sum + s[y].width, 0);
  // Tip = first row where a subject at least 3 px wide persists for 5
  // consecutive rows — spires and masts are thin, noise is thinner still.
  const top = (s: SilRow[], w: number) => {
    let streak = 0;
    for (let y = 0; y < s.length; y++) {
      const ok = s[y].width >= 3 && s[y].left > 0 && s[y].right < w - 1;
      streak = ok ? streak + 1 : 0;
      if (streak >= 5) return y - 4;
    }
    return null;
  };

  const inLuma = (im: Bitmap, s: SilRow[]) => {
    const vals: number[] = [];
    for (let y = 0; y < im.h; y++) {
      const { left, right, width } = s[y];
      if (width < im.w * 0.05) continue;
      for (let x = left; x <= right; x += 2) {
        const p = px(im, x, y); vals.push(luma(p[0], p[1], p[2]));
      }
    }
    vals.sort((a, b) => a - b);
    const at = (f: number) => Math.round(vals[Math.min(vals.length - 1, (vals.length * f) | 0)] * 10) / 10;
    return vals.length
      ? { mean: Math.round((vals.reduce((s2, v) => s2 + v, 0) / vals.length) * 10) / 10, p10: at(0.1), p50: at(0.5), p90: at(0.9) }
      : null;
  };

  const skyAt = (im: Bitmap, fr: number) => {
    const s = rowSkyLR(im, Math.min(im.h - 1, Math.round(im.h * fr)));
    const m = skyAtX(s, im.w >> 1, im.w);
    return Math.round(luma(m[0], m[1], m[2]) * 10) / 10;
  };

  const refTop = top(sRef, ref.w), renTop = top(sRen, ren.w);
  return {
    reference: refPath,
    render: renderPath,
    scored_at: [ref.w, ref.h],
    silhouette: {
      mean_edge_error_px: n ? Math.round((edgeErr / n) * 10) / 10 : null,
      edge_error_by_band: edgeByBand,
      max_edge_error_px: edgeMax,
      rows_compared: n,
      area_ratio: Math.round((area(sRen) / Math.max(1, area(sRef))) * 1000) / 1000,
      top_row: { ref: refTop, render: renTop, delta: refTop !== null && renTop !== null ? renTop - refTop : null },
    },
    // Column-wise skyline — the primary silhouette signal on wide/occluded
    // subjects where rows_compared is small. Trust the axis that compared
    // more of the subject.
    skyline: skylineScore(ref, ren),
    in_silhouette_luma: { ref: inLuma(ref, sRef), render: inLuma(ren, sRen) },
    // Shared vocabulary with the viewer's __measure(): lit/shadow band luma and
    // their ratio, so the skill's Step 4 tuning map applies to this output too.
    bands: { ref: bandStats(ref, sRef), render: bandStats(ren, sRen) },
    sky_luma: [0.05, 0.2, 0.4, 0.6, 0.75].map((f) => ({
      at_height_frac: f, ref: skyAt(ref, f), render: skyAt(ren, f),
    })),
    notes:
      "Identity features (bracing pitch, bay rhythm, feature counts) are NOT covered by " +
      "these metrics — give them their own targets and check them by eye every pass.",
  };
}
