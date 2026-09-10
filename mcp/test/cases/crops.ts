/**
 * normalizeCrops must accept every shape a field agent has actually sent —
 * including the JSON-STRING forms the collapsed union schema provoked (six
 * consecutive -32602s before the agent gave up and rebuilt crop.py).
 */
import { normalizeCrops } from "../../src/instruments.ts";
const say = (n: string, f: () => boolean) => {
  let ok = false, d = "";
  try { ok = f(); } catch (e) { d = String(e).slice(0, 80); }
  console.log(`${n} | ${ok ? "PASS" : "FAIL"} | ${d}`);
};
const R = { x0: 560, y0: 170, x1: 1420, y1: 800 };
say("plain object", () => normalizeCrops(R).length === 1);
say("array of objects (sheet)", () => normalizeCrops([R, { x0: 0, y0: 0, x1: 10, y1: 10 }]).length === 2);
say("STRING of object", () => normalizeCrops(JSON.stringify(R)).length === 1);
say("STRING of array", () => normalizeCrops(JSON.stringify([R])).length === 1);
say("STRING {regions:[...]}", () => normalizeCrops(JSON.stringify({ regions: [R, R] })).length === 2);
say("STRING flat [x0,y0,x1,y1]", () => normalizeCrops("[560,170,1420,800]")[0].x1 === 1420);
say("STRING {x,y,w,h}", () => normalizeCrops(JSON.stringify({ x: 560, y: 170, w: 860, h: 630 }))[0].x1 === 1420);
say("garbage refused with a clear error", () => {
  try { normalizeCrops("hello"); return false; } catch (e) { return String(e).includes("not valid JSON"); }
});
