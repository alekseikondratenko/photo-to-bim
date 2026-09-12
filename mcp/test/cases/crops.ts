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

// A valid PNG can still be almost blank when fractional sheet strides discard
// pixel writes. Check actual tile content, including a second row of tiles.
const fs = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');
const { PNG } = await import('pngjs');
const { viewCropSheet } = await import('../../src/instruments.ts');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ptb-crops-'));
try {
  const source = new PNG({ width: 2000, height: 1333 });
  for (let i = 0; i < source.data.length; i += 4) {
    source.data[i] = 170; source.data[i+1] = 90;
    source.data[i+2] = 60; source.data[i+3] = 255;
  }
  const input = path.join(scratch, 'source.png');
  fs.writeFileSync(input, PNG.sync.write(source));
  const regions = [
    { x0: 540, y0: 570, x1: 1260, y1: 1135 },
    { x0: 250, y0: 965, x1: 610, y1: 1145 },
    { x0: 101, y0: 101, x1: 424, y1: 342 },
  ];
  for (const [scale, count] of [[1.1, 2], [1.5, 3], [.75, 3], [2, 2]] as const) {
    say(`crop sheet ${scale}x / ${count} tiles retains pixels and integer dimensions`, () => {
      const out = path.join(scratch, 'sheet.png');
      const chosen = regions.slice(0, count);
      const report = viewCropSheet(input, chosen, out, { scale });
      const image = PNG.sync.read(fs.readFileSync(out));
      if (!report.out_size.every(Number.isInteger)) return false;
      if (report.out_size[0] !== image.width || report.out_size[1] !== image.height) return false;
      const sizes = chosen.map(r => [Math.round((r.x1-r.x0)*scale), Math.round((r.y1-r.y0)*scale)]);
      const cellW = Math.max(...sizes.map(s => s[0])), cellH = Math.max(...sizes.map(s => s[1]));
      return sizes.every(([w,h], tile) => {
        const gx = (tile%2)*(cellW+8)+8, gy = Math.floor(tile/2)*(cellH+8)+8;
        let matching = 0;
        for (let y=0; y<h; y++) for (let x=0; x<w; x++) {
          const offset = ((gy+y)*image.width+gx+x)*4;
          if (image.data[offset]===170 && image.data[offset+1]===90 && image.data[offset+2]===60) matching++;
        }
        return matching/(w*h) > .9;
      });
    });
  }
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
