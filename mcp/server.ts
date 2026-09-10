/**
 * photo-to-threejs MCP server.
 *
 * The load-bearing fact: an MCP server cannot perform the reconstruction.
 * The modelling is an LLM writing TypeScript across many iterations; the
 * intelligence stays in the host client. This server wraps the method:
 *
 *   deterministic parts -> tools   (measure_reference, score_render)
 *   the method itself   -> prompt  (SKILL.md ships with the server)
 *   the viewer          -> panel   (MCP App) + localhost URL fallback
 *
 * Both acceptance-test runs independently rebuilt exactly these tools mid-run
 * — that convergent reinvention, not optimism, is why these two are the ones
 * shipped. A further meta-finding funds `score_render`: two runs self-scored
 * ~4–8 px with their own rulers and differed 5x under one ruler. Self-scores
 * are not comparable; a standard scorer is.
 */
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { logHandshake } from "./log.ts";
import { inlineViewer } from "./src/bundle.ts";
import { solveCamera, unprojectPoints } from "./src/camera.ts";
import { normalizeCrops, traceEdge, viewCrop, viewCropSheet } from "./src/instruments.ts";
import { BUNDLE_META } from "./src/protocol.ts";
import {
  classifyReference,
  compareImages,
  decodeImage,
  measureImage,
  measurePitch,
  scoreImages,
} from "./src/scan.ts";
import { initWorkspace } from "./src/workspace.ts";
import { ensureViewerServer, PREFERRED_PORT } from "./viewer-server.ts";

const HERE = import.meta.dirname;
// Source layout: mcp/dist/mcp-app.html relative to mcp/server.ts.
// Bundled layout: the bundle itself lives IN mcp/dist, next to mcp-app.html.
const DIST_DIR = fs.existsSync(path.join(HERE, "dist", "mcp-app.html")) ? path.join(HERE, "dist") : HERE;
const PANEL_URI = "ui://photo-to-threejs/viewer-panel.html";

/**
 * CSP for the panel. The primary rendering path no longer needs any of this:
 * the viewer is inlined and written into the frame with `srcdoc`, which has
 * no origin to allow. The declaration stays for the localhost fallback path
 * — and, having watched a pinned origin lose the race when the preferred port
 * was taken, it covers the whole probe range rather than one port.
 *
 * `data:` is the load-bearing entry now: an inlined viewer carries its
 * reference photograph and textures as data URIs, which is an img-src matter.
 */
const VIEWER_ORIGINS = Array.from({ length: 20 }, (_, i) => `http://127.0.0.1:${PREFERRED_PORT + i}`);
const PANEL_CSP = {
  frameDomains: VIEWER_ORIGINS,
  connectDomains: VIEWER_ORIGINS,
  resourceDomains: ["data:", "blob:"],
};

