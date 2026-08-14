import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.spec.{ts,tsx}"],
    testTimeout: 30_000,
    server: {
      deps: {
        // The DSH web client packages ship browser bundles that import CSS
        // (e.g. katex); vitest must inline them through Vite so those imports
        // are stubbed instead of hitting Node's native loader.
        inline: [/@deepseek-ai\/dsh-client/, /katex/],
      },
    },
  },
});
