"""IFC4 authoring in SI metres. Geometry and evidence remain separate.
Pure IfcOpenShell; load the saved file into Bonsai to view it.
"""
VERSION = "0.8.4-dev.3"
import math

import ifcopenshell
import ifcopenshell.api


_GEOMETRY = None


def _geometry():
    global _GEOMETRY
    if _GEOMETRY is None:
        from pathlib import Path
        import types
        path = Path(__file__).with_name('geometry_cache.py')
        module = types.ModuleType('photo_geometry'); module.__file__ = str(path)
        exec(compile(path.read_text(), str(path), 'exec'), module.__dict__)
        if module.VERSION != VERSION: raise RuntimeError('Mixed geometry runtime versions')
        _GEOMETRY = module
    return _GEOMETRY


def _run(cmd, **kw):
    return ifcopenshell.api.run(cmd, _CTX["f"], **kw)


_CTX = {}
_MAPPED_SOURCES = {}


# ---------------------------------------------------------------- model shell

def new_model(project_name, storeys, site_name="Site", building_name="Building"):
    """Create file + spatial tree. `storeys` = [(name, elevation_m), ...].

    Returns the ctx dict every other helper takes first.
    """
    for registry in (_WALL_AXES, _OPENING_GEO, _STYLES, _STYLE_RGB, _ELEMENT_STYLES, _MAPPED_SOURCES):
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


def declare_scope(ctx, floor_coverage="inferred_floorplates", floor_storeys=None, omissions=None):
    """Record intended floor coverage, not a claim of surveyed completeness."""
    import json
    if floor_coverage not in ("exterior_only", "inferred_floorplates", "supplied_floorplates"):
        raise ValueError("Unknown floor coverage")
    names = list(ctx['storeys'] if floor_storeys is None else floor_storeys)
    omissions = omissions or {}
    if any(n not in ctx['storeys'] for n in names + list(omissions)):
        raise ValueError("Floor scope references unknown storeys")
    if any(not isinstance(reason, str) or not reason.strip() for reason in omissions.values()):
        raise ValueError("Floor omissions need reasons")
    return evidence_pset(ctx, {'ModelScope': 'photo-derived exterior',
        'DevelopmentTarget': 'Approximate LOD 200 for represented exterior elements',
        'FloorCoverage': floor_coverage, 'FloorStoreys': json.dumps(names),
        'FloorOmissions': json.dumps(omissions)}, name='Reconstruction_Scope')


def element_evidence(ctx, product, status, basis):
    """Per-occurrence provenance; visible shape does not establish construction."""
    if status not in ('observed', 'inferred', 'supplied', 'unknown') or not basis.strip():
        raise ValueError('Evidence needs a valid status and nonempty basis')
    ps = _run('pset.add_pset', product=product, name='Reconstruction_Element')
    _run('pset.edit_pset', pset=ps, properties={'Status': status, 'Basis': basis})
    return ps


def assign_type(ctx, products, name, predefined_type=None):
    """Reuse an explicit type family without replacing occurrence geometry.

    The caller chooses meaningful families/dimension tolerances, not one type
    per floating-point variant or one family for every window in a building.
    """
    from ifcopenshell.util.type import get_applicable_types
    products = list(products)
    if not products or len({p.is_a() for p in products}) != 1:
        raise ValueError('Type assignment needs products of one IFC class')
    classes = get_applicable_types(products[0].is_a(), ctx['f'].schema)
    if not classes: raise ValueError('No applicable IFC type')
    cls = classes[0]
    existing = [t for t in ctx['f'].by_type(cls) if t.Name == name]
    typ = existing[0] if existing else _run('root.create_entity', ifc_class=cls, name=name,
                                           predefined_type=predefined_type)
    if existing and predefined_type and typ.PredefinedType != predefined_type:
        raise ValueError('Existing type has a different predefined type')
    _run('type.assign_type', related_objects=products, relating_type=typ, should_map_representations=False)
    return typ


def assign_material(ctx, products, name, basis='assumed appearance-based material role'):
    """Assign a material identity independently of render styles; no guessed ratings/layers."""
    if not name.strip() or not basis.strip(): raise ValueError('Material needs a name and basis')
    materials = [m for m in ctx['f'].by_type('IfcMaterial') if m.Name == name]
    material = materials[0] if materials else _run('material.add_material', name=name)
    products = list(products)
    _run('material.assign_material', products=products, type='IfcMaterial', material=material)
    for product in products:
        ps = _run('pset.add_pset', product=product, name='Reconstruction_Material')
        _run('pset.edit_pset', pset=ps, properties={'Basis': basis})
    return material


