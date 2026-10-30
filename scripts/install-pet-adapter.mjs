import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { planAdapter } from "./pet-adapter-plan.mjs";
const target = path.resolve(process.argv[2] || "");
if (!process.argv[2])
  throw Error(
    "用法：node scripts/install-pet-adapter.mjs <现有 dsh-pet 包目录> [--check]",
  );
if (
  JSON.parse(fs.readFileSync(path.join(target, "package.json"), "utf8"))
    .name !== "dsh-pet"
)
  throw Error("目标必须为现有 dsh-pet 包");
const manifest = JSON.parse(
  fs.readFileSync(
    new URL("../integrations/dsh-pet/adapter.json", import.meta.url),
    "utf8",
  ),
);
const pending = planAdapter(target, manifest);
if (process.argv.includes("--check")) {
  console.log("适配检查通过，需要更新 " + pending.length + " 个文件");
  process.exit(0);
}
const backup = path.join(
  os.homedir(),
  ".dsh",
  "elevenlabs-voice",
  "adapter-backups",
  new Date().toISOString().replaceAll(":", "-"),
);
for (const item of pending) {
  const out = path.join(backup, item.name);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, item.original);
  fs.mkdirSync(path.dirname(item.file), { recursive: true });
  fs.writeFileSync(item.file, item.current);
}
console.log("适配完成；保留现有角色和配置。备份：" + backup);
if (pending.length) {
  for (const args of [
    ["run", "typecheck"],
    ["run", "lint"],
    ["test"],
    ["run", "check:openapi"],
    ["run", "build"],
  ])
    execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
      cwd: target,
      stdio: "inherit",
      shell: process.platform === "win32",
    });
}
console.log("请重载统一语音插件和现有 dsh-pet，或重启 DSH。");
