import { serveTunnelIntegration, type CloudflareOptions } from "@sentry/cloudflare";
import { sentryDataCollection, tracesSampleRate } from "./sentry-options.ts";

export function sentryOptions(env: Env): CloudflareOptions {
  const dsn = env.SENTRY_DSN;
  return {
    dsn,
    enabled: Boolean(dsn),
    integrations: [
      serveTunnelIntegration({
        allowedDsns: import.meta.env.VITE_SENTRY_DSN ? [import.meta.env.VITE_SENTRY_DSN] : [],
      }),
    ],
    environment: import.meta.env.DEV ? "development" : env.SENTRY_ENVIRONMENT,
    tracesSampleRate: import.meta.env.DEV ? 1 : tracesSampleRate(env.SENTRY_TRACES_SAMPLE_RATE),
    dataCollection: sentryDataCollection,
  };
}
