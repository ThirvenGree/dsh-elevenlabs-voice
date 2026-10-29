import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import { defaults } from "../src/shared.js";
const flush = async () => {
  for (let n = 0; n < 8; n++) await new Promise((r) => setImmediate(r));
};
async function harness(config = {}) {
  let factory,
    now = 0,
    transcription = { text: "今天好", hasSpeech: true },
    deferTranscription = null,
    deferMicrophone = null,
    sttCalls = 0,
    ttsCalls = 0;
  const components = {},
    cleanups = [],
    intervals = new Map(),
    drafts = new Map(),
    streams = [],
    audios = [];
  let nextInterval = 0;
  const jsx = (type, props) => ({ type, props });
  const React = {
    useState: (value) => [
      typeof value === "function" ? value() : value,
      () => {},
    ],
    useEffect: (fn) => {
      const off = fn();
      if (off) cleanups.push(off);
    },
  };
  class Recorder {
    static isTypeSupported() {
      return true;
    }
    constructor(stream, options) {
      this.stream = stream;
      this.mimeType = options.mimeType;
    }
    start() {
      this.state = "recording";
    }
    stop() {
      if (this.state !== "recording") return;
      this.state = "inactive";
      this.ondataavailable({
        data: new Blob(["audio"], { type: this.mimeType }),
      });
      void this.onstop();
    }
  }
  class Audio {
    constructor() {
      audios.push(this);
      this.paused = true;
      this.duration = 3;
      this.currentTime = 0;
    }
    async play() {
      this.paused = false;
      this.onplay?.();
    }
    pause() {
      this.paused = true;
      this.onpause?.();
    }
    load() {}
    removeAttribute() {}
    async setSinkId(id) {
      this.sink = id;
    }
  }
  const fakeFetch = async (url, init) => {
    if (url.endsWith("/state"))
      return Response.json({
        config: { ...defaults, voiceId: "test", ...config },
        keyPresent: true,
        csrfToken: "test",
      });
    if (url.endsWith("/transcribe")) {
      sttCalls++;
      if (deferTranscription) await deferTranscription;
      return Response.json(transcription);
    }
    if (url.endsWith("/tts")) {
      ttsCalls++;
      return new Response(new Blob(["mp3"]));
    }
    throw Error("unexpected route " + url);
  };
  const sandbox = {
    console,
    Blob,
    Response,
    Headers,
    AbortController,
    DOMException,
    Uint8Array,
    Date: class extends Date {
      static now() {
        return now;
      }
    },
    setInterval: (fn) => {
      intervals.set(++nextInterval, fn);
      return nextInterval;
    },
    clearInterval: (id) => intervals.delete(id),
    URL: { createObjectURL: () => "blob:test", revokeObjectURL: () => {} },
    fetch: fakeFetch,
    Audio,
    AudioContext: class {
      createAnalyser() {
        return { fftSize: 256, getByteTimeDomainData: (a) => a.fill(128) };
      }
      createMediaStreamSource() {
        return { connect() {} };
      }
      async close() {}
    },
    MediaRecorder: Recorder,
    navigator: {
      mediaDevices: {
        enumerateDevices: async () => [],
        getUserMedia: async () => {
          if (deferMicrophone) await deferMicrophone;
          const stream = {
            stopped: false,
            getTracks() {
              return [{ stop: () => (stream.stopped = true) }];
            },
          };
          streams.push(stream);
          return stream;
        },
      },
    },
    document: {
      head: { append() {} },
      createElement: () => ({ remove() {} }),
      addEventListener() {},
      removeEventListener() {},
    },
    window: {
      __ModuleLoader__: { load: (x) => (factory = x.factory) },
      MediaRecorder: Recorder,
      getSelection: () => null,
    },
  };
  vm.runInNewContext(
    fs.readFileSync(new URL("../lib/client.js", import.meta.url), "utf8"),
    sandbox,
  );
  const ctx = {
    effect: (fn) => {
      const off = fn();
      if (off) cleanups.push(off);
    },
    slots: {
      inject: (slot, fn) => {
        const gen = fn();
        if (gen?.next)
          for (const _ of gen) {
          }
        return () => {};
      },
      register: (options, component) => {
        components[options.id] = component;
        return () => {};
      },
    },
    conversation: {
      input: {
        shell: (sid) => {
          if (!drafts.has(sid)) throw Error("unavailable");
          const d = drafts.get(sid);
          return {
            projection: {
              get detectText() {
                return d.text;
              },
            },
            actions: {
              captureInsertion: () => ({ ...d.span, draftRev: 1 }),
              insertText: (text, span) => {
                d.undo.push(d.text);
                d.text =
                  d.text.slice(0, span.start) + text + d.text.slice(span.end);
                d.span = {
                  start: span.start + text.length,
                  end: span.start + text.length,
                };
                return true;
              },
              persistDraft: () => (d.persisted = true),
              submit: () => d.sent++,
            },
          };
        },
      },
    },
    sessions: {
      list: {
        getSnapshot: () => ({
          byId: Object.fromEntries([...drafts].map(([id]) => [id, {}])),
        }),
      },
    },
    uiConversation: {
      binding: () => ({
        target: () => ({
          getSnapshot: () => ({
            nodes: {
              values: () => [
                {
                  data: {
                    closing: {
                      finalNode: {
                        kind: "assistant",
                        messageId: "m",
                        blocks: [
                          { kind: "reasoning", text: "hidden" },
                          { kind: "text", text: "你好，world。" },
                        ],
                      },
                    },
                  },
                },
              ],
            },
          }),
        }),
      }),
    },
  };
  factory((name) => (name === "react" ? React : { jsx })).apply(ctx);
  await flush();
  const add = (id, text = "") => {
    drafts.set(id, {
      text,
      span: { start: text.length, end: text.length },
      undo: [],
      sent: 0,
    });
  };
  add("original");
  add("other");
  const mic = (id) => components["elevenlabs-voice-mic"]({ sessionId: id });
  const buttons = (node) => {
    if (!node) return [];
    if (Array.isArray(node)) return node.flatMap(buttons);
    if (typeof node !== "object") return [];
    return [
      ...(node.type === "button" ? [node] : []),
      ...buttons(node.props?.children),
    ];
  };
  const panel = () => components["elevenlabs-voice-panel"]({});
  return {
    mic,
    buttons,
    panel,
    drafts,
    streams,
    audios,
    cleanups,
    intervals,
    get sttCalls() {
      return sttCalls;
    },
    get ttsCalls() {
      return ttsCalls;
    },
    setTranscript: (v) => (transcription = v),
    deferSTT: () => {
      let deferTranscriptionResolve;
      deferTranscription = new Promise((r) => (deferTranscriptionResolve = r));
      return () => deferTranscriptionResolve();
    },
    deferMic: () => {
      let resolve;
      deferMicrophone = new Promise((r) => (resolve = r));
      return resolve;
    },
    tick: (ms) => {
      now += ms;
      for (const fn of intervals.values()) fn();
    },
    reply: () =>
      components["elevenlabs-voice-play"]({
        sessionId: "original",
        messageId: "m",
      }),
    close: () => cleanups.reverse().forEach((f) => f()),
  };
}
test("completion caret wins over initial caret and native insertion is one undo unit", async () => {
  const env = await harness();
  env.drafts.get("original").text = "你好";
  env.drafts.get("original").span = { start: 2, end: 2 };
  await env.mic("original").props.onClick();
  await flush();
  env.mic("original").props.onClick();
  const d = env.drafts.get("original");
  d.span = { start: 1, end: 2 };
  await flush();
  assert.equal(d.text, "你今天好");
  assert.deepEqual(d.undo, ["你好"]);
  assert.equal(d.sent, 0);
  assert.ok(env.streams.every((s) => s.stopped));
  env.close();
});
test("switching sessions stops recording and returns only to original draft, never auto sends", async () => {
  const env = await harness({ autoSend: true });
  await env.mic("original").props.onClick();
  await flush();
  const cleanup = env.cleanups.at(-1);
  cleanup();
  env.mic("other");
  await flush();
  assert.equal(env.drafts.get("original").text, "今天好");
  assert.equal(env.drafts.get("other").text, "");
  assert.equal(env.drafts.get("original").sent, 0);
  env.close();
});
test("cancelled recording never uploads, and pending microphone grant releases late tracks", async () => {
  const env = await harness();
  const resolve = env.deferMic();
  void env.mic("original").props.onClick();
  await flush();
  env
    .buttons(env.panel())
    .find((x) => x.props.children === "取消")
    .props.onClick();
  resolve();
  await flush();
  assert.equal(env.sttCalls, 0);
  assert.ok(env.streams.every((s) => s.stopped));
  env.close();
});
test("duration limit stops and transcribes once", async () => {
  const env = await harness({ maxSeconds: 5 });
  await env.mic("original").props.onClick();
  await flush();
  env.tick(5000);
  await flush();
  assert.equal(env.sttCalls, 1);
  assert.equal(env.drafts.get("original").text, "今天好");
  env.close();
});
test("no speech leaves draft and submit untouched", async () => {
  const env = await harness({ autoSend: true });
  env.setTranscript({ text: "", hasSpeech: false });
  env.drafts.get("original").text = "原草稿";
  await env.mic("original").props.onClick();
  await flush();
  env.mic("original").props.onClick();
  await flush();
  assert.equal(env.drafts.get("original").text, "原草稿");
  assert.equal(env.drafts.get("original").sent, 0);
  env.close();
});
test("deleted original session discards a delayed transcription", async () => {
  const env = await harness();
  const release = env.deferSTT();
  await env.mic("original").props.onClick();
  await flush();
  env.mic("original").props.onClick();
  env.drafts.delete("original");
  release();
  await flush();
  assert.equal(env.drafts.get("other").text, "");
  assert.match(JSON.stringify(env.panel()), /原会话已删除/);
  env.close();
});
test("auto-send only follows a successful same-session insertion", async () => {
  const env = await harness({ autoSend: true });
  await env.mic("original").props.onClick();
  await flush();
  env.mic("original").props.onClick();
  await flush();
  assert.equal(env.drafts.get("original").sent, 1);
  env.close();
});
test("TTS never runs until explicit click; replay uses session memory cache", async () => {
  const env = await harness();
  const reply = env.reply();
  assert.ok(reply);
  assert.equal(env.ttsCalls, 0);
  env.buttons(reply)[0].props.onClick();
  await flush();
  assert.equal(env.ttsCalls, 1);
  env
    .buttons(env.panel())
    .find((b) => b.props.children === "重播")
    .props.onClick();
  await flush();
  assert.equal(env.ttsCalls, 1);
  assert.equal(env.audios.at(-1).paused, false);
  env
    .buttons(env.panel())
    .find((b) => b.props.children === "停止")
    .props.onClick();
  assert.equal(env.audios.at(-1).paused, true);
  env.close();
});
