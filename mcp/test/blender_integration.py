"""Run through Blender MCP with Bonsai enabled. Preserves the existing scene/model.

exec(compile(Path(script).read_text(), script, 'exec'), namespace)
namespace['run'](repo_path, output_directory, node_path)

Output files stay in the supplied directory. This is a synthetic adapter test,
not a photographic reconstruction or downstream BIM interoperability test.
"""
from pathlib import Path
import hashlib
import json
import types


def run(repo, output, node):
    import bpy
    from mathutils import Vector, Matrix
    from bpy_extras.object_utils import world_to_camera_view
    from bonsai.bim.ifc import IfcStore
    from bonsai.tool import Ifc

    repo, output = Path(repo), Path(output)
    output.mkdir(parents=True, exist_ok=True)
    path = repo/'skills/photo-to-ifc-building/assets/blender-template/bootstrap.py'
    boot = types.ModuleType('integration_bootstrap'); boot.__file__ = str(path)
    exec(compile(path.read_text(), str(path), 'exec'), boot.__dict__)
    rt = boot.load(); H, S, P, V = (rt[k] for k in ('helpers','scene','studio','validation'))
    assert rt['version'] == '0.8.4-dev.2'
    original_scene = bpy.context.window.scene
    original_objects = {ob.name: (tuple(tuple(row) for row in ob.matrix_world), ob.BIMObjectProperties.ifc_definition_id)
                        for ob in original_scene.objects}
    groups = ('scenes','objects','collections','meshes','materials','cameras','lights','worlds','images')
    existing = {name:set(getattr(bpy.data,name)) for name in groups}
    fields = ('file','path','schema','id_map','guid_map','edited_objs','history','future','current_transaction','last_transaction','cache','cache_path')
    saved = {name:getattr(IfcStore,name) for name in fields}
    report = None
    try:
        IfcStore.id_map={}; IfcStore.guid_map={}; IfcStore.history=[]; IfcStore.future=[]; IfcStore.edited_objs=set()
        scene = bpy.data.scenes.new('PhotoToBIM 0.8.4-dev.2 integration')
        bpy.context.window.scene = scene
        ctx = H.new_model('Adapter fixture',[('Ground',0)])
        st=ctx['storeys']['Ground']
        for name,rgb in [('wall',(.7,.6,.5)),('roof',(.25,.2,.15)),('frame',(.8,.8,.7)),('glass',(.08,.18,.25))]:H.style(name,rgb)
        wall=H.profile_wall(ctx,st,(0,0),(8,0),[(0,0),(8,0),(8,3),(4,5),(0,3)],style_name='wall')
        window=H.framed_fill(ctx,H.opening(ctx,wall,1,.8,1.4,1.5),storey=st,crossbar_at=.6)
        H.framed_fill(ctx,H.opening(ctx,wall,5,0,1,2.1),kind='door',storey=st)
        slab=H.slab(ctx,st,[(0,0),(8,0),(8,5),(0,5)],style_name='wall')
        repeated=H.mapped_copy(ctx,slab,st,(0,0,443.123456789),'High repeated slab')
        H.mapped_copy(ctx,slab,st,(12,0,0),'Offset repeated slab')
        H.roof(ctx,st,[[(0,0,3),(4,0,5),(4,5,5),(0,5,3)],[(4,0,5),(8,0,3),(8,5,3),(4,5,5)]],style_name='roof')
        verts, faces = H.prism_mesh([(9,0),(11,0),(11,.1),(9,.1)],0,3)
        panel = H.element(ctx,'IfcPlate','Assembly panel',st,verts,faces,style_name='glass')
        facade = H.assembly(ctx,'IfcCurtainWall','Component facade',ctx['building'],[panel])
        ifc=H.save(ctx,output/'fixture.ifc')
        gate=H.gate_report(ifc,required_classes=('IfcWall','IfcRoof','IfcSlab','IfcWindow','IfcDoor'))
        assert gate['verdict']=='PASS',gate
        job=S.import_ifc(ifc,scene,incremental=True)
        steps=0
        while job.phase in ('importing','checking'):
            before_count=job.imported+job.checked
            progress=job.step(max_elements=2,max_seconds=.25)
            assert job.imported+job.checked-before_count<=2,progress
            steps+=1
            assert steps<100,progress
        assert job.phase=='complete',job.status()
        imported=job.result
        assert imported['appearance']['status']=='PASS', imported
        parent_object = Ifc.get_object(Ifc.get().by_guid(facade.GlobalId))
        panel_object = Ifc.get_object(Ifc.get().by_guid(panel.GlobalId))
        assert parent_object.type == 'EMPTY' and panel_object.type == 'MESH'
        assert parent_object.users_collection[0] == panel_object.users_collection[0]
        assert imported['unique_meshes']<imported['objects'],imported
        assert job.checked==job.imported==job.status()['total']
        cache=H._geometry().snapshot(ifc)
        assert Ifc.get() is not cache.file  # active authoring must not mutate cached export
        Ifc.get().by_guid(wall.GlobalId).Name='Live authoring edit'
        assert cache.file.by_guid(wall.GlobalId).Name!='Live authoring edit'
        Ifc.get().by_guid(wall.GlobalId).Name=wall.Name
        count=cache.stats()['tessellated_occurrences']
        assert S.check_appearance(ifc)['status']=='PASS'
        assert H.gate_report(ifc)['verdict']=='PASS'
        assert cache.stats()['tessellated_occurrences']==count
        high=next(ob for ob in scene.objects if ob.get('ptb.global_id')==repeated.GlobalId)
        original_matrix=high.matrix_world.copy()
        high.location.z+=.001
        bpy.context.view_layer.update()
        assert S.check_appearance(ifc)['status']=='FAIL'
        high.matrix_world=original_matrix; bpy.context.view_layer.update()
        assert S.check_appearance(ifc)['status']=='PASS'
        linked=[ob for ob in scene.objects if ob.get('ptb.global_id')==window.GlobalId][0]
        assert len(linked.data.materials)==2
        assert set(p.material_index for p in linked.data.polygons)=={0,1}
        picks={name:{'global_id':wall.GlobalId,'world':world} for name,world in
               [('left-base',[0,-.15,0]),('right-base',[8,-.15,0]),('left-eave',[0,-.15,3]),('right-eave',[8,-.15,3]),('ridge',[4,-.15,5])]}
        pack=H.capture_landmarks(ifc,picks)
        assert H.resolve_landmarks(ifc,pack)==pack['model_points']
        pack_path=output/'landmarks.json';pack_path.write_text(json.dumps(pack,indent=2))
        pos=Vector((-10,-16,9)); target=Vector((4,2,2))
        blender=(target-pos).to_track_quat('-Z','Y').to_matrix().to_4x4();blender.translation=pos
        frame={'schema_version':1,'convention':'Z_UP_RIGHT_HANDED','image_size':[320,240],'focal_px':320,
               'principal_point':[156,126],'world_from_camera':[list(row) for row in blender@Matrix.Diagonal((1,-1,-1,1))]}
        kwargs=dict(ifc_path=str(ifc),out_dir=str(output),node=node,evaluator=str(repo/'mcp/dist/ifc-server.mjs'))
        scene.render.engine='CYCLES';scene.cycles.samples=4
        setup=P.setup(frame,reference_path=str(output/'reference.png'),**kwargs)
        assert setup['appearance']['status']=='PASS',setup
        bpy.context.view_layer.update()
        reference=P.render_view('reference',percentage=100)['render']
        landmarks=[]
        for name,world in pack['model_points'].items():
            px=world_to_camera_view(scene,scene.camera,Vector(world))
            landmarks.append({'id':name,'pixel':[px.x*320,(1-px.y)*240],'role':'fit','used_for_fitting':True})
        observations=output/'observations.json'
        observations.write_text(json.dumps({'schema_version':1,'reference_sha256':hashlib.sha256(Path(reference).read_bytes()).hexdigest(),
                                            'image_size':[320,240],'landmarks':landmarks},indent=2))
        P.setup(frame,reference_path=reference,observations=str(observations),**kwargs)
        # Artist adjustment is kept and reported, including edits to a tagged shader.
        mat=linked.data.materials[0];mat.node_tree.nodes.get('Principled BSDF').inputs['Roughness'].default_value=.123
        before=S._shader_signature(mat); slots=[m.as_pointer() for m in linked.data.materials]
        assert S.check_appearance(ifc)['status']=='INCOMPLETE'
        result=P.render_and_score('comparison',landmark_pack=pack_path,tolerance_px=.01)
        assert result['photographic']['status']=='PASS',result
        assert result['photographic']['model_binding']['status']=='IFC_SNAPSHOT'
        assert result['appearance']['status']=='INCOMPLETE'
        assert S._shader_signature(mat)==before and [m.as_pointer() for m in linked.data.materials]==slots
        # Missing material and geometry edits are concrete failures.
        linked.data.polygons[0].material_index=1-linked.data.polygons[0].material_index
        assert S.check_appearance(ifc)['status']=='FAIL'
        S.apply_materials(ifc)
        assert S.check_appearance(ifc)['status']=='PASS'
        linked.data.vertices[0].co.x+=.1
        assert S.check_appearance(ifc)['status']=='FAIL'
        try:S.apply_materials(ifc)
        except ValueError:pass
        else:raise AssertionError('Edited geometry was not rejected')
        # Partial work is explicit; changed snapshots cannot finish an old import.
        cancelled=S.import_ifc(ifc,scene,incremental=True)
        cancelled.step(max_elements=1)
        assert cancelled.cancel()['status']=='cancelled'
        assert cancelled.step()['status']=='cancelled' and cancelled.result is None
        changed=S.import_ifc(ifc,scene,incremental=True)
        changed.step(max_elements=1)
        sidecar=Path(str(ifc)+'.styles.json'); saved_sidecar=sidecar.read_bytes()
        try:
            sidecar.write_bytes(saved_sidecar+b'\n')
            assert changed.step()['status']=='failed' and changed.result is None
        finally: sidecar.write_bytes(saved_sidecar)
        report=V.combine(gate,result['photographic'],result['appearance'])
        report['integration']={'status':'PASS','blender':bpy.app.version_string,'runtime':rt['version'],
            'checks':['IFC reopen and semantics','frame/glass face assignments','IFC-bound landmarks','Blender projection parity',
                      'render preserves custom shader','missing style and edited geometry fail',
                      'bounded incremental import and complete occurrence checks','shared meshes retain individual placements',
                      'high-coordinate roundoff passes but 1 mm placement edit fails','unchanged geometry reused across checks',
                      'mutable Bonsai file isolated from snapshot','cancelled or changed-snapshot import cannot complete'],
            'synthetic_fixture':True}
    finally:
        bpy.context.window.scene=original_scene
        if saved['file'] is not None:Ifc.set(saved['file'])
        for name,value in saved.items():setattr(IfcStore,name,value)
        for name in groups:
            datablocks=getattr(bpy.data,name)
            for item in list(datablocks):
                if item not in existing[name]:datablocks.remove(item,do_unlink=True)
        after={ob.name:(tuple(tuple(row) for row in ob.matrix_world),ob.BIMObjectProperties.ifc_definition_id) for ob in original_scene.objects}
        assert after==original_objects,'Original scene changed'
    report['integration']['original_scene_restored']=True
    (output/'validation.json').write_text(json.dumps(report,indent=2))
    return report['integration']
