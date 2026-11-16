import { cloudflare } from "@cloudflare/vite-plugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    cloudflare({ viteEnvironment: { name: "ssr" } }),
    tanstackStart({ spa: { enabled: true, maskPath: "/read" } }),
    react(),
  ],
  server: { host: "127.0.0.1", port: 8787, strictPort: true },
});
