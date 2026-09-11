"""Material-aware IFC import and non-mutating appearance checks for Bonsai."""
VERSION = "0.7.2"
import hashlib
import json
from pathlib import Path
import bpy
import numpy as np
import ifcopenshell
import ifcopenshell.geom as geom


def read_registry(ifc_path):
    path = Path(ifc_path)
    registry_path = Path(str(path)+'.styles.json')
    if not registry_path.is_file():
        raise ValueError(f"Missing IFC style registry: {registry_path}")
    registry = json.loads(registry_path.read_text())
    if registry.get('schema_version') not in (1,2) or registry.get('ifc_sha256') != hashlib.sha256(path.read_bytes()).hexdigest():
        raise ValueError('Style registry schema or IFC hash mismatch; save the current IFC again')
    return registry


def _settings():
    settings = geom.settings(); settings.set(settings.USE_WORLD_COORDS, True)
    return settings


def _shader_signature(mat):
    def value(v):
        if isinstance(v, (str, int, float, bool)): return v
        try: return list(v)
        except TypeError: return str(v)
    nodes = []
    if mat.use_nodes and mat.node_tree:
        for node in mat.node_tree.nodes:
            nodes.append((node.name, node.bl_idname, [(s.identifier, value(s.default_value))
                for s in node.inputs if hasattr(s, 'default_value')]))
        links = [(l.from_node.name,l.from_socket.identifier,l.to_node.name,l.to_socket.identifier) for l in mat.node_tree.links]
    else: links = []
    return hashlib.sha256(json.dumps([list(mat.diffuse_color),mat.use_nodes,nodes,links],sort_keys=True).encode()).hexdigest()


def _material(style, digest):
    style_id = style.instance_id()
    name = f'ptb-{digest[:12]}-style-{style_id}'
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    rgb = style.diffuse
    color = (rgb.r(),rgb.g(),rgb.b(),1)
    mat.diffuse_color = color; mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    if bsdf:
        bsdf.inputs['Base Color'].default_value = color
        bsdf.inputs['Roughness'].default_value = .65
        transparency = style.transparency
        if np.isfinite(transparency):
            bsdf.inputs['Alpha'].default_value = 1-transparency
    mat['ptb.style_id'] = style_id
    mat['ptb.shader_signature'] = _shader_signature(mat)
    return mat


def _assign_materials(ob, geometry, digest):
    # IFC tessellation supplies exact per-face style indices, including mapped items.
    ob.data.materials.clear()
    for style in geometry.materials:
        ob.data.materials.append(_material(style, digest))
    for face,index in zip(ob.data.polygons,geometry.material_ids):
        face.material_index = max(0,index)
    ob['ptb.ifc_sha256'] = digest


def import_ifc(ifc_path, scene=None, collection_name='IFC Reconstruction'):
    """Import a saved IFC into a NEW collection; do not clear existing scenes.
    Sets Bonsai's active IFC file. Callers with another active model must preserve
    that context or use a separate Blender session. Returned objects carry GlobalIds.
    """
    from bonsai.tool import Ifc
    from ifcopenshell.util.element import get_container
    registry = read_registry(ifc_path); digest = registry['ifc_sha256']
    f = ifcopenshell.open(str(ifc_path)); scene = scene or bpy.context.scene
    collection = bpy.data.collections.new(collection_name)
    scene.collection.children.link(collection)
    # Detach the lookup maps before linking another file: overlapping STEP IDs
    # must never unlink objects belonging to an existing scene.
    from bonsai.bim.ifc import IfcStore
    IfcStore.id_map = {}; IfcStore.guid_map = {}
    Ifc.set(f)
    spatial = {}
    entities = f.by_type('IfcProject')+f.by_type('IfcSite')+f.by_type('IfcBuilding')+f.by_type('IfcBuildingStorey')
    for el in entities:
        parent = el.Decomposes[0].RelatingObject if getattr(el,'Decomposes',()) else None
        co = bpy.data.collections.new(el.is_a()+'/'+(el.Name or el.GlobalId))
        spatial.get(parent.id() if parent else None, collection).children.link(co)
        spatial[el.id()] = co
        ob = bpy.data.objects.new(el.is_a()+'/'+(el.Name or el.GlobalId),None); co.objects.link(ob)
        Ifc.link(el,ob); ob['ptb.global_id'] = el.GlobalId
    count = 0
    for el in f.by_type('IfcElement'):
        if el.is_a('IfcOpeningElement'): continue
        shape = geom.create_shape(_settings(),el); geometry = shape.geometry
        mesh = bpy.data.meshes.new(el.Name or el.GlobalId)
        mesh.from_pydata(np.asarray(geometry.verts).reshape(-1,3).tolist(),[],np.asarray(geometry.faces).reshape(-1,3).tolist()); mesh.update()
        ob = bpy.data.objects.new(el.is_a()+'/'+(el.Name or el.GlobalId),mesh)
        st = get_container(el); spatial.get(st.id() if st else None,collection).objects.link(ob)
        Ifc.link(el,ob); ob['ptb.global_id'] = el.GlobalId
        _assign_materials(ob,geometry,digest); count += 1
    scene.unit_settings.system = 'METRIC'; scene.unit_settings.scale_length = 1
    scene.BIMProperties.ifc_file = str(Path(ifc_path).resolve())
    report = check_appearance(ifc_path, objects=list(collection.all_objects))
    return {'collection':collection.name,'objects':count,'appearance':report}


