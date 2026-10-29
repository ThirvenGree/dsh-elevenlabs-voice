import { build } from "esbuild";
await build({
  entryPoints: ["src/client.js"],
  outfile: "lib/client.js",
  bundle: true,
  format: "iife",
  target: "chrome120",
  sourcemap: false,
});
await build({
  entryPoints: ["src/pet-client.js"],
  outfile: "lib/pet-client.js",
  bundle: true,
  format: "iife",
  target: "chrome120",
  sourcemap: false,
  minify: true,
});
