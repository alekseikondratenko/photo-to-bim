/** Local camera-only least-squares fitting. Supplied geometry and metric scale stay fixed. */
import {
  projectWorld,
  validateFrame,
  type CameraFrame,
  type V3,
} from "./frame.ts";
export interface Landmark {
  id: string;
  pixel: [number, number];
  world: V3;
  role?: "fit" | "check";
  used_for_fitting?: boolean;
}
export interface FitOptions {
  fit_focal?: boolean;
  fit_principal_point?: boolean;
  max_iterations?: number;
}
const mul = (a: number[][], b: number[][]) =>
  a.map((row) =>
    b[0].map((_, j) => row.reduce((s, v, k) => s + v * b[k][j], 0)),
  );
function rotation(v: number[]) {
  const angle = Math.hypot(...v),
    k = angle < 1e-12 ? v : v.map((x) => x / angle),
    [x, y, z] = k;
  if (angle < 1e-12)
    return [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
  const c = Math.cos(angle),
    s = Math.sin(angle),
    t = 1 - c;
  return [
    [c + x * x * t, x * y * t - z * s, x * z * t + y * s],
    [y * x * t + z * s, c + y * y * t, y * z * t - x * s],
    [z * x * t - y * s, z * y * t + x * s, c + z * z * t],
  ];
}
function solve(a: number[][], b: number[]) {
  const m = a.map((r, i) => [...r, b[i]]),
    n = b.length;
  for (let i = 0; i < n; i++) {
    let pivot = i;
    for (let j = i + 1; j < n; j++)
      if (Math.abs(m[j][i]) > Math.abs(m[pivot][i])) pivot = j;
    if (Math.abs(m[pivot][i]) < 1e-14) return null;
    [m[i], m[pivot]] = [m[pivot], m[i]];
    const div = m[i][i];
    for (let k = i; k <= n; k++) m[i][k] /= div;
    for (let j = 0; j < n; j++)
      if (j !== i) {
        const f = m[j][i];
        for (let k = i; k <= n; k++) m[j][k] -= f * m[i][k];
      }
  }
  return m.map((r) => r[n]);
}
function rank(j: number[][]) {
  const n = j[0].length,
    scales = Array.from({ length: n }, (_, i) =>
      Math.hypot(...j.map((r) => r[i])),
    );
  const m = j.map((row) => row.map((v, i) => v / (scales[i] || 1)));
  let r = 0;
  for (let c = 0; c < n; c++) {
    let p = r;
    for (let k = r; k < m.length; k++)
      if (Math.abs(m[k][c]) > Math.abs(m[p][c])) p = k;
    if (Math.abs(m[p][c]) < 1e-6) continue;
    [m[r], m[p]] = [m[p], m[r]];
    const d = m[r][c];
    for (let k = c; k < n; k++) m[r][k] /= d;
    for (let k = r + 1; k < m.length; k++) {
      const f = m[k][c];
      for (let l = c; l < n; l++) m[k][l] -= f * m[r][l];
    }
    r++;
  }
  return r;
}
export function fitLandmarkCamera(
  initial: CameraFrame,
  landmarks: Landmark[],
  options: FitOptions = {},
) {
  validateFrame(initial);
  const ids = new Set<string>();
  for (const l of landmarks) {
    if (
      !l.id ||
      ids.has(l.id) ||
      l.pixel.length !== 2 ||
      l.world.length !== 3 ||
      [...l.pixel, ...l.world].some((v) => !Number.isFinite(v))
    )
      throw Error(
        "Landmarks require unique IDs and finite pixels/world points",
      );
    if (l.pixel.some((v, i) => v < 0 || v >= initial.image_size[i]))
      throw Error("Landmark pixels must lie inside the reference image");
    ids.add(l.id);
  }
  const fitting = landmarks.filter(
    (l) => l.role !== "check" || l.used_for_fitting === true,
  );
  if (fitting.length < 6)
    throw Error(
      "Camera fitting needs at least six fit correspondences; check points are excluded unless explicitly consumed",
    );
  const active = [
    0,
    1,
    2,
    3,
    4,
    5,
    ...(options.fit_focal === false ? [] : [6]),
    ...(options.fit_principal_point ? [7, 8] : []),
  ];
  const iterations = options.max_iterations ?? 150;
  if (!Number.isInteger(iterations) || iterations < 1 || iterations > 300)
    throw Error("max_iterations must be 1..300");
  const lo = [0, 1, 2].map((i) => Math.min(...fitting.map((l) => l.world[i]))),
    hi = [0, 1, 2].map((i) => Math.max(...fitting.map((l) => l.world[i])));
  const scale = Math.hypot(...hi.map((v, i) => v - lo[i]));
  if (scale < 1e-7) throw Error("Degenerate model points");
  const base = initial.world_from_camera.slice(0, 3).map((r) => r.slice(0, 3));
  const camera = (p: number[]): CameraFrame => {
    const r = mul(base, rotation(p.slice(3, 6)));
    return {
      ...initial,
      focal_px: initial.focal_px * Math.exp(p[6]),
      principal_point: [
        initial.principal_point[0] + p[7] * initial.image_size[0],
        initial.principal_point[1] + p[8] * initial.image_size[1],
      ],
      world_from_camera: [
        ...r.map((row, i) => [
          ...row,
          initial.world_from_camera[i][3] + p[i] * scale,
        ]),
        [0, 0, 0, 1],
      ],
    };
  };
  const residual = (p: number[]) => {
    const c = camera(p),
      maxSize = Math.max(...c.image_size);
    if (
      !Number.isFinite(c.focal_px) ||
      c.focal_px < maxSize * 0.05 ||
      c.focal_px > maxSize * 10 ||
      c.principal_point.some(
        (v, i) => v < -c.image_size[i] || v > 2 * c.image_size[i],
      )
    )
      return null;
    const out: number[] = [];
    for (const l of fitting) {
      const px = projectWorld(c, l.world);
      if (!px) return null;
      out.push(px[0] - l.pixel[0], px[1] - l.pixel[1]);
    }
    return out;
  };
  const jacobian = (p: number[], r: number[]) => {
    const columns = active.map((k) => {
      const q = [...p];
      q[k] += 1e-6;
      const next = residual(q);
      return next?.map((v, i) => (v - r[i]) / 1e-6) ?? r.map(() => 0);
    });
    return r.map((_, i) => columns.map((col) => col[i]));
  };
  let p = Array(9).fill(0),
    r = residual(p);
  if (!r)
    throw Error(
      "Initial camera must see all fit points and use plausible intrinsics",
    );
  const cost = (r: number[]) => r.reduce((s, v) => s + v * v, 0);
  let lambda = 0.001,
    steps = 0,
    termination = "iteration_limit";
  for (; steps < iterations; steps++) {
    const j = jacobian(p, r),
      a = active.map((_, i) =>
        active.map((_, k) => j.reduce((s, row) => s + row[i] * row[k], 0)),
      ),
      g = active.map((_, i) => j.reduce((s, row, k) => s + row[i] * r![k], 0));
    if (Math.max(...g.map(Math.abs)) < 1e-7 || cost(r) < 1e-12) {
      termination = "converged";
      break;
    }
    const damped = a.map((row, i) =>
      row.map((v, k) => v + (i === k ? lambda * Math.max(a[i][i], 1e-8) : 0)),
    );
    const dp = solve(damped, g);
    if (!dp) {
      termination = "singular";
      break;
    }
    const q = [...p];
    active.forEach((k, i) => (q[k] -= dp[i]));
    const trial = residual(q);
    if (trial && cost(trial) < cost(r)) {
      const gain = cost(r) - cost(trial);
      p = q;
      r = trial;
      lambda = Math.max(1e-10, lambda / 3);
      if (Math.hypot(...dp) < 1e-9 || gain < 1e-12 * Math.max(1, cost(r))) {
        termination = "converged";
        steps++;
        break;
      }
    } else {
      lambda *= 8;
      if (lambda > 1e14) {
        termination = "stalled";
        break;
      }
    }
  }
  const result = camera(p),
    jacobianRank = rank(jacobian(p, r));
  const errors = landmarks.map((l) => {
    const pixel = projectWorld(result, l.world);
    return {
      id: l.id,
      role: l.role ?? "fit",
      used_for_fitting: l.role !== "check" || l.used_for_fitting === true,
      independence:
        l.role === "check" && l.used_for_fitting === false
          ? "declared_independent"
          : l.role === "check" && l.used_for_fitting === undefined
            ? "undeclared"
            : "used",
      error_px: pixel
        ? Math.hypot(pixel[0] - l.pixel[0], pixel[1] - l.pixel[1])
        : null,
    };
  });
  const fitErrors = errors
    .filter((e) => e.used_for_fitting)
    .map((e) => e.error_px!);
  return {
    schema_version: 1,
    method: "landmarks",
    status:
      jacobianRank < active.length
        ? "INCOMPLETE"
        : termination === "converged"
          ? "SOLVED"
          : "INCOMPLETE",
    camera: result,
    iterations: steps,
    termination,
    identifiability: { rank: jacobianRank, parameters: active.length },
    fit_rms_px: Math.sqrt(
      fitErrors.reduce((s, v) => s + v * v, 0) / fitErrors.length,
    ),
    fit_max_px: Math.max(...fitErrors),
    independent_check_count: errors.filter(
      (e) => e.independence === "declared_independent",
    ).length,
    landmarks: errors,
    note:
      jacobianRank < active.length
        ? "Camera parameters are underconstrained; fix focal length/principal point or add independent 3D directions."
        : "Camera-only local fit from the supplied initial frame. Geometry and its assumed/measured metric scale remain fixed; low reprojection error does not prove physical accuracy.",
  };
}
