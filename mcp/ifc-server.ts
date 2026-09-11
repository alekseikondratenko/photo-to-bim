/** Small IFC measurement surface; no viewer or legacy scoring endpoints. */
import fs from "node:fs";
import { createHash } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { solveCamera } from "./src/camera.ts";
import { classifyReference, decodeImage } from "./src/scan.ts";
import { viewCropSheet, traceEdge } from "./src/instruments.ts";
import {
  makeFrame,
  anchorFrame,
  intersectPlane,
  type CameraFrame,
  type V3,
} from "./src/frame.ts";
import { evaluate, type EvaluationRequest } from "./src/evaluate.ts";
const v3 = z.tuple([
  z.number().finite(),
  z.number().finite(),
  z.number().finite(),
]);
const pixel = z.tuple([z.number().finite(), z.number().finite()]);
const crop = z.object({
  x0: z.number(),
  y0: z.number(),
  x1: z.number(),
  y1: z.number(),
});
const frame = z.object({
  schema_version: z.literal(1),
  convention: z.literal("Z_UP_RIGHT_HANDED"),
  image_size: z.tuple([
    z.number().int().positive(),
    z.number().int().positive(),
  ]),
  focal_px: z.number().positive(),
  principal_point: pixel,
  world_from_camera: z.array(z.array(z.number().finite()).length(4)).length(4),
});
const result = (r: object) => ({
  content: [{ type: "text" as const, text: JSON.stringify(r) }],
  structuredContent: r as Record<string, unknown>,
});
const hash = (p: string) =>
  createHash("sha256").update(fs.readFileSync(p)).digest("hex");
