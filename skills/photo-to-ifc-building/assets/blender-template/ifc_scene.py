"""Material-aware IFC import and non-mutating appearance checks for Bonsai."""
VERSION = "0.8.0"
import hashlib
import json
from pathlib import Path
import bpy
import numpy as np
import ifcopenshell


def read_registry(ifc_path):
    path = Path(ifc_path)
    registry_path = Path(str(path)+'.styles.json')
    if not registry_path.is_file():
        raise ValueError(f"Missing IFC style registry: {registry_path}")
    registry = json.loads(registry_path.read_text())
    if registry.get('schema_version') not in (1,2) or registry.get('ifc_sha256') != hashlib.sha256(path.read_bytes()).hexdigest():
        raise ValueError('Style registry schema or IFC hash mismatch; save the current IFC again')
    return registry


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


_GEOMETRY = None


def _geometry():
    global _GEOMETRY
    if _GEOMETRY is None:
        import types
        path = Path(__file__).with_name('geometry_cache.py')
        module = types.ModuleType('photo_geometry'); module.__file__ = str(path)
        exec(compile(path.read_text(), str(path), 'exec'), module.__dict__)
        if module.VERSION != VERSION: raise RuntimeError('Mixed geometry runtime versions')
        _GEOMETRY = module
    return _GEOMETRY


def _drain(generator):
    while True:
        try: next(generator)
        except StopIteration as result: return result.value


class ImportJob:
    """Incremental main-thread import; retain the job in bpy.app.driver_namespace.

    Each step yields between products, not during a single kernel operation.
    Partial collections remain inspectable on cancellation/error, never complete.
    """
    def __init__(self, ifc_path, scene, collection_name):
        from bonsai.tool import Ifc
        from bonsai.bim.ifc import IfcStore
        self.path = str(Path(ifc_path).resolve())
        read_registry(self.path)
        self.snapshot = _geometry().snapshot(self.path)
        self.scene = scene or bpy.context.scene
        self.collection = bpy.data.collections.new(collection_name)
        self.scene.collection.children.link(self.collection)
        IfcStore.id_map = {}; IfcStore.guid_map = {}
        self.file = ifcopenshell.open(self.path)  # Bonsai edits must not mutate the export snapshot.
        Ifc.set(self.file)
        self.spatial, self.meshes = {}, {}
        f = self.file
        for el in f.by_type('IfcProject')+f.by_type('IfcSite')+f.by_type('IfcBuilding')+f.by_type('IfcBuildingStorey'):
            rels = getattr(el, 'Decomposes', ())
            parent = rels[0].RelatingObject if rels else None
            co = bpy.data.collections.new(el.is_a()+'/'+(el.Name or el.GlobalId))
            self.spatial.get(parent.id() if parent else None, self.collection).children.link(co)
            self.spatial[el.id()] = co
            ob = bpy.data.objects.new(el.is_a()+'/'+(el.Name or el.GlobalId), None)
            co.objects.link(ob); Ifc.link(el, ob); ob['ptb.global_id'] = el.GlobalId
        self.elements = [el for el in f.by_type('IfcElement') if not el.is_a('IfcOpeningElement')]
        self.imported = self.checked = 0
        self.phase, self.error, self.result = 'importing', None, None
        self.iterator = self.snapshot.iter_records([self.snapshot.file.by_guid(el.GlobalId) for el in self.elements])
        self.scene.unit_settings.system = 'METRIC'; self.scene.unit_settings.scale_length = 1
        self.scene.BIMProperties.ifc_file = self.path

    def status(self):
        return {'status': self.phase, 'imported': self.imported, 'checked': self.checked,
                'total': len(self.elements), 'collection': self.collection.name,
                'error': self.error, 'result': self.result}

    def cancel(self):
        if self.phase in ('importing', 'checking'):
            self.phase = 'cancelled'; self.iterator = None
        return self.status()

    def step(self, max_elements=100, max_seconds=.25):
        import time
        from mathutils import Matrix
        from bonsai.tool import Ifc
        from ifcopenshell.util.element import get_container
        if max_elements < 1 or max_seconds <= 0: raise ValueError('Positive batch limits required')
        if self.phase not in ('importing', 'checking'): return self.status()
        start = time.monotonic()
        try:
            if _geometry().fingerprint(self.path, self.snapshot.settings) != self.snapshot.fingerprint:
                raise ValueError('IFC or style snapshot changed during import; start a new import')
            if Ifc.get() is not self.file:
                raise ValueError('Active Bonsai IFC changed during import')
            for _ in range(max_elements):
                try: item = next(self.iterator)
                except StopIteration as done:
                    if self.phase == 'importing':
                        self.phase = 'checking'
                        bpy.context.view_layer.update()
                        self.iterator = _appearance(self.path, list(self.collection.all_objects), self.snapshot)
                    else:
                        self.phase = 'complete'
                        self.result = {'collection': self.collection.name, 'objects': self.imported,
                                       'appearance': done.value, 'geometry_cache': self.snapshot.stats(),
                                       'unique_meshes': len(self.meshes)}
                        self.iterator = None
                    break
                if self.phase == 'checking':
                    self.checked += 1
                else:
                    guid, record = item
                    el = self.file.by_guid(guid); geometry = record.geometry
                    mesh = self.meshes.get(geometry.key)
                    if mesh is None:
                        mesh = bpy.data.meshes.new(el.Name or guid)
                        mesh.from_pydata(geometry.verts.tolist(), [], geometry.faces.tolist()); mesh.update()
                        self.meshes[geometry.key] = mesh
                        fresh = True
                    else: fresh = False
                    ob = bpy.data.objects.new(el.is_a()+'/'+(el.Name or guid), mesh)
                    st = get_container(el)
                    self.spatial.get(st.id() if st else None, self.collection).objects.link(ob)
                    ob.matrix_world = Matrix(record.matrix.tolist())
                    Ifc.link(el, ob); ob['ptb.global_id'] = guid
                    if fresh: _assign_materials(ob, geometry, self.snapshot.digest)
                    else: ob['ptb.ifc_sha256'] = self.snapshot.digest
                    self.imported += 1
                if time.monotonic()-start >= max_seconds: break
        except Exception as exc:
            self.phase, self.error, self.iterator = 'failed', str(exc), None
        return self.status()


