"""PhotoCam + the scoring gate, inside Blender.

Load once via `execute_blender_code`. Then the loop is two calls per pass:
edit the IFC / scene, and `render_and_score('p3')` — rendering and being
graded are ONE action (a rule in instructions can be forgotten; a rule in the
only door cannot).

The scorer here is a port of the canonical one in the photo-to-bim MCP server
(mcp/src/scan.ts): same column-wise skyline transpose, same worst-segment
localisation, same stop verdicts. If you change one, change the other. The
full evidence pack (luma detail, overlays) still comes from the server's
`compare_images` / `score_render` — use those for anything this summary does
not answer.
"""
import json
import math
import os

import bpy
import numpy as np

_STATE = {"ref": None, "span": None, "out_dir": None, "history": []}


# ---------------------------------------------------------------- setup

def setup(camera_for_blender, reference_path, out_dir=None, span=None):
    """Build PhotoCam from `solve_camera`'s camera_for_blender block (paste it
    verbatim), point the render at the reference's exact size, neutral light.

    `span` = (x0, x1) subject columns in the photograph. Set it as soon as you
    have measured the subject's extent — the flanks of a real photograph
    measure trees and weather, and two field runs hand-built their own scoped
    scorer because the full-frame number could not be trusted.
    """
    cb = camera_for_blender
    scene = bpy.context.scene
    cam_data = bpy.data.cameras.get("PhotoCam") or bpy.data.cameras.new("PhotoCam")
    ob = bpy.data.objects.get("PhotoCam") or bpy.data.objects.new("PhotoCam", cam_data)
    if ob.name not in {o.name for o in scene.collection.all_objects}:
        scene.collection.objects.link(ob)
    cam_data.sensor_fit = "HORIZONTAL"
    cam_data.sensor_width = cb["sensor_width_mm"]
    cam_data.lens = cb["lens_mm"]
    cam_data.shift_x = cb["shift_x"]
    cam_data.shift_y = cb["shift_y"]
    w, h = cb["render_resolution"]
    scene.render.resolution_x, scene.render.resolution_y = int(w), int(h)
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.camera = ob
    if cb.get("horizontal_distance_m") is not None and cb.get("eye_height_m") is not None:
        import mathutils
        d, e = cb["horizontal_distance_m"], cb["eye_height_m"]
        t = cb.get("tilt_above_horizontal_deg") or 0.0
        ob.location = (0.0, -d, e)
        target = mathutils.Vector((0.0, 0.0, e + d * math.tan(math.radians(t))))
        ob.rotation_euler = (target - ob.location).to_track_quat("-Z", "Y").to_euler()
    # Neutral, deterministic light — match the photograph later, on evidence.
    if not bpy.data.objects.get("PhotoSun"):
        sun = bpy.data.lights.new("PhotoSun", type="SUN")
        sun.energy = 3.0
        sob = bpy.data.objects.new("PhotoSun", sun)
        scene.collection.objects.link(sob)
        sob.rotation_euler = (math.radians(50), 0, math.radians(35))
    world = scene.world or bpy.data.worlds.new("PhotoWorld")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs["Color"].default_value = (0.62, 0.71, 0.82, 1)
        bg.inputs["Strength"].default_value = 0.6
    _STATE["ref"] = reference_path
    _STATE["res"] = (int(w), int(h))
    _STATE["out_dir"] = out_dir or os.path.dirname(os.path.abspath(reference_path))
    _STATE["span"] = tuple(span) if span else None
    return f"PhotoCam ready: lens {cb['lens_mm']} mm, shift ({cb['shift_x']}, {cb['shift_y']}), {w}x{h}"


def set_span(x0, x1):
    _STATE["span"] = (int(x0), int(x1))
    return f"span set: columns {x0}-{x1} scored as subject_span on every save"


# ---------------------------------------------------------------- scoring core

def _load_pixels(path):
    img = bpy.data.images.load(path, check_existing=False)
    try:
        w, h = img.size
        px = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, img.channels)
        rgb = (px[::-1, :, :3] * 255.0)  # Blender rows are bottom-up; flip to image order
        return rgb
    finally:
        bpy.data.images.remove(img)


def _resize_to(im, w, h):
    ys = (np.linspace(0, im.shape[0] - 1, h)).astype(int)
    xs = (np.linspace(0, im.shape[1] - 1, w)).astype(int)
    return im[np.ix_(ys, xs)]


