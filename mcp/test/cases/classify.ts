/** Bounded-row yield per subject; the house must trigger the auto-crop retry. */
import { classifyReference } from "../../src/scan.ts";
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  const name = args[i], p = args[i + 1];
  const r = classifyReference(p) as any;
  console.log(`${name} ${r.evidence.sky_bounded_rows} ${!!r.auto_cropped}`);
}
