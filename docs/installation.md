# Installation

Install once for your user account, then use new working folders for new photos.
These instructions target **local Codex and Claude Code**. Claude Desktop has a
different configuration system; a Claude Code `.mcp.json` is not its setup file.

## Prerequisites

| Dependency | Used for | Install/check |
| --- | --- | --- |
| Blender + Bonsai | IFC authoring and rendering | [Blender download](https://www.blender.org/download/), [Bonsai installation](https://docs.bonsaibim.org/quickstart/installation.html) |
| Blender MCP add-on | Socket server inside Blender | [Official repository and addon.py](https://github.com/ahujasid/blender-mcp) |
| Codex or Claude Code | Local agent with plugin support | An installed, signed-in client supporting the commands below |
| Node.js 22+ | Bundled Photo to BIM measurement server | [Node.js](https://nodejs.org/en/download), `node --version` |
| uv, including uvx | Launches the separate Blender MCP package | [uv installation](https://docs.astral.sh/uv/getting-started/installation/), `uvx --version` |
| Python 3.10+ | Blender MCP bridge | `uv` can provision a compatible interpreter; [Python management](https://docs.astral.sh/uv/guides/install-python/) |
| Git | Fetches the GitHub marketplace | `git --version` |

Blender's own Python and Bonsai's IfcOpenShell run **inside Blender**. End users
do not need our development virtual environment, npm dependencies, or a separate
system IfcOpenShell installation. The measurement server is already bundled.

An agent helping with setup should inspect versions, install missing compatible
dependencies using their official instructions, and preserve existing working
versions and client settings. Installing a plugin does **not** itself install or
upgrade Node, uv, Blender, or add-ons. The user still completes any necessary
Blender UI steps. Do not update all dependencies merely because newer ones exist.

For the macOS/Linux shell commands below, run `command -v uvx` (or `which uvx`)
in your terminal and confirm it returns an absolute executable path. If it does
not, install uv or fix your terminal PATH first. The registration commands resolve
and store that path so Blender MCP does not depend on a GUI client's PATH matching
your terminal. Keep machine-specific paths in local configuration, not this repo;
if uv moves, update the registered path.

## Codex: install for all projects

Run in a terminal with the Codex CLI available:

```sh
codex plugin marketplace add alekseikondratenko/photo-to-bim
codex plugin add photo-to-ifc-building@photo-to-bim
```

Inspect existing Blender registration before adding it:

```sh
codex mcp get blender
```

If it is missing:

```sh
codex mcp add blender -- "$(command -v uvx)" blender-mcp
```

This registers Blender MCP in your user-level Codex configuration. The plugin
registers its own `photo-to-bim` measurement server. Restart the desktop app or
start a fresh CLI task so it loads the new plugin and tools. If `codex plugin` is
unavailable, update the Codex client using its normal installation method.

Check installation with:

```sh
codex plugin list
codex mcp get blender
```

[Official Codex plugin documentation](https://developers.openai.com/plugins/build/plugins)
and [MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## Claude Code: install for all projects

1. **Install the plugin for your user account:**

   ```sh
   claude plugin marketplace add alekseikondratenko/photo-to-bim
   claude plugin install photo-to-ifc-building@photo-to-bim --scope user
   ```

2. **Inspect the existing Blender bridge:**

   ```sh
   claude mcp get blender
   ```

   If it is missing, register it using the absolute `uvx` path checked above:

   ```sh
   claude mcp add --transport stdio --scope user blender -- "$(command -v uvx)" blender-mcp
   ```

3. **Restart Claude Code before your first reconstruction.** Exit and reopen the
   CLI, or restart the app if you use its Claude Code interface. In the new
   session, use `/plugin` to check the plugin and `/mcp` to check both servers.
   Accept any trust or tool-permission prompts your client requires. Recent
   versions also support `/reload-plugins`, but a fresh session is the simplest
   way to load both the plugin and the separately registered Blender bridge.

[Official Claude Code installation guide](https://code.claude.com/docs/en/discover-plugins)
and [MCP configuration](https://code.claude.com/docs/en/mcp).

## Verify once before modelling

Open Blender and confirm Bonsai and Blender MCP are enabled. The current Blender
MCP add-on starts its socket server automatically by default.
In a new task, ask:

> Verify Photo to BIM and Blender MCP are available. List the six measurement
> tools, check Blender's version and that Bonsai can be imported using a read-only
> Blender MCP call, and report any missing dependency. Do not modify the scene or
> start a reconstruction.

The expected measurement tools are `classify_reference`, `view_crop`,
`trace_edges`, `calibrate_camera`, `place_features`, and `compare_model`.
The separate Blender bridge must expose `execute_blender_code`. Seeing a server
listed does not prove all its tools are available or that Blender is connected.
Once this works, use the [short reconstruction prompt](../README.md#use-it).

## What connects to what?

```text
Codex / Claude Code
  ├─ stdio → node → Photo to BIM measurement server (this plugin)
  └─ stdio → uvx blender-mcp → TCP localhost:9876 → add-on inside Blender
                                                        └─ Bonsai / IfcOpenShell
```

The client starts both stdio processes. `uvx` downloads and caches the Blender MCP
package when needed. The Blender add-on listens on its configured port, normally
9876. Keep Blender open while the agent works. With the current add-on's default
auto-start enabled, its server starts when Blender opens; no manual connection
step is needed for each photograph.
Do not launch another stdio bridge manually in a terminal for the same client.

The add-on and this plugin are separate installations. This repository does not
bundle or silently install Blender MCP. Only the local client can reach a Blender
listener on that same machine; generic cloud sessions do not share its localhost.

## Troubleshooting

- **No tools after installation:** start a fresh session, check plugin enablement
  and client errors, and check that the client can find Node 22+ and `uvx`.
- **`node` or `uvx` not found in a desktop app:** its environment may differ from
  your terminal. Fix the app's PATH or configure an executable path appropriate
  to your machine. Do not copy someone else's absolute path.
- **Connection refused:** Blender must be open with the add-on's server running.
  If you use an older add-on, disabled auto-start, or stopped the server manually,
  press **N** in the 3D Viewport, open **BlenderMCP** / **MCP for Blender**, and
  click **Start MCP Server** or **Connect** (the label depends on the version).
  Enable **Auto-Start Server** if available. Check that bridge and add-on use the
  same host/port.
- **Bonsai import fails:** enable the compatible Bonsai release inside the Blender
  instance serving the connection.
- **Duplicate tools:** remove or disable an older Photo to BIM installation or
  per-project registration before testing a global install. Preserve unrelated
  MCP configuration.
- **No Allow Online Access button:** continue if extensions already work. That
  prompt concerns downloading extensions, not starting the localhost MCP server.

## Optional isolated development setup

Our numbered test folders used `scripts/setup_codex_project.py`, which copies a
frozen runtime, creates a local skill entry and Codex configuration, and writes
`SETUP.md`, `PROMPT.txt` and a hash manifest. That is useful for comparing versions;
it is **not required for everyday use** and does not install globally.
See [development instructions](development.md#isolated-project-tests).