def _skyline(im, tol=42.0):
    """First row per column that breaks from that column's own top-margin sky.
    Port of scan.ts `skyline` — the transpose measurement."""
    h, w, _ = im.shape
    y_max = min(14, h)
    sky = np.median(im[2:y_max, :, :], axis=0)          # (w, 3)
    d = np.linalg.norm(im - sky[None, :, :], axis=2)    # (h, w)
    mask = d > tol
    out = np.full(w, -1, dtype=int)
    run = np.zeros(w, dtype=int)
    done = np.zeros(w, dtype=bool)
    for y in range(2, h):
        run = np.where(mask[y], run + 1, 0)
        hit = (~done) & (run >= 4)
        out[hit] = y - 3
        done |= hit
        if done.all():
            break
    return out


def _worst_segments(cols, signed, limit=3):
    """Port of scan.ts worstSegments: mean-relative floor, sign-pure runs."""
    a = np.abs(signed)
    if not len(a):
        return None
    thr = max(4.0, float(a.mean()) * 0.6)
    segs, cur = [], None
    for i in range(len(cols)):
        if a[i] <= thr:
            continue
        sgn = 1 if signed[i] > 0 else -1
        if cur and cols[i] - cur["x1"] <= 12 and cur["sign"] == sgn:
            cur["errs"].append(float(a[i]))
            cur["x1"] = int(cols[i])
        else:
            if cur:
                segs.append(cur)
            cur = {"x0": int(cols[i]), "x1": int(cols[i]), "sign": sgn, "errs": [float(a[i])]}
    if cur:
        segs.append(cur)
    out = []
    for s in segs:
        if len(s["errs"]) < 12:
            continue
        m = sum(s["errs"]) / len(s["errs"])
        out.append({
            "x0": s["x0"], "x1": s["x1"], "columns": len(s["errs"]),
            "mean_err_px": round(m, 1),
            "direction": ("render skyline too LOW (render top edge is below the photograph's)"
                          if s["sign"] > 0 else
                          "render skyline too HIGH (render top edge is above the photograph's)"),
            "_mass": m * len(s["errs"]),
        })
    out.sort(key=lambda s: -s["_mass"])
    for s in out:
        s.pop("_mass")
    return out[:limit] or None


def _skyline_score(ref, ren, span=None):
    a, b = _skyline(ref), _skyline(ren)
    w = ref.shape[1]
    lo = max(0, int(span[0])) if span else int(round(w * 0.03))
    hi = min(w, int(span[1])) if span else int(w * 0.97)
    xs = np.arange(lo, hi)
    ok = (a[lo:hi] >= 0) & (b[lo:hi] >= 0)
    if not ok.any():
        return None
    cols = xs[ok]
    signed = (b[lo:hi][ok] - a[lo:hi][ok]).astype(float)
    errs = np.abs(signed)
    third = len(errs) // 3
    mean = lambda v: round(float(v.mean()), 1) if len(v) else None
    return {
        "mean_top_error_px": mean(errs),
        "top_error_by_band": {"left": mean(errs[:third]), "middle": mean(errs[third:2 * third]),
                              "right": mean(errs[2 * third:])},
        "max_top_error_px": float(errs.max()),
        "columns_compared": int(len(errs)),
        "worst_segments": _worst_segments(cols, signed),
    }


