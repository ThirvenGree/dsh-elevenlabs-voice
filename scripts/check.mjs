import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
for (const file of readdirSync(new URL("../src/", import.meta.url)).filter(
  (f) => f.endsWith(".js"),
))
  execFileSync(
    process.execPath,
    ["--check", fileURLToPath(new URL("../src/" + file, import.meta.url))],
    { stdio: "inherit" },
  );
