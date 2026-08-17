import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

const remoteApi = process.env.VITE_DEV_PROXY_TARGET || "https://xensemble.dev";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3889,
    proxy: {
      "/api": { target: remoteApi, changeOrigin: true },
      "/ws": { target: remoteApi, changeOrigin: true, ws: true },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  optimizeDeps: {
    include: ["monaco-editor"],
  },
  build: {
    // 拆分大依赖（特别是 monaco-editor，单文件就几 MB）到独立 chunk，避免主 bundle 过大导致 vite 转换/打包时内存峰值爆 OOM
    chunkSizeWarningLimit: 5000,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if (id.includes("monaco-editor")) return "monaco-editor";
          if (id.includes("node_modules/react/") || id.includes("node_modules/scheduler/")) return "react-vendor";
          if (id.includes("node_modules/") && id.includes("lucide-react")) return "lucide-react";
          return undefined;
        },
      },
    },
  },
});
