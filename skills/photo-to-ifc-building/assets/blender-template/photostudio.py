"""Blender render adapter. All photo evaluation runs through the bundled JS evaluator.
Drafts may be unscored. Scored renders use fixed evidence and exact reference pixels.
"""
VERSION = "0.7.0"
import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess

import bpy
from mathutils import Matrix

_STATE = {}


def setup(camera, reference_path, ifc_path, out_dir=None, observations=None, node=None, evaluator=None):
    """Accept camera_frame_v1 (right/down/forward), not legacy camera_for_blender.
    IFC path is explicit; style lookup never depends on the output directory.
    """
    if camera.get("schema_version") != 1 or camera.get("convention") != "Z_UP_RIGHT_HANDED":
        raise ValueError("Expected Z-up camera_frame_v1; load the 0.7 bootstrap")
    m = Matrix(camera["world_from_camera"])
    if not all(math.isfinite(v) for row in m for v in row):
        raise ValueError("Non-finite camera matrix")
    r = m.to_3x3()
    if abs(r.determinant() - 1) > 1e-5 or any(abs((r.transposed() @ r)[i][j] - (i == j)) > 1e-5 for i in range(3) for j in range(3)):
        raise ValueError("Camera rotation must be orthonormal and right-handed")
    w, h = camera["image_size"]
    if w <= 0 or h <= 0 or camera["focal_px"] <= 0:
        raise ValueError("Invalid image size or focal length")
    scene = bpy.context.scene
    data = bpy.data.cameras.get("PhotoCam") or bpy.data.cameras.new("PhotoCam")
    ob = bpy.data.objects.get("PhotoCam") or bpy.data.objects.new("PhotoCam", data)
    if ob.name not in scene.objects:
        scene.collection.objects.link(ob)
    # Blender camera is right/up/backward: flip the last two camera axes.
    ob.matrix_world = m @ Matrix.Diagonal((1, -1, -1, 1))
    data.type = "PERSP"
    data.sensor_fit, data.sensor_width = "HORIZONTAL", 36
    data.lens = camera["focal_px"] * 36 / w
    cx, cy = camera["principal_point"]
    data.shift_x, data.shift_y = (w / 2 - cx) / w, (cy - h / 2) / w
    scene.render.resolution_x, scene.render.resolution_y = int(w), int(h)
    scene.render.resolution_percentage = 100
    scene.render.pixel_aspect_x = scene.render.pixel_aspect_y = 1
    scene.render.use_border = False
    scene.render.image_settings.file_format = "PNG"
    scene.camera = ob
    if not bpy.data.objects.get("PhotoSun"):
        sun = bpy.data.lights.new("PhotoSun", type="SUN")
        sun.energy = 3
        light = bpy.data.objects.new("PhotoSun", sun)
        scene.collection.objects.link(light)
        light.rotation_euler = (math.radians(50), 0, math.radians(35))
    world = scene.world or bpy.data.worlds.new("PhotoWorld")
    scene.world, world.use_nodes = world, True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs["Color"].default_value = (.62, .71, .82, 1)
        bg.inputs["Strength"].default_value = .6
    package = Path(__file__).resolve().parents[4]
    runtime_path = package / "runtime.json"
    runtime = json.loads(runtime_path.read_text()) if runtime_path.exists() else {}
    _STATE.clear()
    _STATE.update(reference=str(Path(reference_path).resolve()), ifc=str(Path(ifc_path).resolve()),
                  out_dir=str(Path(out_dir or Path(reference_path).parent).resolve()),
                  observations=str(Path(observations).resolve()) if observations else None,
                  node=node or runtime.get("node") or shutil.which("node"),
                  evaluator=evaluator or str(package / "mcp/dist/ifc-server.mjs"), res=(w, h))
    return {"version": VERSION, "camera": camera_frame(), "appearance": ensure_materials()}


def camera_frame():
    """Read the current camera, including any changes made after setup."""
    scene = bpy.context.scene
    ob = scene.camera
    d = ob.data
    if d.type != "PERSP" or d.sensor_fit != "HORIZONTAL":
        raise ValueError("Evaluation requires a perspective camera with horizontal sensor fit")
    w, h = scene.render.resolution_x, scene.render.resolution_y
    if scene.render.resolution_percentage != 100 or scene.render.use_border or scene.render.pixel_aspect_x != scene.render.pixel_aspect_y:
        raise ValueError("Scoring requires full resolution, square pixels and no border")
    return {"schema_version": 1, "convention": "Z_UP_RIGHT_HANDED", "image_size": [w, h],
            "focal_px": d.lens * w / d.sensor_width,
            "principal_point": [w/2 - d.shift_x*w, h/2 + d.shift_y*w],
            "world_from_camera": [list(row) for row in (ob.matrix_world @ Matrix.Diagonal((1, -1, -1, 1)))]}


