# Field evidence — why the method is shaped like this

Every design decision in photo-to-bim was paid for by an instrumented agent
run. This is the distilled record; the raw archaeology (plans, transcripts,
commit history) lives in the
[photo-to-threejs](https://github.com/alekseikondratenko/photo-to-threejs)
laboratory repo.

## The law

**Rules carried in tool outputs hold; rules left as skill prose decay.**
Confirmed in every run measured. Prose said "score every render" — one run
scored once and eyeballed for an hour. The scoring moved INTO the save
endpoint (saving and being graded became one action) — and every render of
every subsequent run was scored. Prose said "stop when converged" — a run spent
its last four passes moving the score 108 → 110 → 110.4 → 110.4 and stopped
only at its pass budget. The stop signal moved into the score response as a
verdict. Prose said "use unproject" — three consecutive runs hand-rolled
ray×plane math with the tool unlocked. The instruction now ships inside every
solve result, with a worked call.

Corollary, same law one level down: **an opt-in parameter is prose.** The
subject-span scoring window existed for a full release, defaulted to null, and
no run ever passed it — while two runs hand-built their own subject-scoped
scorer because the full-frame number was measuring trees and clouds. The span
is now carried by the workflow (`set_span`), and the score warns when the
flanks disagree with the middle by 2×.

## A capability earns a tool when two runs hand-build it

- Camera algebra: one run burned ~40 minutes, another ~30 with five
  re-derivations and sign slips → `solve_camera`, with residuals and a
  leave-one-out check, converging in 2–3 calls in later runs.
- Magnified inspection: every run built a crop script → `view_crop`
  (contact sheets, coordinate grids in original-image space).
- Self-scoring drift: two runs "self-scored" 4–8 px with their own rulers
  while differing 5× under one ruler → a single canonical `score_render`.
- Silhouette on wide subjects: the row-wise scan came back empty on a wide
  house; a field agent invented the column-wise skyline transpose (silh.py) →
  it became the primary metric.
- Blank frames scored as silent nulls three times → the degenerate-frame
  guard that names the failure instead of scoring noise.
- Openings penetrating roofs shipped once → the clearance check; visible mesh
  holes shipped twice → the geometry-engine pass in the IFC gate.

## The two-agent Blender baseline (2026-09-10)

The experiment that produced this repo. Same photograph, same prompt
("rebuild as IFC, not just Blender geometry"), Blender + Bonsai via MCP:

- **Agent A (instruments visible):** built naive IFC in 14 minutes, then —
  unprompted — discovered `solve_camera`/`trace_edge`/`view_crop`/
  `compare_images`, measured the photo, corrected its model, and re-rendered
  from the solved viewpoint. The instruments were adopted on merit.
- **Agent B (true naive):** valid, schema-clean IFC4 in 16m38s with rich
  decoration (781 scene objects) — and zero measurement: no camera solve, a
  generic viewpoint, every dimension a typed constant. Its two best practices
  were adopted into the skill (introspect the API before authoring; validate
  the deliverable with the format's own tools). Its failure became a gate rule
  (garnish must not export — the entity census).

Conclusion, and the thesis of this project: **modelling is a commodity;
fidelity is the product.** Both agents produced "a house like the photo" —
only instruments produce *the* house.

## Timing arc (same house photograph throughout)

| Run | Stack | Wall clock | Note |
|---|---|---|---|
| 3 | skill prose only | ~2h45 | unconverged |
| 4 | + first instruments | ~2h07 | converged, 21 single-fix passes |
| 5 | + scoring gate, batching | ~2h03 | 2× progress per pass; stalled tail |
| 6 | + routing in tool outputs | ~1h50 | best model; measurement 41 min |
| Blender naive | none (baseline) | 17–40 min | plausible, unmeasured |
| **photo-to-bim target** | full stack, IFC | **≤ 45 min** | measured + gated |

The anti-overfit rule stands throughout: five reference subjects (two towers,
a wide landmark, a curved sail over water, an occluded house), and no release
ships tuning for one class that regresses another — the tower guard in the
regression suite is the standing witness.
