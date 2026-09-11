/**
 * highlight.test.mjs — buildTokenRanges offset math + API detection (node).
 *
 * The Highlighter's DOM painting is browser work (covered live in the
 * demo); what must hold in ANY environment is that token ranges are built
 * from the tokenized offsets against the host's real text-node stream, and
 * that API detection degrades cleanly when Highlight is missing.
 *
 * Node has no DOM, so the TreeWalker/Range/document surface is stubbed
 * with a minimal fake: one text node whose .data is the full text.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { supportsHighlightAPI, buildTokenRanges } from "../src/highlight.js";
import { tokenize } from "../src/tokenizer.js";

test("supportsHighlightAPI is false without the Highlight global", () => {
  // Node has no Highlight/CSS.highlights — detection must say so.
  assert.equal(supportsHighlightAPI(), false);
});

test("buildTokenRanges maps token offsets onto the host's text node", () => {
  const text = "alpha beta gamma";
  const toks = tokenize(text).map((t, i) => ({ ...t, index: i }));

  const textNode = { data: text, nodeType: 3 };
  const host = { contains: () => true, textContent: text };
  const created = [];
  const fakeRange = (node, start, end) => ({
    startContainer: node,
    endContainer: node,
    startOffset: start,
    endOffset: end,
  });
  globalThis.NodeFilter = { SHOW_TEXT: 4 };
  globalThis.document = {
    createTreeWalker(root, _what) {
      // The fake host has exactly one text node.
      return { nextNode: () => (walkerUsed.done ? null : ((walkerUsed.done = true), textNode)) };
    },
    createRange() {
      const r = {};
      r.setStart = (n, o) => { r.startContainer = n; r.startOffset = o; };
      r.setEnd = (n, o) => { r.endContainer = n; r.endOffset = o; };
      created.push(r);
      return r;
    },
  };
  const walkerUsed = { done: false };
  try {
    const ranges = buildTokenRanges(host, toks);
    assert.equal(ranges.size, 3);
    // All three tokens live in the single node; offsets are token offsets.
    assert.equal(ranges.get(0).startOffset, 0);
    assert.equal(ranges.get(0).endOffset, 5);
    assert.equal(ranges.get(1).startOffset, 6);
    assert.equal(ranges.get(1).endOffset, 10);
    assert.equal(ranges.get(2).startOffset, 11);
    assert.equal(ranges.get(2).endOffset, 16);
    assert.equal(created.length, 3); // one Range per token
  } finally {
    delete globalThis.document;
    delete globalThis.NodeFilter;
  }
});

test("a token that outlives the DOM text is dropped, not a crash", () => {
  // Host text is shorter than the token list implies (DOM changed after
  // tokenization) — the walker exhausts and the builder stops cleanly.
  const textNode = { data: "alpha", nodeType: 3 };
  const host = { contains: () => true, textContent: "alpha" };
  const toks = [
    { text: "alpha", start: 0, end: 5, index: 0 },
    { text: "beta", start: 6, end: 10, index: 1 },
    { text: "gamma", start: 11, end: 16, index: 2 },
  ];
  globalThis.NodeFilter = { SHOW_TEXT: 4 };
  globalThis.document = {
    createTreeWalker() {
      return { nextNode: () => (walkerUsed.done ? null : ((walkerUsed.done = true), textNode)) };
    },
    createRange() {
      const r = {};
      r.setStart = (n, o) => { r.startContainer = n; r.startOffset = o; };
      r.setEnd = (n, o) => { r.endContainer = n; r.endOffset = o; };
      return r;
    },
  };
  const walkerUsed = { done: false };
  try {
    const ranges = buildTokenRanges(host, toks);
    assert.equal(ranges.size, 1); // tokens 1,2 have no DOM backing
    assert.ok(ranges.get(0));
    assert.equal(ranges.get(1), undefined);
  } finally {
    delete globalThis.document;
    delete globalThis.NodeFilter;
  }
});

test("offsets survive inline markup (em around a word)", () => {
  // textContent of "<p>A <em>bold</em> word.</p>" is "A bold word." —
  // tokenization must use TEXT content offsets, markup notwithstanding.
  const text = "A bold word.";
  const toks = tokenize(text);
  assert.equal(toks.length, 3);
  assert.deepEqual(
    toks.map((t) => text.slice(t.start, t.end)),
    ["A", "bold", "word."]
  );
});