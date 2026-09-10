/**
 * Inline a built viewer directory into ONE self-contained HTML string.
 *
 * Why this exists: the panel used to iframe the viewer from
 * `http://127.0.0.1:<port>`, and that load has four independent gates, each
 * able to blank the frame with no observable signal from inside the panel —
 * the host honouring the declared `frameDomains`, the http scheme surviving
 * inside a secure-context sandbox, Chromium's private-network blocking of a
 * public page embedding 127.0.0.1, and the served port matching what the CSP
 * declared. Field-tested: the panel rendered, the frame stayed white, and a
 * CSP-blocked iframe still fires `load`, so the panel could not even tell the
 * user which gate had shut.
 *
 * A `srcdoc` document has none of those gates: no origin, no port, no network.
 * So the fix is not to negotiate with the gates but to stop needing them.
 *
 * The cost is honest and bounded: everything must be inlined, so a runtime
 * `fetch` of a sibling file cannot work. Assets loaded at runtime by path
 * (the viewer sets `refimg.src` from JS) are handled by an asset map plus a
 * small shim; anything not in the map falls through untouched and fails
 * exactly as loudly as it would have before.
 */
import fs from "node:fs";
import path from "node:path";

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".json": "application/json",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
  ".bin": "application/octet-stream",
  ".hdr": "image/vnd.radiance",
  ".exr": "image/x-exr",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
};

/** Refuse rather than hand a host a payload it will drop on the floor. */
const MAX_BYTES = 24 * 1024 * 1024;

const mimeFor = (file: string) => MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream";

const dataUri = (file: string) =>
  `data:${mimeFor(file)};base64,${fs.readFileSync(file).toString("base64")}`;

/**
 * Resolve a document-relative reference to a real file inside `dir`.
 * Returns null for anything remote, already-inline, or escaping the directory
 * — a viewer directory is untrusted input like any other path argument.
 */