def ensure_materials():
    """Resolve exact IFC style registry by file hash and IFC GlobalId."""
    ifc = Path(_STATE["ifc"])
    path = Path(str(ifc) + ".styles.json")
    if not path.exists():
        return {"status": "INCOMPLETE", "reason": f"Missing explicit registry {path}"}
    reg = json.loads(path.read_text())
    if reg.get("schema_version") != 1 or reg.get("version") != VERSION or reg.get("ifc_sha256") != hashlib.sha256(ifc.read_bytes()).hexdigest():
        raise ValueError("Style registry version or IFC hash mismatch; re-save the current IFC")
    from bonsai.tool import Ifc
    mats = {}
    for name, rgb in reg["styles"].items():
        mat = bpy.data.materials.get(f"ptb-{name}") or bpy.data.materials.new(f"ptb-{name}")
        mat.use_nodes = True
        bsdf = mat.node_tree.nodes.get("Principled BSDF")
        if bsdf:
            bsdf.inputs["Base Color"].default_value = (*rgb, 1)
            bsdf.inputs["Roughness"].default_value = .75
        mat.diffuse_color = (*rgb, 1)
        mats[name] = mat
    applied = set()
    for ob in bpy.context.scene.objects:
        if ob.type != "MESH":
            continue
        entity = Ifc.get_entity(ob)
        guid = entity.GlobalId if entity else None
        name = reg["elements"].get(guid)
        if name in mats:
            ob.data.materials.clear()
            ob.data.materials.append(mats[name])
            applied.add(guid)
    missing = sorted(set(reg["elements"]) - applied)
    return {"status": "PASS" if applied and not missing else "INCOMPLETE", "applied": len(applied), "missing_guids": missing,
            "note": "Checks registry application, not photographic colour accuracy."}


def render_view(name="draft", percentage=50):
    """Fast unscored preview; does not append evaluation history."""
    if not 1 <= percentage <= 100 or Path(name).name != name:
        raise ValueError("Use a simple name and percentage 1..100")
    scene = bpy.context.scene
    out = Path(_STATE["out_dir"])
    out.mkdir(parents=True, exist_ok=True)
    previous = scene.render.resolution_percentage
    try:
        scene.render.resolution_percentage = percentage
        scene.render.filepath = str(out / (name + ".png"))
        bpy.ops.render.render(write_still=True)
    finally:
        scene.render.resolution_percentage = previous
    return {"render": str(out / (name + ".png")), "photographic_validation": "UNSCORED"}


def render_and_score(name="comparison", model_points=None, render_mask=None, tolerance_px=5, min_mask_iou=.95):
    """Render full-size beauty; optionally score supplied landmarks/mask.
    render_mask must be an explicit binary subject mask produced from this same
    model/camera. Beauty-image thresholding is not a mask generation method.
    """
    frame = camera_frame()
    appearance = ensure_materials()
    rendered = render_view(name, percentage=100)["render"]
    node, bundle = _STATE["node"], _STATE["evaluator"]
    if not node or not Path(bundle).is_file():
        raise RuntimeError("Canonical evaluator unavailable; configure Node and bundled evaluator in setup()")
    request = {"reference": _STATE["reference"], "render": rendered, "camera": frame,
               "model_points": model_points or {}, "out_dir": _STATE["out_dir"],
               "history_path": str(Path(_STATE["out_dir"]) / "score-history.json"), "name": name,
               "tolerance_px": tolerance_px, "min_mask_iou": min_mask_iou}
    if _STATE["observations"]:
        request["observations"] = _STATE["observations"]
    if render_mask:
        request["render_mask"] = str(Path(render_mask).resolve())
    proc = subprocess.run([node, bundle, "--evaluate-json"], input=json.dumps(request), text=True, capture_output=True, timeout=120)
    if proc.returncode:
        raise RuntimeError("Canonical evaluator failed: " + proc.stderr[-2000:])
    return {"render": rendered, "appearance": appearance, "photographic": json.loads(proc.stdout)}
