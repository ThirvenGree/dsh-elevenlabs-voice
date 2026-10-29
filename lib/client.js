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
  function assistantBody(snapshot, messageId) {
    const nodes = snapshot?.nodes;
    const entries = typeof nodes?.values === "function" ? [...nodes.values()] : Array.isArray(nodes) ? nodes : Object.values(nodes || {});
    for (const n of entries) {
      for (const a of [
        n,
        n?.data,
        n?.data?.finalNode,
        n?.data?.closing?.finalNode
      ])
        if (a?.kind === "assistant" && a.messageId === messageId)
          return (a.blocks || []).filter((b) => b.kind === "text").map((b) => b.text).join("\n");
    }
    return "";
  }

  // src/client.js
  window.__ModuleLoader__.load({
    id: "dsh-elevenlabs-voice",
    factory(require2) {
      const R = require2("react"), { jsx: h } = require2("react/jsx-runtime");
      const { useState, useEffect } = R;
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
          const listeners = /* @__PURE__ */ new Set(), requests = /* @__PURE__ */ new Set(), cache = /* @__PURE__ */ new Map();
          let cacheBytes = 0;
          const update = (patch) => {
            state = { ...state, ...patch };
            for (const fn of listeners) fn();
          };
          function useStore() {
            const [, render] = useState(0);
            useEffect(() => {
              const fn = () => render((v) => v + 1);
              listeners.add(fn);
              return () => listeners.delete(fn);
            }, []);
            return state;
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
              return options.audio ? res.blob() : res.json();
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
          function cleanupRecording(r) {
            clearInterval(r.timer);
            r.stream?.getTracks().forEach((t) => t.stop());
            void r.context?.close().catch(() => {
            });
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
          async function cachedAudio(text, sid, config, signal) {
            const key = JSON.stringify([
              sid,
              text,
              config.voiceId,
              config.ttsModel,
              "mp3_44100_128"
            ]);
            if (cache.has(key)) {
              const item2 = cache.get(key);
              cache.delete(key);
              cache.set(key, item2);
              return item2.url;
            }
            const blob = await request("/tts", { text }, { audio: true, signal });
            if (signal.aborted || disposed)
              throw new DOMException("Cancelled", "AbortError");
            const item = { url: URL.createObjectURL(blob), size: blob.size };
            cache.set(key, item);
            cacheBytes += blob.size;
            while (cache.size > 64 || cacheBytes > 64 * 1024 * 1024) {
              const first = cache.keys().next().value;
              const old = cache.get(first);
              cache.delete(first);
              cacheBytes -= old.size;
              URL.revokeObjectURL(old.url);
            }
            return item.url;
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
              label
            };
            p.audio.volume = cfg.volume;
            update({ player: p, error: "" });
            p.audio.ontimeupdate = () => {
              p.progress = p.audio.duration ? p.audio.currentTime / p.audio.duration : 0;
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
            const run = async () => {
              if (generation !== playerGeneration || abort.signal.aborted) return;
              try {
                p.loading = true;
                update({ player: { ...p } });
                p.audio.src = await cachedAudio(
                  parts[p.index],
                  sid,
                  cfg,
                  abort.signal
                );
                if (generation !== playerGeneration) return;
                if (cfg.outputDevice) {
                  if (!p.audio.setSinkId)
                    throw Error("\u6B64\u6D4F\u89C8\u5668\u4E0D\u652F\u6301\u9009\u62E9\u8F93\u51FA\u8BBE\u5907\uFF0C\u8BF7\u6539\u7528\u7CFB\u7EDF\u9ED8\u8BA4");
                  await p.audio.setSinkId(cfg.outputDevice);
                }
                p.loading = false;
                update({ player: { ...p } });
                await p.audio.play();
              } catch (e) {
                if (e.name !== "AbortError" && generation === playerGeneration) {
                  update({
                    error: e.name === "NotAllowedError" ? "\u6D4F\u89C8\u5668\u963B\u6B62\u64AD\u653E\uFF0C\u8BF7\u70B9\u51FB\u7EE7\u7EED\u64AD\u653E" : e.message,
                    player: { ...p, loading: false, paused: true }
                  });
                }
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
          function selected(body, button) {
            const selection = window.getSelection();
            if (!selection || selection.isCollapsed || !selection.rangeCount)
              return "";
            const text = selection.toString().trim();
            if (!text || !spokenText(body).includes(spokenText(text))) return "";
            const node = selection.anchorNode?.parentElement, focus = selection.focusNode?.parentElement;
            if (!node || !focus) return "";
            const turn = button?.closest("[data-chat-turn]");
            if (!turn || !turn.contains(node) || !turn.contains(focus)) return "";
            if (node.closest(
              "[data-turn-process],[data-step-process-content],details"
            ) || focus.closest(
              "[data-turn-process],[data-step-process-content],details"
            ))
              return "";
            return text;
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
            const s = useStore(), [selection, setSelection] = useState("");
            let body = "";
            try {
              body = assistantBody(
                ctx.uiConversation.binding(sessionId).target("chat").getSnapshot(),
                messageId
              );
            } catch {
            }
            useEffect(() => {
              const fn = () => setSelection(window.getSelection()?.toString().trim() || "");
              document.addEventListener("selectionchange", fn);
              return () => document.removeEventListener("selectionchange", fn);
            }, []);
            if (!allowed("tts") || !body) return null;
            return h("span", {
              className: "elv-reply",
              children: [
                h("button", {
                  className: "elv-button",
                  title: "\u4EC5\u6717\u8BFB\u8FD9\u6761\u56DE\u7B54\u6B63\u6587",
                  onClick: () => void play(body, sessionId),
                  children: "\u25B6 \u6717\u8BFB"
                }),
                selection && h("button", {
                  className: "elv-button",
                  onPointerDown: (e) => e.preventDefault(),
                  onClick: (e) => {
                    const text = selected(body, e.currentTarget);
                    if (text) void play(text, sessionId, "\u9009\u4E2D\u5185\u5BB9");
                    else
                      update({
                        error: "\u8BF7\u53EA\u9009\u4E2D\u8FD9\u6761\u56DE\u7B54\u7684\u6B63\u6587\uFF1B\u63A8\u7406\u4E0E\u5DE5\u5177\u8F93\u51FA\u4E0D\u80FD\u6717\u8BFB"
                      });
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
                      value: p.progress,
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
            const s = useStore(), [draft, setDraft] = useState(s.config), [message, setMessage] = useState(""), [busy, setBusy] = useState(false), [testText, setTestText] = useState("\u4F60\u597D\uFF0C\u8FD9\u662F\u4E00\u6761\u8BED\u97F3\u8BD5\u542C\u3002");
            useEffect(() => setDraft(s.config), [s.config]);
            if (!draft) return h("div", { children: "\u6B63\u5728\u8BFB\u53D6\u8BED\u97F3\u8BBE\u7F6E\u2026" });
            const set = (key, value) => setDraft({ ...draft, [key]: value });
            const field = (label, key, type = "text") => h("label", {
              className: "elv-field",
              children: [
                h("span", { children: label }),
                h("input", {
                  type,
                  value: draft[key],
                  min: key === "maxSeconds" ? 5 : void 0,
                  max: key === "maxSeconds" ? 1800 : void 0,
                  onChange: (e) => set(
                    key,
                    type === "number" ? Number(e.target.value) : e.target.value
                  )
                })
              ]
            });
            const toggle = (label, key) => h("label", {
              className: "elv-toggle",
              children: [
                h("input", {
                  type: "checkbox",
                  checked: draft[key],
                  onChange: (e) => set(key, e.target.checked)
                }),
                label
              ]
            });
            const selectDevice = (label, key, kind) => h("label", {
              className: "elv-field",
              children: [
                h("span", { children: label }),
                h("select", {
                  value: draft[key],
                  onChange: (e) => set(key, e.target.value),
                  children: [
                    h("option", { value: "", children: "\u7CFB\u7EDF\u9ED8\u8BA4" }),
                    ...s.devices.filter(
                      (x) => x.kind === kind && x.deviceId !== "default"
                    ).map(
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
                })
              ]
            });
            async function save() {
              setBusy(true);
              try {
                await request("/config", draft, { method: "PUT" });
                await refresh();
                setMessage("\u5DF2\u4FDD\u5B58\uFF0C\u5373\u65F6\u751F\u6548");
                return true;
              } catch (e) {
                setMessage(e.message);
                return false;
              } finally {
                setBusy(false);
              }
            }
            return h("div", {
              className: "elv-settings",
              children: [
                h("div", {
                  className: "elv-hero",
                  children: [
                    h("h2", { children: "ElevenLabs Voice" }),
                    h("p", {
                      children: "\u6309\u9700\u5F55\u97F3\u4E0E\u6717\u8BFB \xB7 Core + DSH Voice \xB7 \u7B2C\u4E00\u9636\u6BB5"
                    }),
                    h("span", {
                      className: s.keyPresent ? "elv-badge" : "elv-error",
                      children: s.keyPresent ? "\u73AF\u5883\u53D8\u91CF\u5DF2\u8BFB\u53D6" : "\u7F3A\u5C11 ELEVENLABS_API_KEY"
                    }),
                    h("p", {
                      children: "\u5BC6\u94A5\u53EA\u4ECE DSH \u8FDB\u7A0B\u73AF\u5883\u8BFB\u53D6\uFF0C\u4E0D\u5728\u63D2\u4EF6\u4E2D\u4FDD\u5B58\u6216\u663E\u793A\u3002\u66F4\u6539 Windows \u73AF\u5883\u53D8\u91CF\u540E\u8BF7\u5B8C\u5168\u9000\u51FA\u5E76\u91CD\u542F DSH\u3002"
                    })
                  ]
                }),
                h("section", {
                  children: [
                    toggle("\u542F\u7528\u7EDF\u4E00\u8BED\u97F3\u63D2\u4EF6", "enabled"),
                    toggle("\u542F\u7528 DSH Voice", "dshEnabled")
                  ]
                }),
                h("section", {
                  children: [
                    h("h3", { children: "\u8BED\u97F3\u8F93\u5165" }),
                    toggle("\u663E\u793A\u8F93\u5165\u6846\u9EA6\u514B\u98CE\u6309\u94AE", "sttEnabled"),
                    field("STT \u6A21\u578B ID", "sttModel"),
                    h("small", {
                      children: "\u9ED8\u8BA4 scribe_v2\uFF1B\u652F\u6301\u624B\u52A8\u8F93\u5165\u5176\u4ED6\u53EF\u7528\u6A21\u578B ID\u3002\u81EA\u52A8\u8BC6\u522B\u4E2D\u6587\u3001\u82F1\u6587\u548C\u6DF7\u5408\u8BED\u8A00\u3002"
                    }),
                    toggle("\u8F6C\u5199\u540E\u81EA\u52A8\u53D1\u9001\uFF08\u9ED8\u8BA4\u5173\u95ED\uFF09", "autoSend"),
                    field("\u6700\u5927\u5F55\u97F3\u65F6\u957F / \u79D2", "maxSeconds", "number"),
                    selectDevice("\u8F93\u5165\u8BBE\u5907", "inputDevice", "audioinput"),
                    h("button", {
                      disabled: busy || Boolean(s.recording),
                      onClick: async () => {
                        if (await save())
                          void startRecording(currentSession, true);
                      },
                      children: "\u5F55\u97F3\u6D4B\u8BD5\uFF08\u4E0D\u4F1A\u53D1\u9001\uFF09"
                    }),
                    h("label", {
                      className: "elv-field",
                      children: [
                        h("span", { children: "\u5173\u952E\u8BCD\uFF08\u6BCF\u884C\u4E00\u4E2A\uFF09" }),
                        h("textarea", {
                          rows: 5,
                          value: draft.keyterms.join("\n"),
                          onChange: (e) => set(
                            "keyterms",
                            e.target.value.split("\n").filter((x) => x.trim())
                          )
                        })
                      ]
                    }),
                    h("small", {
                      children: "\u6700\u591A 1000 \u9879\uFF1B\u6BCF\u9879\u5C11\u4E8E 50 \u5B57\u7B26\u3001\u81F3\u591A 5 \u4E2A\u8BCD\u3002\u5173\u952E\u8BCD\u6709\u989D\u5916\u8D39\u7528\uFF1B\u8D85\u8FC7 100 \u9879\u53EF\u80FD\u6309\u81F3\u5C11 20 \u79D2\u8BA1\u8D39\u3002\u8F6C\u5199\u4FDD\u7559\u97F3\u9891\u4E8B\u4EF6\u6807\u7B7E\uFF0C\u4E0D\u7ECF\u8FC7\u6A21\u578B\u6DA6\u8272\u3002"
                    })
                  ]
                }),
                h("section", {
                  children: [
                    h("h3", { children: "\u56DE\u7B54\u6717\u8BFB" }),
                    toggle("\u663E\u793A\u56DE\u7B54\u6B63\u6587\u64AD\u653E\u6309\u94AE", "playbackEnabled"),
                    field("TTS \u6A21\u578B ID", "ttsModel"),
                    h("small", {
                      children: "\u9ED8\u8BA4 eleven_v4\uFF1B\u53EF\u5207\u6362 eleven_v4_turbo \u6216\u586B\u5199\u8D26\u6237\u53EF\u7528\u7684\u6A21\u578B\u3002V4 \u4E0D\u4F7F\u7528 SSML\u3001\u8BED\u901F\u6216\u98CE\u683C\u6ED1\u5757\u3002"
                    }),
                    field("Voice ID", "voiceId"),
                    selectDevice("\u8F93\u51FA\u8BBE\u5907", "outputDevice", "audiooutput"),
                    h("label", {
                      className: "elv-field",
                      children: [
                        h("span", { children: "\u9ED8\u8BA4\u64AD\u653E\u97F3\u91CF" }),
                        h("input", {
                          type: "range",
                          min: 0,
                          max: 1,
                          step: 0.05,
                          value: draft.volume,
                          onChange: (e) => set("volume", Number(e.target.value))
                        })
                      ]
                    }),
                    h("textarea", {
                      rows: 2,
                      value: testText,
                      onChange: (e) => setTestText(e.target.value)
                    }),
                    h("button", {
                      disabled: busy,
                      onClick: async () => {
                        if (await save()) void play(testText, "settings", "\u8BD5\u542C");
                      },
                      children: "\u4FDD\u5B58\u5E76\u8BD5\u542C\uFF08\u6D88\u8017\u989D\u5EA6\uFF09"
                    })
                  ]
                }),
                h("section", {
                  children: [
                    h("h3", { children: "\u8FDE\u63A5\u4E0E\u8BBE\u5907" }),
                    field("\u672C\u673A HTTP \u4EE3\u7406\uFF08\u53EF\u9009\uFF09", "proxy"),
                    h("small", {
                      children: "\u4F8B\u5982 http://127.0.0.1:7897\uFF1B\u7559\u7A7A\u76F4\u8FDE\u3002\u4EC5\u5141\u8BB8\u672C\u673A\u4EE3\u7406\u7AEF\u53E3\u3002"
                    }),
                    h("button", {
                      onClick: () => void devices(),
                      children: "\u5237\u65B0\u8BBE\u5907\u5217\u8868"
                    }),
                    h("button", {
                      disabled: busy,
                      onClick: async () => {
                        if (!await save()) return;
                        setBusy(true);
                        try {
                          const result = await request("/connection", {});
                          setMessage(
                            "\u8FDE\u63A5\u6210\u529F\uFF0C\u8BFB\u53D6\u5230 " + result.models.length + " \u4E2A\u6A21\u578B"
                          );
                        } catch (e) {
                          setMessage(e.message);
                        } finally {
                          setBusy(false);
                        }
                      },
                      children: "\u4FDD\u5B58\u5E76\u6D4B\u8BD5\u8FDE\u63A5"
                    }),
                    h("p", {
                      children: "\u82E5\u63D0\u793A\u7F3A\u5C11\u6A21\u578B\u8BFB\u53D6\u6743\u9650\uFF0C\u4E0D\u4EE3\u8868 key \u65E0\u6548\uFF1B\u8BF7\u68C0\u67E5 key \u6743\u9650\uFF0C\u6216\u901A\u8FC7\u624B\u52A8\u8BD5\u542C\u5355\u72EC\u9A8C\u8BC1 TTS\u3002\u8BBE\u5907\u540D\u79F0\u53EF\u80FD\u9700\u6388\u6743\u540E\u624D\u663E\u793A\u3002"
                    })
                  ]
                }),
                h("section", {
                  children: [
                    h("h3", { children: "Pet Voice \xB7 \u63A5\u53E3\u9884\u7559" }),
                    h("p", {
                      children: "\u672C\u9636\u6BB5\u672A\u542F\u7528\u5B9E\u65F6\u8BED\u97F3\u3001\u5524\u9192\u8BCD\u6216\u684C\u5BA0\u9EA6\u514B\u98CE\u3002\u73B0\u6709 Pet \u4EBA\u8BBE\u3001\u8BB0\u5FC6\u53CA\u5DE5\u5177\u8BBE\u7F6E\u4FDD\u6301\u6709\u6548\u3002"
                    })
                  ]
                }),
                h("div", {
                  className: "elv-save",
                  children: [
                    h("button", {
                      disabled: busy,
                      onClick: () => void save(),
                      children: busy ? "\u5904\u7406\u4E2D\u2026" : "\u4FDD\u5B58\u8BBE\u7F6E"
                    }),
                    h("span", { role: "status", children: message })
                  ]
                })
              ]
            });
          }
          const style = document.createElement("style");
          style.textContent = ".elv-button{border:1px solid #ccd6df88;border-radius:8px;padding:4px 9px;background:transparent;color:inherit;cursor:pointer;font-size:12px}.elv-reply{display:inline-flex;gap:5px}.elv-panel{position:fixed;bottom:74px;right:28px;z-index:10000;max-width:440px;max-height:70vh;overflow:auto;padding:16px;border:1px solid #95aabb77;border-radius:16px;background:var(--background,#f4f7fa);color:var(--foreground,#172a39);box-shadow:0 10px 40px #0002;font-size:13px}.elv-panel textarea{width:100%;min-height:80px}.elv-panel button{margin:5px;padding:4px 8px}.elv-panel input[type=range]{max-width:150px}.elv-error{color:#b33b3b}.elv-settings{padding:20px 24px;max-width:850px;margin:auto;line-height:1.65;color:inherit}.elv-hero{padding:24px;border-radius:20px;background:linear-gradient(120deg,#95b6c733,#bfabd522);margin-bottom:20px}.elv-hero h2{margin:0;font-size:24px}.elv-badge{display:inline-block;border-radius:20px;padding:3px 12px;background:#60a58b25;color:#32856b}.elv-settings section{border:1px solid #96a6b333;border-radius:16px;padding:20px;margin:14px 0}.elv-settings h3{margin:0 0 12px}.elv-field{display:grid;grid-template-columns:185px minmax(0,1fr);gap:14px;align-items:center;margin:12px 0}.elv-settings input:not([type=checkbox]),.elv-settings textarea,.elv-settings select{border:1px solid #9aa8b866;border-radius:8px;padding:8px 10px;background:transparent;color:inherit;min-width:0}.elv-settings textarea{width:100%;box-sizing:border-box}.elv-toggle{display:flex;align-items:center;gap:10px;margin:10px 0}.elv-settings button{padding:8px 14px;margin:8px 10px 8px 0;border:1px solid #9aa8b877;border-radius:9px;background:#8caebe22;color:inherit;cursor:pointer}.elv-settings small{display:block;opacity:.7}.elv-save{position:sticky;bottom:0;background:var(--background,#f4f7fa);padding:12px;border-radius:12px}.elv-settings input:disabled,.elv-settings button:disabled{opacity:.5}";
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
            listeners.clear();
          });
        }
      };
    }
  });
})();
