"""IFC4 authoring in SI metres. Geometry and evidence remain separate.
Pure IfcOpenShell; load the saved file into Bonsai to view it.
"""
VERSION = "0.7.0"
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
    for registry in (_WALL_AXES, _OPENING_GEO, _STYLES, _STYLE_RGB, _ELEMENT_STYLES):
        registry.clear()
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
    """Attach the measurement evidence to the building. Record observed image facts, derived dimensions and explicit assumptions
    separately; one photograph does not establish survey accuracy."""
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
_STYLE_RGB = {}
_ELEMENT_STYLES = {}


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
    _STYLE_RGB[name] = [float(rgb[0]), float(rgb[1]), float(rgb[2])]
    return st


def element(ctx, ifc_class, name, storey, verts, faces, predefined_type=None, style_name=None):
    """Create an entity with a mesh Body representation, contained in `storey`."""
    if ctx["f"] is not _CTX.get("f"):
        raise ValueError("Inactive model context; load a separate helper module for concurrent files")
    el = _run("root.create_entity", ifc_class=ifc_class, name=name)
    if predefined_type is not None and hasattr(el, "PredefinedType"):
        el.PredefinedType = predefined_type
    rep = _run(
        "geometry.add_mesh_representation",
        context=ctx["body"],
        vertices=[[list(v) for v in verts]],
        faces=[[list(fc) for fc in faces]],
    )
    _run("geometry.assign_representation", product=el, representation=rep)
    if style_name is not None:
        _run("style.assign_representation_styles", shape_representation=rep, styles=[_STYLES[style_name]])
        _ELEMENT_STYLES[el.GlobalId] = style_name
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
    ln = math.hypot(dx, dy)
    if ln <= 0 or height <= 0 or thickness <= 0:
        raise ValueError("Wall length, height and thickness must be positive")
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


def profile_wall(ctx, storey, p1, p2, profile, thickness=0.3, z0=0.0, name="Profile wall", style_name=None):
    """Vertical wall with a polygon in (distance along wall, height above z0).
    Openings use the same local wall axis as wall().
    """
    import numpy as np
    d=np.asarray(p2,dtype=float)-p1; length=float(np.linalg.norm(d))
    if length <= 0 or thickness <= 0: raise ValueError("Positive wall length and thickness required")
    u=d/length; n=np.array([-u[1],u[0]])
    verts=[]
    for side in (-thickness/2, thickness/2):
        for along,z in profile:
            xy=np.asarray(p1)+u*along+n*side; verts.append((float(xy[0]),float(xy[1]),z0+z))
    count=len(profile)
    faces=[list(range(count))[::-1],list(range(count,2*count))]+[[i,(i+1)%count,(i+1)%count+count,i+count] for i in range(count)]
    el=element(ctx,"IfcWall",name,storey,verts,faces,"SOLIDWALL",style_name=style_name)
    _WALL_AXES[el.id()]=(p1,p2,thickness,z0)
    return el


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
    ln = math.hypot(dx, dy)
    if ln <= 0 or height <= 0 or width <= 0:
        raise ValueError("Opening dimensions must be positive")
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
    el.OverallWidth = math.dist(A, B)
    el.OverallHeight = h
    qto = _run("pset.add_qto", product=el, name=f"Qto_{cls[3:]}BaseQuantities")
    _run("pset.edit_qto", qto=qto, properties={"Width": el.OverallWidth, "Height": h, "Area": el.OverallWidth * h})
    return el


