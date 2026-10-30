import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import { defaults } from "../src/shared.js";
const flush = async () => {
  for (let n = 0; n < 8; n++) await new Promise((r) => setImmediate(r));
};
async function harness(config = {}, replyText = "你好，world。") {
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
    audios = [],
    ttsBodies = [],
    dictations = [];
  // A scope keeps hook state across renders of one component instance.
  let scope = null;
  const settingsScope = { hooks: [], cursor: 0 },
    replyScope = { hooks: [], cursor: 0 },
    failTts = new Set(),
    chatListeners = new Set();
  let chatSubscriptions = 0;
  let nextInterval = 0;
  const jsx = (type, props) => ({ type, props });
  const React = {
    useRef: (value) => {
      if (!scope) return { current: value };
      const i = scope.cursor++;
      if (!scope.hooks[i]) scope.hooks[i] = { current: value };
      return scope.hooks[i];
    },
    useState: (value) => {
      if (!scope)
        return [typeof value === "function" ? value() : value, () => {}];
      const hooks = scope.hooks,
        i = scope.cursor++;
      if (!hooks[i])
        hooks[i] = {
          value: typeof value === "function" ? value() : value,
        };
      return [
        hooks[i].value,
        (next) => {
          hooks[i].value =
            typeof next === "function" ? next(hooks[i].value) : next;
        },
      ];
    },
    useEffect: (fn, deps) => {
      if (scope) {
        const i = scope.cursor++,
          old = scope.hooks[i];
        if (old && deps && deps.every((v, j) => v === old.deps[j])) return;
        old?.off?.();
        const off = fn();
        scope.hooks[i] = { deps, off };
        if (off) cleanups.push(off);
      } else {
        const off = fn();
        if (off) cleanups.push(off);
      }
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
      ttsBodies.push(JSON.parse(init.body));
      if (failTts.has(ttsCalls))
        return Response.json({ ok: false, error: "临时故障" }, { status: 503 });
      return new Response(new Blob(["mp3"]), {
        headers: { "x-elevenlabs-request-id": "request-" + ttsCalls },
      });
    }
    if (url.endsWith("/dictation")) {
      dictations.push(JSON.parse(init.body));
      return Response.json({ ok: true });
    }
    if (url.endsWith("/config")) {
      Object.assign(config, JSON.parse(init.body));
      return Response.json({ ok: true });
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
        // Deliberately a fresh object per call, like an unmemoized host binding.
        target: () => ({
          subscribe: (fn) => {
            chatSubscriptions++;
            chatListeners.add(fn);
            return () => chatListeners.delete(fn);
          },
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
                          { kind: "text", text: replyText },
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
    ttsBodies,
    dictations,
    settings: () => {
      scope = settingsScope;
      scope.cursor = 0;
      try {
        return components["elevenlabs-voice"]({});
      } finally {
        scope = null;
      }
    },
    // Renders the same Reply instance repeatedly with persistent hooks.
    renderReply: () => {
      scope = replyScope;
      scope.cursor = 0;
      try {
        return components["elevenlabs-voice-play"]({
          sessionId: "original",
          messageId: "m",
        });
      } finally {
        scope = null;
      }
    },
    notifyChat: () => [...chatListeners].forEach((fn) => fn()),
    failTts: (call) => failTts.add(call),
    get chatSubscriptions() {
      return chatSubscriptions;
    },
    get chatListeners() {
      return chatListeners.size;
    },
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
    .find((b) => b.props["aria-label"] === "重播")
    .props.onClick();
  await flush();
  assert.equal(env.ttsCalls, 1);
  assert.equal(env.audios.at(-1).paused, false);
  env
    .buttons(env.panel())
    .find((b) => b.props["aria-label"] === "停止")
    .props.onClick();
  assert.equal(env.audios.at(-1).paused, true);
  env.close();
});

test("keyterm textarea keeps trailing newline across actual component rerenders", async () => {
  const config = {},
    env = await harness(config);
  const find = (node, predicate) => {
    if (!node) return null;
    if (Array.isArray(node)) {
      for (const n of node) {
        const found = find(n, predicate);
        if (found) return found;
      }
      return null;
    }
    if (typeof node !== "object") return null;
    if (predicate(node)) return node;
    return find(node.props?.children, predicate);
  };
  const terms = (node) =>
    find(node, (x) => x.type === "textarea" && x.props.rows === 5);
  let ui = env.settings();
  terms(ui).props.onChange({ target: { value: "config.json\n" } });
  ui = env.settings();
  assert.equal(terms(ui).props.value, "config.json\n");
  terms(ui).props.onChange({ target: { value: "config.json\n\ntimeout\n" } });
  ui = env.settings();
  assert.equal(terms(ui).props.value, "config.json\n\ntimeout\n");
  await env
    .buttons(ui)
    .find((b) => b.props.children === "保存设置")
    .props.onClick();
  await flush();
  assert.deepEqual(config.keyterms, ["config.json", "timeout"]);
  env.close();
});
test("next chunk is prefetched once while first plays and includes stitching context", async () => {
  const env = await harness({}, "这是测试段落。".repeat(500));
  env.buttons(env.reply())[0].props.onClick();
  await flush();
  assert.equal(env.ttsCalls, 2);
  assert.equal(env.audios[0].paused, false);
  assert.ok(env.ttsBodies[0].stitching.next_text);
  assert.equal(env.ttsBodies[1].stitching.previous_request_ids[0], "request-1");
  env.audios[0].currentTime = 1.5;
  env.audios[0].ontimeupdate();
  let panel = env.panel();
  assert.ok(JSON.stringify(panel).includes("整体播放进度"));
  env.audios[0].onended();
  await flush();
  assert.equal(env.ttsCalls, 2); // Two chunks: transition consumes prefetched audio.
  env
    .buttons(env.panel())
    .find((b) => b.props["aria-label"] === "重播")
    .props.onClick();
  await flush();
  assert.equal(env.ttsCalls, 2);
  env.close();
});
test("failed prefetch is requested again when its segment starts", async () => {
  const env = await harness({}, "这是测试段落。".repeat(500));
  env.failTts(2); // The prefetch of segment 2 fails once.
  env.buttons(env.reply())[0].props.onClick();
  await flush();
  assert.equal(env.ttsCalls, 2);
  assert.equal(env.audios[0].paused, false);
  env.audios[0].onended();
  await flush();
  assert.equal(env.ttsCalls, 3); // Retried instead of reusing the failure.
  assert.equal(env.audios[0].paused, false);
  assert.ok(!JSON.stringify(env.panel()).includes("临时故障"));
  env.close();
});
test("reply subscribes to the chat once across rerenders and unsubscribes", async () => {
  const env = await harness();
  assert.ok(env.renderReply());
  env.renderReply();
  env.renderReply();
  assert.equal(env.chatSubscriptions, 1);
  assert.equal(env.chatListeners, 1);
  env.notifyChat(); // Snapshot change notification must not throw.
  env.close();
  assert.equal(env.chatListeners, 0);
});
test("dictation reports holding the microphone to the host, in order, including cancel", async () => {
  const env = await harness();
  await env.mic("original").props.onClick();
  await flush();
  env.mic("original").props.onClick(); // stop and upload
  await flush();
  assert.deepEqual(
    env.dictations.map((d) => [d.active, d.seq]),
    [
      [true, 1],
      [false, 2],
    ],
  );
  assert.equal(env.dictations[0].client, env.dictations[1].client);
  await env.mic("original").props.onClick();
  await flush();
  env
    .buttons(env.panel())
    .find((x) => x.props.children === "取消")
    .props.onClick();
  await flush();
  assert.deepEqual(
    env.dictations.map((d) => d.active),
    [true, false, true, false],
  );
  env.close();
});
test("the reply button stops its own reply while it plays", async () => {
  const env = await harness();
  const play = env.buttons(env.reply())[0];
  assert.equal(play.props["aria-label"], "朗读这条回答");
  play.props.onClick();
  await flush();
  assert.equal(env.ttsCalls, 1);
  const stop = env.buttons(env.reply())[0];
  assert.equal(stop.props["aria-label"], "停止朗读");
  stop.props.onClick();
  assert.equal(env.audios.at(-1).paused, true);
  assert.equal(env.panel(), null);
  assert.equal(env.buttons(env.reply())[0].props["aria-label"], "朗读这条回答");
  env.close();
});
test("a failed synthesis shows only the error, not a dead player", async () => {
  const env = await harness();
  env.failTts(1);
  env.buttons(env.reply())[0].props.onClick();
  await flush();
  const panel = JSON.stringify(env.panel());
  assert.ok(panel.includes("临时故障"));
  assert.ok(!panel.includes("整体播放进度"));
  assert.ok(
    !env.buttons(env.panel()).some((b) => b.props["aria-label"] === "重播"),
  );
  assert.equal(env.buttons(env.reply())[0].props["aria-label"], "朗读这条回答");
  env.close();
});
