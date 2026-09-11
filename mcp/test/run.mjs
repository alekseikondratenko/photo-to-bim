/** Portable release suite. Missing IFC dependencies are a failure, never a skip. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
const here = import.meta.dirname,
  root = path.resolve(here, "../..");
const python =
  process.env.IFC_PYTHON ??
  (fs.existsSync(path.join(root, ".venv/bin/python"))
    ? path.join(root, ".venv/bin/python")
    : "python3");
const run = (command, args) =>
  execFileSync(command, args, {
    cwd: path.join(root, "mcp"),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
try {
  console.log(
    run(python, [
      "-c",
      'import ifcopenshell, numpy, pytest; print("IFC dependencies available")',
    ]),
  );
  console.log(run(process.execPath, ["build-server.mjs"]));
  for (const name of ["solver", "crops", "unproject"]) {
    const out = run(process.execPath, [
      "node_modules/tsx/dist/cli.mjs",
      `test/cases/${name}.ts`,
    ]);
    console.log(out);
    if (/\| FAIL \|/.test(out)) throw Error(name + " regression");
  }
  // Retain legacy detector tests on the three photographs actually bundled in the repo.
  const photos = fs
    .readdirSync(path.join(here, "photos"))
    .filter((n) => n.endsWith(".jpg"))
    .map((n) => path.join(here, "photos", n));
  const identity = run(process.execPath, [
    "node_modules/tsx/dist/cli.mjs",
    "test/cases/identity.ts",
    ...photos,
  ]);
  console.log(identity);
  for (const line of identity.trim().split("\n")) {
    const [, edge, sky] = line.split(/\s+/);
    if (edge !== "0" || sky !== "0") throw Error("Legacy identity regression");
  }
  console.log(
    run(process.execPath, [
      "node_modules/tsx/dist/cli.mjs",
      "test/cases/reliable.ts",
    ]),
  );
  console.log(
    run(process.execPath, [
      "node_modules/tsx/dist/cli.mjs",
      "test/cases/landmark-camera.ts",
    ]),
  );
  console.log(run(python, [path.join(here, "cases/ifc_helpers.py")]));
  console.log(
    run(python, [
      "-m",
      "pytest",
      "-q",
      path.join(here, "cases/test_runtime.py"),
    ]),
  );
  console.log("ALL RELEASE CHECKS PASS");
} catch (e) {
  console.error(e.stdout ?? "", e.stderr ?? "", e.message);
  process.exitCode = 1;
}
