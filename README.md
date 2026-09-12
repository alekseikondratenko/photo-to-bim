# photo-to-bim

Photo-guided building reconstruction as semantic IFC, using a small agent skill,
measurement tools, and Blender with Bonsai. Version **0.8.1** focuses on repeatable
execution and honest validation. It does not claim survey accuracy from one image
or a demonstrated speed advantage over a capable agent with Blender alone.

The output has an `IfcProject → IfcSite → IfcBuilding → IfcBuildingStorey`
hierarchy, SI metre units, and typed walls, roofs, slabs, windows and doors.
Dimensions derived from pixels remain conditional on camera, scale and assumed
planes. The goal is a coherent exterior, including inferred side/rear surfaces
consistent with the visible form. Hidden geometry is an explicit assumption,
not recovered ground truth; unseen interiors and speculative decoration are omitted. Downstream application
interoperability must be tested; schema validation alone does not establish it.

## What changed in 0.8.1

- Fractional-scale crop sheets use integer pixel dimensions and tile offsets.
  This fixes an almost blank contact sheet produced by a valid 1.1× request;
  regression checks verify image content across multiple tiles and rows.
- The bootstrap example stores runtime and authoring state in a task-specific
  Blender namespace, then retrieves it between MCP calls. This avoids repeated
  undefined-variable recovery without reloading the model context on each call.
- Hidden-geometry guidance preserves the observed form, curvature and proportions
  while limiting unsupported additions. It applies to both conventional and
  freeform buildings; uncertain geometry remains explicitly assumed.

The six MCP tools and their argument schemas, scoring thresholds, material
handling and reconstruction iteration policy are unchanged.

## What changed in 0.8.0

- IFC import and checks share exported tessellation. The native iterator handles
  representation reuse and opening subtraction; compatible Blender meshes share
  data while occurrences retain individual placements and IFC links. Changes to
  IFC bytes, style sidecars or geometry settings invalidate the cache. Current
  Blender geometry and materials are still checked on every appearance assessment.
- Large imports can advance in bounded batches through the existing Blender MCP,
  reporting progress and retaining partial work on cancellation or failure. A
  batch yields between products; a single complex geometry operation can still
  block. Small models retain the synchronous API. See the
  [runtime reference](skills/photo-to-ifc-building/references/runtime.md).
- Geometry comparison accounts for Blender float32 rounding at tall-building
  coordinates, with a 0.01 mm base tolerance and a strict 0.1 mm ceiling. Unsupported
  coordinate magnitudes remain INCOMPLETE instead of receiving unlimited tolerance.
  IFC coordinates and photo-fit thresholds are unchanged.
- The skill advises simple hosts with semantic openings for dense facades, avoiding
  redundant pre-cut holes. It also asks for a coherent exterior with simple,
  documented hidden-surface assumptions. Ambiguous forms get a cheap side/rear
  viewport look within drafting; no additional scored-render loop or fixed pass
  count is introduced. Observation pixels must come from the photograph.

The MCP still exposes six tools with unchanged argument schemas for both Codex and
Claude Code. Material handoff and shader preservation behavior are unchanged.
These changes address failure mechanisms observed in local tests; they do not
establish an end-to-end latency improvement across buildings or clients.

## What changed in 0.7.2

- Fixed a client compatibility defect in MCP schemas: coordinate vectors now
  advertise homogeneous arrays with exact length bounds. Input values and the
  six-tool interface are unchanged. In test 8, the server started, but Codex
  rejected the camera/placement/comparison tools while building its tool catalog.
  A successful standalone handshake alone did not catch this. Read-only tools
  also advertise standard MCP read-only/idempotence hints; crop/report writers
  retain their write permissions.
- Early quantitative checks remain optional. Reuse fitting residuals or a
  compatible existing render when they can resolve a useful uncertainty. Cheap
  drafts stay unscored; no minimum or fixed count of reconstruction passes is set.
