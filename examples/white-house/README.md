# White House

Development test 19, plugin **0.8.2**, source revision `297f64e108e205bd1f176621f48b0922037580ed`.

| Reference | Reconstruction |
| --- | --- |
| ![Reference](reference.jpg) | ![Reconstruction](comparison.png) |

[Download IFC](house.ifc) · [Assumptions and camera](reconstruction.json) ·
[Original validation report](validation.json) · [Publication metadata](example.json)

## Recorded evidence

- IFC: **PASS**.
- Fitted landmarks: **PASS**, RMS **1.95 px**, maximum **3.33 px**, tolerance **5 px**.
- Appearance: **PASS**.
- Held-out landmarks: **0**. No independent photographic accuracy is established.

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

Reference photograph: [North Façade White House](https://commons.wikimedia.org/wiki/File:North_Fa%C3%A7ade_White_House.JPG), Nishkid64, with colour correction by Patrickneil. Released into the public domain. The reference bytes are unchanged.

Reference images are separate from the repository's software license.
