# Runtime API 0.7

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
win = H.fill(ctx, op, kind='window', storey=st)
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
- `save` writes `<ifc>.styles.json`, tied to the IFC hash and element GlobalIds.
  Keep it beside that IFC even when renders live in a different directory.
- The gate checks schema, nonempty finite geometry, spatial hierarchy, metre
  units, task-required classes, containment, opening/fill relations and semantic
  dimensions. It rejects massing and unexplained proxies. A justified proxy
  exception is `{GlobalId: reason}`. It is not a watertightness or survey test.

Load the saved IFC into Bonsai using the installed version's import operator,
then use the studio to configure the camera and apply styles to linked objects.
Do not replace the IFC with unlinked Blender geometry.

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

`observations.json`:

```json
{
  "schema_version": 1,
  "reference_sha256": "SHA256 of the reference image bytes",
  "image_size": [1600, 1200],
  "landmarks": [
    {"id": "ridge-left", "pixel": [350, 220], "role": "fit"},
    {"id": "ridge-right", "pixel": [1000, 260], "role": "fit"},
    {"id": "base-left", "pixel": [300, 950], "role": "check"},
    {"id": "base-right", "pixel": [1100, 900], "role": "check"}
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
P.setup(camera, reference_path='/workspace/house.jpg',
        ifc_path='/workspace/house.ifc', out_dir='/workspace',
        observations='/workspace/observations.json')
P.render_view('draft', percentage=50)  # deliberately unscored
result = P.render_and_score('comparison', model_points={
    'ridge-left': [0,0,7], 'ridge-right': [8,0,7],
    'base-left': [0,0,0], 'base-right': [8,0,0]})
```

Values above illustrate the API only, not a building template. The installed
runtime resolves Node from `runtime.json`; `setup(node=..., evaluator=...)`
can override it. The evaluator runs locally, through the same JS function used
by `compare_model`. It writes `evaluation.json`, `overlay.png` and a history.
It reads the actual Blender camera at render time. Pass `render_mask=...` only
for a mask produced from that same state. Style application has its own result.

Defaults: landmark maximum error ≤5 original-image pixels; mask IoU ≥0.95.
A landmark assessment needs at least four noncollinear, spatially spread points
and all requested correspondences. Set task-appropriate thresholds before fitting.
Changing reference/annotations/masks/thresholds creates a new history key. PASS
means only those checks passed; INCOMPLETE means evidence was unavailable.
`stalled` means three comparable losses barely changed, not convergence.
