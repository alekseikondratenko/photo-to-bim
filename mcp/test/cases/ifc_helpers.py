"""The IFC helpers against real ifcopenshell: both shape classes, plus the
gate's designed failure on an unreplaced massing proxy. Runs wherever a python
with ifcopenshell is available (Bonsai's own, or `uv pip install ifcopenshell`);
the suite SKIPs it otherwise rather than failing."""
import sys, os, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..',
                                'skills', 'photo-to-ifc-building', 'assets', 'blender-template'))
os.chdir(tempfile.mkdtemp(prefix='ifc-helpers-test-'))
import ifc_helpers as H

# ---- Case 1: house-class subject (gable + cross-gable roof, L-footprint) ----
ctx = H.new_model('Test house', [('Ground', 0.0), ('Upper', 2.8)], building_name='House')
H.evidence_pset(ctx, {'Source': 'house.jpg', 'StoreyHeight_m': 2.8, 'RoofPitch_deg': 44.4})
m = H.massing(ctx, ctx['storeys']['Ground'], [(0,0),(10,0),(10,8),(4,8),(4,6),(0,6)], 5.5)  # L-shape (concave!)
H.style('render-white', (0.79, 0.77, 0.71))
H.style('glass', (0.45, 0.30, 0.14))
w1 = H.wall(ctx, ctx['storeys']['Ground'], (0,0), (10,0), 5.5, style_name='render-white')
w2 = H.wall(ctx, ctx['storeys']['Ground'], (10,0), (10,8), 5.5)
op = H.opening(ctx, w1, 2.0, 0.9, 1.2, 1.4)
win = H.fill(ctx, op, 'window', storey=ctx['storeys']['Ground'], style_name='glass')
dop = H.opening(ctx, w1, 6.0, 0.0, 1.0, 2.135)
H.fill(ctx, dop, 'door', storey=ctx['storeys']['Ground'])
H.slab(ctx, ctx['storeys']['Ground'], [(0,0),(10,0),(10,8),(0,8)], 0.2, 0.0)
H.roof(ctx, ctx['storeys']['Upper'], [
  [(0,-0.4,5.5),(10.4,-0.4,5.5),(10.4,4,7.9),(0,4,7.9)],
  [(0,8.4,5.5),(10.4,8.4,5.5),(10.4,4,7.9),(0,4,7.9)],
])
p = H.save(ctx, 'test_house.ifc')
rep = H.gate_report(p)
print('HOUSE gate:', rep['verdict'], '| schema', rep['schema'], '| geom', rep['geometry'], '| proxies', rep['proxies'], '| uncontained', rep['uncontained'])
print('  census:', {k:v for k,v in rep['census'].items() if v})

# proxies>0 expected (massing not replaced) -> gate must FAIL for that reason
assert rep['proxies'] == 1 and rep['verdict'] == 'FAIL', 'massing proxy must fail the gate'

# ---- Case 2: tower-class subject (the anti-overfit check) ----
ctx2 = H.new_model('Test tower', [(f'L{i:02d}', i*3.5) for i in range(8)], building_name='Tower')
core = [(0,0),(20,0),(20,20),(0,20)]
w = H.wall(ctx2, ctx2['storeys']['L00'], (0,0), (20,0), 28.0, thickness=0.5, name='South facade')
H.opening_grid(ctx2, w, rows=7, cols=5, width=2.4, height=2.0, sill0=1.0, storey_h=3.5, x0=1.6, gap=1.2,
               storey=ctx2['storeys']['L00'])
H.slab(ctx2, ctx2['storeys']['L07'], core, 0.3, 28.0, name='Cap', predefined='ROOF')
H.roof(ctx2, ctx2['storeys']['L07'], [[(0,0,28.3),(20,0,28.3),(20,20,28.3),(0,20,28.3)]], name='Flat cap')
p2 = H.save(ctx2, 'test_tower.ifc')
rep2 = H.gate_report(p2)
print('TOWER gate:', rep2['verdict'], '| schema', rep2['schema'], '| geom', rep2['geometry'], '| proxies', rep2['proxies'], '| uncontained', rep2['uncontained'])
print('  census:', {k:v for k,v in rep2['census'].items() if v})
assert rep2['verdict'] == 'PASS', 'tower model must pass the gate'
assert rep2['census']['IfcWindow'] == 35, 'grid should give 35 windows'
# 0.6.1: the fill must SPAN its opening (the 'alien slats' regression) and
# styles must reach the file.
import ifcopenshell, ifcopenshell.geom
f = ifcopenshell.open(p)
w = f.by_type('IfcWindow')[0]
settings = ifcopenshell.geom.settings()
sh = ifcopenshell.geom.create_shape(settings, w)
vs = sh.geometry.verts
xs = vs[0::3]; zs = vs[2::3]
w_extent = max(xs) - min(xs); h_extent = max(zs) - min(zs)
assert abs(w_extent - 1.2) < 0.05, f'window pane width {w_extent} != opening width 1.2'
assert abs(h_extent - 1.4) < 0.05, f'window pane height {h_extent} != opening height 1.4'
assert len(f.by_type('IfcSurfaceStyle')) >= 2, 'styles missing from the file'
print('fill spans opening:', round(w_extent,3), 'x', round(h_extent,3), '| styles:', len(f.by_type('IfcSurfaceStyle')))
print('ALL HELPER CHECKS PASS')
