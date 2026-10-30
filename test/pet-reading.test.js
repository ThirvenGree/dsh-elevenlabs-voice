import test from "node:test";
import assert from "node:assert/strict";
import { PetReadingQueue } from "../src/pet-reading.js";
const event = (counter, data = {}) => ({
  petId: "pet",
  counter,
  data: { text: "文字" + counter, ...data },
});
test("all outputs queue in order, without truncation or duplicate polling", () => {
  const q = new PetReadingQueue(),
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
