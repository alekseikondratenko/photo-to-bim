import fs from "node:fs";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createIfcServer } from "./ifc-server.ts";
import { evaluate } from "./src/evaluate.ts";
try {
  if (process.argv.includes("--evaluate-json")) {
    const req = JSON.parse(fs.readFileSync(0, "utf8"));
    process.stdout.write(JSON.stringify(evaluate(req)) + "\n");
  } else {
    const server = createIfcServer();
    await server.connect(new StdioServerTransport());
  }
} catch (e) {
  console.error(String(e));
  process.exitCode = 1;
}