def _luma_thirds(im, sky_rows):
    """Left/right-third mean luma inside the subject band — the lighting signal."""
    h, w, _ = im.shape
    cols = np.where(sky_rows >= 0)[0]
    if not len(cols):
        return None
    lum = im @ np.array([0.2126, 0.7152, 0.0722])
    third = max(1, len(cols) // 3)
    def band(cs):
        vals = [lum[sky_rows[c]:, c].mean() for c in cs if sky_rows[c] < h - 1]
        return round(float(np.mean(vals)), 1) if vals else None
    l, r = band(cols[:third]), band(cols[-third:])
    ratio = round(max(l, r) / max(1.0, min(l, r)), 3) if l and r else None
    return {"left_band_luma": l, "right_band_luma": r, "lit_over_shadow_ratio": ratio}


def _verdict(history, score, diag):
    """Two-verdict stop signal, per-variantless (one camera, one name stream)."""
    prev = [h for h in history if h.get("delta") is not None]
    if len(prev) < 1 or score.get("delta") is None:
        return None
    last = prev[-1]
    rel = lambda d, v: abs(d) / max(1.0, abs(v))
    cur_v = score["skyline"]["mean_top_error_px"]
    if rel(score["delta"], cur_v) >= 0.03 or rel(last["delta"], last["skyline_mean"]) >= 0.03:
        return None
    floor = round(diag * 0.01, 1)
    if cur_v <= floor:
        return {"verdict": "converged",
                "note": f"CONVERGED: skyline {cur_v} px, inside the {floor} px delivery floor and "
                        "unmoved for two passes. Further geometry passes are waste — run the IFC "
                        "gate (ifc_helpers.gate_report) and deliver."}
    return {"verdict": "stalled",
            "note": f"STALLED: skyline {cur_v} px, above the {floor} px floor and unmoved for two "
                    "passes. Repeating this KIND of pass will not close it — read worst_segments, "
                    "find which element spans those columns, re-MEASURE it (unproject, view_crop) "
                    "instead of re-tuning numbers."}


# ---------------------------------------------------------------- the gate

def render_view(name, camera=None):
    """UNSCORED render — presentation shots, rear checks, any camera. Never
    pushes a number into the history. Use render_and_score for evidence."""
    scene = bpy.context.scene
    prev = scene.camera
    if camera:
        scene.camera = bpy.data.objects[camera] if isinstance(camera, str) else camera
    out = os.path.join(_STATE["out_dir"] or ".", f"{name}.png")
    scene.render.filepath = out
    bpy.ops.render.render(write_still=True)
    scene.camera = prev
    return out


def render_and_score(name):
    """Render PhotoCam to <out_dir>/<name>.png and score it against the
    reference in the same call. Returns the score dict; also appends to
    <out_dir>/score-history.json.

    The camera is PINNED to PhotoCam here — a field run switched to a beauty
    camera and scored it, planting a 416 px "regression" in its history. Only
    the photograph's viewpoint may be scored; use render_view for everything
    else."""
    assert _STATE["ref"], "call setup() first"
    scene = bpy.context.scene
    scene.camera = bpy.data.objects["PhotoCam"]
    w, h = _STATE.get("res") or (scene.render.resolution_x, scene.render.resolution_y)
    scene.render.resolution_x, scene.render.resolution_y = int(w), int(h)
    scene.render.resolution_percentage = 100
    out = os.path.join(_STATE["out_dir"], f"{name}.png")
    scene.render.filepath = out
    bpy.ops.render.render(write_still=True)

    ren = _load_pixels(out)
    ref = _load_pixels(_STATE["ref"])
    ren = _resize_to(ren, ref.shape[1], ref.shape[0])

    if float(ren.max() - ren.min()) < 2.0:
        return {"saved": out, "scored": False,
                "warning": "RENDER IS UNIFORM (blank) — nothing scored. THE SCORING PIPELINE IS "
                           "HEALTHY; the RENDER is empty. Check the camera position, scene "
                           "contents and world, then re-render. Do not debug the scorer."}

    sky = _skyline_score(ref, ren)
    result = {
        "saved": out,
        "scored": True,
        "image_size": [int(ref.shape[1]), int(ref.shape[0])],
        "skyline": sky,
        "luma": _luma_thirds(ren, _skyline(ren)),
    }
    if _STATE["span"]:
        result["subject_span"] = {"x0": _STATE["span"][0], "x1": _STATE["span"][1],
                                  "skyline": _skyline_score(ref, ren, _STATE["span"])}
    elif sky and sky["top_error_by_band"]["middle"]:
        b = sky["top_error_by_band"]
        flanks = [v for v in (b["left"], b["right"]) if v is not None]
        if flanks and max(flanks) > 2 * b["middle"]:
            result["warning"] = ("Flank bands are >2x the middle — the full-frame number is "
                                 "probably measuring vegetation/sky, not the building. Call "
                                 "set_span(x0, x1) with the subject's measured columns; every "
                                 "save then carries a trustworthy subject_span block.")

    cur = sky["mean_top_error_px"] if sky else None
    hist = _STATE["history"]
    prev = hist[-1] if hist else None
    delta = round(cur - prev["skyline_mean"], 2) if (prev and cur is not None) else None
    if delta is not None:
        result["delta_vs_previous"] = {"skyline_mean": delta, "since": prev["name"]}
    entry = {"name": name, "skyline_mean": cur, "delta": delta}
    diag = math.hypot(ref.shape[1], ref.shape[0])
    v = _verdict(hist, {"skyline": sky, "delta": delta}, diag)
    if v:
        result["converged"] = v
    hist.append(entry)
    try:
        with open(os.path.join(_STATE["out_dir"], "score-history.json"), "w") as fh:
            json.dump(hist, fh, indent=1)
    except OSError:
        pass
    return result
