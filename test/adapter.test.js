import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { planAdapter, sha256 } from "../scripts/pet-adapter-plan.mjs";
const manifest = JSON.parse(
  fs.readFileSync(
    new URL("../integrations/dsh-pet/adapter.json", import.meta.url),
    "utf8",
  ),
);
const PANEL = "src/shared/voice-panel.ts";
const oldPanel = fs.readFileSync(
  new URL("./fixtures/voice-panel-1.1.ts", import.meta.url),
  "utf8",
);
// A dsh-pet tree either before or after the adapter ran; the panel module
// holds whatever the case under test needs.
function tree(adapted, panel) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-pet-adapter-")),
    target = path.join(root, "pkg");
  for (const item of manifest.files) {
    const file = path.resolve(target, item.file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (item.create) {
      const content = item.file === PANEL ? panel : adapted ? item.create : "";
      if (content) fs.writeFileSync(file, content);
    } else
      fs.writeFileSync(
        file,
        item.edits
          .map((e) => (adapted ? e.after : e.before))
          .join("\n/* other code */\n"),
      );
  }
  return { root, target };
}
const panelItem = manifest.files.find((x) => x.file === PANEL);
test("an adapted dsh-pet upgrades only the floating window from v1.1", () => {
  assert.ok(
    panelItem.replaces.includes(sha256(oldPanel.replaceAll("\r\n", "\n"))),
  );
  const { root, target } = tree(true, oldPanel);
  try {
    const pending = planAdapter(target, manifest);
    assert.deepEqual(
      pending.map((p) => p.name),
      [PANEL],
    );
    assert.equal(pending[0].current, panelItem.create);
    assert.match(pending[0].current, /vp-edge/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("an up-to-date adapted dsh-pet needs no changes", () => {
  const { root, target } = tree(true, panelItem.create);
  try {
    assert.deepEqual(planAdapter(target, manifest), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("a locally edited floating window is never overwritten", () => {
  const { root, target } = tree(true, oldPanel + "\n// my change\n");
  try {
    assert.throws(() => planAdapter(target, manifest), /内容不同/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
test("a fresh dsh-pet receives every adapter change", () => {
  const { root, target } = tree(false, "");
  try {
    assert.equal(planAdapter(target, manifest).length, manifest.files.length);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("v1.3 bridge upgrades the output subscription once and remains idempotent", () => {
  const { root, target } = tree(true, panelItem.create);
  try {
    const item = manifest.files.find((x) => x.file === "src/host/index.ts");
    const edit = item.edits.find((x) => x.beforeVariants);
    const file = path.join(target, item.file);
    fs.writeFileSync(
      file,
      fs.readFileSync(file, "utf8").replace(edit.after, edit.beforeVariants[0]),
    );
    const changes = planAdapter(target, manifest);
    assert.equal(changes.length, 1);
    assert.match(changes[0].current, /watchSay/);
    fs.writeFileSync(file, changes[0].current);
    assert.deepEqual(planAdapter(target, manifest), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
