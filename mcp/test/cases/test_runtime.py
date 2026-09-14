"""Release gates against real IFC plus adapter/bootstrap boundary regressions."""
import hashlib
import importlib.util
import json
from pathlib import Path
import sys
import types
from unittest.mock import patch

import ifcopenshell
import ifcopenshell.geom
import ifcopenshell.validate
import numpy as np
import pytest

TEMPLATE = Path(__file__).resolve().parents[3] / 'skills/photo-to-ifc-building/assets/blender-template'

def module(name):
    spec = importlib.util.spec_from_file_location(name, TEMPLATE / (name + '.py'))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

@pytest.fixture
def H():
    return module('ifc_helpers')

def model(H):
    ctx = H.new_model('Test', [('Ground', 0)])
    st = ctx['storeys']['Ground']
    H.style('stone', (.6,.5,.4))
    w = H.profile_wall(ctx, st, (0,0), (8,0), [(0,0),(8,0),(8,3),(4,5),(0,3)], style_name='stone')
    op = H.opening(ctx,w,2,.8,1.2,1.4)
    win = H.fill(ctx,op,storey=st,style_name='stone')
    H.slab(ctx,st,[(0,0),(8,0),(8,5),(0,5)])
    H.roof(ctx,st,[[(0,0,3),(8,0,3),(8,5,4),(0,5,4)]])
    return ctx, w, op, win

def test_complete_reopened_and_gable_geometry(H, tmp_path):
    ctx,w,op,win=model(H)
    path=H.save(ctx,tmp_path/'house.ifc')
    report=H.gate_report(path)
    assert report['verdict']=='PASS', report
    f=ifcopenshell.open(str(path))
    sh=ifcopenshell.geom.create_shape(ifcopenshell.geom.settings(),f.by_type('IfcWall')[0])
    xyz=np.asarray(sh.geometry.verts).reshape(-1,3)
    assert np.allclose(xyz.max(axis=0), [8,.15,5])
    assert win.OverallWidth==pytest.approx(1.2) and win.OverallHeight==1.4
    registry=json.loads(Path(str(path)+'.styles.json').read_text())
    assert win.GlobalId in registry['elements']
    assert registry['ifc_sha256']==hashlib.sha256(Path(path).read_bytes()).hexdigest()

def test_empty_and_missing_required_class_fail(H):
    empty=H.new_model('Empty',[('Ground',0)])
    assert H.gate_report(empty['f'])['verdict']=='FAIL'
    ctx,*_=model(H)
    assert H.gate_report(ctx['f'],required_classes=('IfcDoor',))['semantics']=='FAIL'

def test_missing_representation_and_dimensions_fail(H):
    ctx,w,op,win=model(H)
    win.Representation=None
    assert H.gate_report(ctx['f'])['geometry']=='FAIL'
    win.OverallWidth=None
    assert H.gate_report(ctx['f'])['semantics']=='FAIL'

def test_unavailable_schema_never_passes(H):
    ctx,*_=model(H)
    with patch('ifcopenshell.validate.validate', side_effect=RuntimeError('validator unavailable')):
        report=H.gate_report(ctx['f'])
    assert report['schema']=='UNAVAILABLE' and report['verdict']=='INCOMPLETE'

def test_geometry_failure_never_passes(H):
    ctx,*_=model(H)
    with patch('ifcopenshell.geom.create_shape', side_effect=RuntimeError('kernel failed')):
        assert H.gate_report(ctx['f'])['geometry']=='FAIL'

def test_wrong_parent_and_orphan_fill_fail(H):
    ctx,w,op,win=model(H)
    rel=op.HasFillings[0]
    ctx['f'].remove(rel)
    assert H.gate_report(ctx['f'])['semantics']=='FAIL'
    ctx['storeys']['Ground'].Decomposes[0].RelatingObject=ctx['site']
    assert any('spatial parent' in e for e in H.gate_report(ctx['f'])['semantic_errors'])

def test_proxy_exceptions_are_explicit_and_never_cover_massing(H):
    ctx,*_=model(H)
    v,f=H.prism_mesh([(0,0),(1,0),(1,1),(0,1)],0,1)
    el=H.element(ctx,'IfcBuildingElementProxy','Sculpture',ctx['storeys']['Ground'],v,f)
    assert H.gate_report(ctx['f'])['verdict']=='FAIL'
    assert H.gate_report(ctx['f'],proxy_exceptions={el.GlobalId:'Unclassified site sculpture requested by client'})['verdict']=='PASS'
    el.Name='MASSING-leftover'
    assert H.gate_report(ctx['f'],proxy_exceptions={el.GlobalId:'temporary'})['verdict']=='FAIL'

