"""Load the exact on-disk helper version, without stale Blender module caches."""
import hashlib
import importlib.util
import pathlib
import sys

VERSION = "0.7.1"

def load():
    root = pathlib.Path(__file__).resolve().parent
    modules = {}
    for name in ("ifc_helpers", "ifc_scene", "photostudio", "validation"):
        path = root / (name + ".py")
        digest = hashlib.sha256(path.read_bytes()).hexdigest()[:12]
        key = f"photo_to_bim_{name}_{digest}"
        # Execute a fresh module even when the content hash is unchanged: no model state leaks.
        spec = importlib.util.spec_from_file_location(key, path)
        module = importlib.util.module_from_spec(spec)
        sys.modules[key] = module
        # Compiling source directly also avoids timestamp-based .pyc reuse after upgrades.
        exec(compile(path.read_text(), str(path), "exec"), module.__dict__)
        if module.VERSION != VERSION:
            raise RuntimeError(f"Mixed helper versions: bootstrap {VERSION}, {name} {module.VERSION}")
        modules[name] = module
    modules["photostudio"]._SCENE = modules["ifc_scene"]
    return {"version": VERSION, "helpers": modules["ifc_helpers"], "studio": modules["photostudio"],
            "scene": modules["ifc_scene"], "validation": modules["validation"],
            "capabilities": ["camera_frame_v1", "canonical_evaluation_v1", "ifc_gate_v1", "profile_wall",
                             "item_materials_v2", "framed_fill", "ifc_landmarks_v1", "acceptance_v1"]}
