# Photo to BIM measurement MCP

The plugin starts `dist/ifc-server.mjs` over stdio using Node.js 22+.
It ships prebuilt; end users do not need `npm install` or a build step.

The six tools are:

| Tool | Purpose |
| --- | --- |
| `classify_reference` | Inspect the input image and framing |
| `view_crop` | Inspect image regions |
| `trace_edges` | Measure reference edges |
| `calibrate_camera` | Fit a camera from supplied correspondences |
| `place_features` | Place features using camera/plane geometry |
| `compare_model` | Compare the model/render against retained evidence |

These tools measure and evaluate. The separate
[Blender MCP](https://github.com/ahujasid/blender-mcp) executes Blender Python, and
Bonsai authors the IFC. Install both servers using the
[client setup guide](../docs/installation.md).

The shared [skill](../skills/photo-to-ifc-building/SKILL.md) defines the modelling
workflow, optional diagnostics, delivery evidence and stopping policy. This
packaging update does not change those instructions or add scoring iterations.

[Source layout and developer tests](../docs/development.md) explain the retained
legacy Three.js server, which is not an entry point of the IFC plugin.
