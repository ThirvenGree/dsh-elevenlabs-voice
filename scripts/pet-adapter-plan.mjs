import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const ALLOWED_FILES = new Set([
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

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/**
 * Works out which files the adapter would change, without writing anything.
 * Edits apply only where their exact "before" snippet occurs once; a module
 * the adapter creates is replaced only when it still holds a version an
 * earlier adapter wrote (listed by hash in "replaces"), never a local edit.
 */
export function planAdapter(target, manifest) {
  const pending = [];
  for (const item of manifest.files) {
    if (!ALLOWED_FILES.has(item.file)) throw Error("适配清单存在未授权路径");
    const file = path.resolve(target, item.file);
    const original = fs.existsSync(file)
      ? fs.readFileSync(file, "utf8").replaceAll("\r\n", "\n")
      : "";
    let current = original;
    if (item.create) {
      if (
        current &&
        current !== item.create &&
        !(item.replaces || []).includes(sha256(current))
      )
        throw Error("新模块已经存在且内容不同：" + item.file);
      current = item.create;
    } else
      for (const edit of item.edits) {
        if (current.includes(edit.after)) continue;
        const candidates = [edit.before, ...(edit.beforeVariants || [])];
        const matches = candidates.filter(
          (before) => current.split(before).length === 2,
        );
        if (matches.length !== 1)
          throw Error("源码与适配版本不符，未改写任何文件：" + item.file);
        const parts = current.split(matches[0]);
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
  return pending;
}
