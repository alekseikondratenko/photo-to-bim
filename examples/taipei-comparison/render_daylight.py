"""Run in Blender with SOURCE_FOLDER and OUTPUT_PATH supplied by the caller.

Render the existing Claude IFC and camera with Codex-style daylight. Preserve
the source IFC, its colours, geometry and the active Bonsai model. This creates
a separate presentation scene; it does not rebuild or re-export the building.
"""
import hashlib
import json
import math
from pathlib import Path

import bpy
import ifcopenshell
import ifcopenshell.geom
from mathutils import Matrix, Vector

source = Path(SOURCE_FOLDER)
output = Path(OUTPUT_PATH)
ifc_path = source / 'house.ifc'
camera = json.loads((source / 'work/camera_final.json').read_text())
digest = hashlib.sha256(ifc_path.read_bytes()).hexdigest()
scene = bpy.data.scenes.new('Taipei Claude - daylight presentation')
scene.unit_settings.system = 'METRIC'
scene.unit_settings.scale_length = 1
model = ifcopenshell.open(str(ifc_path))
settings = ifcopenshell.geom.settings()
settings.set(settings.USE_WORLD_COORDS, True)
elements = [e for e in model.by_type('IfcElement')
            if not e.is_a('IfcOpeningElement') and e.Representation]
iterator = ifcopenshell.geom.iterator(settings, model, 1, include=elements)
materials = {}
imported = set()
if not iterator.initialize():
    raise RuntimeError('No IFC geometry to render')
while True:
    shape = iterator.get()
    geo = shape.geometry
    mesh = bpy.data.meshes.new(shape.guid)
    mesh.from_pydata(list(zip(*[iter(geo.verts)] * 3)), [],
                     list(zip(*[iter(geo.faces)] * 3)))
    mesh.update()
    for style in geo.materials:
        key = style.instance_id()
        if key not in materials:
            rgb = style.diffuse
            mat = bpy.data.materials.new('Taipei presentation ' + str(key))
            mat.use_nodes = True
            mat.diffuse_color = (rgb.r(), rgb.g(), rgb.b(), 1)
            bsdf = mat.node_tree.nodes.get('Principled BSDF')
            bsdf.inputs['Base Color'].default_value = mat.diffuse_color
            bsdf.inputs['Roughness'].default_value = .65
            if math.isfinite(style.transparency):
                bsdf.inputs['Alpha'].default_value = 1 - style.transparency
            materials[key] = mat
        mesh.materials.append(materials[key])
    for polygon, index in zip(mesh.polygons, geo.material_ids):
        polygon.material_index = max(0, index)
    ob = bpy.data.objects.new(shape.name or shape.guid, mesh)
    ob['source_ifc_guid'] = shape.guid
    scene.collection.objects.link(ob)
    imported.add(shape.guid)
    if not iterator.next():
        break
missing = {e.GlobalId for e in elements} - imported
if missing:
    raise RuntimeError('IFC elements missing from presentation: ' + str(sorted(missing)))

data = bpy.data.cameras.new('Taipei original fitted camera')
ob = bpy.data.objects.new(data.name, data)
scene.collection.objects.link(ob)
ob.matrix_world = Matrix(camera['world_from_camera']) @ Matrix.Diagonal((1, -1, -1, 1))
w, h = camera['image_size']
cx, cy = camera['principal_point']
data.sensor_fit, data.sensor_width = 'HORIZONTAL', 36
data.lens = camera['focal_px'] * 36 / w
data.shift_x, data.shift_y = (w / 2 - cx) / w, (cy - h / 2) / w
data.clip_end = 20000
scene.camera = ob
scene.render.resolution_x, scene.render.resolution_y = w, h
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = 'PNG'
scene.render.film_transparent = False
scene.render.engine = 'CYCLES'
scene.cycles.samples = 32
scene.cycles.use_denoising = True
scene.view_settings.view_transform = 'Standard'
scene.view_settings.look = 'None'
scene.view_settings.exposure = 0
scene.view_settings.gamma = 1

# Same sky/ambient settings as the earlier Codex presentation. Rotate the sun
# around Z with the camera azimuth so the same image-side facade stays lit.
sun = bpy.data.lights.new('Taipei daylight', 'SUN')
sun.energy, sun.angle = 2.8, .03
light = bpy.data.objects.new(sun.name, sun)
scene.collection.objects.link(light)
azimuth = math.atan2(ob.location.y, ob.location.x) - math.atan2(-768.052, 644.165)
direction = Matrix.Rotation(azimuth, 3, 'Z') @ Vector((-1, .16, -.8))
light.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
world = bpy.data.worlds.new('Taipei blue sky')
world.use_nodes = True
scene.world = world
nt = world.node_tree
nt.nodes.clear()
out = nt.nodes.new('ShaderNodeOutputWorld')
mix = nt.nodes.new('ShaderNodeMixShader')
lp = nt.nodes.new('ShaderNodeLightPath')
ambient = nt.nodes.new('ShaderNodeBackground')
ambient.inputs['Color'].default_value = (.72, .80, .9, 1)
ambient.inputs['Strength'].default_value = .50
sky = nt.nodes.new('ShaderNodeBackground')
sky.inputs['Strength'].default_value = 1
tc = nt.nodes.new('ShaderNodeTexCoord')
sep = nt.nodes.new('ShaderNodeSeparateXYZ')
ramp = nt.nodes.new('ShaderNodeValToRGB')
ramp.color_ramp.elements[0].position = 0
ramp.color_ramp.elements[0].color = (.25, .55, .87, 1)
ramp.color_ramp.elements[1].position = .52
ramp.color_ramp.elements[1].color = (.085, .23, .52, 1)
neg = nt.nodes.new('ShaderNodeMath')
neg.operation = 'MULTIPLY'
neg.inputs[1].default_value = -1
nt.links.new(tc.outputs['Normal'], sep.inputs[0])
nt.links.new(sep.outputs['Z'], neg.inputs[0])
nt.links.new(neg.outputs[0], ramp.inputs[0])
nt.links.new(ramp.outputs['Color'], sky.inputs['Color'])
nt.links.new(lp.outputs['Is Camera Ray'], mix.inputs[0])
nt.links.new(ambient.outputs[0], mix.inputs[1])
nt.links.new(sky.outputs[0], mix.inputs[2])
nt.links.new(mix.outputs[0], out.inputs[0])
scene.render.filepath = str(output)
scene['source_ifc_sha256'] = digest
print({'scene': scene.name, 'imported': len(imported), 'output': str(output)})
bpy.ops.render.render(write_still=True, scene=scene.name)