def test_grid_reuses_geometry_at_correct_positions(H):
    ctx=H.new_model('Grid',[('Ground',0)])
    st=ctx['storeys']['Ground']
    wall=H.wall(ctx,st,(0,0),(20,0),8)
    wins=H.opening_grid(ctx,wall,2,3,1.2,1.4,.8,3,1,2,storey=st)
    assert len(ctx['f'].by_type('IfcRepresentationMap'))==1
    assert len(ctx['f'].by_type('IfcMappedItem'))==5
    for i,win in enumerate(wins):
        settings=ifcopenshell.geom.settings();settings.set(settings.USE_WORLD_COORDS,True)
        sh=ifcopenshell.geom.create_shape(settings,win)
        xyz=np.asarray(sh.geometry.verts).reshape(-1,3)
        assert xyz[:,0].min()==pytest.approx(1+(i%3)*3.2)
        assert xyz[:,2].min()==pytest.approx(.8+(i//3)*3)
        assert np.ptp(xyz[:,0])==pytest.approx(1.2)

def test_new_model_clears_state_and_rejects_old_context(H,tmp_path):
    ctx,*_=model(H)
    H.new_model('Another',[('Ground',0)])
    assert not H._ELEMENT_STYLES and not H._STYLES and not H._OPENING_GEO
    with pytest.raises(ValueError,match='Inactive'):
        H.save(ctx,tmp_path/'wrong.ifc')

def test_bootstrap_ignores_stale_modules(monkeypatch):
    monkeypatch.setitem(sys.modules,'bpy',types.ModuleType('bpy'))
    monkeypatch.setitem(sys.modules,'mathutils',types.SimpleNamespace(Matrix=object))
    monkeypatch.setitem(sys.modules,'photostudio',types.SimpleNamespace(VERSION='0.6.0'))
    boot=module('bootstrap')
    first,second=boot.load(),boot.load()
    assert first['version']=='0.8.4-dev.2'
    assert first['studio'] is not second['studio']
    assert first['helpers'] is not second['helpers']
    assert 'ifc_path' in first['studio'].setup.__code__.co_varnames

def test_material_lookup_uses_ifc_path_not_render_directory(monkeypatch,tmp_path):
    monkeypatch.setitem(sys.modules,'bpy',types.ModuleType('bpy'))
    monkeypatch.setitem(sys.modules,'mathutils',types.SimpleNamespace(Matrix=object))
    P=module('photostudio')
    ifc=tmp_path/'house.ifc';ifc.write_text('ifc')
    work=tmp_path/'renders';work.mkdir()
    (work/'wrong.styles.json').write_text('{}')
    P._STATE.update(ifc=str(ifc),out_dir=str(work))
    assert P.check_appearance()['status']=='INCOMPLETE'
    with pytest.raises(ValueError,match='Missing'):
        P.ensure_materials()
    Path(str(ifc)+'.styles.json').write_text(json.dumps({'schema_version':1,'version':'0.7.0','ifc_sha256':'wrong'}))
    with pytest.raises(ValueError,match='hash mismatch'):
        P.ensure_materials()

def test_scoped_installer_is_frozen_and_refuses_overwrite(tmp_path):
    import shutil
    script=TEMPLATE.parents[3]/'scripts/setup_codex_project.py'
    spec=importlib.util.spec_from_file_location('setup_codex_project',script)
    setup=importlib.util.module_from_spec(spec);spec.loader.exec_module(setup)
    image=tmp_path/'source.jpg';image.write_bytes(b'test fixture')
    target=tmp_path/'test-project'
    result=setup.install(target,reference=image,node=shutil.which('node'),disable_plugin=['photo-to-ifc-building@photo-to-bim'])
    assert result['version']=='0.8.4-dev.2'
    skill=target/'.agents/skills/photo-to-ifc-building'
    assert skill.is_symlink() and skill.resolve().is_relative_to(target)
    manifest=json.loads((target/'runtime-manifest.json').read_text())
    package=target/'.agents/plugins/photo-to-bim'
    for name,digest in manifest['files_sha256'].items():
        assert hashlib.sha256((package/name).read_bytes()).hexdigest()==digest
    assert (target/'house.jpg').read_bytes()==image.read_bytes()
    assert (target/'house.jpg').name in (target/'PROMPT.txt').read_text()
    assert str(package/'mcp/dist/ifc-server.mjs') in (target/'.codex/config.toml').read_text()
    import tomllib
    config=tomllib.loads((target/'.codex/config.toml').read_text())
    assert config['plugins']['photo-to-ifc-building@photo-to-bim']['enabled'] is False
    assert config['mcp_servers']['photo-to-bim']['enabled'] is True
    with pytest.raises(ValueError,match='new or empty'):
        setup.install(target,node=shutil.which('node'))

def test_package_versions_and_mcp_entrypoints_agree():
    repo=TEMPLATE.parents[3]
    codex=json.loads((repo/'.codex-plugin/plugin.json').read_text())
    claude=json.loads((repo/'plugin.json').read_text())
    npm=json.loads((repo/'mcp/package.json').read_text())
    assert codex['version']==claude['version']==npm['version']=='0.8.4-dev.2'
    portable=json.loads((repo/'mcp.json').read_text())
    assert portable.pop('$schema')=='https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'
    normalized=json.loads(json.dumps(portable).replace('${PLUGIN_ROOT}','${CLAUDE_PLUGIN_ROOT}'))
    assert json.loads((repo/'.mcp.json').read_text())==normalized
    assert 'ifc-server.mjs' in (repo/'.mcp.json').read_text()

def test_framed_fill_item_styles_rotated_host_and_dimensions(H,tmp_path):
    ctx=H.new_model('Framed',[('Ground',0)])
    st=ctx['storeys']['Ground']
    H.style('frame',(.6,.5,.4));H.style('glass',(.1,.2,.3))
    wall=H.wall(ctx,st,(2,3),(8,11),4)
    win=H.framed_fill(ctx,H.opening(ctx,wall,2,.8,1.2,1.4),storey=st,crossbar_at=.55)
    door=H.framed_fill(ctx,H.opening(ctx,wall,5,0,1,2.1),kind='door',storey=st)
    path=H.save(ctx,tmp_path/'framed.ifc')
    assert H.gate_report(path,required_classes=('IfcWall','IfcWindow','IfcDoor'))['verdict']=='PASS'
    f=ifcopenshell.open(str(path));reg=json.loads(Path(str(path)+'.styles.json').read_text())
    assert reg['schema_version']==2
    for el in (win,door):
        saved=f.by_guid(el.GlobalId)
        assert saved.OverallWidth==el.OverallWidth and saved.OverallHeight==el.OverallHeight
        assert len(saved.FillsVoids)==1
        records=reg['item_styles'][el.GlobalId]
        assert len(records)==2
        assert records[0]['surface_style_ids']!=records[1]['surface_style_ids']
        sh=ifcopenshell.geom.create_shape(ifcopenshell.geom.settings(),saved)
        assert len(sh.geometry.materials)==2 and set(sh.geometry.material_ids)=={0,1}
        # Unequal-sized items tessellate without padding vertices.
        assert len(saved.Representation.Representations[0].Items[0].Coordinates.CoordList)>len(saved.Representation.Representations[0].Items[1].Coordinates.CoordList)
    with pytest.raises(ValueError,match='dimensions'):
        H.framed_fill(ctx,H.opening(ctx,wall,7,0,1,2),storey=st,frame_width=1)

def test_exported_landmark_snapshot_and_stale_geometry(H,tmp_path):
    ctx,w,*_=model(H);path=H.save(ctx,tmp_path/'model.ifc')
    snap=H.capture_landmarks(path,{'corner':{'global_id':w.GlobalId,'world':[0,-.15,0]}})
    assert H.resolve_landmarks(path,snap)==snap['model_points']
    snap['bindings']['corner']['geometry_sha256']='tampered'
    with pytest.raises(ValueError,match='geometry'): H.resolve_landmarks(path,snap)
    with pytest.raises(ValueError,match='snap tolerance'):
        H.capture_landmarks(path,{'bad':{'global_id':w.GlobalId,'world':[99,99,99]}})
    with Path(path).open('a') as out:out.write('\n')
    with pytest.raises(ValueError,match='Stale'): H.resolve_landmarks(path,snap)

def test_visual_acceptance_does_not_rewrite_automated_failure():
    V=module('validation')
    ifc={'verdict':'PASS'};photo={'status':'FAIL','landmarks':{'max_px':6.57}};appearance={'status':'INCOMPLETE'}
    user={'decision':'accepted','source':'user','reviewer':'test user','basis':'Satisfied with visible result'}
    report=V.combine(ifc,photo,appearance,user)
    assert report['acceptance']['status']=='accepted_with_deviations'
    assert report['photographic']==photo and report['appearance']==appearance
    assert V.combine(ifc,photo,appearance)['acceptance']['status']=='pending_user_review'
    assert V.combine(ifc,photo,appearance,{**user,'source':'agent'})['acceptance']['status']=='pending_user_review'
    assert V.combine({'verdict':'FAIL'},photo,appearance,user)['acceptance']['status']=='blocked'
    with pytest.raises(ValueError):V.combine(ifc,photo,appearance,{'decision':'accepted'})


def test_mapped_fill_registry_preserves_both_item_styles(H,tmp_path):
    ctx=H.new_model('Mapped styles',[('Ground',0)]);st=ctx['storeys']['Ground']
    H.style('frame',(.7,.7,.7));H.style('glass',(.1,.2,.3))
    wall=H.wall(ctx,st,(0,0),(8,0),3)
    win=H.framed_fill(ctx,H.opening(ctx,wall,1,.8,1.2,1.4),storey=st)
    duplicate=H.mapped_copy(ctx,win,st,(3,0,0),'Repeated window')
    op=H.opening(ctx,wall,4,.8,1.2,1.4)
    H._run('feature.add_filling',opening=op,element=duplicate)
    path=H.save(ctx,tmp_path/'mapped.ifc')
    reg=json.loads(Path(str(path)+'.styles.json').read_text())
    first=reg['item_styles'][win.GlobalId];second=reg['item_styles'][duplicate.GlobalId]
    assert [r['surface_style_ids'] for r in first]==[r['surface_style_ids'] for r in second]
    assert len(second)==2 and len(second[0]['item_path'])==3
    sh=ifcopenshell.geom.create_shape(ifcopenshell.geom.settings(),duplicate)
    assert len(sh.geometry.materials)==2 and set(sh.geometry.material_ids)=={0,1}
    assert H.gate_report(path,required_classes=('IfcWall','IfcWindow'))['verdict']=='PASS'


def test_geometry_snapshot_reuse_and_world_placement(H, tmp_path):
    G = H._geometry()
    ctx = H.new_model('Repeated', [('Ground', 0)])
    st = ctx['storeys']['Ground']
    H.style('stone', (.6, .5, .4))
    wall = H.wall(ctx, st, (0, 0), (20, 0), 450, style_name='stone')
    wins = H.opening_grid(ctx, wall, 2, 3, 1.2, 1.4, 441.123456, 3, 1, 2, storey=st)
    # An occurrence with a rotated local placement must keep its own transform.
    transform = np.eye(4); transform[:2, :2] = [[0, -1], [1, 0]]; transform[:3, 3] = [9, 8, 0]
    H._run('geometry.edit_object_placement', product=wins[-1], matrix=transform, is_si=True)
    path = H.save(ctx, tmp_path/'repeated.ifc')
    snap = G.snapshot(path)
    records = dict(snap.iter_records(snap.file.by_type('IfcElement')))
    settings = ifcopenshell.geom.settings(); settings.set(settings.USE_WORLD_COORDS, True)
    for el in snap.file.by_type('IfcElement'):
        shape = ifcopenshell.geom.create_shape(settings, el)
        assert np.allclose(G.world_vertices(records[el.GlobalId]), np.asarray(shape.geometry.verts).reshape(-1, 3), rtol=0, atol=1e-9)
        assert records[el.GlobalId].geometry.faces.tolist() == np.asarray(shape.geometry.faces).reshape(-1, 3).tolist()
    assert len({records[w.GlobalId].geometry.key for w in wins}) <= 2  # direct prototype and mapped repeats
    before = snap.stats()
    with patch('ifcopenshell.geom.iterator', side_effect=AssertionError('unchanged geometry recalculated')):
        gate = H.gate_report(path, required_classes=('IfcWall','IfcWindow'))
        assert gate['verdict'] == 'PASS', gate
    assert G.snapshot(path) is snap and snap.stats() == before
    with pytest.raises(ValueError): records[wall.GlobalId].geometry.verts[0, 0] += 1


def test_geometry_snapshot_invalidation(H, tmp_path):
    G = H._geometry(); ctx, wall, *_ = model(H)
    path = H.save(ctx, tmp_path/'snapshot.ifc'); first = G.snapshot(path)
    assert G.snapshot(path) is first
    options = G.settings(); options.set('mesher-linear-deflection', .002)
    assert G.snapshot(path, options) is not first
    first = G.snapshot(path)
    registry = Path(str(path)+'.styles.json'); registry.write_text(registry.read_text()+'\n')
    second = G.snapshot(path); assert second is not first
    # Representation, placement, and style changes all invalidate the exported snapshot.
    for mutate in (
        lambda: setattr(wall.Representation.Representations[0].Items[0].Coordinates, 'CoordList', [(x+1, y, z) for x, y, z in wall.Representation.Representations[0].Items[0].Coordinates.CoordList]),
        lambda: H._run('geometry.edit_object_placement', product=wall, matrix=np.diag([1., 1., 1., 1.]), is_si=True),
        lambda: setattr(ctx['f'].by_type('IfcColourRgb')[0], 'Red', .23),
    ):
        previous = G.snapshot(path); mutate(); H.save(ctx, path)
        assert G.snapshot(path) is not previous


def test_geometry_snapshot_different_voids_and_styles(H, tmp_path):
    ctx = H.new_model('Variants', [('Ground', 0)]); st = ctx['storeys']['Ground']
    H.style('a', (.6,.5,.4)); H.style('b', (.1,.2,.3))
    walls = [H.wall(ctx, st, (0, 0), (8, 0), 3, style_name=style) for style in ('a', 'a', 'b')]
    H.opening(ctx, walls[0], 1, .8, 1.2, 1.4)
    H.opening(ctx, walls[1], 4, .8, 1.2, 1.4)
    path = H.save(ctx, tmp_path/'voids.ifc'); snap = H._geometry().snapshot(path)
    records = dict(snap.iter_records([snap.file.by_guid(w.GlobalId) for w in walls]))
    assert len({r.geometry.key for r in records.values()}) == 3


def test_export_iterator_omission_is_not_pass(H, tmp_path):
    ctx, wall, *_ = model(H); path = H.save(ctx, tmp_path/'invalid.ifc')
    with patch('ifcopenshell.geom.iterator') as iterator, patch('ifcopenshell.geom.create_shape', side_effect=RuntimeError('invalid geometry')):
        iterator.return_value.initialize.return_value = False
        report = H.gate_report(path)
    assert report['geometry'] == report['verdict'] == 'FAIL'
    assert report['geometry_checked'] == 0


def test_precision_roundoff_real_edits_and_bounded_coordinates():
    G = module('geometry_cache')
    expected = np.array([[.123456789, 3.14, 443.123456789]])
    rounded = expected.astype(np.float32).astype(float)
    assert np.max(abs(rounded-expected)) > 1e-5  # old tolerance falsely failed
    assert G.compare_vertices(rounded, expected)['status'] == 'PASS'
    moved = rounded.copy(); moved[0, 2] += .001
    assert G.compare_vertices(moved, expected)['status'] == 'FAIL'
    near_origin = np.zeros((1, 3)); displaced = near_origin + .00002
    assert G.compare_vertices(displaced, near_origin)['status'] == 'FAIL'
    huge = np.array([[1e6, 0, 0]])
    assert G.compare_vertices(huge, huge)['status'] == 'INCOMPLETE'
    assert G.compare_vertices(huge+.001, huge)['status'] == 'FAIL'
    assert G.compare_vertices([[float('nan'), 0, 0]], near_origin)['status'] == 'FAIL'
    assert G.compare_vertices(np.zeros((2, 3)), near_origin)['status'] == 'FAIL'


def test_nested_scaled_mappings_keep_geometry_and_styles(H, tmp_path):
    ctx = H.new_model('Nested mappings', [('Ground', 0)]); st = ctx['storeys']['Ground']
    H.style('red', (.8,.1,.1)); H.style('blue', (.1,.1,.8))
    sources = [H.slab(ctx, st, [(0,0),(2,0),(2,1),(0,1)], style_name=style) for style in ('red','blue')]
    copies = [H.mapped_copy(ctx, source, st, (6,2,10)) for source in sources]
    for el in copies:
        representation = el.Representation.Representations[0]
        inner = representation.Items[0]
        inner.MappingTarget = ctx['f'].create_entity('IfcCartesianTransformationOperator3DnonUniform',
            LocalOrigin=ctx['f'].create_entity('IfcCartesianPoint', Coordinates=(0.,0.,0.)),
            Scale=2., Scale2=3., Scale3=.5)
        nested = H._run('geometry.map_representation', representation=representation)
        el.Representation.Representations = (nested,)
    path = H.save(ctx, tmp_path/'nested.ifc'); G = H._geometry(); snap = G.snapshot(path)
    records = dict(snap.iter_records(snap.file.by_type('IfcElement')))
    settings = ifcopenshell.geom.settings(); settings.set(settings.USE_WORLD_COORDS, True)
    for el in snap.file.by_type('IfcElement'):
        shape = ifcopenshell.geom.create_shape(settings, el)
        record = records[el.GlobalId]
        assert np.allclose(G.world_vertices(record), np.array(shape.geometry.verts).reshape(-1,3), rtol=0, atol=1e-9)
        assert record.geometry.material_ids.tolist() == list(shape.geometry.material_ids)
    red, blue = (records[e.GlobalId].geometry for e in copies)
    assert np.array_equal(red.verts, blue.verts)
    assert red.key != blue.key  # identical geometry with different styles cannot share Blender slots


def test_documented_bootstrap_survives_fresh_mcp_namespaces(monkeypatch):
    import re
    bpy_stub = types.ModuleType('bpy')
    bpy_stub.app = types.SimpleNamespace(driver_namespace={})
    monkeypatch.setitem(sys.modules, 'bpy', bpy_stub)
    monkeypatch.setitem(sys.modules, 'mathutils', types.SimpleNamespace(Matrix=object))
    reference = TEMPLATE.parents[1]/'references/runtime.md'
    snippets = re.findall(r'```python\n(.*?)\n```', reference.read_text(), re.S)
    startup = snippets[0].replace('/absolute/path/to/skill/assets/blender-template/bootstrap.py', str(TEMPLATE/'bootstrap.py'))
    exec(startup, {})  # First MCP call has its own globals.
    later = {}
    exec(snippets[1], later)  # Next call does not inherit the first call's variables.
    state = later['state']
    exec("ctx = H.new_model('Persistent fixture', [('Ground', 0)])", state)
    original_file = state['ctx']['f']
    third = {}
    exec(snippets[1], third)
    exec("wall = H.wall(ctx, ctx['storeys']['Ground'], (0, 0), (4, 0), 3)", third['state'])
    assert third['state'] is state and state['ctx']['f'] is original_file
    assert original_file.by_type('IfcWall') == [state['wall']]


def test_repetition_preserves_semantics_without_copying_occurrence_evidence(H, tmp_path):
    from ifcopenshell.util.element import get_type, get_material, get_psets
    ctx, wall, opening, win = model(H)
    typ = H.assign_type(ctx, [win], 'W1 1200x1400', 'WINDOW')
    mat = H.assign_material(ctx, [win], 'Unspecified glazing')
    H.element_evidence(ctx, win, 'observed', 'Visible front opening')
    copy = H.mapped_copy(ctx, win, ctx['storeys']['Ground'], (3, 0, 0),
                         evidence={'status': 'inferred', 'basis': 'Rear continuation'})
    H.host_fill(ctx, H.opening(ctx, wall, 5, .8, 1.2, 1.4), copy)
    f = ifcopenshell.open(H.save(ctx, tmp_path/'copies.ifc'))
    a, b = [f.by_guid(e.GlobalId) for e in (win, copy)]
    assert a.GlobalId != b.GlobalId and get_type(a) == get_type(b)
    assert get_material(a) == get_material(b)
    assert get_psets(a)['Reconstruction_Element']['Status'] == 'observed'
    assert get_psets(b)['Reconstruction_Element']['Status'] == 'inferred'
    assert get_psets(a)['Qto_WindowBaseQuantities']['Width'] == get_psets(b)['Qto_WindowBaseQuantities']['Width']
    assert get_psets(a)['Reconstruction_Host']['OpeningGlobalId'] != get_psets(b)['Reconstruction_Host']['OpeningGlobalId']
    assert H.gate_report(f)['verdict'] == 'PASS'


def test_assembly_parent_has_no_body_and_children_supply_geometry(H, tmp_path):
    ctx = H.new_model('Facade', [('Ground', 0)])
    st = ctx['storeys']['Ground']
    verts, faces = H.prism_mesh([(0, 0), (4, 0), (4, .1), (0, .1)], 0, 3)
    panel = H.element(ctx, 'IfcPlate', 'Panel', st, verts, faces)
    parent = H.assembly(ctx, 'IfcCurtainWall', 'Facade', ctx['building'], [panel])
    path = H.save(ctx, tmp_path/'assembly.ifc')
    report = H.gate_report(path, required_classes=('IfcCurtainWall',))
    assert report['verdict'] == 'PASS', report
    assert report['geometry_checked'] == 1
    parent.Representation = panel.Representation
    assert H.gate_report(ctx['f'], required_classes=('IfcCurtainWall',))['semantics'] == 'FAIL'
    parent.Representation = None
    panel.Representation = None
    assert H.gate_report(ctx['f'], required_classes=('IfcCurtainWall',))['geometry'] == 'FAIL'


def test_opening_without_fill_and_free_window_are_valid_but_lost_host_fails(H):
    ctx, wall, opening, win = model(H)
    H.opening(ctx, wall, 5, .8, 1, 1)
    vertices, faces = H.prism_mesh([(0, 4), (1, 4), (1, 4.1), (0, 4.1)], 1, 2)
    free = H.element(ctx, 'IfcWindow', 'Freestanding window', ctx['storeys']['Ground'], vertices, faces)
    free.OverallWidth = free.OverallHeight = 1
    assert H.gate_report(ctx['f'])['verdict'] == 'PASS'
    ctx['f'].remove(opening.HasFillings[0])
    assert H.gate_report(ctx['f'])['semantics'] == 'FAIL'


def test_floor_scope_is_advisory_and_deep_solids_are_reviewed(H):
    ctx = H.new_model('Tower', [('Ground', 0), ('Upper', 4)])
    st = ctx['storeys']['Ground']
    H.slab(ctx, st, [(0, 0), (52, 0), (52, 52), (0, 52)], 2.5)
    H.declare_scope(ctx, 'exterior_only')
    report = H.gate_report(ctx['f'], required_classes=('IfcSlab',))
    codes = {x['code'] for x in report['bim_review']['findings']}
    assert report['verdict'] == 'PASS' and 'DEEP_FLOOR_SOLID' in codes
    assert 'FLOOR_COVERAGE' not in codes
    H.declare_scope(ctx, 'inferred_floorplates')
    assert 'FLOOR_COVERAGE' in {x['code'] for x in H.bim_review(ctx['f'])['findings']}
    H.declare_scope(ctx, 'inferred_floorplates', omissions={'Upper': 'Open multiheight space'})
    assert 'FLOOR_COVERAGE' not in {x['code'] for x in H.bim_review(ctx['f'])['findings']}


def test_default_copy_evidence_and_user_defined_identity(H):
    from ifcopenshell.util.element import get_pset
    ctx = H.new_model('Trim', [('Ground', 0)])
    st = ctx['storeys']['Ground']
    verts, faces = H.prism_mesh([(0, 0), (1, 0), (1, 1), (0, 1)], 0, 1)
    source = H.element(ctx, 'IfcMember', 'Trim', st, verts, faces, predefined_type='USERDEFINED')
    source.ObjectType = 'Decorative trim'
    H.element_evidence(ctx, source, 'observed', 'Front trim')
    duplicate = H.mapped_copy(ctx, source, st, (2, 0, 0))
    assert duplicate.ObjectType == source.ObjectType
    assert get_pset(duplicate, 'Reconstruction_Element', 'Status') == 'unknown'
    assert get_pset(source, 'Reconstruction_Element', 'Status') == 'observed'


def assert_express_valid(f):
    logger = ifcopenshell.validate.json_logger()
    ifcopenshell.validate.validate(f, logger, express_rules=True)
    assert not logger.statements, [(s.get('attribute'), s.get('message')) for s in logger.statements[:5]]


def test_placed_repetition_preserves_world_geometry_and_passes_express(H, tmp_path):
    from ifcopenshell.util.placement import get_local_placement
    ctx = H.new_model('Placed facade', [('Ground', 0), ('Upper', 4)])
    st = ctx['storeys']['Ground']
    H.style('glass', (.1, .3, .4))
    verts, faces = H.prism_mesh([(0,0),(2,0),(2,.1),(0,.1)], 0, 3)
    source = H.element(ctx, 'IfcPlate', 'Panel', st, verts, faces, style_name='glass')
    assert np.allclose(get_local_placement(source.ObjectPlacement), np.eye(4))
    transform = np.eye(4); transform[:2,:2] = [[0.,-1.],[1.,0.]]; transform[:3,3] = [9.,8.,4.]
    H._run('geometry.edit_object_placement', product=source, matrix=transform, is_si=True)
    H.assign_type(ctx, [source], 'Glazing panel')
    H.assign_material(ctx, [source], 'Assumed glass')
    a = H.mapped_copy(ctx, source, ctx['storeys']['Upper'], (3,0,0))
    b = H.mapped_copy(ctx, source, st, (6,0,0))
    c = H.mapped_copy(ctx, a, st, (0,5,0))
    H.assembly(ctx, 'IfcCurtainWall', 'Facade assembly', st, [source,a,b,c])
    path = H.save(ctx, tmp_path/'placed.ifc'); f = ifcopenshell.open(path)
    settings = ifcopenshell.geom.settings(); settings.set(settings.USE_WORLD_COORDS, True)
    def points(el):
        sh = ifcopenshell.geom.create_shape(settings, f.by_guid(el.GlobalId))
        return np.asarray(sh.geometry.verts).reshape(-1,3)
    original = points(source)
    for el, offset in [(a,[3,0,0]),(b,[6,0,0]),(c,[3,5,0])]:
        assert np.allclose(points(el), original + offset)
    assert len(f.by_type('IfcRepresentationMap')) == 2  # one shared source, one nested source
    report = H.gate_report(path, required_classes=('IfcCurtainWall',))
    assert report['verdict'] == 'PASS', report
    assert_express_valid(f)


def test_gate_rejects_missing_placement_and_conflicting_shape_ownership(H):
    ctx, wall, *_ = model(H)
    original = wall.ObjectPlacement; wall.ObjectPlacement = None
    report = H.gate_report(ctx['f'])
    assert report['schema'] == 'FAIL'
    assert any('PlacementForShapeRepresentation' in e for e in report['schema_errors'])
    wall.ObjectPlacement = original
    # Reproduce the old mapped_copy defect: give a direct product Body a second owner.
    rep = wall.Representation.Representations[0]
    mapped = H._run('geometry.map_representation', representation=rep)
    occurrence = H._run('root.create_entity', ifc_class='IfcWall', name='Bad repeat')
    H._run('geometry.assign_representation', product=occurrence, representation=mapped)
    H._run('geometry.edit_object_placement', product=occurrence, matrix=np.eye(4), is_si=True)
    H._run('spatial.assign_container', products=[occurrence], relating_structure=ctx['storeys']['Ground'])
    report = H.gate_report(ctx['f'])
    assert report['schema'] == 'FAIL'
    assert any('IfcShapeModel.WR11' in e for e in report['schema_errors'])


def test_house_floor_scope_and_hosted_repeats_pass_full_express(H, tmp_path):
    ctx = H.new_model('House', [('Ground',0),('Upper',3),('Roof',6)])
    ground, upper = ctx['storeys']['Ground'], ctx['storeys']['Upper']
    H.declare_scope(ctx, floor_storeys=['Ground','Upper'])
    for st in (ground,upper):
        el = H.slab(ctx, st, [(0,0),(8,0),(8,6),(0,6)], thickness=.2, z_top=st.Elevation)
        H.element_evidence(ctx, el, 'inferred', 'Assumed floorplate following the envelope')
    wall = H.wall(ctx, ground, (0,0), (8,0), 6)
    H.style('frame',(.6,.5,.4)); H.style('glass',(.1,.2,.3))
    source = H.framed_fill(ctx,H.opening(ctx,wall,1,.8,1.2,1.4),storey=ground)
    H.assign_type(ctx,[source],'Window 1200x1400','WINDOW')
    H.assign_material(ctx,[source],'Assumed window assembly')
    copied = H.mapped_copy(ctx,source,upper,(3,0,3))
    H.host_fill(ctx,H.opening(ctx,wall,4,3.8,1.2,1.4),copied)
    H.framed_fill(ctx,H.opening(ctx,wall,6,0,1,2.1),kind='door',storey=ground)
    H.roof(ctx,ctx['storeys']['Roof'],[[(0,0,6),(8,0,6),(8,6,7),(0,6,7)]])
    f = ifcopenshell.open(H.save(ctx,tmp_path/'house.ifc'))
    assert not any(x['code']=='FLOOR_COVERAGE' for x in H.bim_review(f)['findings'])
    assert H.gate_report(f)['verdict']=='PASS'
    assert_express_valid(f)
    f.by_type('IfcSlab')[1].PredefinedType = 'ROOF'
    assert any(x['code']=='FLOOR_COVERAGE' for x in H.bim_review(f)['findings'])
