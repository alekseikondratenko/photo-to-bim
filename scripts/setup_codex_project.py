#!/usr/bin/env python3
"""Install a frozen skill + MCP runtime into one new Codex project, without global writes."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess

REPO = Path(__file__).resolve().parents[1]

def install(target, reference=None, node=None, blender_command=None, blender_args=None, disable_mcp=None):
    target = Path(target).expanduser().resolve()
    if target.exists() and any(target.iterdir()):
        raise ValueError(f"Destination must be new or empty: {target}. Use a new test folder to preserve previous runs.")
    node = str(Path(node or shutil.which('node') or '').resolve())
    if not Path(node).is_file():
        raise ValueError('Node is required; pass --node /absolute/path/to/node')
    subprocess.run([node, '--version'], check=True, capture_output=True)
    bundle = REPO / 'mcp/dist/ifc-server.mjs'
    if not bundle.is_file():
        raise ValueError('Missing server bundle; run npm run build:server in mcp/')
    if reference:
        reference = Path(reference).expanduser().resolve()
        if not reference.is_file(): raise ValueError('Reference image is missing')
    if blender_command:
        blender_command = shutil.which(blender_command) or str(Path(blender_command).expanduser().resolve())
        if not Path(blender_command).is_file(): raise ValueError('Blender MCP command is missing')
    if any(name in ('photo-to-bim','blender') for name in disable_mcp or []):
        raise ValueError('Cannot disable a server that this installer configures')
    version = json.loads((REPO / '.codex-plugin/plugin.json').read_text())['version']
    target.mkdir(parents=True, exist_ok=True)
    package = target / '.agents/plugins/photo-to-bim'
    package.mkdir(parents=True)
    for dirname in ('skills', '.codex-plugin'):
        shutil.copytree(REPO / dirname, package / dirname, ignore=shutil.ignore_patterns('__pycache__','*.pyc'))
    (package / 'mcp/dist').mkdir(parents=True)
    shutil.copy2(bundle, package / 'mcp/dist/ifc-server.mjs')
    for name in ('mcp.json','.mcp.json','plugin.json','LICENSE','NOTICE'):
        shutil.copy2(REPO / name, package / name)
    (package / 'runtime.json').write_text(json.dumps({'version':version,'node':node},indent=2)+'\n')
    skill = target / '.agents/skills/photo-to-ifc-building'
    skill.parent.mkdir(parents=True)
    # Symlink remains inside the test folder, so future repo edits cannot change the run.
    skill.symlink_to('../plugins/photo-to-bim/skills/photo-to-ifc-building', target_is_directory=True)
    quote = json.dumps  # TOML basic strings use compatible JSON escapes for these paths.
    config = f'''# Project-local runtime {version}; no user-level config was modified.
[mcp_servers.photo-to-bim]
command = {quote(node)}
args = [{quote(str(package / 'mcp/dist/ifc-server.mjs'))}]
enabled = true
startup_timeout_sec = 30
'''
    if blender_command:
        config += f'''\n[mcp_servers.blender]
command = {quote(blender_command)}
args = {quote(blender_args or ['blender-mcp'])}
enabled = true
startup_timeout_sec = 60
'''
    for name in disable_mcp or []:
        config += f'\n[mcp_servers.{quote(name)}]\nenabled = false\n'
    (target / '.codex').mkdir()
    (target / '.codex/config.toml').write_text(config)
    files = {str(p.relative_to(package)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(package.rglob('*')) if p.is_file()}
    try:
        commit = subprocess.check_output(['git','rev-parse','HEAD'],cwd=REPO,text=True).strip()
        dirty = bool(subprocess.check_output(['git','status','--porcelain'],cwd=REPO,text=True).strip())
    except subprocess.CalledProcessError:
        commit,dirty=None,None
    manifest = {'schema_version':1,'version':version,'source_commit':commit,'source_dirty':dirty,'files_sha256':files}
    (target / 'runtime-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
    if reference:
        shutil.copy2(reference,target / ('house'+reference.suffix.lower()))
    source = 'house'+reference.suffix.lower() if reference else 'the photograph in this folder'
    prompt = f'Create an IFC model of the building in {source} using Blender and Bonsai.\n'
    (target / 'PROMPT.txt').write_text(prompt)
    (target / 'SETUP.md').write_text(f'''# Photo to BIM test — {version}

Open **{target}** as a Codex project and start a fresh task there. Paste PROMPT.txt.
If Codex asks whether to trust this folder, trust it to enable project-local MCP settings.
Start Blender with Bonsai enabled and the existing Blender MCP server connected.
The authoring agent should load the local bootstrap before it edits the scene.
Check the actual task tool catalog once: calibrate_camera, place_features and
compare_model must be visible as well as the other three tools. Server startup
success alone does not prove schema exposure. If missing, inspect client errors
and restart after correcting setup; do not repeatedly probe during reconstruction.

The skill is in `.agents/skills/photo-to-ifc-building`; its symlink resolves entirely
inside this folder. `.codex/config.toml` registers the bundled measurement server.
This enables the plugin's components locally, rather than installing a global
marketplace entry. The installer does not alter user-level configuration; Codex project trust is a
separate, folder-specific setting.
An existing global Blender MCP remains inherited unless this setup explicitly
supplied a local Blender command. Earlier test folders are unaffected.\nLocally disabled inherited MCP servers: {', '.join(disable_mcp or []) or 'none'}.

`runtime-manifest.json` records version, source revision/dirty state and file hashes.
The copy is frozen: updating the source repo does not change this experiment.
Use a new empty folder to test another version. No reconstruction has been launched.

The intended six measurement tools are classify_reference, view_crop, trace_edges,
calibrate_camera, place_features and compare_model. Legacy score_render and
solve_camera are not part of this runtime. Other unrelated global tools may still
be present. If an older photo-to-bim marketplace plugin is globally installed,
disable it for this project before comparing runs to avoid duplicate tool sets.

For Claude Code, load this same frozen plugin for the session with:
`claude --plugin-dir {package}`
Configure Blender MCP in Claude Code separately; `.codex/config.toml` is Codex-only.
The shared skill has optional early diagnostics and no fixed reconstruction pass count.
''')
    subprocess.run(['git','init','-q',str(target)],check=True)
    return {'project':str(target),'version':version,'skill':str(skill),'config':str(target / '.codex/config.toml')}

if __name__ == '__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('target')
    parser.add_argument('--reference', help='Photo copied into the test folder as house.<extension>')
    parser.add_argument('--node')
    parser.add_argument('--blender-command', help='Optional existing Blender MCP executable, for example uvx')
    parser.add_argument('--disable-mcp', action='append', help='Disable an inherited MCP server only in this project; repeat for multiple names')
    parser.add_argument('--blender-arg', action='append', help='Repeat for Blender MCP arguments; defaults to blender-mcp')
    args=parser.parse_args()
    print(json.dumps(install(args.target,args.reference,args.node,args.blender_command,args.blender_arg,args.disable_mcp),indent=2))
