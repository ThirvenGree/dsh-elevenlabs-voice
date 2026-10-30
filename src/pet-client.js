import { Conversation } from "@elevenlabs/client";
import { chunks } from "./shared.js";
const params = new URLSearchParams(location.search);
const background = params.get("background") === "1";
// The floating window passes the host page's theme; without it the panel
// follows the system setting.
if (["dark", "light"].includes(params.get("theme")))
  document.documentElement.dataset.theme = params.get("theme");
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
let unloading = false;
let reading = false,
  synthesizing = false,
  chatBusy = false,
  readingEnabled = false;
let selectedMode = "realtime";
function readingReady() {
  send({
    type: "reading-ready",
    realtime: wanted || !!conversation,
    active:
      !unloading &&
      !wanted &&
      !audio &&
      !synthesizing &&
      !chatBusy &&
      !dictating &&
      !reading,
  });
  renderStop();
}
const readinessTimer = setInterval(readingReady, 500);
const $ = (id) => document.getElementById(id),
  token = location.pathname.split("/")[2],
  base = location.pathname;
let conversation = null,
  wanted = false,
  generation = 0,
  audio = null,
  audioUrl = "",
  ws = null,
  heartbeat = null,
  retry = null,
  retries = 0,
  request = null,
  volume = 0.8,
  liveReply = null,
  lastLine = "",
  playback = 0,
  finishAudio = null,
  dictating = false,
  mode = "listening",
  level = 0,
  levelFrame = 0;
