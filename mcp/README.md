# MCP server

The deterministic half of the method, as tools. The modelling intelligence stays in the
host agent — an MCP server cannot perform the reconstruction (the White House run took
190 tool calls of an LLM writing TypeScript). The server wraps what *is* deterministic:

| Tool | What it does |
|---|---|
| `view_crop` | Magnified crop with a labelled pixel grid burned in — look closely and read positions in ORIGINAL image coordinates. Every field run hand-built this (crop.py); now it needs no Python |
| `trace_edge` | An edge you can see → exact numbers: per-column/row boundary points, Theil–Sen line fit with residuals, and a segment ready for `solve_camera` |
| `unproject` | Image points + a plane → world coordinates, with a reprojection check on every point. Use it INSTEAD of pixel-measuring features once the camera is solved — a field run spent ~25 minutes measuring what this returns in one call |
| `solve_camera` | Vanishing points from lines **you** pick, with per-line residuals and a leave-one-out check; horizon, focal length, tilt/roll/yaw, eye height, metric distance, and a paste-ready Three.js camera block including `setViewOffset`. **Call it early and iterate through the residuals** — 'weak' + a named worst line is the workflow, not a failure. Parallel verticals are treated as a shifted lens (principal point on the horizon), never a spurious tilt |
| `classify_reference` | Evidence for Step 1: vertical-edge slopes, per-band pitch drift, end-pitch asymmetry, silhouette taper. Hints, never a verdict. Auto-retries with interior crops when the full-frame scan is blind, and says exactly what it tried |
| `measure_reference` | Pixel measurement of a photograph: per-row-sky silhouette, floor-pitch autocorrelation per height band, lit/shadow bands |
| `measure_pitch` | The same autocorrelation, aimed at a crop and an axis: floor and course spacing, baluster and bay rhythm, per-face end-pitch |
| `compare_images` | Writes `overlay.png` / `wipe.png` / `edge_diff.png` and returns the full `score_render` numbers — the evidence pack every run used to hand-build |
| `score_render` | Scans render and reference with the **same** detector: row-wise silhouette AND column-wise skyline (the transpose — the primary signal on wide subjects), luma, sky gradient |
| `init_workspace` | Scaffolds `<dir>/viewer` + `RECON.md` (the working ledger), copies the reference into `public/`, and wires the **auto-scoring gate** (silhouette + skyline + luma, blank-render guard, score deltas, RECON auto-rows) and the **render trigger** (`POST /__render {view,name}` — a scoring pass is one curl): the dev server scores every render saved via `POST /__save-render` and returns the numbers in the save response — saving and being graded are one action |
| `open_viewer` | Serves a built viewer directory and shows it in an MCP App panel where the host supports one; always returns a localhost URL for a real browser |

Every scanning tool takes an optional `crop` (original-image pixels) and reports
coordinates back in full-image space. That parameter is the architecture in miniature:
**judgement in the agent, determinism in the tool**. The margin-based detectors failed on
4 of 4 real field photographs — dusk gradient, sea horizon, vegetation, hero-crop margins
— not because the measurement was wrong but because nothing had aimed it. On the prefab
house that defeated the scanner outright (5 usable rows), an aimed crop yields 279.

**Crop only when the uncropped scan fails.** Measured across the five reference
photographs, a crop is a power tool with a sharp edge: it rescues occluded margins
(prefab 5 → 279 rows) and it *destroys* a scan that was already working — cropping Taipei
101 tight to the tower left no sky at the margins at all and dropped 824 usable rows to 6.
The rule is simple: run uncropped first, and reach for `crop` only when the evidence comes
back empty or the silhouette is visibly picking up skyline and foreground rather than the
subject. A badly aimed crop is reported as a failed detection, never as a fabricated
measurement — but it is still a wasted pass.

