/**
 * The solver's three commitments, each as a check:
 *  - exact on a synthetic camera (no drift from any fix);
 *  - the two label shapes both field agents actually wrote must solve;
 *  - the shifted-lens branch fires on a cropped archviz frame and does NOT
 *    fire on a genuinely tilted tower photograph. That last one is the guard
 *    that keeps a house-motivated fix from breaking towers.
 */
import { solveCamera, type Segment } from "../../src/camera.ts";

const cr = (a: number[], b: number[]) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
function synth(tiltDeg: number, yawDeg = 35, F = 1400, W = 1600, H = 1200) {
  const YAW = yawDeg*Math.PI/180, TILT = tiltDeg*Math.PI/180;
  const fwd = [Math.sin(YAW)*Math.cos(TILT), Math.sin(TILT), Math.cos(YAW)*Math.cos(TILT)];
  const right = [Math.cos(YAW), 0, -Math.sin(YAW)];
  const up = cr(fwd, right), down = [-up[0], -up[1], -up[2]];
  const C = [0, 1.6, -40];
  const proj = (P: number[]): [number, number] => {
    const d = [P[0]-C[0], P[1]-C[1], P[2]-C[2]];
    const zc = fwd[0]*d[0]+fwd[1]*d[1]+fwd[2]*d[2];
    return [F*(right[0]*d[0]+right[1]*d[1]+right[2]*d[2])/zc + W/2,
            F*(down[0]*d[0]+down[1]*d[1]+down[2]*d[2])/zc + H/2];
  };
  const seg = (a: number[], b: number[], label: string): Segment => {
    const p = proj(a), q = proj(b);
    return { x0: p[0], y0: p[1], x1: q[0], y1: q[1], label };
  };
  return { W, H, F, lines: [
    seg([-10,0,0],[-10,14,0],"vertical"), seg([10,0,0],[10,14,0],"vertical"), seg([10,0,12],[10,14,12],"vertical"),
    seg([-10,2,0],[10,2,0],"eave-x"), seg([-10,14,0],[10,14,0],"eave-x"), seg([-10,8,0],[10,8,0],"eave-x"),
    seg([10,2,0],[10,2,12],"eave-z"), seg([10,14,0],[10,14,12],"eave-z"), seg([10,8,0],[10,8,12],"eave-z"),
  ]};
}

const say = (n: string, cond: boolean, d = "") => console.log(`${n} | ${cond ? "PASS" : "FAIL"} | ${d}`);

// 1. synthetic exactness
{
  const { W, H, F, lines } = synth(12);
  const r: any = solveCamera([W, H], lines, { height_m: 14 });
  say("synthetic 12deg: focal exact", Math.abs(r.intrinsics.focal_px - F) < 1, `got ${r.intrinsics.focal_px}`);
  say("synthetic 12deg: tilt exact", Math.abs(r.pose.tilt_above_horizontal_deg - 12) < 0.05, `got ${r.pose.tilt_above_horizontal_deg}`);
  say("synthetic 12deg: eye height exact", Math.abs(r.eye_height.eye_height_m_metric - 1.6) < 0.05, `got ${r.eye_height.eye_height_m_metric}`);
  say("synthetic tilted: principal point stays CENTRED (tower guard)",
      Math.abs(r.intrinsics.principal_point[1] - H/2) < 1, `got ${r.intrinsics.principal_point[1]}`);
}

// 2. the two field label shapes
{
  const base = synth(12).lines;
  const dashed = base.map((s, i) => ({ ...s, label: `${s.label}-line${i}` }));
  const r1: any = (() => { try { return solveCamera([1600,1200], dashed, {}); } catch (e) { return { err: String(e) }; } })();
  say("field label shape 'family-lineN' groups by prefix", !r1.err && r1.families?.length >= 2, r1.err ?? `${r1.families?.length} families`);

  const underscored = base.map((s, i) => ({ ...s, label: `${s.label!.replace("-", "")}_${i}` }));
  const r2: any = (() => { try { return solveCamera([1600,1200], underscored, {}); } catch (e) { return { err: String(e) }; } })();
  say("field label shape 'FAMILY_n' groups by prefix", !r2.err && r2.families?.length >= 2, r2.err ?? `${r2.families?.length} families`);
}

