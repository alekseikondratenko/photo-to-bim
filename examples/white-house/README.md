# White House

| Reference | IFC reconstruction |
| --- | --- |
| ![Reference](reference.jpg) | ![Reconstruction](comparison.png) |

[Download IFC](house.ifc) · [Assumptions](reconstruction.json) · [Independent IFC review](review.json) · [Photographic evaluation](evaluation.json) · [File provenance](example.json)

Generated with **0.8.4-dev.3**. Two inferred occupied floorplates, 68 windows and one door, all with hosted openings. All 204 physical elements have types and material associations. Every represented element converts. Full EXPRESS validation found seven custom-type label errors affecting three chimneys, a flagpole and their types. The source IFC is preserved; release 0.8.4 adds a helper fix and a cheap export check for this case. The original run-time PASS was a narrower check, not a full EXPRESS pass.

Fitted-landmark error: **6.89 px RMS / 14.60 px maximum**, against a 5 px tolerance. The recorded photographic verdict is **needs_refinement**. No held-out landmarks or silhouette mask were supplied. A pleasing render and a valid IFC structure do not establish survey accuracy.

The IFC and render are unchanged from the run. JSON paths are normalized for distribution. Original run validation is retained alongside the later independent review; consult both when assessing the model. The represented elements target approximate LOD 200, not a certified architectural deliverable. No invented room layouts or building services are included.

## Reference

Reference: Nishkid64, colour correction by Patrickneil, [public domain source](https://commons.wikimedia.org/wiki/File:North_Fa%C3%A7ade_White_House.JPG). Image terms are separate from the repository's software licence.
