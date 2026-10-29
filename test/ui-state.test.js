import test from "node:test";
import assert from "node:assert/strict";
import {
  createStore,
  replyConfig,
  createBodyReader,
  createSelectionHub,
  parseKeyterms,
  selectedBody,
} from "../src/ui-state.js";
test("1000 reply subscribers do not rerender for 100 recording/player ticks", () => {
  const store = createStore({
    config: { enabled: true, dshEnabled: true, playbackEnabled: true },
    level: 0,
  });
  let renders = 0;
  for (let n = 0; n < 1000; n++) store.subscribe(replyConfig, () => renders++);
  for (let n = 0; n < 100; n++)
    store.set({ level: n, player: { progress: n / 100 } });
  assert.equal(renders, 0);
  store.set({
    config: { enabled: true, dshEnabled: true, playbackEnabled: false },
  });
  assert.equal(renders, 1000);
});
test("shared immutable-snapshot body index scans once for all replies", () => {
  let scans = 0;
  const nodes = Array.from({ length: 1000 }, (_, i) => ({
    data: {
      finalNode: {
        kind: "assistant",
        messageId: String(i),
        blocks: [
          { kind: "reasoning", text: "hidden" },
          { kind: "text", text: "回答" + i },
        ],
      },
    },
  }));
  const snapshot = {
      nodes: {
        values: () => {
          scans++;
          return nodes;
        },
      },
    },
    read = createBodyReader();
  for (let i = 0; i < 1000; i++)
    assert.equal(read(snapshot, String(i)), "回答" + i);
  assert.equal(scans, 1);
  nodes[0] = {
    data: {
      finalNode: {
        kind: "assistant",
        messageId: "0",
        blocks: [{ kind: "text", text: "changed" }],
      },
    },
  };
  assert.equal(read({ nodes: snapshot.nodes }, "0"), "changed");
  assert.equal(scans, 2);
});
test("keyterms preserve editable line breaks; save parses empty lines and CRLF", () =>
  assert.deepEqual(parseKeyterms("config.json\r\n\r\n timeout\n"), [
    "config.json",
    "timeout",
  ]));
const body = "| 名称 | 数量 |\n|---|---|\n| 苹果 | 2 |";
function fixture() {
  const node = { closest: () => null },
    other = { closest: () => null };
  const turn = { contains: (n) => n === node };
  const element = { closest: () => turn };
  const selection = {
    isCollapsed: false,
    rangeCount: 1,
    anchorNode: { parentElement: node },
    focusNode: { parentElement: node },
    toString: () => "名称\t数量\n苹果\t2",
    getRangeAt: () => ({
      cloneContents: () => ({ querySelector: () => null }),
    }),
  };
  return { element, selection, node, other };
}
test("rendered table selection matches Markdown body while rejecting tools and other turns", () => {
  const f = fixture();
  assert.equal(
    selectedBody(body, f.element, f.selection),
    "名称\t数量\n苹果\t2",
  );
  assert.equal(selectedBody("其他回答", f.element, f.selection), "");
  f.selection.focusNode.parentElement = f.other;
  assert.equal(selectedBody(body, f.element, f.selection), "");
  f.selection.focusNode.parentElement = f.node;
  f.node.closest = () => ({});
  assert.equal(selectedBody(body, f.element, f.selection), "");
});
test("one selection listener, only matching reply offered, cleanup removes listener", () => {
  const f = fixture();
  let add = 0,
    remove = 0,
    handler;
  const doc = {
    addEventListener: (_name, fn) => {
      add++;
      handler = fn;
    },
    removeEventListener: () => remove++,
  };
  const results = [[], []],
    hub = createSelectionHub(doc, () => f.selection);
  const off = hub.register({
    element: () => f.element,
    body: () => body,
    notify: (v) => results[0].push(v),
  });
  hub.register({
    element: () => ({ closest: () => ({ contains: () => false }) }),
    body: () => body,
    notify: (v) => results[1].push(v),
  });
  assert.equal(add, 1);
  handler();
  assert.equal(results[0][0], "名称\t数量\n苹果\t2");
  assert.deepEqual(results[1], []);
  f.selection.isCollapsed = true;
  handler();
  assert.equal(results[0].at(-1), "");
  off();
  hub.clear();
  assert.equal(remove, 1);
});
