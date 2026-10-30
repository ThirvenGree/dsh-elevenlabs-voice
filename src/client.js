import { insertion, chunks } from "./shared.js";
import {
  createStore,
  replyConfig,
  createBodyReader,
  createSelectionHub,
  selectedBody,
  parseKeyterms,
} from "./ui-state.js";
window.__ModuleLoader__.load({
  id: "dsh-elevenlabs-voice",
  factory(require) {
    const R = require("react"),
      { jsx: h } = require("react/jsx-runtime");
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
            elapsed: 0,
          },
          token = "",
          disposed = false,
          currentSession = null,
          rec = null,
          recordGeneration = 0,
          playerGeneration = 0;
        const store = createStore(state),
          requests = new Set(),
          cache = new Map();
        const bodyReader = createBodyReader(),
          selectionHub = createSelectionHub(document, () =>
            window.getSelection(),
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
            [select],
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
              method: options.method || (body === undefined ? "GET" : "POST"),
              headers: {
                ...(body === undefined
                  ? {}
                  : {
                      "x-elevenlabs-csrf": token,
                      "content-type": options.raw
                        ? body.type
                        : "application/json",
                    }),
              },
              body:
                body === undefined
                  ? undefined
                  : options.raw
                    ? body
                    : JSON.stringify(body),
              signal: controller.signal,
            });
            if (!res.ok) {
              let e;
              try {
                e = await res.json();
              } catch {}
              throw Error(e?.error || "请求失败 HTTP " + res.status);
            }
            return options.audio
              ? {
                  blob: await res.blob(),
                  requestId: res.headers.get("x-elevenlabs-request-id") || null,
                }
              : await res.json();
          } finally {
            requests.delete(controller);
            options.signal?.removeEventListener("abort", abort);
          }
        }
        const allowed = (feature) =>
          state.config?.enabled &&
          state.config?.dshEnabled &&
          (feature === "stt"
            ? state.config.sttEnabled
            : state.config.playbackEnabled);
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
            status: "已取消录音",
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
            if (
              (!s.config.playbackEnabled && before.playbackEnabled) ||
              s.config.voiceId !== before.voiceId ||
              s.config.ttsModel !== before.ttsModel
            )
              stopPlayback();
          }
        }
        // Tell the host while dictation holds the microphone so a live Pet
        // conversation pauses listening and speaking. Fire-and-forget; the
        // host treats a start as a lease, and seq orders racing requests.
        const dictationClient =
          Math.random().toString(36).slice(2) + Date.now().toString(36);
        let dictationSeq = 0,
          dictationOn = false;
        function dictation(active) {
          if (dictationOn === active) return;
          dictationOn = active;
          void request("/dictation", {
            client: dictationClient,
            seq: ++dictationSeq,
            active,
          }).catch(() => {});
        }
        function cleanupRecording(r) {
          clearInterval(r.timer);
          r.stream?.getTracks().forEach((t) => t.stop());
          void r.context?.close().catch(() => {});
          if (!rec || rec === r) dictation(false);
        }
        function exists(sid) {
          try {
            const list = ctx.sessions.list.getSnapshot();
            return Boolean(
              list.byId?.[sid] ||
              (Array.isArray(list.sessions) &&
                list.sessions.some((x) => x.id === sid)),
            );
          } catch {
            return true;
          }
        }
        function insert(sid, text) {
          const shell = ctx.conversation.input.shell(sid);
          const span = shell.actions.captureInsertion();
          const draft =
            shell.projection?.detectText ??
            shell.snapshot?.draft ??
            shell.state.getSnapshot().draft;
          const result = shell.actions.insertText(
            insertion(draft, span, text),
            span,
          );
          if (result) shell.actions.persistDraft();
          return result;
        }
        async function finish(r) {
          cleanupRecording(r);
          if (r.cancelled || r.generation !== recordGeneration || disposed)
            return;
          update({ recording: "transcribing", level: 0, status: "正在转写…" });
          try {
            const blob = new Blob(r.parts, { type: r.recorder.mimeType });
            if (!blob.size) throw Error("没有录到音频");
            const result = await request("/transcribe", blob, {
              raw: true,
              signal: r.abort.signal,
            });
            if (r.cancelled || disposed || r.generation !== recordGeneration)
              return;
            if (!r.test && !exists(r.sid)) {
              update({ status: "原会话已删除，转写结果已丢弃", pending: null });
              return;
            }
            if (!result.hasSpeech) {
              update({ status: "未识别到有效语音，草稿保持不变" });
              return;
            }
            if (r.test) {
              update({
                pending: { text: result.text, sid: null },
                status: "录音测试完成（不会自动发送）",
              });
              return;
            }
            const same = currentSession === r.sid;
            let inserted = false;
            try {
              inserted = insert(r.sid, result.text);
            } catch {}
            if (inserted) {
              update({
                status: same
                  ? "转写已插入，可编辑并按 Ctrl+Z 撤销"
                  : "转写已写回原会话草稿",
              });
              if (same && state.config.autoSend && allowed("stt"))
                await ctx.conversation.input.shell(r.sid).actions.submit();
            } else
              update({
                pending: { text: result.text, sid: r.sid },
                status: "原草稿不可用；文本已保留，请复制或插入当前会话",
              });
          } catch (e) {
            if (!r.cancelled && e.name !== "AbortError")
              update({ error: e.message, status: "转写未完成" });
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
              status: "录音结束，正在上传…",
            });
            rec.recorder.stop();
          }
        }
        async function startRecording(sid, test = false) {
          if (!allowed("stt") || rec) return;
          if (!state.keyPresent) {
            update({
              error:
                "DSH 未读取到 ELEVENLABS_API_KEY；设置环境变量后请完全退出并重启 DSH",
            });
            return;
          }
          if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
            update({
              error:
                "当前浏览器不支持录音，请使用 DSH 桌面端或 Chromium 安全页面",
            });
            return;
          }
          const r = {
            sid,
            test,
            parts: [],
            cancelled: false,
            generation: ++recordGeneration,
            abort: new AbortController(),
          };
          rec = r;
          dictation(true);
          update({
            recording: "requesting",
            status: "等待麦克风权限…",
            error: "",
          });
          try {
            const stream = await navigator.mediaDevices.getUserMedia({
              audio: state.config.inputDevice
                ? { deviceId: { exact: state.config.inputDevice } }
                : true,
            });
            r.stream = stream;
            if (r.cancelled || r.generation !== recordGeneration || disposed) {
              cleanupRecording(r);
              return;
            }
            const mime = [
              "audio/webm;codecs=opus",
              "audio/ogg;codecs=opus",
              "audio/mp4",
            ].find((x) => MediaRecorder.isTypeSupported(x));
            r.recorder = new MediaRecorder(
              stream,
              mime ? { mimeType: mime } : {},
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
              update({ error: "录音设备发生错误" });
              cancelRecording();
            };
            r.recorder.start(1000);
            update({
              recording: "recording",
              status: "录音中；再次点击麦克风结束",
            });
            r.timer = setInterval(() => {
              if (r.cancelled) return;
              analyser.getByteTimeDomainData(samples);
              const level = Math.min(
                1,
                Math.sqrt(
                  samples.reduce((sum, x) => sum + ((x - 128) / 128) ** 2, 0) /
                    samples.length,
                ) * 4,
              );
              const elapsed = Math.floor((Date.now() - r.started) / 1000);
              update({ level, elapsed });
              if (elapsed >= state.config.maxSeconds) stopRecording();
            }, 100);
            void devices();
          } catch (e) {
            cleanupRecording(r);
            if (!r.cancelled)
              update({
                error:
                  e.name === "NotAllowedError"
                    ? "麦克风权限未授予，请在系统或浏览器设置中允许"
                    : e.message,
                recording: null,
                status: "",
              });
            if (rec === r) rec = null;
          }
        }
        async function devices() {
          try {
            const list = await navigator.mediaDevices?.enumerateDevices();
            if (!disposed) update({ devices: list || [] });
          } catch {}
        }
        async function cachedAudio(text, sid, config, signal, stitching = {}) {
          const key = JSON.stringify([
            sid,
            text,
            config.voiceId,
            config.ttsModel,
            "mp3_44100_128",
            stitching.previous_text || "",
            stitching.next_text || "",
          ]);
          if (cache.has(key)) {
            const item = cache.get(key);
            cache.delete(key);
            cache.set(key, item);
            return item;
          }
          const { blob, requestId } = await request(
            "/tts",
            { text, stitching },
            { audio: true, signal },
          );
          if (signal.aborted || disposed)
            throw new DOMException("Cancelled", "AbortError");
          const item = {
            url: URL.createObjectURL(blob),
            size: blob.size,
            requestId,
            at: Date.now(),
          };
          cache.set(key, item);
          cacheBytes += blob.size;
          while (cache.size > 64 || cacheBytes > 64 * 1024 * 1024) {
            const first = cache.keys().next().value,
              old = cache.get(first);
            cache.delete(first);
            cacheBytes -= old.size;
            URL.revokeObjectURL(old.url);
          }
          return item;
        }
        async function play(text, sid, label = "回答", source = null) {
          if (!allowed("tts")) return;
          stopPlayback();
          const parts = chunks(text);
          if (!parts.length) {
            update({ error: "这条回答没有可朗读的正文" });
            return;
          }
          const generation = playerGeneration,
            cfg = { ...state.config },
            abort = new AbortController();
          const p = {
            audio: new Audio(),
            abort,
            index: 0,
            total: parts.length,
            paused: false,
            loading: true,
            progress: 0,
            label,
            source,
            ended: false,
            segmentProgress: 0,
          };
          p.audio.volume = cfg.volume;
          update({ player: p, error: "" });
          p.audio.ontimeupdate = () => {
            p.segmentProgress = p.audio.duration
              ? p.audio.currentTime / p.audio.duration
              : 0;
            p.progress = (p.index + p.segmentProgress) / parts.length;
            if (state.player?.audio === p.audio)
              update({
                player: {
                  ...p,
                  progress: p.progress,
                },
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
          const tasks = new Map(),
            items = new Map();
          const prepare = (index) => {
            if (tasks.has(index)) return tasks.get(index);
            const task = (async () => {
              const stitching =
                cfg.ttsModel === "eleven_v3"
                  ? {}
                  : {
                      previous_text: parts[index - 1] || "",
                      next_text: parts[index + 1] || "",
                    };
              const previous = [...items.entries()]
                .filter(
                  ([i, item]) =>
                    i < index &&
                    item.requestId &&
                    Date.now() - item.at < 2 * 60 * 60 * 1000,
                )
                .sort((a, b) => a[0] - b[0])
                .slice(-3)
                .map(([, item]) => item.requestId);
              if (previous.length && cfg.ttsModel !== "eleven_v3")
                stitching.previous_request_ids = previous;
              const item = await cachedAudio(
                parts[index],
                sid,
                cfg,
                abort.signal,
                stitching,
              );
              items.set(index, item);
              return item;
            })();
            tasks.set(index, task);
            // A failed segment (usually a prefetch) must not be reused when its
            // turn comes; drop it so run() requests it again.
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
                  throw Error("此浏览器不支持选择输出设备，请改用系统默认");
                await p.audio.setSinkId(cfg.outputDevice);
              }
              p.loading = false;
              update({ player: { ...p } });
              await p.audio.play();
              if (generation !== playerGeneration || abort.signal.aborted)
                return;
              // At most one segment ahead, and only after explicit playback starts.
              if (p.index + 1 < parts.length)
                void prepare(p.index + 1).catch(() => {});
            } catch (e) {
              if (e.name === "AbortError" || generation !== playerGeneration)
                return;
              // A blocked autoplay keeps the player so one click resumes it;
              // any other failure leaves nothing to resume.
              if (e.name === "NotAllowedError")
                update({
                  error: "浏览器阻止了自动播放，请点击播放键继续",
                  player: { ...p, loading: false, paused: true },
                });
              else {
                stopPlayback();
                update({ error: e.message });
              }
            }
          };
          p.audio.onended = () => {
            if (generation !== playerGeneration) return;
            if (++p.index < parts.length) void run();
            else {
              p.index = parts.length - 1;
              p.paused = true;
              p.ended = true;
              p.progress = 1;
              update({ player: { ...p } });
            }
          };
          p.audio.onerror = () => {
            if (generation !== playerGeneration) return;
            stopPlayback();
            update({ error: "音频播放失败，请检查输出设备" });
          };
          p.replay = () => void play(text, sid, label, source);
          void run();
        }
        // Line icons drawn at 16px to sit beside DSH's own action icons.
        const STROKE = {
          fill: "none",
          stroke: "currentColor",
          strokeWidth: 1.5,
          strokeLinecap: "round",
          strokeLinejoin: "round",
        };
        const ICONS = {
          mic: [
            [
              "path",
              {
                ...STROKE,
                d: "M8 2.2a2.2 2.2 0 0 0-2.2 2.2v3.4a2.2 2.2 0 0 0 4.4 0V4.4A2.2 2.2 0 0 0 8 2.2ZM4.2 7.6a3.8 3.8 0 0 0 7.6 0M8 11.4v2.4",
              },
            ],
          ],
          speaker: [
            [
              "path",
              {
                ...STROKE,
                d: "M2.5 6.2h2.1L7.5 3.8v8.4L4.6 9.8H2.5zM10.2 6a2.8 2.8 0 0 1 0 4M12 4.2a5.3 5.3 0 0 1 0 7.6",
              },
            ],
          ],
          stop: [
            [
              "rect",
              {
                x: 4,
                y: 4,
                width: 8,
                height: 8,
                rx: 1.6,
                fill: "currentColor",
              },
            ],
          ],
          play: [
            [
              "path",
              {
                d: "M5.2 3.6v8.8a.6.6 0 0 0 .9.5l7-4.4a.6.6 0 0 0 0-1L6.1 3.1a.6.6 0 0 0-.9.5Z",
                fill: "currentColor",
              },
            ],
          ],
          pause: [
            [
              "rect",
              {
                x: 4.2,
                y: 3.5,
                width: 2.6,
                height: 9,
                rx: 0.9,
                fill: "currentColor",
              },
            ],
            [
              "rect",
              {
                x: 9.2,
                y: 3.5,
                width: 2.6,
                height: 9,
                rx: 0.9,
                fill: "currentColor",
              },
            ],
          ],
          replay: [
            ["path", { ...STROKE, d: "M3 8a5 5 0 1 0 1.5-3.6M3 2.5v2.4h2.4" }],
          ],
          close: [["path", { ...STROKE, d: "M4.5 4.5l7 7M11.5 4.5l-7 7" }]],
          alert: [
            ["circle", { ...STROKE, cx: 8, cy: 8, r: 5.8 }],
            ["path", { ...STROKE, d: "M8 5v3.4M8 10.8v.1" }],
          ],
          spinner: [
            [
              "circle",
              { ...STROKE, cx: 8, cy: 8, r: 5.5, strokeOpacity: 0.25 },
            ],
            ["path", { ...STROKE, d: "M13.5 8A5.5 5.5 0 0 0 8 2.5" }],
          ],
        };
        const icon = (name) =>
          h("svg", {
            className: "elv-icon" + (name === "spinner" ? " elv-spin" : ""),
            viewBox: "0 0 16 16",
            "aria-hidden": "true",
            focusable: "false",
            children: ICONS[name].map(([tag, props], i) => h(tag, props, i)),
          });
        const clock = (seconds) => {
          if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
          const whole = Math.floor(seconds);
          return (
            Math.floor(whole / 60) + ":" + String(whole % 60).padStart(2, "0")
          );
        };
        const percent = (value) =>
          Math.round((Number.isFinite(value) ? value : 0) * 100) + "%";
        const iconButton = (label, name, onClick, disabled = false) =>
          h("button", {
            type: "button",
            className: "elv-act",
            title: label,
            "aria-label": label,
            disabled,
            onClick,
            children: icon(name),
          });
        const MIC_LABELS = {
          idle: "语音输入",
          requesting: "等待麦克风权限",
          recording: "结束录音并转写",
          transcribing: "正在转写",
        };
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
          const phase = s.recording || "idle";
          return h("button", {
            type: "button",
            className: "elv-mic",
            "data-state": phase,
            title: MIC_LABELS[phase],
            "aria-label": MIC_LABELS[phase],
            disabled: phase === "transcribing" || phase === "requesting",
            onClick: () =>
              s.recording ? stopRecording() : void startRecording(sessionId),
            children:
              phase === "recording"
                ? [
                    h("span", {
                      className: "elv-rec-dot",
                      "aria-hidden": "true",
                    }),
                    clock(s.elapsed),
                  ]
                : icon(phase === "idle" ? "mic" : "spinner"),
          });
        }
        function Reply({ sessionId, messageId }) {
          const config = useStore(replyConfig),
            element = useRef(null),
            bodyRef = useRef("");
          const [selection, setSelection] = useState(""),
            [, renderBody] = useState(0);
          const chat = () =>
            ctx.uiConversation.binding(sessionId).target("chat");
          try {
            bodyRef.current = bodyReader(chat().getSnapshot(), messageId);
          } catch {
            bodyRef.current = "";
          }
          // Subscribe per session/message, not per render: target() may return
          // a fresh object on every call.
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
              } catch {}
              if (next !== bodyRef.current) {
                bodyRef.current = next;
                setSelection("");
                renderBody((v) => v + 1);
              }
            });
          }, [sessionId, messageId]);
          useEffect(
            () =>
              selectionHub.register({
                element: () => element.current,
                body: () => bodyRef.current,
                notify: setSelection,
              }),
            [sessionId, messageId],
          );
          if (
            !config.enabled ||
            !config.dshEnabled ||
            !config.playbackEnabled ||
            !bodyRef.current
          )
            return null;
          const key = sessionId + ":" + messageId,
            playing = config.playing === key;
          return h("span", {
            className: "elv-reply",
            ref: element,
            children: [
              h("button", {
                type: "button",
                className: "elv-act",
                "data-active": playing ? "" : undefined,
                title: playing ? "停止朗读" : "朗读这条回答",
                "aria-label": playing ? "停止朗读" : "朗读这条回答",
                onClick: () =>
                  playing
                    ? stopPlayback()
                    : void play(bodyRef.current, sessionId, "回答", key),
                children: icon(playing ? "stop" : "speaker"),
              }),
              selection &&
                h("button", {
                  type: "button",
                  className: "elv-act elv-act--text",
                  onPointerDown: (e) => e.preventDefault(),
                  onClick: () => {
                    const text = selectedBody(
                      bodyRef.current,
                      element.current,
                      window.getSelection(),
                    );
                    if (text) void play(text, sessionId, "选中内容", key);
                    else setSelection("");
                  },
                  children: [icon("speaker"), "朗读选中内容"],
                }),
            ],
          });
        }
        const PLAYER_TITLES = {
          回答: "朗读回答",
          选中内容: "朗读选中内容",
          试听: "声音试听",
        };
        const REC_COPY = {
          requesting: ["等待麦克风权限", "请在系统提示里允许使用麦克风"],
          recording: ["正在录音", null],
          transcribing: ["正在转写", "完成后放进输入框，发送前可以修改"],
        };
        function Panel() {
          const s = useStore();
          if (!s.config?.enabled || !s.config?.dshEnabled) return null;
          if (!s.recording && !s.pending && !s.player && !s.error && !s.status)
            return null;
          const p = s.player;
          const text = (title, meta) =>
            h("div", {
              className: "elv-text",
              children: [
                h("p", { className: "elv-title", children: title }),
                meta && h("p", { className: "elv-meta", children: meta }),
              ],
            });
          const recording =
            s.recording &&
            h("div", {
              className: "elv-block",
              children: [
                h("div", {
                  className: "elv-line",
                  children: [
                    s.recording === "recording"
                      ? h("span", {
                          className: "elv-rec-dot elv-rec-dot--lg",
                          "aria-hidden": "true",
                        })
                      : icon("spinner"),
                    text(
                      REC_COPY[s.recording][0],
                      REC_COPY[s.recording][1] ||
                        clock(s.elapsed) +
                          " / 最长 " +
                          clock(s.config.maxSeconds),
                    ),
                    h("button", {
                      type: "button",
                      className: "elv-btn",
                      onClick: cancelRecording,
                      children: "取消",
                    }),
                    s.recording === "recording" &&
                      h("button", {
                        type: "button",
                        className: "elv-btn elv-btn--primary",
                        onClick: stopRecording,
                        children: "结束并转写",
                      }),
                  ],
                }),
                s.recording === "recording" &&
                  h("div", {
                    className: "elv-level",
                    "aria-hidden": "true",
                    children: h("span", { style: { width: percent(s.level) } }),
                  }),
              ],
            });
          const pending =
            s.pending &&
            h("div", {
              className: "elv-block",
              children: [
                h("div", {
                  className: "elv-line",
                  children: [
                    text("转写结果", s.status),
                    iconButton("丢弃转写结果", "close", () =>
                      update({ pending: null, status: "" }),
                    ),
                  ],
                }),
                h("textarea", {
                  className: "elv-panel-text",
                  "aria-label": "转写结果",
                  value: s.pending.text,
                  onChange: (e) =>
                    update({
                      pending: { ...s.pending, text: e.target.value },
                    }),
                }),
                h("div", {
                  className: "elv-actions",
                  children: [
                    h("button", {
                      type: "button",
                      className: "elv-btn",
                      onClick: () =>
                        void navigator.clipboard
                          .writeText(s.pending.text)
                          .then(() => update({ status: "已复制" }))
                          .catch(() =>
                            update({ error: "复制失败，请手动选择文本复制" }),
                          ),
                      children: "复制",
                    }),
                    h("button", {
                      type: "button",
                      className: "elv-btn elv-btn--primary",
                      onClick: () => {
                        try {
                          if (
                            !currentSession ||
                            !insert(currentSession, s.pending.text)
                          )
                            throw Error("请先打开可编辑的会话");
                          update({
                            pending: null,
                            status: "已插入当前会话，请检查后发送",
                          });
                        } catch (e) {
                          update({ error: e.message });
                        }
                      },
                      children: "插入当前会话",
                    }),
                  ],
                }),
              ],
            });
          const note =
            !s.recording &&
            !s.pending &&
            s.status &&
            h("div", {
              className: "elv-block elv-note",
              role: "status",
              children: [
                h("p", { className: "elv-note-text", children: s.status }),
                iconButton("收起", "close", () => update({ status: "" })),
              ],
            });
          let player = null;
          if (p) {
            const duration = p.audio.duration,
              current = p.audio.currentTime,
              volume = p.audio.volume;
            const state = p.loading
              ? "正在生成语音…"
              : p.ended
                ? "播放完毕"
                : p.paused
                  ? "已暂停"
                  : "正在播放";
            player = h("div", {
              className: "elv-block",
              children: [
                p.total > 1 &&
                  h("progress", {
                    className: "elv-overall",
                    max: 1,
                    value: p.progress,
                    "aria-label": "整体播放进度",
                  }),
                h("div", {
                  className: "elv-line",
                  children: [
                    h("button", {
                      type: "button",
                      className: "elv-play",
                      disabled: p.loading,
                      "aria-label": p.paused ? "继续" : "暂停",
                      title: p.paused ? "继续" : "暂停",
                      onClick: () => {
                        if (p.ended) p.replay();
                        else if (p.audio.paused)
                          void p.audio
                            .play()
                            .catch((e) => update({ error: e.message }));
                        else p.audio.pause();
                      },
                      children: icon(
                        p.loading ? "spinner" : p.paused ? "play" : "pause",
                      ),
                    }),
                    text(
                      PLAYER_TITLES[p.label] || p.label,
                      state +
                        (p.total > 1
                          ? "，第 " + (p.index + 1) + "/" + p.total + " 段"
                          : ""),
                    ),
                    iconButton("重播", "replay", p.replay, p.loading),
                    iconButton("停止", "close", stopPlayback),
                  ],
                }),
                h("div", {
                  className: "elv-controls",
                  children: [
                    h("input", {
                      type: "range",
                      className: "elv-slider elv-seek",
                      "aria-label": p.total > 1 ? "当前段进度" : "播放进度",
                      min: 0,
                      max: 1,
                      step: 0.01,
                      value: p.segmentProgress,
                      style: { "--elv-fill": percent(p.segmentProgress) },
                      onChange: (e) => {
                        if (Number.isFinite(p.audio.duration))
                          p.audio.currentTime =
                            Number(e.target.value) * p.audio.duration;
                      },
                    }),
                    h("span", {
                      className: "elv-time",
                      children: clock(current) + " / " + clock(duration),
                    }),
                    h("span", {
                      className: "elv-vol",
                      children: [
                        icon("speaker"),
                        h("input", {
                          type: "range",
                          className: "elv-slider",
                          "aria-label": "音量",
                          min: 0,
                          max: 1,
                          step: 0.05,
                          value: volume,
                          style: { "--elv-fill": percent(volume) },
                          onChange: (e) => {
                            p.audio.volume = Number(e.target.value);
                            update({ player: { ...p } });
                          },
                        }),
                      ],
                    }),
                  ],
                }),
              ],
            });
          }
          const error =
            s.error &&
            h("div", {
              className: "elv-block elv-note",
              "data-tone": "error",
              role: "alert",
              children: [
                icon("alert"),
                h("p", { className: "elv-note-text", children: s.error }),
                iconButton("关闭提示", "close", () => update({ error: "" })),
              ],
            });
          return h("div", {
            className: "elv-panel",
            role: "region",
            "aria-label": "ElevenLabs 语音",
            children: [recording, pending, note, player, error],
          });
        }
        function Settings() {
          const s = useStore(),
            [draft, setDraft] = useState(s.config),
            [keytermsText, setKeytermsText] = useState(
              s.config?.keyterms.join("\n") || "",
            ),
            [message, setMessage] = useState(null),
            [probe, setProbe] = useState(null),
            [busy, setBusy] = useState(false),
            [testText, setTestText] = useState("你好，这是一条语音试听。");
          useEffect(() => {
            setDraft(s.config);
            setKeytermsText(s.config?.keyterms.join("\n") || "");
          }, [s.config]);
          if (!draft)
            return h("div", {
              className: "elv-settings",
              children: h("p", {
                className: "elv-loading",
                children: "正在读取语音设置…",
              }),
            });
          const terms = parseKeyterms(keytermsText);
          const dirty =
            JSON.stringify({ ...draft, keyterms: terms }) !==
            JSON.stringify(s.config);
          const set = (key, value) => {
            setDraft({ ...draft, [key]: value });
            setMessage(null);
          };
          const id = (key) => "elv-" + key;
          // One settings row: label and hint on the left, the control on the
          // right; a narrow card moves the control under the text.
          // layout: "stack" puts a wide control under the text; "inline"
          // keeps a small control (switch, chip) beside it at every width.
          const row = (key, label, hint, control, layout) =>
            h("div", {
              className: "elv-row" + (layout ? " elv-row--" + layout : ""),
              children: [
                h("label", {
                  className: "elv-label",
                  htmlFor: id(key),
                  children: label,
                }),
                hint &&
                  h("p", {
                    className: "elv-hint",
                    id: id(key) + "-hint",
                    children: hint,
                  }),
                h("div", { className: "elv-control", children: control }),
              ],
            });
          const toggle = (key, label) =>
            h("button", {
              type: "button",
              role: "switch",
              id: id(key),
              className: "elv-switch",
              "aria-checked": draft[key] ? "true" : "false",
              ...(label
                ? { "aria-label": label }
                : { "aria-describedby": id(key) + "-hint" }),
              onClick: () => set(key, !draft[key]),
              children: h("span", { className: "elv-switch-thumb" }),
            });
          const text = (key, props = {}) =>
            h("input", {
              id: id(key),
              className: "elv-input",
              value: draft[key],
              spellCheck: false,
              autoComplete: "off",
              "aria-describedby": id(key) + "-hint",
              onChange: (e) => set(key, e.target.value),
              ...props,
            });
          const device = (key, kind) =>
            h("select", {
              id: id(key),
              className: "elv-input",
              value: draft[key],
              "aria-describedby": id(key) + "-hint",
              onChange: (e) => set(key, e.target.value),
              children: [
                h("option", { value: "", children: "系统默认" }),
                ...s.devices
                  .filter((x) => x.kind === kind && x.deviceId !== "default")
                  .map((x, i) =>
                    h(
                      "option",
                      {
                        value: x.deviceId,
                        children: x.label || "设备 " + (i + 1),
                      },
                      x.deviceId,
                    ),
                  ),
              ],
            });
          const button = (label, onClick, primary = false, disabled = busy) =>
            h("button", {
              type: "button",
              className: "elv-btn" + (primary ? " elv-btn--primary" : ""),
              disabled,
              onClick,
              children: label,
            });
          const card = (key, title, description, rows, action, off = false) =>
            h("section", {
              className: "elv-card",
              "aria-labelledby": id(key) + "-title",
              "data-off": off ? "" : undefined,
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
                          children: title,
                        }),
                        h("p", {
                          className: "elv-card-desc",
                          children: description,
                        }),
                      ],
                    }),
                    action || null,
                  ],
                }),
                rows &&
                  h("div", { className: "elv-card-body", children: rows }),
              ],
            });
          async function save() {
            setBusy(true);
            try {
              await request(
                "/config",
                { ...draft, keyterms: parseKeyterms(keytermsText) },
                { method: "PUT" },
              );
              await refresh();
              setMessage({ tone: "ok", text: "已保存，立即生效" });
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
                "通用",
                "统一管理 DSH 和 Pet 的 ElevenLabs 语音。",
                [
                  row(
                    "enabled",
                    "启用语音插件",
                    "关闭后 DSH 和 Pet 的语音功能都会停止。",
                    toggle("enabled"),
                    "inline",
                  ),
                  row(
                    "dshEnabled",
                    "DSH 语音",
                    "控制输入框麦克风和回答朗读，不影响 Pet 语音。",
                    toggle("dshEnabled"),
                    "inline",
                  ),
                  row(
                    "key",
                    "ElevenLabs 密钥",
                    "只从 DSH 进程的 ELEVENLABS_API_KEY 环境变量读取，插件不保存也不显示。修改后需完全退出并重启 DSH。",
                    h("span", {
                      id: id("key"),
                      className: "elv-chip",
                      "data-tone": s.keyPresent ? "ok" : "error",
                      children: s.keyPresent ? "已读取" : "未找到",
                    }),
                    "inline",
                  ),
                  row(
                    "proxy",
                    "本机 HTTP 代理",
                    "例如 http://127.0.0.1:7897，留空则直连。只允许本机地址。",
                    text("proxy", { placeholder: "留空直连" }),
                  ),
                  row(
                    "connection",
                    "连接测试",
                    "读取账户可用的模型。提示缺少模型读取权限不代表密钥无效，可用试听单独验证朗读。",
                    h("div", {
                      className: "elv-action",
                      children: [
                        h("button", {
                          type: "button",
                          id: id("connection"),
                          className: "elv-btn",
                          disabled: busy,
                          onClick: async () => {
                            if (!(await save())) return;
                            setBusy(true);
                            setProbe(null);
                            try {
                              const result = await request("/connection", {});
                              setProbe({
                                tone: "ok",
                                text:
                                  "已连接，读取到 " +
                                  result.models.length +
                                  " 个模型",
                              });
                            } catch (e) {
                              setProbe({ tone: "error", text: e.message });
                            } finally {
                              setBusy(false);
                            }
                          },
                          children: "保存并测试连接",
                        }),
                        probe &&
                          h("p", {
                            className: "elv-result",
                            "data-tone": probe.tone,
                            role: "status",
                            children: probe.text,
                          }),
                      ],
                    }),
                  ),
                ],
              ),
              card(
                "devices",
                "音频设备",
                "设备名称在授予麦克风权限后显示。",
                [
                  row(
                    "inputDevice",
                    "输入设备",
                    "DSH 听写使用的麦克风。",
                    device("inputDevice", "audioinput"),
                  ),
                  row(
                    "outputDevice",
                    "输出设备",
                    "回答朗读使用的扬声器；浏览器不支持时使用系统默认。",
                    device("outputDevice", "audiooutput"),
                  ),
                ],
                h("button", {
                  type: "button",
                  className: "elv-text-btn",
                  onClick: () => void devices(),
                  children: "刷新设备列表",
                }),
              ),
              card(
                "stt",
                "语音输入",
                "点击输入框旁的麦克风录音，转写后放进输入框，发送前可以修改。",
                [
                  row(
                    "sttModel",
                    "转写模型",
                    "默认 scribe_v2，自动识别中文、英文和混合语言。",
                    text("sttModel", { list: "elv-stt-models" }),
                  ),
                  row(
                    "maxSeconds",
                    "最长录音",
                    "到时自动结束并开始转写。",
                    h("span", {
                      className: "elv-unit",
                      children: [
                        text("maxSeconds", {
                          type: "number",
                          min: 5,
                          max: 1800,
                          onChange: (e) =>
                            set("maxSeconds", Number(e.target.value)),
                        }),
                        h("span", { children: "秒" }),
                      ],
                    }),
                  ),
                  row(
                    "autoSend",
                    "转写后自动发送",
                    "默认关闭。切换会话后返回的转写不会自动发送。",
                    toggle("autoSend"),
                    "inline",
                  ),
                  row(
                    "keyterms",
                    "术语表",
                    "每行一个文件名、命令或专有名词，帮助识别更准确。会产生额外费用；超过 100 项时每次至少按 20 秒计费。",
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
                        },
                      }),
                      h("span", {
                        className: "elv-count",
                        "data-tone": terms.length > 1000 ? "error" : undefined,
                        children: terms.length + " / 1000",
                      }),
                    ],
                    "stack",
                  ),
                  row(
                    "recordTest",
                    "录音测试",
                    "录一段话，只显示转写结果，不会插入或发送。",
                    h("button", {
                      type: "button",
                      id: id("recordTest"),
                      className: "elv-btn",
                      disabled: busy || Boolean(s.recording),
                      onClick: async () => {
                        if (await save())
                          void startRecording(currentSession, true);
                      },
                      children: "保存并录音测试",
                    }),
                  ),
                  h("datalist", {
                    id: "elv-stt-models",
                    children: h("option", { value: "scribe_v2" }),
                  }),
                ],
                toggle("sttEnabled", "显示输入框麦克风按钮"),
                !draft.sttEnabled,
              ),
              card(
                "tts",
                "回答朗读",
                "在每条回答旁显示播放键，点击后才合成，不会自动朗读。",
                [
                  row(
                    "voiceId",
                    "Voice ID",
                    "在 ElevenLabs 声音库复制声音的 ID，必须是你的账户可用的声音。",
                    text("voiceId", { placeholder: "粘贴 Voice ID" }),
                  ),
                  row(
                    "ttsModel",
                    "朗读模型",
                    "默认 eleven_v4；eleven_v4_turbo 更快。",
                    text("ttsModel", { list: "elv-tts-models" }),
                  ),
                  row(
                    "volume",
                    "默认音量",
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
                          onChange: (e) =>
                            set("volume", Number(e.target.value)),
                        }),
                        h("output", {
                          htmlFor: id("volume"),
                          children: volume + "%",
                        }),
                      ],
                    }),
                  ),
                  row(
                    "preview",
                    "试听",
                    "用当前声音和模型合成下面这句话，会消耗额度。",
                    h("div", {
                      className: "elv-preview",
                      children: [
                        h("input", {
                          id: id("preview"),
                          className: "elv-input",
                          value: testText,
                          "aria-describedby": id("preview") + "-hint",
                          onChange: (e) => setTestText(e.target.value),
                        }),
                        button("保存并试听", async () => {
                          if (await save())
                            void play(testText, "settings", "试听");
                        }),
                      ],
                    }),
                    "stack",
                  ),
                  h("datalist", {
                    id: "elv-tts-models",
                    children: [
                      h("option", { value: "eleven_v4" }, "v4"),
                      h("option", { value: "eleven_v4_turbo" }, "v4t"),
                    ],
                  }),
                ],
                toggle("playbackEnabled", "显示回答播放键"),
                !draft.playbackEnabled,
              ),
              card(
                "pet",
                "Pet 语音",
                "在桌宠右键菜单选择「语音对话」打开语音面板。每只 Pet 的声音、对话模型、单次对话时长和自动出声都在面板里单独设置；麦克风只在点击开始后开启。",
              ),
              h("div", {
                className: "elv-savebar",
                "data-dirty": dirty ? "" : undefined,
                children: [
                  h("p", {
                    className: "elv-savebar-text",
                    role: "status",
                    "data-tone": message?.tone,
                    children: message
                      ? message.text
                      : dirty
                        ? "有未保存的更改"
                        : "设置已是最新",
                  }),
                  button(
                    "还原",
                    () => {
                      setDraft(s.config);
                      setKeytermsText(s.config.keyterms.join("\n"));
                      setMessage(null);
                    },
                    false,
                    busy || !dirty,
                  ),
                  button("保存设置", () => void save(), true),
                ],
              }),
            ],
          });
        }
        const style = document.createElement("style");
        // Every surface uses DSH's own semantic tokens, so each skin and the
        // dark theme apply without a second palette; settings also follow
        // DSH's settings-row vocabulary.
        style.textContent = `
:is(.elv-settings,.elv-panel,.elv-reply,.elv-mic){--elv-ink:var(--dsw-alias-label-primary,#1f2328);--elv-ink-2:var(--dsw-alias-label-secondary,#59636e);--elv-ink-3:var(--dsw-alias-label-tertiary,#8b949e);--elv-line:var(--dsw-alias-border-l2,rgb(31 35 40 / 12%));--elv-card:var(--dsw-alias-bg-layer-3,#fff);--elv-page:var(--dsw-alias-bg-layer-2,#f6f7f9);--elv-chip:var(--dsw-alias-bg-module-platform,rgb(31 35 40 / 6%));--elv-brand:var(--dsw-alias-brand-primary,#3f6ae0);--elv-fill-btn:var(--dsw-alias-button-primary-fill,var(--elv-ink));--elv-on-fill:var(--dsw-alias-label-primary-foreground,var(--elv-card));--elv-error:var(--dsw-alias-state-error-primary,#b42318);--elv-rail:var(--dsw-alias-label-dimmed,rgb(31 35 40 / 22%));--elv-hover:var(--dsw-alias-interactive-bg-hover,rgb(31 35 40 / 5%));--elv-rec:var(--dsw-alias-state-error-primary,#d1453b)}
.elv-settings{container:elv-settings/inline-size;display:flex;flex-direction:column;gap:16px;max-width:720px;color:var(--elv-ink);font-size:14px;line-height:22px}
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
.elv-range input{flex:1;min-width:0}
.elv-slider,.elv-range input{height:20px;margin:0;background:transparent;appearance:none;cursor:pointer}
.elv-slider::-webkit-slider-runnable-track,.elv-range input::-webkit-slider-runnable-track{height:4px;border-radius:999px;background:linear-gradient(to right,var(--elv-brand) var(--elv-fill,0%),color-mix(in srgb,var(--elv-ink) 12%,transparent) var(--elv-fill,0%))}
.elv-slider::-webkit-slider-thumb,.elv-range input::-webkit-slider-thumb{width:14px;height:14px;margin-top:-5px;border:0;border-radius:50%;background:#fff;box-shadow:0 0 0 1px rgb(0 0 0 / 12%),0 1px 3px rgb(0 0 0 / 25%);appearance:none}
.elv-slider::-moz-range-track,.elv-range input::-moz-range-track{height:4px;border-radius:999px;background:color-mix(in srgb,var(--elv-ink) 12%,transparent)}
.elv-slider::-moz-range-progress,.elv-range input::-moz-range-progress{height:4px;border-radius:999px;background:var(--elv-brand)}
.elv-slider::-moz-range-thumb,.elv-range input::-moz-range-thumb{width:14px;height:14px;border:0;border-radius:50%;background:#fff;box-shadow:0 0 0 1px rgb(0 0 0 / 12%),0 1px 3px rgb(0 0 0 / 25%)}
.elv-settings :is(.elv-btn,.elv-text-btn,.elv-switch,.elv-range input):focus-visible{outline:2px solid var(--elv-brand);outline-offset:2px}
.elv-savebar{position:sticky;bottom:12px;z-index:1;display:flex;align-items:center;gap:8px;padding:10px 12px 10px 16px;border:1px solid var(--elv-line);border-radius:12px;background:var(--elv-card);box-shadow:0 4px 16px rgb(20 20 19 / 8%)}
.elv-savebar-text{flex:1;min-width:0;color:var(--elv-ink-2);font-size:13px;line-height:20px;overflow-wrap:anywhere}
.elv-savebar[data-dirty] .elv-savebar-text{color:var(--elv-ink)}
.elv-savebar[data-dirty] .elv-savebar-text:not([data-tone])::before{content:"";display:inline-block;width:7px;height:7px;margin-right:8px;border-radius:50%;background:var(--elv-brand);vertical-align:1px}
.elv-savebar-text[data-tone=error]{color:var(--elv-error)}
@container elv-settings (max-width:520px){.elv-row:not(.elv-row--inline){grid-template-columns:minmax(0,1fr);grid-template-areas:"label" "hint" "control";row-gap:4px}.elv-row:not(.elv-row--inline)>.elv-control{margin-top:8px;justify-self:stretch}.elv-input,.elv-range{width:100%}.elv-action{align-items:stretch}.elv-result{max-width:none;text-align:left}.elv-card-head{align-items:flex-start}}
.elv-icon{display:block;flex:none;width:16px;height:16px}
.elv-spin{animation:elv-spin .9s linear infinite}
@keyframes elv-spin{to{rotate:1turn}}
.elv-rec-dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--elv-rec);animation:elv-pulse 1.2s ease-in-out infinite}
.elv-rec-dot--lg{width:10px;height:10px;margin:0 3px}
@keyframes elv-pulse{50%{opacity:.35}}
.elv-mic{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:32px;min-width:32px;padding:0 8px;border:0;border-radius:8px;background:transparent;color:var(--elv-ink-2);font:inherit;font-size:12px;font-variant-numeric:tabular-nums;cursor:pointer;transition:background-color .12s ease,color .12s ease}
.elv-mic:hover:not(:disabled){background:var(--elv-hover);color:var(--elv-ink)}
.elv-mic:disabled{cursor:default}
.elv-mic[data-state=recording],.elv-mic[data-state=recording]:hover:not(:disabled){padding:0 10px;background:color-mix(in srgb,var(--elv-rec) 12%,transparent);color:var(--elv-rec)}
.elv-reply{display:inline-flex;align-items:center;gap:2px;vertical-align:middle}
.elv-act{display:inline-flex;align-items:center;justify-content:center;gap:5px;flex:none;height:28px;min-width:28px;padding:0 6px;border:0;border-radius:6px;background:transparent;color:var(--elv-ink-2);font:inherit;font-size:12px;white-space:nowrap;cursor:pointer;transition:background-color .12s ease,color .12s ease}
.elv-act:hover:not(:disabled){background:var(--elv-hover);color:var(--elv-ink)}
.elv-act:disabled{cursor:default;opacity:.4}
.elv-act[data-active],.elv-act[data-active]:hover:not(:disabled){color:var(--elv-brand)}
.elv-act--text{padding:0 8px}
:is(.elv-mic,.elv-act,.elv-play,.elv-panel .elv-btn,.elv-slider,.elv-panel-text):focus-visible{outline:2px solid var(--elv-brand);outline-offset:1px}
.elv-panel{position:fixed;right:24px;bottom:148px;z-index:10000;display:flex;flex-direction:column;gap:12px;box-sizing:border-box;width:min(360px,calc(100vw - 32px));max-height:min(60vh,520px);overflow:auto;padding:14px;border:1px solid var(--elv-line);border-radius:14px;background:var(--elv-card);color:var(--elv-ink);box-shadow:0 12px 32px rgb(20 20 19 / 14%),0 2px 6px rgb(20 20 19 / 6%);font-size:13px;line-height:20px}
.elv-panel *,.elv-panel *::before,.elv-panel *::after{box-sizing:border-box}
.elv-panel p{margin:0}
.elv-block{display:flex;flex-direction:column;gap:10px;min-width:0}
.elv-block+.elv-block{padding-top:12px;border-top:1px solid var(--elv-line)}
.elv-line{display:flex;align-items:center;gap:10px;min-width:0}
.elv-text{flex:1;min-width:0}
.elv-title{font-size:13px;font-weight:600;line-height:20px}
.elv-meta{color:var(--elv-ink-2);font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}
.elv-play{display:grid;place-items:center;flex:none;width:36px;height:36px;padding:0;border:0;border-radius:50%;background:var(--elv-fill-btn);color:var(--elv-on-fill);cursor:pointer}
.elv-play:hover:not(:disabled){filter:brightness(1.08)}
.elv-play:disabled{cursor:default;opacity:.65}
.elv-overall{position:absolute;top:0;left:0;width:100%;height:2px;border:0;background:transparent;appearance:none}
.elv-overall::-webkit-progress-bar{background:transparent}
.elv-overall::-webkit-progress-value{background:var(--elv-brand)}
.elv-overall::-moz-progress-bar{background:var(--elv-brand)}
.elv-controls{display:flex;align-items:center;gap:10px;min-width:0}
.elv-seek{flex:1;min-width:0}
.elv-time{flex:none;color:var(--elv-ink-2);font-size:11.5px;font-variant-numeric:tabular-nums;white-space:nowrap}
.elv-vol{display:flex;flex:none;align-items:center;gap:6px;color:var(--elv-ink-2)}
.elv-vol .elv-slider{width:64px}
.elv-level{height:4px;overflow:hidden;border-radius:999px;background:color-mix(in srgb,var(--elv-ink) 10%,transparent)}
.elv-level span{display:block;height:100%;border-radius:inherit;background:var(--elv-rec);transition:width .1s linear}
.elv-panel-text{display:block;width:100%;min-height:84px;padding:8px 10px;border:1px solid var(--elv-line);border-radius:8px;background:var(--elv-card);color:var(--elv-ink);font:inherit;font-size:13px;line-height:20px;resize:vertical}
.elv-actions{display:flex;justify-content:flex-end;gap:8px}
.elv-note{flex-direction:row;align-items:flex-start;gap:8px}
.elv-note .elv-icon{margin-top:2px}
.elv-note-text{flex:1;min-width:0;padding-top:4px;font-size:12.5px;line-height:19px;overflow-wrap:anywhere}
.elv-note[data-tone=error]{color:var(--elv-error)}
.elv-note[data-tone=error] .elv-act{color:var(--elv-ink-2)}
@media (prefers-reduced-motion:reduce){.elv-switch,.elv-switch-thumb,.elv-btn,.elv-mic,.elv-act,.elv-level span{transition:none}.elv-spin,.elv-rec-dot{animation:none}}
`;
        document.head.append(style);
        const register = (slot, id, component, inject) =>
          ctx.effect(() =>
            ctx.slots.inject(slot, function* () {
              yield ctx.slots.register(
                {
                  name: slot,
                  id,
                  order: 50,
                  ...(slot === "settings.section"
                    ? { label: () => "ElevenLabs Voice" }
                    : {}),
                  ...(inject ? { inject } : {}),
                },
                component,
              );
            }),
          );
        register("settings.section", "elevenlabs-voice", Settings);
        register(
          "conversation.input.right",
          "elevenlabs-voice-mic",
          Mic,
          (sessionId) => ({ sessionId }),
        );
        register(
          "conversation.chat.assistant-actions",
          "elevenlabs-voice-play",
          Reply,
          (sessionId) => ({ sessionId }),
        );
        register("shell.overlay", "elevenlabs-voice-panel", Panel);
        void refresh().catch((e) => update({ error: e.message }));
        void devices();
        const timer = setInterval(() => void refresh().catch(() => {}), 10000);
        ctx.effect(() => () => {
          disposed = true;
          clearInterval(timer);
          disable();
          style.remove();
          store.clear();
          selectionHub.clear();
        });
      },
    };
  },
});
