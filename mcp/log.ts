/**
 * Phase 0 test 4 instrumentation.
 *
 * When a host calls the tool but shows no panel, there are two very different
 * causes and no way to tell them apart from the chat transcript:
 *
 *   a) the host never declared the MCP Apps client capability, so it does not
 *      know the tool has a View at all; or
 *   b) it declared it, read the ui:// resource, and then failed to render.
 *
 * The difference is visible only in the handshake, so write it to a file.
 * stderr is not usable here — hosts bury or discard an MCP server's stderr.
 */
import fs from "node:fs";
import path from "node:path";

const LOG = path.join(import.meta.dirname, "handshake.log");

export function logHandshake(label: string, data: unknown) {
  fs.appendFileSync(LOG, `[${new Date().toISOString()}] ${label} ${JSON.stringify(data ?? null)}\n`);
}
