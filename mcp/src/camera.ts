/**
 * solve_camera: vanishing-point algebra, done once and checked.
 *
 * This is the single largest time sink in every observed run — not finding
 * the lines (the agent is good at that, and picking them is judgement that
 * stays with the agent) but the algebra afterwards: one run spent ~40 minutes
 * on a two-VP solve, another spiralled ~30 minutes through five
 * re-derivations with sign slips. That is a deterministic computation being
 * done by hand, repeatedly, with arithmetic errors. It belongs in code.
 *
 * Two commitments make the output trustworthy rather than merely confident:
 *
 *  - Residuals travel with every fit, and a leave-one-out pass predicts a
 *    line that was not used to fit its own vanishing point. A solve that
 *    cannot predict a line it did not see is reported as such.
 *  - The principal-point / focal-length ambiguity is stated, not hidden. Two
 *    vanishing points cannot pin both; three can. The result always says
 *    which case it was in and what was assumed.
 *
 * When the input is inconsistent the answer is "inconsistent, and here is the
 * line that disagrees" — never a forced number. An impossible answer means a
 * broken method, not a weird building.
 */

export interface Segment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Family name: lines sharing a real-world direction (eave, sill, ridge…). */
  label?: string;
}

export interface KnownScale {
  /** Real height of the subject spanned by the vertical lines, in metres. */
  height_m?: number;
  /** Roof pitch, if the agent already measured it — reported back, not fitted. */
  pitch_deg?: number;
  /**
   * How to treat the principal point.
   *
   * `"centre"` (the default) assumes the frame centre. That is right for an
   * uncropped photograph off a normal camera, and it is deliberately the
   * default because the alternative is noise-sensitive: the orthocentre of
   * three vanishing points is exact on perfect input but amplifies pick
   * error badly, and a picked line is accurate to a pixel or three at best.
   *
   * `"solve"` derives it from the three vanishing points. Use it only when
   * the image is known to be cropped or shot on a shift lens, and only with
   * carefully picked lines — the result reports which was used either way.
   */
  principal_point?: "centre" | "solve";
}

type Vec3 = [number, number, number];

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 => {
  const n = norm(a) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};
const deg = (r: number) => (r * 180) / Math.PI;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r4 = (v: number) => Math.round(v * 10000) / 10000;

/**
 * Eigen-decomposition of a symmetric 3x3 by cyclic Jacobi rotation.
 * Small, exact enough, and — unlike a closed-form cubic — does not lose
 * precision when two eigenvalues are close, which is exactly what happens
 * when the supplied lines are nearly parallel.
 */
function jacobiEigen(m: number[][]): { values: number[]; vectors: number[][] } {
  const a = m.map((r) => [...r]);
  let v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  for (let sweep = 0; sweep < 64; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) for (let q = p + 1; q < 3; q++) off += a[p][q] * a[p][q];
    if (off < 1e-24) break;
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 3; q++) {
        if (Math.abs(a[p][q]) < 1e-30) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
  }
  return { values: [a[0][0], a[1][1], a[2][2]], vectors: v };
}

/** Homogeneous line through a segment's endpoints, scaled so that l·(x,y,1)
 *  is a signed distance in pixels. */
function lineOf(s: Segment): Vec3 {
  const l = cross([s.x0, s.y0, 1], [s.x1, s.y1, 1]);
  const n = Math.hypot(l[0], l[1]) || 1;
  return [l[0] / n, l[1] / n, l[2] / n];
}

/** Least-squares vanishing point: the direction minimising Σ(l·v)². */
function fitVp(lines: Vec3[]): Vec3 {
  const m = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ];
  for (const l of lines) {
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i][j] += l[i] * l[j];
  }
  const { values, vectors } = jacobiEigen(m);
  let k = 0;
  for (let i = 1; i < 3; i++) if (values[i] < values[k]) k = i;
  return unit([vectors[0][k], vectors[1][k], vectors[2][k]]);
}

/** Pixel distance from the (finite) vanishing point to a line. Infinite-ish
 *  vanishing points are reported as such rather than as a huge number. */
function residual(l: Vec3, v: Vec3): number | null {
  if (Math.abs(v[2]) < 1e-9) return null;
  return Math.abs(dot(l, v) / v[2]);
}

const med = (xs: number[]) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[n >> 1] : 0.5 * (s[(n >> 1) - 1] + s[n >> 1]);
};

interface Family {
  label: string;
  count: number;
  segments: Segment[];
  lines: Vec3[];
  vp: Vec3;
  finite: boolean;
  point: [number, number] | null;
  residuals: (number | null)[];
  maxResidual: number | null;
  medResidual: number | null;
  loo: { worst: number | null; median: number | null } | null;
  vertical: boolean;
}

/**
 * Auto-label when the agent supplies none: near-image-vertical lines are the
 * vertical family, the rest split by slope sign — the ordinary corner-view
 * case. Reported back explicitly so a wrong guess is visible, not silent.
 */
function autoLabel(s: Segment): string {
  const dx = s.x1 - s.x0, dy = s.y1 - s.y0;
  if (Math.abs(dy) > Math.abs(dx) / Math.tan((25 * Math.PI) / 180)) return "vertical";
  return (dy / (dx || 1e-9)) < 0 ? "horizontal-a" : "horizontal-b";
}

/**
 * Normalise however the caller spelled family membership into real families.
 *
 * Order: honour explicit shared labels; else cluster by label prefix (the
 * spelling both field agents used); else fall back to direction. The choice is
 * reported so a wrong guess is visible rather than silent — same contract as
 * the scanners' auto-crop.
 */
