import { build } from "esbuild";
await build({
  entryPoints: ["src/client.js"],
  outfile: "lib/client.js",
  bundle: true,
  format: "iife",
  target: "chrome120",
  sourcemap: false,
});
