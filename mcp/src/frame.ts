/** Metric Z-up world; camera coordinates are right, down, forward (OpenCV). */
export type V3 = [number, number, number];
export interface CameraFrame {
  schema_version: 1;
  convention: "Z_UP_RIGHT_HANDED";
  image_size: [number, number];
  focal_px: number;
  principal_point: [number, number];
  world_from_camera: number[][];
}
const dot = (a: number[], b: number[]) =>
  a.reduce((s, v, i) => s + v * b[i], 0);
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const unit = (v: V3): V3 => {
  const n = Math.hypot(...v);
  if (!Number.isFinite(n) || n < 1e-10) throw Error("Degenerate frame vector");
  return v.map((x) => x / n) as V3;
};
export function makeFrame(
  size: [number, number],
  focal: number,
  pp: [number, number],
  position: V3,
  target: V3,
  roll = 0,
): CameraFrame {
  const forward = unit(target.map((v, i) => v - position[i]) as V3);
  const right = unit(cross(forward, [0, 0, 1]));
  const down = cross(forward, right);
  const c = Math.cos((roll * Math.PI) / 180),
    s = Math.sin((roll * Math.PI) / 180);
  const r = right.map((v, i) => c * v + s * down[i]),
    d = down.map((v, i) => c * v - s * right[i]);
  const frame: CameraFrame = {
    schema_version: 1,
    convention: "Z_UP_RIGHT_HANDED",
    image_size: size,
    focal_px: focal,
    principal_point: pp,
    world_from_camera: [
      ...position.map((p, i) => [r[i], d[i], forward[i], p]),
      [0, 0, 0, 1],
    ],
  };
  validateFrame(frame);
  return frame;
}
export function validateFrame(c: CameraFrame) {
  const m = c.world_from_camera;
  if (
    c.schema_version !== 1 ||
    c.convention !== "Z_UP_RIGHT_HANDED" ||
    !(c.focal_px > 0) ||
    !Number.isFinite(c.focal_px) ||
    c.image_size.length !== 2 ||
    c.principal_point.length !== 2 ||
    c.image_size.some((v) => !Number.isInteger(v) || v <= 0) ||
    c.principal_point.some((v) => !Number.isFinite(v)) ||
    m.length !== 4 ||
    m.some((r) => r.length !== 4 || r.some((v) => !Number.isFinite(v)))
  )
    throw Error("Invalid camera frame");
  if (m[3].some((v, i) => Math.abs(v - (i === 3 ? 1 : 0)) > 1e-8))
    throw Error("Expected affine transform");
  const cols = [0, 1, 2].map((j) => [m[0][j], m[1][j], m[2][j]] as V3);
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      if (Math.abs(dot(cols[i], cols[j]) - (i === j ? 1 : 0)) > 1e-5)
        throw Error("Camera rotation must be orthonormal");
  if (dot(cross(cols[0], cols[1]), cols[2]) < 0.99999)
    throw Error("Camera transform must be right-handed");
}
export function projectWorld(c: CameraFrame, p: V3): [number, number] | null {
  validateFrame(c);
  const m = c.world_from_camera,
    v = p.map((x, i) => x - m[i][3]);
  const q = [0, 1, 2].map((j) => dot(v, [m[0][j], m[1][j], m[2][j]]));
  if (q[2] <= 1e-9) return null;
  return [
    c.principal_point[0] + (c.focal_px * q[0]) / q[2],
    c.principal_point[1] + (c.focal_px * q[1]) / q[2],
  ];
}
export function intersectPlane(
  c: CameraFrame,
  plane: { origin: V3; normal: V3 },
  pixels: [number, number][],
  pick_uncertainty_px = 1,
) {
  validateFrame(c);
  if (
    [...plane.origin, ...plane.normal, ...pixels.flat()].some(
      (v) => !Number.isFinite(v),
    )
  )
    throw Error("Non-finite plane or pixel");
  if (!Number.isFinite(pick_uncertainty_px) || pick_uncertainty_px < 0)
    throw Error("Invalid pick uncertainty");
  const n = unit(plane.normal),
    m = c.world_from_camera,
    eye = m.slice(0, 3).map((r) => r[3]);
  const hit = (px: number, py: number) => {
    const q = [
      (px - c.principal_point[0]) / c.focal_px,
      (py - c.principal_point[1]) / c.focal_px,
      1,
    ];
    const ray = m.slice(0, 3).map((row) => dot(row.slice(0, 3), q));
    const denom = dot(n, ray);
    if (Math.abs(denom) / Math.hypot(...ray) < 1e-6) return null;
    const t =
      dot(
        n,
        plane.origin.map((v, i) => v - eye[i]),
      ) / denom;
    return t > 0 ? (eye.map((v, i) => v + t * ray[i]) as V3) : null;
  };
  return {
    schema_version: 1,
    frame: c.convention,
    dimension_status: "derived",
    note: "Conditional on camera, scale and plane. Round-trip error tests arithmetic, not plane correctness. Pick sensitivity excludes calibration and scale uncertainty.",
    points: pixels.map((pixel) => {
      const p = hit(...pixel);
      if (!p) return { pixel, world: null, status: "no_forward_intersection" };
      const back = projectWorld(c, p)!;
      const near = [
        [pick_uncertainty_px, 0],
        [-pick_uncertainty_px, 0],
        [0, pick_uncertainty_px],
        [0, -pick_uncertainty_px],
      ].map(([dx, dy]) => hit(pixel[0] + dx, pixel[1] + dy));
      return {
        pixel,
        world: p,
        round_trip_error_px: Math.hypot(back[0] - pixel[0], back[1] - pixel[1]),
        pick_sensitivity_m: near.some((v) => !v)
          ? null
          : Math.max(
              ...near.map((v) => Math.hypot(...v!.map((x, i) => x - p[i]))),
            ),
        status: "derived",
      };
    }),
  };
}

/** Solve a vertical metric anchor in the camera frame, including roll and off-centre pixels. */
export function anchorFrame(
  size: [number, number],
  focal: number,
  pp: [number, number],
  tilt: number,
  roll: number,
  bottom: [number, number],
  top: [number, number],
  height: number,
) {
  const th = (tilt * Math.PI) / 180;
  const neutral = makeFrame(
    size,
    focal,
    pp,
    [0, 0, 0],
    [0, Math.cos(th), Math.sin(th)],
    roll,
  );
  const ray = (p: [number, number]) =>
    neutral.world_from_camera
      .slice(0, 3)
      .map((row) =>
        dot(row.slice(0, 3), [
          (p[0] - pp[0]) / focal,
          (p[1] - pp[1]) / focal,
          1,
        ]),
      );
  const a = ray(top),
    b = ray(bottom).map((v) => -v),
    aa = dot(a, a),
    bb = dot(b, b),
    ab = dot(a, b),
    det = aa * bb - ab * ab;
  if (det < 1e-12) throw Error("Degenerate scale anchor");
  const at = a[2] * height,
    bt = b[2] * height,
    lt = (at * bb - bt * ab) / det,
    lb = (bt * aa - at * ab) / det;
  if (lt <= 0 || lb <= 0)
    throw Error("Scale anchor intersects behind the camera");
  const residual = Math.hypot(
    ...a.map((v, i) => lt * v + lb * b[i] - (i === 2 ? height : 0)),
  );
  const pos = b.map((v) => lb * v) as V3;
  const camera = {
    ...neutral,
    world_from_camera: neutral.world_from_camera.map((r, i) =>
      i < 3 ? [...r.slice(0, 3), pos[i]] : r,
    ),
  };
  return { camera, residual_m: residual };
}
