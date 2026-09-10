/**
 * Cross-subject regression. Run before every push: `npm test` in mcp/.
 *
 * The standing requirement is that tuning for one subject class must not
 * silently regress another. These five photographs are deliberately unlike
 * each other — two towers against sky, a wide low landmark, a curved sail over
 * water, and a wide occluded house — and every fix carries a check here.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const HERE = import.meta.dirname;
const MCP = path.resolve(HERE, '..');
const REPO = path.resolve(MCP, '..');

const PHOTOS = {
  empirestate: `${MCP}/test/photos/reference-empirestate.jpg`,
  taipei101: `${MCP}/test/photos/reference-taipei101.jpg`,
  whitehouse: `${MCP}/test/photos/reference-whitehouse.jpg`,
  burj: '/Users/alexbest/Desktop/skill-test/p3050792a.jpg',
  house: '/Users/alexbest/Desktop/mcp-test-3/house.jpg',
};

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS  ${name}`); }
  else { fail++; console.log(`  FAIL  ${name} ${detail}`); }
};

const tsx = (file, args = []) =>
  execFileSync('npx', ['tsx', file, ...args], { cwd: MCP, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024 });

console.log('\n== 1. scorer identity (every photo vs itself: zero error, both axes) ==');
const idOut = tsx(path.join(HERE, 'cases', 'identity.ts'), Object.values(PHOTOS));
for (const line of idOut.trim().split('\n')) {
  const [name, edge, sky, cols, wseg] = line.split(/\s+/);
  ok(`${name}: identity edge=${edge} skyline=${sky} (${cols} cols)`, edge === '0' && sky === '0');
  ok(`${name}: identity localises nothing (worst_segments null)`, wseg === 'null', `(got ${wseg})`);
}

console.log('\n== 2. classify sanity + house auto-crop ==');
const clOut = tsx(path.join(HERE, 'cases', 'classify.ts'), Object.entries(PHOTOS).flat());
for (const line of clOut.trim().split('\n')) {
  const [name, rows, auto] = line.split(/\s+/);
  if (name === 'house') ok(`house full-frame blind -> auto-crop fires (${rows} rows)`, auto === 'true' && +rows > 100);
  else ok(`${name}: ${rows} bounded rows without help`, +rows > 100, `(got ${rows})`);
}

console.log('\n== 3. solver: synthetic exact, field label shapes, shifted-lens guard ==');
const svOut = tsx(path.join(HERE, 'cases', 'solver.ts'));
for (const line of svOut.trim().split('\n')) {
  const [name, verdict, detail] = line.split('|');
  ok(name.trim(), verdict.trim() === 'PASS', detail ?? '');
}

console.log('\n== 4. crop normalisation (the six field shapes) ==');
const crOut = tsx(path.join(HERE, 'cases', 'crops.ts'));
for (const line of crOut.trim().split('\n')) {
  const [name, verdict, detail] = line.split('|');
  ok(name.trim(), verdict.trim() === 'PASS', detail ?? '');
}

console.log('\n== 5. unproject round-trip ==');
const upOut = tsx(path.join(HERE, 'cases', 'unproject.ts'));
for (const line of upOut.trim().split('\n')) {
  const [name, verdict, detail] = line.split('|');
  ok(name.trim(), verdict.trim() === 'PASS', detail ?? '');
}

console.log('\n== 6. IFC helpers (both shape classes) — needs a python with ifcopenshell ==');
{
  const py = process.env.IFC_PYTHON ?? 'python3';
  let has = false;
  try { execFileSync(py, ['-c', 'import ifcopenshell'], { stdio: 'ignore' }); has = true; } catch { /* not installed */ }
  if (!has) {
    console.log('  SKIP  no ifcopenshell in ' + py + ' (set IFC_PYTHON=/path/to/python to run)');
  } else {
    try {
      const out = execFileSync(py, [path.join(HERE, 'cases', 'ifc_helpers.py')], { encoding: 'utf-8' });
      ok('ifc helpers: house + tower + gate semantics', /ALL HELPER CHECKS PASS/.test(out), out.slice(-200));
    } catch (e) {
      ok('ifc helpers: house + tower + gate semantics', false, String(e.stdout ?? e).slice(-300));
    }
  }
}

console.log(`\n${fail === 0 ? 'ALL GREEN' : 'REGRESSION'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
