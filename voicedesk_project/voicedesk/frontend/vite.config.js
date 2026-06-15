import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@/components": path.resolve(__dirname, "./src/components"),
      "@/pages": path.resolve(__dirname, "./src/pages"),
      "@/contexts": path.resolve(__dirname, "./src/contexts"),
      "@/i18n": path.resolve(__dirname, "./src/i18n"),
      "@/styles": path.resolve(__dirname, "./src/styles"),
      "@/utils": path.resolve(__dirname, "./src/utils"),
      "@shared": path.resolve(__dirname, "../shared"),
    },
  },
  server: {
    port: 3000,
    host: true,
    strictPort: true,
    allowedHosts: true,
    hmr: false,
    proxy: {
      "/api": "http://localhost:8001",
      "/webhooks": "http://localhost:8001",
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
