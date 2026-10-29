import { Conversation } from "@elevenlabs/client";
import { chunks } from "./shared.js";
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
  finishAudio = null;
const status = (text) => {
  $("status").textContent = text;
};
const send = (value) => {
  if (ws?.readyState === 1) ws.send(JSON.stringify(value));
};
const speaking = (active) => {
  $("speaking").textContent = active ? "· 正在说话" : "";
  send({ type: "speaking", active });
  clearInterval(heartbeat);
  if (active)
    heartbeat = setInterval(
      () => send({ type: "speaking", active: true }),
      5000,
    );
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
function line(role, text) {
  const el = document.createElement("div");
  el.className = role;
  el.textContent = (role === "user" ? "你：" : "Pet：") + text;
  $("log").append(el);
  while ($("log").children.length > 80) $("log").firstChild.remove();
  $("log").scrollTop = $("log").scrollHeight;
  return el;
}
function stopAudio() {
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
async function say(text) {
  stopAudio();
  status("正在生成语音…");
  request?.abort();
  request = new AbortController();
  const version = playback,
    signal = request.signal;
  for (const part of chunks(text, 2300)) {
    const response = await api("tts", { text: part }, signal),
      blob = await response.blob();
    if (version !== playback || signal.aborted) return;
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = URL.createObjectURL(blob);
    audio = new Audio(audioUrl);
    audio.volume = volume;
    await new Promise((resolve, reject) => {
      finishAudio = resolve;
      audio.onplaying = () => {
        speaking(true);
        status("正在朗读…");
      };
      audio.onended = resolve;
      audio.onerror = () => reject(Error("音频播放失败"));
      audio.play().catch(reject);
    });
    if (version !== playback) return;
  }
  stopAudio();
  status("朗读完成");
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
  if (current) await current.endSession().catch(() => {});
  if (notify) await api("stop", {}).catch(() => {});
  status("已停止");
}
async function start(reconnecting = false) {
  if (!reconnecting) {
    await stop();
    wanted = true;
    retries = 0;
  }
  const version = ++generation;
  status(reconnecting ? "正在重连…" : "正在建立语音连接…");
  $("start").disabled = true;
  try {
    const response = await api("session", {}),
      result = await response.json();
    if (!wanted || version !== generation) return;
    const next = await Conversation.startSession({
      signedUrl: result.signedUrl,
      connectionType: "websocket",
      onConnect: () => {
        retries = 0;
        status("实时对话已连接，可以说话；再次说话可打断。");
      },
      onDisconnect: () => {
        speaking(false);
        conversation = null;
        if (wanted && version === generation) {
          if (retries < 3) {
            retry = setTimeout(
              () => void start(true),
              [1500, 4000, 10000][retries++],
            );
            status("连接断开，准备重连…");
          } else {
            wanted = false;
            status("重连未成功，请点击开始重试");
          }
        }
      },
      onModeChange: ({ mode }) => speaking(mode === "speaking"),
      onError: (message) => status("语音服务：" + message),
    });
    if (!wanted || version !== generation) {
      await next.endSession();
      return;
    }
    conversation = next;
    conversation.setVolume({ volume });
  } catch (error) {
    wanted = false;
    status("连接失败：" + error.message);
  } finally {
    $("start").disabled = false;
  }
}
async function refresh() {
  const result = await (await api("state")).json();
  volume = result.settings.volume;
  lastLine = result.lastLine;
  $("model").textContent =
    "跟随 DSH：" + result.model.provider + " / " + result.model.model;
  for (const [name, value] of Object.entries(result.settings)) {
    const field = $("settings").elements.namedItem(name);
    if (!field) continue;
    if (field.type === "checkbox") field.checked = value;
    else field.value = value;
  }
  $("log").replaceChildren();
  for (const message of result.history) line(message.role, message.content);
  status(
    result.keyPresent
      ? "就绪 · 点击开始后才会启用麦克风"
      : "缺少 ELEVENLABS_API_KEY，请设置后重启 DSH",
  );
}
// A single owner per Pet prevents desktop and web from speaking the same line twice.
function connectUi() {
  ws = new WebSocket(location.origin.replace(/^http/, "ws") + base + "socket");
  ws.onmessage = (event) => {
    const m = JSON.parse(event.data);
    if (m.type === "disabled") {
      void stop();
      status("统一语音已关闭");
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
    if (m.type === "error") status(m.error);
    if (m.type === "speak" && !wanted && !audio)
      void say(m.text).catch((error) => status(error.message));
  };
  ws.onclose = (event) => {
    void stop(false);
    if (event.code === 4001) status("语音面板已在另一端打开");
    else status("本机连接已断开，请重新打开面板");
  };
}
$("start").onclick = () => void start();
$("stop").onclick = () => void stop();
$("speak").onclick = () => {
  void stop()
    .then(() => say($("text").value))
    .catch((error) => status(error.message));
};
$("chat").onclick = async () => {
  const text = $("text").value.trim();
  if (!text) return;
  try {
    if (conversation) {
      conversation.sendUserMessage(text);
      $("text").value = "";
      return;
    }
    request?.abort();
    request = new AbortController();
    stopAudio();
    status("正在回复…");
    $("chat").disabled = true;
    const response = await api("chat", { text }, request.signal);
    const result = await response.json();
    $("text").value = "";
    await say(result.text);
  } catch (error) {
    status(error.name === "AbortError" ? "已取消" : error.message);
  } finally {
    $("chat").disabled = false;
  }
};
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
    status("设置已保存");
  } catch (error) {
    status(error.message);
  }
};
$("clear").onclick = async () => {
  if (!confirm("清空本 Pet 最近记录？DSH 长期记忆会保留。")) return;
  try {
    await stop();
    await api("clear", {});
    await refresh();
  } catch (error) {
    status(error.message);
  }
};
window.addEventListener("pagehide", () => {
  wanted = false;
  generation++;
  request?.abort();
  stopAudio();
  conversation?.endSession();
  send({ type: "stop" });
  ws?.close();
});
connectUi();
void refresh().catch((error) => status(error.message));

function showTask(m) {
  const button = document.createElement("button");
  button.textContent =
    m.task.type === "timer"
      ? "确认计时 " + m.task.seconds + " 秒：" + m.task.label
      : "确认打开 " + m.task.url;
  button.onclick = async () => {
    try {
      if (m.task.type === "url") {
        window.open(m.task.url, "_blank", "noopener");
        await api("task", { taskId: m.taskId });
      } else await api("task", { taskId: m.taskId });
      button.remove();
      status("已执行确认的简单任务");
    } catch (error) {
      status(error.message);
    }
  };
  $("tasks").replaceChildren(button);
}
$("last").onclick = () => {
  void stop()
    .then(() => say(lastLine))
    .catch((error) => status(error.message));
};