function groupFamilies(segments: Segment[]): {
  labelled: (Segment & { label: string })[];
  grouping: "as-given" | "prefix" | "direction";
} {
  const given = segments.filter((s) => s.label && s.label.trim().length);
  if (given.length === segments.length) {
    const counts = new Map<string, number>();
    for (const s of segments) counts.set(s.label!, (counts.get(s.label!) ?? 0) + 1);
    const singles = [...counts.values()].filter((n) => n === 1).length;
    // Mostly-singleton labels mean the caller named LINES, not families.
    if (singles <= counts.size / 2) {
      return { labelled: segments.map((s) => ({ ...s, label: s.label! })), grouping: "as-given" };
    }
    const prefixOf = (l: string) => l.split(/[-_.]/)[0] || l;
    const pc = new Map<string, number>();
    for (const s of segments) pc.set(prefixOf(s.label!), (pc.get(prefixOf(s.label!)) ?? 0) + 1);
    const prefixSingles = [...pc.values()].filter((n) => n === 1).length;
    if (pc.size >= 2 && prefixSingles <= pc.size / 2) {
      return {
        labelled: segments.map((s) => ({ ...s, label: prefixOf(s.label!) })),
        grouping: "prefix",
      };
    }
  }
  return { labelled: segments.map((s) => ({ ...s, label: s.label ?? autoLabel(s) })), grouping: "direction" };
}

