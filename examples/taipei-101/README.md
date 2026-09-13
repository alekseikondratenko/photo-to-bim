# Taipei 101

Plugin **0.8.3**. Runtime files match the repository revision recorded in
[publication metadata](example.json).

| Reference | Reconstruction |
| --- | --- |
| ![Reference](reference.jpg) | ![Reconstruction](comparison.png) |

[Download IFC](house.ifc) · [Assumptions and camera](reconstruction.json) ·
[Original validation report](validation.json) · [Publication metadata](example.json)

## Recorded evidence

- IFC: **PASS**.
- Fitted landmarks: **needs refinement**, RMS **4.09 px**, maximum **8.16 px**, tolerance **5 px**.
- Appearance: **PASS**.
- Fitted points: **14**; held-out landmarks: **0**; no silhouette mask.
  No independent photographic accuracy is established.
- Semantic model: **101 storeys**, **2,035 elements**, including **44 curtain walls**.

The run loaded the user-installed skill and used both Blender MCP and the
measurement MCP. It inspected envelope and detailed drafts, then evaluated the
final IFC-bound landmarks without a prolonged refinement loop. Hidden faces
continue the visible façade pattern; the lower podium and ground level are
inferred. Ground context is omitted. The camera is an appearance-fitting
approximation, not a recovered physical camera position.

These are the original run's reports, not newly scored results. Read the report
for visual-review limits and outstanding discrepancies. Dimensions and hidden
geometry are assumptions from one view. This is not a survey model.

## Files

The IFC and comparison render are final delivery snapshots. The style sidecar
retains Blender appearance metadata; ordinary IFC readers use the IFC itself.
`observations.json` and `landmarks.json` retain the annotations and IFC bindings
behind the reported fit. `example.json` records the source revision and published
file hashes without machine-specific configuration.

Intermediate renders, logs, scripts, local setup files and client configuration
are intentionally omitted. This is an inspectable output package, not a complete
replay environment. The IFC bytes and their hashes are unchanged.

## Image credit

Reference photograph: [Taipei 101 2009 amk-EditMylius](https://commons.wikimedia.org/wiki/File:Taipei_101_2009_amk-EditMylius.jpg), AngMoKio, edited by Mylius. [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/). The reference bytes are unchanged.

Reference images are separate from the repository's software license.
