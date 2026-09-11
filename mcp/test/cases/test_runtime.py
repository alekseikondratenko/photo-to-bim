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
    assert first['version']=='0.7.2'
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
    result=setup.install(target,reference=image,node=shutil.which('node'))
    assert result['version']=='0.7.2'
    skill=target/'.agents/skills/photo-to-ifc-building'
    assert skill.is_symlink() and skill.resolve().is_relative_to(target)
    manifest=json.loads((target/'runtime-manifest.json').read_text())
    package=target/'.agents/plugins/photo-to-bim'
    for name,digest in manifest['files_sha256'].items():
        assert hashlib.sha256((package/name).read_bytes()).hexdigest()==digest
    assert (target/'house.jpg').read_bytes()==image.read_bytes()
    assert '$photo-to-bim:photo-to-ifc-building' in (target/'PROMPT.txt').read_text()
    assert str(package/'mcp/dist/ifc-server.mjs') in (target/'.codex/config.toml').read_text()
    with pytest.raises(ValueError,match='new or empty'):
        setup.install(target,node=shutil.which('node'))

def test_package_versions_and_mcp_entrypoints_agree():
    repo=TEMPLATE.parents[3]
    codex=json.loads((repo/'.codex-plugin/plugin.json').read_text())
    claude=json.loads((repo/'plugin.json').read_text())
    npm=json.loads((repo/'mcp/package.json').read_text())
    assert codex['version']==claude['version']==npm['version']=='0.7.2'
    assert json.loads((repo/'.mcp.json').read_text())==json.loads((repo/'mcp.json').read_text())
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