export function solveCamera(
  size: [number, number],
  segments: Segment[],
  known?: KnownScale,
) {
  const [W, H] = size;
  const diag = Math.hypot(W, H);
  const warnings: string[] = [];

  if (segments.length < 4) {
    throw new Error(
      `solve_camera needs at least 4 line segments (got ${segments.length}) — ` +
      "two per family for two families, or it cannot fit anything to check.",
    );
  }

  // ---- Family grouping. Lines PARALLEL IN THE WORLD must land in one family;
  // how the caller spells that is not something to be strict about. Two
  // independent field agents labelled every line individually with the family
  // as a prefix ('v-win1-jamb', 'R_ridge', 'G_uppersill') and got N singleton
  // families and a hard error. That is a schema defect, not agent error:
  // descriptive per-line names are the natural thing to write.
  const { labelled, grouping } = groupFamilies(segments);
  if (grouping === "prefix") {
    warnings.push(
      "labels looked per-line, so families were grouped by their common PREFIX " +
      "(text before the first '-', '_' or '.'). Check the families below — if the " +
      "grouping is wrong, re-send with one shared label per family.",
    );
  } else if (grouping === "direction") {
    warnings.push(
      "labels were missing or all distinct, so families were guessed from direction " +
      "(near-vertical → 'vertical', others split by slope sign). Check the grouping " +
      "below before trusting the pose; supply one shared label per family to control it.",
    );
  }

  const byLabel = new Map<string, Segment[]>();
  for (const s of labelled) {
    const arr = byLabel.get(s.label!) ?? [];
    arr.push(s);
    byLabel.set(s.label!, arr);
  }

  const families: Family[] = [];
  for (const [label, segs] of byLabel) {
    if (segs.length < 2) {
      warnings.push(`family '${label}' has only ${segs.length} line — skipped (a vanishing point needs 2)`);
      continue;
    }
    const lines = segs.map(lineOf);
    const vp = fitVp(lines);
    // "Finite" has to mean practically finite, not merely non-zero in the
    // homogeneous coordinate. A frontal elevation produced a vanishing point
    // 472 image-diagonals away and reported it as a real point, which then
    // contradicted the refusal message right beneath it. Anything past ~50
    // diagonals is a parallel family.
    const far = Math.abs(vp[2]) < 1e-9 || Math.hypot(vp[0] / vp[2] - W / 2, vp[1] / vp[2] - H / 2) > 50 * diag;
    const finite = !far;
    const residuals = lines.map((l) => residual(l, vp));

    // Leave-one-out: refit without each line, then measure that line against
    // a vanishing point it did not help create. This is the cross-check the
    // method's Step 2.5 asks for, as code — a fit always explains its own
    // input, so only a withheld line tests it.
    let loo: Family["loo"] = null;
    if (segs.length >= 3) {
      const errs: number[] = [];
      for (let i = 0; i < lines.length; i++) {
        const rest = lines.filter((_, j) => j !== i);
        const r = residual(lines[i], fitVp(rest));
        if (r !== null) errs.push(r);
      }
      if (errs.length) loo = { worst: Math.max(...errs), median: med(errs) };
    } else {
      warnings.push(`family '${label}' has 2 lines: fitted exactly, so its residuals are 0 by construction and prove nothing — add a third line to get a real check`);
    }

    families.push({
      label,
      count: segs.length,
      segments: segs,
      lines,
      vp,
      finite,
      point: finite ? [vp[0] / vp[2], vp[1] / vp[2]] : null,
      residuals,
      maxResidual: residuals.some((r) => r === null) ? null : Math.max(...(residuals as number[])),
      medResidual: med(residuals.filter((r): r is number => r !== null)),
      loo,
      // Vertical is a GEOMETRIC fact, not a naming convention. A field agent
      // labelled its verticals 'V-red-corner'/'V-white-gable-corner'; prefix
      // grouping correctly formed family 'V' — which then failed a
      // startsWith("vert") test, was fitted as a third horizontal family, and
      // produced a wrong focal length plus a locked unproject. A family is
      // vertical if its label says so OR most of its lines are near-vertical
      // in the image (same 25-degree test as the auto-labeller).
      vertical:
        /^(v|vert|vertical|plumb)/i.test(label) ||
        segs.filter((sg) => Math.abs(sg.y1 - sg.y0) > Math.abs(sg.x1 - sg.x0) / Math.tan((25 * Math.PI) / 180)).length * 2 > segs.length,
    });
  }

  const verticalFam = families.find((f) => f.vertical);
  const horizontals = families.filter((f) => !f.vertical);

  if (horizontals.length < 1) {
    throw new Error(
      "no horizontal family found — label lines by FAMILY, not per line: three eave " +
      "lines all labelled \"eave\" (or \"eave-a\"/\"eave-b\" for two facades), not " +
      "\"eave-left\"/\"eave-mid\"/\"eave-right\". Lines parallel in the WORLD share a label.",
    );
  }

  // ---- Horizon: the join of two horizontal vanishing points. Homogeneous
  // coordinates handle a family that vanishes at infinity without a branch.
  let horizon: Vec3 | null = null;
  if (horizontals.length >= 2) {
    horizon = cross(horizontals[0].vp, horizontals[1].vp);
    const n = Math.hypot(horizon[0], horizon[1]) || 1;
    horizon = [horizon[0] / n, horizon[1] / n, horizon[2] / n];
  }
  const horizonY = (x: number) => (horizon && Math.abs(horizon[1]) > 1e-9 ? -(horizon[0] * x + horizon[2]) / horizon[1] : null);

  // ---- Intrinsics.
  const centre: [number, number] = [W / 2, H / 2];
  let pp = centre;
  let ppSource = "assumed image centre";
  let focal: number | null = null;
  let inconsistent: string | null = null;

  const h0 = horizontals[0], h1 = horizontals[1];

  // Shifted-lens / cropped-frame branch. When the supplied verticals are
  // parallel in the image (vertical VP at infinity), the camera has NO tilt —
  // and then the horizon row IS the principal point's row. If that row is far
  // from the frame centre, the image is a crop or a shift-lens shot, and
  // assuming a centred principal point would convert the offset into a
  // spurious tilt (about 9 degrees on the field case that exposed this: a
  // 2000x890 hero crop of a 2000x1240 render — verticals parallel, horizon at
  // y=618, frame centre at 445; the agent derived the correct treatment by
  // hand while this tool would have got it wrong).
  //
  // The decision uses its OWN parallel test, deliberately tighter than the
  // `finite` flag used for reporting: a field solve fitted two short jambs to a
  // vanishing point 70,000 px away — parallel for every practical purpose, the
  // apparent convergence pure pick noise — and the 50-diagonal reporting cap
  // let it through as "finite", so this branch was skipped and the principal
  // point wrongly stayed at frame centre.
  //
  // The tightening cuts BOTH ways and the tower case is the one to protect: a
  // ground-level photograph of a tall building has REAL vertical convergence
  // (that is the method's textbook case) and must keep its tilt. So the branch
  // needs the verticals to be effectively parallel — VP beyond 8 diagonals, or
  // an implied tilt under 1.5° — before it treats the frame as shifted/cropped.
  const verticallyParallel = (() => {
    if (!verticalFam) return false;
    if (!verticalFam.finite) return true;
    const p = verticalFam.point;
    if (!p) return true;
    if (Math.hypot(p[0] - W / 2, p[1] - H / 2) > 8 * diag) return true;
    // Implied tilt from the vertical VP against a centre-assumed focal guess:
    // a VP this far out with so little offset cannot represent a real tilt.
    const guessF = Math.max(W, H);
    return Math.abs(deg(Math.atan2(guessF, Math.abs(p[1] - H / 2)))) > 88.5;
  })();

  if (verticalFam && verticallyParallel && h0?.point && h1?.point) {
    const hy = horizonY(W / 2);
    if (hy !== null && Math.abs(hy - H / 2) > H * 0.04) {
      pp = [W / 2, hy];
      ppSource =
        "horizon row (verticals are parallel ⇒ no tilt ⇒ the principal point sits on the " +
        "horizon — a cropped frame or shifted lens; reproduce with setViewOffset, never a tilt)";
    }
  }

  if (known?.principal_point === "solve" && h0?.point && h1?.point && verticalFam?.point) {
    // Three finite vanishing points pin the principal point: it is the
    // orthocentre of their triangle. This is the only case where the
    // cx/f trade-off is actually resolved rather than assumed.
    const [ax, ay] = h0.point, [bx, by] = h1.point, [cx, cy] = verticalFam.point;
    // Altitude from A ⟂ BC and altitude from B ⟂ AC, as a 2x2 system.
    const a1 = cx - bx, b1 = cy - by, c1 = a1 * ax + b1 * ay;
    const a2 = cx - ax, b2 = cy - ay, c2 = a2 * bx + b2 * by;
    const det = a1 * b2 - a2 * b1;
    if (Math.abs(det) > 1e-6) {
      pp = [(c1 * b2 - c2 * b1) / det, (a1 * c2 - a2 * c1) / det];
      ppSource = "orthocentre of the three vanishing points (three finite VPs pin it)";
    }
  }

  if (h0?.point && h1?.point) {
    const f2 = -((h0.point[0] - pp[0]) * (h1.point[0] - pp[0]) + (h0.point[1] - pp[1]) * (h1.point[1] - pp[1]));
    if (f2 > 0) focal = Math.sqrt(f2);
    else {
      inconsistent =
        `focal length came out imaginary (f² = ${r2(f2)}): the two horizontal families ` +
        `'${h0.label}' and '${h1.label}' are not consistent with a 90° corner seen through ` +
        `a camera whose principal point is ${ppSource}. Either the two families are not ` +
        "perpendicular in the world, or a line is mis-assigned — check the residuals below.";
    }
  } else if (verticalFam?.point && h0?.point) {
    const f2 = -((verticalFam.point[0] - pp[0]) * (h0.point[0] - pp[0]) + (verticalFam.point[1] - pp[1]) * (h0.point[1] - pp[1]));
    if (f2 > 0) {
      focal = Math.sqrt(f2);
      warnings.push(
        "focal length came from the vertical + one horizontal family. That pair is " +
        "orthogonal, so the algebra is valid, but with only one horizontal direction the " +
        "yaw of the building around the vertical is NOT determined — supply a second " +
        "horizontal family to fix it.",
      );
    }
  }

  if (!focal && !inconsistent) {
    inconsistent =
      "not enough finite vanishing points to recover a focal length. Two families vanish " +
      "at infinity (their lines are parallel in the image), which means the camera is " +
      "square-on to them — a shifted-lens/orthographic-like view. Set the focal length " +
      "from the lens if you know it, or supply lines from a receding direction.";
  }

  // ---- Pose, in camera coordinates (x right, y down, z forward).
  const dirOf = (f: Family | undefined): Vec3 | null => {
    if (!f || !focal) return null;
    // K⁻¹v for a finite or infinite vanishing point alike.
    return unit([(f.vp[0] - pp[0] * f.vp[2]) / focal, (f.vp[1] - pp[1] * f.vp[2]) / focal, f.vp[2]]);
  };

  let tilt: number | null = null;
  let roll: number | null = null;
  const yawTo: Record<string, number> = {};
  let up: Vec3 | null = null;

  const dV = dirOf(verticalFam);
  if (dV) {
    // World-up in camera coords: the sign that points up the image.
    up = dV[1] > 0 ? ([-dV[0], -dV[1], -dV[2]] as Vec3) : dV;
    const fwd: Vec3 = [0, 0, 1];
    // Angle of the optical axis above the horizontal plane.
    tilt = deg(Math.asin(Math.max(-1, Math.min(1, dot(fwd, up)))));
    roll = deg(Math.atan2(up[0], -up[1]));
    const fh = unit([fwd[0] - dot(fwd, up) * up[0], fwd[1] - dot(fwd, up) * up[1], fwd[2] - dot(fwd, up) * up[2]]);
    for (const f of horizontals) {
      const d = dirOf(f);
      if (!d) continue;
      const dh = unit([d[0] - dot(d, up) * up[0], d[1] - dot(d, up) * up[1], d[2] - dot(d, up) * up[2]]);
      yawTo[f.label] = r2(deg(Math.atan2(dot(cross(fh, dh), up), dot(fh, dh))));
    }
  } else {
    // Be accurate about WHY. Saying "no vertical family" when three vertical
    // lines were supplied sends the caller to fix the wrong thing.
    warnings.push(
      verticalFam
        ? "tilt/roll/yaw need a focal length, and none could be recovered — fix the cause " +
          "given in `inconsistent` first; the vertical family itself is fine"
        : "no vertical family, so tilt/roll/yaw are not recoverable — label 2–3 vertical edges 'vertical'",
    );
  }

  // ---- Orthogonality cross-check: the recovered directions must be mutually
  // perpendicular. This is independent of the residuals (a family can fit its
  // own lines perfectly and still sit in the wrong place).
  const orthoError: { pair: string; deg_from_90: number }[] = [];
  if (focal) {
    const withDir = families
      .map((f) => ({ f, d: dirOf(f) }))
      .filter((x): x is { f: Family; d: Vec3 } => x.d !== null);
    for (let i = 0; i < withDir.length; i++) {
      for (let j = i + 1; j < withDir.length; j++) {
        const a = deg(Math.acos(Math.max(-1, Math.min(1, Math.abs(dot(withDir[i].d, withDir[j].d))))));
        orthoError.push({ pair: `${withDir[i].f.label} ⟂ ${withDir[j].f.label}`, deg_from_90: r2(90 - a) });
      }
    }
  }

  // ---- Eye height: the horizon cuts a standing vertical at the camera's eye
  // height. Each vertical segment therefore reports it as a fraction of its
  // own height, with no extra input.
  let eye: {
    per_line: number[];
    fraction: number | null;
    height_m?: number;
    /** From the horizon + cross-ratio: eye height as a share of the height. */
    eye_height_m?: number;
    /** Solved metrically from the rays; agreement with the above is a check. */
    eye_height_m_metric?: number;
    horizontal_distance_m?: number;
  } | null = null;
  if (verticalFam && horizon) {
    const fracs: number[] = [];
    const bases: [number, number][] = [];
    const tops: [number, number][] = [];
    for (const s of verticalFam.segments) {
      const top: [number, number] = s.y0 < s.y1 ? [s.x0, s.y0] : [s.x1, s.y1];
      const bot: [number, number] = s.y0 < s.y1 ? [s.x1, s.y1] : [s.x0, s.y0];
      const x = (s.x0 + s.x1) / 2;
      const yh = horizonY(x);
      if (yh === null || bot[1] - top[1] < 1) continue;
      // Cross-ratio, not linear interpolation. The horizon cuts a standing
      // vertical at eye height, but image distance is not proportional to
      // world distance — the vertical vanishing point is the fourth point
      // that makes the ratio exact. Ignoring it biased this by ~7% on a
      // 12°-tilt synthetic camera, and the bias grows with tilt.
      const lin = (bot[1] - yh) / (bot[1] - top[1]);
      const yv = verticalFam.point?.[1];
      const exact =
        yv !== undefined && Math.abs(yh - yv) > 1e-6
          ? lin * ((top[1] - yv) / (yh - yv))
          : lin;
      fracs.push(exact);
      bases.push(bot);
      tops.push(top);
    }
    const fraction = med(fracs);
    if (fraction !== null) {
      eye = { per_line: fracs.map(r4), fraction: r4(fraction) };
      if (known?.height_m && known.height_m > 0) {
        eye.height_m = known.height_m;
        eye.eye_height_m = r2(fraction * known.height_m);
        // Metric placement, solved rather than approximated. A vertical edge
        // of known height fixes the scale outright: with rays through its two
        // endpoints and the world-up direction, λ_top·r_top − λ_base·r_base =
        // height·up is three equations in two unknowns. Least-squares it.
        if (focal && up && bases.length) {
          const ray = (p: [number, number]): Vec3 =>
            unit([(p[0] - pp[0]) / focal!, (p[1] - pp[1]) / focal!, 1]);
          const dists: number[] = [];
          const heights: number[] = [];
          for (let i = 0; i < bases.length; i++) {
            const rB = ray(bases[i]), rT = ray(tops[i]);
            const target: Vec3 = [known.height_m * up[0], known.height_m * up[1], known.height_m * up[2]];
            // Normal equations for [rT, -rB]·[λT, λB]ᵀ = target.
            const a11 = dot(rT, rT), a12 = -dot(rT, rB), a22 = dot(rB, rB);
            const b1 = dot(rT, target), b2 = -dot(rB, target);
            const det = a11 * a22 - a12 * a12;
            if (Math.abs(det) < 1e-9) continue;
            const lT = (b1 * a22 - a12 * b2) / det;
            const lB = (a11 * b2 - a12 * b1) / det;
            if (!(lB > 0) || !(lT > 0)) continue;
            const P: Vec3 = [lB * rB[0], lB * rB[1], lB * rB[2]];
            const toCam: Vec3 = [-P[0], -P[1], -P[2]];
            const hgt = dot(toCam, up);
            const horiz = Math.hypot(toCam[0] - hgt * up[0], toCam[1] - hgt * up[1], toCam[2] - hgt * up[2]);
            heights.push(hgt);
            dists.push(horiz);
          }
          const dm = med(dists), hm = med(heights);
          if (dm !== null) eye.horizontal_distance_m = r2(dm);
          if (hm !== null) eye.eye_height_m_metric = r2(hm);
        }
      }
      if (fraction < 0 || fraction > 1.2) {
        warnings.push(
          `the horizon falls outside the vertical segments (eye-height fraction ${r4(fraction)}). ` +
          "That is possible (looking down from above, or up from below the base) but it is " +
          "also what a mis-picked vertical or a wrong horizon looks like — verify by eye.",
        );
      }
    }
  }

  // ---- The camera block: the thing the agent actually needs to paste.
  let cameraBlock: Record<string, unknown> | null = null;
  if (focal) {
    const vfov = r2(deg(2 * Math.atan(H / (2 * focal))));
    const offCentre = Math.hypot(pp[0] - centre[0], pp[1] - centre[1]);
    // A principal point away from the frame centre is an asymmetric frustum.
    // Three.js expresses that as a symmetric frustum over a larger virtual
    // frame, cropped back to the render size — this is the setViewOffset
    // arithmetic runs have repeatedly rederived by hand.
    const fullW = 2 * Math.max(pp[0], W - pp[0]);
    const fullH = 2 * Math.max(pp[1], H - pp[1]);
    const offX = fullW / 2 - pp[0];
    const offY = fullH / 2 - pp[1];
    const fullFov = r2(deg(2 * Math.atan(fullH / (2 * focal))));
    const needsOffset = offCentre > 0.5;

    cameraBlock = {
      render_size: [W, H],
      fov_deg: needsOffset ? fullFov : vfov,
      aspect: needsOffset ? r4(fullW / fullH) : r4(W / H),
      set_view_offset: needsOffset
        ? { fullWidth: r2(fullW), fullHeight: r2(fullH), x: r2(offX), y: r2(offY), width: W, height: H }
        : null,
      orientation_deg: { tilt_above_horizontal: tilt === null ? null : r2(tilt), roll: roll === null ? null : r2(roll), yaw_to_family: yawTo },
      snippet: [
        `// focal ${r2(focal)} px, principal point ${ppSource}`,
        `const camera = new THREE.PerspectiveCamera(${needsOffset ? fullFov : vfov}, ${needsOffset ? r4(fullW / fullH) : r4(W / H)}, 0.1, 5000);`,
        needsOffset
          ? `camera.setViewOffset(${r2(fullW)}, ${r2(fullH)}, ${r2(offX)}, ${r2(offY)}, ${W}, ${H}); // principal point is off-centre`
          : `// principal point is within 0.5 px of centre — no setViewOffset needed`,
        eye?.horizontal_distance_m !== undefined
          ? `camera.position.set(0, ${eye.eye_height_m_metric ?? eye.eye_height_m}, ${eye.horizontal_distance_m}); // solved from the known height; place the subject's near vertical edge at the origin`
          : `camera.position.set(0, EYE_HEIGHT, DISTANCE); // supply known.height_m to get these`,
        tilt === null
          ? `camera.lookAt(0, TARGET_Y, 0);`
          : `camera.lookAt(0, ${
              eye?.horizontal_distance_m !== undefined
                ? r2((eye.eye_height_m_metric ?? eye.eye_height_m ?? 0) + eye.horizontal_distance_m * Math.tan((tilt * Math.PI) / 180))
                : "TARGET_Y"
            }, 0); // ${r2(tilt)}° above horizontal`,
      ].join("\n"),
    };
  }

  // ---- Verdict. Thresholds are stated so a caller can disagree with them.
  const allLoo = families.map((f) => f.loo?.worst).filter((v): v is number => v !== undefined && v !== null);
  const worstLoo = allLoo.length ? Math.max(...allLoo) : null;

  // Name the single worst line. "Check the residuals" is a chore; "line 3 of
  // 'eave-a', the one from (648,690) to (1090,700), misses by 2470 px" is an
  // instruction — and re-picking one line is nearly always the actual fix.
  let culprit: string | null = null;
  {
    let worst = -1;
    for (const f of families) {
      f.residuals.forEach((r, i) => {
        if (r !== null && r > worst) {
          worst = r;
          const s = f.segments[i];
          culprit =
            `line ${i + 1} of ${f.count} in family '${f.label}' — ` +
            `(${Math.round(s.x0)},${Math.round(s.y0)})→(${Math.round(s.x1)},${Math.round(s.y1)}), ` +
            `missing its own vanishing point by ${r2(r)} px`;
        }
      });
    }
  }
  if (inconsistent && culprit) inconsistent += ` Worst offender: ${culprit}.`;
  const worstOrtho = orthoError.length ? Math.max(...orthoError.map((o) => Math.abs(o.deg_from_90))) : null;
  const verdict = inconsistent
    ? "inconsistent"
    : worstLoo !== null && worstLoo > diag * 0.02
      ? "weak"
      : worstOrtho !== null && worstOrtho > 8
        ? "weak"
        : "usable";

  if (verdict === "weak") {
    warnings.push(
      "the fit is weak: either a withheld line missed its own vanishing point by more than " +
      "2% of the image diagonal, or the recovered axes are more than 8° from perpendicular. " +
      "This is common with hand-picked lines and it is worth acting on — over randomised " +
      "cameras, 'usable' fits kept focal error under ~12% while 'weak' ones reached 48%. " +
      "The fix is nearly always the picking, not the solver: use the LONGEST runs of each " +
      "family you can see, spread them apart rather than clustering them, and re-pick the " +
      "worst line named in cross_check.worst_line. Endpoint accuracy is what matters — a " +
      "short line pinned to two fuzzy pixels aims its vanishing point badly.",
    );
  }

  // ---- Routing block. Two rules decayed in three consecutive field runs —
  // "massing before detail" and "unlock unproject by supplying verticals" — and
  // both lived in skill prose. Tool RESULTS are read on every call; prose is not.
  // So the instruction ships in the result, next to the numbers it depends on.
  // Count what was SUPPLIED, not what survived: a family of one line is
  // dropped before it becomes a Family, and "0 verticals" would be a lie to an
  // agent that supplied one. Run 5 supplied exactly one.
  const verticalCount = verticalFam
    ? verticalFam.count
    : labelled.filter(
        (sg) =>
          /^(v|vert|vertical|plumb)/i.test(sg.label) ||
          Math.abs(sg.y1 - sg.y0) > Math.abs(sg.x1 - sg.x0) / Math.tan((25 * Math.PI) / 180),
      ).length;
  const unprojectReady = Boolean(focal && up);
  const nextSteps: string[] = [];
  if (!unprojectReady) {
    // First, and loud: this is the single largest saving the server offers and
    // run 5 never engaged it, because nothing said it was off.
    nextSteps.push(
      `WARNING: unproject is LOCKED — no usable vertical family was formed (${verticalCount} ` +
      "vertical line(s) supplied; 2–3 are needed: window jambs, building corners, downpipes, " +
      "labelled 'vertical'). One more solve_camera call with those lines unlocks " +
      "world-coordinate feature placement, which replaces per-feature pixel measurement " +
      "outright — a field run spent ~25 minutes measuring what unproject returns in one call.",
    );
  }
  if (verdict === "weak") {
    nextSteps.push(
      "Re-pick one line before building: " +
      (culprit ? `${culprit} — replace it ` : "replace the worst line named in cross_check.worst_line ") +
      "with the longest, cleanest run of that family you can see, then solve again. Re-picking " +
      "is minutes; the geometry a weak fit distorts costs hours.",
    );
  } else if (verdict === "inconsistent") {
    nextSteps.push(
      "Do not build on this solve — it is inconsistent (see `inconsistent`). Fix the picking " +
      "first: longest runs, spread apart, endpoints on features you can actually see. Derived " +
      "quantities are withheld deliberately; do not reconstruct them by hand.",
    );
  }
  if (verdict !== "inconsistent") {
    // Routing that does NOT depend on the verdict. Three consecutive field
    // runs — two web, one Blender — proceeded to build on a `weak` solve, and
    // because this instruction used to ship only with `usable`, each of them
    // hand-wrote its own unprojection math (four Python files in one run, a
    // scipy least-squares fit in another) while the tool sat unlocked.
    //
    // Draft-first (v0.6.1): with the camera solved, the model's own read of
    // the photograph is a good first draft — build it WHOLE (massing, roof,
    // openings) and let the SCORE, not a measuring ritual, decide what gets
    // measured. Measured against field runs, up-front feature measurement
    // spent ~30 trace calls before the first render; the score then indicted
    // only a handful of elements.
    nextSteps.push(
      "Build the whole DRAFT now — massing, roof planes AND openings, from your read of " +
      "the photograph — and score it from this camera immediately. Do not pixel-measure " +
      "features up front: the score's worst_segments will name the columns that are wrong, " +
      "and only those elements earn measurement.",
    );
    if (unprojectReady) {
      nextSteps.push(
        "When the score indicts an element, correct it with `unproject` — never re-derive " +
        "camera math by hand and never pixel-measure what plane geometry can place. " +
        "Worked call: unproject({image, camera: <the camera_for_unproject block in this " +
        "result, verbatim>, points: [[x, y]], plane: {axis: \"y\", value: 0}} (ground; " +
        "the facade is {axis: \"z\", value: 0}, a gable wall {axis: \"x\", ...}). One call " +
        "returns world metres with a reprojection check per point.",
      );
    }
  }

  return {
    size: [W, H],
    /**
     * What to do with this result. Verdict-conditional and ordered, most
     * urgent first — the routing that used to live in skill prose.
     */
    next: { unproject_locked: !unprojectReady, vertical_lines: verticalCount, do: nextSteps },
    families: families.map((f) => ({
      label: f.label,
      lines: f.count,
      vanishing_point: f.point ? [r2(f.point[0]), r2(f.point[1])] : null,
      at_infinity: !f.finite,
      residual_px: {
        per_line: f.residuals.map((r) => (r === null ? null : r2(r))),
        max: f.maxResidual === null ? null : r2(f.maxResidual),
        median: f.medResidual === null ? null : r2(f.medResidual),
      },
      leave_one_out_px: f.loo ? { worst: r2(f.loo.worst!), median: r2(f.loo.median!) } : null,
    })),
    horizon: horizon
      ? {
          line_abc: [r4(horizon[0]), r4(horizon[1]), r4(horizon[2])],
          y_at_x0: horizonY(0) === null ? null : r2(horizonY(0)!),
          y_at_centre: horizonY(W / 2) === null ? null : r2(horizonY(W / 2)!),
          y_at_xmax: horizonY(W) === null ? null : r2(horizonY(W)!),
        }
      : null,
    /** Everything `unproject` needs, ready to pass straight back in. */
    camera_for_unproject: focal && up
      ? { focal_px: r2(focal), principal_point: [r2(pp[0]), r2(pp[1])], up: [r4(up[0]), r4(up[1]), r4(up[2])] }
      : null,
    /**
     * The same camera as a Blender camera. Blender has NATIVE lens shift, so
     * the shifted-lens branch maps to shift_x/shift_y directly — cleaner than
     * the setViewOffset arithmetic the web target needs. A field run spent
     * ~10 minutes hand-deriving exactly this mapping; paste it instead.
     * Convention: sensor_fit HORIZONTAL, 36 mm sensor; shift is normalised by
     * image WIDTH; image y grows down, Blender sensor y grows up.
     */
    camera_for_blender: focal
      ? {
          sensor_fit: "HORIZONTAL",
          sensor_width_mm: 36,
          lens_mm: r2((focal * 36) / W),
          shift_x: r4((W / 2 - pp[0]) / W),
          shift_y: r4((pp[1] - H / 2) / W),
          render_resolution: [W, H],
          eye_height_m: eye ? r2((eye.eye_height_m_metric ?? eye.eye_height_m) as number) : null,
          horizontal_distance_m: eye?.horizontal_distance_m !== undefined ? r2(eye.horizontal_distance_m) : null,
          tilt_above_horizontal_deg: tilt === null ? null : r2(tilt),
          snippet: [
            "import bpy, math, mathutils",
            "cam = bpy.data.cameras.new('PhotoCam'); ob = bpy.data.objects.new('PhotoCam', cam)",
            "bpy.context.scene.collection.objects.link(ob)",
            "cam.sensor_fit = 'HORIZONTAL'; cam.sensor_width = 36.0",
            `cam.lens = ${r2((focal * 36) / W)}`,
            `cam.shift_x = ${r4((W / 2 - pp[0]) / W)}; cam.shift_y = ${r4((pp[1] - H / 2) / W)}`,
            `bpy.context.scene.render.resolution_x = ${W}; bpy.context.scene.render.resolution_y = ${H}`,
            eye?.horizontal_distance_m !== undefined
              ? `ob.location = (0, ${-r2(eye.horizontal_distance_m)}, ${r2((eye.eye_height_m_metric ?? eye.eye_height_m) as number)})  # subject near edge at origin, +Y away from camera`
              : "ob.location = (0, -DISTANCE, EYE_HEIGHT)  # supply known.height_m to solve these",
            tilt !== null && eye?.horizontal_distance_m !== undefined
              ? `target = mathutils.Vector((0, 0, ${r2(((eye.eye_height_m_metric ?? eye.eye_height_m) as number) + eye.horizontal_distance_m * Math.tan((tilt * Math.PI) / 180))}))`
              : "target = mathutils.Vector((0, 0, TARGET_HEIGHT))",
            "ob.rotation_euler = (target - ob.location).to_track_quat('-Z', 'Y').to_euler()",
            "bpy.context.scene.camera = ob",
            "# Verify with ONE render against the photograph before building on it;",
            "# if the subject is offset opposite to the photo, negate the shifts.",
          ].join("\n"),
        }
      : null,
    intrinsics: focal
      ? {
          focal_px: r2(focal),
          fov_vertical_deg: r2(deg(2 * Math.atan(H / (2 * focal)))),
          principal_point: [r2(pp[0]), r2(pp[1])],
          principal_point_source: ppSource,
          ambiguity:
            ppSource.startsWith("assumed")
              ? "The frame centre was assumed. Principal point and focal length cannot be " +
                "separated from two vanishing points — a lens shift and a longer lens make " +
                "nearly the same image — and this is the default on purpose: measured over " +
                "randomised cameras with ±1.5 px pick noise, assuming the centre halved the " +
                "95th-percentile focal error against solving the orthocentre (11% vs 25%), " +
                "because the orthocentre is exact on perfect input but amplifies pick error. " +
                "If the image is cropped or shot on a shift lens, re-run with " +
                "known.principal_point = 'solve'."
              : "Solved as the orthocentre of three finite vanishing points, on request. " +
                "This is the right choice for a cropped or shifted image, but it is " +
                "noise-sensitive: check that it landed plausibly near the frame centre " +
                "unless you know the image was cropped.",
        }
      : null,
    pose: {
      tilt_above_horizontal_deg: tilt === null ? null : r2(tilt),
      roll_deg: roll === null ? null : r2(roll),
      yaw_to_family_deg: yawTo,
      known_pitch_deg: known?.pitch_deg ?? null,
    },
    // Derived quantities are withheld when the solve is inconsistent. They
    // are computable from a broken horizon — an eye height of −17 m is
    // arithmetic, not a measurement — and printing them next to a refusal
    // invites someone to use them anyway. The diagnostics below stay: those
    // are what fixes the input.
    eye_height: inconsistent ? null : eye,
    cross_check: {
      leave_one_out_worst_px: worstLoo === null ? null : r2(worstLoo),
      leave_one_out_threshold_px: r2(diag * 0.02),
      orthogonality: orthoError,
      worst_line: culprit,
      verdict,
    },
    camera_block: cameraBlock,
    inconsistent,
    warnings,
    notes:
      "Vanishing points are fitted, not assumed: residual_px is how far each supplied line " +
      "misses the point it was fitted to, and leave_one_out_px is how far a line misses a " +
      "point fitted WITHOUT it — only the second is a real test. Angles are in degrees, " +
      "lengths in original-image pixels. The distance estimate (if any) is first-order: " +
      "refine it with the scoring loop, do not trust it to better than ~10%.",
  };
}

