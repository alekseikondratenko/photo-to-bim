/**
 * init_workspace — scaffold a reconstruction workspace from the skill's
 * viewer template and register a subject stub in it.
 *
 * This mechanises the fiddliest manual minutes of a fresh run: copy template,
 * create models/<id>.ts + scenes/<id>.ts, patch MODELS in main.ts. The stubs
 * compile and render a placeholder so the massing gate has somewhere to start;
 * every number in them is loudly marked as placeholder.
 */
import fs from "node:fs";
import path from "node:path";

const HERE = import.meta.dirname;

function templateDir(): string {
  const candidates = [
    path.join(HERE, "..", "..", "skills", "photo-to-threejs-building", "assets", "viewer-template"),
    path.join(HERE, "..", "viewer-template"),
  ];
  for (const p of candidates) if (fs.existsSync(path.join(p, "src", "main.ts"))) return p;
  throw new Error(
    "viewer-template not found — the web-viewer target's assets live in the " +
    "photo-to-threejs repo (this server's legacy target). For IFC work use the " +
    "photo-to-ifc-building skill's blender-template instead; init_workspace is not " +
    "part of that workflow.",
  );
}

function copyTree(src: string, dst: string) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist") continue;
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
}

const modelStub = (id: string, pascal: string) => `import * as THREE from 'three';
import { countGeometry } from '../lib/geometry';
import type { ModelRuntime } from '../lib/types';

/**
 * ${pascal} — PLACEHOLDER SCAFFOLD from init_workspace.
 *
 * Replace with measured geometry (SKILL.md Steps 1–3). Massing gate applies:
 * whole-building massing, scored, before any detail.
 */
export const TOTAL_H = 10;

export function create${pascal}Model(
  opts: { context?: boolean; shadows?: boolean } = {},
): THREE.Group {
  const { shadows = true } = opts;
  const root = new THREE.Group();
  root.name = '${pascal}';
  const nodes: Record<string, THREE.Object3D> = {};
  const materials: Record<string, THREE.Material> = {};

  const mass = new THREE.MeshStandardMaterial({ color: 0x9aa2ab, roughness: 0.9 });
  materials.massing = mass;
  const block = new THREE.Mesh(new THREE.BoxGeometry(8, TOTAL_H, 6), mass);
  block.position.y = TOTAL_H / 2;
  block.castShadow = shadows;
  block.receiveShadow = shadows;
  block.name = 'placeholder-massing';
  root.add(block);
  nodes['placeholder-massing'] = block;

  const { meshes, triangles } = countGeometry(root);
  const runtime: ModelRuntime = {
    nodes,
    materials,
    stats: { floors: 0, heightM: TOTAL_H, meshes, triangles },
  };
  (root.userData as { sculptRuntime: ModelRuntime }).sculptRuntime = runtime;
  return root;
}
`;

const sceneStub = (id: string, pascal: string, referenceImage: string) => `import { create${pascal}Model, TOTAL_H } from '../models/${id}';
import type { BuildingModel } from '../lib/types';

/**
 * PLACEHOLDER SCAFFOLD from init_workspace — every number below is unmeasured.
 * Replace views with the solved camera (SKILL.md Step 1) and targets with values
 * measured off the reference (Step 2). Do NOT score against placeholder targets.
 */
export const ${id}: BuildingModel = {
  id: '${id}',
  label: '${pascal}',
  blurb: 'Scaffold — replace with the measured reconstruction',
  referenceImage: '${referenceImage}',
  heightM: TOTAL_H,
  build: (o) => create${pascal}Model(o),
  views: {
    ref: { pos: [18, 4, 26], target: [0, 4, 0], fov: 40 },
    q34: { pos: [16, 9, 16], target: [0, 4, 0], fov: 40 },
    side: { pos: [26, 5, 0], target: [0, 4, 0], fov: 35 },
    rear: { pos: [-14, 6, -20], target: [0, 4, 0], fov: 40 },
    top: { pos: [10, 26, 12], target: [0, 2, 0], fov: 45 },
  },
  lighting: {
    sun: { color: 0xffffff, intensity: 2.5, position: [60, 90, 70] },
    hemi: { sky: 0xcfd8e6, ground: 0x8a8676, intensity: 1.0 },
    skyStops: [[0.0, '#9db4d6'], [0.7, '#dce9f5'], [1.0, '#b9b6a4']],
    exposure: 1.0,
    shadowExtent: 30,
  },
  // PLACEHOLDERS — measure before scoring (a converged score against invented
  // targets is checklist item 13's false-100% trap, deliberately).
  targets: {
    litLuma: 128, shadowLuma: 96, ratio: 1.33, widthFrac: 0.5,
    // The subject's column extent in the REFERENCE photograph, in original
    // image pixels. Set it as soon as you know it (the massing pass is the
    // natural moment) and every scored save from then on carries an extra
    // subject-band block — the flanks of a real photograph measure trees and
    // neighbours, not the building, and a field run read 487/585 px flanks
    // against a 107 px middle before hand-building its own scoped checker.
    // Nothing else to remember: the render trigger forwards this for you.
    span: null, // e.g. { x0: 210, x1: 1780 }
  },
};
`;

