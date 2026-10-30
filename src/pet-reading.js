// Only short-lived, bounded pending output survives a busy playback owner.
export const readingPolicy = Object.freeze({
  maxItems: 8,
  maxCharacters: 64000,
  ttlMs: 60000,
});
export class PetReadingQueue {
  constructor({ now = Date.now, ...policy } = {}) {
    this.now = now;
    this.policy = { ...readingPolicy, ...policy };
    this.items = new Map();
    this.seen = new Map();
    this.inflight = new Map();
  }
  observe(event, enabled, baseline = false) {
    const { petId, counter, data } = event;
    if (counter <= (this.seen.get(petId) || 0)) return;
    this.seen.set(petId, counter);
    if (
      baseline ||
      !enabled ||
      data?.voiceProduced ||
      typeof data?.text !== "string" ||
      !data.text.trim()
    )
      return;
    this.enqueue(petId, counter, data.text);
  }
  prune(id) {
    const active = this.inflight.get(id)?.id;
    const pending = (this.items.get(id) || []).filter(
      (item) => item.id === active || item.expiresAt > this.now(),
    );
    if (pending.length) this.items.set(id, pending);
    else this.items.delete(id);
  }
  sweep() {
    for (const id of this.items.keys()) this.prune(id);
  }
  enqueue(petId, id, text) {
    this.prune(petId);
    if (typeof text !== "string" || text.length > this.policy.maxCharacters)
      return;
    const pending = this.items.get(petId) || [];
    pending.push({
      type: "speak",
      id,
      text,
      expiresAt: this.now() + this.policy.ttlMs,
    });
    let chars = pending.reduce((n, item) => n + item.text.length, 0);
    while (
      pending.length > this.policy.maxItems ||
      chars > this.policy.maxCharacters
    ) {
      const index = pending.findIndex(
        (item) => item.id !== this.inflight.get(petId)?.id,
      );
      if (index < 0) break;
      chars -= pending[index].text.length;
      pending.splice(index, 1);
    }
    this.items.set(petId, pending);
  }
  next(id, owner) {
    if (this.inflight.get(id)?.owner === owner) return null;
    // A different owner must not replay an expired unfinished delivery.
    this.inflight.delete(id);
    this.prune(id);
    const item = this.items.get(id)?.[0];
    if (!item) return null;
    this.inflight.set(id, { owner, id: item.id });
    return { type: item.type, id: item.id, text: item.text };
  }
  finish(id, owner, counter, retry = false) {
    const active = this.inflight.get(id);
    if (active?.owner !== owner || active.id !== counter) return;
    this.inflight.delete(id);
    if (!retry)
      this.items.set(
        id,
        (this.items.get(id) || []).filter((item) => item.id !== counter),
      );
    this.prune(id);
  }
  clear(id) {
    this.items.delete(id);
    this.inflight.delete(id);
  }
}
