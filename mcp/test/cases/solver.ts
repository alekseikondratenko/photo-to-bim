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

// Stable machine routing replaces tests tied to motivational prose.
{
  const {W,H,lines}=synth(12);
  const r:any=solveCamera([W,H],lines,{});
  say("usable calibration routes to draft",r.next.action==='draft' && r.next.buildable);
  say("routing stays concise",r.next.do.length===1);
  const oneVertical=[...lines.filter(l=>l.label!=='vertical'),lines.find(l=>l.label==='vertical')!];
  const locked:any=solveCamera([W,H],oneVertical,{});
  say("missing vertical evidence is explicit",locked.camera_for_unproject!==null || (locked.next.unproject_locked && locked.next.action==='add_vertical_lines'));
  const labels=lines.map((l,i)=>({...l,label:l.label==='vertical'?`V-corner${i}`:`${l.label}-l${i}`}));
  const named:any=solveCamera([W,H],labels,{});
  say("geometric vertical-family recognition",named.camera_for_unproject!==null);
}