def mapped_copy(ctx, source, storey, translation, name=None):
    """Reuse a source Body with a translated mapped representation.
    Source geometry must be in world coordinates with no ObjectPlacement;
    use one unmoved prototype for a repetition group.
    """
    import numpy as np
    if source.ObjectPlacement is not None:
        raise ValueError("Mapped-copy source must be an unplaced prototype")
    if ctx["f"] is not _CTX.get("f"):
        raise ValueError("Inactive model context")
    el = _run("root.create_entity", ifc_class=source.is_a(), name=name or source.Name)
    rep = next(r for r in source.Representation.Representations if r.RepresentationIdentifier == "Body")
    mapped = _run("geometry.map_representation", representation=rep)
    _run("geometry.assign_representation", product=el, representation=mapped)
    matrix = np.eye(4); matrix[:3, 3] = translation
    _run("geometry.edit_object_placement", product=el, matrix=matrix, is_si=True)
    _run("spatial.assign_container", products=[el], relating_structure=storey)
    if hasattr(el, "PredefinedType"): el.PredefinedType = source.PredefinedType
    if source.GlobalId in _ELEMENT_STYLES:
        _ELEMENT_STYLES[el.GlobalId] = _ELEMENT_STYLES[source.GlobalId]
    if el.is_a("IfcWindow") or el.is_a("IfcDoor"):
        el.OverallWidth, el.OverallHeight = source.OverallWidth, source.OverallHeight
        qto = _run("pset.add_qto", product=el, name=f"Qto_{el.is_a()[3:]}BaseQuantities")
        _run("pset.edit_qto", qto=qto, properties={"Width": el.OverallWidth, "Height": el.OverallHeight, "Area": el.OverallWidth * el.OverallHeight})
    return el


def opening_grid(ctx, wall_el, rows, cols, width, height, sill0, storey_h, x0, gap, kind="window", storey=None):
    """One geometric fill prototype per grid; each opening/fill remains semantic IFC.
    Use only for repetitions actually visible or explicitly assumed.
    """
    out = []
    p1, p2, _, _ = _WALL_AXES[wall_el.id()]
    length = math.dist(p1, p2)
    ux, uy = (p2[0]-p1[0])/length, (p2[1]-p1[1])/length
    for r in range(rows):
        for c in range(cols):
            op = opening(ctx, wall_el, x0 + c * (width + gap), sill0 + r * storey_h, width, height,
                         name=f"Opening r{r}c{c}")
            name = f"{kind.capitalize()} r{r}c{c}"
            if not out:
                el = fill(ctx, op, kind, storey=storey, name=name)
            else:
                dx = c * (width + gap)
                el = mapped_copy(ctx, out[0], storey, (ux*dx, uy*dx, r*storey_h), name)
                _run("feature.add_filling", opening=op, element=el)
            out.append(el)
    return out


def save(ctx, path):
    import json, hashlib
    if ctx["f"] is not _CTX.get("f"):
        raise ValueError("Inactive model context")
    ctx["f"].write(str(path))
    registry = {"schema_version": 1, "version": VERSION, "ifc_sha256": hashlib.sha256(open(path, "rb").read()).hexdigest(),
                "styles": dict(_STYLE_RGB), "elements": dict(_ELEMENT_STYLES)}
    # Explicitly bound to this IFC, not newest-file discovery in a render directory.
    with open(str(path) + ".styles.json", "w") as fh:
        json.dump(registry, fh, indent=2)
    return path


