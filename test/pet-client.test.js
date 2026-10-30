import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise(setImmediate);
};
function harness() {
  const elements = new Map(),
    sent = [],
    audio = [],
    calls = [],
    pending = {},
    sessions = [];
  function element() {
    return {
      style: { setProperty() {} },
      dataset: {},
      children: [],
      value: "",
      setAttribute() {},
      addEventListener() {},
      append() {},
      replaceChildren() {},
      querySelector() {
        return null;
      },
      focus() {},
      elements: {
        namedItem() {
          return null;
        },
      },
    };
  }
  const get = (id) => {
    if (!elements.has(id)) elements.set(id, element());
    return elements.get(id);
  };
  let socket;
  const context = vm.createContext({
    URLSearchParams,
    AbortController,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval() {},
    matchMedia: () => ({ matches: true }),
    location: {
      search: "?background=1",
      pathname: "/pet/test/",
      origin: "http://127.0.0.1",
    },
    document: {
      getElementById: get,
      createElement: element,
      documentElement: { dataset: {} },
      body: { dataset: {} },
    },
    window: { addEventListener() {} },
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    chunks: (text) => [text],
    WebSocket: class {
      constructor() {
        socket = this;
        this.readyState = 1;
      }
      send(data) {
        sent.push(JSON.parse(data));
      }
    },
    Audio: class {
      constructor() {
        audio.push(this);
      }
      play() {
        this.onplaying?.();
        return Promise.resolve();
      }
      pause() {}
    },
    Conversation: {
      startSession: async (options) => {
        sessions.push(options);
        return { endSession: async () => {}, setVolume() {}, setMicMuted() {} };
      },
    },
    fetch: async (url, options) => {
      const route = url.split("/").at(-1);
      calls.push(route);
      if (pending[route]) return pending[route](options);
      return {
        ok: true,
        json: async () => ({ signedUrl: "test", text: "回答" }),
        blob: async () => ({}),
      };
    },
  });
  vm.runInContext(
    fs
      .readFileSync(new URL("../src/pet-client.js", import.meta.url), "utf8")
      .replace(/^import .*;\r?\n/gm, ""),
    context,
  );
  return {
    get,
    sent,
    audio,
    calls,
    pending,
    sessions,
    run: (code) => vm.runInContext(code, context),
    message: (m) => socket.onmessage({ data: JSON.stringify(m) }),
  };
}
test("automatic output is acknowledged only after playback, interrupted dictation retries", async () => {
  const h = harness();
  h.message({ type: "reading-setting", enabled: true });
  h.message({ type: "speak", id: 1, text: "第一条" });
  await flush();
  assert.equal(h.audio.length, 1);
  assert.equal(h.sent.filter((x) => x.type === "read-result").length, 0);
  h.message({ type: "dictation", active: true });
  await flush();
  assert.equal(h.sent.find((x) => x.type === "read-result").retry, true);
  h.message({ type: "dictation", active: false });
  h.message({ type: "speak", id: 1, text: "第一条" });
  await flush();
  h.audio.at(-1).onended();
  await flush();
  assert.equal(
    h.sent.filter((x) => x.type === "read-result").at(-1).retry,
    false,
  );
});
test("rapid Enter sends once and a stopped delayed text response never starts audio", async () => {
  const h = harness();
  let resolve;
  h.pending.chat = () =>
    new Promise((r) => {
      resolve = r;
    });
  h.get("text").value = "你好";
  h.run("void chat(); void chat()");
  await flush();
  assert.equal(h.calls.filter((x) => x === "chat").length, 1);
  await h.run("stop()");
  resolve({ ok: true, json: async () => ({ text: "迟到回复" }) });
  await flush();
  assert.equal(h.audio.length, 0);
});
test("callbacks from the previous realtime connection do not clear the new one", async () => {
  const h = harness();
  await h.run("start()");
  await h.run("start()");
  assert.equal(h.run("conversation !== null"), true);
  h.sessions[0].onDisconnect();
  h.sessions[0].onError("old error");
  assert.equal(h.run("conversation !== null"), true);
  assert.notEqual(h.get("status").textContent, "语音服务：old error");
});
test("the stop button shows only while the panel is speaking or about to", async () => {
  const h = harness();
  assert.equal(h.get("stop-all").hidden, true);
  let resolve;
  h.pending.chat = () =>
    new Promise((r) => {
      resolve = r;
    });
  h.get("text").value = "你好";
  h.run("void chat()");
  await flush();
  assert.equal(h.get("stop-all").hidden, false); // waiting for the reply
  resolve({ ok: true, json: async () => ({ text: "回答" }) });
  await flush();
  assert.equal(h.audio.length, 1);
  assert.equal(h.get("stop-all").hidden, false); // reading it aloud
  assert.equal(h.get("status").textContent, "正在朗读…");
  h.audio.at(-1).onended();
  await flush();
  assert.equal(h.get("stop-all").hidden, true);
  // A live realtime conversation keeps the orb as its stop control.
  await h.run("start()");
  assert.equal(h.run("conversation !== null"), true);
  assert.equal(h.get("stop-all").hidden, true);
});
test("stopping mid-reading clears the playback message and the stop button", async () => {
  const h = harness();
  h.run('void say("一段比较长的话")');
  await flush();
  assert.equal(h.get("status").textContent, "正在朗读…");
  assert.equal(h.get("stop-all").hidden, false);
  await h.run("stop()");
  await flush();
  assert.equal(h.get("status").textContent, "");
  assert.equal(h.get("stop-all").hidden, true);
});