const unique = (ids: string[]) => {
  if (new Set(ids).size !== ids.length)
    throw Error("Observation IDs must be unique");
};
export function createIfcServer() {
  const s = new McpServer({ name: "photo-to-bim", version: "0.7.0" });
  s.registerTool(
    "classify_reference",
    {
      description:
        "Optional shape hints. Inspect the image yourself; sky-based detectors can fail on vegetation and clouds.",
      inputSchema: { image: z.string(), crop: crop.optional() },
    },
    async ({ image, crop }) =>
      result({
        reference_sha256: hash(image),
        ...classifyReference(image, crop),
      }),
  );
  s.registerTool(
    "view_crop",
    {
      description: "Batch up to six magnified crops with original-pixel grids.",
      inputSchema: {
        image: z.string(),
        regions: z.array(crop).min(1).max(6),
        out: z.string(),
        scale: z.number().positive().optional(),
      },
    },
    async ({ image, regions, out, scale }) =>
      result(viewCropSheet(image, regions, out, { scale })),
  );
  s.registerTool(
    "trace_edges",
    {
      description:
        "Batch named line observations. Inspect crops to ensure each trace follows the intended physical edge.",
      inputSchema: {
        image: z.string(),
        edges: z
          .array(
            z.object({
              id: z.string().min(1),
              family: z.string().optional(),
              crop,
              direction: z.enum(["down", "up", "left", "right"]),
              threshold: z.number().optional(),
              condition: z.enum(["above", "below"]).optional(),
            }),
          )
          .min(1)
          .max(32),
      },
    },
    async ({ image, edges }) => {
      unique(edges.map((e) => e.id));
      return result({
        schema_version: 1,
        reference_sha256: hash(image),
        observations: edges.map((e) => ({
          id: e.id,
          family: e.family,
          status: "observed",
          ...traceEdge(image, e.crop, e.direction, {
            threshold: e.threshold,
            condition: e.condition,
          }),
        })),
      });
    },
  );
  s.registerTool(
    "calibrate_camera",
    {
      description:
        "Fit line families; return a complete Z-up camera frame and conditional scale assumptions. Shared labels identify world-parallel edges. Scale anchor pixel endpoints must span the stated vertical height.",
      inputSchema: {
        image: z.string(),
        lines: z
          .array(
            z.object({
              id: z.string(),
              label: z.string(),
              x0: z.number(),
              y0: z.number(),
              x1: z.number(),
              y1: z.number(),
            }),
          )
          .min(4),
        principal_point: z.enum(["centre", "solve"]).optional(),
        scale_anchor: z
          .object({
            height_m: z.number().positive(),
            bottom: pixel,
            top: pixel,
            status: z.enum(["assumed", "measured"]),
            source: z.string().min(1),
            uncertainty_m: z.number().nonnegative().optional(),
          })
          .optional(),
        placement: z
          .object({
            position: v3,
            target: v3,
            roll_deg: z.number().finite().optional(),
          })
          .optional(),
      },
    },
    async ({ image, lines, principal_point, scale_anchor, placement }) => {
      unique(lines.map((l) => l.id));
      const im = decodeImage(image);
      const solve = solveCamera([im.w, im.h], lines, { principal_point });
      let camera: CameraFrame | null = null;
      const intrinsics = solve.intrinsics,
        tilt = solve.pose.tilt_above_horizontal_deg ?? 0;
      // Legacy solver roll uses the opposite sign to camera_frame_v1's right/down axes.
      const roll = solve.pose.roll_deg === null ? null : -solve.pose.roll_deg;
      let anchor_residual_m: number | null = null;
      if (
        intrinsics &&
        !solve.inconsistent &&
        (placement || solve.camera_for_unproject)
      ) {
        if (placement)
          camera = makeFrame(
            [im.w, im.h],
            intrinsics.focal_px,
            intrinsics.principal_point as [number, number],
            placement.position,
            placement.target,
            placement.roll_deg ?? roll ?? 0,
          );
        else if (scale_anchor) {
          const anchored = anchorFrame(
            [im.w, im.h],
            intrinsics.focal_px,
            intrinsics.principal_point as [number, number],
            tilt,
            roll ?? 0,
            scale_anchor.bottom,
            scale_anchor.top,
            scale_anchor.height_m,
          );
          anchor_residual_m = anchored.residual_m;
          if (anchor_residual_m > Math.max(0.01, scale_anchor.height_m * 0.02))
            throw Error(
              "Scale anchor is inconsistent with the solved vertical direction; recheck its endpoints",
            );
          camera = anchored.camera;
        }
      }
      return result({
        schema_version: 1,
        reference_sha256: hash(image),
        camera,
        anchor_residual_m,
        calibration: {
          intrinsics: intrinsics
            ? {
                focal_px: intrinsics.focal_px,
                principal_point: intrinsics.principal_point,
                principal_point_source: intrinsics.principal_point_source,
              }
            : null,
          families: solve.families,
          horizon: solve.horizon,
          pose: { ...solve.pose, roll_deg: roll },
          cross_check: solve.cross_check,
          next: solve.next,
          inconsistent: solve.inconsistent,
        },
        scale: scale_anchor ?? { status: "unknown" },
        dimension_status: camera
          ? "derived"
          : scale_anchor
            ? "unresolved"
            : "unscaled",
        placement_status: placement
          ? "supplied"
          : camera
            ? "anchor_frame_assumption"
            : "required",
        note: "Default frame puts the anchor bottom at world origin and aims along +Y with the solved tilt and roll. The anchor bottom is assumed to be ground level. Building axes need not align with world X/Y; use yaw_to_family_deg or explicit placement. Scale and camera uncertainty are not eliminated by pixel agreement.",
      });
    },
  );
  s.registerTool(
    "place_features",
    {
      description:
        "Intersect image rays with any plane in the same Z-up world as Blender/IFC. Results are conditional estimates; pick sensitivity excludes camera/scale uncertainty.",
      inputSchema: {
        camera: frame,
        plane: z.object({ origin: v3, normal: v3 }),
        features: z.array(z.object({ id: z.string(), pixel })).min(1),
        pick_uncertainty_px: z.number().nonnegative().optional(),
      },
    },
    async ({ camera, plane, features, pick_uncertainty_px }) => {
      unique(features.map((f) => f.id));
      const r = intersectPlane(
        camera as CameraFrame,
        plane,
        features.map((f) => f.pixel),
        pick_uncertainty_px,
      );
      return result({
        ...r,
        points: r.points.map((p, i) => ({ id: features[i].id, ...p })),
      });
    },
  );
  s.registerTool(
    "compare_model",
    {
      description:
        "Compare fixed named landmarks and/or explicit binary subject masks; write overlay and report. Missing evidence returns INCOMPLETE. RGB sky detection cannot drive a verdict.",
      inputSchema: {
        reference: z.string(),
        render: z.string(),
        observations: z.string().optional(),
        camera: frame.optional(),
        model_points: z.record(z.string(), v3).optional(),
        render_mask: z.string().optional(),
        out_dir: z.string().optional(),
        history_path: z.string().optional(),
        name: z.string().optional(),
        tolerance_px: z.number().positive().optional(),
        min_mask_iou: z.number().min(0.01).max(1).optional(),
      },
    },
    async (req) => result(evaluate(req as EvaluationRequest)),
  );
  return s;
}
