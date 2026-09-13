# Taipei 101: Claude Code and Codex

Both runs used the same reference photograph, verified by matching SHA-256 hashes.
The displayed images are the final `comparison.png` deliverables, unchanged and
shown at equal widths. Both renders and the reference are 960 × 1547 pixels.

| Run | Client and model | Plugin version | Approximate elapsed time |
| --- | --- | --- | --- |
| Test 22 | Claude Code · Fable 5.1 | 0.8.3 | 30 minutes |
| Test 11 | Codex · Astra | 0.7.2 | 14 minutes |

Elapsed time is measured from the reconstruction request/start event to the final
completion response in each session log, rounded to the nearest whole minute.
It includes tool execution and waits during the task. Installation time is not
included. These are individual development runs with different plugin versions
and detail choices, not a controlled model-speed benchmark.

- [Original photograph](../taipei-101/reference.jpg)
- [Claude Code final render](claude-code.png)
- [Codex final render](../taipei-101/comparison.png)
- [Codex IFC and original validation evidence](../taipei-101/README.md)
- [Comparison provenance and file hashes](comparison.json)

Reference photograph: [Taipei 101 2009 amk-EditMylius](https://commons.wikimedia.org/wiki/File:Taipei_101_2009_amk-EditMylius.jpg),
AngMoKio, edited by Mylius, [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/).
The source photograph and rendered images have not been cropped or retouched for
this comparison. Reference image licensing is separate from the software license.
