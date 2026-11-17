import { cloudflare } from "@cloudflare/vite-plugin";
import { sentryTanstackStart } from "@sentry/tanstackstart-react/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const uploadSourceMaps = Boolean(env.SENTRY_AUTH_TOKEN && env.SENTRY_ORG && env.SENTRY_PROJECT);
  return {
    plugins: [
      cloudflare({ viteEnvironment: { name: "ssr" } }),
      tanstackStart({ spa: { enabled: true, maskPath: "/read" } }),
      react(),
      sentryTanstackStart({
        org: env.SENTRY_ORG,
        project: env.SENTRY_PROJECT?.split(",").map(project => project.trim()).filter(Boolean),
        authToken: env.SENTRY_AUTH_TOKEN,
        sentryUrl: env.SENTRY_URL || "https://sentry.io/",
        telemetry: false,
        autoInstrumentMiddleware: false,
        sourcemaps: { disable: !uploadSourceMaps },
      }),
    ],
    server: { host: "127.0.0.1", port: 8787, strictPort: true },
  };
});
