export const defaults = Object.freeze({
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
  pet: { enabled: false },
});
export function validateConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw Error("配置必须是对象");
  const c = { ...defaults, ...input };
  for (const k of Object.keys(input))
    if (!(k in defaults)) throw Error("不支持的配置项：" + k);
  for (const k of [
    "enabled",
    "dshEnabled",
    "sttEnabled",
    "autoSend",
    "playbackEnabled",
  ])
    if (typeof c[k] !== "boolean") throw Error(k + " 必须是开关");
  for (const k of ["sttModel", "ttsModel"])
    if (
      typeof c[k] !== "string" ||
      !c[k].trim() ||
      c[k].length > 100 ||
      !/^[-\w.]+$/.test(c[k])
    )
      throw Error("模型 ID 无效");
  for (const k of ["voiceId", "inputDevice", "outputDevice"])
    if (typeof c[k] !== "string" || c[k].length > 256) throw Error(k + " 无效");
  if (c.voiceId && !/^[-\w]+$/.test(c.voiceId)) throw Error("Voice ID 无效");
  if (
    !Number.isInteger(c.maxSeconds) ||
    c.maxSeconds < 5 ||
    c.maxSeconds > 1800
  )
    throw Error("录音时长应为 5–1800 秒");
  if (
    typeof c.volume !== "number" ||
    !Number.isFinite(c.volume) ||
    c.volume < 0 ||
    c.volume > 1
  )
    throw Error("音量应为 0–1");
  if (
    !Array.isArray(c.keyterms) ||
    c.keyterms.length > 1000 ||
    c.keyterms.some(
      (x) =>
        typeof x !== "string" ||
        !x.trim() ||
        [...x].length >= 50 ||
        x.trim().split(/\s+/u).length > 5 ||
        /[<>{}\[\]\\]/.test(x),
    )
  )
    throw Error(
      "关键词最多 1000 个，每项少于 50 字符、至多 5 个词，不含 <>{}[]\\",
    );
  c.keyterms = [...new Set(c.keyterms.map((x) => x.trim()).filter(Boolean))];
  if (c.proxy) {
    let u;
    try {
      u = new URL(c.proxy);
    } catch {
      throw Error("代理地址无效");
    }
    if (
      u.protocol !== "http:" ||
      !["127.0.0.1", "[::1]", "localhost"].includes(u.hostname) ||
      !u.port ||
      u.username ||
      u.password ||
      u.pathname !== "/" ||
      u.search ||
      u.hash
    )
      throw Error("代理只允许本机 HTTP 代理端口");
  }
  if (
    c.pet?.enabled !== false ||
    Object.keys(c.pet || {}).some((k) => k !== "enabled")
  )
    throw Error("Pet Voice 属于后续阶段，当前保持关闭");
  return c;
}
export function insertion(text, span, transcript) {
  const start = Math.min(text.length, Math.max(0, span.start)),
    end = Math.min(text.length, Math.max(start, span.end));
  const seam = (a, b) =>
    !a ||
    !b ||
    /\s/u.test(a) ||
    /\s/u.test(b) ||
    (/\p{Script=Han}/u.test(a) && /\p{Script=Han}/u.test(b))
      ? ""
      : " ";
  return (
    seam(text[start - 1], transcript[0]) +
    transcript +
    seam(transcript.at(-1), text[end])
  );
}
export function spokenText(text) {
  return String(text)
    .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<https?:\/\/([^>]+)>/g, "$1")
    .replace(/https?:\/\//g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/^\s{0,3}(?:#{1,6}|>|[-+*])\s+/gm, "")
    .replace(/^[| :\-]+$/gm, "")
    .replace(/\|/g, "，")
    .replace(/[*_~`]/g, "")
    .replace(/[\u200b-\u200f\ufeff]/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
export function chunks(text, limit = 2400) {
  const result = [];
  let rest = spokenText(text);
  while (rest.length > limit) {
    let end = -1;
    for (const mark of ["\n", "。", "！", "？", ". ", "! ", "? ", "，", " "])
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
export function transcriptResult(value) {
  const text = typeof value.text === "string" ? value.text.trim() : "";
  const hasSpeech =
    Array.isArray(value.words) && value.words.length
      ? value.words.some((w) => w.type === "word" && w.text?.trim())
      : Boolean(text.replace(/\[[^\]]*\]|\([^)]*\)/g, "").trim());
  return {
    text: hasSpeech ? text : "",
    language: value.language_code || "",
    hasSpeech,
  };
}
export function assistantBody(snapshot, messageId) {
  const nodes = snapshot?.nodes;
  const entries =
    typeof nodes?.values === "function"
      ? [...nodes.values()]
      : Array.isArray(nodes)
        ? nodes
        : Object.values(nodes || {});
  for (const n of entries) {
    for (const a of [
      n,
      n?.data,
      n?.data?.finalNode,
      n?.data?.closing?.finalNode,
    ])
      if (a?.kind === "assistant" && a.messageId === messageId)
        return (a.blocks || [])
          .filter((b) => b.kind === "text")
          .map((b) => b.text)
          .join("\n");
  }
  return "";
}
