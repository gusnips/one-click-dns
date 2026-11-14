import { defineConfig } from "tsdown";

// Same files and names tsup made: ESM as .js and .d.ts, CJS as .cjs and .d.cts.
export default defineConfig({
  entry: ["src/index.ts", "src/server/index.ts", "src/writers/index.ts"],
  format: ["cjs", "esm"],
  dts: true,
  target: "es2022",
  outExtensions: ({ format }) =>
    format === "cjs" ? { js: ".cjs", dts: ".d.cts" } : { js: ".js", dts: ".d.ts" },
});
