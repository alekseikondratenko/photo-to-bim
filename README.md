# photo-to-bim

**One photograph in. A measured IFC model out.**

An agent skill + MCP server that turns a single photo of a building into a
valid IFC4/BIM model — authored in Blender through
[Bonsai](https://bonsaibim.org) (ifcopenshell), with a real
`IfcProject → IfcSite → IfcBuilding → IfcBuildingStorey` hierarchy, walls,
roofs, slabs, windows and doors as first-class entities, and every load-bearing
dimension traceable to pixels in the photograph. Opens in Revit, ArchiCAD,
Solibri — anything that speaks IFC.

## Why measurement is the product

Today's coding agents can already produce a *plausible* building from a photo —
a lovely gable house "like" the picture, with guessed constants typed into a
script. We benchmarked exactly that: two different agents, given only a photo
and a Blender connection, each authored valid IFC in under 40 minutes,
unprompted. Modelling ability is a commodity now.

What neither produced is **the** building. Without instruments there is no
camera solve, so no viewpoint to verify against; no pixel evidence, so every
dimension is a guess with confidence. This project is the missing layer:

- **Measure the photograph** — magnified coordinate-gridded crops
  (`view_crop`), edges turned into fitted lines (`trace_edge`), repeating
  rhythms (`measure_pitch`).
- **Solve the camera** — vanishing points with per-line residuals and a
  leave-one-out cross-check (`solve_camera`); shifted-lens/cropped frames
  handled natively (and mapped straight onto Blender's lens shift via the
  `camera_for_blender` block).
- **Place features in world coordinates** — `unproject`: image points + a
  named plane → metres, with a reprojection check on every point.
- **Score every render against the photograph's own pixels** — the same
  detector on both images, column-wise skyline with located worst segments
  ("columns 1180–1400: render 42 px too HIGH"), lighting bands, and a
  two-verdict stop signal (`converged` / `stalled`).
- **Gate the delivery deterministically** — schema validation, every element
  opened through the IFC geometry engine, an entity census (scaffolding and
  garnish cannot masquerade as BIM), spatial containment, and a final scored
  render from the solved camera.

The design law, proven across eight field runs: **rules carried in tool
outputs hold; rules left as prose decay.** Every instrument here exists
because at least two independent agent runs hand-built it or burned 15+
minutes without it.

## Install

Requirements: [Blender](https://www.blender.org/download/) (free) with the
Bonsai add-on, a Blender MCP bridge (e.g.
[blender-mcp](https://github.com/ahujasid/blender-mcp)), and Node 20+.

As a Claude Code plugin (ships the skill AND the measurement server):

```
/plugin marketplace add alekseikondratenko/photo-to-bim
/plugin install photo-to-ifc-building@photo-to-bim
```

Or wire the server manually:

```json
{
  "mcpServers": {
    "photo-to-bim": {
      "command": "node",
      "args": ["<repo>/mcp/dist/server.mjs", "--stdio", "--profile", "ifc"]
    }
  }
}
```

`--profile ifc` registers only the nine measurement instruments. The server
also carries a legacy web-viewer target (`--profile all`) from the project
this one graduated from — see below.

Build from source: `cd mcp && npm install && npm run build && npm run build:server`.
Regression suite: `npm test` (46 checks across five reference photographs —
two towers, a wide landmark, a curved sail, an occluded house — so a fix for
one subject class cannot silently regress another).

## How a run works

1. `classify_reference` → `view_crop`/`trace_edge` → `solve_camera` (2–3
   iterations through its residuals; the result's `next` block is the routing).
2. Paste `camera_for_blender` into the skill's `photostudio.setup()` —
   PhotoCam reproduces the photograph's viewpoint, lens shift included.
3. Author IFC natively with the skill's `ifc_helpers` (general-shape: footprint
   massing, arbitrary roof planes, storey stacks, opening grids — houses and
   towers alike). Massing first, scored, then detail.
4. Every `render_and_score()` is rendered at the exact reference size and
   scored in the same call; located errors point at the element to fix; the
   gate says when to stop.
5. `gate_report()` + a final scored render + RECON.md (the evidence ledger)
   = the deliverable.

## Provenance

This project graduated from
[photo-to-threejs](https://github.com/alekseikondratenko/photo-to-threejs) —
the laboratory where the method, the instruments and the scoring gates were
developed and field-tested against real agent runs (six full reconstruction
runs, timed and instrumented, on the same reference photographs). The war
stories live there; the distilled evidence lives in
[docs/field-evidence.md](docs/field-evidence.md).

## License

See [LICENSE](LICENSE).
