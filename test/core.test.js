import test from "node:test";
import assert from "node:assert/strict";
import {
  defaults,
  validateConfig,
  insertion,
  chunks,
  spokenText,
  transcriptResult,
  assistantBody,
} from "../src/shared.js";
import { VoiceCore, providerError } from "../src/core.js";
import { guard, readBody } from "../src/host.js";
import { Readable } from "node:stream";
const config = () => ({ ...defaults, voiceId: "test-voice" });
test("safe defaults and custom models", () => {
  assert.equal(defaults.autoSend, false);
  assert.equal(defaults.maxSeconds, 300);
  assert.equal(defaults.pet.enabled, false);
  assert.equal(
    validateConfig({ ...defaults, ttsModel: "future-model-v8" }).ttsModel,
    "future-model-v8",
  );
});
test("never accept credential fields", () =>
  assert.throws(
    () => validateConfig({ ...defaults, apiKey: "SECRET" }),
    /不支持/,
  ));
test("keyterm constraints and dedup", () => {
  assert.deepEqual(
    validateConfig({ ...defaults, keyterms: [" config.json ", "config.json"] })
      .keyterms,
    ["config.json"],
  );
  for (const terms of [
    ["x".repeat(50)],
    ["a b c d e f"],
    ["a\\b"],
    Array(1001).fill("x"),
  ])
    assert.throws(() => validateConfig({ ...defaults, keyterms: terms }));
});
test("proxy rejects remote hosts, credentials and paths", () => {
  for (const proxy of [
    "https://localhost:99",
    "http://attacker.test:123",
    "http://user:pass@localhost:123",
    "http://127.0.0.1:99/a",
  ])
    assert.throws(() => validateConfig({ ...defaults, proxy }));
  assert.equal(
    validateConfig({ ...defaults, proxy: "http://127.0.0.1:7897" }).proxy,
    "http://127.0.0.1:7897",
  );
});
test("insertion handles empty, caret, selection and seams", () => {
  assert.equal(insertion("", { start: 0, end: 0 }, "你好"), "你好");
  assert.equal(insertion("你好", { start: 1, end: 1 }, "今天"), "今天");
  assert.equal(insertion("hello world", { start: 6, end: 11 }, "DSH"), "DSH");
  assert.equal(insertion("你好", { start: 2, end: 2 }, "DSH"), " DSH");
  assert.equal(insertion("hello world", { start: 5, end: 5 }, "new"), " new");
  assert.equal(insertion("hello", { start: 0, end: 5 }, "你好"), "你好");
});
test("empty/event-only audio never mutates draft, speech keeps labels", () => {
  assert.equal(
    transcriptResult({
      text: "[laughter]",
      words: [{ type: "audio_event", text: "laughter" }],
    }).hasSpeech,
    false,
  );
  assert.equal(
    transcriptResult({
      text: "[laughs] 你好",
      words: [{ type: "audio_event" }, { type: "word", text: "你好" }],
    }).text,
    "[laughs] 你好",
  );
  assert.equal(transcriptResult({ text: " " }).text, "");
});
test("assistant extraction excludes reasoning, tools and other messages", () => {
  const snapshot = {
    nodes: new Map([
      [
        "a",
        {
          data: {
            closing: {
              finalNode: {
                kind: "assistant",
                messageId: "m",
                blocks: [
                  { kind: "reasoning", text: "SECRET" },
                  { kind: "tool-call", text: "PRIVATE" },
                  { kind: "text", text: "可见回答" },
                ],
              },
            },
          },
        },
      ],
    ]),
  };
  assert.equal(assistantBody(snapshot, "m"), "可见回答");
  assert.equal(assistantBody(snapshot, "other"), "");
});
test("native readonly node collection exposes values without Map prototype", () => {
  assert.equal(
    assistantBody(
      {
        nodes: {
          values: () => [
            {
              data: {
                finalNode: {
                  kind: "assistant",
                  messageId: "m",
                  blocks: [{ kind: "text", text: "正文" }],
                },
              },
            },
          ],
        },
      },
      "m",
    ),
    "正文",
  );
});
test("Markdown preprocess and long chunking preserve unicode content", () => {
  assert.equal(
    spokenText("# 标题\n[链接](https://a.test) **文字**"),
    "标题\n链接 文字",
  );
  const original = "甲乙😀。".repeat(2000);
  const parts = chunks(original);
  assert.ok(
    parts.every((p) => p.length <= 2400 && !/[\uD800-\uDBFF]$/.test(p)),
  );
  assert.equal(parts.join(""), original);
});
test("error types distinguish key permission quota and transient", () => {
  assert.equal(
    providerError(401, { detail: { status: "missing_permissions" } }).kind,
    "permission",
  );
  assert.equal(providerError(401, {}).kind, "invalid_key");
  assert.equal(providerError(402, {}).kind, "quota");
  assert.equal(providerError(429, {}).kind, "rate_limit");
  assert.equal(providerError(503, {}).kind, "provider");
});
test("missing environment key explicit restart advice", async () => {
  const core = new VoiceCore({ config, key: () => "" });
  await assert.rejects(core.connection(), /重启 DSH/);
});
test("TTS sends only model and text, receipts never claim confirmed model", async () => {
  let sent;
  const core = new VoiceCore({
    config,
    key: () => "test-secret",
    fetch: async (url, init) => {
      sent = { url, init };
      return new Response(new Uint8Array([1, 2, 3]), {
        headers: { "request-id": "receipt" },
      });
    },
  });
  const result = await core.synthesize("你好");
  assert.deepEqual(JSON.parse(sent.init.body), {
    text: "你好",
    model_id: "eleven_v4",
  });
  assert.equal(result.receipt.requestedModel, "eleven_v4");
  assert.equal(result.receipt.serverModel, null);
  assert.equal(result.receipt.requestId, "receipt");
  assert.ok(!JSON.stringify(core.receipts).includes("test-secret"));
  await core.close();
});
test("STT uses batch multipart, events, keyterms and no language correction", async () => {
  let form;
  const core = new VoiceCore({
    config: () => ({ ...config(), keyterms: ["config.json"] }),
    key: () => "test",
    fetch: async (_, init) => {
      form = init.body;
      return Response.json({
        text: "你好 [laughter]",
        words: [{ type: "word", text: "你好" }],
        language_code: "zho",
      });
    },
  });
  const result = await core.transcribe(
    Buffer.from("fake"),
    "audio/webm;codecs=opus",
  );
  assert.equal(form.get("model_id"), "scribe_v2");
  assert.equal(form.get("tag_audio_events"), "true");
  assert.deepEqual(form.getAll("keyterms"), ["config.json"]);
  assert.equal(form.get("language_code"), null);
  assert.equal(result.hasSpeech, true);
  await core.close();
});
test("request timeout covers body download", async () => {
  const core = new VoiceCore({
    config,
    key: () => "x",
    timeout: 15,
    fetch: async (_, init) => ({
      ok: true,
      headers: new Headers(),
      arrayBuffer: () =>
        new Promise((_, reject) =>
          init.signal.addEventListener("abort", () => reject(Error("abort"))),
        ),
    }),
  });
  await assert.rejects(core.synthesize("你好"), (e) => e.kind === "timeout");
  await core.close();
});
test("cancellation aborts active provider request", async () => {
  const core = new VoiceCore({
    config,
    key: () => "x",
    fetch: async (_, init) =>
      new Promise((_, reject) =>
        init.signal.addEventListener("abort", () => reject(Error("aborted"))),
      ),
  });
  const control = new AbortController();
  const request = core.synthesize("你好", control.signal);
  control.abort();
  await assert.rejects(request, (e) => e.kind === "cancelled");
  assert.equal(core.pending.size, 0);
  await core.close();
});
test("disabled features never contact provider", async () => {
  let n = 0;
  const core = new VoiceCore({
    config: () => ({ ...config(), enabled: false }),
    key: () => "x",
    fetch: () => n++,
  });
  await assert.rejects(core.connection(), (e) => e.kind === "disabled");
  assert.equal(n, 0);
});
test("request guard rejects DNS rebinding, origin mismatch, wrong port and missing CSRF", () => {
  const make = () => ({
    method: "POST",
    headers: {
      host: "127.0.0.1:1234",
      origin: "http://127.0.0.1:1234",
      "x-elevenlabs-csrf": "test",
    },
    socket: { localPort: 1234, remoteAddress: "127.0.0.1" },
  });
  guard(make(), "test");
  for (const change of [
    (r) => (r.headers.host = "attacker.test:1234"),
    (r) => (r.headers.origin = "https://evil.test"),
    (r) => (r.headers.host = "127.0.0.1:999"),
    (r) => delete r.headers["x-elevenlabs-csrf"],
    (r) => (r.headers["sec-fetch-site"] = "cross-site"),
    (r) => (r.socket.remoteAddress = "192.168.1.2"),
  ]) {
    const req = make();
    change(req);
    assert.throws(() => guard(req, "test"));
  }
});
test("upload body size bounded", async () => {
  assert.equal(
    (await readBody(Readable.from([Buffer.from("abc")]), 4)).toString(),
    "abc",
  );
  await assert.rejects(
    readBody(Readable.from([Buffer.alloc(5)]), 4),
    (e) => e.status === 413,
  );
});
test("precise provider tags take precedence over HTTP status", () => {
  for (const http of [400, 401, 403, 429]) {
    assert.equal(
      providerError(http, { detail: { status: "quota_exceeded" } }).kind,
      "quota",
    );
    assert.equal(
      providerError(http, {
        detail: { status: "max_character_limit_exceeded" },
      }).kind,
      "text_size",
    );
    assert.equal(
      providerError(http, { detail: { status: "voice_not_found" } }).kind,
      "voice_not_found",
    );
    assert.equal(
      providerError(http, { detail: { status: "invalid_api_key" } }).kind,
      "invalid_key",
    );
  }
  assert.notEqual(
    providerError(400, { detail: { status: "some_limit_exceeded" } }).kind,
    "quota",
  );
});
test("ordinary config saves preserve inflight STT; disabling TTS cancels only TTS", async () => {
  let c = config();
  const core = new VoiceCore({
    config: () => c,
    key: () => "x",
    fetch: async (_url, init) =>
      new Promise((_, reject) =>
        init.signal.addEventListener("abort", () => reject(Error("aborted"))),
      ),
  });
  const stt = core.transcribe(Buffer.from("fake"), "audio/wav"),
    tts = core.synthesize("你好");
  const both = Promise.allSettled([stt, tts]);
  assert.equal(core.pending.size, 2);
  const next = { ...c, keyterms: ["file.txt"] };
  core.configurationChanged(c, next);
  c = next;
  assert.ok([...core.pending.keys()].every((x) => !x.signal.aborted));
  const off = { ...c, playbackEnabled: false };
  core.configurationChanged(c, off);
  c = off;
  assert.equal(
    [...core.pending.entries()].find(([, feature]) => feature === "stt")[0]
      .signal.aborted,
    false,
  );
  assert.equal(
    [...core.pending.entries()].find(([, feature]) => feature === "tts")[0]
      .signal.aborted,
    true,
  );
  await core.close();
  assert.ok((await both).every((r) => r.status === "rejected"));
});
test("stitching fields are bounded and v3 skips unsupported context", async () => {
  let sent;
  let c = config();
  const core = new VoiceCore({
    config: () => c,
    key: () => "x",
    fetch: async (_url, init) => {
      sent = JSON.parse(init.body);
      return new Response("mp3");
    },
  });
  await core.synthesize("第二段", undefined, {
    previous_request_ids: ["request-one"],
    previous_text: "第一段",
    next_text: "第三段",
  });
  assert.deepEqual(sent.previous_request_ids, ["request-one"]);
  assert.equal(sent.next_text, "第三段");
  await assert.rejects(
    core.synthesize("第二段", undefined, {
      previous_request_ids: Array(4).fill("x"),
    }),
    (e) => e.kind === "stitching",
  );
  c = { ...c, ttsModel: "eleven_v3" };
  await core.synthesize("第二段", undefined, { previous_text: "第一段" });
  assert.equal(sent.previous_text, undefined);
  await core.close();
});