def assembly(ctx, ifc_class, name, storey, components):
    """Create a geometry-less parent whose components supply its Body."""
    components = list(components)
    if not components: raise ValueError('An assembly needs components')
    parent = _run('root.create_entity', ifc_class=ifc_class, name=name)
    _run('spatial.assign_container', products=[parent], relating_structure=storey)
    _run('aggregate.assign_object', products=components, relating_object=parent)
    return parent


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
    """Outward-oriented vertical prism; accepts either footprint winding."""
    # Caps are triangulated counterclockwise. Match side winding to them without
    # mutating the caller's polygon; otherwise clockwise input reverses only sides.
    footprint = list(footprint)
    if _area(footprint) < 0:
        footprint.reverse()
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
    # Mesh vertices already use the model frame; identity keeps their world position.
    # A Body requires an explicit placement even when no transform is needed.
    import numpy as np
    _run("geometry.edit_object_placement", product=el, matrix=np.eye(4), is_si=True)
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
    if kind not in ("window", "door"):
        raise ValueError("Fill kind must be window or door")
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
    host_fill(ctx, opening_el, el)
    el.OverallWidth = math.dist(A, B)
    el.OverallHeight = h
    qto = _run("pset.add_qto", product=el, name=f"Qto_{cls[3:]}BaseQuantities")
    _run("pset.edit_qto", qto=qto, properties={"Width": el.OverallWidth, "Height": h, "Area": el.OverallWidth * h})
    return el


def host_fill(ctx, opening_el, product):
    """Record the intended host so loss of a hosted filling remains detectable."""
    _run('feature.add_filling', opening=opening_el, element=product)
    ps = _run('pset.add_pset', product=product, name='Reconstruction_Host')
    _run('pset.edit_pset', pset=ps, properties={'OpeningGlobalId': opening_el.GlobalId})


def mapped_copy(ctx, source, storey, translation, name=None, evidence=None):
    """Reuse a source Body with a translated mapped representation.
    Translation is a world-space offset from the source occurrence. Preserve its
    placement and share geometric items through a separately owned map source.
    """
    import numpy as np
    from ifcopenshell.util.placement import get_local_placement
    offset = np.asarray(translation, dtype=float)
    if offset.shape != (3,) or not np.isfinite(offset).all():
        raise ValueError("Translation must contain three finite metre values")
    if ctx["f"] is not _CTX.get("f"):
        raise ValueError("Inactive model context")
    el = _run("root.create_entity", ifc_class=source.is_a(), name=name or source.Name)
    rep = next(r for r in source.Representation.Representations if r.RepresentationIdentifier == "Body")
    # WR11: a representation cannot belong to both a product and a map.
    # Keep the prototype's Body; the map owns a lightweight wrapper over its items.
    map_source = _MAPPED_SOURCES.get(rep.id())
    if map_source is None:
        map_source = ctx['f'].create_entity('IfcShapeRepresentation',
            ContextOfItems=rep.ContextOfItems, RepresentationIdentifier=rep.RepresentationIdentifier,
            RepresentationType=rep.RepresentationType, Items=rep.Items)
        _MAPPED_SOURCES[rep.id()] = map_source
    mapped = _run("geometry.map_representation", representation=map_source)
    _run("geometry.assign_representation", product=el, representation=mapped)
    matrix = get_local_placement(source.ObjectPlacement).copy() if source.ObjectPlacement else np.eye(4)
    matrix[:3, 3] += offset
    _run("geometry.edit_object_placement", product=el, matrix=matrix, is_si=True)
    _run("spatial.assign_container", products=[el], relating_structure=storey)
    if hasattr(el, "PredefinedType"): el.PredefinedType = source.PredefinedType
    el.ObjectType = source.ObjectType
    from ifcopenshell.util.element import get_type, copy_deep
    typ = get_type(source)
    if typ:
        _run('type.assign_type', related_objects=[el], relating_type=typ, should_map_representations=False)
    # Keep shared material identity (including usage), but independent property
    # sets/quantities and a new occurrence GlobalId. Translation preserves sizes.
    for rel in source.HasAssociations:
        if rel.is_a('IfcRelAssociatesMaterial'):
            rel.RelatedObjects = tuple(rel.RelatedObjects) + (el,)
    for rel in source.IsDefinedBy:
        if rel.is_a('IfcRelDefinesByProperties'):
            if rel.RelatingPropertyDefinition.Name == 'Reconstruction_Host': continue
            definition = copy_deep(ctx['f'], rel.RelatingPropertyDefinition)
            ctx['f'].create_entity('IfcRelDefinesByProperties', GlobalId=ifcopenshell.guid.new(),
                RelatedObjects=[el], RelatingPropertyDefinition=definition)
    # A visible prototype does not prove that another occurrence was observed.
    element_evidence(ctx, el, **(evidence or {'status': 'unknown',
        'basis': 'Repeated geometry; occurrence evidence not supplied'}))
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
                host_fill(ctx, op, el)
            out.append(el)
    return out


