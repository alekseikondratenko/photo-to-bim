/** Each photo scored against itself: both axes must read exactly zero. */
import { scoreImages } from "../../src/scan.ts";
for (const p of process.argv.slice(2)) {
  const r = scoreImages(p, p) as any;
  const name = p.split("/").pop()!.replace(/\.(jpe?g|png)$/i, "").replace("reference-", "");
  // worst_segments must stay null on identity: a located error that is only
  // noise is worse than silence (v0.5.2).
  console.log(`${name} ${r.silhouette.mean_edge_error_px ?? 0} ${r.skyline?.mean_top_error_px ?? "null"} ${r.skyline?.columns_compared ?? 0} ${r.skyline?.worst_segments ? r.skyline.worst_segments.length : "null"}`);
}
