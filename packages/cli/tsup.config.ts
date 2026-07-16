import { defineConfig } from "tsup";
import path from "node:path";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  noExternal: [/^@runharness\//],
  esbuildOptions(options) {
    options.alias = {
      "@runharness/core": path.resolve("../core/src/index.ts"),
      "@runharness/development": path.resolve("../development/src/index.ts"),
      "@runharness/providers": path.resolve("../providers/src/index.ts"),
      "@runharness/server": path.resolve("../../apps/server/src/index.ts"),
      "@runharness/shared": path.resolve("../shared/src/index.ts"),
    };
  },
});
