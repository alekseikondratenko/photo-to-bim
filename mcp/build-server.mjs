/**
 * Bundle the server to one self-contained ESM file for the plugin.
 *
 * A build script rather than an npm one-liner because the CJS-interop banner
 * needs single quotes inside a JSON string, and escaping those through
 * package.json once produced a bundle whose first line was a syntax error —
 * caught only when the shipped artifact refused to boot.
 */
import { build } from 'esbuild';

await build({
  entryPoints: ['main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile: 'dist/server.mjs',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  logLevel: 'warning',
});
console.log('dist/server.mjs built');
