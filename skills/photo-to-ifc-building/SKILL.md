---
name: photo-to-ifc-building
description: Reconstruct a photographed building as semantic IFC using Blender MCP and Bonsai. Use for photo-to-BIM tasks requiring real walls, roofs, slabs, openings and a matching comparison render; not geometry-only scenes.
---

# Photo to IFC building — 0.7.0

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
Never reuse helpers cached from another test. Do not change a running Blender
scene without checking whether it contains work that must be preserved.

## Working method

1. **Observe.** Identify the dominant volumes, roof topology, visible openings
   and occlusions. Batch useful crops and edge traces. Choose a scale anchor;
   record its source and whether it is assumed or measured. Classification and
   automatic edge detection are optional hints to inspect, not ground truth.
2. **Establish a frame.** Calibrate from clear parallel line families (at least
   two edges per family). Preserve the full Z-up camera transform, focal length,
   principal point and reference size. `place_features` intersects rays with
   any explicitly defined plane in that frame. Its round-trip check proves
   arithmetic consistency, not the correctness of the plane or scale.
3. **Draft early.** Build the envelope and main roof, then make a cheap unscored
   render. A weak calibration can support a provisional draft; record that
   uncertainty. If calibration is unavailable, use an explicitly assumed
   camera instead of repeating poor measurements indefinitely.
4. **Refine from fixed evidence.** Save stable landmark IDs in `observations.json`
   before fitting; spread them over the building. Prefer some withheld check
   points. Add a subject mask only when the silhouette can be annotated
   reliably; exclude occluded pixels explicitly. Change camera or geometry
   when correspondences support that diagnosis. Do not alter annotations to
   make a score improve. Corrected annotations start a new evaluation series.
5. **Author semantics.** Use Project → Site → Building → Storey, SI metres and
   real IfcWall/IfcRoof/IfcSlab/IfcWindow/IfcDoor classes where applicable.
   Openings void their host walls; doors/windows fill them and carry width and
   height. Replace massing proxies. Use `profile_wall` for gables; model real
   parts, rather than one wall entity per triangle.
6. **Finish and verify.** Save and reopen the IFC. Run the structural gate with
   the classes required by the task. Render the final viewpoint at the exact
   reference dimensions and evaluate fixed landmarks and/or explicit masks.
   Inspect the image visually as well: a numeric pass is limited to its evidence.

## Detail and stopping policy

Match envelope, roof and major openings before secondary details. Default to
visible architectural detail; omit unseen interiors and subpixel decoration
unless requested. Keep decorative render context outside IFC. Repeated real
components remain semantic occurrences but should share geometry where possible
(`opening_grid` uses mapped fill geometry). Do not spend the run creating
thousands of guessed parts. Record any deliberate simplification.

Use targeted iterations on the largest supported mismatch. Stop when the
requested quality is reached, the explicit budget is reached, or improvement
stalls. Report the remaining mismatch; do not call stalled work converged.
An unavailable check is INCOMPLETE. Photographic and IFC validation are
independent: neither can substitute for the other.

## Evidence and delivery

Keep a compact `reconstruction.json`: reference hash, camera, scale anchor,
observed features, derived dimensions, assumptions, detail policy and runtime
version. Store the same key assumptions in an IFC property set. A property
set is provenance, not proof that a dimension was surveyed.

Deliver the user's filenames (normally `house.ifc`, `comparison.png`) and
`validation.json` with separate IFC, photographic and appearance results.
Keep intermediate files in the permitted workspace. Include a `.blend` only
if requested; when saving it, persist Bonsai's association with the final IFC.
Explain scale assumptions and incomplete checks in the final response.
