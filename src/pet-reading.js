// Pending output belongs to the host, not a disposable web/desktop panel.
export class PetReadingQueue {
  constructor() {
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
  enqueue(petId, id, text) {
    const pending = this.items.get(petId) || [];
    pending.push({ type: "speak", id, text });
    this.items.set(petId, pending);
  }
  next(id, owner) {
    if (this.inflight.get(id)?.owner === owner) return null;
    const item = this.items.get(id)?.[0];
    if (!item) return null;
    this.inflight.set(id, { owner, id: item.id });
    return item;
  }
  finish(id, owner, counter, retry = false) {
    const active = this.inflight.get(id);
    if (active?.owner !== owner || active.id !== counter) return;
    this.inflight.delete(id);
    if (!retry) this.items.get(id)?.shift();
  }
  clear(id) {
    this.items.delete(id);
    this.inflight.delete(id);
  }
}
