# Taipei 101: Claude Code and Codex

Both runs used the same reference photograph, verified by matching SHA-256 hashes.
The models are shown at equal widths. Both renders and the reference are
960 × 1547 pixels. The Claude presentation was re-rendered in Blender from its
original IFC and fitted camera with blue-sky daylight similar to the Codex render.
IFC geometry, material colours and camera framing were preserved. The original
Claude render is retained below; the Codex render is unchanged.

| Client and model | Plugin version | Approximate elapsed time |
| --- | --- | --- |
| Claude Code · Fable 5.1 | 0.8.3 | 30 minutes |
| Codex · Astra | 0.7.2 | 14 minutes |

Elapsed time is measured from the reconstruction request/start event to the final
completion response in each session log, rounded to the nearest whole minute.
It includes tool execution and waits during the task. Installation time is not
included, nor is the later daylight presentation render. These are individual development runs with different plugin versions
and detail choices, not a controlled model-speed benchmark.

Both models infer lower geometry: the earlier Codex model extends its tapered
envelope to an assumed ground level, while the Claude model adds a broad podium.
Neither render includes the photograph's surrounding ground context, so the
visible lower silhouettes also reflect different assumptions.

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
