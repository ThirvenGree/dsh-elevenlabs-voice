import test from "node:test";
import assert from "node:assert/strict";
import { PetReadingQueue } from "../src/pet-reading.js";
const event = (counter, data = {}) => ({
  petId: "pet",
  counter,
  data: { text: "文字" + counter, ...data },
});
test("all outputs queue in order, without truncation or duplicate polling", () => {
  const q = new PetReadingQueue({ maxItems: 128 }),
    owner = {};
  q.observe(event(1), true, true);
  q.observe(event(2, { voiceProduced: true }), true);
  q.observe(event(3), false);
  for (let i = 4; i < 104; i++) {
    q.observe(event(i), true);
    q.observe(event(i), true);
  }
  for (let i = 4; i < 104; i++) {
    assert.equal(q.next("pet", owner).id, i);
    assert.equal(q.next("pet", owner), null);
    q.finish("pet", owner, i);
  }
  const text = "长正文".repeat(2000);
  q.observe(event(104, { text }), true);
  assert.equal(q.next("pet", owner).text, text);
});
test("interruption retains the item; owner handoff rejects stale acknowledgements", () => {
  const q = new PetReadingQueue(),
    old = {},
    next = {};
  q.observe(event(1), true);
  q.observe(event(2), true);
  q.next("pet", old);
  assert.equal(q.next("pet", next).id, 1);
  q.finish("pet", old, 1);
  assert.equal(q.next("pet", next), null);
  q.finish("pet", next, 1, true);
  assert.equal(q.next("pet", next).id, 1);
  q.finish("pet", next, 1);
  assert.equal(q.next("pet", next).id, 2);
  q.clear("pet");
  assert.equal(q.next("pet", next), null);
});

test("timer reminders use the same ordered queue and acknowledgement", () => {
  const q = new PetReadingQueue(),
    owner = {};
  q.observe(event(1), true);
  q.enqueue("pet", "timer:example", "计时结束");
  assert.equal(q.next("pet", owner).id, 1);
  q.finish("pet", owner, 1);
  assert.equal(q.next("pet", owner).id, "timer:example");
  q.finish("pet", owner, "timer:example");
  assert.equal(q.next("pet", owner), null);
});

test("pending work expires even without a playback endpoint or new output", () => {
  let now = 0;
  const q = new PetReadingQueue({ now: () => now });
  q.observe(event(1), true);
  now = 59999;
  assert.equal(q.items.get("pet").length, 1);
  now = 60000;
  q.sweep();
  assert.equal(q.items.size, 0);
  assert.equal(q.next("pet", {}), null);
  q.observe(event(1), true);
  assert.equal(q.items.size, 0); // expiry does not replay a polled leaf
});
test("floods retain the newest bounded backlog and never remove the playing item", () => {
  let now = 0;
  const q = new PetReadingQueue({ now: () => now }),
    owner = {};
  q.observe(event(1), true);
  q.next("pet", owner);
  for (let i = 2; i <= 1000; i++) q.observe(event(i), true);
  assert.equal(q.items.get("pet").length, 8);
  assert.deepEqual(
    q.items.get("pet").map((x) => x.id),
    [1, 994, 995, 996, 997, 998, 999, 1000],
  );
  now = 60000;
  q.sweep();
  assert.deepEqual(
    q.items.get("pet").map((x) => x.id),
    [1],
  );
  q.finish("pet", owner, 1, true);
  assert.equal(q.items.size, 0); // an expired interrupted item is not replayed
});
test("character budget and stale acknowledgements cannot evict a newer item", () => {
  let now = 0;
  const q = new PetReadingQueue({ now: () => now, maxCharacters: 10 }),
    owner = {},
    other = {};
  q.enqueue("pet", 1, "123456");
  q.next("pet", owner);
  q.enqueue("pet", 2, "abcdef");
  assert.equal(q.items.get("pet").length, 1);
  q.enqueue("pet", 3, "abc");
  now = 60001;
  assert.equal(q.next("pet", other), null); // owner handoff never revives stale speech
  q.enqueue("pet", 4, "fresh");
  q.next("pet", other);
  q.finish("pet", owner, 1);
  assert.equal(q.items.get("pet")[0].id, 4);
  q.enqueue("pet", 5, "x".repeat(11));
  assert.equal(q.items.get("pet").length, 1);
});
