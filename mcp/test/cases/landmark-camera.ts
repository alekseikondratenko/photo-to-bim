import assert from "node:assert/strict";
import fs from "node:fs";
import { fitLandmarkCamera, type Landmark } from "../../src/landmark-camera.ts";
import { makeFrame, projectWorld, type V3 } from "../../src/frame.ts";
const truth = makeFrame(
  [800, 600],
  700,
  [380, 275],
  [12, -22, 7],
  [0, 3, 3],
  4,
);
const worlds: V3[] = [
  [-4, 0, 0],
  [4, 0, 0],
  [-4, 0, 6],
  [4, 0, 6],
  [-4, 7, 0],
  [4, 7, 0],
  [-4, 7, 6],
  [4, 7, 6],
  [0, 4, 8],
  [0, 0, 3],
];
const landmarks: Landmark[] = worlds.map((world, i) => ({
  id: "p" + i,
  world,
  pixel: projectWorld(truth, world)!,
  role: i === 9 ? "check" : "fit",
  used_for_fitting: i !== 9,
}));
const initial = makeFrame(
  [800, 600],
  650,
  [400, 300],
  [13, -24, 8],
  [0, 3, 3],
  2,
);
const fit = fitLandmarkCamera(initial, landmarks, {
  fit_principal_point: true,
});
assert.equal(fit.status, "SOLVED", JSON.stringify(fit));
assert.ok(fit.fit_max_px < 1e-4, JSON.stringify(fit));
assert.ok(Math.abs(fit.camera.focal_px - 700) < 0.01);
assert.ok(
  Math.hypot(
    ...fit.camera.principal_point.map((v, i) => v - truth.principal_point[i]),
  ) < 0.01,
);
assert.equal(fit.independent_check_count, 1);
const changed = landmarks.map((l, i) =>
  i === 9 ? { ...l, pixel: [50, 50] as [number, number] } : l,
);
assert.deepEqual(
  fitLandmarkCamera(initial, changed, { fit_principal_point: true }).camera,
  fit.camera,
);
const fixed = fitLandmarkCamera(
  { ...initial, focal_px: 700, principal_point: [380, 275] },
  landmarks,
  { fit_focal: false },
);
assert.equal(fixed.status, "SOLVED");
assert.ok(fixed.fit_max_px < 1e-4);
assert.equal(
  fitLandmarkCamera(initial, landmarks, {
    max_iterations: 1,
    fit_principal_point: true,
  }).status,
  "INCOMPLETE",
);
const collinear: Landmark[] = Array.from({ length: 8 }, (_, i) => {
  const world: V3 = [i - 4, 0, 2];
  return { id: "l" + i, world, pixel: projectWorld(truth, world)! };
});
assert.equal(fitLandmarkCamera(truth, collinear).status, "INCOMPLETE");
assert.throws(() => fitLandmarkCamera(initial, landmarks.slice(0, 5)), /six/);
assert.throws(
  () => fitLandmarkCamera(initial, [...landmarks, landmarks[0]]),
  /unique/,
);
const fixture = JSON.parse(
  fs.readFileSync(
    new URL("../fixtures/test7-camera.json", import.meta.url),
    "utf8",
  ),
);
const regression = fitLandmarkCamera(fixture.camera, fixture.landmarks, {
  fit_principal_point: true,
  max_iterations: 300,
});
assert.equal(regression.status, "SOLVED", JSON.stringify(regression));
assert.ok(
  regression.fit_rms_px <= fixture.baseline_rms_px + 0.01,
  JSON.stringify(regression),
);
assert.equal(regression.independent_check_count, 0);
console.log(
  "PASS camera-only fit: focal/shift/roll, held-out exclusion, fixed intrinsics, degeneracy, iteration limit, test-7 fixed geometry",
);