def _item_style_records(item, path):
    if item.is_a("IfcMappedItem"):
        for i, child in enumerate(item.MappingSource.MappedRepresentation.Items):
            yield from _item_style_records(child, path + [i])
        return
    ids = []
    for assigned in getattr(item, "StyledByItem", ()):
        for style in assigned.Styles:
            if style.is_a("IfcSurfaceStyle"):
                ids.append(style.id())
            elif style.is_a("IfcPresentationStyleAssignment"):
                ids.extend(s.id() for s in style.Styles if s.is_a("IfcSurfaceStyle"))
    yield {"item_path": path, "item_id": item.id(), "surface_style_ids": ids}


def save(ctx, path):
    """Export IFC and a v2 item-level style registry, including mapped geometry."""
    import json, hashlib
    from pathlib import Path
    if ctx["f"] is not _CTX.get("f"):
        raise ValueError("Inactive model context")
    f = ctx["f"]
    f.write(str(path))
    catalog = {}
    for st in f.by_type("IfcSurfaceStyle"):
        for shading in st.Styles:
            if shading.is_a("IfcSurfaceStyleShading"):
                color = shading.SurfaceColour
                catalog[str(st.id())] = {"name": st.Name, "rgb": [color.Red, color.Green, color.Blue],
                    "transparency": getattr(shading, "Transparency", None) or 0.0}
    item_styles = {}
    for el in f.by_type("IfcElement"):
        if el.Representation:
            item_styles[el.GlobalId] = [record for ri, rep in enumerate(el.Representation.Representations)
                for ii, item in enumerate(rep.Items) for record in _item_style_records(item, [ri, ii])]
    registry = {"schema_version": 2, "version": VERSION, "ifc_sha256": hashlib.sha256(Path(path).read_bytes()).hexdigest(),
                "styles": dict(_STYLE_RGB), "elements": dict(_ELEMENT_STYLES),
                "surface_styles": catalog, "item_styles": item_styles}
    Path(str(path) + ".styles.json").write_text(json.dumps(registry, indent=2))
    return path


def framed_fill(ctx, opening_el, kind="window", storey=None, name=None,
                frame_style="frame", glass_style="glass", frame_width=.065,
                frame_depth=.14, glass_thickness=.025, crossbar_at=None):
    """One semantic filling with separately styled frame and glass items.
    crossbar_at is a fraction of opening height. All parts follow the host axis.
    """
    import numpy as np
    A, B, normal, z0, h = _OPENING_GEO[opening_el.id()]
    width = math.dist(A, B)
    if not 0 < frame_width < min(width, h)/2 or min(frame_depth, glass_thickness) <= 0:
        raise ValueError("Frame and glazing dimensions do not fit the opening")
    if crossbar_at is not None and not frame_width < h*crossbar_at < h-frame_width:
        raise ValueError("Crossbar must lie inside the frame")
    if frame_style not in _STYLES or glass_style not in _STYLES:
        raise ValueError("Create frame and glass styles before framed_fill()")
    el = fill(ctx, opening_el, kind, storey, name, frame_style)
    old = el.Representation.Representations[0]
    _run("geometry.unassign_representation", product=el, representation=old)
    _run("geometry.remove_representation", representation=old)
    u = (np.array(B)-A)/width; n = np.array(normal)
    def box(x0, x1, low, high, depth):
        footprint = [tuple(np.array(A)+u*x+n*y) for x,y in
                     ((x0,-depth/2),(x1,-depth/2),(x1,depth/2),(x0,depth/2))]
        return prism_mesh(footprint, z0+low, z0+high)
    bars = [(0,frame_width,0,h),(width-frame_width,width,0,h),
            (frame_width,width-frame_width,0,frame_width),
            (frame_width,width-frame_width,h-frame_width,h)]
    if crossbar_at is not None:
        bars.append((frame_width,width-frame_width,h*crossbar_at-frame_width/2,h*crossbar_at+frame_width/2))
    verts, faces = [], []
    for x0,x1,low,high in bars:
        vv,ff = box(x0,x1,low,high,frame_depth)
        faces.extend([[i+len(verts) for i in face] for face in ff]); verts.extend(vv)
    # Create each item separately: no ragged NumPy arrays or padding vertices.
    rep = _run("geometry.add_mesh_representation", context=ctx["body"], vertices=[verts], faces=[faces])
    vv,ff = box(frame_width,width-frame_width,frame_width,h-frame_width,glass_thickness)
    glass_rep = _run("geometry.add_mesh_representation", context=ctx["body"], vertices=[vv], faces=[ff])
    glass_item = glass_rep.Items[0]
    rep.Items = tuple(rep.Items)+(glass_item,)
    ctx["f"].remove(glass_rep)
    _run("geometry.assign_representation", product=el, representation=rep)
    _run("style.assign_item_style", item=rep.Items[0], style=_STYLES[frame_style])
    _run("style.assign_item_style", item=glass_item, style=_STYLES[glass_style])
    return el


