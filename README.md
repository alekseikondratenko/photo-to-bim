# photo-to-bim

Photo-guided building reconstruction as semantic IFC, using a small agent skill,
measurement tools, and Blender with Bonsai. Version **0.7.0** focuses on repeatable
execution and honest validation. It does not claim survey accuracy from one image
or a demonstrated speed advantage over a capable agent with Blender alone.

The output has an `IfcProject → IfcSite → IfcBuilding → IfcBuildingStorey`
hierarchy, SI metre units, and typed walls, roofs, slabs, windows and doors.
Dimensions derived from pixels remain conditional on camera, scale and assumed
planes. Hidden geometry is an explicit assumption. Downstream application
interoperability must be tested; schema validation alone does not establish it.

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
python3 scripts/setup_codex_project.py ~/Desktop/blender-test-7 \
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

## Runtime surface

| Tool | Purpose |
| --- | --- |
| `classify_reference` | Optional image-shape hints, never authoritative evidence |
| `view_crop` | Up to six magnified, coordinate-labelled crops per call |
| `trace_edges` | Batch named line observations, returned in original pixels |
| `calibrate_camera` | Line-family fit, complete camera frame and explicit scale anchor |
| `place_features` | Conditional metric estimates on any plane in that world frame |
| `compare_model` | Fixed landmark/mask evaluation, overlays and comparable history |

The [skill](skills/photo-to-ifc-building/SKILL.md) describes the working method.
Its [runtime reference](skills/photo-to-ifc-building/references/runtime.md)
contains bootstrap, IFC, camera and observation examples. The input/output
schema version is `1`; the package version is `0.7.0`.

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
withheld from fitting when possible. Missing evidence returns `INCOMPLETE`.
Rendered masks must come from the same model/camera state as the beauty render;
the current adapter accepts them explicitly, without automatic segmentation.

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
real stdio MCP handshake. Python tests use IfcOpenShell to reopen generated IFCs
and exercise structural failures, geometry reuse and stale-loader/style lookup
regressions. Adapter boundary tests use stubs; they do **not** replace a live
Blender/Bonsai import/render test. The scoped installer also has a portable test. GitHub Actions runs the release
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
