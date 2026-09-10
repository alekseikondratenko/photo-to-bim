"""General-shape IFC authoring helpers for the photo-to-bim method.

Load once inside Blender (exec via the MCP `execute_blender_code`, or import in a
script), author with MEASURED values, save, then view with `bpy.ops.bim.load_project`.

Design rules, learned the hard way across field runs:
- Pure ifcopenshell — no bpy, no bonsai imports — so the same code runs headless
  and is covered by the repo's regression test. Viewing is a separate step.
- Every call sequence here was proven against a live Bonsai install (ifcopenshell
  0.8.x) by a field run; do not "modernise" calls without re-proving them.
- NOTHING in here is house-shaped. Massing is any footprint polygon; a roof is
  any set of 3D planes (a gable is two, a hip is four, a tower cap is none);
  towers get `opening_grid`. The tower photographs are the regression subjects
  that keep it that way.
- Massing placeholders are IfcBuildingElementProxy named 'MASSING-*' on purpose:
  the delivery gate requires proxy count ~0, so an unreplaced massing block
  FAILS delivery. Scaffolding that does not decay into fake BIM.

Units are METRES throughout (the file declares SI metres).
"""
import math

import ifcopenshell
import ifcopenshell.api


def _run(cmd, **kw):
    return ifcopenshell.api.run(cmd, _CTX["f"], **kw)


_CTX = {}


# ---------------------------------------------------------------- model shell

def new_model(project_name, storeys, site_name="Site", building_name="Building"):
    """Create file + spatial tree. `storeys` = [(name, elevation_m), ...].

    Returns the ctx dict every other helper takes first.
    """
    f = ifcopenshell.api.run("project.create_file", version="IFC4")
    _CTX["f"] = f
    project = _run("root.create_entity", ifc_class="IfcProject", name=project_name)
    units = [_run("unit.add_si_unit", unit_type=u) for u in ("LENGTHUNIT", "AREAUNIT", "VOLUMEUNIT")]
    _run("unit.assign_unit", units=units)
    model = _run("context.add_context", context_type="Model")
    body = _run(
        "context.add_context",
        context_type="Model",
        context_identifier="Body",
        target_view="MODEL_VIEW",
        parent=model,
    )
    site = _run("root.create_entity", ifc_class="IfcSite", name=site_name)
    building = _run("root.create_entity", ifc_class="IfcBuilding", name=building_name)
    ctx = {
        "f": f,
        "body": body,
        "project": project,
        "site": site,
        "building": building,
        "storeys": {},
    }
    st_entities = []
    for name, elev in storeys:
        st = _run("root.create_entity", ifc_class="IfcBuildingStorey", name=name)
        st.Elevation = float(elev)
        ctx["storeys"][name] = st
        st_entities.append(st)
    _run("aggregate.assign_object", products=[site], relating_object=project)
    _run("aggregate.assign_object", products=[building], relating_object=site)
    _run("aggregate.assign_object", products=st_entities, relating_object=building)
    return ctx


def evidence_pset(ctx, properties, name="Reconstruction_Evidence"):
    """Attach the measurement evidence to the building. Every value your RECON
    ledger calls Verified belongs here — this is what separates the output from
    a guessed model."""
    ps = _run("pset.add_pset", product=ctx["building"], name=name)
    _run("pset.edit_pset", pset=ps, properties=properties)
    return ps


# ---------------------------------------------------------------- geometry core

def _ear_clip(poly):
    """Triangulate a simple 2D polygon (CCW), concave allowed. Returns index triples."""
    idx = list(range(len(poly)))
    if _area(poly) < 0:
        idx.reverse()
    tris = []
    guard = 0
    while len(idx) > 3 and guard < 10000:
        guard += 1
        n = len(idx)
        for k in range(n):
            a, b, c = idx[(k - 1) % n], idx[k], idx[(k + 1) % n]
            if _cross(poly[a], poly[b], poly[c]) <= 0:
                continue
            if any(
                _inside(poly[a], poly[b], poly[c], poly[j])
                for j in idx
                if j not in (a, b, c)
            ):
                continue
            tris.append((a, b, c))
            idx.pop(k)
            break
        else:
            break  # degenerate; fall back to fan below
    if len(idx) == 3:
        tris.append(tuple(idx))
    elif len(idx) > 3:
        for k in range(1, len(idx) - 1):
            tris.append((idx[0], idx[k], idx[k + 1]))
    return tris


