---
name: photo-to-ifc-building
description: Rebuild a building from a single photograph as a measured IFC/BIM model, authored in Blender through Bonsai (ifcopenshell). Use when the user supplies a building photo and wants IFC, BIM, a Revit/ArchiCAD-openable model, a Blender reconstruction, or asks to "do the photo-to-bim thing". Covers the camera-first, draft-then-verify workflow (solve the camera, draft whole, measure what the score indicts), IFC-native authoring with real IfcWall/IfcRoof/IfcWindow entities, the render-vs-photograph scoring loop, and the deterministic IFC delivery gate.
---

# Photograph → measured IFC model

One photograph in; a valid, **measured** IFC4 model out — real `IfcProject →
IfcSite → IfcBuilding → IfcBuildingStorey` hierarchy, walls/roof/slabs/windows/
doors as first-class entities with openings that void and fillings that fill,
every load-bearing dimension traceable to pixels in the photograph.

Any capable agent can produce a *plausible* building — a lovely gable house
"like" the photo, with guessed constants typed into a script. That is a
commodity. What this method produces is **the** building: proportions solved
from the camera, dimensions in metres with evidence, a render from the solved
viewpoint scored against the photograph's own pixels. Nobody opens a plausible
model in Revit twice.

**Requirements:** Blender with the Bonsai add-on (ifcopenshell ships inside it),
driven via the Blender MCP; plus this skill's companion `photo-to-bim` MCP
server for the measurement instruments. The web-viewer tools some hosts also
show (`init_workspace`, `open_viewer`) belong to a different build target — you
will not need them here.

## The working ledger — RECON.md, before anything else

Keep ONE file, `RECON.md`, in the working folder, and **rewrite it at every
step**:

