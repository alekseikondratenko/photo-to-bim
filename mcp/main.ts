/**
 * Entry point. `--stdio` for local host config (Claude Code / Desktop);
 * default is Streamable HTTP so the ext-apps `basic-host` harness can drive it
 * from a browser, which is how the spike gets a screenshot.
 */
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import type { Request, Response } from "express";
import { logHandshake } from "./log.ts";
import { createServer } from "./server.ts";

async function startHttp() {
  // 3001 is what the ext-apps `basic-host` harness probes by default, so the
  // spike needs no env config to be testable. (Never 5173 — Docker shadows it
  // on IPv6 on this machine; see PLAN.)
  const port = parseInt(process.env.PORT ?? "3001", 10);
  const app = createMcpExpressApp({ host: "0.0.0.0" });
  app.use(cors());

  app.all("/mcp", async (req: Request, res: Response) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP error:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  app.listen(port, () => console.log(`MCP spike listening on http://localhost:${port}/mcp`));
}

async function main() {
  if (process.argv.includes("--stdio")) {
    // Nothing may touch stdout on this path — it is the JSON-RPC channel.
    const mcp = createServer();
    const transport = new StdioServerTransport();
    await mcp.connect(transport);

    // Log the RAW inbound JSON, not the parsed request. `getClientCapabilities()`
    // is useless for this question: the SDK's zod schema strips unknown keys, so
    // a client declaring the MCP Apps capability reads back as `{}`. The only
    // place the truth survives is the unparsed message.
    //
    // `onmessage` is typed as taking only the message in this SDK version, so
    // forward with `...args` rather than naming a second parameter.
    const inner = transport.onmessage!.bind(transport);
    transport.onmessage = (...args: Parameters<typeof inner>) => {
      const method = (args[0] as { method?: string }).method;
      if (method === "initialize" || method === "resources/read") {
        logHandshake(`raw ${method}`, args[0]);
      }
      inner(...args);
    };
  } else {
    await startHttp();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
