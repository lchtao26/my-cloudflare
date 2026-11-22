import * as Sentry from "@sentry/tanstackstart-react";
import { sentryDataCollection, tracesSampleRate } from "./sentry-options.ts";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  const router = createRouter({
    routeTree,
    defaultOnCatch: (error, info) => {
      Sentry.captureException(error, { contexts: { react: { componentStack: info.componentStack } } });
    },
  });
  if (!router.isServer && !Sentry.isInitialized() && import.meta.env.VITE_SENTRY_DSN) {
    Sentry.init({
      dsn: import.meta.env.VITE_SENTRY_DSN,
      tunnel: true,
      environment: import.meta.env.MODE,
      integrations: [Sentry.tanstackRouterBrowserTracingIntegration(router)],
      tracesSampleRate: import.meta.env.DEV ? 1 : tracesSampleRate(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE),
      tracePropagationTargets: [/^\/(?!\/)/],
      dataCollection: sentryDataCollection,
    });
  }
  return router;
}

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