def _objects(objects):
    return list(bpy.context.scene.objects) if objects is None else list(objects)


def _linked(objects):
    from bonsai.tool import Ifc
    found,unlinked,duplicates = {},[],[]
    for ob in _objects(objects):
        if ob.type != 'MESH': continue
        el = Ifc.get_entity(ob)
        guid = ob.get('ptb.global_id')
        if el and el.is_a('IfcElement') and not el.is_a('IfcOpeningElement'):
            if guid and guid != el.GlobalId: unlinked.append(ob.name); continue
            if el.GlobalId in found: duplicates.append(el.GlobalId)
            found[el.GlobalId] = ob
        elif guid or ob.name.startswith('Ifc'):
            unlinked.append(ob.name)
    return found,unlinked,duplicates


def check_appearance(ifc_path, objects=None):
    """Read-only checks of IFC linkage, current geometry and material assignments.
    Custom shader overrides are retained and reported for visual review.
    """
    try:
        reg = read_registry(ifc_path)
    except ValueError as exc:
        return {'status':'INCOMPLETE','reason':str(exc)}
    f = ifcopenshell.open(str(ifc_path)); found,unlinked,duplicates = _linked(objects)
    errors,overrides = [],[]
    expected = [el for el in f.by_type('IfcElement') if not el.is_a('IfcOpeningElement')]
    missing = [el.GlobalId for el in expected if el.GlobalId not in found]
    if missing or unlinked or duplicates: errors.append('Missing, duplicate or unlinked IFC objects')
    for el in expected:
        ob = found.get(el.GlobalId)
        if ob is None: continue
        if ob.hide_render or any(mod.show_render for mod in ob.modifiers) or ob.data.shape_keys:
            errors.append(f'{el.GlobalId}: hidden object or unevaluated render geometry')
        shape = geom.create_shape(_settings(),el); geo = shape.geometry
        verts = np.asarray(geo.verts).reshape(-1,3)
        actual = np.asarray([tuple(ob.matrix_world @ v.co) for v in ob.data.vertices])
        if actual.shape != verts.shape or not np.allclose(actual,verts,atol=1e-5,rtol=0):
            errors.append(f'{el.GlobalId}: scene geometry differs from exported IFC')
        faces = np.asarray(geo.faces).reshape(-1,3).tolist()
        if [list(p.vertices) for p in ob.data.polygons] != faces:
            errors.append(f'{el.GlobalId}: scene faces differ from exported IFC')
        expected_indices = [max(0,i) for i in geo.material_ids]
        if [p.material_index for p in ob.data.polygons] != expected_indices:
            errors.append(f'{el.GlobalId}: per-face material assignment changed')
        if len(ob.data.materials) != len(geo.materials) or any(m is None for m in ob.data.materials):
            errors.append(f'{el.GlobalId}: missing or unexpected material slots')
        else:
            for mat,style in zip(ob.data.materials,geo.materials):
                if mat.get('ptb.style_id') != style.instance_id() or mat.get('ptb.shader_signature') != _shader_signature(mat):
                    overrides.append({'global_id':el.GlobalId,'material':mat.name})
        if ob.get('ptb.ifc_sha256') != reg['ifc_sha256']:
            errors.append(f'{el.GlobalId}: stale import; reopen the final IFC')
    return {'status':'FAIL' if errors else 'INCOMPLETE' if overrides or not expected else 'PASS',
            'linked_objects':len(found),'missing_guids':missing,'unlinked_objects':unlinked,
            'errors':errors,'material_overrides':overrides,
            'note':'Automated linkage/geometry/material checks, not visual acceptance or colour accuracy.'}


def apply_materials(ifc_path, objects=None):
    """Explicitly restore IFC item styles. Rendering never calls this implicitly."""
    reg = read_registry(ifc_path); f = ifcopenshell.open(str(ifc_path))
    found,_,_ = _linked(objects)
    # Refuse stale/edited meshes instead of assigning face indices to different geometry.
    before = check_appearance(ifc_path, objects)
    structural_errors = [e for e in before.get('errors',[]) if 'geometry differs' in e or 'faces differ' in e or 'stale import' in e]
    if structural_errors: raise ValueError('; '.join(structural_errors))
    for guid,ob in found.items():
        try: el = f.by_guid(guid)
        except RuntimeError: continue
        shape = geom.create_shape(_settings(),el)
        _assign_materials(ob,shape.geometry,reg['ifc_sha256'])
    return check_appearance(ifc_path, objects)
