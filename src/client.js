import { insertion, chunks, assistantBody, spokenText } from "./shared.js";
window.__ModuleLoader__.load({
  id: "dsh-elevenlabs-voice",
  factory(require) {
    const R = require("react"),
      { jsx: h } = require("react/jsx-runtime");
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
            elapsed: 0,
          },
          token = "",
          disposed = false,
          currentSession = null,
          rec = null,
          recordGeneration = 0,
          playerGeneration = 0;
        const listeners = new Set(),
          requests = new Set(),
          cache = new Map();
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
            return options.audio ? res.blob() : res.json();
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
        function cleanupRecording(r) {
          clearInterval(r.timer);
          r.stream?.getTracks().forEach((t) => t.stop());
          void r.context?.close().catch(() => {});
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
        async function cachedAudio(text, sid, config, signal) {
          const key = JSON.stringify([
            sid,
            text,
            config.voiceId,
            config.ttsModel,
            "mp3_44100_128",
          ]);
          if (cache.has(key)) {
            const item = cache.get(key);
            cache.delete(key);
            cache.set(key, item);
            return item.url;
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
        async function play(text, sid, label = "回答") {
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
          };
          p.audio.volume = cfg.volume;
          update({ player: p, error: "" });
          p.audio.ontimeupdate = () => {
            p.progress = p.audio.duration
              ? p.audio.currentTime / p.audio.duration
              : 0;
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
          const run = async () => {
            if (generation !== playerGeneration || abort.signal.aborted) return;
            try {
              p.loading = true;
              update({ player: { ...p } });
              p.audio.src = await cachedAudio(
                parts[p.index],
                sid,
                cfg,
                abort.signal,
              );
              if (generation !== playerGeneration) return;
              if (cfg.outputDevice) {
                if (!p.audio.setSinkId)
                  throw Error("此浏览器不支持选择输出设备，请改用系统默认");
                await p.audio.setSinkId(cfg.outputDevice);
              }
              p.loading = false;
              update({ player: { ...p } });
              await p.audio.play();
            } catch (e) {
              if (e.name !== "AbortError" && generation === playerGeneration) {
                update({
                  error:
                    e.name === "NotAllowedError"
                      ? "浏览器阻止播放，请点击继续播放"
                      : e.message,
                  player: { ...p, loading: false, paused: true },
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
                error: "音频播放失败，请检查输出设备",
                player: { ...p, loading: false, paused: true },
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
          const node = selection.anchorNode?.parentElement,
            focus = selection.focusNode?.parentElement;
          if (!node || !focus) return "";
          const turn = button?.closest("[data-chat-turn]");
          if (!turn || !turn.contains(node) || !turn.contains(focus)) return "";
          if (
            node.closest(
              "[data-turn-process],[data-step-process-content],details",
            ) ||
            focus.closest(
              "[data-turn-process],[data-step-process-content],details",
            )
          )
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
            title: s.recording ? "结束录音并转写" : "ElevenLabs 语音输入",
            disabled:
              s.recording === "transcribing" || s.recording === "requesting",
            onClick: () =>
              s.recording ? stopRecording() : void startRecording(sessionId),
            children:
              s.recording === "recording"
                ? "⏹ " + s.elapsed + "s"
                : s.recording
                  ? "…"
                  : "🎙",
          });
        }
        function Reply({ sessionId, messageId }) {
          const s = useStore(),
            [selection, setSelection] = useState("");
          let body = "";
          try {
            body = assistantBody(
              ctx.uiConversation
                .binding(sessionId)
                .target("chat")
                .getSnapshot(),
              messageId,
            );
          } catch {}
          useEffect(() => {
            const fn = () =>
              setSelection(window.getSelection()?.toString().trim() || "");
            document.addEventListener("selectionchange", fn);
            return () => document.removeEventListener("selectionchange", fn);
          }, []);
          if (!allowed("tts") || !body) return null;
          return h("span", {
            className: "elv-reply",
            children: [
              h("button", {
                className: "elv-button",
                title: "仅朗读这条回答正文",
                onClick: () => void play(body, sessionId),
                children: "▶ 朗读",
              }),
              selection &&
                h("button", {
                  className: "elv-button",
                  onPointerDown: (e) => e.preventDefault(),
                  onClick: (e) => {
                    const text = selected(body, e.currentTarget);
                    if (text) void play(text, sessionId, "选中内容");
                    else
                      update({
                        error: "请只选中这条回答的正文；推理与工具输出不能朗读",
                      });
                  },
                  children: "朗读选中内容",
                }),
            ],
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
              s.recording &&
                h("div", {
                  children: [
                    s.status + " " + s.elapsed + "s ",
                    h("meter", { min: 0, max: 1, value: s.level }),
                    s.recording === "recording" &&
                      h("button", {
                        onClick: stopRecording,
                        children: "结束并转写",
                      }),
                    h("button", { onClick: cancelRecording, children: "取消" }),
                  ],
                }),
              !s.recording && s.status && h("div", { children: s.status }),
              s.pending &&
                h("div", {
                  children: [
                    h("textarea", {
                      value: s.pending.text,
                      onChange: (e) =>
                        update({
                          pending: { ...s.pending, text: e.target.value },
                        }),
                    }),
                    h("button", {
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
                    h("button", {
                      onClick: () => update({ pending: null }),
                      children: "丢弃",
                    }),
                  ],
                }),
              p &&
                h("div", {
                  children: [
                    h("span", {
                      children:
                        (p.loading
                          ? "生成中…"
                          : p.paused
                            ? "已暂停"
                            : "播放中") +
                        " " +
                        p.label +
                        " " +
                        (p.index + 1) +
                        "/" +
                        p.total,
                    }),
                    h("button", {
                      disabled: p.loading,
                      onClick: () => {
                        if (p.audio.paused)
                          void p.audio
                            .play()
                            .catch((e) => update({ error: e.message }));
                        else p.audio.pause();
                      },
                      children: p.paused ? "继续" : "暂停",
                    }),
                    h("button", { onClick: stopPlayback, children: "停止" }),
                    h("button", {
                      disabled: p.loading,
                      onClick: p.replay,
                      children: "重播",
                    }),
                    h("input", {
                      type: "range",
                      min: 0,
                      max: 1,
                      step: 0.01,
                      value: p.progress,
                      onChange: (e) => {
                        if (Number.isFinite(p.audio.duration))
                          p.audio.currentTime =
                            Number(e.target.value) * p.audio.duration;
                      },
                    }),
                    h("label", {
                      children: [
                        "音量 ",
                        h("input", {
                          type: "range",
                          min: 0,
                          max: 1,
                          step: 0.05,
                          defaultValue: s.config.volume,
                          onChange: (e) => {
                            p.audio.volume = Number(e.target.value);
                          },
                        }),
                      ],
                    }),
                  ],
                }),
              s.error &&
                h("div", {
                  className: "elv-error",
                  children: [
                    s.error,
                    h("button", {
                      onClick: () => update({ error: "" }),
                      children: "关闭",
                    }),
                  ],
                }),
              !s.recording &&
                !p &&
                !s.pending &&
                h("button", {
                  onClick: () => update({ status: "", error: "" }),
                  children: "收起",
                }),
            ],
          });
        }
        function Settings() {
          const s = useStore(),
            [draft, setDraft] = useState(s.config),
            [message, setMessage] = useState(""),
            [busy, setBusy] = useState(false),
            [testText, setTestText] = useState("你好，这是一条语音试听。");
          useEffect(() => setDraft(s.config), [s.config]);
          if (!draft) return h("div", { children: "正在读取语音设置…" });
          const set = (key, value) => setDraft({ ...draft, [key]: value });
          const field = (label, key, type = "text") =>
            h("label", {
              className: "elv-field",
              children: [
                h("span", { children: label }),
                h("input", {
                  type,
                  value: draft[key],
                  min: key === "maxSeconds" ? 5 : undefined,
                  max: key === "maxSeconds" ? 1800 : undefined,
                  onChange: (e) =>
                    set(
                      key,
                      type === "number"
                        ? Number(e.target.value)
                        : e.target.value,
                    ),
                }),
              ],
            });
          const toggle = (label, key) =>
            h("label", {
              className: "elv-toggle",
              children: [
                h("input", {
                  type: "checkbox",
                  checked: draft[key],
                  onChange: (e) => set(key, e.target.checked),
                }),
                label,
              ],
            });
          const selectDevice = (label, key, kind) =>
            h("label", {
              className: "elv-field",
              children: [
                h("span", { children: label }),
                h("select", {
                  value: draft[key],
                  onChange: (e) => set(key, e.target.value),
                  children: [
                    h("option", { value: "", children: "系统默认" }),
                    ...s.devices
                      .filter(
                        (x) => x.kind === kind && x.deviceId !== "default",
                      )
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
                }),
              ],
            });
          async function save() {
            setBusy(true);
            try {
              await request("/config", draft, { method: "PUT" });
              await refresh();
              setMessage("已保存，即时生效");
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
                    children: "按需录音与朗读 · Core + DSH Voice · 第一阶段",
                  }),
                  h("span", {
                    className: s.keyPresent ? "elv-badge" : "elv-error",
                    children: s.keyPresent
                      ? "环境变量已读取"
                      : "缺少 ELEVENLABS_API_KEY",
                  }),
                  h("p", {
                    children:
                      "密钥只从 DSH 进程环境读取，不在插件中保存或显示。更改 Windows 环境变量后请完全退出并重启 DSH。",
                  }),
                ],
              }),
              h("section", {
                children: [
                  toggle("启用统一语音插件", "enabled"),
                  toggle("启用 DSH Voice", "dshEnabled"),
                ],
              }),
              h("section", {
                children: [
                  h("h3", { children: "语音输入" }),
                  toggle("显示输入框麦克风按钮", "sttEnabled"),
                  field("STT 模型 ID", "sttModel"),
                  h("small", {
                    children:
                      "默认 scribe_v2；支持手动输入其他可用模型 ID。自动识别中文、英文和混合语言。",
                  }),
                  toggle("转写后自动发送（默认关闭）", "autoSend"),
                  field("最大录音时长 / 秒", "maxSeconds", "number"),
                  selectDevice("输入设备", "inputDevice", "audioinput"),
                  h("button", {
                    disabled: busy || Boolean(s.recording),
                    onClick: async () => {
                      if (await save())
                        void startRecording(currentSession, true);
                    },
                    children: "录音测试（不会发送）",
                  }),
                  h("label", {
                    className: "elv-field",
                    children: [
                      h("span", { children: "关键词（每行一个）" }),
                      h("textarea", {
                        rows: 5,
                        value: draft.keyterms.join("\n"),
                        onChange: (e) =>
                          set(
                            "keyterms",
                            e.target.value.split("\n").filter((x) => x.trim()),
                          ),
                      }),
                    ],
                  }),
                  h("small", {
                    children:
                      "最多 1000 项；每项少于 50 字符、至多 5 个词。关键词有额外费用；超过 100 项可能按至少 20 秒计费。转写保留音频事件标签，不经过模型润色。",
                  }),
                ],
              }),
              h("section", {
                children: [
                  h("h3", { children: "回答朗读" }),
                  toggle("显示回答正文播放按钮", "playbackEnabled"),
                  field("TTS 模型 ID", "ttsModel"),
                  h("small", {
                    children:
                      "默认 eleven_v4；可切换 eleven_v4_turbo 或填写账户可用的模型。V4 不使用 SSML、语速或风格滑块。",
                  }),
                  field("Voice ID", "voiceId"),
                  selectDevice("输出设备", "outputDevice", "audiooutput"),
                  h("label", {
                    className: "elv-field",
                    children: [
                      h("span", { children: "默认播放音量" }),
                      h("input", {
                        type: "range",
                        min: 0,
                        max: 1,
                        step: 0.05,
                        value: draft.volume,
                        onChange: (e) => set("volume", Number(e.target.value)),
                      }),
                    ],
                  }),
                  h("textarea", {
                    rows: 2,
                    value: testText,
                    onChange: (e) => setTestText(e.target.value),
                  }),
                  h("button", {
                    disabled: busy,
                    onClick: async () => {
                      if (await save()) void play(testText, "settings", "试听");
                    },
                    children: "保存并试听（消耗额度）",
                  }),
                ],
              }),
              h("section", {
                children: [
                  h("h3", { children: "连接与设备" }),
                  field("本机 HTTP 代理（可选）", "proxy"),
                  h("small", {
                    children:
                      "例如 http://127.0.0.1:7897；留空直连。仅允许本机代理端口。",
                  }),
                  h("button", {
                    onClick: () => void devices(),
                    children: "刷新设备列表",
                  }),
                  h("button", {
                    disabled: busy,
                    onClick: async () => {
                      if (!(await save())) return;
                      setBusy(true);
                      try {
                        const result = await request("/connection", {});
                        setMessage(
                          "连接成功，读取到 " +
                            result.models.length +
                            " 个模型",
                        );
                      } catch (e) {
                        setMessage(e.message);
                      } finally {
                        setBusy(false);
                      }
                    },
                    children: "保存并测试连接",
                  }),
                  h("p", {
                    children:
                      "若提示缺少模型读取权限，不代表 key 无效；请检查 key 权限，或通过手动试听单独验证 TTS。设备名称可能需授权后才显示。",
                  }),
                ],
              }),
              h("section", {
                children: [
                  h("h3", { children: "Pet Voice · 接口预留" }),
                  h("p", {
                    children:
                      "本阶段未启用实时语音、唤醒词或桌宠麦克风。现有 Pet 人设、记忆及工具设置保持有效。",
                  }),
                ],
              }),
              h("div", {
                className: "elv-save",
                children: [
                  h("button", {
                    disabled: busy,
                    onClick: () => void save(),
                    children: busy ? "处理中…" : "保存设置",
                  }),
                  h("span", { role: "status", children: message }),
                ],
              }),
            ],
          });
        }
        const style = document.createElement("style");
        style.textContent =
          ".elv-button{border:1px solid #ccd6df88;border-radius:8px;padding:4px 9px;background:transparent;color:inherit;cursor:pointer;font-size:12px}.elv-reply{display:inline-flex;gap:5px}.elv-panel{position:fixed;bottom:74px;right:28px;z-index:10000;max-width:440px;max-height:70vh;overflow:auto;padding:16px;border:1px solid #95aabb77;border-radius:16px;background:var(--background,#f4f7fa);color:var(--foreground,#172a39);box-shadow:0 10px 40px #0002;font-size:13px}.elv-panel textarea{width:100%;min-height:80px}.elv-panel button{margin:5px;padding:4px 8px}.elv-panel input[type=range]{max-width:150px}.elv-error{color:#b33b3b}.elv-settings{padding:20px 24px;max-width:850px;margin:auto;line-height:1.65;color:inherit}.elv-hero{padding:24px;border-radius:20px;background:linear-gradient(120deg,#95b6c733,#bfabd522);margin-bottom:20px}.elv-hero h2{margin:0;font-size:24px}.elv-badge{display:inline-block;border-radius:20px;padding:3px 12px;background:#60a58b25;color:#32856b}.elv-settings section{border:1px solid #96a6b333;border-radius:16px;padding:20px;margin:14px 0}.elv-settings h3{margin:0 0 12px}.elv-field{display:grid;grid-template-columns:185px minmax(0,1fr);gap:14px;align-items:center;margin:12px 0}.elv-settings input:not([type=checkbox]),.elv-settings textarea,.elv-settings select{border:1px solid #9aa8b866;border-radius:8px;padding:8px 10px;background:transparent;color:inherit;min-width:0}.elv-settings textarea{width:100%;box-sizing:border-box}.elv-toggle{display:flex;align-items:center;gap:10px;margin:10px 0}.elv-settings button{padding:8px 14px;margin:8px 10px 8px 0;border:1px solid #9aa8b877;border-radius:9px;background:#8caebe22;color:inherit;cursor:pointer}.elv-settings small{display:block;opacity:.7}.elv-save{position:sticky;bottom:0;background:var(--background,#f4f7fa);padding:12px;border-radius:12px}.elv-settings input:disabled,.elv-settings button:disabled{opacity:.5}";
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
          listeners.clear();
        });
      },
    };
  },
});
