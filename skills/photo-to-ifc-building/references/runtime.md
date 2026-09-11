# Runtime API 0.7.2

The IFC MCP contains six tools: `classify_reference`, `view_crop`, `trace_edges`,
`calibrate_camera`, `place_features`, `compare_model`. Tool schemas carry exact
argument definitions. Batch crops and lines to reduce round trips. The legacy
viewer server is a separate entry point and is not loaded by this skill.

## Load inside Blender through its MCP

Resolve this skill's directory from its actual location. In a folder-only run,
the isolated installer has already copied it into that folder.

```python
from pathlib import Path
import types
p = Path('/absolute/path/to/skill/assets/blender-template/bootstrap.py')
B = types.ModuleType('photo_to_bim_bootstrap')
B.__file__ = str(p)
exec(compile(p.read_text(), str(p), 'exec'), B.__dict__)
runtime = B.load()
H, P = runtime['helpers'], runtime['studio']
S, V = runtime['scene'], runtime['validation']
print(runtime['version'], runtime['capabilities'])
```

Reload with this snippet after an upgrade. Each call loads fresh, content-keyed
modules, avoiding the stale `setup(position=...)` failure from older tests.
The helper supports one active model per loaded module; call `new_model` to
reset all registries. Use separate bootstrap loads for concurrent models.

## IFC helper

```python
ctx = H.new_model('Photo reconstruction', [('Ground', 0.0)])
st = ctx['storeys']['Ground']
H.style('wall', (.75, .72, .65))
w = H.wall(ctx, st, (0,0), (8,0), height=3, style_name='wall')
op = H.opening(ctx, w, x_along=2, sill=.9, width=1.2, height=1.4)
H.style('frame', (.8, .8, .75))
H.style('glass', (.08, .18, .25))
win = H.framed_fill(ctx, op, kind='window', storey=st, crossbar_at=.6)
# Add the remaining walls, slab, roof and any other observed openings.
H.evidence_pset(ctx, {'ScaleStatus':'assumed', 'ScaleSource':'door height estimate'})
H.save(ctx, '/workspace/house.ifc')
report = H.gate_report('/workspace/house.ifc',
    required_classes=('IfcWall','IfcRoof','IfcSlab','IfcWindow','IfcDoor'))
```

- `profile_wall(ctx, storey, p1, p2, profile, thickness=.3, z0=0, ...)` takes a
  polygon of `(distance_along_wall, height)` pairs; openings use the wall axis.
- `slab` takes a footprint, thickness and top elevation; `roof` takes a list of
  3D roof-plane polygons. See helper signatures for optional names/styles.
- `opening_grid` creates semantic openings/fills with shared fill geometry.
  It does not infer hidden windows. `mapped_copy` supports translated repeats
  of an unplaced world-coordinate prototype, not arbitrary nested transforms.
- `framed_fill` supports windows and glazed doors, with separate frame/glass items,
  semantic overall dimensions and the existing opening/fill relationship. Omit
  `crossbar_at` for a plain frame; it otherwise specifies a height fraction.
  Use custom helpers for solid panels or more complex observed joinery.
- `save` writes v2 `<ifc>.styles.json`, tied to the IFC hash and element GlobalIds.
  It records per-item style IDs, including mapped representations.
  Keep it beside that IFC even when renders live in a different directory.
- The gate checks schema, nonempty finite geometry, spatial hierarchy, metre
  units, task-required classes, containment, opening/fill relations and semantic
  dimensions. It rejects massing and unexplained proxies. A justified proxy
  exception is `{GlobalId: reason}`. It is not a watertightness or survey test.

`S.import_ifc('/workspace/house.ifc')` creates a new collection containing the spatial
hierarchy and linked IFC meshes with exact per-face material indices. It sets the
active Bonsai IFC and persists `BIMProperties.ifc_file`. Check existing Blender
work first: importing changes the active IFC context and does not remove any old
collections. Start from a cleared/preserved scene when reimporting to avoid duplicate
geometry. It is a tessellated preview importer, not a parametric-family converter.
`S.check_appearance(ifc_path)` is read-only; `S.apply_materials(ifc_path)` explicitly
restores IFC item styles and refuses stale or edited geometry.

## Camera and observations

`camera_frame_v1` is `{schema_version:1, convention:'Z_UP_RIGHT_HANDED',
image_size:[w,h], focal_px:f, principal_point:[cx,cy], world_from_camera:4x4}`.
World units are metres. The transform's first three columns are camera right,
down and forward; the fourth column is its world position. This differs from
Blender camera axes; the adapter performs that conversion. `calibrate_camera`
uses a metric vertical anchor to derive translation, including off-centre picks
and roll. Its default world origin is the anchor bottom, assumed ground level.
An explicit position/target replaces that translation assumption. A null camera
means calibration or placement is unavailable; do not invent a successful solve.