def capture_landmarks(ifc_path, picks, max_distance_m=.05):
    """Snap named world-space picks to actual exported IFC mesh vertices.
    Returns an immutable snapshot bound to the IFC bytes and per-element geometry.
    """
    import hashlib, json
    import numpy as np
    import ifcopenshell.geom as geom
    from pathlib import Path
    if max_distance_m < 0 or not math.isfinite(max_distance_m):
        raise ValueError("Invalid landmark snap tolerance")
    f = ifcopenshell.open(str(ifc_path)); settings = geom.settings()
    settings.set(settings.USE_WORLD_COORDS, True)
    cache, bindings = {}, {}
    for name, pick in picks.items():
        if not name: raise ValueError("Landmarks need nonempty IDs")
        guid = pick["global_id"]
        if guid not in cache:
            el = f.by_guid(guid); sh = geom.create_shape(settings, el)
            vertices = np.asarray(sh.geometry.verts).reshape(-1,3)
            digest = hashlib.sha256(json.dumps([list(sh.geometry.verts),list(sh.geometry.faces)]).encode()).hexdigest()
            cache[guid] = vertices, digest
        vertices, digest = cache[guid]
        target = np.asarray(pick["world"], dtype=float)
        if target.shape != (3,) or not np.isfinite(target).all(): raise ValueError("Invalid world pick")
        distances = np.linalg.norm(vertices-target, axis=1); index = int(np.argmin(distances))
        if distances[index] > max_distance_m: raise ValueError(f"{name}: no exported vertex within snap tolerance")
        bindings[name] = {"global_id": guid, "vertex_index": index, "geometry_sha256": digest,
                          "world": vertices[index].tolist(), "snap_distance_m": float(distances[index])}
    return {"schema_version": 1, "ifc_sha256": hashlib.sha256(Path(ifc_path).read_bytes()).hexdigest(),
            "bindings": bindings, "model_points": {name:b["world"] for name,b in bindings.items()}}


def resolve_landmarks(ifc_path, snapshot):
    """Reject stale exports, missing elements and altered geometry before scoring."""
    import hashlib
    from pathlib import Path
    if snapshot.get("schema_version") != 1 or snapshot.get("ifc_sha256") != hashlib.sha256(Path(ifc_path).read_bytes()).hexdigest():
        raise ValueError("Stale landmark snapshot: recapture from the final exported IFC")
    picks = {name:{"global_id":b["global_id"],"world":b["world"]} for name,b in snapshot["bindings"].items()}
    current = capture_landmarks(ifc_path, picks, max_distance_m=1e-7)
    for name,b in current["bindings"].items():
        old = snapshot["bindings"][name]
        if b["geometry_sha256"] != old["geometry_sha256"] or b["world"] != snapshot["model_points"][name]:
            raise ValueError(f"Stale landmark geometry: {name}")
    return current["model_points"]


