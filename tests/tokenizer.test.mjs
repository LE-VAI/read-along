/**
 * tokenizer.test.mjs — tokenize / sentences / chunkTokens.
 *
 * The tokenizer's whole contract is: offsets into the ORIGINAL string,
 * \S+ granularity, no normalization. Every offset test here guards the
 * invariant the highlight layer depends on (ranges must line up with the
 * host's real text nodes).
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { tokenize, sentences, chunkTokens } from "../src/tokenizer.js";

test("tokenize: plain sentence, offsets match source", () => {
  const text = "Hello world, this is read-along.";
  const toks = tokenize(text);
  assert.equal(toks.length, 5);
  assert.deepEqual(
    toks.map((t) => t.text),
    ["Hello", "world,", "this", "is", "read-along."]
  );
  // Offsets must slice the source back into the token.
  for (const t of toks) {
    assert.equal(text.slice(t.start, t.end), t.text);
  }
  assert.equal(toks[0].index, 0);
  assert.equal(toks[4].index, 4);
});

test("tokenize: multiple spaces and newlines collapse to nothing", () => {
  const toks = tokenize("a\n\n  b\t c");
  assert.deepEqual(
    toks.map((t) => t.text),
    ["a", "b", "c"]
  );
  for (const t of toks) assert.equal("a\n\n  b\t c".slice(t.start, t.end), t.text);
});

test("tokenize: empty and whitespace-only inputs", () => {
  assert.deepEqual(tokenize(""), []);
  assert.deepEqual(tokenize("   \n\t "), []);
});

test("tokenize: unicode words keep full grapheme runs", () => {
  const toks = tokenize("café naïve — 東京");
  // \S+ is codepoint-based: accented Latin words survive, the em dash is
  // its own token, and a CJK run (no internal whitespace) is one token —
  // CJK word segmentation is out of scope for v0.
  assert.deepEqual(
    toks.map((t) => t.text),
    ["café", "naïve", "—", "東京"]
  );
  for (const t of toks) {
    assert.equal("café naïve — 東京".slice(t.start, t.end), t.text);
  }
});

test("tokenize: does not share lastIndex state across calls", () => {
  const a = tokenize("one two");
  const b = tokenize("three four five");
  assert.equal(a.length, 2);
  assert.equal(b.length, 3); // a stale lastIndex would drop tokens here
});

test("sentences: splits on .!? and keeps spans in bounds", () => {
  const text = "First one. Second one! Third? No punctuation here";
  const sents = sentences(text);
  assert.equal(sents.length, 4);
  for (const s of sents) {
    assert.equal(text.slice(s.start, s.end), s.text);
    assert.ok(s.text.trim().length > 0);
  }
});

test("sentences: newlines break too", () => {
  const toks = sentences("line one\nline two");
  assert.equal(toks.length, 2);
});

test("chunkTokens: default chunking is sentence-bounded", () => {
  const text = "First sentence here. Second sentence follows. Third one ends it.";
  const toks = tokenize(text);
  const chunks = chunkTokens(toks);
  assert.ok(chunks.length >= 1);
  // Chunks must tile the tokens in order, with no gaps or overlaps.
  let prev = -1;
  for (const c of chunks) {
    for (const t of c.tokens) {
      assert.equal(t.index, prev + 1);
      prev = t.index;
    }
  }
  assert.equal(prev, toks.length - 1);
});

test("chunkTokens: chunk 0 is capped tighter (fast first audio)", () => {
  // Long run-on text: chunk 0 must emit near firstChunkChars (80), not 180.
  const text = "word ".repeat(120); // 600 chars, no punctuation
  const toks = tokenize(text);
  const chunks = chunkTokens(toks);
  const zero = chunks[0].tokens.map((t) => t.text).join(" ").length;
  assert.ok(zero <= 120, `chunk 0 chars=${zero}, expected <= ~80-120 band`);
});

test("chunkTokens: run-on text hard-emits at 1.5x cap", () => {
  const toks = tokenize("a ".repeat(400)); // 800 chars, zero punctuation
  const chunks = chunkTokens(toks);
  assert.ok(chunks.length > 1);
  for (const c of chunks) {
    const chars = c.tokens.reduce((n, t) => n + t.text.length + 1, 0);
    assert.ok(chars <= 180 * 1.5 + 4, `chunk exceeded 1.5x cap: ${chars}`);
  }
});

test("chunkTokens: empty input yields no chunks", () => {
  assert.deepEqual(chunkTokens([]), []);
});