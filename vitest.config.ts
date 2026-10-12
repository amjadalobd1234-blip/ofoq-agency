import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    environment: "node",
    // .tsx as well: the staff alert centre is covered by tests that render the
    // real components (see tests/admin-alert-reply-e2e.test.tsx).
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    globals: false,
    pool: "forks",
    reporters: ["default"],
    setupFiles: ["tests/setup.ts"],
    testTimeout: 20_000,
  },
  // App Router components rely on the automatic JSX runtime (Next.js compiles
  // them that way); tsconfig has `"jsx": "preserve"`, so tests must opt in.
  esbuild: { jsx: "automatic" },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
