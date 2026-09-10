/**
 * Localhost static server for viewer directories.
 *
 * Serves a built viewer (any directory with an index.html) so the MCP panel
 * can iframe it and the `open in browser` button has a destination. Hosts
 * that render no panel (Claude Code today) still get a working viewer via
 * the returned URL — the fallback is the default path, not the contingency.
 *
 * Port policy: prefer 5199 (the panel's CSP frame allowance is declared
 * against it — CSP is static, ports are not), probe upward if taken. Never
 * 5173: Docker shadows it on IPv6 on at least one machine, silently.
 */
import express from "express";
import type { Server } from "node:http";
import fs from "node:fs";
import path from "node:path";

export const PREFERRED_PORT = 5199;
const ATTEMPTS = 20;

const running = new Map<string, string>();

function listen(app: express.Express, port: number): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, "127.0.0.1");
    server.once("listening", () => resolve(server));
    server.once("error", reject);
  });
}

/** Serve `dir` statically; returns the URL. One server per directory. */
export async function ensureViewerServer(dir: string): Promise<string> {
  const key = path.resolve(dir);
  const existing = running.get(key);
  if (existing) return existing;

  if (!fs.existsSync(path.join(key, "index.html"))) {
    throw new Error(
      `${key} has no index.html — for a vite workspace, run \`npm run build\` and pass its dist/ directory`,
    );
  }

  const app = express();
  // Chromium blocks a page on a public/secure origin from reaching a private
  // address (127.0.0.1) unless the target opts in via a Private Network Access
  // preflight. That block is invisible from inside an iframe, so it is one of
  // the candidate causes of the blank panel; these headers remove it as a
  // suspect and also unblock a browser tab fetching /__save-render.
  app.use((req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    if (req.method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "*");
      res.setHeader("Access-Control-Max-Age", "600");
      res.status(204).end();
      return;
    }
    next();
  });
  app.use(express.static(key));

  for (let i = 0; i < ATTEMPTS; i++) {
    const port = PREFERRED_PORT + i;
    try {
      await listen(app, port);
      const url = `http://127.0.0.1:${port}/`;
      running.set(key, url);
      return url;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "EADDRINUSE") continue;
      throw e;
    }
  }
  throw new Error(`No free port in ${PREFERRED_PORT}–${PREFERRED_PORT + ATTEMPTS - 1}`);
}