function resolveLocal(dir: string, ref: string): string | null {
  if (!ref || /^(https?:|data:|blob:|about:|mailto:|#|\/\/)/i.test(ref)) return null;
  const clean = ref.split(/[?#]/)[0];
  if (!clean) return null;
  const root = path.resolve(dir);
  const abs = path.resolve(root, clean.startsWith("/") ? `.${clean}` : clean);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  try {
    return fs.statSync(abs).isFile() ? abs : null;
  } catch {
    return null;
  }
}

/** `</script>` inside inlined JS would close the wrapper element early. */
const guard = (js: string) => js.replace(/<\/script/gi, "<\\/script");

/** Rewrite `url(...)` inside a stylesheet to data URIs. */
function inlineCssUrls(css: string, dir: string, seen: Set<string>): string {
  return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (whole, _q, ref: string) => {
    const file = resolveLocal(dir, ref);
    if (!file) return whole;
    seen.add(file);
    return `url("${dataUri(file)}")`;
  });
}

export interface ViewerBundle {
  html: string;
  bytes: number;
  /** Files folded into the document, relative to the viewer directory. */
  inlined: string[];
  /** Referenced but not found on disk — the honest "this will 404" list. */
  missing: string[];
  /** Runtime-loadable assets exposed through the shim map. */
  mapped: string[];
  /** Assets too large to carry — named, never silently dropped. */
  skipped: string[];
}

/**
 * Build the self-contained document for a viewer directory.
 * Throws if there is no index.html — same contract as the localhost server.
 */
export function inlineViewer(dir: string): ViewerBundle {
  const root = path.resolve(dir);
  const indexPath = path.join(root, "index.html");
  if (!fs.existsSync(indexPath)) {
    throw new Error(
      `${root} has no index.html — for a vite workspace, run \`npm run build\` and pass its dist/ directory`,
    );
  }

  let html = fs.readFileSync(indexPath, "utf-8");
  const inlined = new Set<string>();
  const missing: string[] = [];

  const note = (ref: string, file: string | null) => {
    if (file) inlined.add(file);
    else if (!/^(https?:|data:|blob:|about:|mailto:|#|\/\/)/i.test(ref)) missing.push(ref);
  };

  // Stylesheets first: their url() references may pull further assets.
  html = html.replace(
    /<link\b[^>]*\brel=(['"]?)stylesheet\1[^>]*>/gi,
    (tag) => {
      const href = /\bhref=(['"])(.*?)\1/i.exec(tag)?.[2] ?? /\bhref=([^\s>]+)/i.exec(tag)?.[1];
      if (!href) return tag;
      const file = resolveLocal(root, href);
      note(href, file);
      if (!file) return tag;
      const css = inlineCssUrls(fs.readFileSync(file, "utf-8"), path.dirname(file), inlined);
      return `<style>\n${css}\n</style>`;
    },
  );

  // Existing inline <style> blocks can carry url() references too.
  html = html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (whole, css: string) =>
    whole.replace(css, inlineCssUrls(css, root, inlined)),
  );

  // Scripts: keep type="module" — the viewer bundle is ESM and drops its
  // top-level await and import.meta if downgraded to a classic script.
  html = html.replace(/<script\b([^>]*)\bsrc=(['"])(.*?)\2([^>]*)>\s*<\/script>/gi, (tag, pre: string, _q, src: string, post: string) => {
    const file = resolveLocal(root, src);
    note(src, file);
    if (!file) return tag;
    const attrs = `${pre} ${post}`;
    const isModule = /\btype=(['"]?)module\1/i.test(attrs);
    return `<script${isModule ? ' type="module"' : ""}>\n${guard(fs.readFileSync(file, "utf-8"))}\n</script>`;
  });

  // Remaining static src=/href= attributes (images, favicons, preloads).
  html = html.replace(/\b(src|href)=(['"])(.*?)\2/gi, (whole, attr: string, q: string, ref: string) => {
    if (!ref || ref.startsWith("data:")) return whole;
    const file = resolveLocal(root, ref);
    if (!file) return whole;
    inlined.add(file);
    return `${attr}=${q}${dataUri(file)}${q}`;
  });

  // Assets the app loads at runtime by path (the HUD reference photograph is
  // assigned from JS, so no static rewrite can catch it). Expose every
  // not-yet-inlined loadable file under both its absolute and relative URL.
  //
  // Bounded deliberately. A viewer directory is often a source tree rather
  // than a dist/ — the first field call passed one — and walking it naively
  // swallowed node_modules whole: a 0.7 MB self-contained viewer came back as
  // a 17 MB bundle of typeface JSON and package manifests. Skip dependency
  // and dot directories, and cap what any single asset may contribute.
  const SKIP_DIRS = new Set(["node_modules", "dist-ssr", "coverage", "__pycache__"]);
  const MAX_ASSET_BYTES = 8 * 1024 * 1024;
  // Keys point at INDICES into a URI table, not at the URIs themselves: each
  // asset is reachable under three spellings (/a.jpg, a.jpg, ./a.jpg) and
  // storing the base64 once per spelling tripled the payload.
  const uris: string[] = [];
  const mapped: Record<string, number> = {};
  const mappedNames: string[] = [];
  const skipped: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const abs = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(abs);
        continue;
      }
      if (!entry.isFile() || inlined.has(abs)) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!(ext in MIME)) continue;
      const rel = path.relative(root, abs).split(path.sep).join("/");
      if (fs.statSync(abs).size > MAX_ASSET_BYTES) {
        skipped.push(rel);
        continue;
      }
      const at = uris.push(dataUri(abs)) - 1;
      mapped[`/${rel}`] = at;
      mapped[rel] = at;
      mapped[`./${rel}`] = at;
      mappedNames.push(rel);
    }
  };
  walk(root);

  if (mappedNames.length) {
    // Runs before the app script: rewrite image loads whose path is in the
    // map. Unmapped paths pass through unchanged — the shim never invents an
    // asset, it only substitutes one it actually holds.
    const shim = `<script>(function(){var A=${JSON.stringify(mapped)},U=${JSON.stringify(uris)};
var pick=function(v){if(typeof v!=="string"||!v||v.slice(0,5)==="data:")return v;
if(v in A)return U[A[v]];try{var p=new URL(v,"http://viewer.invalid/").pathname;if(p in A)return U[A[p]];}catch(e){}return v;};
var d=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,"src");
if(d&&d.set){Object.defineProperty(HTMLImageElement.prototype,"src",{configurable:true,enumerable:d.enumerable,
get:function(){return d.get.call(this);},set:function(v){d.set.call(this,pick(v));}});}
var sa=Element.prototype.setAttribute;Element.prototype.setAttribute=function(n,v){
return sa.call(this,n,(n==="src"||n==="href")?pick(v):v);};
var f=window.fetch;if(f)window.fetch=function(i,o){var u=(typeof i==="string")?pick(i):i;return f.call(this,u,o);};
})();</script>`;
    html = /<head\b[^>]*>/i.test(html)
      ? html.replace(/<head\b[^>]*>/i, (h) => `${h}\n${shim}`)
      : `${shim}\n${html}`;
  }

  const bytes = Buffer.byteLength(html, "utf-8");
  if (bytes > MAX_BYTES) {
    throw new Error(
      `Inlined viewer is ${(bytes / 1e6).toFixed(1)} MB, over the ${MAX_BYTES / 1e6} MB panel limit — ` +
      `shrink the reference/texture assets, or use the returned localhost URL in a browser instead`,
    );
  }

  return {
    html,
    bytes,
    inlined: [...inlined].map((f) => path.relative(root, f).split(path.sep).join("/")),
    missing: [...new Set(missing)],
    mapped: mappedNames,
    skipped,
  };
}