const status = (text, tone = "") => {
  $("status").textContent = text;
  $("status").dataset.tone = tone;
};
// What the talk button shows. Its colour says who is talking.
const CALL = {
  idle: ["开始实时对话", "点击后才会开启麦克风", "开始实时对话"],
  connecting: ["正在连接…", "第一次连接需要几秒", "取消连接"],
  reconnecting: ["正在重连…", "连接断开了，正在自动恢复", "停止重连"],
  listening: ["正在聆听", "直接说话；开口也能打断 Pet", "结束实时对话"],
  speaking: ["Pet 正在说话", "开口可以打断，点击按钮结束对话", "结束实时对话"],
  playing: ["正在朗读", "点击按钮停止朗读", "停止朗读"],
  paused: ["已暂停", "DSH 正在听写，结束后自动恢复", "结束实时对话"],
};
function phase() {
  if (dictating && (conversation || wanted)) return "paused";
  if (conversation) return mode === "speaking" ? "speaking" : "listening";
  if (wanted) return retries > 0 ? "reconnecting" : "connecting";
  if (audio) return "playing";
  return "idle";
}
function renderCall() {
  const p = phase(),
    [title, hint, action] = CALL[p];
  document.body.dataset.call = p;
  $("call-title").textContent = title;
  $("call-hint").textContent = hint;
  $("orb").setAttribute("aria-label", action);
  if (conversation && !levelFrame && !reducedMotion)
    levelFrame = requestAnimationFrame(tickLevel);
  renderStop();
}
// "停止说话" appears only while the panel is speaking or about to: a reply
// being generated, synthesized or played. Realtime talk keeps the orb.
function renderStop() {
  $("stop-all").hidden = !(audio || synthesizing || chatBusy || reading);
}
// The ring follows your voice while listening and the Pet's while speaking.
function tickLevel() {
  levelFrame = 0;
  let value = 0;
  if (conversation && !dictating)
    try {
      value =
        mode === "speaking"
          ? conversation.getOutputVolume()
          : conversation.getInputVolume();
    } catch {}
  level += (Math.min(1, value * 1.8) - level) * 0.25;
  $("orb").style.setProperty("--level", level.toFixed(3));
  if (conversation) levelFrame = requestAnimationFrame(tickLevel);
}
function playbackError(error) {
  status(error.message, "error");
  if (background)
    void api("notice", {
      text: "Pet 语音播放失败：" + String(error.message).slice(0, 400),
    }).catch(() => {});
}
const send = (value) => {
  if (ws?.readyState === 1) ws.send(JSON.stringify(value));
};
const speaking = (active) => {
  send({ type: "speaking", active });
  clearInterval(heartbeat);
  if (active)
    heartbeat = setInterval(
      () => send({ type: "speaking", active: true }),
      5000,
    );
  renderCall();
};
async function api(route, data, signal) {
  const response = await fetch(base + route, {
    method: data === undefined ? "GET" : "POST",
    headers: { "x-pet-token": token, "content-type": "application/json" },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    signal,
  });
  if (!response.ok) {
    const result = await response.json();
    throw Error(result.error || "请求失败");
  }
  return response;
}
function emptyLog() {
  const p = document.createElement("p");
  p.className = "pv-empty";
  p.textContent = "点击上面的圆形按钮开始说话，或在下面输入文字。";
  $("log").replaceChildren(p);
  syncClear();
}
// Returns the text node's element so streamed deltas can append to it.
function line(role, text) {
  $("log").querySelector(".pv-empty")?.remove();
  const el = document.createElement("div"),
    who = document.createElement("span"),
    body = document.createElement("span");
  el.className = "pv-msg " + (role === "user" ? "pv-msg--user" : "pv-msg--pet");
  who.className = "pv-sr";
  who.textContent = role === "user" ? "你：" : "Pet：";
  body.textContent = text;
  el.append(who, body);
  $("log").append(el);
  while ($("log").children.length > 80) $("log").firstChild.remove();
  $("log").scrollTop = $("log").scrollHeight;
  syncClear();
  return body;
}
// Messages that describe playback in progress; they go when playback stops.
const PLAYBACK_STATUS = new Set(["正在生成语音…", "正在朗读…"]);
function stopAudio() {
  if (PLAYBACK_STATUS.has($("status").textContent)) status("");
  playback++;
  finishAudio?.();
  finishAudio = null;
  if (audio) {
    audio.pause();
    audio.src = "";
    audio = null;
  }
  if (audioUrl) {
    URL.revokeObjectURL(audioUrl);
    audioUrl = "";
  }
  speaking(false);
}
// While DSH dictation records, the Pet neither listens nor plays sound, so
// it does not answer the dictation or leak its own voice into it.
function applyDictation() {
  if (conversation) {
    conversation.setMicMuted(dictating);
    conversation.setVolume({ volume: dictating ? 0 : volume });
  }
}
function setDictating(active) {
  if (active === dictating) return;
  dictating = active;
  if (active) {
    request?.abort();
    stopAudio();
  }
  applyDictation();
  renderCall();
}
async function say(text) {
  synthesizing = true;
  renderStop();
  try {
    stopAudio();
    status("正在生成语音…");
    request?.abort();
    request = new AbortController();
    const version = playback,
      signal = request.signal;
    for (const part of chunks(text, 2300)) {
      const response = await api("tts", { text: part }, signal),
        blob = await response.blob();
      if (version !== playback || signal.aborted) return false;
      if (audioUrl) URL.revokeObjectURL(audioUrl);
      audioUrl = URL.createObjectURL(blob);
      audio = new Audio(audioUrl);
      audio.volume = volume;
      await new Promise((resolve, reject) => {
        finishAudio = resolve;
        audio.onplaying = () => {
          status("正在朗读…");
          speaking(true);
        };
        audio.onended = resolve;
        audio.onerror = () => reject(Error("音频播放失败"));
        audio.play().catch(reject);
      });
      if (version !== playback) return false;
    }
    stopAudio();
    status("朗读完成");
    return true;
  } catch (error) {
    stopAudio();
    throw error;
  } finally {
    synthesizing = false;
    readingReady();
  }
}
async function stop(notify = true) {
  wanted = false;
  generation++;
  clearTimeout(retry);
  request?.abort();
  request = null;
  stopAudio();
  if (notify) send({ type: "stop" });
  const current = conversation;
  conversation = null;
  renderCall();
  if (current) await current.endSession().catch(() => {});
  if (notify) await api("stop", {}).catch(() => {});
}
async function start(reconnecting = false) {
  if (!reconnecting) {
    await stop();
    wanted = true;
    retries = 0;
    status("");
  }
  const version = ++generation;
  renderCall();
  try {
    const response = await api("session", {}),
      result = await response.json();
    if (!wanted || version !== generation) return;
    const next = await Conversation.startSession({
      signedUrl: result.signedUrl,
      connectionType: "websocket",
      onConnect: () => {
        if (version !== generation) return;
        retries = 0;
        status("");
        renderCall();
      },
      onDisconnect: () => {
        if (version !== generation) return;
        conversation = null;
        speaking(false);
        if (wanted && version === generation) {
          if (retries < 3) {
            retry = setTimeout(
              () => void start(true),
              [1500, 4000, 10000][retries++],
            );
          } else {
            wanted = false;
            status("连续三次重连失败，请点击圆形按钮重试", "error");
          }
        }
        renderCall();
      },
      onModeChange: ({ mode: next }) => {
        if (version !== generation) return;
        mode = next;
        speaking(next === "speaking");
      },
      onError: (message) => {
        if (version === generation) status("语音服务：" + message, "error");
      },
    });
    if (!wanted || version !== generation) {
      await next.endSession();
      return;
    }
    conversation = next;
    mode = "listening";
    conversation.setVolume({ volume });
    applyDictation();
    renderCall();
  } catch (error) {
    if (version !== generation) return;
    wanted = false;
    status("连接失败：" + error.message, "error");
    renderCall();
  }
}
async function refresh(includeHistory = true) {
  const result = await (await api("state")).json();
  volume = result.settings.volume;
  readingEnabled = result.settings.enabled && result.settings.autonomous;
  $("auto-read").checked = result.settings.autonomous;
  lastLine = result.lastLine;
  $("model").textContent =
    (result.settings.provider
      ? "当前：这只 Pet 指定 · "
      : "当前：跟随 DSH · ") +
    result.model.provider +
    " / " +
    result.model.model;
  for (const [name, value] of Object.entries(result.settings)) {
    const field = $("settings").elements.namedItem(name);
    if (!field) continue;
    if (field.type === "checkbox") field.checked = value;
    else field.value = value;
  }
  showVolume();
  if (includeHistory && result.history.length) {
    $("log").replaceChildren();
    for (const message of result.history) line(message.role, message.content);
  } else if (includeHistory) emptyLog();
  if (!result.keyPresent)
    status("缺少 ELEVENLABS_API_KEY，请设置后重启 DSH", "error");
}
function showVolume() {
  const percent = Math.round(Number($("volume").value) * 100) + "%";
  $("volume").style.setProperty("--fill", percent);
  $("volume-out").textContent = percent;
}
// A single owner per Pet prevents desktop and web from speaking the same line twice.
function connectUi() {
  ws = new WebSocket(
    location.origin.replace(/^http/, "ws") +
      base +
      "socket" +
      (background ? "?background=1" : ""),
  );
  ws.onmessage = (event) => {
    const m = JSON.parse(event.data);
    if (m.type === "owner" && background) void refresh().catch(playbackError);
    if (m.type === "disabled") {
      void stop();
      status("统一语音已关闭", "error");
    }
    if (m.type === "user") {
      liveReply = null;
      line("user", m.text);
    }
    if (m.type === "delta") {
      if (!liveReply) liveReply = line("assistant", "");
      liveReply.textContent += m.text;
      $("log").scrollTop = $("log").scrollHeight;
    }
    if (m.type === "done") {
      liveReply = null;
      lastLine = m.text;
    }
    if (m.type === "task") showTask(m);
    if (m.type === "error") status(m.error, "error");
    if (m.type === "dictation") setDictating(m.active === true);
    if (m.type === "reading-setting") {
      readingEnabled = m.enabled;
      $("auto-read").checked = m.enabled;
      if (!m.enabled && reading) {
        request?.abort();
        stopAudio();
      }
    }
    if (m.type === "speak") void readOutput(m);
  };
  ws.onclose = (event) => {
    void stop(false);
    if (background && !unloading) {
      retry = setTimeout(connectUi, 5000);
      return;
    }
    status(
      event.code === 4001
        ? "语音面板已在另一端打开"
        : "本机连接已断开，请重新打开面板",
      "error",
    );
  };
}
$("orb").onclick = () => {
  if (phase() === "idle") void start();
  else void stop();
};
async function readOutput(message) {
  if (
    !readingEnabled ||
    wanted ||
    audio ||
    synthesizing ||
    chatBusy ||
    dictating ||
    reading
  ) {
    send({ type: "read-result", id: message.id, retry: readingEnabled });
    return;
  }
  reading = true;
  renderStop();
  lastLine = message.text;
  try {
    const completed = await say(message.text);
    send({
      type: "read-result",
      id: message.id,
      retry: !completed && readingEnabled && (dictating || wanted),
    });
  } catch (error) {
    const interrupted = error.name === "AbortError";
    if (!interrupted) playbackError(error);
    send({
      type: "read-result",
      id: message.id,
      retry: interrupted && readingEnabled && (dictating || wanted),
    });
  } finally {
    reading = false;
    readingReady();
  }
}
async function chat() {
  const text = $("text").value.trim();
  if (!text || chatBusy || dictating) return;
  chatBusy = true;
  renderStop();
  let version = generation;
  try {
    if (conversation) {
      conversation.sendUserMessage(text);
      $("text").value = "";
      growComposer();
      return;
    }
    await stop();
    version = generation;
    request = new AbortController();
    stopAudio();
    status("Pet 正在回复…");
    $("chat").disabled = true;
    const response = await api("chat", { text }, request.signal);
    const result = await response.json();
    if (version !== generation) return;
    $("text").value = "";
    growComposer();
    await say(result.text);
  } catch (error) {
    status(
      error.name === "AbortError" ? "已取消" : error.message,
      error.name === "AbortError" ? "" : "error",
    );
  } finally {
    chatBusy = false;
    $("chat").disabled = false;
    renderStop();
  }
}
$("chat").onclick = () => void chat();
function growComposer() {
  const text = $("text");
  text.style.height = "auto";
  text.style.height = Math.min(text.scrollHeight + 2, 128) + "px";
}
$("text").addEventListener("input", growComposer);
$("text").addEventListener("keydown", (event) => {
  // Enter sends; Shift+Enter breaks the line; an IME composition keeps Enter.
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    void chat();
  }
});
$("volume").addEventListener("input", showVolume);
function selectTab(name) {
  $("automatic-panel").hidden = name !== "chat" || selectedMode !== "automatic";
  $("realtime-panel").hidden = name !== "chat" || selectedMode !== "realtime";
  for (const tab of ["chat", "settings"]) {
    const on = tab === name;
    $("tab-" + tab).setAttribute("aria-selected", String(on));
    $("tab-" + tab).tabIndex = on ? 0 : -1;
    $("panel-" + tab).hidden =
      !on || (tab === "chat" && selectedMode === "automatic");
  }
}
$("tab-chat").onclick = () => selectTab("chat");
$("tab-settings").onclick = () => selectTab("settings");
for (const id of ["tab-chat", "tab-settings"])
  $(id).addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const next = id === "tab-chat" ? "settings" : "chat";
    selectTab(next);
    $("tab-" + next).focus();
  });