// ---------------------------------------------------------------- unproject

/**
 * Camera parameters as `solve_camera` reports them — pass its result straight
 * back in.
 */
export interface SolvedCamera {
  focal_px: number;
  principal_point: [number, number];
  /** World-up expressed in CAMERA coordinates (solve_camera's `up`). */
  up: Vec3;
}

/**
 * The camera's three axes, in camera coordinates, mapped to world X/Y/Z.
 *
 * World frame convention: Y is up, Z is the camera's horizontal view
 * direction, X completes a right-handed set. That makes the frame the agent
 * actually models in — a facade at z = 0, a gable wall at x = 0, ground at
 * y = 0 — which is the whole point of this tool.
 */
function worldAxesInCamera(cam: SolvedCamera) {
  const up = unit(cam.up);
  const fwd: Vec3 = [0, 0, 1];
  const fh = unit([
    fwd[0] - dot(fwd, up) * up[0],
    fwd[1] - dot(fwd, up) * up[1],
    fwd[2] - dot(fwd, up) * up[2],
  ]);
  return { X: unit(cross(up, fh)), Y: up, Z: fh };
}

/** World → pixel. Exact inverse of the ray construction in unprojectPoints. */
export function projectPoint(
  cam: SolvedCamera,
  P: Vec3,
  eye: Vec3 = [0, 0, 0],
): [number, number] | null {
  const { X, Y, Z } = worldAxesInCamera(cam);
  const v: Vec3 = [P[0] - eye[0], P[1] - eye[1], P[2] - eye[2]];
  // A world vector rebuilt in camera coordinates from its world components.
  const c: Vec3 = [
    v[0] * X[0] + v[1] * Y[0] + v[2] * Z[0],
    v[0] * X[1] + v[1] * Y[1] + v[2] * Z[1],
    v[0] * X[2] + v[1] * Y[2] + v[2] * Z[2],
  ];
  if (c[2] <= 1e-9) return null; // behind the camera
  const f = cam.focal_px;
  return [(c[0] / c[2]) * f + cam.principal_point[0], (c[1] / c[2]) * f + cam.principal_point[1]];
}

