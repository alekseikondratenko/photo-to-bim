"""Immutable export geometry, shared across import and checks within one bootstrap.

The IFC iterator owns representation reuse and opening evaluation. Never bypass
opening subtraction or guess that two occurrences have interchangeable geometry.
"""
VERSION = "0.8.1"
import hashlib
from pathlib import Path
from types import SimpleNamespace

import ifcopenshell
import ifcopenshell.geom as geom
from ifcopenshell.util.shape import get_shape_matrix
import numpy as np


def settings():
    result = geom.settings()
    result.set(result.USE_WORLD_COORDS, False)
    return result


def settings_key(value):
    values = []
    for name in sorted(value.setting_names()):
        try: item = value.get(name)
        except RuntimeError: item = None
        values.append((name, repr(item)))
    return tuple(values)


def _style(source):
    # Copy SWIG values before the iterator advances or its owner is released.
    rgb = (source.diffuse.r(), source.diffuse.g(), source.diffuse.b())
    sid, transparency = source.instance_id(), source.transparency
    return SimpleNamespace(instance_id=lambda: sid, transparency=transparency,
                           diffuse=SimpleNamespace(r=lambda: rgb[0], g=lambda: rgb[1], b=lambda: rgb[2]))


class Snapshot:
    def __init__(self, path, digest, options, fingerprint):
        self.path, self.digest = Path(path), digest
        self.file = ifcopenshell.open(str(path))
        if hashlib.sha256(self.path.read_bytes()).hexdigest() != digest:
            raise ValueError('IFC changed while opening geometry snapshot')
        self.settings, self.fingerprint = options, fingerprint
        self.records, self.geometries, self.errors = {}, {}, {}
        self.tessellated = 0

    def record(self, shape):
        source = shape.geometry
        verts = np.array(source.verts, dtype=float).reshape(-1, 3)
        faces = np.array(source.faces, dtype=np.int32).reshape(-1, 3)
        indices = np.array(source.material_ids, dtype=np.int32)
        styles = tuple(_style(s) for s in source.materials)
        style_values = [(s.instance_id(), s.diffuse.r(), s.diffuse.g(), s.diffuse.b(), s.transparency) for s in styles]
        key = hashlib.sha256(verts.tobytes()+faces.tobytes()+indices.tobytes()+repr(style_values).encode()).hexdigest()
        if key not in self.geometries:
            for value in (verts, faces, indices): value.setflags(write=False)
            self.geometries[key] = SimpleNamespace(verts=verts, faces=faces,
                material_ids=indices, materials=styles, key=key)
        matrix = np.array(get_shape_matrix(shape), dtype=float)
        matrix.setflags(write=False)
        record = SimpleNamespace(geometry=self.geometries[key], matrix=matrix)
        self.records[shape.guid] = record
        self.tessellated += 1
        return record

    def iter_records(self, elements):
        elements = list(elements)
        missing = [e for e in elements if e.GlobalId not in self.records and e.GlobalId not in self.errors]
        if missing:
            iterator = geom.iterator(self.settings, self.file, num_threads=1, include=missing)
            if iterator.initialize():
                while True:
                    shape = iterator.get()
                    record = self.record(shape)
                    yield shape.guid, record
                    if not iterator.next(): break
            # An iterator can silently omit invalid products. Never treat that as PASS.
            for el in missing:
                if el.GlobalId not in self.records:
                    self.errors[el.GlobalId] = 'No geometry returned by IFC iterator'
        pending_ids = {e.GlobalId for e in missing}
        for el in elements:
            if el.GlobalId in self.errors: raise ValueError(f'{el.GlobalId}: {self.errors[el.GlobalId]}')
            if el.GlobalId not in pending_ids: yield el.GlobalId, self.records[el.GlobalId]

    def get(self, el):
        guid = el.GlobalId
        if guid not in self.records:
            list(self.iter_records([self.file.by_guid(guid)]))
        if guid in self.errors: raise ValueError(self.errors[guid])
        return self.records[guid]

    def stats(self):
        return {'occurrences': len(self.records), 'unique_geometry': len(self.geometries),
                'tessellated_occurrences': self.tessellated}


_LAST = None


def fingerprint(path, options):
    path = Path(path).resolve()
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    registry = Path(str(path)+'.styles.json')
    style_digest = hashlib.sha256(registry.read_bytes()).hexdigest() if registry.exists() else None
    return (str(path), digest, style_digest, settings_key(options))


def snapshot(path, options=None):
    """Reuse exported geometry while IFC, sidecar, path and settings are unchanged.

    Retain only the latest snapshot here; a running import owns its own reference.
    Live in-memory IFC files deliberately bypass this cache.
    """
    global _LAST
    options = options or settings()
    if options.get(options.USE_WORLD_COORDS):
        raise ValueError('Geometry snapshot requires local coordinates for placement-aware reuse')
    key = fingerprint(path, options)
    if _LAST is None or _LAST.fingerprint != key:
        _LAST = Snapshot(key[0], key[1], options, key)
    return _LAST


def world_vertices(record):
    return record.geometry.verts @ record.matrix[:3, :3].T + record.matrix[:3, 3]


def compare_vertices(actual, expected):
    """Allow bounded float32 roundoff, never scale tolerance without a ceiling."""
    actual, expected = np.asarray(actual), np.asarray(expected)
    base, ceiling = 1e-5, 1e-4  # metres: 0.01 mm base; 0.1 mm precision ceiling
    if actual.shape != expected.shape or not np.isfinite(actual).all() or not np.isfinite(expected).all():
        return {'status': 'FAIL', 'reason': 'Shape mismatch or non-finite coordinates'}
    with np.errstate(over='ignore', invalid='ignore'):
        spacing = np.abs(np.spacing(np.abs(expected).astype(np.float32)).astype(float))
    allowances = np.maximum(base, 2*spacing)
    error = float(np.max(np.abs(actual-expected), initial=0))
    limit = float(np.max(allowances, initial=base))
    if not np.isfinite(limit) or limit > ceiling:
        status = 'FAIL' if error > ceiling else 'INCOMPLETE'
        return {'status': status, 'max_error_m': error, 'reason': 'Coordinate magnitude exceeds bounded Blender precision; use a local origin',
                'base_tolerance_m': base, 'precision_ceiling_m': ceiling}
    return {'status': 'PASS' if np.all(np.abs(actual-expected) <= allowances) else 'FAIL',
            'max_error_m': error, 'max_tolerance_m': limit, 'base_tolerance_m': base,
            'precision_ceiling_m': ceiling}