const reconStub = (id: string, referencePublic: string) => `# RECON — ${id}

The working ledger. Rewrite it every step; read it before re-deriving anything.
A fact not recorded here will be re-measured; a hypothesis not buried here will
be resurrected. (Both happened, repeatedly, in the run that motivated this file.)

## Verified
<!-- measurements with their evidence: "eave y=2.95 m — gutter rows 549-551 + rake unprojection agree" -->

## Assumed
<!-- working values without direct evidence, each with its source: "storey height 2.85 m (standard)" -->

## REFUTED
<!-- hypotheses killed, WITH the evidence that killed them. Once here, they stay dead. -->

## Camera
<!-- paste the solve_camera result (or its summary) here verbatim once verdict != inconsistent -->

## Next tests
<!-- what would change your mind about the current reading -->

## Score history
<!-- The save-render gate appends a row here automatically on every scored save.
     Fill in the last column yourself — the numbers say WHAT moved, only you can
     say what you changed. A pass whose numbers did not move is a pass to think
     about, not to repeat. -->
| render | skyline mean px | subject band px | row-edge px | area ratio | what changed |
|---|---|---|---|---|---|

Reference: \`${referencePublic}\`
`;

export function initWorkspace(dir: string, subjectId: string, referenceImage?: string) {
  const id = subjectId.replace(/[^a-zA-Z0-9]/g, "");
  if (!id) throw new Error("subjectId must contain letters/digits");
  const pascal = id[0].toUpperCase() + id.slice(1);
  const viewer = path.join(dir, "viewer");

  const created: string[] = [];
  if (!fs.existsSync(path.join(viewer, "src", "main.ts"))) {
    copyTree(templateDir(), viewer);
    created.push("viewer/ (from template)");
  }
  for (const d of ["models", "scenes"]) fs.mkdirSync(path.join(viewer, "src", d), { recursive: true });

  // The reference must be servable by the browser AND findable by the scoring
  // gate. A filesystem path written into the scene verbatim satisfies neither
  // (a field run had to fix that by hand) — so when we are handed a real file,
  // copy it into public/ and reference it by URL path.
  let referenceRef = referenceImage ?? `/${id}-reference.jpg`;
  if (referenceImage && fs.existsSync(referenceImage) && path.isAbsolute(referenceImage)) {
    const pub = path.join(viewer, "public");
    fs.mkdirSync(pub, { recursive: true });
    const ext = path.extname(referenceImage).toLowerCase() || ".jpg";
    const dest = path.join(pub, `${id}-reference${ext}`);
    fs.copyFileSync(referenceImage, dest);
    referenceRef = `/${id}-reference${ext}`;
    created.push(`viewer/public/${id}-reference${ext} (copied for the browser + scoring gate)`);
  }

  const modelPath = path.join(viewer, "src", "models", `${id}.ts`);
  const scenePath = path.join(viewer, "src", "scenes", `${id}.ts`);
  if (fs.existsSync(modelPath) || fs.existsSync(scenePath)) {
    throw new Error(`subject '${id}' already exists in ${viewer}`);
  }
  fs.writeFileSync(modelPath, modelStub(id, pascal));
  fs.writeFileSync(scenePath, sceneStub(id, pascal, referenceRef));
  created.push(`viewer/src/models/${id}.ts`, `viewer/src/scenes/${id}.ts`);

  const reconPath = path.join(dir, "RECON.md");
  if (!fs.existsSync(reconPath)) {
    fs.writeFileSync(reconPath, reconStub(id, referenceRef));
    created.push("RECON.md (the working ledger — rewrite it every step)");
  }

  // Register in main.ts: add the import and append to MODELS.
  const mainPath = path.join(viewer, "src", "main.ts");
  let main = fs.readFileSync(mainPath, "utf-8");
  if (!main.includes(`scenes/${id}`)) {
    main = main.replace(
      /(^import .*lib\/measure.*$)/m,
      `import { ${id} } from './scenes/${id}';\n$1`,
    );
    main = main.replace(
      /const MODELS: BuildingModel\[\] = \[(.*?)\];/s,
      (_m, inner: string) => {
        const list = inner.trim().length ? `${inner.trim().replace(/,\s*$/, "")}, ${id}` : id;
        return `const MODELS: BuildingModel[] = [${list}];`;
      },
    );
    fs.writeFileSync(mainPath, main);
    created.push(`main.ts (registered '${id}')`);
  }

  return {
    workspace: viewer,
    subject: id,
    created,
    next:
      "npm install in viewer/, then npm run dev — vite prints the URL (it may not be " +
      "5200; the printed URL is the truth). Replace the stub's placeholder numbers with " +
      "measured values before scoring anything. Every render saved via POST /__save-render " +
      "is scored against the reference automatically — the score comes back in the save " +
      "response and lands in renders/<name>.score.json; log each pass in RECON.md and fix " +
      "the largest error first.",
  };
}
