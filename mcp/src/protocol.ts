/**
 * Constants shared by the server and the panel.
 *
 * Kept in its own module because the panel is browser code: importing them
 * from server.ts would drag node:fs and express into the View bundle.
 */

/**
 * Namespaced `_meta` key on the `get_viewer_bundle` result carrying the
 * inlined viewer document.
 *
 * It travels in `_meta` rather than `content` on purpose. `visibility:
 * ["app"]` is advisory — the SDK does not filter `tools/list` — so on a host
 * that ignores it an agent can call the tool. Keeping the payload out of the
 * agent-facing fields means the worst case is a short summary rather than
 * several megabytes of HTML pasted into the conversation.
 */
export const BUNDLE_META = "io.aecfoundry.photo-to-threejs/viewer-bundle";
