# Development and packaging

Everyday users install the [published plugin](installation.md); they do not need
a source checkout or a build step. This local experimental revision uses runtime 0.8.4-dev.3. It adds scope-aware
BIM review, semantic repetition and assembly-aware authoring/import. It is not
published; frozen project installations can be evaluated before a release.
The local update supplies explicit product placements, valid map-source ownership,
and cheap export checks for both. Full EXPRESS validation is exercised in release
regressions. Inferred floorplates are preferred when occupied levels are credible;
room layouts remain outside the default scope. Prism footprints accept either
winding while producing consistent outward faces, verified by signed-volume and
opening-subtraction regressions.

## What is in the repository?

| Path | Purpose |
| --- | --- |
| `plugin.json` | Portable plugin identity and metadata |
| `.codex-plugin/plugin.json` | Codex compatibility metadata and interface |
| `.claude-plugin/plugin.json` | Claude Code plugin metadata |
| `.claude-plugin/marketplace.json` | GitHub marketplace entry, also understood by Codex |
| `.mcp.json`, `mcp.json` | Claude/compatibility and portable MCP entry points; equivalent server, client-specific path syntax |
| `skills/photo-to-ifc-building/` | Shared skill, reference notes and Blender Python helpers |
| `mcp/dist/ifc-server.mjs` | Prebuilt measurement server used by the plugin |
| `mcp/ifc-*.ts`, `mcp/src/` | Server source and shared measurement modules |
| `scripts/setup_codex_project.py` | Optional frozen project setup used for development tests |
| `examples/` | Selected historical outputs, assumptions and validation evidence |
| `benchmarks/` | Optional controlled evaluation protocol, not a reconstruction requirement |

The marketplace and all manifests use the plugin identifier
`photo-to-ifc-building`; the marketplace is `photo-to-bim` and the measurement
server is named `photo-to-bim`. The marketplace points at the plugin root.
Client-specific manifests contain metadata, not a second copy of the skill.
`.mcp.json` belongs at the **root**, not inside `.claude-plugin/`.

The portable files declare their Agent Plugins `$schema`. Codex uses
`${PLUGIN_ROOT}` in `mcp.json`; Claude Code uses `${CLAUDE_PLUGIN_ROOT}` in
`.mcp.json`. Omitting the portable schema can make Codex select the legacy
configuration and pass a placeholder literally to Node, so testing only a direct
`node` launch is insufficient. The packaging check covers both entry points.

The repository retains the original Three.js server/UI sources and bundle
(`mcp/server.ts`, `mcp/main.ts`, `mcp/dist/server.mjs`, and associated frontend
files) for development history and existing tests. The IFC plugin does not start
that server. Several measurement modules are shared, so removing the entire
Three.js-related tree would also remove dependencies used by the IFC server.
The old field notes remain under [historical documentation](archive/field-evidence.md)
and are not current workflow instructions.

## Where the Python comes from

The maintained helpers in
[`skills/photo-to-ifc-building/assets/blender-template/`](../skills/photo-to-ifc-building/assets/blender-template/)
ship inside the plugin. They provide IFC authoring, geometry reuse, studio setup
and validation, and are loaded into Blender by the agent through Blender MCP.
They are ordinary source files in this repository, not a separate downloaded
modelling service.

The agent writes building-specific Python during each reconstruction: dimensions,
geometry, façade patterns, camera parameters and assumptions depend on the photo.
Those scripts are task outputs when saved; they are not prerequisites that users
must bring. IFC and comparison images are sufficient to inspect the result.
Exact reruns additionally need the run's scripts, source image, dependency versions
and original environment. The compact public examples are **delivery snapshots**,
not complete bit-for-bit replay packages.

## Source checks

For development, install Node 22+ and Python 3.13, then:

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements-test.txt
npm ci --prefix mcp
npm run typecheck --prefix mcp
npm test --prefix mcp
python3 scripts/check_package.py
```

On Windows use the virtual environment's `Scripts/python.exe`. The test runner
builds the server and exercises TypeScript measurements and Python IFC helpers.
CI uses Node 22 and Python 3.13. Committed server bundles must match source.
These checks do not require changing the user's Blender scene.

## Isolated project tests

From a source checkout:

```sh
python3 scripts/setup_codex_project.py ../my-photo-test --blender-command uvx
```

The destination must be new or empty. Add your own photo, open the folder as a
trusted Codex project, and start a fresh task. The copied runtime stays frozen
when the source repository changes. The generated hash manifest is for that test
installation and contains machine-specific paths in its companion setup files;
those files are not intended for publication.

This installer configures the project directly. A real global install must also
be tested independently through the marketplace, since copying components can
hide manifest or client-discovery failures.

When comparing a local experimental copy with a globally installed release, pass
`--disable-plugin photo-to-ifc-building@photo-to-bim` to disable that inherited
plugin only in the test project's configuration. Use its actual installation key
if your marketplace has a different name. Start a fresh trusted project session;
the global plugin and other projects are unchanged. The manifest records this
override alongside the copied runtime's revision and hashes.

## Shipping check

[Recorded shipping verification](shipping-check.md).

Test the GitHub revision in **fresh, isolated client configurations**, preserving
normal user settings. For each client:

1. Add the GitHub marketplace and install `photo-to-ifc-building@photo-to-bim`.
2. Register Blender MCP using the documented user-level command.
3. Inspect the installed manifest, skill and six measurement tools.
4. Use the [verification prompt](installation.md#verify-once-before-modelling) in
   a fresh task. Make a read-only Blender/Bonsai probe when Blender is available.
5. Check that a generic photo-to-IFC request discovers the skill and its default
   outputs, without asking the smoke test to build a new model.

Keep authentication out of the repository and test reports. Record the actual
client versions and any untested portion; an installation smoke test is not an
end-to-end reconstruction benchmark.