/** SKILL.md travels with the server: repo layout first, bundled copy second. */
function skillText(): string {
  const candidates = [
    path.join(HERE, "..", "skills", "photo-to-ifc-building", "SKILL.md"),
    path.join(HERE, "..", "..", "skills", "photo-to-ifc-building", "SKILL.md"), // bundled in mcp/dist
    path.join(HERE, "SKILL.md"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf-8");
  }
  return "SKILL.md not found next to the server — fetch it from https://github.com/alekseikondratenko/photo-to-bim";
}

/**
 * Region-of-interest, shared by every scanning tool.
 *
 * The detectors are not blind because the measurement is wrong; they are
 * blind because nothing aimed them. Four of four real field photographs
 * defeated the sky-margin scan (dusk gradient, sea horizon, vegetation,
 * hero-crop margins), and in each case the agent had already cropped the
 * image by hand within minutes. Judgement in the agent, determinism in the
 * tool — this parameter is where the two meet.
 */
const CROP = z
  .object({
    x0: z.number().describe("Left edge, in ORIGINAL image pixels"),
    y0: z.number().describe("Top edge, in ORIGINAL image pixels"),
    x1: z.number().describe("Right edge, in ORIGINAL image pixels"),
    y1: z.number().describe("Bottom edge, in ORIGINAL image pixels"),
  })
  .optional()
  .describe(
    "Region to scan, in original-image pixels. Use it when foreground clutter " +
    "(trees, crowds, a tight crop) reaches the frame margins and the sky-bounded " +
    "detectors report few or no usable rows. Reported coordinates come back in " +
    "full-image space so they stay comparable across crops.",
  );

/**
 * Target profile. The instruments (measurement, camera, scoring) are universal;
 * the web-viewer plumbing (init_workspace, open_viewer, the panel) is a target.
 * `--profile ifc` does not merely discourage the web tools — it never registers
 * them, so an IFC session cannot call the wrong target's tools at all. Same
 * design as the scoring gate: remove the wrong door, don't guard it.
 */
function profileFromArgv(): "all" | "ifc" | "web" {
  const argv = process.argv;
  const i = argv.indexOf("--profile");
  const raw = i >= 0 ? argv[i + 1] : argv.find((a) => a.startsWith("--profile="))?.split("=")[1];
  return raw === "ifc" || raw === "web" ? raw : "all";
}

export function createServer(): McpServer {
  const profile = profileFromArgv();
  const webTarget = profile !== "ifc";
  const server = new McpServer({ name: "photo-to-bim", version: "0.6.1" });

  server.registerTool(
    "classify_reference",
    {
      title: "Classify a reference photograph (evidence, not verdict)",
      description:
        "Numeric hints for Step 1: vertical-edge slopes (tilt/parallel verticals), per-band " +
        "pitch drift (the linearity test), end-pitch asymmetry (the two-faces falsification), " +
        "silhouette taper. HONEST LIMITS: the detector needs a sky-bounded silhouette, so it " +
        "is strong on tall subjects against sky and weak on wide or occluded ones — on those " +
        "it auto-retries with interior crops and says exactly what it tried, but classifying " +
        "by eye (use view_crop to look closely) beats it there. Classification itself is " +
        "always the agent's judgement; treat this as one witness, never the verdict.",
      inputSchema: {
        image: z.string().describe("Absolute path to the photograph (png/jpg)"),
        crop: CROP,
      },
    },
    async ({ image, crop }) => {
      logHandshake("tools/call", { tool: "classify_reference", image, crop });
      const result = classifyReference(image, crop);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  if (webTarget) {
  server.registerTool(
    "init_workspace",
    {
      title: "Scaffold a reconstruction workspace",
      description:
        "Copies the viewer template into <dir>/viewer (if absent), writes compilable " +
        "placeholder models/<id>.ts + scenes/<id>.ts stubs, registers the subject in " +
        "main.ts, copies the reference photograph into viewer/public/ (so the browser and " +
        "the scoring gate can reach it), and scaffolds RECON.md — the working ledger. " +
        "The workspace's dev server scores EVERY render saved via POST /__save-render " +
        "automatically and returns the numbers in the save response. Placeholder numbers " +
        "in the stubs are loudly marked: replace them with measured values before scoring " +
        "— a converged score against invented targets is the false-100% trap.",
      inputSchema: {
        dir: z.string().describe("Absolute path of the workspace parent directory"),
        subject: z.string().describe("Subject id, e.g. 'flatiron' — letters/digits only"),
        referenceImage: z
          .string()
          .optional()
          .describe(
            "Absolute path to the reference photograph — it is copied into viewer/public/ " +
            "and wired into the scene and the scoring gate. (A URL or public path is " +
            "passed through as-is.)",
          ),
      },
    },
    async ({ dir, subject, referenceImage }) => {
      logHandshake("tools/call", { tool: "init_workspace", dir, subject });
      const result = initWorkspace(dir, subject, referenceImage);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );
  }

  server.registerTool(
    "measure_reference",
    {
      title: "Measure a reference photograph",
      description:
        "Deterministic pixel measurement of a building photograph: per-row-sky silhouette, " +
        "floor-pitch autocorrelation per height band, lit/shadow bands. Run this before " +
        "hand-measuring anything. Reports measurements, not conclusions — a pitch that " +
        "drifts between bands means perspective is non-linear (use local ratios). Pass " +
        "`crop` when foreground clutter reaches the margins.",
      inputSchema: {
        image: z.string().describe("Absolute path to the photograph (png/jpg)"),
        crop: CROP,
      },
    },
    async ({ image, crop }) => {
      logHandshake("tools/call", { tool: "measure_reference", image, crop });
      const result = measureImage(image, crop);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "view_crop",
    {
      title: "Magnified crop(s) with a coordinate grid — look closely, keep your bearings",
      description:
        "Writes a PNG of the crop, upscaled, with a labelled pixel grid burned in " +
        "(magenta = x, cyan = y, labels in ORIGINAL image coordinates). Use it whenever " +
        "you need to LOOK at a detail and read positions off what you see — junctions, " +
        "eave lines, window corners. Every observed run hand-built exactly this " +
        "(crop.py + PIL); this version needs no Python and no dependency check. Read the " +
        "output image with your normal image reading.",
      inputSchema: {
        image: z.string().describe("Absolute path to the photograph (png/jpg)"),
        // Deliberately NOT a union: the SDK's schema conversion collapses
        // unions into an untyped field, the model then guesses (a field run
        // sent strings six times), and validation rejects every guess. Loose
        // schema, strict-but-liberal normalisation in the handler.
        crop: z
          .any()
          .describe(
            "One region {x0,y0,x1,y1} in ORIGINAL image pixels, or an ARRAY of up to 6 " +
            "such regions for a contact sheet (all tiles in one image, each numbered and " +
            "separately gridded — one call instead of six round-trips).",
          ),
        out: z.string().describe("Absolute path for the output PNG"),
        scale: z.number().optional().describe("Upscale factor (default: sized to ~1400 px output)"),
        grid: z.number().optional().describe("Grid step in original pixels (default: a round step giving 8-20 lines)"),
      },
    },
    async ({ image, crop, out, scale, grid }) => {
      logHandshake("tools/call", { tool: "view_crop", image, crop, out });
      const crops = normalizeCrops(crop);
      const result = crops.length > 1
        ? viewCropSheet(image, crops, out, { scale, grid })
        : viewCrop(image, crops[0], out, { scale, grid });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "trace_edge",
    {
      title: "Trace a boundary to sub-pixel numbers — eyes locate, the tool reads off",
      description:
        "Scans a crop along an axis and returns the first luma boundary as points in " +
        "ORIGINAL image coordinates, with a robust Theil–Sen line fit and a ready " +
        "segment_for_solve_camera. Use it to turn an edge you can SEE (ridge against sky, " +
        "eave shadow line, wall corner) into exact endpoints instead of reading pixels by " +
        "eye — hand-picked endpoints are ±3 px at best, and that is precisely what turns a " +
        "solve_camera verdict 'weak'. direction is the scan direction: 'down' finds the " +
        "top boundary (skyline), 'right' finds the left boundary, etc. A high " +
        "residual_max_px means the boundary is not one straight edge — split the crop.",
      inputSchema: {
        image: z.string().describe("Absolute path to the photograph (png/jpg)"),
        crop: z.object({
          x0: z.number(), y0: z.number(), x1: z.number(), y1: z.number(),
        }).describe("Region to scan, in ORIGINAL image pixels — tight around ONE edge"),
        direction: z.enum(["down", "up", "left", "right"])
          .describe("Scan direction: 'down' = first hit from the top per column (skyline), 'up' = from the bottom, 'left'/'right' = per row"),
        threshold: z.number().optional()
          .describe("Luma threshold (default: midpoint of the crop's 10th/90th percentile — usually right)"),
        condition: z.enum(["below", "above"]).optional()
          .describe("Hit when luma is below (dark subject on light sky — default) or above the threshold"),
      },
    },
    async ({ image, crop, direction, threshold, condition }) => {
      logHandshake("tools/call", { tool: "trace_edge", image, crop, direction });
      const result = traceEdge(image, crop, direction, { threshold, condition });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "solve_camera",
    {
      title: "Solve the camera from picked lines — call it EARLY, iterate through it",
      description:
        "Give it 4–10 line segments along real-world parallel families (vertical edges, " +
        "eaves, sills, ridges) and it returns vanishing points with per-line residuals, the " +
        "horizon, focal length, tilt/roll/yaw, eye height, and a ready-to-paste Three.js " +
        "camera block including the setViewOffset arithmetic for an off-centre principal " +
        "point. CALL IT EARLY WITH ROUGH LINES — do not polish lines first. A 'weak' " +
        "verdict is normal on the first call and the result names the exact worst line to " +
        "re-pick; iterating through the solver converges in 2–3 calls, while gathering " +
        "'confident' lines before calling has been measured to cost a 30-minute manual " +
        "algebra detour that the solver then confirmed in one call. The solver is the " +
        "instrument for finding out which lines are good, not a finisher for lines already " +
        "trusted. It is also the arbiter for structural hypotheses: label the lines per " +
        "hypothesis and the residuals say which reading of the building is consistent. " +
        "Inconsistent input returns 'inconsistent' plus the offending line, never a forced " +
        "number. Verticals parallel in the image are handled as a shifted-lens/cropped " +
        "frame (principal point on the horizon), not a tilt. Every result ends with a " +
        "`next` block: what to build next, and whether `unproject` is unlocked — read it, " +
        "it is the routing, not decoration.",
      inputSchema: {
        image: z.string().describe("Absolute path to the photograph (png/jpg) — read for its size"),
        lines: z
          .array(
            z.object({
              x0: z.number(), y0: z.number(), x1: z.number(), y1: z.number(),
              label: z
                .string()
                .optional()
                .describe(
                  "Family this line belongs to: lines PARALLEL IN THE WORLD share a label. " +
                  "Use 'vertical' for vertical edges; any names for the horizontal families " +
                  "(e.g. 'eave-left', 'eave-right'). Omit and families are guessed from " +
                  "direction, which is reported back so you can correct it.",
                ),
            }),
          )
          .min(4)
          .describe("Line segments in ORIGINAL image pixels. 3+ per family enables the real check."),
        known: z
          .object({
            height_m: z.number().optional().describe("True height spanned by the vertical lines, in metres"),
            pitch_deg: z.number().optional().describe("Roof pitch you already measured — echoed, not fitted"),
            principal_point: z
              .enum(["centre", "solve"])
              .optional()
              .describe(
                "Default 'centre' (right for an uncropped photograph, and measurably more " +
                "accurate under realistic pick noise). Use 'solve' only for a cropped or " +
                "shift-lens image: it is exact on perfect input but amplifies pick error.",
              ),
          })
          .optional()
          .describe("Supply height_m to turn ratios into metres (eye height and camera distance)"),
      },
    },
    async ({ image, lines, known }) => {
      logHandshake("tools/call", { tool: "solve_camera", image, lines: lines.length });
      const im = decodeImage(image);
      const result = solveCamera([im.w, im.h], lines, known);
      return {
        content: [{ type: "text", text: JSON.stringify({ image, ...result }, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "unproject",
    {
      title: "Pixels → world coordinates on a plane (use it INSTEAD of measuring features)",
      description:
        "Once solve_camera has given you a usable camera, STOP measuring features in " +
        "pixels: give this tool the camera, a plane, and the image points, and it returns " +
        "world coordinates. Windows, doors, trim, terrace corners — all of it. The last " +
        "field run spent ~25 minutes on magnify-and-measure cycles AFTER its camera was " +
        "already solved; this is that time back. Planes are named the way you model: the " +
        "facade is {axis:'z', value:0}, a gable wall {axis:'x', value:0}, the ground " +
        "{axis:'y', value:0}. Pass `eye` as the camera position in YOUR scene frame (from " +
        "the camera block: [0, eye_height, -horizontal_distance] with the camera looking " +
        "toward +Z). Every point is reprojected as a check — reprojection_error_px near " +
        "zero means the mapping is sound; a large value means the wrong plane.",
      inputSchema: {
        camera: z
          .object({
            focal_px: z.number(),
            principal_point: z.array(z.number()).length(2),
            up: z.array(z.number()).length(3),
          })
          .describe("Pass solve_camera's `camera_for_unproject` back in verbatim"),
        plane: z
          .object({
            axis: z.enum(["x", "y", "z"]),
            value: z.number(),
          })
          .describe("The plane the points lie on, e.g. {axis:'z', value:0} for the facade"),
        points: z
          .array(z.array(z.number()).length(2))
          .describe("Image points [[px,py], ...] in ORIGINAL image pixels"),
        eye: z
          .array(z.number())
          .length(3)
          .optional()
          .describe("Camera position in your scene frame, default [0,0,0] (world origin)"),
      },
    },
    async ({ camera, plane, points, eye }) => {
      logHandshake("tools/call", { tool: "unproject", plane, points: points.length });
      const result = unprojectPoints(
        {
          focal_px: camera.focal_px,
          principal_point: [camera.principal_point[0], camera.principal_point[1]],
          up: [camera.up[0], camera.up[1], camera.up[2]],
        },
        plane,
        points.map((p) => [p[0], p[1]] as [number, number]),
        eye ? ([eye[0], eye[1], eye[2]] as [number, number, number]) : undefined,
      );
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "measure_pitch",
    {
      title: "Measure a repeating pitch in a chosen region",
      description:
        "Autocorrelation, aimed: point it at a crop and an axis and it returns the " +
        "repeating pitch in pixels. Use it for floor and course spacing, baluster and bay " +
        "rhythm, and the per-face end-pitch comparison (call twice with two crops — a " +
        "tighter pitch at one end means that end recedes). Warns when the pitch is at the " +
        "JPEG noise floor (~8 px) or when fewer than ~3 repeats were seen, which is a " +
        "coincidence rather than a rhythm.",
      inputSchema: {
        image: z.string().describe("Absolute path to the photograph (png/jpg)"),
        axis: z
          .enum(["vertical", "horizontal"])
          .describe("'vertical' = rhythm running down the image (floors, courses); 'horizontal' = across (bays, balusters)"),
        crop: CROP,
      },
    },
    async ({ image, axis, crop }) => {
      logHandshake("tools/call", { tool: "measure_pitch", image, axis, crop });
      const result = measurePitch(image, axis, crop);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "compare_images",
    {
      title: "Build the evidence pack for two images",
      description:
        "Writes overlay.png (50% blend), wipe.png (split) and edge_diff.png (both " +
        "silhouettes drawn on A) into out_dir, and returns the paths together with the " +
        "full score_render numbers. One call instead of the side-by-sides every run " +
        "hand-builds. Pass the photograph as imageA and the render as imageB; B is " +
        "resized to A. The pictures and the numbers come from the same detector, so a " +
        "defect visible in edge_diff is the defect the score is counting. CADENCE: run this " +
        "(or read the auto-score every /__save-render returns) on EVERY iteration pass and " +
        "log the numbers in RECON.md — a field run that scored once and then eyeballed " +
        "drifted for an hour without converging. Fix the largest measured error first.",
      inputSchema: {
        imageA: z.string().describe("Absolute path to the base image — normally the reference photograph"),
        imageB: z.string().describe("Absolute path to the compared image — normally the render"),
        out_dir: z.string().describe("Absolute path of the directory to write the three PNGs into (created if absent)"),
      },
    },
    async ({ imageA, imageB, out_dir }) => {
      logHandshake("tools/call", { tool: "compare_images", imageA, imageB, out_dir });
      const result = compareImages(imageA, imageB, out_dir);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "score_render",
    {
      title: "Score a render against the reference",
      description:
        "Scans render and reference photograph with the SAME silhouette detector and reports " +
        "edge error, area ratio, tip row, in-silhouette luma and sky gradient. Use the render " +
        "saved by the viewer's /__save-render endpoint (exact drawing-buffer size — never a " +
        "screenshot, they rescale). Note the endpoint already scores each save automatically " +
        "and returns the silhouette numbers — this tool adds the luma/sky detail on top. " +
        "Score EVERY pass, log it in RECON.md, fix the largest error first. Identity " +
        "features are not covered: target them separately. The skyline block also localises " +
        "the error: `worst_segments` names the worst contiguous column ranges and which way " +
        "each is wrong ('x 1180-1400, render skyline too HIGH'), so you can go straight to " +
        "the element that spans them instead of re-reading the whole overlay.",
      inputSchema: {
        render: z.string().describe("Absolute path to the render png"),
        reference: z.string().describe("Absolute path to the reference photograph"),
      },
    },
    async ({ render, reference }) => {
      logHandshake("tools/call", { tool: "score_render", render, reference });
      const result = scoreImages(render, reference);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        structuredContent: result as unknown as Record<string, unknown>,
      };
    },
  );

  if (webTarget) {
  registerAppTool(
    server,
    "open_viewer",
    {
      title: "Open the reconstruction viewer",
      description:
        "Serves a built viewer directory (one containing index.html — for a vite workspace, " +
        "`npm run build` first and pass dist/) and shows it in a panel where the host supports " +
        "MCP Apps. In such hosts this is the way to put the reconstruction inline in the " +
        "conversation — prefer it whenever the user asks to see the result in chat. Always " +
        "also returns a localhost URL: hosts without panels open it in a browser instead. " +
        "During active modelling prefer the workspace's own dev server — it hot-reloads; this " +
        "panel refreshes per call. HOSTS MAY SILENTLY NOT RENDER THE PANEL (Claude Code as of " +
        "2.1.222 does not fetch the View at all): unless the user confirms seeing it, report " +
        "the URL and never state that a panel is visible.",
      inputSchema: {
        dir: z.string().describe("Absolute path to the built viewer directory (contains index.html)"),
      },
      // `csp` is deliberately NOT set here: the spec puts it on the UI
      // resource, hosts read it from the resources/read result, and the type
      // declares it `never` on a tool. It was set here too while the blank
      // frame was being chased; that was noise, and noise in a security
      // declaration is worse than nothing.
      _meta: { ui: { resourceUri: PANEL_URI } },
    },
    async ({ dir }) => {
      logHandshake("tools/call", { tool: "open_viewer", dir });
      const viewerUrl = await ensureViewerServer(dir);
      return {
        content: [{ type: "text", text: `Viewer serving at ${viewerUrl}` }],
        // `dir` travels so the panel can ask for the inlined bundle; the URL
        // travels so every host has a path that works without a panel.
        structuredContent: { viewerUrl, dir: path.resolve(dir) },
      };
    },
  );
  }

  if (webTarget) {
  registerAppTool(
    server,
    "get_viewer_bundle",
    {
      title: "Inline a viewer directory into one self-contained document",
      description:
        "Panel-only: inlines a viewer directory into one self-contained document for the " +
        "panel to render. Not for the agent — call open_viewer instead. Calling this " +
        "yourself returns a summary only; the document is not in the agent-facing result.",
      inputSchema: {
        dir: z.string().describe("Absolute path to the built viewer directory"),
      },
      _meta: { ui: { resourceUri: PANEL_URI, visibility: ["app"] } },
    },
    async ({ dir }) => {
      logHandshake("tools/call", { tool: "get_viewer_bundle", dir });
      const bundle = inlineViewer(dir);
      const summary = {
        bytes: bundle.bytes,
        inlined: bundle.inlined,
        missing: bundle.missing,
        mapped: bundle.mapped,
        skipped: bundle.skipped,
      };
      return {
        // The document travels in `_meta` and NOWHERE else. `visibility: ["app"]`
        // is advisory — the SDK does not filter tools/list, and a host that
        // ignores it would otherwise let an agent call this and paste multiple
        // megabytes of HTML into its own context. `content` and
        // `structuredContent` are what a model sees, so they carry the summary;
        // `_meta` is protocol metadata, and the panel reads the payload there.
        content: [{ type: "text", text: JSON.stringify(summary) }],
        structuredContent: summary,
        _meta: { [BUNDLE_META]: { html: bundle.html, bytes: bundle.bytes } },
      };
    },
  );
  }

  if (webTarget) {
  registerAppResource(
    server,
    "Reconstruction viewer panel",
    PANEL_URI,
    { mimeType: RESOURCE_MIME_TYPE, _meta: { ui: { csp: PANEL_CSP } } },
    async () => {
      const html = await fsp.readFile(path.join(DIST_DIR, "mcp-app.html"), "utf-8");
      return {
        contents: [
          {
            uri: PANEL_URI,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
            // Read-result metadata takes precedence over the listing entry.
            _meta: { ui: { csp: PANEL_CSP } },
          },
        ],
      };
    },
  );
  }

  server.registerPrompt(
    "reconstruct_from_photo",
    {
      title: "Reconstruct a building from one photograph",
      description:
        "The full photo-to-bim method: measurement-first workflow, scoring loop, and the " +
        "delivery gates. Apply it to the photograph the user supplies.",
    },
    async () => ({
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text:
              (webTarget
                ? "Follow this method to rebuild the building in the photograph I provide as a " +
                  "procedural, measured Three.js model. "
                : "Follow this method to rebuild the building in the photograph I provide as a " +
                  "measured IFC model, authored through Bonsai/ifcopenshell in Blender. ") +
              "Use this server's tools for the " +
              "deterministic steps instead of writing your own scripts:\n" +
              "- LOOK with `view_crop` (magnified, coordinate-gridded crops) and turn edges " +
              "you can see into numbers with `trace_edge` — never read pixels by eye.\n" +
              "- Call `solve_camera` EARLY with rough lines and iterate through its " +
              "residuals; do not derive vanishing points by hand, and do not polish lines " +
              "before the first call — 'weak' plus a named worst line IS the workflow.\n" +
              "- Once the camera is usable, get feature positions with `unproject` — do NOT " +
              "keep measuring windows and doors in pixels; that is the single biggest " +
              "time sink left in the method.\n" +
              "- `measure_pitch` for any repeating rhythm; `classify_reference`/" +
              "`measure_reference` as extra witnesses where a sky-bounded silhouette exists.\n" +
              (webTarget
                ? "- `init_workspace` for the workspace. It scaffolds RECON.md — the working " +
                  "ledger. Rewrite it every step: verified facts with evidence, assumptions, " +
                  "REFUTED hypotheses (once buried, they stay dead), and the score history.\n" +
                  "- Every render saved via POST /__save-render is scored automatically and the " +
                  "numbers come back in the save response. Read them EVERY pass, log them in " +
                  "RECON.md, fix the largest error first. Never iterate by eyeballing " +
                  "screenshots.\n\n"
                : "- Keep RECON.md as the working ledger. Rewrite it every step: verified facts " +
                  "with evidence, assumptions, REFUTED hypotheses (once buried, they stay " +
                  "dead), and the score history.\n" +
                  "- Paste `camera_for_blender` from the solve result — never re-derive the " +
                  "camera mapping by hand. Render from PhotoCam at the exact reference size " +
                  "and score EVERY pass with `score_render`; fix the largest located error " +
                  "first. Never iterate by eyeballing screenshots.\n\n") +
              "- Batch independent fixes into one pass, and stop optimising a metric that " +
              "has moved less than 0.5% of the image diagonal over two passes.\n\n" +
              (webTarget
                ? "Before delivering: run `window.__clearance()` (any penetration blocks " +
                  "delivery), review the 3/4, side, rear and top renders with fresh eyes, then " +
                  "build the workspace (`npm run build`) and call `open_viewer` so the result " +
                  "appears in the conversation — the run is not done until the viewer is " +
                  "delivered.\n\n"
                : "Before delivering, run the IFC gate in one script: ifcopenshell.validate " +
                  "(schema clean), open every element through the geometry engine, print the " +
                  "entity census (IfcBuildingElementProxy must be ~0), check every element is " +
                  "contained in a storey, and score the final PhotoCam render against the " +
                  "photograph. The run is not done until house.ifc, the comparison render and " +
                  "a README manifest are saved in the working folder.\n\n") +
              skillText(),
          },
        },
      ],
    }),
  );

  return server;
}
