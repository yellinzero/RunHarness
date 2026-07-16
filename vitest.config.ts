import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@runharness/shared": path.resolve("packages/shared/src/index.ts"),
      "@runharness/core": path.resolve("packages/core/src/index.ts"),
      "@runharness/providers": path.resolve("packages/providers/src/index.ts"),
      "@runharness/development": path.resolve("packages/development/src/index.ts"),
      "@runharness/server": path.resolve("apps/server/src/index.ts"),
    },
  },
  test: {
    include: ["packages/**/*.test.ts", "apps/server/**/*.test.ts"],
    maxWorkers: 4,
    coverage: { reporter: ["text", "html"] }
  }
});
