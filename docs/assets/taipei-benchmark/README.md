# Taipei 101 agent comparison

Both agents received the same photograph (matching SHA-256). This is an illustrative comparison between development runs, not a controlled speed benchmark.

| Client/model | Plugin | Approximate elapsed time |
| --- | --- | --- |
| Claude Code · Fable 5.1 | 0.8.3 — historical | 30 minutes |
| Codex · Astra | 0.8.4-dev.3 | 12 minutes |

Times are rounded to whole minutes from the respective session logs, excluding installation and the later Claude presentation render. Codex's recorded duration was approximately 11.5 minutes. The agents used different plugin versions and modelling decisions.

The [Claude daylight image](claude-code-daylight.png) was rendered afterwards in Blender, preserving its original IFC geometry, colours and fitted camera. Its [original render](claude-code.png) is retained for transparency. The [Codex image](../../../examples/taipei-101/comparison.png) is the unchanged final render from the newer run.

[Original photograph](../../../examples/taipei-101/reference.jpg) · [Current Codex IFC and evidence](../../../examples/taipei-101/README.md). The current Codex run has 4.22 px RMS / 9.34 px maximum fitted-landmark error, exceeding the 5 px maximum tolerance; there are no held-outs or silhouette checks.

Reference: AngMoKio, edited by Mylius, [source](https://commons.wikimedia.org/wiki/File:Taipei_101_2009_amk-EditMylius.jpg), [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/).
