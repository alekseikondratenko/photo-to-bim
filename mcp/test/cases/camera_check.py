"""camera_check: the camera-vs-geometry verdict, against real field renders.

Positive: run-5's final render (the camera was never fixed; four geometry
passes were wasted against this exact signature). Negatives: identity, and a
synthetic single-band structural error (worst_segments territory). Skipped by
the suite when the field fixtures or PIL are unavailable.
"""
import sys, os, types
sys.modules['bpy'] = types.ModuleType('bpy')
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..',
                                'skills', 'photo-to-ifc-building', 'assets', 'blender-template'))
import numpy as np
from PIL import Image
import photostudio as P

REF = '/Users/alexbest/Desktop/blender-test-5/house.jpg'
REN = '/Users/alexbest/Desktop/blender-test-5/comparison.png'

ref = np.asarray(Image.open(REF).convert('RGB'), dtype=np.float32)
ren = P._resize_to(np.asarray(Image.open(REN).convert('RGB'), dtype=np.float32), ref.shape[1], ref.shape[0])
a, b = P._skyline(ref), P._skyline(ren)

c = P._camera_check(a, b, ref.shape[1], lo=560, hi=1420)
assert c is not None and c['verdict'] == 'camera_offset', 'run-5 misplaced camera must fire'

assert P._camera_check(a, a, ref.shape[1], lo=560, hi=1420) is None, 'identity must stay quiet'

b2 = a.copy()
mid = (a[900:1100] >= 0)
b2[900:1100][mid] = a[900:1100][mid] + 60
assert P._camera_check(a, b2, ref.shape[1], lo=560, hi=1420) is None, 'structural band must stay quiet'

print('ALL CAMERA-CHECK CASES PASS')
