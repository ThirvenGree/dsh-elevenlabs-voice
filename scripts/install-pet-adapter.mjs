import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
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
const allowed = new Set([
  "src/host/index.ts",
  "src/client/pet.ts",
  "src/shared/menu.ts",
  "src/shared/index.ts",
  "runtime/electron-helper/sprite.js",
  "src/client/settings.ts",
  "../API.md",
  "../CONFIG.md",
  "../openapi.yaml",
  "src/host/voice-stream.ts",
  "src/host/voice-stream.test.ts",
  "src/shared/voice-panel.ts",
]);
const pending = [];
for (const item of manifest.files) {
  if (!allowed.has(item.file)) throw Error("适配清单存在未授权路径");
  const file = path.resolve(target, item.file);
  let current = fs.existsSync(file)
    ? fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n")
    : "";
  const original = current;
  if (item.create) {
    if (current && current !== item.create)
      throw Error("新模块已经存在且内容不同：" + item.file);
    current = item.create;
  } else
    for (const edit of item.edits) {
      if (current.includes(edit.after)) continue;
      const parts = current.split(edit.before);
      if (parts.length !== 2)
        throw Error("源码与适配版本不符，未改写任何文件：" + item.file);
      current = parts.join(edit.after);
    }
  if (current !== original)
    pending.push({
      file,
      original,
      current,
      name: item.file.replaceAll("../", "outer/"),
    });
}
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
