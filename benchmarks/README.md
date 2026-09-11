# Reconstruction benchmark protocol

0.7.1 has automated regression coverage and a live synthetic Blender/Bonsai
import/render check. Test 7 exercised 0.7.0; no agent reconstruction run has yet
been performed with 0.7.1. Earlier desktop tests changed model, prompting,
scene state and plugin version; they motivate fixes but do not isolate causality.

Compare three arms: (A) Blender/Bonsai with the concise task only, (B) the same
plus measurement MCP tools, (C) tools plus the 0.7 skill. Use the same model,
reasoning setting, input image, scale information, deliverables, detail policy
and budget. Start a fresh Codex task and a clean Blender scene per trial.
Randomize arm order and repeat each arm at least three times per photograph.
Include a house with vegetation/clouds, a repeated-window tower and an irregular
roof. Do not optimize the runtime against the evaluation annotations.

Before each run, fix a separately reviewed set of landmarks (including withheld
check points), a subject mask/occlusion mask when feasible, and required IFC
classes. Use the same hashes and tolerances for every arm. If possible, add a
measured dimension or a second view withheld from fitting: reprojection alone
cannot establish real-world dimensions.

Record the fields in `run-template.json`, including time to first useful draft,
wall time, tool calls by tool, tokens/cost when exposed, iterations, manual
interventions, exceptions, output file sizes, IFC counts, geometry reuse and
independent validation. Missing timing/cost data stays null. Keep renders,
validation and transcripts with the run, not only the final score. Compare
medians, spread and failure rate; report photographic and semantic outcomes
separately. Have a reviewer inspect roof topology, openings, over-detailing and
assumptions without seeing which arm produced the model.

Acceptance should prioritize fewer failed/incomplete deliveries and less outcome
variance at comparable detail. Claim a speed or accuracy gain only after the
controlled runs support it. Test 7 is an exploratory integration run, not itself
proof of improvement.
