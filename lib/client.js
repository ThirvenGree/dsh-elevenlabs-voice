(() => {
  // src/shared.js
  var defaults = Object.freeze({
    enabled: true,
    dshEnabled: true,
    sttEnabled: true,
    sttModel: "scribe_v2",
    autoSend: false,
    maxSeconds: 300,
    keyterms: [],
    playbackEnabled: true,
    ttsModel: "eleven_v4",
    voiceId: "",
    inputDevice: "",
    outputDevice: "",
    volume: 0.8,
    proxy: "",
    pet: { enabled: false }
  });
  function insertion(text, span, transcript) {
    const start = Math.min(text.length, Math.max(0, span.start)), end = Math.min(text.length, Math.max(start, span.end));
    const seam = (a, b) => !a || !b || /\s/u.test(a) || /\s/u.test(b) || new RegExp("\\p{Script=Han}", "u").test(a) && new RegExp("\\p{Script=Han}", "u").test(b) ? "" : " ";
    return seam(text[start - 1], transcript[0]) + transcript + seam(transcript.at(-1), text[end]);
  }
  function spokenText(text) {
    return String(text).replace(/```[^\n]*\n([\s\S]*?)```/g, "$1").replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/<https?:\/\/([^>]+)>/g, "$1").replace(/https?:\/\//g, "").replace(/<[^>]+>/g, "").replace(/^\s{0,3}(?:#{1,6}|>|[-+*])\s+/gm, "").replace(/^[| :\-]+$/gm, "").replace(/\|/g, "\uFF0C").replace(/[*_~`]/g, "").replace(/[\u200b-\u200f\ufeff]/g, "").replace(/\n{3,}/g, "\n\n").trim();
  }
  function chunks(text, limit = 2400) {
    const result = [];
    let rest = spokenText(text);
    while (rest.length > limit) {
      let end = -1;
      for (const mark of ["\n", "\u3002", "\uFF01", "\uFF1F", ". ", "! ", "? ", "\uFF0C", " "])
        end = Math.max(end, rest.lastIndexOf(mark, limit - 1));
      if (end < limit / 3) end = limit - 1;
      let cut = end + 1;
      if (/[\uD800-\uDBFF]/.test(rest[cut - 1] || "")) cut--;
      result.push(rest.slice(0, cut));
      rest = rest.slice(cut).trimStart();
    }
    if (rest) result.push(rest);
    return result;
  }

  // src/ui-state.js
  var shallowEqual = (a, b) => a === b || Boolean(
    a && b && typeof a === "object" && typeof b === "object" && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((k) => Object.is(a[k], b[k]))
  );
  function createStore(initial) {
    let state = initial;
    const listeners = /* @__PURE__ */ new Set();
    return {
      get: () => state,
      set(patch) {
        state = { ...state, ...patch };
        for (const entry of listeners) {
          const value = entry.select(state);
          if (!shallowEqual(value, entry.value)) {
            entry.value = value;
            entry.notify();
          }
        }
      },
      subscribe(select, notify) {
        const entry = { select, notify, value: select(state) };
        listeners.add(entry);
        return () => listeners.delete(entry);
      },
      clear: () => listeners.clear()
    };
  }
  var replyConfig = (s) => ({
    enabled: s.config?.enabled,
    dshEnabled: s.config?.dshEnabled,
    playbackEnabled: s.config?.playbackEnabled
  });
  function createBodyReader() {
    const cache = /* @__PURE__ */ new WeakMap();
    return (snapshot, messageId) => {
      if (!snapshot || typeof snapshot !== "object") return "";
      let index = cache.get(snapshot);
      if (!index) {
        index = /* @__PURE__ */ new Map();
        const nodes = snapshot.nodes;
        const values = typeof nodes?.values === "function" ? nodes.values() : Array.isArray(nodes) ? nodes : Object.values(nodes || {});
        for (const n of values)
          for (const a of [
            n,
            n?.data,
            n?.data?.finalNode,
            n?.data?.closing?.finalNode
          ])
            if (a?.kind === "assistant" && a.messageId && !index.has(a.messageId))
              index.set(
                a.messageId,
                (a.blocks || []).filter((b) => b.kind === "text").map((b) => b.text).join("\n")
              );
        cache.set(snapshot, index);
      }
      return index.get(messageId) || "";
    };
  }
  var parseKeyterms = (text) => text.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  var selectionKey = (text) => spokenText(text).normalize("NFKC").replace(/[\s\p{P}\p{S}]+/gu, "");
  function selectedBody(body, element, selection) {
    if (!selection || selection.isCollapsed || !selection.rangeCount) return "";
    const text = selection.toString().trim(), key = selectionKey(text);
    const node = selection.anchorNode?.parentElement, focus = selection.focusNode?.parentElement, turn = element?.closest("[data-chat-turn]");
    if (!turn || !node || !focus || !turn.contains(node) || !turn.contains(focus))
      return "";
    if (!key || !selectionKey(body).includes(key)) return "";
    const internal = "[data-turn-process],[data-step-process-content],details,[data-tool-call]";
    if (node.closest(internal) || focus.closest(internal)) return "";
    const range = selection.getRangeAt?.(0);
    if (range?.cloneContents?.().querySelector?.(internal)) return "";
    return text;
  }
  function createSelectionHub(document2, getSelection) {
    const owners = /* @__PURE__ */ new Set();
    let active = null;
    const refresh = () => {
      const selection = getSelection();
      let next = null, text = "";
      for (const owner of owners) {
        const value = selectedBody(owner.body(), owner.element(), selection);
        if (value) {
          next = owner;
          text = value;
          break;
        }
      }
      if (active && active !== next) active.notify("");
      if (next) next.notify(text);
      active = next;
    };
    return {
      register(owner) {
        if (!owners.size) document2.addEventListener("selectionchange", refresh);
        owners.add(owner);
        return () => {
          owners.delete(owner);
          if (active === owner) active = null;
          if (!owners.size)
            document2.removeEventListener("selectionchange", refresh);
        };
      },
      clear() {
        document2.removeEventListener("selectionchange", refresh);
        owners.clear();
        active = null;
      }
    };
  }

  // src/client.js
  window.__ModuleLoader__.load({
    id: "dsh-elevenlabs-voice",
    factory(require2) {
      const R = require2("react"), { jsx: h } = require2("react/jsx-runtime");
      const { useState, useEffect, useRef } = R;
      return {
        name: "elevenlabs-voice",
        inject: ["slots", "conversation", "uiConversation", "sessions"],
        apply(ctx) {
          const base = "/dsh-elevenlabs-voice";
          let state = {
            config: null,
            keyPresent: false,
            recording: null,
            status: "",
            error: "",
            pending: null,
            player: null,
            devices: [],
            level: 0,
            elapsed: 0
          }, token = "", disposed = false, currentSession = null, rec = null, recordGeneration = 0, playerGeneration = 0;
          const store = createStore(state), requests = /* @__PURE__ */ new Set(), cache = /* @__PURE__ */ new Map();
          const bodyReader = createBodyReader(), selectionHub = createSelectionHub(
            document,
            () => window.getSelection()
          );
          const identity = (s) => s;
          let cacheBytes = 0;
          const update = (patch) => {
            state = { ...state, ...patch };
            store.set(patch);
          };
          function useStore(select = identity) {
            const [, render] = useState(0);
            useEffect(
              () => store.subscribe(select, () => render((v) => v + 1)),
              [select]
            );
            return select(state);
          }
          async function request(route, body, options = {}) {
            const controller = new AbortController();
            requests.add(controller);
            const abort = () => controller.abort();
            options.signal?.addEventListener("abort", abort, { once: true });
            if (options.signal?.aborted) abort();
            try {
              const res = await fetch(base + route, {
                method: options.method || (body === void 0 ? "GET" : "POST"),
                headers: {
                  ...body === void 0 ? {} : {
                    "x-elevenlabs-csrf": token,
                    "content-type": options.raw ? body.type : "application/json"
                  }
                },
                body: body === void 0 ? void 0 : options.raw ? body : JSON.stringify(body),
                signal: controller.signal
              });
              if (!res.ok) {
                let e;
                try {
                  e = await res.json();
                } catch {
                }
                throw Error(e?.error || "\u8BF7\u6C42\u5931\u8D25 HTTP " + res.status);
              }
              return options.audio ? {
                blob: await res.blob(),
                requestId: res.headers.get("x-elevenlabs-request-id") || null
              } : await res.json();
            } finally {
              requests.delete(controller);
              options.signal?.removeEventListener("abort", abort);
            }
          }
          const allowed = (feature) => state.config?.enabled && state.config?.dshEnabled && (feature === "stt" ? state.config.sttEnabled : state.config.playbackEnabled);
          function stopPlayback() {
            playerGeneration++;
            const p = state.player;
            if (p) {
              p.abort?.abort();
              p.audio?.pause();
              if (p.audio) {
                p.audio.removeAttribute("src");
                p.audio.load();
              }
            }
            update({ player: null });
          }
          function cancelRecording() {
            recordGeneration++;
            if (rec) {
              rec.cancelled = true;
              rec.abort?.abort();
              if (rec.recorder?.state === "recording") rec.recorder.stop();
              cleanupRecording(rec);
              rec = null;
            }
            update({
              recording: null,
              elapsed: 0,
              level: 0,
              status: "\u5DF2\u53D6\u6D88\u5F55\u97F3"
            });
          }
          function disable() {
            cancelRecording();
            stopPlayback();
            for (const c of requests) c.abort();
            for (const entry of cache.values()) URL.revokeObjectURL(entry.url);
            cache.clear();
            cacheBytes = 0;
            update({ pending: null });
          }
          async function refresh() {
            const s = await request("/state");
            if (disposed) return;
            token = s.csrfToken;
            const before = state.config;
            if (JSON.stringify(before) !== JSON.stringify(s.config))
              update({ config: s.config, keyPresent: s.keyPresent });
            else if (state.keyPresent !== s.keyPresent)
              update({ keyPresent: s.keyPresent });
            if (before && (!s.config.enabled || !s.config.dshEnabled)) {
              disable();
            } else if (before) {
              if (!s.config.sttEnabled && before.sttEnabled) cancelRecording();
              if (!s.config.playbackEnabled && before.playbackEnabled || s.config.voiceId !== before.voiceId || s.config.ttsModel !== before.ttsModel)
                stopPlayback();
            }
          }
          const dictationClient = Math.random().toString(36).slice(2) + Date.now().toString(36);
          let dictationSeq = 0, dictationOn = false;
          function dictation(active) {
            if (dictationOn === active) return;
            dictationOn = active;
            void request("/dictation", {
              client: dictationClient,
              seq: ++dictationSeq,
              active
            }).catch(() => {
            });
          }
          function cleanupRecording(r) {
            clearInterval(r.timer);
            r.stream?.getTracks().forEach((t) => t.stop());
            void r.context?.close().catch(() => {
            });
            if (!rec || rec === r) dictation(false);
          }
          function exists(sid) {
            try {
              const list = ctx.sessions.list.getSnapshot();
              return Boolean(
                list.byId?.[sid] || Array.isArray(list.sessions) && list.sessions.some((x) => x.id === sid)
              );
            } catch {
              return true;
            }
          }
          function insert(sid, text) {
            const shell = ctx.conversation.input.shell(sid);
            const span = shell.actions.captureInsertion();
            const draft = shell.projection?.detectText ?? shell.snapshot?.draft ?? shell.state.getSnapshot().draft;
            const result = shell.actions.insertText(
              insertion(draft, span, text),
              span
            );
            if (result) shell.actions.persistDraft();
            return result;
          }
          async function finish(r) {
            cleanupRecording(r);
            if (r.cancelled || r.generation !== recordGeneration || disposed)
              return;
            update({ recording: "transcribing", level: 0, status: "\u6B63\u5728\u8F6C\u5199\u2026" });
            try {
              const blob = new Blob(r.parts, { type: r.recorder.mimeType });
              if (!blob.size) throw Error("\u6CA1\u6709\u5F55\u5230\u97F3\u9891");
              const result = await request("/transcribe", blob, {
                raw: true,
                signal: r.abort.signal
              });
              if (r.cancelled || disposed || r.generation !== recordGeneration)
                return;
              if (!r.test && !exists(r.sid)) {
                update({ status: "\u539F\u4F1A\u8BDD\u5DF2\u5220\u9664\uFF0C\u8F6C\u5199\u7ED3\u679C\u5DF2\u4E22\u5F03", pending: null });
                return;
              }
              if (!result.hasSpeech) {
                update({ status: "\u672A\u8BC6\u522B\u5230\u6709\u6548\u8BED\u97F3\uFF0C\u8349\u7A3F\u4FDD\u6301\u4E0D\u53D8" });
                return;
              }
              if (r.test) {
                update({
                  pending: { text: result.text, sid: null },
                  status: "\u5F55\u97F3\u6D4B\u8BD5\u5B8C\u6210\uFF08\u4E0D\u4F1A\u81EA\u52A8\u53D1\u9001\uFF09"
                });
                return;
              }
              const same = currentSession === r.sid;
              let inserted = false;
              try {
                inserted = insert(r.sid, result.text);
              } catch {
              }
              if (inserted) {
                update({
                  status: same ? "\u8F6C\u5199\u5DF2\u63D2\u5165\uFF0C\u53EF\u7F16\u8F91\u5E76\u6309 Ctrl+Z \u64A4\u9500" : "\u8F6C\u5199\u5DF2\u5199\u56DE\u539F\u4F1A\u8BDD\u8349\u7A3F"
                });
                if (same && state.config.autoSend && allowed("stt"))
                  await ctx.conversation.input.shell(r.sid).actions.submit();
              } else
                update({
                  pending: { text: result.text, sid: r.sid },
                  status: "\u539F\u8349\u7A3F\u4E0D\u53EF\u7528\uFF1B\u6587\u672C\u5DF2\u4FDD\u7559\uFF0C\u8BF7\u590D\u5236\u6216\u63D2\u5165\u5F53\u524D\u4F1A\u8BDD"
                });
            } catch (e) {
              if (!r.cancelled && e.name !== "AbortError")
                update({ error: e.message, status: "\u8F6C\u5199\u672A\u5B8C\u6210" });
            } finally {
              if (rec === r) rec = null;
              if (r.generation === recordGeneration)
                update({ recording: null, elapsed: 0, level: 0 });
            }
          }
          function stopRecording() {
            if (rec?.recorder?.state === "recording") {
              update({
                recording: "transcribing",
                status: "\u5F55\u97F3\u7ED3\u675F\uFF0C\u6B63\u5728\u4E0A\u4F20\u2026"
              });
              rec.recorder.stop();
            }
          }
          async function startRecording(sid, test = false) {
            if (!allowed("stt") || rec) return;
            if (!state.keyPresent) {
              update({
                error: "DSH \u672A\u8BFB\u53D6\u5230 ELEVENLABS_API_KEY\uFF1B\u8BBE\u7F6E\u73AF\u5883\u53D8\u91CF\u540E\u8BF7\u5B8C\u5168\u9000\u51FA\u5E76\u91CD\u542F DSH"
              });
              return;
            }
            if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
              update({
                error: "\u5F53\u524D\u6D4F\u89C8\u5668\u4E0D\u652F\u6301\u5F55\u97F3\uFF0C\u8BF7\u4F7F\u7528 DSH \u684C\u9762\u7AEF\u6216 Chromium \u5B89\u5168\u9875\u9762"
              });
              return;
            }
            const r = {
              sid,
              test,
              parts: [],
              cancelled: false,
              generation: ++recordGeneration,
              abort: new AbortController()
            };
            rec = r;
            dictation(true);
            update({
              recording: "requesting",
              status: "\u7B49\u5F85\u9EA6\u514B\u98CE\u6743\u9650\u2026",
              error: ""
            });
            try {
              const stream = await navigator.mediaDevices.getUserMedia({
                audio: state.config.inputDevice ? { deviceId: { exact: state.config.inputDevice } } : true
              });
              r.stream = stream;
              if (r.cancelled || r.generation !== recordGeneration || disposed) {
                cleanupRecording(r);
                return;
              }
              const mime = [
                "audio/webm;codecs=opus",
                "audio/ogg;codecs=opus",
                "audio/mp4"
              ].find((x) => MediaRecorder.isTypeSupported(x));
              r.recorder = new MediaRecorder(
                stream,
                mime ? { mimeType: mime } : {}
              );
              r.context = new AudioContext();
              const analyser = r.context.createAnalyser();
              analyser.fftSize = 256;
              r.context.createMediaStreamSource(stream).connect(analyser);
              const samples = new Uint8Array(analyser.fftSize);
              r.started = Date.now();
              r.recorder.ondataavailable = (e) => {
                if (e.data.size) r.parts.push(e.data);
              };
              r.recorder.onstop = () => void finish(r);
              r.recorder.onerror = () => {
                update({ error: "\u5F55\u97F3\u8BBE\u5907\u53D1\u751F\u9519\u8BEF" });
                cancelRecording();
              };
              r.recorder.start(1e3);
              update({
                recording: "recording",
                status: "\u5F55\u97F3\u4E2D\uFF1B\u518D\u6B21\u70B9\u51FB\u9EA6\u514B\u98CE\u7ED3\u675F"
              });
              r.timer = setInterval(() => {
                if (r.cancelled) return;
                analyser.getByteTimeDomainData(samples);
                const level = Math.min(
                  1,
                  Math.sqrt(
                    samples.reduce((sum, x) => sum + ((x - 128) / 128) ** 2, 0) / samples.length
                  ) * 4
                );
                const elapsed = Math.floor((Date.now() - r.started) / 1e3);
                update({ level, elapsed });
                if (elapsed >= state.config.maxSeconds) stopRecording();
              }, 100);
              void devices();
            } catch (e) {
              cleanupRecording(r);
              if (!r.cancelled)
                update({
                  error: e.name === "NotAllowedError" ? "\u9EA6\u514B\u98CE\u6743\u9650\u672A\u6388\u4E88\uFF0C\u8BF7\u5728\u7CFB\u7EDF\u6216\u6D4F\u89C8\u5668\u8BBE\u7F6E\u4E2D\u5141\u8BB8" : e.message,
                  recording: null,
                  status: ""
                });
              if (rec === r) rec = null;
            }
          }
          async function devices() {
            try {
              const list = await navigator.mediaDevices?.enumerateDevices();
              if (!disposed) update({ devices: list || [] });
            } catch {
            }
          }
          async function cachedAudio(text, sid, config, signal, stitching = {}) {
            const key = JSON.stringify([
              sid,
              text,
              config.voiceId,
              config.ttsModel,
              "mp3_44100_128",
              stitching.previous_text || "",
              stitching.next_text || ""
            ]);
            if (cache.has(key)) {
              const item2 = cache.get(key);
              cache.delete(key);
              cache.set(key, item2);
              return item2;
            }
            const { blob, requestId } = await request(
              "/tts",
              { text, stitching },
              { audio: true, signal }
            );
            if (signal.aborted || disposed)
              throw new DOMException("Cancelled", "AbortError");
            const item = {
              url: URL.createObjectURL(blob),
              size: blob.size,
              requestId,
              at: Date.now()
            };
            cache.set(key, item);
            cacheBytes += blob.size;
            while (cache.size > 64 || cacheBytes > 64 * 1024 * 1024) {
              const first = cache.keys().next().value, old = cache.get(first);
              cache.delete(first);
              cacheBytes -= old.size;
              URL.revokeObjectURL(old.url);
            }
            return item;
          }
          async function play(text, sid, label = "\u56DE\u7B54") {
            if (!allowed("tts")) return;
            stopPlayback();
            const parts = chunks(text);
            if (!parts.length) {
              update({ error: "\u8FD9\u6761\u56DE\u7B54\u6CA1\u6709\u53EF\u6717\u8BFB\u7684\u6B63\u6587" });
              return;
            }
            const generation = playerGeneration, cfg = { ...state.config }, abort = new AbortController();
            const p = {
              audio: new Audio(),
              abort,
              index: 0,
              total: parts.length,
              paused: false,
              loading: true,
              progress: 0,
              label,
              segmentProgress: 0
            };
            p.audio.volume = cfg.volume;
            update({ player: p, error: "" });
            p.audio.ontimeupdate = () => {
              p.segmentProgress = p.audio.duration ? p.audio.currentTime / p.audio.duration : 0;
              p.progress = (p.index + p.segmentProgress) / parts.length;
              if (state.player?.audio === p.audio)
                update({
                  player: {
                    ...p,
                    progress: p.progress
                  }
                });
            };
            p.audio.onpause = () => {
              p.paused = true;
              if (state.player?.audio === p.audio) update({ player: { ...p } });
            };
            p.audio.onplay = () => {
              p.paused = false;
              if (state.player?.audio === p.audio) update({ player: { ...p } });
            };
            const tasks = /* @__PURE__ */ new Map(), items = /* @__PURE__ */ new Map();
            const prepare = (index) => {
              if (tasks.has(index)) return tasks.get(index);
              const task = (async () => {
                const stitching = cfg.ttsModel === "eleven_v3" ? {} : {
                  previous_text: parts[index - 1] || "",
                  next_text: parts[index + 1] || ""
                };
                const previous = [...items.entries()].filter(
                  ([i, item2]) => i < index && item2.requestId && Date.now() - item2.at < 2 * 60 * 60 * 1e3
                ).sort((a, b) => a[0] - b[0]).slice(-3).map(([, item2]) => item2.requestId);
                if (previous.length && cfg.ttsModel !== "eleven_v3")
                  stitching.previous_request_ids = previous;
                const item = await cachedAudio(
                  parts[index],
                  sid,
                  cfg,
                  abort.signal,
                  stitching
                );
                items.set(index, item);
                return item;
              })();
              tasks.set(index, task);
              task.catch(() => {
                if (tasks.get(index) === task) tasks.delete(index);
              });
              return task;
            };
            const run = async () => {
              if (generation !== playerGeneration || abort.signal.aborted) return;
              try {
                p.loading = true;
                p.segmentProgress = 0;
                p.progress = p.index / parts.length;
                update({ player: { ...p } });
                const item = await prepare(p.index);
                if (generation !== playerGeneration || abort.signal.aborted)
                  return;
                p.audio.src = item.url;
                if (cfg.outputDevice) {
                  if (!p.audio.setSinkId)
                    throw Error("\u6B64\u6D4F\u89C8\u5668\u4E0D\u652F\u6301\u9009\u62E9\u8F93\u51FA\u8BBE\u5907\uFF0C\u8BF7\u6539\u7528\u7CFB\u7EDF\u9ED8\u8BA4");
                  await p.audio.setSinkId(cfg.outputDevice);
                }
                p.loading = false;
                update({ player: { ...p } });
                await p.audio.play();
                if (generation !== playerGeneration || abort.signal.aborted)
                  return;
                if (p.index + 1 < parts.length)
                  void prepare(p.index + 1).catch(() => {
                  });
              } catch (e) {
                if (e.name !== "AbortError" && generation === playerGeneration)
                  update({
                    error: e.name === "NotAllowedError" ? "\u6D4F\u89C8\u5668\u963B\u6B62\u64AD\u653E\uFF0C\u8BF7\u70B9\u51FB\u7EE7\u7EED\u64AD\u653E" : e.message,
                    player: { ...p, loading: false, paused: true }
                  });
              }
            };
            p.audio.onended = () => {
              if (generation !== playerGeneration) return;
              if (++p.index < parts.length) void run();
              else {
                p.index = parts.length - 1;
                p.paused = true;
                p.progress = 1;
                update({ player: { ...p } });
              }
            };
            p.audio.onerror = () => {
              if (generation === playerGeneration)
                update({
                  error: "\u97F3\u9891\u64AD\u653E\u5931\u8D25\uFF0C\u8BF7\u68C0\u67E5\u8F93\u51FA\u8BBE\u5907",
                  player: { ...p, loading: false, paused: true }
                });
            };
            p.replay = () => void play(text, sid, label);
            void run();
          }
          function Mic({ sessionId }) {
            const s = useStore();
            useEffect(() => {
              currentSession = sessionId;
              return () => {
                if (currentSession === sessionId) currentSession = null;
                if (rec?.sid === sessionId && rec.recorder?.state === "recording")
                  stopRecording();
                else if (rec?.sid === sessionId && !rec.recorder)
                  cancelRecording();
              };
            }, [sessionId]);
            if (!allowed("stt")) return null;
            return h("button", {
              className: "elv-button",
              title: s.recording ? "\u7ED3\u675F\u5F55\u97F3\u5E76\u8F6C\u5199" : "ElevenLabs \u8BED\u97F3\u8F93\u5165",
              disabled: s.recording === "transcribing" || s.recording === "requesting",
              onClick: () => s.recording ? stopRecording() : void startRecording(sessionId),
              children: s.recording === "recording" ? "\u23F9 " + s.elapsed + "s" : s.recording ? "\u2026" : "\u{1F399}"
            });
          }
          function Reply({ sessionId, messageId }) {
            const config = useStore(replyConfig), element = useRef(null), bodyRef = useRef("");
            const [selection, setSelection] = useState(""), [, renderBody] = useState(0);
            const chat = () => ctx.uiConversation.binding(sessionId).target("chat");
            try {
              bodyRef.current = bodyReader(chat().getSnapshot(), messageId);
            } catch {
              bodyRef.current = "";
            }
            useEffect(() => {
              let source;
              try {
                source = chat();
              } catch {
                return;
              }
              return source?.subscribe?.(() => {
                let next = "";
                try {
                  next = bodyReader(source.getSnapshot(), messageId);
                } catch {
                }
                if (next !== bodyRef.current) {
                  bodyRef.current = next;
                  setSelection("");
                  renderBody((v) => v + 1);
                }
              });
            }, [sessionId, messageId]);
            useEffect(
              () => selectionHub.register({
                element: () => element.current,
                body: () => bodyRef.current,
                notify: setSelection
              }),
              [sessionId, messageId]
            );
            if (!config.enabled || !config.dshEnabled || !config.playbackEnabled || !bodyRef.current)
              return null;
            return h("span", {
              className: "elv-reply",
              ref: element,
              children: [
                h("button", {
                  className: "elv-button",
                  title: "\u4EC5\u6717\u8BFB\u8FD9\u6761\u56DE\u7B54\u6B63\u6587",
                  onClick: () => void play(bodyRef.current, sessionId),
                  children: "\u25B6 \u6717\u8BFB"
                }),
                selection && h("button", {
                  className: "elv-button",
                  onPointerDown: (e) => e.preventDefault(),
                  onClick: () => {
                    const text = selectedBody(
                      bodyRef.current,
                      element.current,
                      window.getSelection()
                    );
                    if (text) void play(text, sessionId, "\u9009\u4E2D\u5185\u5BB9");
                    else setSelection("");
                  },
                  children: "\u6717\u8BFB\u9009\u4E2D\u5185\u5BB9"
                })
              ]
            });
          }
          function Panel() {
            const s = useStore();
            if (!s.config?.enabled || !s.config?.dshEnabled) return null;
            if (!s.recording && !s.pending && !s.player && !s.error && !s.status)
              return null;
            const p = s.player;
            return h("div", {
              className: "elv-panel",
              children: [
                h("strong", { children: "ElevenLabs Voice" }),
                s.recording && h("div", {
                  children: [
                    s.status + " " + s.elapsed + "s ",
                    h("meter", { min: 0, max: 1, value: s.level }),
                    s.recording === "recording" && h("button", {
                      onClick: stopRecording,
                      children: "\u7ED3\u675F\u5E76\u8F6C\u5199"
                    }),
                    h("button", { onClick: cancelRecording, children: "\u53D6\u6D88" })
                  ]
                }),
                !s.recording && s.status && h("div", { children: s.status }),
                s.pending && h("div", {
                  children: [
                    h("textarea", {
                      value: s.pending.text,
                      onChange: (e) => update({
                        pending: { ...s.pending, text: e.target.value }
                      })
                    }),
                    h("button", {
                      onClick: () => void navigator.clipboard.writeText(s.pending.text).then(() => update({ status: "\u5DF2\u590D\u5236" })).catch(
                        () => update({ error: "\u590D\u5236\u5931\u8D25\uFF0C\u8BF7\u624B\u52A8\u9009\u62E9\u6587\u672C\u590D\u5236" })
                      ),
                      children: "\u590D\u5236"
                    }),
                    h("button", {
                      onClick: () => {
                        try {
                          if (!currentSession || !insert(currentSession, s.pending.text))
                            throw Error("\u8BF7\u5148\u6253\u5F00\u53EF\u7F16\u8F91\u7684\u4F1A\u8BDD");
                          update({
                            pending: null,
                            status: "\u5DF2\u63D2\u5165\u5F53\u524D\u4F1A\u8BDD\uFF0C\u8BF7\u68C0\u67E5\u540E\u53D1\u9001"
                          });
                        } catch (e) {
                          update({ error: e.message });
                        }
                      },
                      children: "\u63D2\u5165\u5F53\u524D\u4F1A\u8BDD"
                    }),
                    h("button", {
                      onClick: () => update({ pending: null }),
                      children: "\u4E22\u5F03"
                    })
                  ]
                }),
                p && h("div", {
                  children: [
                    h("span", {
                      children: (p.loading ? "\u751F\u6210\u4E2D\u2026" : p.paused ? "\u5DF2\u6682\u505C" : "\u64AD\u653E\u4E2D") + " " + p.label + " " + (p.index + 1) + "/" + p.total
                    }),
                    h("button", {
                      disabled: p.loading,
                      onClick: () => {
                        if (p.audio.paused)
                          void p.audio.play().catch((e) => update({ error: e.message }));
                        else p.audio.pause();
                      },
                      children: p.paused ? "\u7EE7\u7EED" : "\u6682\u505C"
                    }),
                    h("progress", {
                      max: 1,
                      value: p.progress,
                      "aria-label": "\u6574\u4F53\u64AD\u653E\u8FDB\u5EA6"
                    }),
                    h("button", { onClick: stopPlayback, children: "\u505C\u6B62" }),
                    h("button", {
                      disabled: p.loading,
                      onClick: p.replay,
                      children: "\u91CD\u64AD"
                    }),
                    h("input", {
                      type: "range",
                      min: 0,
                      max: 1,
                      step: 0.01,
                      value: p.segmentProgress,
                      title: "\u5F53\u524D\u6BB5\u8FDB\u5EA6\uFF1B\u603B\u4F53\u8FDB\u5EA6\u89C1\u4E0A\u65B9",
                      onChange: (e) => {
                        if (Number.isFinite(p.audio.duration))
                          p.audio.currentTime = Number(e.target.value) * p.audio.duration;
                      }
                    }),
                    h("label", {
                      children: [
                        "\u97F3\u91CF ",
                        h("input", {
                          type: "range",
                          min: 0,
                          max: 1,
                          step: 0.05,
                          defaultValue: s.config.volume,
                          onChange: (e) => {
                            p.audio.volume = Number(e.target.value);
                          }
                        })
                      ]
                    })
                  ]
                }),
                s.error && h("div", {
                  className: "elv-error",
                  children: [
                    s.error,
                    h("button", {
                      onClick: () => update({ error: "" }),
                      children: "\u5173\u95ED"
                    })
                  ]
                }),
                !s.recording && !p && !s.pending && h("button", {
                  onClick: () => update({ status: "", error: "" }),
                  children: "\u6536\u8D77"
                })
              ]
            });
          }
          function Settings() {
            const s = useStore(), [draft, setDraft] = useState(s.config), [keytermsText, setKeytermsText] = useState(
              s.config?.keyterms.join("\n") || ""
            ), [message, setMessage] = useState(null), [probe, setProbe] = useState(null), [busy, setBusy] = useState(false), [testText, setTestText] = useState("\u4F60\u597D\uFF0C\u8FD9\u662F\u4E00\u6761\u8BED\u97F3\u8BD5\u542C\u3002");
            useEffect(() => {
              setDraft(s.config);
              setKeytermsText(s.config?.keyterms.join("\n") || "");
            }, [s.config]);
            if (!draft)
              return h("div", {
                className: "elv-settings",
                children: h("p", {
                  className: "elv-loading",
                  children: "\u6B63\u5728\u8BFB\u53D6\u8BED\u97F3\u8BBE\u7F6E\u2026"
                })
              });
            const terms = parseKeyterms(keytermsText);
            const dirty = JSON.stringify({ ...draft, keyterms: terms }) !== JSON.stringify(s.config);
            const set = (key, value) => {
              setDraft({ ...draft, [key]: value });
              setMessage(null);
            };
            const id = (key) => "elv-" + key;
            const row = (key, label, hint, control, layout) => h("div", {
              className: "elv-row" + (layout ? " elv-row--" + layout : ""),
              children: [
                h("label", {
                  className: "elv-label",
                  htmlFor: id(key),
                  children: label
                }),
                hint && h("p", {
                  className: "elv-hint",
                  id: id(key) + "-hint",
                  children: hint
                }),
                h("div", { className: "elv-control", children: control })
              ]
            });
            const toggle = (key, label) => h("button", {
              type: "button",
              role: "switch",
              id: id(key),
              className: "elv-switch",
              "aria-checked": draft[key] ? "true" : "false",
              ...label ? { "aria-label": label } : { "aria-describedby": id(key) + "-hint" },
              onClick: () => set(key, !draft[key]),
              children: h("span", { className: "elv-switch-thumb" })
            });
            const text = (key, props = {}) => h("input", {
              id: id(key),
              className: "elv-input",
              value: draft[key],
              spellCheck: false,
              autoComplete: "off",
              "aria-describedby": id(key) + "-hint",
              onChange: (e) => set(key, e.target.value),
              ...props
            });
            const device = (key, kind) => h("select", {
              id: id(key),
              className: "elv-input",
              value: draft[key],
              "aria-describedby": id(key) + "-hint",
              onChange: (e) => set(key, e.target.value),
              children: [
                h("option", { value: "", children: "\u7CFB\u7EDF\u9ED8\u8BA4" }),
                ...s.devices.filter((x) => x.kind === kind && x.deviceId !== "default").map(
                  (x, i) => h(
                    "option",
                    {
                      value: x.deviceId,
                      children: x.label || "\u8BBE\u5907 " + (i + 1)
                    },
                    x.deviceId
                  )
                )
              ]
            });
            const button = (label, onClick, primary = false, disabled = busy) => h("button", {
              type: "button",
              className: "elv-btn" + (primary ? " elv-btn--primary" : ""),
              disabled,
              onClick,
              children: label
            });
            const card = (key, title, description, rows, action, off = false) => h("section", {
              className: "elv-card",
              "aria-labelledby": id(key) + "-title",
              "data-off": off ? "" : void 0,
              children: [
                h("div", {
                  className: "elv-card-head",
                  children: [
                    h("div", {
                      className: "elv-card-text",
                      children: [
                        h("h3", {
                          className: "elv-card-title",
                          id: id(key) + "-title",
                          children: title
                        }),
                        h("p", {
                          className: "elv-card-desc",
                          children: description
                        })
                      ]
                    }),
                    action || null
                  ]
                }),
                rows && h("div", { className: "elv-card-body", children: rows })
              ]
            });
            async function save() {
              setBusy(true);
              try {
                await request(
                  "/config",
                  { ...draft, keyterms: parseKeyterms(keytermsText) },
                  { method: "PUT" }
                );
                await refresh();
                setMessage({ tone: "ok", text: "\u5DF2\u4FDD\u5B58\uFF0C\u7ACB\u5373\u751F\u6548" });
                return true;
              } catch (e) {
                setMessage({ tone: "error", text: e.message });
                return false;
              } finally {
                setBusy(false);
              }
            }
            const volume = Math.round(draft.volume * 100);
            return h("div", {
              className: "elv-settings",
              children: [
                card(
                  "general",
                  "\u901A\u7528",
                  "\u7EDF\u4E00\u7BA1\u7406 DSH \u548C Pet \u7684 ElevenLabs \u8BED\u97F3\u3002",
                  [
                    row(
                      "enabled",
                      "\u542F\u7528\u8BED\u97F3\u63D2\u4EF6",
                      "\u5173\u95ED\u540E DSH \u548C Pet \u7684\u8BED\u97F3\u529F\u80FD\u90FD\u4F1A\u505C\u6B62\u3002",
                      toggle("enabled"),
                      "inline"
                    ),
                    row(
                      "dshEnabled",
                      "DSH \u8BED\u97F3",
                      "\u63A7\u5236\u8F93\u5165\u6846\u9EA6\u514B\u98CE\u548C\u56DE\u7B54\u6717\u8BFB\uFF0C\u4E0D\u5F71\u54CD Pet \u8BED\u97F3\u3002",
                      toggle("dshEnabled"),
                      "inline"
                    ),
                    row(
                      "key",
                      "ElevenLabs \u5BC6\u94A5",
                      "\u53EA\u4ECE DSH \u8FDB\u7A0B\u7684 ELEVENLABS_API_KEY \u73AF\u5883\u53D8\u91CF\u8BFB\u53D6\uFF0C\u63D2\u4EF6\u4E0D\u4FDD\u5B58\u4E5F\u4E0D\u663E\u793A\u3002\u4FEE\u6539\u540E\u9700\u5B8C\u5168\u9000\u51FA\u5E76\u91CD\u542F DSH\u3002",
                      h("span", {
                        id: id("key"),
                        className: "elv-chip",
                        "data-tone": s.keyPresent ? "ok" : "error",
                        children: s.keyPresent ? "\u5DF2\u8BFB\u53D6" : "\u672A\u627E\u5230"
                      }),
                      "inline"
                    ),
                    row(
                      "proxy",
                      "\u672C\u673A HTTP \u4EE3\u7406",
                      "\u4F8B\u5982 http://127.0.0.1:7897\uFF0C\u7559\u7A7A\u5219\u76F4\u8FDE\u3002\u53EA\u5141\u8BB8\u672C\u673A\u5730\u5740\u3002",
                      text("proxy", { placeholder: "\u7559\u7A7A\u76F4\u8FDE" })
                    ),
                    row(
                      "connection",
                      "\u8FDE\u63A5\u6D4B\u8BD5",
                      "\u8BFB\u53D6\u8D26\u6237\u53EF\u7528\u7684\u6A21\u578B\u3002\u63D0\u793A\u7F3A\u5C11\u6A21\u578B\u8BFB\u53D6\u6743\u9650\u4E0D\u4EE3\u8868\u5BC6\u94A5\u65E0\u6548\uFF0C\u53EF\u7528\u8BD5\u542C\u5355\u72EC\u9A8C\u8BC1\u6717\u8BFB\u3002",
                      h("div", {
                        className: "elv-action",
                        children: [
                          h("button", {
                            type: "button",
                            id: id("connection"),
                            className: "elv-btn",
                            disabled: busy,
                            onClick: async () => {
                              if (!await save()) return;
                              setBusy(true);
                              setProbe(null);
                              try {
                                const result = await request("/connection", {});
                                setProbe({
                                  tone: "ok",
                                  text: "\u5DF2\u8FDE\u63A5\uFF0C\u8BFB\u53D6\u5230 " + result.models.length + " \u4E2A\u6A21\u578B"
                                });
                              } catch (e) {
                                setProbe({ tone: "error", text: e.message });
                              } finally {
                                setBusy(false);
                              }
                            },
                            children: "\u4FDD\u5B58\u5E76\u6D4B\u8BD5\u8FDE\u63A5"
                          }),
                          probe && h("p", {
                            className: "elv-result",
                            "data-tone": probe.tone,
                            role: "status",
                            children: probe.text
                          })
                        ]
                      })
                    )
                  ]
                ),
                card(
                  "devices",
                  "\u97F3\u9891\u8BBE\u5907",
                  "\u8BBE\u5907\u540D\u79F0\u5728\u6388\u4E88\u9EA6\u514B\u98CE\u6743\u9650\u540E\u663E\u793A\u3002",
                  [
                    row(
                      "inputDevice",
                      "\u8F93\u5165\u8BBE\u5907",
                      "DSH \u542C\u5199\u4F7F\u7528\u7684\u9EA6\u514B\u98CE\u3002",
                      device("inputDevice", "audioinput")
                    ),
                    row(
                      "outputDevice",
                      "\u8F93\u51FA\u8BBE\u5907",
                      "\u56DE\u7B54\u6717\u8BFB\u4F7F\u7528\u7684\u626C\u58F0\u5668\uFF1B\u6D4F\u89C8\u5668\u4E0D\u652F\u6301\u65F6\u4F7F\u7528\u7CFB\u7EDF\u9ED8\u8BA4\u3002",
                      device("outputDevice", "audiooutput")
                    )
                  ],
                  h("button", {
                    type: "button",
                    className: "elv-text-btn",
                    onClick: () => void devices(),
                    children: "\u5237\u65B0\u8BBE\u5907\u5217\u8868"
                  })
                ),
                card(
                  "stt",
                  "\u8BED\u97F3\u8F93\u5165",
                  "\u70B9\u51FB\u8F93\u5165\u6846\u65C1\u7684\u9EA6\u514B\u98CE\u5F55\u97F3\uFF0C\u8F6C\u5199\u540E\u653E\u8FDB\u8F93\u5165\u6846\uFF0C\u53D1\u9001\u524D\u53EF\u4EE5\u4FEE\u6539\u3002",
                  [
                    row(
                      "sttModel",
                      "\u8F6C\u5199\u6A21\u578B",
                      "\u9ED8\u8BA4 scribe_v2\uFF0C\u81EA\u52A8\u8BC6\u522B\u4E2D\u6587\u3001\u82F1\u6587\u548C\u6DF7\u5408\u8BED\u8A00\u3002",
                      text("sttModel", { list: "elv-stt-models" })
                    ),
                    row(
                      "maxSeconds",
                      "\u6700\u957F\u5F55\u97F3",
                      "\u5230\u65F6\u81EA\u52A8\u7ED3\u675F\u5E76\u5F00\u59CB\u8F6C\u5199\u3002",
                      h("span", {
                        className: "elv-unit",
                        children: [
                          text("maxSeconds", {
                            type: "number",
                            min: 5,
                            max: 1800,
                            onChange: (e) => set("maxSeconds", Number(e.target.value))
                          }),
                          h("span", { children: "\u79D2" })
                        ]
                      })
                    ),
                    row(
                      "autoSend",
                      "\u8F6C\u5199\u540E\u81EA\u52A8\u53D1\u9001",
                      "\u9ED8\u8BA4\u5173\u95ED\u3002\u5207\u6362\u4F1A\u8BDD\u540E\u8FD4\u56DE\u7684\u8F6C\u5199\u4E0D\u4F1A\u81EA\u52A8\u53D1\u9001\u3002",
                      toggle("autoSend"),
                      "inline"
                    ),
                    row(
                      "keyterms",
                      "\u672F\u8BED\u8868",
                      "\u6BCF\u884C\u4E00\u4E2A\u6587\u4EF6\u540D\u3001\u547D\u4EE4\u6216\u4E13\u6709\u540D\u8BCD\uFF0C\u5E2E\u52A9\u8BC6\u522B\u66F4\u51C6\u786E\u3002\u4F1A\u4EA7\u751F\u989D\u5916\u8D39\u7528\uFF1B\u8D85\u8FC7 100 \u9879\u65F6\u6BCF\u6B21\u81F3\u5C11\u6309 20 \u79D2\u8BA1\u8D39\u3002",
                      [
                        h("textarea", {
                          id: id("keyterms"),
                          className: "elv-input elv-textarea",
                          rows: 5,
                          spellCheck: false,
                          placeholder: "config.json\nnpm run build",
                          value: keytermsText,
                          "aria-describedby": id("keyterms") + "-hint",
                          onChange: (e) => {
                            setKeytermsText(e.target.value);
                            setMessage(null);
                          }
                        }),
                        h("span", {
                          className: "elv-count",
                          "data-tone": terms.length > 1e3 ? "error" : void 0,
                          children: terms.length + " / 1000"
                        })
                      ],
                      "stack"
                    ),
                    row(
                      "recordTest",
                      "\u5F55\u97F3\u6D4B\u8BD5",
                      "\u5F55\u4E00\u6BB5\u8BDD\uFF0C\u53EA\u663E\u793A\u8F6C\u5199\u7ED3\u679C\uFF0C\u4E0D\u4F1A\u63D2\u5165\u6216\u53D1\u9001\u3002",
                      h("button", {
                        type: "button",
                        id: id("recordTest"),
                        className: "elv-btn",
                        disabled: busy || Boolean(s.recording),
                        onClick: async () => {
                          if (await save())
                            void startRecording(currentSession, true);
                        },
                        children: "\u4FDD\u5B58\u5E76\u5F55\u97F3\u6D4B\u8BD5"
                      })
                    ),
                    h("datalist", {
                      id: "elv-stt-models",
                      children: h("option", { value: "scribe_v2" })
                    })
                  ],
                  toggle("sttEnabled", "\u663E\u793A\u8F93\u5165\u6846\u9EA6\u514B\u98CE\u6309\u94AE"),
                  !draft.sttEnabled
                ),
                card(
                  "tts",
                  "\u56DE\u7B54\u6717\u8BFB",
                  "\u5728\u6BCF\u6761\u56DE\u7B54\u65C1\u663E\u793A\u64AD\u653E\u952E\uFF0C\u70B9\u51FB\u540E\u624D\u5408\u6210\uFF0C\u4E0D\u4F1A\u81EA\u52A8\u6717\u8BFB\u3002",
                  [
                    row(
                      "voiceId",
                      "Voice ID",
                      "\u5728 ElevenLabs \u58F0\u97F3\u5E93\u590D\u5236\u58F0\u97F3\u7684 ID\uFF0C\u5FC5\u987B\u662F\u4F60\u7684\u8D26\u6237\u53EF\u7528\u7684\u58F0\u97F3\u3002",
                      text("voiceId", { placeholder: "\u7C98\u8D34 Voice ID" })
                    ),
                    row(
                      "ttsModel",
                      "\u6717\u8BFB\u6A21\u578B",
                      "\u9ED8\u8BA4 eleven_v4\uFF1Beleven_v4_turbo \u66F4\u5FEB\u3002",
                      text("ttsModel", { list: "elv-tts-models" })
                    ),
                    row(
                      "volume",
                      "\u9ED8\u8BA4\u97F3\u91CF",
                      null,
                      h("span", {
                        className: "elv-range",
                        children: [
                          h("input", {
                            id: id("volume"),
                            type: "range",
                            min: 0,
                            max: 1,
                            step: 0.05,
                            value: draft.volume,
                            style: { "--elv-fill": volume + "%" },
                            onChange: (e) => set("volume", Number(e.target.value))
                          }),
                          h("output", {
                            htmlFor: id("volume"),
                            children: volume + "%"
                          })
                        ]
                      })
                    ),
                    row(
                      "preview",
                      "\u8BD5\u542C",
                      "\u7528\u5F53\u524D\u58F0\u97F3\u548C\u6A21\u578B\u5408\u6210\u4E0B\u9762\u8FD9\u53E5\u8BDD\uFF0C\u4F1A\u6D88\u8017\u989D\u5EA6\u3002",
                      h("div", {
                        className: "elv-preview",
                        children: [
                          h("input", {
                            id: id("preview"),
                            className: "elv-input",
                            value: testText,
                            "aria-describedby": id("preview") + "-hint",
                            onChange: (e) => setTestText(e.target.value)
                          }),
                          button("\u4FDD\u5B58\u5E76\u8BD5\u542C", async () => {
                            if (await save())
                              void play(testText, "settings", "\u8BD5\u542C");
                          })
                        ]
                      }),
                      "stack"
                    ),
                    h("datalist", {
                      id: "elv-tts-models",
                      children: [
                        h("option", { value: "eleven_v4" }, "v4"),
                        h("option", { value: "eleven_v4_turbo" }, "v4t")
                      ]
                    })
                  ],
                  toggle("playbackEnabled", "\u663E\u793A\u56DE\u7B54\u64AD\u653E\u952E"),
                  !draft.playbackEnabled
                ),
                card(
                  "pet",
                  "Pet \u8BED\u97F3",
                  "\u5728\u684C\u5BA0\u53F3\u952E\u83DC\u5355\u9009\u62E9\u300C\u8BED\u97F3\u5BF9\u8BDD\u300D\u6253\u5F00\u8BED\u97F3\u9762\u677F\u3002\u6BCF\u53EA Pet \u7684\u58F0\u97F3\u3001\u5BF9\u8BDD\u6A21\u578B\u3001\u5355\u6B21\u5BF9\u8BDD\u65F6\u957F\u548C\u81EA\u52A8\u51FA\u58F0\u90FD\u5728\u9762\u677F\u91CC\u5355\u72EC\u8BBE\u7F6E\uFF1B\u9EA6\u514B\u98CE\u53EA\u5728\u70B9\u51FB\u5F00\u59CB\u540E\u5F00\u542F\u3002"
                ),
                h("div", {
                  className: "elv-savebar",
                  "data-dirty": dirty ? "" : void 0,
                  children: [
                    h("p", {
                      className: "elv-savebar-text",
                      role: "status",
                      "data-tone": message?.tone,
                      children: message ? message.text : dirty ? "\u6709\u672A\u4FDD\u5B58\u7684\u66F4\u6539" : "\u8BBE\u7F6E\u5DF2\u662F\u6700\u65B0"
                    }),
                    button(
                      "\u8FD8\u539F",
                      () => {
                        setDraft(s.config);
                        setKeytermsText(s.config.keyterms.join("\n"));
                        setMessage(null);
                      },
                      false,
                      busy || !dirty
                    ),
                    button("\u4FDD\u5B58\u8BBE\u7F6E", () => void save(), true)
                  ]
                })
              ]
            });
          }
          const LEGACY_CSS = ".elv-button{border:1px solid #ccd6df88;border-radius:8px;padding:4px 9px;background:transparent;color:inherit;cursor:pointer;font-size:12px}.elv-reply{display:inline-flex;gap:5px}.elv-panel{position:fixed;bottom:74px;right:28px;z-index:10000;max-width:440px;max-height:70vh;overflow:auto;padding:16px;border:1px solid #95aabb77;border-radius:16px;background:var(--background,#f4f7fa);color:var(--foreground,#172a39);box-shadow:0 10px 40px #0002;font-size:13px}.elv-panel textarea{width:100%;min-height:80px}.elv-panel button{margin:5px;padding:4px 8px}.elv-panel input[type=range]{max-width:150px}.elv-error{color:#b33b3b}";
          const style = document.createElement("style");
          style.textContent = LEGACY_CSS + `
.elv-settings{--elv-ink:var(--dsw-alias-label-primary,#1f2328);--elv-ink-2:var(--dsw-alias-label-secondary,#59636e);--elv-ink-3:var(--dsw-alias-label-tertiary,#8b949e);--elv-line:var(--dsw-alias-border-l2,rgb(31 35 40 / 12%));--elv-card:var(--dsw-alias-bg-layer-3,#fff);--elv-page:var(--dsw-alias-bg-layer-2,#f6f7f9);--elv-chip:var(--dsw-alias-bg-module-platform,rgb(31 35 40 / 6%));--elv-brand:var(--dsw-alias-brand-primary,#3f6ae0);--elv-fill-btn:var(--dsw-alias-button-primary-fill,var(--elv-ink));--elv-on-fill:var(--dsw-alias-label-primary-foreground,var(--elv-card));--elv-error:var(--dsw-alias-state-error-primary,#b42318);--elv-rail:var(--dsw-alias-label-dimmed,rgb(31 35 40 / 22%));--elv-hover:var(--dsw-alias-interactive-bg-hover,rgb(31 35 40 / 5%));container:elv-settings/inline-size;display:flex;flex-direction:column;gap:16px;max-width:720px;color:var(--elv-ink);font-size:14px;line-height:22px}
.elv-settings *,.elv-settings *::before,.elv-settings *::after{box-sizing:border-box}
.elv-settings p{margin:0}
.elv-loading{color:var(--elv-ink-2);font-size:13px}
.elv-card{border:1px solid var(--elv-line);border-radius:12px;background:var(--elv-card)}
.elv-card-head{display:flex;align-items:center;gap:16px;padding:16px}
.elv-card-text{display:flex;flex:1;flex-direction:column;gap:4px;min-width:0}
.elv-card-title{margin:0;color:var(--elv-ink);font-size:15px;font-weight:600;line-height:1.4}
.elv-card-desc{color:var(--elv-ink-2);font-size:12px;line-height:18px}
.elv-card-body{margin:0 16px;padding-bottom:4px;border-top:1px solid var(--elv-line)}
.elv-card[data-off] .elv-row{opacity:.55}
.elv-row{display:grid;grid-template-columns:minmax(0,1fr) fit-content(52%);grid-template-areas:"label control" "hint control";align-items:center;gap:4px 24px;padding:16px 0}
.elv-row+.elv-row{border-top:1px solid var(--elv-line)}
.elv-row--stack{grid-template-columns:minmax(0,1fr);grid-template-areas:"label" "hint" "control";row-gap:4px}
.elv-row--stack>.elv-control{margin-top:8px;justify-self:stretch}
.elv-label{grid-area:label;color:var(--elv-ink);font-size:14px;line-height:22px}
.elv-hint{grid-area:hint;color:var(--elv-ink-2);font-size:12px;line-height:18px}
.elv-control{grid-area:control;justify-self:end;display:flex;align-items:center;min-width:0;max-width:100%}
.elv-input{width:240px;max-width:100%;height:34px;padding:0 12px;border:1px solid var(--elv-line);border-radius:8px;background:var(--elv-card);color:var(--elv-ink);font:inherit;font-size:13px;line-height:1.5}
.elv-input:hover{border-color:var(--elv-rail)}
.elv-input:focus-visible{border-color:var(--elv-brand);outline:none}
.elv-input::placeholder{color:var(--elv-ink-3)}
select.elv-input{padding-right:8px;cursor:pointer}
.elv-textarea{display:block;width:100%;height:auto;min-height:112px;padding:8px 12px;resize:vertical;font-family:ui-monospace,"Cascadia Mono",Consolas,monospace;font-size:12.5px;line-height:20px}
.elv-row--stack .elv-control{flex-direction:column;align-items:stretch;gap:6px}
.elv-count{align-self:flex-end;color:var(--elv-ink-3);font-size:12px;line-height:16px;font-variant-numeric:tabular-nums}
.elv-count[data-tone=error]{color:var(--elv-error)}
.elv-unit{display:inline-flex;align-items:center;gap:8px;color:var(--elv-ink-2);font-size:13px}
.elv-unit .elv-input{width:112px;font-variant-numeric:tabular-nums}
.elv-preview{display:flex;gap:8px;width:100%}
.elv-preview .elv-input{flex:1;width:auto}
.elv-action{display:flex;flex-direction:column;align-items:flex-end;gap:6px}
.elv-result{max-width:260px;color:var(--elv-ink-2);font-size:12px;line-height:18px;text-align:right;overflow-wrap:anywhere}
.elv-result[data-tone=error]{color:var(--elv-error)}
.elv-btn{display:inline-flex;align-items:center;justify-content:center;flex:none;height:32px;padding:0 14px;border:1px solid var(--elv-line);border-radius:8px;background:transparent;color:var(--elv-ink);font:inherit;font-size:13px;font-weight:500;line-height:1;white-space:nowrap;cursor:pointer;transition:background-color .12s ease,border-color .12s ease}
.elv-btn:hover:not(:disabled){background:var(--elv-hover);border-color:var(--elv-rail)}
.elv-btn--primary{border-color:transparent;background:var(--elv-fill-btn);color:var(--elv-on-fill)}
.elv-btn--primary:hover:not(:disabled){border-color:transparent;background:var(--elv-fill-btn);filter:brightness(1.08)}
.elv-btn:disabled{cursor:default;opacity:.45}
.elv-text-btn{flex:none;padding:2px 0;border:0;background:transparent;color:var(--elv-ink-2);font:inherit;font-size:12px;cursor:pointer}
.elv-text-btn:hover{color:var(--elv-ink)}
.elv-switch{position:relative;flex:none;width:36px;height:20px;margin:0;padding:0;border:0;border-radius:999px;background:var(--elv-rail);cursor:pointer;transition:background-color .18s ease}
.elv-switch-thumb{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--elv-card);box-shadow:0 1px 2px rgb(20 20 19 / 18%);transition:translate .18s ease}
.elv-switch[aria-checked=true]{background:var(--elv-fill-btn)}
.elv-switch[aria-checked=true] .elv-switch-thumb{translate:16px 0;background:var(--elv-on-fill)}
.elv-chip{display:inline-flex;align-items:center;gap:6px;padding:1px 10px;border-radius:999px;background:var(--elv-chip);color:var(--elv-ink);font-size:12px;line-height:20px;white-space:nowrap}
.elv-chip::before{content:"";width:6px;height:6px;border-radius:50%;background:#2f9461}
.elv-chip[data-tone=error]::before{background:var(--elv-error)}
.elv-range{display:inline-flex;align-items:center;gap:12px;width:240px;max-width:100%}
.elv-range output{min-width:38px;color:var(--elv-ink-2);font-size:12px;text-align:right;font-variant-numeric:tabular-nums}
.elv-range input{flex:1;min-width:0;height:20px;margin:0;background:transparent;appearance:none;cursor:pointer}
.elv-range input::-webkit-slider-runnable-track{height:4px;border-radius:999px;background:linear-gradient(to right,var(--elv-brand) var(--elv-fill,0%),color-mix(in srgb,var(--elv-ink) 12%,transparent) var(--elv-fill,0%))}
.elv-range input::-webkit-slider-thumb{width:14px;height:14px;margin-top:-5px;border:0;border-radius:50%;background:#fff;box-shadow:0 0 0 1px rgb(0 0 0 / 12%),0 1px 3px rgb(0 0 0 / 25%);appearance:none}
.elv-range input::-moz-range-track{height:4px;border-radius:999px;background:color-mix(in srgb,var(--elv-ink) 12%,transparent)}
.elv-range input::-moz-range-progress{height:4px;border-radius:999px;background:var(--elv-brand)}
.elv-range input::-moz-range-thumb{width:14px;height:14px;border:0;border-radius:50%;background:#fff;box-shadow:0 0 0 1px rgb(0 0 0 / 12%),0 1px 3px rgb(0 0 0 / 25%)}
.elv-settings :is(.elv-btn,.elv-text-btn,.elv-switch,.elv-range input):focus-visible{outline:2px solid var(--elv-brand);outline-offset:2px}
.elv-savebar{position:sticky;bottom:12px;z-index:1;display:flex;align-items:center;gap:8px;padding:10px 12px 10px 16px;border:1px solid var(--elv-line);border-radius:12px;background:var(--elv-card);box-shadow:0 4px 16px rgb(20 20 19 / 8%)}
.elv-savebar-text{flex:1;min-width:0;color:var(--elv-ink-2);font-size:13px;line-height:20px;overflow-wrap:anywhere}
.elv-savebar[data-dirty] .elv-savebar-text{color:var(--elv-ink)}
.elv-savebar[data-dirty] .elv-savebar-text:not([data-tone])::before{content:"";display:inline-block;width:7px;height:7px;margin-right:8px;border-radius:50%;background:var(--elv-brand);vertical-align:1px}
.elv-savebar-text[data-tone=error]{color:var(--elv-error)}
@container elv-settings (max-width:520px){.elv-row:not(.elv-row--inline){grid-template-columns:minmax(0,1fr);grid-template-areas:"label" "hint" "control";row-gap:4px}.elv-row:not(.elv-row--inline)>.elv-control{margin-top:8px;justify-self:stretch}.elv-input,.elv-range{width:100%}.elv-action{align-items:stretch}.elv-result{max-width:none;text-align:left}.elv-card-head{align-items:flex-start}}
@media (prefers-reduced-motion:reduce){.elv-switch,.elv-switch-thumb,.elv-btn{transition:none}}
`;
          document.head.append(style);
          const register = (slot, id, component, inject) => ctx.effect(
            () => ctx.slots.inject(slot, function* () {
              yield ctx.slots.register(
                {
                  name: slot,
                  id,
                  order: 50,
                  ...slot === "settings.section" ? { label: () => "ElevenLabs Voice" } : {},
                  ...inject ? { inject } : {}
                },
                component
              );
            })
          );
          register("settings.section", "elevenlabs-voice", Settings);
          register(
            "conversation.input.right",
            "elevenlabs-voice-mic",
            Mic,
            (sessionId) => ({ sessionId })
          );
          register(
            "conversation.chat.assistant-actions",
            "elevenlabs-voice-play",
            Reply,
            (sessionId) => ({ sessionId })
          );
          register("shell.overlay", "elevenlabs-voice-panel", Panel);
          void refresh().catch((e) => update({ error: e.message }));
          void devices();
          const timer = setInterval(() => void refresh().catch(() => {
          }), 1e4);
          ctx.effect(() => () => {
            disposed = true;
            clearInterval(timer);
            disable();
            style.remove();
            store.clear();
            selectionHub.clear();
          });
        }
      };
    }
  });
})();