`calibrate_camera` also accepts `method: "landmarks"`, `initial_camera`,
`landmarks: [{id, pixel:[x,y], world:[x,y,z], role:"fit"|"check", used_for_fitting}]`
and `scale_source: {status:"assumed"|"measured", source:"..."}`. Use at least six
fit points spread across the building and multiple 3D directions. The initial
frame must see them. This is a local camera-only fit: it changes position/rotation
and, by default, focal length. `fit_options` accepts `fit_focal` (default true),
`fit_principal_point` (default false) and `max_iterations` (1–300, default 150).
Focal/shift fitting can be underconstrained on planar data; fix intrinsics or add
geometric depth. Geometry, topology and scale never change in this mode.

Check points are excluded unless `used_for_fitting: true`. A false flag declares
that the point was unused for camera **and geometry** adjustment; absence means
unknown independence. Carry actual usage into `observations.json`, including any
manual geometry edits guided by those points. `SOLVED` means numerical local
convergence with full numerical rank, not a passing photo score. `INCOMPLETE`
includes the best frame plus termination/rank information for diagnosis.

`observations.json`:

```json
{
  "schema_version": 1,
  "reference_sha256": "SHA256 of the reference image bytes",
  "image_size": [1600, 1200],
  "landmarks": [
    {"id": "ridge-left", "pixel": [350, 220], "role": "fit"},
    {"id": "ridge-right", "pixel": [1000, 260], "role": "fit"},
    {"id": "base-left", "pixel": [300, 950], "role": "check", "used_for_fitting": false},
    {"id": "base-right", "pixel": [1100, 900], "role": "check", "used_for_fitting": false}
  ]
}
```

Optional `subject_mask` and `occlusion_mask` are file paths relative to the
observation file, at the exact reference size. White is subject/excluded,
black is background/included. They must be binary, not thresholded beauty
images. Optional `span:[x0,x1]` restricts both reference and rendered evidence.
Generate a rendered mask from the chosen building objects using the same
camera as the beauty image; context such as ground, plants and skies is excluded.
The adapter accepts this explicit mask; it does not automatically segment RGB.

## Render and evaluate

```python
import json
P.setup(camera, reference_path='/workspace/house.jpg',
        ifc_path='/workspace/house.ifc', out_dir='/workspace',
        observations='/workspace/observations.json')
P.render_view('draft', percentage=50)  # deliberately unscored
# Picks must be near actual vertices of the final exported geometry.
pack = H.capture_landmarks('/workspace/house.ifc', {
    'ridge-left': {'global_id': roof.GlobalId, 'world': [0,0,7]},
    # Include every visible observation ID with the correct element and vertex.
})
Path('/workspace/landmarks.json').write_text(json.dumps(pack, indent=2))
result = P.render_and_score('comparison', landmark_pack='/workspace/landmarks.json')
validation = V.combine(report, result['photographic'], result['appearance'])
Path('/workspace/validation.json').write_text(json.dumps(validation, indent=2))
```

Values above illustrate the API only, not a building template. The installed
runtime resolves Node from `runtime.json`; `setup(node=..., evaluator=...)`
can override it. The evaluator runs locally, through the same JS function used
by `compare_model`. It writes `evaluation.json`, `overlay.png` and a history.
It reads the actual Blender camera at render time. Pass `render_mask=...` only
for a mask produced from that same state. Neither `setup` nor rendering restores
materials automatically. `P.ensure_materials()` or `setup(apply_ifc_materials=True)`
is an explicit restoration request. Appearance checks distinguish linkage/geometry
failures from retained custom shader overrides; visual colour matching remains a
review task.

`capture_landmarks` snaps within `max_distance_m` (default .05), records exported
vertex coordinates, element GlobalIds, geometry hashes and the IFC byte hash.
`resolve_landmarks(ifc_path, pack)` verifies it against geometry again. The scorer
checks the IFC byte hash and snapshot consistency; a changed export requires fresh
capture, including style-only IFC changes. Stable IDs survive only while the IFC
entities are retained; recreating them requires explicit rebinding. These are vertex
snapshots, not topological edge/face references. Direct `model_points` remain
supported for exploration, with `model_binding.status: "UNBOUND"` in the report.

`V.combine` defaults to `visual_review: {decision:"not_reviewed"}`. When an actual
review exists, pass `{decision:"accepted"|"rejected", source:"user"|"agent",
reviewer:"...", basis:"..."}`. User acceptance can coexist with photographic failure
as `accepted_with_deviations`; IFC failures remain blocked. Never invent a user
review or change automated thresholds after fitting to turn a failure into a pass.

Defaults: landmark maximum error ≤5 original-image pixels; mask IoU ≥0.95.
A landmark assessment needs at least four noncollinear, spatially spread points
and all requested correspondences. Set task-appropriate thresholds before fitting.
Changing reference/annotations/masks/thresholds creates a new history key. PASS
means only those checks passed; INCOMPLETE means evidence was unavailable.
`stalled` means three comparable losses barely changed, not convergence. This is
an advisory diagnostic, not a minimum of three evaluations. `needs_refinement`
reports a threshold miss; it does not require another pass. Keep failed or
incomplete results when further work is not justified.

Early checks are optional. Camera fitting already returns residuals without a
render; they describe supplied correspondences, not visual acceptance. Existing
renders can be compared only when they match the model/camera state and reference
resolution. `render_and_score` always makes a full-resolution render, so keep
cheap previews unscored unless a quantitative check will inform a useful decision.
