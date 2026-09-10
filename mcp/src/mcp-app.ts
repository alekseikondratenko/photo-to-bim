/**
 * The MCP App panel: a window onto the real viewer.
 *
 * Rendering path, in order of preference:
 *
 *  1. `srcdoc` — the panel asks the server (over the app→server channel, so
 *     the payload never touches the model's context) for the viewer inlined
 *     into one self-contained document and writes it straight into the frame.
 *     No origin, no port, no network: none of the gates that can blank a
 *     cross-origin localhost iframe apply.
 *  2. `src` — the localhost URL, kept for viewer directories too large to
 *     inline and as evidence when path 1 fails.
 *
 * Still ONE viewer implementation: both paths show the same built directory,
 * so the panel can never drift from what the browser shows.
 *
 * Failure honesty: a CSP-blocked iframe still fires `load`, so path 2 cannot
 * detect its own blankness (field-tested). Path 1 can — if the bundle call
 * throws, we say which path we fell back to and why, and always keep
 * open-in-browser reachable. Never a silent blank.
 */
import { App, applyDocumentTheme, type McpUiHostContext } from "@modelcontextprotocol/ext-apps";
import { BUNDLE_META } from "./protocol.ts";
import "./mcp-app.css";

const statusEl = document.getElementById("status")!;
const openBtn = document.getElementById("open-btn") as HTMLButtonElement;
const sizeBtn = document.getElementById("size-btn") as HTMLButtonElement;
const frame = document.getElementById("viewer") as HTMLIFrameElement;
const emptyEl = document.getElementById("empty")!;

const setStatus = (t: string) => { statusEl.textContent = t; };

let viewerUrl: string | undefined;

const app = new App({ name: "photo-to-threejs viewer", version: "0.4.0" });

/** Path 2 — the original cross-origin iframe, now only a fallback. */
function showByUrl(url: string, why: string) {
  emptyEl.hidden = true;
  frame.removeAttribute("srcdoc");
  frame.src = url;
  setStatus(`${why} — embedding ${url}; blank frame? use open in browser`);
}

/** Path 1 — self-contained document, no network involved. */
function showBundle(html: string, bytes: number) {
  emptyEl.hidden = true;
  frame.removeAttribute("src");
  frame.srcdoc = html;
  setStatus(`viewer inlined (${(bytes / 1e6).toFixed(1)} MB) — no localhost embed needed`);
}

async function render(dir: string | undefined, url: string | undefined) {
  viewerUrl = url;
  openBtn.hidden = !url;
  emptyEl.hidden = true;

  if (!dir) {
    if (url) showByUrl(url, "server sent no directory");
    return;
  }

  setStatus("inlining viewer…");
  try {
    const res = await app.callServerTool({ name: "get_viewer_bundle", arguments: { dir } });
    // The document rides in `_meta`, not in `content`: the agent-facing fields
    // deliberately carry only a summary, so a host that ignores app-only
    // visibility still cannot leak megabytes of HTML into the conversation.
    const payload = (res._meta as Record<string, { html?: string; bytes?: number }> | undefined)?.[BUNDLE_META];
    if (res.isError || !payload?.html) {
      const block = res.content?.find((c) => c.type === "text") as { text?: string } | undefined;
      throw new Error(block?.text ?? "no bundle in result metadata");
    }
    showBundle(payload.html, payload.bytes ?? payload.html.length);
  } catch (e) {
    // The host may withhold app→server tool calls, or the bundle may exceed
    // the panel limit. Either way the URL still works — say which happened.
    if (url) showByUrl(url, `inline failed (${String(e).slice(0, 80)})`);
    else setStatus(`inline failed and no URL to fall back to: ${String(e)}`);
  }
}

app.ontoolresult = (result) => {
  const sc = result.structuredContent as { viewerUrl?: string; dir?: string } | undefined;
  if (sc?.viewerUrl || sc?.dir) void render(sc?.dir, sc?.viewerUrl);
};

app.onhostcontextchanged = (ctx: McpUiHostContext) => {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  const other = ctx.displayMode === "fullscreen" ? "inline" : "fullscreen";
  sizeBtn.hidden = !(ctx.availableDisplayModes?.includes(other) ?? false);
  sizeBtn.textContent = other;
};

openBtn.addEventListener("click", async () => {
  if (!viewerUrl) return;
  const { isError } = await app.openLink({ url: viewerUrl });
  if (isError) setStatus("host refused to open the link — copy it: " + viewerUrl);
});

sizeBtn.addEventListener("click", async () => {
  const target = sizeBtn.textContent as "inline" | "fullscreen";
  const { mode } = await app.requestDisplayMode({ mode: target });
  sizeBtn.textContent = mode === "fullscreen" ? "inline" : "fullscreen";
});

app.onerror = (e) => setStatus(`app error: ${String(e)}`);

app
  .connect()
  .then(() => {
    setStatus("connected — call open_viewer");
    const ctx = app.getHostContext();
    if (ctx?.theme) applyDocumentTheme(ctx.theme);
  })
  .catch(() => setStatus("no MCP host — standalone preview"));
