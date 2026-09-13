#!/usr/bin/env python3
"""Check distributable metadata, paths, bundled tools and example integrity."""
import hashlib
import json
from pathlib import Path
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]


def read_json(path):
    return json.loads((ROOT / path).read_text())


def check():
    manifests = [read_json(p) for p in (
        'plugin.json', '.codex-plugin/plugin.json', '.claude-plugin/plugin.json')]
    assert len({m['name'] for m in manifests}) == 1, 'Plugin identifiers disagree'
    assert len({m['version'] for m in manifests}) == 1, 'Plugin versions disagree'
    catalog = read_json('.claude-plugin/marketplace.json')
    entry = catalog['plugins'][0]
    assert entry['name'] == manifests[0]['name'], 'Marketplace identity mismatch'
    assert entry['source'] == './' and entry['strict'] is True
    assert not ({'skills', 'mcpServers'} & entry.keys()), 'Duplicate component declarations'
    assert (ROOT / 'skills/photo-to-ifc-building/SKILL.md').is_file()
    assert manifests[0]['$schema'] == 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json'
    portable = read_json('mcp.json')
    assert portable.pop('$schema') == 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json'
    normalized = json.loads(json.dumps(portable).replace('${PLUGIN_ROOT}', '${CLAUDE_PLUGIN_ROOT}'))
    assert normalized == read_json('.mcp.json')
    servers = read_json('.mcp.json')['mcpServers']
    assert set(servers) == {'photo-to-bim'}, 'Do not bundle the external Blender bridge'
    server = servers['photo-to-bim']
    assert server['command'] == 'node' and server['type'] == 'stdio'
    assert server['args'] == ['${CLAUDE_PLUGIN_ROOT}/mcp/dist/ifc-server.mjs']
    assert (ROOT / 'mcp/dist/ifc-server.mjs').is_file()

    # Inspect the publishable tree, including new files before they are staged.
    names = subprocess.check_output(
        ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'],
        cwd=ROOT).decode().split('\0')
    for name in filter(None, names):
        path = ROOT / name
        if not path.is_file():
            continue
        content = path.read_bytes()
        assert not re.search(rb'/(?:Users|home)/[^/\s]+/', content), f'Personal path: {name}'
        assert not re.search(rb'[A-Za-z]:\\Users\\', content), f'Personal path: {name}'
        if path.suffix == '.md':
            for target in re.findall(r'\]\(([^)]+)\)', content.decode()):
                if re.match(r'[a-z]+:', target) or target.startswith('#'):
                    continue
                target = target.split('#', 1)[0]
                assert (path.parent / target).exists(), f'Broken link in {name}: {target}'

    for metadata in (ROOT / 'examples').glob('*/example.json'):
        example = json.loads(metadata.read_text())
        folder = metadata.parent
        for name, digest in example['files_sha256'].items():
            assert hashlib.sha256((folder / name).read_bytes()).hexdigest() == digest, name
        ifc_hash = hashlib.sha256((folder / 'house.ifc').read_bytes()).hexdigest()
        for name in ['house.ifc.styles.json', 'landmarks.json']:
            assert json.loads((folder / name).read_text())['ifc_sha256'] == ifc_hash, name
        if example['reference_included']:
            assert hashlib.sha256((folder / 'reference.jpg').read_bytes()).hexdigest() == example['reference_sha256']
    print('Package metadata, entry points, personal-path scan, links and example hashes: PASS')


if __name__ == '__main__':
    check()
