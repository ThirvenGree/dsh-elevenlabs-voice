import { fetch as nativeFetch, ProxyAgent, FormData } from "undici";
import { transcriptResult } from "./shared.js";
export class VoiceError extends Error {
  constructor(kind, message, status = 400) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}
export function providerError(status, detail) {
  const tag = String(detail?.detail?.status || detail?.status || "");
  if (/missing_permissions|permission/i.test(tag))
    return new VoiceError(
      "permission",
      "API key 缺少此操作权限，请检查 ElevenLabs key 的 STT/TTS/模型读取权限",
      403,
    );
  if (status === 401)
    return new VoiceError("invalid_key", "API key 无效或已失效", 401);
  if (status === 402 || /quota|credit|limit_exceeded/i.test(tag))
    return new VoiceError(
      "quota",
      "ElevenLabs 额度不足或账户限制，请检查余额和方案",
      402,
    );
  if (status === 429)
    return new VoiceError(
      "rate_limit",
      "请求频率或并发数超限，请稍后再试",
      429,
    );
  if (status === 403)
    return new VoiceError("permission", "账户没有此模型或声音的使用权限", 403);
  if (status === 404)
    return new VoiceError(
      "not_found",
      "模型、声音或接口不存在，请检查配置",
      404,
    );
  return new VoiceError(
    status >= 500 ? "provider" : "request",
    "ElevenLabs 请求失败（HTTP " + status + "）；请检查模型、声音及请求配置",
    status >= 500 ? 502 : 400,
  );
}
export class VoiceCore {
  constructor({
    config,
    key = () => process.env.ELEVENLABS_API_KEY,
    fetch = nativeFetch,
    timeout = 90000,
  } = {}) {
    this.config = config;
    this.key = key;
    this.fetch = fetch;
    this.timeout = timeout;
    this.pending = new Set();
    this.receipts = [];
    this.proxyAgent = null;
    this.proxyUrl = "";
    this.disposed = false;
  }
  assert(feature) {
    const c = this.config();
    if (
      this.disposed ||
      !c.enabled ||
      !c.dshEnabled ||
      (feature === "stt" && !c.sttEnabled) ||
      (feature === "tts" && !c.playbackEnabled)
    )
      throw new VoiceError("disabled", "语音功能已关闭", 409);
    if (!this.key())
      throw new VoiceError(
        "missing_key",
        "未找到 ELEVENLABS_API_KEY。设置 Windows 环境变量后，请完全退出并重启 DSH",
        400,
      );
    return c;
  }
  abort() {
    for (const c of this.pending) c.abort();
    this.pending.clear();
  }
  async close() {
    this.disposed = true;
    this.abort();
    await this.proxyAgent?.close();
  }
  async request(path, init, signal, feature) {
    const c = this.assert(feature),
      controller = new AbortController();
    this.pending.add(controller);
    const timer = setTimeout(
      () => controller.abort(new DOMException("Timeout", "TimeoutError")),
      this.timeout,
    );
    const onAbort = () => controller.abort(signal.reason);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (c.proxy !== this.proxyUrl) {
        const old = this.proxyAgent;
        this.proxyAgent = c.proxy ? new ProxyAgent(c.proxy) : null;
        this.proxyUrl = c.proxy;
        void old?.close();
      }
      const response = await this.fetch("https://api.elevenlabs.io/v1" + path, {
        ...init,
        headers: { ...init.headers, "xi-api-key": this.key() },
        signal: controller.signal,
        ...(this.proxyAgent ? { dispatcher: this.proxyAgent } : {}),
      });
      if (!response.ok) {
        let detail;
        try {
          detail = await response.json();
        } catch {}
        throw providerError(response.status, detail);
      }
      const receipt = {
        at: new Date().toISOString(),
        operation: feature || "connection",
        requestId:
          response.headers.get("request-id") ||
          response.headers.get("x-request-id") ||
          null,
        requestedModel:
          feature === "stt"
            ? c.sttModel
            : feature === "tts"
              ? c.ttsModel
              : null,
        serverModel: response.headers.get("x-model-id") || null,
      };
      // Consume the body while cancellation and timeout are still active.
      const data =
        feature === "tts"
          ? Buffer.from(await response.arrayBuffer())
          : await response.json();
      this.receipts.push(receipt);
      this.receipts = this.receipts.slice(-20);
      return { data, receipt };
    } catch (e) {
      if (e instanceof VoiceError) throw e;
      if (controller.signal.aborted) {
        const cancelled =
          signal?.aborted || controller.signal.reason?.name !== "TimeoutError";
        throw new VoiceError(
          cancelled ? "cancelled" : "timeout",
          cancelled ? "操作已取消" : "请求超时，请检查网络或稍后重试",
          408,
        );
      }
      throw new VoiceError(
        "network",
        "无法连接 ElevenLabs，请检查网络及代理",
        502,
      );
    } finally {
      clearTimeout(timer);
      this.pending.delete(controller);
      signal?.removeEventListener("abort", onAbort);
    }
  }
  async connection(signal) {
    const { data } = await this.request("/models", { method: "GET" }, signal);
    return {
      ok: true,
      models: Array.isArray(data)
        ? data.map((m) => ({
            id: m.model_id,
            name: m.name,
            tts: m.can_do_text_to_speech,
          }))
        : [],
    };
  }
  async transcribe(audio, mime, signal) {
    const c = this.assert("stt");
    if (!audio.length || audio.length > 32 * 1024 * 1024)
      throw new VoiceError("audio_size", "音频大小应为 1 字节–32 MiB");
    if (
      ![
        "audio/webm",
        "audio/ogg",
        "audio/wav",
        "audio/mp4",
        "audio/mpeg",
        "audio/x-wav",
      ].includes(mime.split(";")[0])
    )
      throw new VoiceError("audio_type", "不支持的录音格式");
    const form = new FormData();
    form.append(
      "file",
      new Blob([audio], { type: mime }),
      "recording." +
        {
          "audio/webm": "webm",
          "audio/ogg": "ogg",
          "audio/wav": "wav",
          "audio/x-wav": "wav",
          "audio/mp4": "m4a",
          "audio/mpeg": "mp3",
        }[mime.split(";")[0]],
    );
    form.append("model_id", c.sttModel);
    form.append("tag_audio_events", "true");
    for (const t of c.keyterms) form.append("keyterms", t);
    const { data, receipt } = await this.request(
      "/speech-to-text",
      { method: "POST", body: form },
      signal,
      "stt",
    );
    return { ...transcriptResult(data), receipt };
  }
  async synthesize(text, signal) {
    const c = this.assert("tts");
    if (!c.voiceId)
      throw new VoiceError(
        "voice_required",
        "请先在 ElevenLabs Voice 设置中填写 Voice ID",
      );
    if (typeof text !== "string" || !text.trim() || text.length > 2500)
      throw new VoiceError("text_size", "单段朗读文本应为 1–2500 字符");
    return this.request(
      "/text-to-speech/" +
        encodeURIComponent(c.voiceId) +
        "?output_format=mp3_44100_128",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text, model_id: c.ttsModel }),
      },
      signal,
      "tts",
    );
  }
}