def gate_report(path_or_file, required_classes=("IfcWall", "IfcRoof", "IfcSlab"), proxy_exceptions=None):
    """Independent format, geometry and semantic checks. Unavailable != PASS.
    Proxy exceptions map GlobalId to a nonempty justification. Geometry checks
    do not establish photographic fidelity, watertight junctions or BIM-authoring
    interoperability in a downstream application.
    """
    import numpy as np
    f = ifcopenshell.open(str(path_or_file)) if not isinstance(path_or_file, ifcopenshell.file) else path_or_file
    report = {"schema": "PASS", "geometry": "PASS", "semantics": "PASS", "schema_errors": [],
              "geometry_errors": [], "semantic_errors": [], "census": {}, "proxies": 0,
              "proxy_exceptions": {}, "uncontained": [], "geometry_checked": 0, "verdict": "PASS"}
    try:
        import ifcopenshell.validate as v
        logger = v.json_logger(); v.validate(f, logger)
        report["schema_errors"] = [str(e)[:400] for e in logger.statements]
        if report["schema_errors"]: report["schema"] = "FAIL"
    except Exception as e:
        report["schema"] = "UNAVAILABLE"; report["schema_errors"].append(str(e))
    try:
        import ifcopenshell.geom as geom
        settings = geom.settings()
        for el in f.by_type("IfcElement"):
            if not el.Representation:
                report["geometry_errors"].append(f"{el.GlobalId} {el.is_a()} {el.Name}: missing representation")
                continue
            try:
                shape = geom.create_shape(settings, el)  # retain owner while reading geometry
                coords = np.asarray(shape.geometry.verts)
                if not len(coords) or not len(shape.geometry.faces) or not np.isfinite(coords).all():
                    raise ValueError("empty or non-finite geometry")
                report["geometry_checked"] += 1
            except Exception as e:
                report["geometry_errors"].append(f"{el.GlobalId} {el.Name}: {e}")
        if report["geometry_errors"]: report["geometry"] = "FAIL"
    except Exception as e:
        report["geometry"] = "UNAVAILABLE"; report["geometry_errors"].append(str(e))
    errors = report["semantic_errors"]
    classes = set(required_classes) | {"IfcWall", "IfcRoof", "IfcSlab", "IfcWindow", "IfcDoor", "IfcOpeningElement", "IfcBuildingStorey", "IfcBuildingElementProxy"}
    report["census"] = {cls: len(f.by_type(cls)) for cls in sorted(classes)}
    for cls in required_classes:
        if not report["census"][cls]: errors.append(f"Missing required class {cls}")
    for cls in ("IfcProject", "IfcSite", "IfcBuilding"):
        if len(f.by_type(cls)) != 1: errors.append(f"Expected exactly one {cls}")
    if not f.by_type("IfcBuildingStorey"): errors.append("Missing storeys")
    parent_types = {"IfcSite": "IfcProject", "IfcBuilding": "IfcSite", "IfcBuildingStorey": "IfcBuilding"}
    for cls, parent in parent_types.items():
        for el in f.by_type(cls):
            rels = el.Decomposes
            if len(rels) != 1 or not rels[0].RelatingObject.is_a(parent): errors.append(f"Invalid spatial parent: {el.Name}")
    projects=f.by_type("IfcProject")
    units=projects[0].UnitsInContext.Units if projects and projects[0].UnitsInContext else []
    if not any(u.is_a("IfcSIUnit") and u.UnitType == "LENGTHUNIT" and u.Name == "METRE" and u.Prefix is None for u in units):
        errors.append("Project length units must be SI metres")
    from ifcopenshell.util.element import get_container
    for el in f.by_type("IfcElement"):
        if el.is_a("IfcOpeningElement"): continue
        container = get_container(el)
        if not container or not container.is_a("IfcBuildingStorey"):
            report["uncontained"].append(el.GlobalId); errors.append(f"No storey container: {el.Name}")
    exceptions = proxy_exceptions or {}
    for el in f.by_type("IfcBuildingElementProxy"):
        report["proxies"] += 1
        reason = exceptions.get(el.GlobalId)
        if isinstance(reason, str) and reason.strip() and not (el.Name or "").startswith("MASSING-"):
            report["proxy_exceptions"][el.GlobalId] = reason
        else: errors.append(f"Unexplained proxy or massing placeholder: {el.Name}")
    for op in f.by_type("IfcOpeningElement"):
        if len(op.VoidsElements) != 1: errors.append(f"Opening needs one host: {op.Name}")
        if len(op.HasFillings) != 1: errors.append(f"Opening needs one filling: {op.Name}")
    for el in f.by_type("IfcWindow") + f.by_type("IfcDoor"):
        if len(el.FillsVoids) != 1: errors.append(f"Window/door needs one opening: {el.Name}")
        if not el.OverallWidth or el.OverallWidth <= 0 or not el.OverallHeight or el.OverallHeight <= 0:
            errors.append(f"Missing semantic width/height: {el.Name}")
    if errors: report["semantics"] = "FAIL"
    statuses = [report[k] for k in ("schema", "geometry", "semantics")]
    report["verdict"] = "FAIL" if "FAIL" in statuses else "INCOMPLETE" if "UNAVAILABLE" in statuses else "PASS"
    return report