def gate_report(path_or_file, required_classes=("IfcWall", "IfcRoof", "IfcSlab"), proxy_exceptions=None):
    """Independent format, geometry and semantic checks. Unavailable != PASS.
    Proxy exceptions map GlobalId to a nonempty justification. Geometry checks
    do not establish photographic fidelity, watertight junctions or BIM-authoring
    interoperability in a downstream application.
    """
    import numpy as np
    snapshot = _geometry().snapshot(path_or_file) if not isinstance(path_or_file, ifcopenshell.file) else None
    f = snapshot.file if snapshot else path_or_file
    report = {"schema": "PASS", "geometry": "PASS", "semantics": "PASS", "schema_errors": [],
              "geometry_errors": [], "semantic_errors": [], "census": {}, "proxies": 0,
              "proxy_exceptions": {}, "uncontained": [], "geometry_checked": 0, "verdict": "PASS",
              "schema_check_scope": "Attribute/cardinality validation plus placement and shape-ownership rules; not full EXPRESS validation"}
    slab_review = []
    elevations = sorted(set(s.Elevation for s in f.by_type('IfcBuildingStorey') if s.Elevation is not None))
    gaps = np.diff(elevations)
    typical_height = float(np.median(gaps[gaps > 0])) if len(gaps) else None
    try:
        import ifcopenshell.validate as v
        logger = v.json_logger(); v.validate(f, logger)
        report["schema_errors"] = [str(e)[:400] for e in logger.statements]
        # Targeted formal rules are linear graph checks: no extra tessellation or render.
        for product in f.by_type('IfcProduct'):
            if (product.Representation and not product.ObjectPlacement and
                any(rep.is_a('IfcShapeRepresentation') for rep in product.Representation.Representations)):
                report['schema_errors'].append(f'IfcProduct.PlacementForShapeRepresentation: #{product.id()} {product.Name} has a shape but no placement')
        for shape in f.by_type('IfcShapeModel'):
            owners = (len(shape.OfProductRepresentation) == 1,
                      len(shape.RepresentationMap) == 1, len(shape.OfShapeAspect) == 1)
            if not (owners[0] ^ owners[1] ^ owners[2]):
                report['schema_errors'].append(f'IfcShapeModel.WR11: #{shape.id()} has invalid representation ownership')
        if report["schema_errors"]: report["schema"] = "FAIL"
    except Exception as e:
        report["schema"] = "UNAVAILABLE"; report["schema_errors"].append(str(e))
    try:
        import ifcopenshell.geom as geom
        settings = geom.settings()
        elements = f.by_type('IfcElement')
        leaves = [el for el in elements if not _geometry().is_assembly_container(el)]
        if snapshot:
            try: list(snapshot.iter_records(leaves))
            except ValueError: pass  # Per-product errors are reported below, never skipped.
        for el in leaves:
            if not el.Representation:
                report["geometry_errors"].append(f"{el.GlobalId} {el.is_a()} {el.Name}: missing representation")
                continue
            try:
                if snapshot:
                    record = snapshot.get(el)
                    coords, faces = _geometry().world_vertices(record), record.geometry.faces
                else:
                    shape = geom.create_shape(settings, el)  # Mutable IFC: always evaluate fresh.
                    coords, faces = np.asarray(shape.geometry.verts), shape.geometry.faces
                if not len(coords) or not len(faces) or not np.isfinite(coords).all():
                    raise ValueError("empty or non-finite geometry")
                if typical_height and el.is_a('IfcSlab'):
                    from ifcopenshell.util.element import get_predefined_type
                    size = np.ptp(np.asarray(coords).reshape(-1, 3), axis=0)
                    if get_predefined_type(el) == 'FLOOR' and size[2] > .4 * typical_height and min(size[:2]) > 2 * size[2]:
                        slab_review.append(el.GlobalId)
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
        if not container or not any(container.is_a(c) for c in ('IfcBuildingStorey', 'IfcBuilding', 'IfcSite')):
            report["uncontained"].append(el.GlobalId); errors.append(f"No spatial container: {el.Name}")
        if el.is_a('IfcCurtainWall') and _geometry().aggregate_children(el) and not _geometry().is_assembly_container(el):
            errors.append(f'{el.GlobalId}: Aggregated curtain wall must derive Body from components: {el.Name}')
    exceptions = proxy_exceptions or {}
    for el in f.by_type("IfcBuildingElementProxy"):
        report["proxies"] += 1
        reason = exceptions.get(el.GlobalId)
        if isinstance(reason, str) and reason.strip() and not (el.Name or "").startswith("MASSING-"):
            report["proxy_exceptions"][el.GlobalId] = reason
        else: errors.append(f"Unexplained proxy or massing placeholder: {el.Name}")
    for op in f.by_type("IfcOpeningElement"):
        if len(op.VoidsElements) != 1: errors.append(f"Opening needs one host: {op.Name}")
        if len(op.HasFillings) > 1: errors.append(f"Opening has multiple fillings: {op.Name}")
    for el in f.by_type("IfcWindow") + f.by_type("IfcDoor"):
        from ifcopenshell.util.element import get_pset
        expected = get_pset(el, 'Reconstruction_Host', 'OpeningGlobalId')
        if len(el.FillsVoids) > 1 or (expected and (not el.FillsVoids or el.FillsVoids[0].RelatingOpeningElement.GlobalId != expected)):
            errors.append(f"Hosted window/door lost its intended opening: {el.Name}")
        if not el.OverallWidth or el.OverallWidth <= 0 or not el.OverallHeight or el.OverallHeight <= 0:
            errors.append(f"Missing semantic width/height: {el.Name}")
    report['bim_review'] = bim_review(f)
    if slab_review:
        report['bim_review']['findings'].append({'code': 'DEEP_FLOOR_SOLID', 'count': len(slab_review),
            'sample_guids': slab_review[:10], 'message': 'FLOOR solids are deep relative to the model level spacing. Review whether these are floors, transfer structures or perimeter features; no automatic reclassification.'})
        report['bim_review']['status'] = 'REVIEW'
    if errors: report["semantics"] = "FAIL"
    statuses = [report[k] for k in ("schema", "geometry", "semantics")]
    report["verdict"] = "FAIL" if "FAIL" in statuses else "INCOMPLETE" if "UNAVAILABLE" in statuses else "PASS"
    return report


