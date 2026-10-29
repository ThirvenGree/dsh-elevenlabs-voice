import { spokenText } from "./shared.js";
export const shallowEqual = (a, b) =>
  a === b ||
  Boolean(
    a &&
    b &&
    typeof a === "object" &&
    typeof b === "object" &&
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every((k) => Object.is(a[k], b[k])),
  );
export function createStore(initial) {
  let state = initial;
  const listeners = new Set();
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
    clear: () => listeners.clear(),
  };
}
export const replyConfig = (s) => ({
  enabled: s.config?.enabled,
  dshEnabled: s.config?.dshEnabled,
  playbackEnabled: s.config?.playbackEnabled,
});
export function createBodyReader() {
  const cache = new WeakMap();
  return (snapshot, messageId) => {
    if (!snapshot || typeof snapshot !== "object") return "";
    let index = cache.get(snapshot);
    if (!index) {
      index = new Map();
      const nodes = snapshot.nodes;
      const values =
        typeof nodes?.values === "function"
          ? nodes.values()
          : Array.isArray(nodes)
            ? nodes
            : Object.values(nodes || {});
      for (const n of values)
        for (const a of [
          n,
          n?.data,
          n?.data?.finalNode,
          n?.data?.closing?.finalNode,
        ])
          if (a?.kind === "assistant" && a.messageId && !index.has(a.messageId))
            index.set(
              a.messageId,
              (a.blocks || [])
                .filter((b) => b.kind === "text")
                .map((b) => b.text)
                .join("\n"),
            );
      cache.set(snapshot, index);
    }
    return index.get(messageId) || "";
  };
}
export const parseKeyterms = (text) =>
  text
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);
// Ignore rendering-only separators (including table cell tabs/newlines). The
// selected bytes are accepted only if their lexical content occurs in the
// approved assistant text. Never read the rest of the page for TTS.
export const selectionKey = (text) =>
  spokenText(text)
    .normalize("NFKC")
    .replace(/[\s\p{P}\p{S}]+/gu, "");
export function selectedBody(body, element, selection) {
  if (!selection || selection.isCollapsed || !selection.rangeCount) return "";
  const text = selection.toString().trim(),
    key = selectionKey(text);
  const node = selection.anchorNode?.parentElement,
    focus = selection.focusNode?.parentElement,
    turn = element?.closest("[data-chat-turn]");
  if (!turn || !node || !focus || !turn.contains(node) || !turn.contains(focus))
    return "";
  if (!key || !selectionKey(body).includes(key)) return "";
  const internal =
    "[data-turn-process],[data-step-process-content],details,[data-tool-call]";
  if (node.closest(internal) || focus.closest(internal)) return "";
  const range = selection.getRangeAt?.(0);
  if (range?.cloneContents?.().querySelector?.(internal)) return "";
  return text;
}
export function createSelectionHub(document, getSelection) {
  const owners = new Set();
  let active = null;
  const refresh = () => {
    const selection = getSelection();
    let next = null,
      text = "";
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
      if (!owners.size) document.addEventListener("selectionchange", refresh);
      owners.add(owner);
      return () => {
        owners.delete(owner);
        if (active === owner) active = null;
        if (!owners.size)
          document.removeEventListener("selectionchange", refresh);
      };
    },
    clear() {
      document.removeEventListener("selectionchange", refresh);
      owners.clear();
      active = null;
    },
  };
}