$("settings").onsubmit = async (event) => {
  event.preventDefault();
  try {
    await stop();
    const data = {};
    for (const field of $("settings").elements) {
      if (!field.name) continue;
      data[field.name] =
        field.type === "checkbox"
          ? field.checked
          : ["number", "range"].includes(field.type)
            ? Number(field.value)
            : field.value;
    }
    await api("settings", data);
    await refresh();
    status("设置已保存", "ok");
  } catch (error) {
    status(error.message, "error");
  }
};
// Clearing asks twice inline instead of a native dialog, which some desktop
// pet windows cannot show. It removes this Pet's recent conversation so it
// does not come back on reopen; DSH long-term memory is kept.
let clearArmed = null;
function disarmClear() {
  clearTimeout(clearArmed);
  clearArmed = null;
  $("clear").textContent = "清空对话";
  delete $("clear").dataset.armed;
}
$("clear").onclick = async () => {
  if (!clearArmed) {
    $("clear").textContent = "确认清空";
    $("clear").dataset.armed = "";
    status("再点一次清空这只 Pet 的最近对话；DSH 长期记忆不受影响");
    clearArmed = setTimeout(() => {
      disarmClear();
      status("");
    }, 4000);
    return;
  }
  disarmClear();
  try {
    await stop();
    await api("clear", {});
    await refresh();
    $("tasks").replaceChildren();
    status("对话已清空，DSH 长期记忆保留", "ok");
  } catch (error) {
    status(error.message, "error");
  }
};
// Nothing to clear while the log is empty.
function syncClear() {
  $("clear").disabled = !$("log").querySelector(".pv-msg");
}
window.addEventListener("pagehide", () => {
  unloading = true;
  clearInterval(readinessTimer);
  clearTimeout(retry);
  wanted = false;
  generation++;
  request?.abort();
  stopAudio();
  conversation?.endSession();
  send({ type: "stop" });
  ws?.close();
});
function duration(seconds) {
  if (seconds < 60) return seconds + " 秒";
  if (seconds < 3600)
    return (
      Math.floor(seconds / 60) +
      " 分钟" +
      (seconds % 60 ? " " + (seconds % 60) + " 秒" : "")
    );
  const minutes = Math.floor((seconds % 3600) / 60);
  return (
    Math.floor(seconds / 3600) +
    " 小时" +
    (minutes ? " " + minutes + " 分钟" : "")
  );
}
function showTask(m) {
  const card = document.createElement("div"),
    text = document.createElement("p"),
    actions = document.createElement("div"),
    ignore = document.createElement("button"),
    confirm = document.createElement("button");
  card.className = "pv-task";
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", "Pet 的提议");
  text.textContent =
    m.task.type === "timer"
      ? "Pet 想设一个 " + duration(m.task.seconds) + " 的计时：" + m.task.label
      : "Pet 想打开网页：" + m.task.url;
  actions.className = "pv-task-actions";
  ignore.type = confirm.type = "button";
  ignore.className = "pv-btn";
  ignore.textContent = "忽略";
  ignore.onclick = () => card.remove();
  confirm.className = "pv-btn pv-primary";
  confirm.textContent = m.task.type === "timer" ? "开始计时" : "打开网页";
  confirm.onclick = async () => {
    try {
      if (m.task.type === "url") window.open(m.task.url, "_blank", "noopener");
      await api("task", { taskId: m.taskId });
      card.remove();
      status(m.task.type === "timer" ? "计时已开始" : "网页已打开", "ok");
    } catch (error) {
      status(error.message, "error");
    }
  };
  actions.append(ignore, confirm);
  card.append(text, actions);
  $("tasks").replaceChildren(card);
}
$("last").onclick = () => {
  if (!lastLine) {
    status("Pet 还没有说过台词");
    return;
  }
  void stop()
    .then(() => say(lastLine))
    .catch((error) => status(error.message, "error"));
};
emptyLog();
renderCall();
connectUi();
if (!background)
  void refresh().catch((error) => status(error.message, "error"));

for (const name of ["realtime", "text", "automatic"]) {
  $("mode-" + name).onclick = async () => {
    if (selectedMode !== name) await stop();
    selectedMode = name;
    selectTab("chat");
    for (const n of ["realtime", "text", "automatic"])
      $("mode-" + n).setAttribute("aria-pressed", String(n === name));
    $("realtime-panel").hidden = name !== "realtime";
    $("automatic-panel").hidden = name !== "automatic";
    $("panel-chat").hidden = name === "automatic";
    $("panel-settings").hidden = true;
    if (name === "text") $("text").focus();
  };
}
$("auto-read").onchange = async () => {
  const field = $("auto-read");
  field.disabled = true;
  try {
    await api("settings", { autonomous: field.checked });
    await refresh(false);
    status(
      field.checked
        ? "自动朗读已开启：Pet 的所有文字输出都会出声"
        : "自动朗读已关闭",
      "ok",
    );
  } catch (error) {
    field.checked = readingEnabled;
    playbackError(error);
  } finally {
    field.disabled = false;
  }
};

$("stop-all").onclick = () => void stop();
