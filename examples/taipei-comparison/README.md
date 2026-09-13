# Taipei 101: Claude Code and Codex

Both runs used the same reference photograph, verified by matching SHA-256 hashes.
The models are shown at equal widths. Both renders and the reference are
960 × 1547 pixels. The Claude presentation was re-rendered in Blender from its
original IFC and fitted camera with blue-sky daylight similar to the Codex render.
IFC geometry, material colours and camera framing were preserved. The original
Claude render is retained below; the Codex image is the unedited final render
from the current run.

| Client and model | Plugin version | Approximate elapsed time |
| --- | --- | --- |
| Claude Code · Fable 5.1 | 0.8.3 | 30 minutes |
| Codex · Astra | 0.8.3 | 9 minutes |

Claude time is measured from the reconstruction request to the final response,
rounded to whole minutes. Codex's approximately 9 minutes is the author's reported
estimate; its session log records about 8 minutes from task start to completion.
Both exclude installation and the later Claude daylight presentation render.
These are individual development runs with different detail choices, not a
controlled model-speed benchmark.

Both models infer the obscured lower geometry. Codex continues the curtain-wall
pattern around its lower podium; Claude adds a broader podium. Neither render
includes the photograph's surrounding ground context, so the exposed undersides
and lower silhouettes reflect those assumptions.

The updated Codex run passes IFC and appearance checks. Its fitted landmarks have
4.09 px RMS error and 8.16 px maximum error against a 5 px tolerance, so the
photographic result remains approximate. There are no held-out points or
silhouette-mask checks.

- [Original photograph](../taipei-101/reference.jpg)
- [Claude Code daylight presentation](claude-code-daylight.png)
- [Claude Code original final render](claude-code.png)
- [Blender daylight-render script](render_daylight.py)
- [Codex final render](../taipei-101/comparison.png)
- [Codex IFC and original validation evidence](../taipei-101/README.md)
- [Comparison provenance and file hashes](comparison.json)

Reference photograph: [Taipei 101 2009 amk-EditMylius](https://commons.wikimedia.org/wiki/File:Taipei_101_2009_amk-EditMylius.jpg),
AngMoKio, edited by Mylius, [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/).
The source photograph and images have not been cropped or retouched; the daylight
image is a new Blender render, not an image edit. To reproduce it, execute
`render_daylight.py` through Blender MCP with `SOURCE_FOLDER` pointing to the
original Claude output folder (including `house.ifc` and `work/camera_final.json`)
and `OUTPUT_PATH` set to the destination PNG. It creates a separate presentation
scene and leaves the active Bonsai model untouched. Reference image licensing is
separate from the software license.
