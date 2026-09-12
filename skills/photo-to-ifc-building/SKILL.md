---
name: photo-to-ifc-building
description: Reconstruct a photographed building as semantic IFC using Blender MCP and Bonsai. Use for photo-to-BIM tasks requiring real walls, roofs, slabs, openings and a matching comparison render; not geometry-only scenes.
---

# Photo to IFC building — 0.8.0

Produce an editable, dimensioned IFC reconstruction and a comparison render.
For ambiguous scale or roof topology, consult [scale anchors](references/scale-anchors.md)
or [roof interpretation](references/roof-geometry.md) as needed.
A single photograph constrains appearance and proportions; absolute scale,
hidden surfaces and construction details remain assumptions unless measured.

## Start

Inspect the reference and requested deliverables. Use Blender MCP for Blender
operations and Bonsai/IfcOpenShell for IFC authoring. Respect the user's file
boundary. Load the versioned bootstrap in `assets/blender-template/bootstrap.py`
and check its returned version/capabilities before modelling; read
[the runtime reference](references/runtime.md) for the load snippet and API.
Check tool availability once at startup. If measurement tools are missing, report
the limitation and use the available fallback; do not repeatedly probe for them.
Never reuse helpers cached from another test. Do not change a running Blender
scene without checking whether it contains work that must be preserved.

## Working method

1. **Observe.** Identify the dominant volumes, roof topology, visible openings
   and occlusions. Batch useful crops and edge traces. Choose a scale anchor;
   record its source and whether it is assumed or measured. Classification and
   automatic edge detection are optional hints to inspect, not ground truth.
2. **Establish a frame.** Calibrate from clear parallel line families (at least
   two edges per family), or refine an initial camera against fixed 3D landmarks
   with `method: landmarks`. Keep metric scale explicit in either mode. Preserve the full Z-up camera transform, focal length,
   principal point and reference size. `place_features` intersects rays with
   any explicitly defined plane in that frame. Its round-trip check proves
   arithmetic consistency, not the correctness of the plane or scale.
3. **Draft early.** Build the envelope and main roof, then make a cheap unscored
   render. A weak calibration can support a provisional draft; record that
   uncertainty. Complete a coherent exterior in 3D: infer simple side/rear surfaces
   consistent with the visible form, and document them as assumptions. For ambiguous
   forms, use a cheap side/rear viewport look during this draft to catch missing depth
   or disconnected surfaces; no additional scored render is required. If calibration is unavailable, use an explicitly assumed
   camera instead of repeating poor measurements indefinitely. Early quantitative
   checking is optional when existing evidence can resolve a specific uncertainty
   before costly detail work; reuse fit residuals or a compatible existing render.
   Do not create extra annotations or renders just to complete an early checkpoint.
4. **Refine from fixed evidence.** Save stable landmark IDs in `observations.json`
   before fitting; measure their pixels from the photograph, never by projecting
   the current model back into the image. Spread them over the building. Prefer some withheld check
   points; set `used_for_fitting: true` if a check later guides camera **or geometry**
   edits. Bind final model landmarks to the exported IFC with `capture_landmarks`.
   Add a subject mask only when the silhouette can be annotated
   reliably; exclude occluded pixels explicitly. Change camera or geometry
   when correspondences support that diagnosis. Do not alter annotations to
   make a score improve. Corrected annotations start a new evaluation series.
5. **Author semantics.** Use Project → Site → Building → Storey, SI metres and
   real IfcWall/IfcRoof/IfcSlab/IfcWindow/IfcDoor classes where applicable.
   Openings void their host walls; doors/windows fill them and carry width and
   height. Replace massing proxies. Use `profile_wall` for gables; model real
   parts, rather than one wall entity per triangle. `framed_fill` preserves separate
   frame/glass items; `runtime["scene"].import_ifc` imports their styles into Bonsai.
6. **Finish and verify.** Save and reopen the IFC. Run the structural gate with
   the classes required by the task. Render the final viewpoint at the exact
   reference dimensions and evaluate fixed landmarks and/or explicit masks.
   Inspect the image visually as well: a numeric pass is limited to its evidence.

## Detail and stopping policy

Match envelope, roof and major openings before secondary details. Default to
visible architectural detail; omit unseen interiors and subpixel decoration
unless requested. Keep decorative render context outside IFC. Repeated real
components remain semantic occurrences but should share geometry where possible
(`opening_grid` uses mapped fill geometry). For dense openings, keep host walls
simple and let IFC openings cut them; avoid manually pre-cutting the same holes
before adding void relationships. Use incremental import from the runtime
reference when a large model risks a long blocking Blender call. Do not spend the run creating
thousands of guessed parts. Record any deliberate simplification.

Repeat a check only after a relevant change or new evidence, when the expected
benefit justifies its cost. Do not repeat unchanged checks or continue solely to
obtain PASS. No minimum or fixed number of passes is required. Stop when the
requested quality or explicit budget is reached, or further refinement is
unsupported or disproportionate. Report the stopping reason and remaining
mismatch; do not call stalled work converged.
An unavailable check is INCOMPLETE. Photographic and IFC validation are
independent: neither can substitute for the other.

## Evidence and delivery

Keep a compact `reconstruction.json`: reference hash, camera, scale anchor,
observed features, derived dimensions, assumptions, detail policy and runtime
version. Store the same key assumptions in an IFC property set. A property
set is provenance, not proof that a dimension was surveyed.

Deliver the user's filenames (normally `house.ifc`, `comparison.png`) and
`validation.json` via `runtime["validation"].combine` with separate IFC, photographic,
appearance and visual-review evidence. Rendering preserves materials; restoration
is explicit. Never convert visual satisfaction into an automated PASS. Record user
acceptance only when the user has expressed it; pending review need not delay delivery.
Keep intermediate files in the permitted workspace. Include a `.blend` only
if requested; when saving it, persist Bonsai's association with the final IFC.
Explain scale assumptions and incomplete checks in the final response.