def _area(poly):
    return 0.5 * sum(
        poly[i][0] * poly[(i + 1) % len(poly)][1] - poly[(i + 1) % len(poly)][0] * poly[i][1]
        for i in range(len(poly))
    )


def _cross(a, b, c):
    return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])


def _inside(a, b, c, p):
    d1 = _cross(a, b, p)
    d2 = _cross(b, c, p)
    d3 = _cross(c, a, p)
    return (d1 > 0) == (d2 > 0) == (d3 > 0)


def prism_mesh(footprint, z0, z1):
    """Vertical prism over a 2D footprint polygon: (verts, faces)."""
    n = len(footprint)
    verts = [(x, y, z0) for x, y in footprint] + [(x, y, z1) for x, y in footprint]
    faces = [[i, (i + 1) % n, (i + 1) % n + n, i + n] for i in range(n)]
    faces += [list(t)[::-1] for t in _ear_clip(footprint)]           # bottom
    faces += [[a + n, b + n, c + n] for a, b, c in _ear_clip(footprint)]  # top
    return verts, faces


def plane_mesh(polygon3d, thickness=0.06):
    """A roof/canopy plane: 3D polygon extruded along its own normal."""
    p0, p1, p2 = polygon3d[0], polygon3d[1], polygon3d[2]
    u = [p1[i] - p0[i] for i in range(3)]
    v = [p2[i] - p0[i] for i in range(3)]
    nrm = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
    ln = math.sqrt(sum(c * c for c in nrm)) or 1.0
    off = [c / ln * thickness for c in nrm]
    m = len(polygon3d)
    verts = list(polygon3d) + [tuple(p[i] + off[i] for i in range(3)) for p in polygon3d]
    faces = [list(range(m))[::-1], [i + m for i in range(m)]]
    faces += [[i, (i + 1) % m, (i + 1) % m + m, i + m] for i in range(m)]
    return verts, faces


_STYLES = {}


def style(name, rgb):
    """An IfcSurfaceStyle. `rgb` = (r, g, b) floats 0-1 — SAMPLE THEM FROM THE
    PHOTOGRAPH (view_crop the wall/roof/gable and read the dominant colour);
    a measured colour is evidence like any other. Pass the name to any element
    helper as `style_name=`."""
    st = _run("style.add_style", name=name)
    _run(
        "style.add_surface_style",
        style=st,
        attributes={
            "SurfaceColour": {"Red": float(rgb[0]), "Green": float(rgb[1]), "Blue": float(rgb[2])},
            "Transparency": 0.0,
        },
    )
    _STYLES[name] = st
    return st


def element(ctx, ifc_class, name, storey, verts, faces, predefined_type=None, style_name=None):
    """Create an entity with a mesh Body representation, contained in `storey`."""
    el = _run("root.create_entity", ifc_class=ifc_class, name=name)
    if predefined_type is not None and hasattr(el, "PredefinedType"):
        try:
            el.PredefinedType = predefined_type
        except Exception:
            pass
    rep = _run(
        "geometry.add_mesh_representation",
        context=ctx["body"],
        vertices=[[list(v) for v in verts]],
        faces=[[list(fc) for fc in faces]],
    )
    _run("geometry.assign_representation", product=el, representation=rep)
    if style_name is not None:
        _run("style.assign_representation_styles", shape_representation=rep, styles=[_STYLES[style_name]])
    if storey is not None:
        _run("spatial.assign_container", products=[el], relating_structure=storey)
    return el


# ---------------------------------------------------------------- elements

