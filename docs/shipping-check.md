# Shipping verification — 13 September 2026

The packaging in commit `c2c0fe2` was installed from the GitHub
`docs/public-installation` branch into fresh, isolated user-level configurations
for both clients. Normal user configuration was preserved. Existing account
authentication was reused only for the bounded prompt checks; credentials and raw
local logs are not published.

| Check | Result |
| --- | --- |
| Codex CLI 0.154.0-alpha.6.2: GitHub marketplace add and plugin install | PASS |
| Claude Code 2.1.260: GitHub marketplace add and user-scope plugin install | PASS |
| Client-visible skill discovery and loading | PASS in both |
| Six measurement tools exposed in the actual client sessions | PASS in both |
| One read-only `classify_reference` call | PASS in both |
| One read-only Blender MCP execution call | PASS in both |
| Blender/Bonsai environment | Blender 5.2.1 LTS; Bonsai import succeeded; IfcOpenShell 0.8.5 |
| Generic request resolves the hierarchy, metres, appropriate classes, photo matching, assumptions, repetition, outputs and stopping guidance | PASS in both |
| TypeScript typecheck and existing release suite | PASS, including 16 reliability groups and 24 Python tests |
| Package identities, entry points, personal-path scan, Markdown links and example hashes | PASS |
| All four example IFC files reopened with hierarchy and metre units | PASS |
| Skill, Blender helpers and measurement implementation/bundles compared with pre-packaging commit | Unchanged |

The prompt began with the normal short photo-to-IFC request and explicitly limited
execution to an installation smoke test. The clients read the installed skill,
reported its defaults and made the two read-only tool calls. They were not asked
to author, render or score a new building. No Blender scene edits were made.
For noninteractive verification, only the required tool calls were permitted in
the isolated test configuration; normal users can approve calls in their client.

## Packaging failures caught and fixed

- The Codex manifest name differed from the marketplace plugin name; installation
  failed before any modelling could start. Plugin identities now agree.
- Adding explicit Claude metadata exposed duplicate component declarations in the
  marketplace. The strict marketplace entry now delegates components to the plugin.
- Without portable schema declarations, Codex selected the legacy MCP configuration
  and passed the plugin-root placeholder literally to Node. The portable manifest
  and MCP file now declare their schemas and use the supported root syntax.

A direct launch of the bundled server passed even while the third issue prevented
Codex from exposing its tools. This is why the shipping check includes actual
client prompt/tool exposure, not just a package validator or server handshake.

## Scope

This verifies local installation and bounded use on the listed macOS client
versions. It does not establish Windows/Linux installation, older-client support,
cloud-to-desktop connectivity, a full new reconstruction result, or deterministic
replay of historical examples. GitHub CI separately exercises the source suite on
Ubuntu with Node 22 and Python 3.13.