def bim_review(f):
    """Cheap, advisory graph review. Findings neither invent data nor trigger a render loop."""
    import json
    from ifcopenshell.util.element import get_container, get_type, get_material, get_psets
    physical = [e for e in f.by_type('IfcElement') if not e.is_a('IfcFeatureElement')]
    findings = []
    def finding(code, message, ids=()):
        findings.append({'code': code, 'message': message, 'count': len(ids), 'sample_guids': list(ids)[:10]})
    untyped = [e.GlobalId for e in physical if (e.is_a('IfcWindow') or e.is_a('IfcDoor') or
        (e.Representation and any(r.RepresentationType == 'MappedRepresentation' for r in e.Representation.Representations))) and not get_type(e)]
    if untyped: finding('UNTYPED_PRODUCTS', 'Review reusable types for repeated products; mapped geometry is not a type.', untyped)
    no_material = [e.GlobalId for e in physical if not _geometry().is_assembly_container(e) and get_material(e) is None]
    if no_material: finding('MATERIAL_INFORMATION', 'Material information is absent. Add supported or explicitly assumed roles; leave unknown specifications unknown.', no_material)
    scopes = [get_psets(b).get('Reconstruction_Scope', {}) for b in f.by_type('IfcBuilding')]
    scope = scopes[0] if scopes else {}
    if not scope.get('FloorCoverage'):
        finding('UNDECLARED_SCOPE', 'Record intended floor coverage and the approximate development target.')
    elif scope['FloorCoverage'] != 'exterior_only':
        try:
            expected = json.loads(scope.get('FloorStoreys', '[]'))
            omissions = json.loads(scope.get('FloorOmissions', '{}'))
            if not isinstance(expected, list) or not isinstance(omissions, dict): raise ValueError('Invalid floor scope')
            covered = set()
            for slab in f.by_type('IfcSlab'):
                typ = get_type(slab)
                if (getattr(typ, 'PredefinedType', None) or slab.PredefinedType) != 'FLOOR': continue
                st = get_container(slab)
                if st: covered.add(st.Name)
            absent = [s for s in expected if s not in covered and not omissions.get(s)]
            if absent: finding('FLOOR_COVERAGE', 'No FLOOR slab assigned to declared levels: '+', '.join(absent[:10]))
        except (ValueError, TypeError): finding('INVALID_SCOPE', 'Floor coverage metadata could not be read.')
    loose = [e.GlobalId for e in f.by_type('IfcMember')+f.by_type('IfcPlate') if not e.Decomposes]
    if f.by_type('IfcCurtainWall') and loose:
        finding('FACADE_ASSEMBLIES', 'Review whether standalone plates/members belong to facade assemblies; unrelated members may remain standalone.', loose)
    return {'status': 'REVIEW' if findings else 'NO_FINDINGS', 'scope': scope,
            'findings': findings, 'note': 'Advisory BIM completeness, not architectural acceptance or LOD certification. Review element function and suspicious solid slabs using existing geometry.'}
