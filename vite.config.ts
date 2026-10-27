import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// BASE_PATH lets the same build serve from a sub-path, e.g. GitHub Pages "/ayah-live/".
export default defineConfig({
  base: process.env.BASE_PATH ?? "./",
  plugins: [react()],
  worker: { format: "es" },
  build: {
    target: "es2022",
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 2000,
  },
  optimizeDeps: { exclude: ["onnxruntime-web"] },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
} as never);
