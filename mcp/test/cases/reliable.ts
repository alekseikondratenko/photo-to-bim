import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { PNG } from "pngjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  makeFrame,
  projectWorld,
  intersectPlane,
  anchorFrame,
  type V3,
} from "../../src/frame.ts";
import { evaluate } from "../../src/evaluate.ts";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "photo-to-bim-"));
let tests = 0;
const test = (name: string, f: () => void) => {
  f();
  tests++;
  console.log("PASS " + name);
};
const png = (name: string, pixel: (x: number, y: number) => number[]) => {
  const p = new PNG({ width: 200, height: 160 });
  for (let y = 0; y < 160; y++)
    for (let x = 0; x < 200; x++) {
      const i = (y * 200 + x) * 4;
      p.data.set([...pixel(x, y), 255], i);
    }
  const f = path.join(dir, name);
  fs.writeFileSync(f, PNG.sync.write(p));
  return f;
};
try {
  const camera = makeFrame([200, 160], 150, [100, 80], [0, -10, 2], [0, 0, 2]);
  const pixels: [number, number][] = [
    [50, 30],
    [150, 30],
    [50, 130],
    [150, 130],
  ];
  const points = intersectPlane(
    camera,
    { origin: [0, 0, 0], normal: [0, 1, 0] },
    pixels,
  ).points;
  test("arbitrary plane in Z-up world", () => {
    const p = intersectPlane(
      camera,
      { origin: [0, 1, 0], normal: [1, 2, 0.3] },
      [[110, 90]],
    ).points[0].world!;
    assert.ok(Math.abs(p[0] + 2 * (p[1] - 1) + 0.3 * p[2]) < 1e-10);
    assert.ok(
      Math.hypot(...projectWorld(camera, p)!.map((v, i) => v - [110, 90][i])) <
        1e-9,
    );
  });
  test("reject invalid and backwards intersections", () => {
    assert.equal(
      intersectPlane(camera, { origin: [0, -20, 0], normal: [0, 1, 0] }, [
        [100, 80],
      ]).points[0].world,
      null,
    );
    assert.throws(() =>
      intersectPlane(camera, { origin: [0, 0, 0], normal: [0, 0, 0] }, pixels),
    );
    assert.throws(() =>
      intersectPlane(
        camera,
        { origin: [NaN, 0, 0], normal: [0, 1, 0] },
        pixels,
      ),
    );
  });
  test("metric anchor handles off-centre principal point, tilt and roll", () => {
    const tilt = 10,
      roll = 8,
      pos: V3 = [-2, -10, 2];
    const c = makeFrame(
      [200, 160],
      180,
      [95, 70],
      pos,
      [-2, 0, 2 + 10 * Math.tan((tilt * Math.PI) / 180)],
      roll,
    );
    const r = anchorFrame(
      [200, 160],
      180,
      [95, 70],
      tilt,
      roll,
      projectWorld(c, [0, 0, 0])!,
      projectWorld(c, [0, 0, 4])!,
      4,
    );
    assert.ok(r.residual_m < 1e-10);
    for (let i = 0; i < 3; i++)
      assert.ok(Math.abs(r.camera.world_from_camera[i][3] - pos[i]) < 1e-9);
  });
  const reference = png("ref.png", (x, y) =>
    y < 50 ? [x % 2 ? 255 : 20, 90, 170] : [80, 60, 40],
  );
  const render = png("beauty.png", () => [220, 220, 220]);
  const subject = png("subject.png", (x, y) =>
    x > 30 && x < 170 && y > 20 && y < 140 ? [255, 255, 255] : [0, 0, 0],
  );
  const obsPath = path.join(dir, "observations.json");
  const base = {
    schema_version: 1,
    reference_sha256: createHash("sha256")
      .update(fs.readFileSync(reference))
      .digest("hex"),
    image_size: [200, 160],
  };
  const landmarks = pixels.map((pixel, i) => ({
    id: "p" + i,
    pixel,
    role: i > 1 ? "check" : "fit",
    used_for_fitting: i <= 1,
  }));
  const model_points = Object.fromEntries(
    points.map((p, i) => ["p" + i, p.world!]),
  );
  const observe = (extra: object = {}) =>
    fs.writeFileSync(obsPath, JSON.stringify({ ...base, ...extra }));
  test("clouds and RGB identity cannot declare a photographic pass", () => {
    assert.equal(
      evaluate({ reference, render: reference }).status,
      "INCOMPLETE",
    );
    assert.equal(
      evaluate({ reference, render }).camera_check.status,
      "UNDETERMINED",
    );
  });
  observe({ landmarks, subject_mask: "subject.png" });
  const req = {
    reference,
    render,
    observations: obsPath,
    camera,
    model_points,
    render_mask: subject,
  };
  test("fixed landmarks and explicit masks pass despite beauty differences", () => {
    const r = evaluate(req);
    assert.equal(r.status, "PASS");
    assert.equal(r.landmarks.held_out_count, 2);
    assert.equal(r.silhouette.iou, 1);
  });
  test("consumed or undeclared check points are not independent", () => {
    observe({
      landmarks: landmarks.map((l) => ({ ...l, used_for_fitting: true })),
    });
    const consumed = evaluate(req);
    assert.equal(consumed.landmarks.held_out_count, 0);
    assert.equal(consumed.landmarks.consumed_check_count, 2);
    observe({ landmarks: landmarks.map(({ used_for_fitting, ...l }) => l) });
    assert.equal(evaluate(req).landmarks.undeclared_check_count, 2);
    assert.equal(evaluate(req).landmarks.held_out_count, 0);
    observe({ landmarks, subject_mask: "subject.png" });
  });
  test("IFC landmark packs reject stale exports and edited coordinates", () => {
    const ifc = path.join(dir, "snapshot.ifc"),
      pack = path.join(dir, "landmarks.json");
    fs.writeFileSync(ifc, "fixture IFC bytes");
    const snapshot = {
      schema_version: 1,
      ifc_sha256: createHash("sha256")
        .update(fs.readFileSync(ifc))
        .digest("hex"),
      model_points,
      bindings: Object.fromEntries(
        Object.entries(model_points).map(([id, world]) => [
          id,
          {
            global_id: "fixture-guid",
            geometry_sha256: "fixture-geometry",
            world,
          },
        ]),
      ),
    };
    fs.writeFileSync(pack, JSON.stringify(snapshot));
    const bound = { ...req, model_points: undefined, landmark_pack: pack, ifc };
    assert.equal(evaluate(bound).model_binding.status, "IFC_SNAPSHOT");
    fs.writeFileSync(ifc, "changed");
    assert.throws(() => evaluate(bound), /[Ss]tale|hash/);
    fs.writeFileSync(ifc, "fixture IFC bytes");
    snapshot.model_points = { ...model_points, p0: [999, 0, 0] };
    fs.writeFileSync(pack, JSON.stringify(snapshot));
    assert.throws(() => evaluate(bound), /binding|snapshot|[Ll]andmark/);
  });
  test("missing mask or a missing point is incomplete", () => {
    assert.equal(
      evaluate({ ...req, render_mask: undefined }).status,
      "INCOMPLETE",
    );
    assert.equal(
      evaluate({ ...req, model_points: { p0: model_points.p0 } }).status,
      "INCOMPLETE",
    );
  });
  test("model mismatch fails without automatic camera diagnosis", () => {
    const r = evaluate({
      ...req,
      model_points: { ...model_points, p0: [10, 0, 2] },
    });
    assert.equal(r.status, "FAIL");
    assert.equal(r.camera_check.status, "UNDETERMINED");
  });
  test("collinear evidence is incomplete", () => {
    observe({
      landmarks: landmarks.map((l, i) => ({
        ...l,
        pixel: [30 + i * 30, 30 + i * 20],
      })),
    });
    assert.equal(evaluate(req).status, "INCOMPLETE");
  });
  test("mask span and occlusion apply to both images", () => {
    const other = png("other.png", (x, y) =>
      (x < 100 ? x > 30 && y > 20 && y < 140 : x > 190)
        ? [255, 255, 255]
        : [0, 0, 0],
    );
    observe({ subject_mask: "subject.png", span: [0, 100] });
    assert.equal(evaluate({ ...req, render_mask: other }).status, "PASS");
    png("exclude.png", (x) => (x >= 100 ? [255, 255, 255] : [0, 0, 0]));
    observe({ subject_mask: "subject.png", occlusion_mask: "exclude.png" });
    assert.equal(evaluate({ ...req, render_mask: other }).status, "PASS");
  });
  test("empty and fully excluded masks never pass", () => {
    png("black.png", () => [0, 0, 0]);
    png("white.png", () => [255, 255, 255]);
    observe({ subject_mask: "black.png" });
    assert.equal(evaluate(req).status, "INCOMPLETE");
    observe({ subject_mask: "subject.png", occlusion_mask: "white.png" });
    assert.equal(evaluate(req).status, "INCOMPLETE");
  });
  test("stale observations and nonbinary masks fail loudly", () => {
    observe({ reference_sha256: "bad" });
    assert.throws(() => evaluate(req), /hash/);
    observe({ subject_mask: "beauty.png" });
    assert.throws(() => evaluate(req), /binary/);
  });
  test("history compares only fixed evidence and thresholds", () => {
    observe({ landmarks });
    const history_path = path.join(dir, "history.json");
    const bad = {
      ...req,
      model_points: { ...model_points, p0: [10, 0, 2] as V3 },
      history_path,
    };
    assert.equal(evaluate(bad).verdict, "needs_refinement");
    evaluate(bad);
    assert.equal(evaluate(bad).verdict, "stalled");
    assert.equal(
      evaluate({ ...bad, tolerance_px: 6 }).verdict,
      "needs_refinement",
    );
    observe({
      landmarks: landmarks.map((l, i) => (i ? l : { ...l, pixel: [51, 30] })),
    });
    assert.equal(evaluate(bad).verdict, "needs_refinement");
  });
  observe({ landmarks, subject_mask: "subject.png" });
  test("bundled JSON CLI and direct evaluator agree", () => {
    const cli = JSON.parse(
      execFileSync(
        process.execPath,
        ["dist/ifc-server.mjs", "--evaluate-json"],
        { input: JSON.stringify(req), encoding: "utf8" },
      ),
    );
    assert.deepEqual(cli, evaluate(req));
  });
  const client = new Client({ name: "release-test", version: "1.0.0" });
  try {
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: ["dist/ifc-server.mjs"],
      }),
    );
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), [
      "calibrate_camera",
      "classify_reference",
      "compare_model",
      "place_features",
      "trace_edges",
      "view_crop",
    ]);
    // Regression: tuple-style items arrays were listed by MCP, then silently
    // rejected by the client's model-tool translator (test 8).
    function portableArrays(schema: any) {
      if (!schema || typeof schema !== "object") return;
      assert.ok(
        !Array.isArray(schema.items),
        "Tuple-style items are not portable",
      );
      for (const value of Object.values(schema)) {
        if (Array.isArray(value)) value.forEach(portableArrays);
        else portableArrays(value);
      }
    }
    tools.forEach((t) => portableArrays(t.inputSchema));
    const planeTool = tools.find((t) => t.name === "place_features")!;
    const normalSchema = (planeTool.inputSchema.properties as any).plane
      .properties.normal;
    assert.equal(normalSchema.minItems, 3);
    assert.equal(normalSchema.maxItems, 3);
    assert.equal(normalSchema.items.type, "number");
    const invalidVector = await client.callTool({
      name: "place_features",
      arguments: {
        camera,
        plane: { origin: [0, 0, 0], normal: [0, 1] },
        features: [{ id: "p", pixel: [100, 80] }],
      },
    });
    assert.equal(invalidVector.isError, true);
    const cropError = await client.callTool({
      name: "view_crop",
      arguments: {
        image: reference,
        regions: [{ x0: 0, y0: 0, x1: 100, y1: 100 }],
        out: dir,
      },
    });
    assert.equal(cropError.isError, true);
    assert.match(JSON.stringify(cropError), /[Pp][Nn][Gg]|filename/);
    const response = await client.callTool({
      name: "compare_model",
      arguments: req,
    });
    assert.equal(response.isError, undefined);
    assert.deepEqual(response.structuredContent, evaluate(req));
    const synthCamera = makeFrame(
      [200, 160],
      150,
      [100, 80],
      [20, -40, 2],
      [0, 0, 12],
      8,
    );
    const segment = (id: string, label: string, a: V3, b: V3) => {
      const p = projectWorld(synthCamera, a)!,
        q = projectWorld(synthCamera, b)!;
      return { id, label, x0: p[0], y0: p[1], x1: q[0], y1: q[1] };
    };
    const lines = [
      segment("v1", "vertical", [-10, 0, 0], [-10, 0, 14]),
      segment("v2", "vertical", [10, 0, 0], [10, 0, 14]),
      segment("v3", "vertical", [10, 12, 0], [10, 12, 14]),
      segment("x1", "eave-x", [-10, 0, 2], [10, 0, 2]),
      segment("x2", "eave-x", [-10, 0, 14], [10, 0, 14]),
      segment("x3", "eave-x", [-10, 0, 8], [10, 0, 8]),
      segment("y1", "eave-y", [10, 0, 2], [10, 12, 2]),
      segment("y2", "eave-y", [10, 0, 14], [10, 12, 14]),
      segment("y3", "eave-y", [10, 0, 8], [10, 12, 8]),
    ];
    const bottom = projectWorld(synthCamera, [0, 0, 0])!,
      top = projectWorld(synthCamera, [0, 0, 14])!;
    const calibrated = await client.callTool({
      name: "calibrate_camera",
      arguments: {
        image: reference,
        lines,
        scale_anchor: {
          height_m: 14,
          bottom,
          top,
          status: "measured",
          source: "synthetic truth",
        },
      },
    });
    assert.equal(calibrated.isError, undefined, JSON.stringify(calibrated));
    const cc = calibrated.structuredContent as any;
    assert.ok(cc.camera, JSON.stringify(cc));
    assert.ok(cc.anchor_residual_m < 0.01, JSON.stringify(cc));
    assert.ok(
      Math.hypot(
        ...projectWorld(cc.camera, [0, 0, 14])!.map((v, i) => v - top[i]),
      ) < 0.2,
    );
    const fitWorlds: V3[] = [
      [-8, 0, 0],
      [8, 0, 0],
      [-8, 0, 14],
      [8, 0, 14],
      [-8, 12, 0],
      [8, 12, 0],
      [-8, 12, 14],
      [8, 12, 14],
    ];
    const landmarkArgs = {
      image: reference,
      method: "landmarks",
      initial_camera: synthCamera,
      landmarks: fitWorlds.map((world, i) => ({
        id: "landmark-" + i,
        world,
        pixel: projectWorld(synthCamera, world)!,
        role: "fit",
      })),
      scale_source: {
        status: "measured",
        source: "Synthetic fixture dimensions",
      },
    };
    const landmarkFit = await client.callTool({
      name: "calibrate_camera",
      arguments: landmarkArgs,
    });
    assert.equal(landmarkFit.isError, undefined, JSON.stringify(landmarkFit));
    assert.equal((landmarkFit.structuredContent as any).status, "SOLVED");
    assert.ok((landmarkFit.structuredContent as any).fit_max_px < 0.001);
    const { scale_source, ...withoutScale } = landmarkArgs;
    assert.equal(
      (
        await client.callTool({
          name: "calibrate_camera",
          arguments: withoutScale,
        })
      ).isError,
      true,
    );
    const placed = await client.callTool({
      name: "place_features",
      arguments: {
        camera,
        plane: { origin: [0, 0, 0], normal: [0, 1, 0] },
        features: [{ id: "corner", pixel: [100, 80] }],
      },
    });
    assert.equal(placed.isError, undefined);
    console.log(
      "PASS MCP handshake, six tool schemas, real evaluation and placement",
    );
    tests++;
  } finally {
    await client.close();
  }
  console.log(`${tests} reliability groups passed`);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