- **Verified** — measurements WITH their evidence ("eave 3.28 m — indicted by
  p2 worst_segments, fixed by unprojecting the gutter line").
- **Assumed** — working values with their source ("storey 2.80 m, DE standard").
- **REFUTED** — hypotheses killed, with what killed them. Once buried, they
  stay dead.
- **Camera** — the accepted solve, pasted verbatim.
- **Score history** — the gate writes `score-history.json` for you; your job is
  the "what changed" commentary and the four sections above.

A fact not recorded here WILL be re-measured, the re-measurement will not agree
pixel-for-pixel with the first one, and reconciling the two costs more than the
ledger ever does. The ledger is also the audit trail — its Verified table is
what you export into the model's `Reconstruction_Evidence` property set.

## The loop grammar

Every pass has the same grammar:

1. **Predict** — write (in RECON.md) what the change should do to the numbers.
2. **Act** — change the IFC / scene; call `photostudio.render_and_score('pN')`.
   Rendering and being graded are ONE call — there is no unscored render.
3. **Read the grade.** The response carries the score, the delta, the located
   worst segments, and — when the geometry stops moving — a stop verdict.
4. **Fix the largest *located* error — and every independent smaller fix — in
   the SAME pass.** `skyline.worst_segments` names the worst column ranges and
   the direction ("x 1180–1400, render too HIGH"); you measured those columns,
   so look up which element lives there and fix that element. Batch: a material,
   a tree position and a window reveal do not interact, so they do not each
   deserve their own pass.
5. **One eye pass per numeric pass.** Holes, missing fills and identity
   features hide from silhouette metrics; `view_crop` works on your own render.

**Stop rules — the gate says when, not you.** When no geometry metric has moved
by 3% of its own value across two passes, the score carries a verdict:
`converged` (inside the delivery floor → run the IFC gate and deliver) or
`stalled` (still wrong, and more passes of the same kind will not fix it —
re-MEASURE the element in `worst_segments` instead of re-tuning numbers). A
third verdict, `camera_check: camera_offset`, usually appears on the FIRST
score if at all — it means move the camera, not the geometry (Step 2). Soft
budget: **~8 scored passes**; going beyond is allowed but write one line in
RECON.md saying what is still moving. Never iterate on eyeballed screenshots.

## Two shape classes, one method

- **Extruded/swept subjects** (most buildings): a footprint polygon and a
  storey stack; roofs as pitched planes. The rear is always invented — say so
  in the evidence pset.
- **Stacked/lofted subjects** (towers): profile-over-height with setbacks;
  fenestration as grids, not individual windows.

The helpers cover both (`massing`/`wall`/`roof(planes)` vs `opening_grid` and
per-storey stacking) — if you find yourself hand-writing geometry because the
subject is "not a house", stop: the subject is one of these two classes.

## The one measurement rule

Stated once, and nothing below contradicts it:

> **Before the first scored draft: only the solver's 4–10 lines and ONE scale
> anchor. After it: only what the score indicts.**

Every trace, crop and unprojection outside that rule is time spent measuring
things the draft may not even get wrong. A field run spent 23 measurement
calls before its first render; the score then pointed at a handful of
elements. Speed comes from letting the score direct the measuring.

## Step 1 — solve the camera (4–10 lines, nothing else)

1. `classify_reference` on the photograph (aim it with `crop` if the full-frame
   scan comes back blind — it will tell you what it tried).
2. `view_crop` ONLY to locate the lines you are about to trace; `trace_edge`
   ONLY the 4–10 lines the solver needs, along real parallel families —
   **including 2–3 verticals** (jambs, corners, downpipes; any label works,
   vertical is detected geometrically). This is not the measuring phase; that
   never comes as a phase at all (see the rule above).
3. `solve_camera` rough and early: 'weak' plus a named worst line IS the
   workflow, and it converges in 2–3 calls. **When the result says
   `buildable: true`, the camera is done** — draft now; more line-polishing
   before the first score is waste.
4. **Read the `next` block of every solve result — it is the routing.**
5. Paste `camera_for_blender` into `photostudio.setup(...)` **verbatim** — and
   pass `position=`/`target=` from your RECON camera frame (the default
   placement ignores yaw and WILL misframe a rotated model). Blender's native
   lens shift already encodes the shifted-lens case; never re-derive the
   mapping.
6. Take your ONE scale anchor now (a door head via `unproject`, or a storey
   height via `measure_pitch`) — one dimension, not a survey.

## Step 2 — draft whole, then the camera verdict, then refine

**Build the entire first draft from your visual read of the photograph** —
massing, roof planes AND openings, styles included — and score it immediately
(`render_and_score('p1-draft')`). Your spatial read is good; what it cannot
give you is *which parts are wrong*, and that is the score's job.

**Read `camera_check` on that first score before touching any geometry.** If
it reports `camera_offset`, the camera — not the building — is wrong: fix it
with `photostudio.place_camera(position, target)` and re-score. A field run
spent FOUR geometry passes (438→354→372→382→416) fighting a misplaced camera
because nothing named it; the check now names it, and a geometry pass taken
against that verdict is waste by definition.

With the camera verdict clean, refine: `worst_segments` names the columns and
the direction, you know which element lives there, and **only indicted
elements earn measurement** — correct them with **`unproject`** (image points
+ a named plane → world metres, reprojection-checked) or one targeted
`trace_edge`. Never re-derive camera math by hand; three field runs
hand-rolled it with the tool unlocked. Do not be the fourth.

As soon as you know the subject's column extent in the photograph, call
`photostudio.set_span(x0, x1)` — the flanks of a real photograph measure trees
and weather (a field run read 475/568 px flanks against a 101 px middle), and
the span puts a trustworthy `subject_span` block on every save.

## Step 3 — author IFC natively, script-per-phase

**Learn the API surface first, in one call.** Run `inspect` over the
`ifcopenshell.api` modules you are about to use, read the signatures, THEN
write. A field run that introspected first wrote a 13 KB build script that was
right the first time; runs that guessed API shapes burned half an hour
debugging them.

**One script per phase, executed whole** via `execute_blender_code`:
`draft` (spatial tree + the whole building: walls, roof, openings, fills,
styles — parameters in params.json) → `refine` (fixes from scores) →
`finish` (gate + manifest). Three big executions, not forty snippets.

Load the template once (it travels with this skill, in
`assets/blender-template/`):

```python
import sys; sys.path.insert(0, "<this skill>/assets/blender-template")
import ifc_helpers as H, photostudio as P
```

| Call | What it gives you |
|---|---|
| `H.new_model(name, [(storey, elev), ...])` | file + full spatial tree, SI metres |
| `H.evidence_pset(ctx, {...})` | RECON's Verified table, attached to the building |
| `H.massing(ctx, storey, footprint, height)` | OPTIONAL quick blockout (a proxy the gate fails until replaced). The draft-first flow normally skips it — draft with real walls/roof/openings directly |
| `H.wall(ctx, storey, p1, p2, height, thickness)` | `IfcWall` along any plan segment |
| `H.slab(ctx, storey, footprint, thickness, z_top)` | floors, terraces, tower caps |
| `H.roof(ctx, storey, planes)` | ONE `IfcRoof` from ANY set of 3D plane polygons — a gable is two, a hip four, a flat cap one |
| `H.opening(ctx, wall, x_along, sill, w, h)` + `H.fill(ctx, op, 'window'|'door', storey)` | real voids and fillings (`IfcRelVoidsElement`/`IfcRelFillsElement`) |
| `H.opening_grid(ctx, wall, rows, cols, ...)` | tower fenestration in one call |
| `H.save(ctx, path)` / `H.gate_report(path)` | write; the delivery gate |

**First-draft checkpoint:** the draft — openings included — must be saved,
loaded (`bpy.ops.bim.load_project`) and scored (`P.render_and_score('p1-draft')`)
before ANY refinement pass. The score, not element type, decides what happens
next: a wrong yaw or scale shows in this overlay in minutes and invalidates
everything downstream, so nothing proceeds until the first number exists.

**Parameterise the build** — the convention a field run invented and proved:
dimensions live in `params.json`, the build script reads them, and a
correction is a one-line parameter edit plus a re-run, never code surgery.

To SEE the model, save and reload (`bpy.ops.bim.load_project(filepath=...)`) —
authoring is in the file, viewing is in the scene; keep the file the truth.

## Materials: sampled from the photograph, not invented

A grey model reads as unfinished even when its dimensions are perfect — a
field run delivered exactly that because nothing asked for colour. Colours are
measurements like everything else: `view_crop` the wall, the roof, the accent
gable; read the dominant RGB; register each as `H.style('render-white',
(r, g, b))` and pass `style_name=` to every element helper. Windows get a
glass style. Three to five styles cover a building; decoration beyond flat
measured colour is not the deliverable. `render_and_score` applies these
styles to the loaded model automatically (via the registry `H.save` writes) —
a scored render can never come out accidentally white.

## Context: massing only, and it never enters the IFC

Ground plane, grey neighbour blocks, cone trees — **~2 passes, total**, as
Blender-only objects. A field run modelled 781 scene objects of terrace
furniture, hedge leaves and lamps: zero fidelity gained, and garnish that leaks
into an export becomes `IfcBuildingElementProxy` clutter that the gate rightly
fails. Decoration is not the deliverable; the census keeps you honest.

## The delivery gate — deterministic, one call

```python
report = H.gate_report("house.ifc")   # paste into RECON.md
```

FAIL on any of: schema errors (`ifcopenshell.validate`) · an element the IFC
geometry engine cannot open · `IfcBuildingElementProxy` count > 0 · an element
contained in no storey. Then the pixel side: the final
`P.render_and_score('final')` from PhotoCam, plus one eye pass over a 3/4 and
a rear view for holes (sky through a valley, openings with nothing behind
them — `view_crop` your own render to check closely).

Deliver in the working folder: `<subject>.ifc`, `comparison.png` (final scored
render), `RECON.md`, and a short `README.md` manifest (deliverables, storey
table, entity census, what was measured vs assumed).

## MCP instruments (the photo-to-bim server)

| Tool | Use |
|---|---|
| `classify_reference` | Step 1 evidence — hints, never a verdict |
| `view_crop` | magnified, gridded crops — the photograph AND your own renders |
| `trace_edge` | an edge you can see → exact numbers + a solver-ready segment |
| `solve_camera` | the camera, verdict-checked; `camera_for_blender` + `next` routing |
| `unproject` | pixels + plane → world metres. THE feature-placement tool |
| `measure_pitch` | repeating rhythm: floors, courses, bay spacing |
| `compare_images` | overlay/wipe/edge-diff evidence pack + full score |
| `score_render` | the canonical scorer, when you need the full detail |

Cookbook pages in `references/` (roof geometry, scale anchors) apply unchanged
— geometry does not care about the build target.

## Bug checklist (each item has already cost a run a review cycle)

1. **Scoring a screenshot instead of a render.** Screenshots rescale;
   `render_and_score` renders at the exact reference size — use it only. It
   PINS PhotoCam; presentation shots go through `render_view` and are never
   scored (a field run scored a beauty camera and planted a 416 px ghost
   regression in its own history).
2. **Re-deriving the camera.** `camera_for_blender` is paste-ready; the
   verification is the FIRST score's `camera_check` — no separate ritual.
3. **Hand-rolled unprojection.** If you are writing ray×plane code, stop —
   that is `unproject`, with a reprojection check you will not write.
4. **Refining before the first scored draft** — the frame moves, everything
   re-measures. Draft whole, score, then refine.
5. **Trusting the full-frame skyline on a real photograph.** Flanks measure
   trees and clouds; `set_span` early, read `subject_span`.
6. **Drafted guesses dressed as evidence.** Drafting from your visual read is
   the METHOD; recording those guesses in `Reconstruction_Evidence` is not —
   the pset holds measured values only, guesses stay in RECON's Assumed until
   a score or an unprojection confirms them.
7. **Openings cut but not filled** — a hole is not a window; the gate's
   geometry check catches some of this, your rear-view eye pass catches the rest.
8. **Roof planes trimmed to eaves instead of valleys** where masses intersect —
   sky shows through the junction; zoom your own render.
9. **Garnish exported as IFC.** Census before delivery; proxies ≈ 0.
10. **Blender scene treated as the truth.** The .ifc file is the deliverable;
    the scene is a viewport. Save and reload rather than trusting live state.
11. **Editing the loaded Bonsai project while also writing the file from
    `ifc_helpers`** — pick ONE authoring path per phase; mixing them silently
    forks the model.
12. **Grey delivery.** No styles = unfinished to every human reviewer;
    sample colours from the photo and style every element class.
13. **Unit drift.** `new_model` declares SI metres; if a number looks 1000×
    off, a millimetre convention leaked in — fix the source, not the symptom.