def massing(ctx, storey, footprint, height, z0=0.0, name="MASSING-block", style_name=None):
    """Whole-building massing placeholder. Deliberately an
    IfcBuildingElementProxy: the delivery gate fails on proxies, so massing
    MUST be replaced by real walls/roof/slabs before the run can finish."""
    verts, faces = prism_mesh(footprint, z0, z0 + height)
    return element(ctx, "IfcBuildingElementProxy", name, storey, verts, faces, style_name=style_name)


def wall(ctx, storey, p1, p2, height, thickness=0.3, z0=0.0, name="Wall", style_name=None):
    """Straight wall from plan point p1 to p2 (metres), extruded to `height`."""
    dx, dy = p2[0] - p1[0], p2[1] - p1[1]
    ln = math.hypot(dx, dy) or 1.0
    nx, ny = -dy / ln * thickness / 2, dx / ln * thickness / 2
    footprint = [
        (p1[0] + nx, p1[1] + ny),
        (p2[0] + nx, p2[1] + ny),
        (p2[0] - nx, p2[1] - ny),
        (p1[0] - nx, p1[1] - ny),
    ]
    verts, faces = prism_mesh(footprint, z0, z0 + height)
    el = element(ctx, "IfcWall", name, storey, verts, faces, "SOLIDWALL", style_name=style_name)
    el.ObjectType = "photo-to-bim wall"
    _WALL_AXES[el.id()] = (p1, p2, thickness, z0)
    return el


_WALL_AXES = {}


def slab(ctx, storey, footprint, thickness=0.2, z_top=0.0, name="Slab", predefined="FLOOR", style_name=None):
    verts, faces = prism_mesh(footprint, z_top - thickness, z_top)
    return element(ctx, "IfcSlab", name, storey, verts, faces, predefined, style_name=style_name)


def roof(ctx, storey, planes, thickness=0.08, name="Roof", style_name=None):
    """One IfcRoof from ANY set of 3D plane polygons. A gable is two quads, a
    hip four, a Zwerchgiebel adds two more, a flat tower cap is one."""
    verts, faces = [], []
    for poly in planes:
        v, fs = plane_mesh(poly, thickness)
        base = len(verts)
        verts += v
        faces += [[i + base for i in fc] for fc in fs]
    return element(ctx, "IfcRoof", name, storey, verts, faces, style_name=style_name)


def opening(ctx, wall_el, x_along, sill, width, height, name="Opening"):
    """Void a wall created by `wall()`: x_along runs p1->p2 (metres), sill is
    height above the wall's own base. Returns the IfcOpeningElement — pass it
    to `fill()` to put a window or door in it."""
    p1, p2, t, z0 = _WALL_AXES[wall_el.id()]
    dx, dy = p2[0] - p1[0], p2[1] - p1[1]
    ln = math.hypot(dx, dy) or 1.0
    ux, uy = dx / ln, dy / ln
    nx, ny = -uy, ux
    depth = t + 0.1
    corners = []
    for a in (x_along, x_along + width):
        px, py = p1[0] + ux * a, p1[1] + uy * a
        corners.append((px, py))
    footprint = [
        (corners[0][0] + nx * depth / 2, corners[0][1] + ny * depth / 2),
        (corners[1][0] + nx * depth / 2, corners[1][1] + ny * depth / 2),
        (corners[1][0] - nx * depth / 2, corners[1][1] - ny * depth / 2),
        (corners[0][0] - nx * depth / 2, corners[0][1] - ny * depth / 2),
    ]
    verts, faces = prism_mesh(footprint, z0 + sill, z0 + sill + height)
    op = element(ctx, "IfcOpeningElement", name, None, verts, faces)
    _run("feature.add_feature", feature=op, element=wall_el)
    _OPENING_GEO[op.id()] = (corners[0], corners[1], (nx, ny), z0 + sill, height)
    return op


_OPENING_GEO = {}