// 3. shifted-lens guard, both directions
{
  // Archviz crop: no tilt, horizon off-centre because the frame is cropped.
  const { lines } = synth(0);
  const H = 890, W = 2000;
  const shifted = lines.map((s) => ({ ...s, y0: s.y0 * 0.6, y1: s.y1 * 0.6 }));
  const r: any = solveCamera([W, H], shifted, {});
  const src = String(r.intrinsics?.principal_point_source ?? "");
  say("archviz crop: shifted-lens branch FIRES", src.startsWith("horizon row"), src.slice(0, 40));

  // Tower: genuine tilt must keep a centred principal point and nonzero tilt.
  const t = synth(18, 25, 1100, 800, 1067);
  const rt: any = solveCamera([t.W, t.H], t.lines, {});
  const srcT = String(rt.intrinsics?.principal_point_source ?? "");
  say("tilted tower: shifted-lens branch does NOT fire", srcT.startsWith("assumed"), srcT.slice(0, 40));
  say("tilted tower: tilt preserved", Math.abs(rt.pose.tilt_above_horizontal_deg - 18) < 0.5, `got ${rt.pose.tilt_above_horizontal_deg}`);
}

// 4. The routing block: the result must carry what to do next (v0.5.2).
//    Both rules it carries — massing before detail, and "unproject is locked" —
//    lived in skill prose for three runs and were skipped in all three.
{
  const { W, H, lines } = synth(12);
  const r: any = solveCamera([W, H], lines, { height_m: 14 });
  say("usable solve carries a next block", Array.isArray(r.next?.do) && r.next.do.length > 0);
  say("usable solve routes to the draft-first build",
      /DRAFT/.test(r.next.do.join(" ")) && /Do not pixel-measure/i.test(r.next.do.join(" ")),
      r.next?.do?.[0]?.slice(0, 50));
  say("usable solve with verticals reports unproject UNLOCKED",
      r.next.unproject_locked === false && r.camera_for_unproject !== null,
      `locked=${r.next?.unproject_locked}`);

  // Run 5 supplied ONE vertical line, so no vertical family formed, so
  // camera_for_unproject came back null — and nothing said so.
  const oneVertical = [...lines.filter((l) => l.label !== "vertical"), lines.find((l) => l.label === "vertical")!];
  const r2: any = solveCamera([W, H], oneVertical, {});
  const locked = r2.camera_for_unproject === null;
  say("one vertical line: unproject is reported LOCKED, loudly and first",
      !locked || (r2.next.unproject_locked === true && /unproject is LOCKED/.test(r2.next.do[0])),
      locked ? r2.next?.do?.[0]?.slice(0, 60) : "camera_for_unproject was not null (guard n/a)");
  say("locked warning names how many verticals were supplied",
      !locked || /vertical line\(s\) supplied/.test(r2.next.do[0]) === true,
      `vertical_lines=${r2.next?.vertical_lines}`);
}

// 5. v0.6: the field failures of the Blender baselines, as regression cases.
{
  const { W, H, lines } = synth(12);
  // 5a. Vertical family named 'V-...' (the exact blender-test-1 spelling) must
  //     be recognised GEOMETRICALLY and unlock unproject on the first call.
  const vLabels = lines.map((l, i) => ({ ...l, label: l.label === "vertical" ? `V-corner${i}` : `${l.label}-l${i}` }));
  const r: any = solveCamera([W, H], vLabels, {});
  say("'V-' vertical family unlocks unproject (geometric detection)",
      r.camera_for_unproject !== null && r.next.unproject_locked === false,
      `locked=${r.next?.unproject_locked} verticals=${r.next?.vertical_lines}`);

  // 5b. camera_for_blender present with a plausible mapping.
  const cb = r.camera_for_blender;
  const lensOk = cb && Math.abs(cb.lens_mm - (r.intrinsics.focal_px * 36) / W) < 0.1;
  say("camera_for_blender present, lens_mm = focal_px * 36 / W",
      Boolean(cb && lensOk && cb.snippet.includes("PhotoCam")), cb ? `lens=${cb.lens_mm}` : "missing");

  // 5c. The unproject instruction must ship on EVERY buildable verdict — the
  //     0.5.2 version gated it on 'usable' and three runs hand-rolled the math.
  const weakLines = lines.map((l) => ({ ...l }));
  weakLines[3] = { ...weakLines[3], y1: weakLines[3].y1 + 14 }; // bend one eave line
  const rw: any = solveCamera([W, H], weakLines, {});
  const doTxt = (rw.next?.do ?? []).join(" ");
  say("weak verdict still carries BOTH re-pick and unproject routing",
      rw.cross_check.verdict !== "usable"
        ? /Re-pick|re-pick/.test(doTxt) && /unproject/.test(doTxt)
        : true,
      `verdict=${rw.cross_check.verdict}`);
  say("routing includes the draft-first instruction on every buildable verdict",
      /DRAFT/.test(doTxt), "");
}