- Repeat checks only after relevant changes or new evidence when the expected
  benefit justifies the cost. A threshold miss or the three-result stall detector
  does not instruct the agent to keep evaluating. Final checks still report their
  actual outcome, including incomplete or failed results.

The shared skill and MCP schemas apply to both Codex and Claude Code. Setup
instructions belong to the respective client sections below; tool responses do
not carry client-specific routing or installation instructions.

Bounded live checks in Codex and Claude Code exposed all six tools and called
`place_features` successfully with the same synthetic input. These checks verify
client compatibility, not reconstruction quality or latency. Test 9 contains the
frozen 0.7.2 runtime for the next reconstruction run.

## What changed in 0.7.1

Test 7 produced a useful model, but exposed repeated custom work around mixed
materials, camera fitting and validation. This release keeps the six-tool surface
and adds reusable implementations for those gaps:

- Frame and glass keep separate IFC representation-item styles. `framed_fill`
  creates a semantic window or door without ragged mesh arrays or padding.
  `scene.import_ifc` links exported entities to Bonsai and preserves per-face styles.
- Camera calibration can refine an initial camera against fixed 3D landmarks,
  with optional focal length and optical shift. Geometry and metric scale stay
  fixed. Underconstrained or unfinished solves return `INCOMPLETE`.
- Exported-geometry landmark snapshots carry GlobalIds and an IFC hash. An older
  export cannot silently supply points for a newer model. Direct `model_points`
  remain supported but are explicitly reported as unbound.
- A check point counts as independent only when explicitly declared unused for
  **both camera and geometry fitting**. Consumed and undeclared checks have their
  own counts. Visual acceptance never rewrites an automated failure.
- Studio setup and rendering preserve material assignments and custom shaders.
  Read-only appearance checks report missing links, stale geometry, lost styles
  and overrides; restoring IFC materials is an explicit operation.
- Crop output rejects directories with a clear PNG filename error.

The live synthetic Blender/Bonsai import/render test passed for this release.
It verifies the adapter, not reconstruction accuracy or a speed gain. Test 8
subsequently exercised these helpers, but its client rejected three MCP tool
schemas. It does not establish an end-to-end tool benchmark.

## What changed in 0.7

- A short workflow skill replaces the long mandatory instruction sequence.
  Draft renders can be unscored; batch crops and edge observations reduce calls.
- Six IFC-focused MCP tools use one complete Z-up camera frame and arbitrary
  ray/plane intersections. Each observation can carry a stable ID.
- Fixed landmarks and explicit subject masks control photographic evaluation.
  RGB skyline detection cannot declare convergence or prescribe camera moves.
  Missing evidence returns `INCOMPLETE`; stalled improvement is not a pass.
- Blender and MCP use the **same evaluator**, rather than separate JS/Python
  implementations. Reports separate IFC validity, photo fit and appearance.
- Fresh versioned helper loading prevents stale Blender module imports. Styles
  are resolved from the explicit IFC path and linked by file hash and GlobalId.
- The IFC gate rejects empty models, missing geometry, invalid hierarchy,
  missing required classes and invalid openings/dimensions. Unavailable checks
  cannot silently pass. Gable walls have a helper; repeated window grids share
  fill geometry while retaining separate IFC occurrences.
- Portable release tests replace checks that depended on a developer's Desktop.
  The legacy Three.js viewer remains available through a separate server.

These are reliability changes, not measured benchmark wins. See the
[benchmark protocol](benchmarks/README.md) before comparing agent runs.

## Test locally in Codex, scoped to one folder

Requirements: Node.js 22+, Python 3.10+ for the installer, Blender with Bonsai
already installed, and a working Blender MCP connection. The bundled server
needs no npm install at runtime. IFC authoring runs inside Blender through its
MCP; the measurement server does not launch Blender.

From this repository:

```bash
python3 scripts/setup_codex_project.py ~/Desktop/blender-test-9 \
  --reference /absolute/path/to/house.jpg \
  --blender-command /absolute/path/to/uvx
```

Use a **new or empty** destination. Omit `--blender-command` to inherit an
existing Blender MCP registration. `--node` pins a Node executable if needed.
Use `--disable-mcp SERVER_NAME` to disable an inherited older measurement server
only in the test project. The installer copies a frozen runtime into `.agents/plugins/photo-to-bim`,
links its skill under `.agents/skills`, and writes `.codex/config.toml` with
absolute local MCP paths. It initializes a local Git boundary and records
runtime hashes. It never writes user-level Codex settings or installs a global
marketplace plugin.

Open that folder as a Codex project, trust it if prompted, and start a fresh
task using the generated `PROMPT.txt`. Codex exposes the local skill as
`photo-to-bim:photo-to-ifc-building`. The project's `SETUP.md` explains the
layout. Codex supports [repository skills](https://developers.openai.com/codex/skills/)
and [trusted project configuration](https://developers.openai.com/codex/config-basic/).
This setup enables the plugin's components locally; it does not add a global
Plugins UI entry. Existing global tools are still inherited. If you have an
older photo-to-bim marketplace install, disable that plugin for the test
project to avoid two versions being exposed together.

The repository also includes `.codex-plugin/plugin.json` for Codex packaging
and the existing Claude marketplace descriptor for compatible clients. The
measurement runtime entry point for both is `mcp/dist/ifc-server.mjs`. Plugin
root substitution uses the supported `${CLAUDE_PLUGIN_ROOT}` compatibility
variable; the scoped installer writes resolved paths instead.

## Claude Code

The existing Claude marketplace packaging and `.mcp.json` remain supported. For
session-local development, load this directory without a global installation:

```bash
claude --plugin-dir /absolute/path/to/photo-to-bim
```

For a frozen test folder, point `--plugin-dir` at its
`.agents/plugins/photo-to-bim` directory. Blender MCP must also be available in
that client. See the [Claude plugin reference](https://code.claude.com/docs/en/plugins-reference).

## Verify client availability

Check the client tool catalog once at task startup: the intended tools are listed
below. If a tool is missing, distinguish server startup from schema exposure;
restart after a setup change and inspect the client's error. Confirm a small
read-only call in that client before a benchmark run. A standalone MCP handshake
or enabled configuration does not establish that model-visible tools were accepted.
This is a setup check, not a repeated modelling phase. Missing tools should be
reported explicitly; the skill permits a limited fallback without repeated probing.

## Runtime surface

| Tool | Purpose |
| --- | --- |
| `classify_reference` | Optional image-shape hints, never authoritative evidence |
| `view_crop` | Up to six magnified, coordinate-labelled crops per call |
| `trace_edges` | Batch named line observations, returned in original pixels |
| `calibrate_camera` | Line-family or camera-only landmark fit, full frame and explicit scale assumptions |
| `place_features` | Conditional metric estimates on any plane in that world frame |
| `compare_model` | Fixed landmark/mask evaluation, overlays and comparable history |

The [skill](skills/photo-to-ifc-building/SKILL.md) describes the working method.
Its [runtime reference](skills/photo-to-ifc-building/references/runtime.md)
contains bootstrap, IFC, camera and observation examples. The camera/observation schema version is `1`; the IFC style registry is `2`
(with legacy v1 reading), and the package version is `0.8.1`.

The camera frame uses a right-handed Z-up world in metres. Camera axes are
right/down/forward; `world_from_camera` includes orientation and translation.
The Blender adapter converts that into Blender's camera convention. Scale
anchors are marked `assumed` or `measured`, with source and optional uncertainty.
The default anchor frame assumes its bottom is ground level at the origin.
Ray sensitivity covers pixel picking only, not total reconstruction uncertainty.

## Outputs and scope of validation

Typical outputs are `house.ifc`, `comparison.png`, `validation.json`, a compact
`reconstruction.json` assumption ledger and `observations.json`. Helpers save
`house.ifc.styles.json` beside the IFC. Evaluation can also save `overlay.png`,
`evaluation.json` and `score-history.json`; intermediates stay in the workspace.

IFC validation checks syntax/schema, nonempty finite geometry, spatial structure,
SI metres, required entity classes, containment, opening/filling relations and
window/door width and height. It does not prove watertight junctions, editable
parametric families in every BIM product, or correspondence to the real building.
Underlying helper representations include tessellated geometry and mapped repeats.

Photographic validation uses at least four spread, noncollinear named landmarks
and/or an explicit binary subject mask. By default, landmark maximum error must
be ≤5 pixels and mask IoU ≥0.95. Choose thresholds before fitting; mask occlusions
and subject spans apply to both images. A pass refers only to the supplied
evidence, so inspect the final render as well. Fixed check landmarks should be
withheld from fitting when possible. Mark `used_for_fitting: true` if a check
point later guides either camera or geometry edits; omit the flag only when its
usage is unknown. Missing evidence returns `INCOMPLETE`.
Rendered masks must come from the same model/camera state as the beauty render;
the current adapter accepts them explicitly, without automatic segmentation.

Appearance validation checks the imported geometry, IFC links, per-face material
indices and shader overrides. A custom shader is retained and reported for visual
review; these checks do not establish colour accuracy. `runtime['validation'].combine`
keeps IFC, photographic, appearance and visual-review evidence separate. Only an
explicit user review can produce `accepted` or `accepted_with_deviations`; an agent's
review leaves user acceptance pending. An IFC failure blocks acceptance. The agent
can deliver a result with pending visual review without an extra approval round.

## Development and release checks

```bash
uv venv .venv --python 3.13
uv pip install --python .venv/bin/python -r requirements-test.txt
npm ci --prefix mcp
npm run typecheck --prefix mcp
npm test --prefix mcp
```

Set `IFC_PYTHON` if your test interpreter lives elsewhere. Missing IFC dependencies
fail the release suite. Tests build both bundles, check numerical camera/plane
behaviour, synthetic cloud/occlusion regressions, canonical scorer parity and a
real stdio MCP handshake, camera-only fitting (including fixed test-7
correspondences), consumed-check accounting and stale IFC landmark rejection. Python tests use IfcOpenShell to reopen generated IFCs
and exercise structural failures, repeated geometry with distinct placements and
voids, cache invalidation, bounded precision, and stale-loader/style lookup regressions. Adapter boundary tests use stubs; they do **not** replace a live
Blender/Bonsai import/render test. Run the reproducible live test through Blender
MCP after building the bundle, using `mcp/test/blender_integration.py` and its
`run(repo, output_directory, node)` function. It creates a synthetic fixture in a
temporary scene, saves test outputs only under the supplied directory, and restores
the existing scene and active IFC context. It checks material preservation during
rendering and failure detection after deliberately changing the fixture.
The scoped installer also has a portable test. GitHub Actions runs the release
suite and verifies that shipped bundles match their source.

Both server bundles are checked in. After changing source run:

```bash
npm run build:server --prefix mcp
```

For the legacy Three.js application: `npm run build --prefix mcp` and
`node mcp/dist/server.mjs --stdio`. Its historical tools/scoring are outside the
0.7 IFC workflow. Existing 0.6 scripts need migration: load the new bootstrap,
replace `camera_for_blender` with a full camera frame, pass the exact IFC path
to `setup`, and replace skyline scoring with fixed observations. Do not mix
helpers or score histories across versions.

[Historical field notes](docs/field-evidence.md) describe the earlier experiments;
they are not controlled evidence of speed or dimensional accuracy.

## License

Apache-2.0; see [LICENSE](LICENSE) and [NOTICE](NOTICE).
