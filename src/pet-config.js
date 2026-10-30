export const petDefaults = Object.freeze({
  enabled: true,
  voiceId: "",
  ttsModel: "eleven_v4_turbo",
  volume: 0.8,
  autonomous: false,
  cooldownMinutes: 30,
  hourlyLimit: 3,
  // One realtime conversation's limit; the panel reconnects when it ends.
  sessionMinutes: 10,
  provider: "",
  model: "",
});
export function petConfig(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw Error("桌宠语音配置无效");
  const c = { ...petDefaults, ...input };
  if (Object.keys(input).some((k) => !(k in petDefaults)))
    throw Error("未知桌宠语音配置");
  for (const k of ["enabled", "autonomous"])
    if (typeof c[k] !== "boolean") throw Error("语音开关无效");
  if (typeof c.voiceId !== "string" || !/^[-\w]{0,100}$/.test(c.voiceId))
    throw Error("声音 ID 无效");
  if (typeof c.ttsModel !== "string" || !/^[-\w.]{1,100}$/.test(c.ttsModel))
    throw Error("模型 ID 无效");
  for (const key of ["provider", "model"])
    if (
      typeof c[key] !== "string" ||
      c[key].length > 150 ||
      /[\r\n\0]/.test(c[key])
    )
      throw Error("LLM 配置无效");
  if (Boolean(c.provider) !== Boolean(c.model))
    throw Error("LLM 提供商和模型必须同时填写或留空");
  if (!Number.isFinite(c.volume) || c.volume < 0 || c.volume > 1)
    throw Error("音量无效");
  if (
    !Number.isInteger(c.cooldownMinutes) ||
    c.cooldownMinutes < 1 ||
    c.cooldownMinutes > 1440
  )
    throw Error("冷却时间无效");
  if (
    !Number.isInteger(c.hourlyLimit) ||
    c.hourlyLimit < 1 ||
    c.hourlyLimit > 20
  )
    throw Error("频率无效");
  if (
    !Number.isInteger(c.sessionMinutes) ||
    c.sessionMinutes < 1 ||
    c.sessionMinutes > 60
  )
    throw Error("单次对话时长应为 1–60 分钟");
  return c;
}
// Legacy frequency fields remain readable for migration; they no longer drop output.
export function canSpeakAutomatically(c) {
  return c.enabled && c.autonomous;
}