**No unions in MCP input schemas.** The SDK's schema conversion collapses a
`z.union` to an untyped field, and a model facing an untyped field guesses — v0.5.1
shipped a union for `view_crop`'s `crop` and a field agent produced six different
JSON-string spellings, collected six validation errors, and rebuilt its own crop script
in Python. The house pattern is a loose schema plus normalisation in the handler:
`normalizeCrops` accepts every shape that was ever sent and the six field spellings are
regression cases.

Plus the method itself as an MCP prompt: `reconstruct_from_photo` ships the full
SKILL.md, wired to prefer these tools over hand-written scanners.

Why these tools and not others: the rule is that a capability earns a tool when **two or
more independent runs hand-built it or burned >15 minutes on it**. One data point gets
logged, not built. Camera algebra qualified loudly (one run ~40 minutes, another spiralled
~30 through five re-derivations with sign slips); lighting debugging did not, and stayed
knowledge rather than a tool. The two acceptance runs also self-scored ~4–8 px with their
own rulers while differing 5× under one ruler — *self-scores are not comparable across
runs*, which is the whole case for a standard `score_render`.

## What the panel is

A window onto the real viewer, not a second engine that could drift. `open_viewer` gives
the panel the viewer **inlined into one self-contained document**, delivered over the
app→server channel (`get_viewer_bundle`, app-only visibility, so a multi-megabyte payload
never enters the model's context) and rendered with `srcdoc`.

That indirection is the fix for a bug that survived two attempts. The panel used to iframe
`http://127.0.0.1:<port>` directly, and that load has four independent gates — the host
honouring the declared `frameDomains`, the http scheme surviving inside a secure-context
sandbox, Chromium's private-network block on a public page embedding `127.0.0.1`, and the
served port matching what the CSP declared. Any one of them blanks the frame, and a
CSP-blocked iframe still fires `load`, so the panel could not even tell which had shut.
A `srcdoc` document has none of those gates: no origin, no port, no network. The localhost
URL remains as the fallback path and for hosts with no panel at all.

Host matrix for panels (per-client, not per-vendor):

| Host | Panel |
|---|---|
| ext-apps reference host | ✅ |
| Claude Desktop (chat) | ✅ renders |
| Claude Desktop (Cowork) | ❌ identifies as `claude-code` |
| Claude Code 2.1.237 | ✅ renders (fetches the View and the panel bundle) |

Because of that spread, every result also carries the plain URL, and the tool description
tells the agent never to claim a panel is visible unless the user confirms it.

## Install

```bash
npm install && npm run build
```

The panel bundle must be built before the server runs — the `ui://` resource is read from
`dist/mcp-app.html` at request time.

Client config (Claude Desktop `claude_desktop_config.json`, or `claude mcp add` for
Claude Code):

```json
{
  "mcpServers": {
    "photo-to-threejs": {
      "command": "node",
      "args": ["<abs-path>/mcp/node_modules/tsx/dist/cli.mjs",
               "<abs-path>/mcp/main.ts", "--stdio"]
    }
  }
}
```

> Use an **absolute** path to `node` if you manage Node with nvm — desktop clients launch
> with a minimal `PATH`. Restart the client fully afterwards; MCP servers load at startup.

## Typical loop

1. `classify_reference`, then `measure_reference` on the photograph. If the evidence comes
   back empty the margins are occluded — re-run with `crop`, don't proceed blind.
2. `solve_camera` with 4–10 lines picked along real parallel families. Check
   `cross_check.verdict` before building on the numbers: `weak` means a withheld line
   missed its own vanishing point, and re-picking it is cheaper than debugging downstream.
3. `init_workspace`, then author `models/<id>.ts` + `scenes/<id>.ts`, pasting the returned
   camera block.
4. Save an exact-size render: the workspace dev server accepts
   `POST /__save-render {name, dataUrl}` (never score a screenshot — they rescale).
5. `compare_images` photo-vs-render; fix the largest error; repeat. Identity features are
   not covered by the metrics — target them separately and check them by eye.
6. `open_viewer` on the built workspace (`npm run build` → pass `dist/`).

## Run standalone

```bash
npm run serve   # Streamable HTTP on :3001 — the port the ext-apps basic-host probes
```
