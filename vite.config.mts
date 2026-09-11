import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// The 127.0.0.1:5173 exception exists only for `npm run dev` (Vite HMR).
// Strip it from production builds so the packaged app keeps a tight CSP.
function productionCsp(): Plugin {
  return {
    name: "production-csp",
    apply: "build",
    transformIndexHtml(html: string): string {
      return html.replace("connect-src 'self' http://127.0.0.1:5173 ws://127.0.0.1:5173", "connect-src 'self'");
    },
  };
}

export default defineConfig({
  base: "./",
  plugins: [react(), productionCsp()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
