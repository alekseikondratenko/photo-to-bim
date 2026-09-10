import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

// The View must be ONE self-contained HTML file: it is delivered as an MCP
// resource, not served from an origin, so it cannot fetch sibling assets.
export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    rollupOptions: { input: "mcp-app.html" },
    outDir: "dist",
    emptyOutDir: false,
    // Three.js is ~600KB minified; singlefile inlines it, so raise the warn cap.
    chunkSizeWarningLimit: 2000,
  },
});
