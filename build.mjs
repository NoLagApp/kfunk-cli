import { build } from "esbuild";

const shared = {
  bundle: true,
  platform: "node",
  target: "node20",
  format: "esm",
  sourcemap: false,
  banner: {
    js: `import { createRequire } from 'module'; const require = createRequire(import.meta.url);`,
  },
};

await Promise.all([
  build({
    ...shared,
    entryPoints: ["src/worker/server.ts"],
    outfile: "dist/worker/index.js",
    external: [],
  }),
  build({
    ...shared,
    entryPoints: ["src/cli/index.ts"],
    outfile: "dist/cli/index.js",
  }),
  build({
    ...shared,
    entryPoints: ["src/core/index.ts"],
    outfile: "dist/core/index.js",
  }),
]);

console.log("Build complete");
