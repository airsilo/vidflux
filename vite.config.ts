import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
// @ts-expect-error type error without @types/node package
import process from "node:process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const host = process.env.TAURI_DEV_HOST;

const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));

export default defineConfig(() => ({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // Ignore the entire Rust build folder — Vite can't watch locked DLLs on Windows.
      ignored: [
        "**/src-tauri/**",
        "**/target/**",
      ],
    },
  },
}));