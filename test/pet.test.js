import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, createHmac } from "node:crypto";
import { WebSocket } from "ws";
import { PetVoiceHost } from "../src/pet-host.js";
import { petConfig, canSpeakAutomatically } from "../src/pet-config.js";
import { validUpstreamJwt } from "../src/pet-tunnel.js";
import { parsePetTask, withoutPetTask } from "../src/pet-tasks.js";
test("upstream rejects expired, forged, wrong issuer and wrong algorithm tokens", () => {
  const key = "fixture-secret",
    now = Date.now();
  const sign = (claims, alg = "HS256") => {
    const h = Buffer.from(JSON.stringify({ alg })).toString("base64url"),
      p = Buffer.from(JSON.stringify(claims)).toString("base64url");
    return (
      h +
      "." +
      p +
      "." +
      createHmac("sha256", createHash("sha256").update(key).digest())
        .update(h + "." + p)
        .digest("base64url")
    );
  };
  const claims = {
    iss: "https://api.elevenlabs.io/convai/speech-engine",
    sub: "convai_speech_engine_upstream",
    exp: now / 1000 + 30,
  };
  assert.equal(validUpstreamJwt(sign(claims), key, now), true);
  for (const token of [
    sign({ ...claims, exp: now / 1000 - 1 }),
    sign({ ...claims, iss: "other" }),
    sign(claims, "none"),
    sign(claims) + "x",
  ])
    assert.equal(validUpstreamJwt(token, key, now), false);
});
test("autonomous voice is opt in, quiet 2-6, cooldown and hourly budget enforced", () => {
  const now = new Date(2026, 9, 29, 12).getTime(),
    c = petConfig({ autonomous: true });
  assert.equal(canSpeakAutomatically(petConfig(), [], now), false);
  assert.equal(canSpeakAutomatically(c, [], now), true);
  assert.equal(
    canSpeakAutomatically(c, [], new Date(2026, 9, 29, 3).getTime()),
    false,
  );
  assert.equal(canSpeakAutomatically(c, [now - 1000], now), false);
  assert.throws(() => petConfig({ provider: "x" }));
  assert.throws(() => petConfig({ key: "secret" }));
});
test("task proposals accept only bounded timers and public HTTPS URLs", () => {
  assert.deepEqual(
    parsePetTask(
      '<pet-task>{"type":"timer","seconds":60,"label":"休息"}</pet-task>',
    ),
    { type: "timer", seconds: 60, label: "休息" },
  );
  for (const url of [
    "file:///C:/x",
    "http://example.com",
    "https://127.0.0.1/a",
    "https://user:secret@example.com",
  ])
    assert.equal(
      parsePetTask(
        "<pet-task>" + JSON.stringify({ type: "url", url }) + "</pet-task>",
      ),
      null,
    );
  assert.equal(withoutPetTask('回答<pet-task>{"x":2}</pet-task>'), "回答");
});
test("local panel has capability and CSRF protection, exclusive owner, scoped history and clear", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-pet-voice-"));
  let cleared = "",
    lock = false;
  const bridge = {
    describe: () => ({ model: { provider: "fixture", model: "same-as-dsh" } }),
    history: async () => [{ role: "user", content: "hello" }],
    events: () => [],
    clear: async (id) => {
      cleared = id;
    },
    speaking: (_id, on) => {
      lock = on;
    },
    async *stream(_id, text, signal) {
      signal.throwIfAborted();
      yield "收到 " + text;
    },
  };
  const host = new PetVoiceHost({ get: () => bridge }, dir, () => ({
    enabled: true,
    dshEnabled: false,
    voiceId: "fixture",
  }));
  let one, two;
  try {
    const panel = await host.panel("main"),
      base = panel.url,
      token = new URL(base).pathname.split("/")[2];
    let response = await fetch(base + "state");
    assert.equal(response.status, 200);
    assert.equal((await response.json()).model.model, "same-as-dsh");
    response = await fetch(base + "clear", { method: "POST", body: "{}" });
    assert.equal(response.status, 403);
    assert.equal(cleared, "");
    response = await fetch(base + "clear", {
      method: "POST",
      headers: { "x-pet-token": token },
      body: "{}",
    });
    assert.equal(response.status, 200);
    assert.equal(cleared, "main");
    response = await fetch(base + "state", {
      headers: { origin: "http://malicious.invalid" },
    });
    assert.equal(response.status, 403);
    one = new WebSocket(base.replace("http:", "ws:") + "socket");
    await new Promise((r) => one.once("open", r));
    const closed = new Promise((r) => one.once("close", (code) => r(code)));
    two = new WebSocket(base.replace("http:", "ws:") + "socket");
    await new Promise((r) => two.once("open", r));
    assert.equal(await closed, 4001);
    let output = "";
    assert.equal(
      await host.reply("main", "你好", (delta) => (output += delta)),
      "收到 你好",
    );
    assert.equal(output, "收到 你好");
    two.send(JSON.stringify({ type: "speaking", active: true }));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(lock, true);
    two.close();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(lock, false);
    assert.equal(host.jobs.size, 0);
  } finally {
    one?.terminate();
    two?.terminate();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("a new user turn aborts the old model generation and does not emit late chunks", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-pet-turn-"));
  let firstSignal;
  const bridge = {
    speaking: () => {},
    events: () => [],
    async *stream(_id, text, signal) {
      if (text === "old") {
        firstSignal = signal;
        await new Promise((resolve, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          }),
        );
      }
      yield text;
    },
  };
  const host = new PetVoiceHost({ get: () => bridge }, dir, () => ({
    enabled: true,
  }));
  try {
    await host.ready;
    const old = host.reply("main", "old", () => {});
    const rejected = assert.rejects(old);
    while (!firstSignal) await new Promise((r) => setTimeout(r, 1));
    assert.equal(await host.reply("main", "new", () => {}), "new");
    await rejected;
    assert.equal(firstSignal.aborted, true);
  } finally {
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("background audio yields to the visible panel and can resume after it closes", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "dsh-pet-owner-"));
  const host = new PetVoiceHost(
    {
      get: () => ({
        describe: () => ({ model: {} }),
        speaking: () => {},
        events: () => [],
      }),
    },
    dir,
    () => ({ enabled: true }),
  );
  const clients = [];
  try {
    const { url } = await host.panel("main");
    const open = async (background) => {
      const ws = new WebSocket(
        url.replace("http:", "ws:") +
          "socket" +
          (background ? "?background=1" : ""),
      );
      clients.push(ws);
      const closed = new Promise((resolve) => ws.once("close", resolve));
      await new Promise((resolve, reject) => {
        ws.once("open", resolve);
        ws.once("error", reject);
      });
      return { ws, closed };
    };
    const first = await open(true);
    const panel = await open(false);
    assert.equal(await first.closed, 4001);
    const rejected = await open(true);
    assert.equal(await rejected.closed, 4002);
    assert.equal(host.sockets.get("main").background, false);
    panel.ws.close();
    await panel.closed;
    await new Promise((r) => setTimeout(r, 10));
    await open(true);
    assert.equal(host.sockets.get("main").background, true);
  } finally {
    for (const ws of clients) ws.terminate();
    await host.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