/**
 * Pixels → world, on a named plane.
 *
 * The natural next need once the camera is solved: "where is this window in
 * world coordinates?" Every observed run answered it by MEASURING each feature
 * in pixels instead — ~15 magnify-look-measure cycles in the last run, roughly
 * 25 minutes, all of it AFTER the camera was already known. One run hand-built
 * this tool and hit an axis-confusion bug (projected 6370,52 where 900,500 was
 * expected) that cost a debug cycle — which is why the round-trip check here is
 * not optional: every unprojected point is reprojected and its error reported.
 */
export function unprojectPoints(
  cam: SolvedCamera,
  plane: { axis: "x" | "y" | "z"; value: number },
  points: [number, number][],
  /** Camera position in WORLD coordinates. Default: the world origin. */
  eye: Vec3 = [0, 0, 0],
) {
  const { X, Y, Z } = worldAxesInCamera(cam);
  const f = cam.focal_px;
  const [cx, cy] = cam.principal_point;
  const idx = plane.axis === "x" ? 0 : plane.axis === "y" ? 1 : 2;

  const world: ([number, number, number] | null)[] = [];
  const reproj: (number | null)[] = [];
  const notes: string[] = [];

  for (const [px, py] of points) {
    // Camera-space ray, then its components along the world axes. No manual
    // sign flips: image y is down and `up` already carries that, so the dot
    // product against world-up comes out positive for points above centre.
    const d: Vec3 = [(px - cx) / f, (py - cy) / f, 1];
    const r: Vec3 = [dot(d, X), dot(d, Y), dot(d, Z)];

    const denom = r[idx];
    if (Math.abs(denom) < 1e-9) {
      world.push(null); reproj.push(null);
      notes.push(`(${px},${py}) is parallel to the ${plane.axis} plane — no intersection`);
      continue;
    }
    const t = (plane.value - eye[idx]) / denom;
    if (t <= 0) {
      world.push(null); reproj.push(null);
      notes.push(`(${px},${py}) meets the plane BEHIND the camera — wrong plane for this feature`);
      continue;
    }
    const P: Vec3 = [eye[0] + t * r[0], eye[1] + t * r[1], eye[2] + t * r[2]];
    world.push([r2(P[0]), r2(P[1]), r2(P[2])]);
    const back = projectPoint(cam, P, eye);
    reproj.push(back ? r2(Math.hypot(back[0] - px, back[1] - py)) : null);
  }

  const errs = reproj.filter((v): v is number => v !== null);
  return {
    plane,
    world,
    reprojection_error_px: reproj,
    max_reprojection_error_px: errs.length ? r2(Math.max(...errs)) : null,
    notes: notes.length ? notes : undefined,
  };
}