def import_ifc(ifc_path, scene=None, collection_name='IFC Reconstruction', incremental=False):
    """Import into a new collection; preserve existing scenes and shader policy.

    Default is synchronous. incremental=True returns an ImportJob for bounded
    step() calls through the existing Blender MCP; it starts no background thread.
    """
    job = ImportJob(ifc_path, scene, collection_name)
    if incremental: return job
    while job.phase in ('importing', 'checking'): job.step()
    if job.phase != 'complete': raise RuntimeError(job.error or job.phase)
    return job.result


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


def _appearance(ifc_path, objects, snapshot):
    reg = read_registry(ifc_path)
    f = snapshot.file; found, unlinked, duplicates = _linked(objects)
    errors, overrides, precision_limits = [], [], []
    maximum_error = maximum_tolerance = 0.0
    expected = [el for el in f.by_type('IfcElement') if not el.is_a('IfcOpeningElement')]
    missing = [el.GlobalId for el in expected if el.GlobalId not in found]
    if missing or unlinked or duplicates: errors.append('Missing, duplicate or unlinked IFC objects')
    for el in expected:
        ob = found.get(el.GlobalId)
        if ob is None:
            yield None
            continue
        if ob.hide_render or any(mod.show_render for mod in ob.modifiers) or ob.data.shape_keys:
            errors.append(f'{el.GlobalId}: hidden object or unevaluated render geometry')
        record = snapshot.get(el); geo = record.geometry
        verts = _geometry().world_vertices(record)
        matrix = np.asarray(ob.matrix_world, dtype=float)
        local = np.asarray([tuple(v.co) for v in ob.data.vertices]).reshape(-1, 3)
        actual = local @ matrix[:3,:3].T + matrix[:3,3]
        comparison = _geometry().compare_vertices(actual, verts)
        maximum_error = max(maximum_error, comparison.get('max_error_m', 0))
        maximum_tolerance = max(maximum_tolerance, comparison.get('max_tolerance_m', 0))
        if comparison['status'] == 'FAIL':
            errors.append(f'{el.GlobalId}: scene geometry differs from exported IFC')
        elif comparison['status'] == 'INCOMPLETE':
            precision_limits.append(el.GlobalId)
        if [list(p.vertices) for p in ob.data.polygons] != geo.faces.tolist():
            errors.append(f'{el.GlobalId}: scene faces differ from exported IFC')
        expected_indices = [max(0,int(i)) for i in geo.material_ids]
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
        yield None
    if _geometry().fingerprint(ifc_path, snapshot.settings) != snapshot.fingerprint:
        errors.append('Export snapshot changed during appearance check; check the current export')
    return {'status':'FAIL' if errors else 'INCOMPLETE' if overrides or not expected or precision_limits else 'PASS',
            'linked_objects':len(found),'missing_guids':missing,'unlinked_objects':unlinked,
            'errors':errors,'material_overrides':overrides,
            'coordinate_precision': {'maximum_error_m': maximum_error, 'maximum_tolerance_m': maximum_tolerance,
                                     'precision_limited_guids': precision_limits, 'ceiling_m': 1e-4},
            'note':'Automated linkage/geometry/material checks, not visual acceptance or colour accuracy.'}


def check_appearance(ifc_path, objects=None):
    """Check current instances against immutable IFC geometry; preserve shaders."""
    try:
        read_registry(ifc_path)
        snapshot = _geometry().snapshot(ifc_path)
    except ValueError as exc:
        return {'status':'INCOMPLETE','reason':str(exc)}
    # Populate in one iterator so repeated representations share kernel work.
    try:
        list(snapshot.iter_records([el for el in snapshot.file.by_type('IfcElement') if not el.is_a('IfcOpeningElement')]))
        return _drain(_appearance(ifc_path, objects, snapshot))
    except Exception as exc:
        return {'status':'FAIL', 'errors':[str(exc)], 'note':'IFC geometry unavailable for appearance comparison'}


def apply_materials(ifc_path, objects=None):
    """Explicitly restore IFC item styles. Rendering never calls this implicitly."""
    reg = read_registry(ifc_path); snapshot = _geometry().snapshot(ifc_path); f = snapshot.file
    found,_,_ = _linked(objects)
    # Refuse stale/edited meshes instead of assigning face indices to different geometry.
    before = check_appearance(ifc_path, objects)
    structural_errors = [e for e in before.get('errors',[]) if 'geometry differs' in e or 'faces differ' in e or 'stale import' in e]
    if structural_errors: raise ValueError('; '.join(structural_errors))
    for guid,ob in found.items():
        try: el = f.by_guid(guid)
        except RuntimeError: continue
        _assign_materials(ob,snapshot.get(el).geometry,reg['ifc_sha256'])
    return check_appearance(ifc_path, objects)