def fill(ctx, opening_el, kind="window", storey=None, name=None, style_name=None, pane_t=0.08):
    """Fill an opening with an IfcWindow or IfcDoor.

    The pane spans the FULL opening width and height and is thin only THROUGH
    the wall. (The first version shrank both axes, which rendered as a narrow
    plank floating inside every void — a field run's facade grew "alien" slats
    between its windows. The pane is the size of the hole, by construction.)
    """
    A, B, (nx, ny), z0, h = _OPENING_GEO[opening_el.id()]
    footprint = [
        (A[0] + nx * pane_t / 2, A[1] + ny * pane_t / 2),
        (B[0] + nx * pane_t / 2, B[1] + ny * pane_t / 2),
        (B[0] - nx * pane_t / 2, B[1] - ny * pane_t / 2),
        (A[0] - nx * pane_t / 2, A[1] - ny * pane_t / 2),
    ]
    verts, faces = prism_mesh(footprint, z0, z0 + h)
    cls = "IfcDoor" if kind == "door" else "IfcWindow"
    el = element(ctx, cls, name or kind.capitalize(), storey, verts, faces, style_name=style_name)
    _run("feature.add_filling", opening=opening_el, element=el)
    return el


def opening_grid(ctx, wall_el, rows, cols, width, height, sill0, storey_h, x0, gap, kind="window", storey=None):
    """Tower fenestration: rows x cols of identical openings+fills on one wall.
    Row r sits at sill0 + r*storey_h; column c at x0 + c*(width+gap)."""
    out = []
    for r in range(rows):
        for c in range(cols):
            op = opening(ctx, wall_el, x0 + c * (width + gap), sill0 + r * storey_h, width, height,
                         name=f"Opening r{r}c{c}")
            out.append(fill(ctx, op, kind, storey=storey, name=f"{kind.capitalize()} r{r}c{c}"))
    return out


def save(ctx, path):
    ctx["f"].write(path)
    return path


# ---------------------------------------------------------------- delivery gate

def gate_report(path_or_file):
    """The IFC delivery gate, one call. Deterministic; run it before delivering
    and paste the dict into RECON.md. Any FAIL blocks delivery:
      - schema errors from ifcopenshell.validate
      - elements whose geometry the IFC geometry engine cannot open
      - IfcBuildingElementProxy count > 0 (unreplaced massing, or garnish
        masquerading as BIM)
      - elements not contained in any storey
    """
    f = ifcopenshell.open(path_or_file) if isinstance(path_or_file, str) else path_or_file
    report = {"schema": "PASS", "schema_errors": [], "geometry": "PASS", "geometry_errors": [],
              "census": {}, "proxies": 0, "uncontained": [], "verdict": "PASS"}
    try:
        import ifcopenshell.validate as v
        logger = v.json_logger()
        v.validate(f, logger)
        errs = [e for e in logger.statements]
        if errs:
            report["schema"] = "FAIL"
            report["schema_errors"] = [str(e)[:200] for e in errs[:10]]
    except Exception as e:  # validator itself unavailable — say so, never skip silently
        report["schema"] = f"UNAVAILABLE: {e}"
    try:
        import ifcopenshell.geom as geom
        settings = geom.settings()
        for el in f.by_type("IfcProduct"):
            if not el.Representation:
                continue
            try:
                geom.create_shape(settings, el)
            except Exception as e:
                report["geometry"] = "FAIL"
                report["geometry_errors"].append(f"{el.is_a()} '{el.Name}': {str(e)[:120]}")
    except Exception as e:
        report["geometry"] = f"UNAVAILABLE: {e}"
    for cls in ("IfcWall", "IfcRoof", "IfcSlab", "IfcWindow", "IfcDoor", "IfcOpeningElement",
                "IfcBuildingStorey", "IfcBuildingElementProxy"):
        report["census"][cls] = len(f.by_type(cls))
    report["proxies"] = report["census"]["IfcBuildingElementProxy"]
    contained = set()
    for rel in f.by_type("IfcRelContainedInSpatialStructure"):
        for el in rel.RelatedElements:
            contained.add(el.id())
    for el in f.by_type("IfcElement"):
        if el.is_a("IfcOpeningElement"):
            continue
        if el.id() not in contained:
            report["uncontained"].append(f"{el.is_a()} '{el.Name}'")
    if (report["schema"] == "FAIL" or report["geometry"] == "FAIL"
            or report["proxies"] > 0 or report["uncontained"]):
        report["verdict"] = "FAIL"
    return report
