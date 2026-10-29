export function parsePetTask(text) {
  const match = String(text).match(/<pet-task>([\s\S]*?)<\/pet-task>/);
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]);
    if (
      value.type === "timer" &&
      Number.isInteger(value.seconds) &&
      value.seconds >= 1 &&
      value.seconds <= 86400 &&
      typeof value.label === "string" &&
      value.label.length <= 100
    )
      return { type: "timer", seconds: value.seconds, label: value.label };
    if (value.type === "url") {
      const url = new URL(value.url);
      if (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        url.hostname.includes(".") &&
        !/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/.test(url.hostname)
      )
        return { type: "url", url: url.href };
    }
  } catch {}
  return null;
}
export const withoutPetTask = (text) =>
  String(text)
    .replace(/<pet-task>[\s\S]*?(?:<\/pet-task>|$)/g, "")
    .trim();
