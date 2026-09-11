/** Canonical photo evaluation, shared by MCP and Blender's JSON CLI adapter. */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { PNG } from "pngjs";
import { decodeImage, type Bitmap } from "./scan.ts";
import {
  projectWorld,
  validateFrame,
  type CameraFrame,
  type V3,
} from "./frame.ts";
export interface Observations {
  schema_version: 1;
  reference_sha256: string;
  image_size: [number, number];
  landmarks?: {
    id: string;
    pixel: [number, number];
    visible?: boolean;
    role?: "fit" | "check";
  }[];
  subject_mask?: string;
  occlusion_mask?: string;
  span?: [number, number];
}
export interface EvaluationRequest {
  reference: string;
  render: string;
  observations?: string;
  camera?: CameraFrame;
  model_points?: Record<string, V3>;
  render_mask?: string;
  out_dir?: string;
  history_path?: string;
  name?: string;
  tolerance_px?: number;
  min_mask_iou?: number;
}
const sha = (v: string | Buffer) =>
  createHash("sha256").update(v).digest("hex");
const hashFile = (p: string) => sha(fs.readFileSync(p));
function mask(p: string, w: number, h: number): boolean[] {
  const im = decodeImage(p);
  if (im.w !== w || im.h !== h)
    throw Error("Masks must have the exact reference dimensions");
  const out = [];
  for (let i = 0; i < w * h; i++) {
    const rgb = [im.data[i * 4], im.data[i * 4 + 1], im.data[i * 4 + 2]];
    if (!(rgb.every((v) => v === 0) || rgb.every((v) => v === 255)))
      throw Error("Masks must be binary black/white, not beauty images");
    out.push(rgb[0] === 255 && im.data[i * 4 + 3] > 0);
  }
  return out;
}
function writeOverlay(
  a: Bitmap,
  b: Bitmap,
  p: string,
  points: { reference: number[]; projected: number[] | null }[],
) {
  const im = new PNG({ width: a.w, height: a.h });
  for (let i = 0; i < a.data.length; i++)
    im.data[i] = i % 4 === 3 ? 255 : Math.round((a.data[i] + b.data[i]) / 2);
  const mark = (point: number[], color: number[]) => {
    const [x, y] = point.map(Math.round);
    for (let d = -5; d <= 5; d++)
      for (const [xx, yy] of [
        [x + d, y],
        [x, y + d],
      ])
        if (xx >= 0 && xx < a.w && yy >= 0 && yy < a.h) {
          const k = (yy * a.w + xx) * 4;
          for (let c = 0; c < 3; c++) im.data[k + c] = color[c];
        }
  };
  for (const p of points) {
    mark(p.reference, [0, 255, 255]);
    if (p.projected) mark(p.projected, [255, 0, 255]);
  }
  fs.writeFileSync(p, PNG.sync.write(im));
}
export function evaluate(req: EvaluationRequest) {
  if (req.camera) validateFrame(req.camera);
  const ref = decodeImage(req.reference),
    ren = decodeImage(req.render);
  if (ref.w !== ren.w || ref.h !== ren.h)
    throw Error(
      "Render must match the reference dimensions; use a full-resolution final or consistently scaled draft reference",
    );
  const tolerance = req.tolerance_px ?? 5,
    minIou = req.min_mask_iou ?? 0.95;
  if (
    !(tolerance > 0) ||
    !Number.isFinite(tolerance) ||
    !(minIou > 0 && minIou <= 1)
  )
    throw Error("Invalid evaluation thresholds");
  let obs: Observations | undefined;
  let evidenceHash: string | undefined;
  const problems: string[] = [];
  const resolve = (p: string) =>
    path.resolve(path.dirname(req.observations!), p);
  if (req.observations) {
    const raw = fs.readFileSync(req.observations, "utf8");
    obs = JSON.parse(raw);
    evidenceHash = sha(raw);
    if (
      obs?.schema_version !== 1 ||
      obs.reference_sha256 !== hashFile(req.reference) ||
      obs.image_size?.[0] !== ref.w ||
      obs.image_size?.[1] !== ref.h
    )
      throw Error("Observation reference hash, size or schema does not match");
    if (
      obs.span &&
      (!obs.span.every(Number.isFinite) ||
        obs.span[0] < 0 ||
        obs.span[1] > ref.w ||
        obs.span[1] <= obs.span[0])
    )
      throw Error("Invalid subject span");
  }
  const ids = new Set<string>();
  for (const l of obs?.landmarks ?? []) {
    if (
      !l.id ||
      ids.has(l.id) ||
      l.pixel.length !== 2 ||
      l.pixel.some(
        (v, i) => !Number.isFinite(v) || v < 0 || v >= [ref.w, ref.h][i],
      )
    )
      throw Error("Landmarks need unique IDs and valid original-image pixels");
    ids.add(l.id);
  }
  const visible = (obs?.landmarks ?? []).filter(
    (l) =>
      l.visible !== false &&
      (!obs?.span || (l.pixel[0] >= obs.span[0] && l.pixel[0] < obs.span[1])),
  );
  const points = visible.map((l) => {
    const world = req.model_points?.[l.id];
    if (world && (world.length !== 3 || world.some((v) => !Number.isFinite(v))))
      throw Error("Invalid model point " + l.id);
    const projected =
      req.camera && world ? projectWorld(req.camera, world) : null;
    return {
      id: l.id,
      role: l.role ?? "fit",
      reference: l.pixel,
      projected,
      error_px: projected
        ? Math.hypot(projected[0] - l.pixel[0], projected[1] - l.pixel[1])
        : null,
    };
  });
  if (
    req.camera &&
    (req.camera.image_size[0] !== ref.w || req.camera.image_size[1] !== ref.h)
  )
    throw Error("Camera image size does not match reference");
  const complete = points.filter((p) => p.error_px !== null);
  let landmarks: any = {
    status: "UNAVAILABLE",
    reason:
      "Need at least four visible, spread-out reference landmarks and their model points.",
  };
  if (points.length) {
    const xs = points.map((p) => p.reference[0]),
      ys = points.map((p) => p.reference[1]);
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length,
      my = ys.reduce((a, b) => a + b, 0) / ys.length;
    const xx = xs.reduce((s, x) => s + (x - mx) ** 2, 0),
      yy = ys.reduce((s, y) => s + (y - my) ** 2, 0),
      xy = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
    const spread =
      xx * yy - xy * xy > 1e-4 * (xx + yy) ** 2 &&
      Math.max(...xs) - Math.min(...xs) > ref.w * 0.1 &&
      Math.max(...ys) - Math.min(...ys) > ref.h * 0.1;
    if (points.length >= 4 && complete.length === points.length && spread) {
      const errors = complete.map((p) => p.error_px!);
      const rms = Math.sqrt(
          errors.reduce((s, v) => s + v * v, 0) / errors.length,
        ),
        max = Math.max(...errors);
      const checks = complete.filter((p) => p.role === "check");
      landmarks = {
        status: max <= tolerance ? "PASS" : "FAIL",
        rms_px: rms,
        max_px: max,
        tolerance_px: tolerance,
        coverage: complete.length,
        held_out_count: checks.length,
        held_out_rms_px: checks.length
          ? Math.sqrt(
              checks.reduce((s, p) => s + p.error_px! ** 2, 0) / checks.length,
            )
          : null,
        worst: complete
          .toSorted((a, b) => b.error_px! - a.error_px!)
          .slice(0, 5),
        note: "Projection agreement under the supplied camera; does not independently establish physical dimensions.",
      };
    } else
      problems.push(
        "Incomplete or spatially concentrated landmark correspondences.",
      );
  }
  let silhouette: any = {
    status: "UNAVAILABLE",
    reason:
      "Provide a fixed reference subject mask and a rendered subject-only binary mask.",
  };
  let maskHash = "";
  if (obs?.subject_mask) {
    const rp = resolve(obs.subject_mask);
    maskHash = hashFile(rp);
    const a = mask(rp, ref.w, ref.h),
      ex = obs.occlusion_mask
        ? mask(resolve(obs.occlusion_mask), ref.w, ref.h)
        : null;
    if (obs.occlusion_mask) maskHash += hashFile(resolve(obs.occlusion_mask));
    if (req.render_mask) {
      const b = mask(req.render_mask, ref.w, ref.h);
      let intersection = 0,
        union = 0,
        referenceArea = 0,
        renderArea = 0,
        excluded = 0;
      for (let i = 0; i < a.length; i++) {
        const x = i % ref.w;
        if (ex?.[i] || (obs.span && (x < obs.span[0] || x >= obs.span[1]))) {
          excluded++;
          continue;
        }
        if (a[i]) referenceArea++;
        if (b[i]) renderArea++;
        if (a[i] && b[i]) intersection++;
        if (a[i] || b[i]) union++;
      }
      if (referenceArea < 16)
        problems.push(
          "Reference subject mask is empty or fully occluded within the selected span.",
        );
      else {
        const iou = union ? intersection / union : 0;
        silhouette = {
          status: iou >= minIou ? "PASS" : "FAIL",
          iou,
          min_iou: minIou,
          reference_pixels: referenceArea,
          render_pixels: renderArea,
          excluded_pixels: excluded,
        };
      }
    } else problems.push("Reference mask exists but rendered mask is missing.");
  }
  const available = [landmarks, silhouette].filter(
    (m) => m.status !== "UNAVAILABLE",
  );
  const expectedMissing =
    (visible.length > 0 && landmarks.status === "UNAVAILABLE") ||
    (!!obs?.subject_mask && silhouette.status === "UNAVAILABLE");
  const status =
    expectedMissing || !available.length
      ? "INCOMPLETE"
      : available.every((m) => m.status === "PASS")
        ? "PASS"
        : "FAIL";
  // A dimensionless, threshold-normalised loss; no RGB skyline influences it.
  const loss =
    status === "INCOMPLETE"
      ? null
      : Math.max(
          ...available.map((m) =>
            m === landmarks
              ? m.max_px / tolerance
              : (1 - m.iou) / Math.max(1e-6, 1 - minIou),
          ),
        );
  const metricKey = sha(
    JSON.stringify({
      reference: hashFile(req.reference),
      evidenceHash,
      maskHash,
      tolerance,
      minIou,
      metrics: available.map((m) => (m === landmarks ? "landmarks" : "mask")),
    }),
  );
  let history: any[] = [];
  if (req.history_path && fs.existsSync(req.history_path)) {
    const h = JSON.parse(fs.readFileSync(req.history_path, "utf8"));
    if (!Array.isArray(h)) throw Error("Invalid score history");
    history = h;
  }
  const comparable = history.filter(
    (h) => h.metric_key === metricKey && typeof h.loss === "number",
  );
  const tail = [...comparable.slice(-2).map((h) => h.loss), loss];
  const stable =
    tail.length === 3 &&
    tail.every((v) => v !== null) &&
    Math.max(...tail) - Math.min(...tail) < 0.03 * Math.max(1, ...tail);
  const verdict =
    status === "INCOMPLETE"
      ? "unavailable"
      : status === "PASS"
        ? "satisfied"
        : stable
          ? "stalled"
          : "needs_refinement";
  const report = {
    schema_version: 1,
    version: "0.7.0",
    status,
    verdict,
    loss,
    metric_key: metricKey,
    landmarks,
    silhouette,
    problems,
    camera_check: {
      status: "UNDETERMINED",
      note: "Image extent alone cannot distinguish camera error from model error. Compare independent correspondences before changing either.",
    },
    note:
      status === "INCOMPLETE"
        ? "No photographic pass is claimed. Add usable observations or explicitly deliver with photographic validation incomplete."
        : "Only fixed observations and explicit masks control this assessment.",
  };
  const entry = {
    name: req.name ?? "comparison",
    ...report,
    render_sha256: hashFile(req.render),
    camera_sha256: req.camera ? sha(JSON.stringify(req.camera)) : null,
  };
  if (req.out_dir) {
    fs.mkdirSync(req.out_dir, { recursive: true });
    writeOverlay(ref, ren, path.join(req.out_dir, "overlay.png"), points);
    fs.writeFileSync(
      path.join(req.out_dir, "evaluation.json"),
      JSON.stringify(entry, null, 2),
    );
  }
  if (req.history_path) {
    fs.mkdirSync(path.dirname(req.history_path), { recursive: true });
    fs.writeFileSync(
      req.history_path,
      JSON.stringify([...history, entry], null, 2),
    );
  }
  return report;
}
