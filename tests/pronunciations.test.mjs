/**
 * pronunciations.test.mjs — the spoken-view mapping, and the engines that
 * ride on it.
 *
 * The substitution itself is trivial. What these tests guard is the
 * invariant that makes it safe for a reader: every offset an engine reports
 * into the SPOKEN string maps back to exactly one VISIBLE word, in order,
 * and the visible text is never touched. A highlight that drifts off the
 * word being said is worse than no pronunciation fix at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parsePronunciations,
  compilePronunciations,
  findPronunciations,
  spokenChunk,
  applySpokenViews,
  applyPronunciations,
  spokenText,
  spokenTokenAt,
  sliceChunk,
} from "../src/pronunciations.js";
import { tokenize, chunkTokens } from "../src/tokenizer.js";
import { tokenAtChar, WebSpeechEngine } from "../src/engines/webspeech.js";
import { wordTimingsFromChunk, toEngineManifest } from "../src/timings.js";
import { ExternalEngine } from "../src/engines/external.js";

const THERAVADA = { Theravada: "Terra-vah-dah" };

/** A chunk over `text`, with token indexes starting at `base`. */
function chunkOf(text, base = 0) {
  const tokens = tokenize(text).map((t, i) => ({ ...t, index: base + i }));
  return { tokens, start: tokens[0]?.start ?? 0, end: tokens[tokens.length - 1]?.end ?? 0 };
}

/** The visible word a spoken offset lands on. */
function wordAt(chunk, c) {
  return spokenTokenAt(chunk, c)?.text;
}

/** Start offsets of each whitespace-separated spoken word. */
function spokenWordStarts(text) {
  return [...text.matchAll(/\S+/g)].map((m) => m.index);
}

// -- parsing and compiling ----------------------------------------------------

test("parsePronunciations accepts a JSON object and rejects everything else", () => {
  assert.deepEqual(parsePronunciations('{"Theravada":"Terra-vah-dah"}'), THERAVADA);
  for (const bad of ["[]", '"x"', "3", "null", "true"]) {
    assert.throws(() => parsePronunciations(bad), TypeError, bad);
  }
  assert.throws(() => parsePronunciations("{not json"), SyntaxError);
});

test("compile skips entries without a non-empty string key and value, and says which", () => {
  const c = compilePronunciations({ Theravada: "Terra-vah-dah", empty: "", blank: "   ", num: 3, "": "x" });
  assert.equal(c.size, 1);
  assert.deepEqual(c.skipped.sort(), ["", "blank", "empty", "num"]);
  assert.equal(compilePronunciations(null).size, 0);
  assert.equal(compilePronunciations(undefined).size, 0);
  assert.equal(compilePronunciations({}).size, 0);
});

test("compile accepts a Map, collapses whitespace, and a later case-variant wins", () => {
  const c = compilePronunciations(new Map([
    ["  Abu \n Bakr ", "  Ah-boo   Bahk-er "],
    ["theravada", "first"],
    ["THERAVADA", "second"],
  ]));
  assert.equal(c.size, 2);
  const byKey = Object.fromEntries(c.entries.map((e) => [e.key, e.spoken]));
  assert.equal(byKey["Abu Bakr"], "Ah-boo Bahk-er");
  assert.equal(byKey.THERAVADA, "second");
  assert.equal(byKey.theravada, undefined);
});

// -- matching rules -------------------------------------------------------------

test("whole-word: punctuation and possessives match, word-internal hits do not", () => {
  const c = compilePronunciations(THERAVADA);
  const text = "(Theravada) Theravada, Theravada's theravada Theravadin preTheravada";
  const hits = findPronunciations(text, c).map((m) => text.slice(m.start, m.end));
  assert.deepEqual(hits, ["Theravada", "Theravada", "Theravada", "theravada"]);
});

test("whole-word holds for accented letters and combining marks", () => {
  const c = compilePronunciations({ caf: "X", cafe: "Y", "Mañjuśrī": "Man-joo-shree" });
  assert.deepEqual(findPronunciations("café", c), [], "é is a letter: 'caf' is inside a word");
  assert.deepEqual(findPronunciations("café", c), [], "a combining mark continues the word");
  const m = findPronunciations("Hail Mañjuśrī.", c);
  assert.equal(m.length, 1);
  assert.equal(m[0].spoken, "Man-joo-shree");
});

test("regex metacharacters in keys are literal", () => {
  const c = compilePronunciations({ "Node.js": "node jay ess", "C++": "see plus plus" });
  assert.deepEqual(findPronunciations("Nodexjs", c), []);
  assert.equal(findPronunciations("Use Node.js today", c)[0].spoken, "node jay ess");
  assert.equal(findPronunciations("in C++ code", c)[0].spoken, "see plus plus");
});

test("longest key wins at a position, falling back when the longer ends mid-word", () => {
  const c = compilePronunciations({ Abu: "AH-BOO", "Abu Bakr": "Ah-boo Bahk-er" });
  assert.equal(applyPronunciations("Abu Bakr spoke", c), "Ah-boo Bahk-er spoke");
  assert.equal(applyPronunciations("Abu Bakrs spoke", c), "AH-BOO Bakrs spoke");
});

test("leftmost match first: overlapping keys never both apply", () => {
  const c = compilePronunciations({ "New York": "NY", "York City": "YC" });
  assert.equal(applyPronunciations("New York City", c), "NY City");
});

test("one pass: a replacement is never matched again", () => {
  const c = compilePronunciations({ alpha: "beta", beta: "gamma" });
  assert.equal(applyPronunciations("alpha beta", c), "beta gamma");
});

test("multi-word keys match across a line break in the source", () => {
  const c = compilePronunciations({ "Abu Bakr": "Ah-boo Bahk-er" });
  assert.equal(applyPronunciations("said Abu\n   Bakr", c), "said Ah-boo Bahk-er");
});

// -- the spoken view --------------------------------------------------------------

test("no map: the spoken view is the identity, and lookups agree with tokenAtChar", () => {
  const chunk = chunkOf("Speak the words as they light up.");
  const view = spokenChunk(chunk, null);
  assert.equal(view.text, "Speak the words as they light up.");
  assert.deepEqual(view.matches, []);
  const withView = { ...chunk, spoken: view };
  for (let c = 0; c <= view.text.length + 3; c++) {
    assert.equal(spokenTokenAt(withView, c), tokenAtChar(chunk, c), `offset ${c}`);
    assert.equal(spokenTokenAt(chunk, c), tokenAtChar(chunk, c), `offset ${c} (no view)`);
  }
});

test("Theravada: every spoken offset of the replacement maps to that one visible word", () => {
  const chunk = chunkOf("Theravada is the oldest school.");
  chunk.spoken = spokenChunk(chunk, compilePronunciations(THERAVADA));
  assert.equal(chunk.spoken.text, "Terra-vah-dah is the oldest school.");
  for (let c = 0; c <= "Terra-vah-dah".length; c++) {
    assert.equal(wordAt(chunk, c), "Theravada", `offset ${c}`);
  }
  // A boundary at each spoken word start walks the visible words in order.
  const seen = spokenWordStarts(chunk.spoken.text).map((c) => wordAt(chunk, c));
  assert.deepEqual(seen, ["Theravada", "is", "the", "oldest", "school."]);
  // Engines that split hyphens into separate boundaries still land on it.
  for (const part of ["Terra", "vah", "dah"]) {
    assert.equal(wordAt(chunk, chunk.spoken.text.indexOf(part)), "Theravada", part);
  }
});

test("the visible text is never touched", () => {
  const chunks = chunkTokens(tokenize("Theravada and Theravada's monks."));
  const before = JSON.stringify(chunks.map((c) => c.tokens));
  applySpokenViews(chunks, compilePronunciations(THERAVADA));
  assert.equal(JSON.stringify(chunks.map((c) => c.tokens)), before);
});

test("a spaced replacement (SUM -> S U M) still maps to exactly one word", () => {
  const chunk = chunkOf("Use SUM for totals.");
  chunk.spoken = spokenChunk(chunk, compilePronunciations({ SUM: "S U M" }));
  assert.equal(chunk.spoken.text, "Use S U M for totals.");
  const seen = spokenWordStarts(chunk.spoken.text).map((c) => wordAt(chunk, c));
  assert.deepEqual(seen, ["Use", "SUM", "SUM", "SUM", "for", "totals."]);
});

test("punctuation glued to a replaced word stays inside that word's span", () => {
  const chunk = chunkOf("Read (Theravada). Then rest.");
  chunk.spoken = spokenChunk(chunk, compilePronunciations(THERAVADA));
  const k = chunk.tokens.findIndex((t) => t.text === "(Theravada).");
  const span = chunk.spoken.spans[k];
  assert.equal(chunk.spoken.text.slice(span.start, span.end), "(Terra-vah-dah).");
});

test("multi-word key, equal word counts: word maps to word", () => {
  const chunk = chunkOf("Then Abu Bakr led.");
  chunk.spoken = spokenChunk(chunk, compilePronunciations({ "Abu Bakr": "Ah-boo Bahk-er" }));
  const seen = spokenWordStarts(chunk.spoken.text).map((c) => wordAt(chunk, c));
  assert.deepEqual(seen, ["Then", "Abu", "Bakr", "led."]);
  assert.deepEqual(chunk.spoken.matches, [{ key: "Abu Bakr", spoken: "Ah-boo Bahk-er", first: 1, last: 2 }]);
});

test("multi-word key, fewer spoken words: first and last pinned, the middle passed over", () => {
  const chunk = chunkOf("in New York City now");
  chunk.spoken = spokenChunk(chunk, compilePronunciations({ "New York City": "Nyork Sitty" }));
  const seen = spokenWordStarts(chunk.spoken.text).map((c) => wordAt(chunk, c));
  assert.deepEqual(seen, ["in", "New", "City", "now"]);
  const york = chunk.spoken.spans[2];
  assert.equal(york.start, york.end, "the skipped word has an empty span");
});

test("multi-word key, more spoken words: every visible word gets at least one", () => {
  const chunk = chunkOf("say Xi Jinping now");
  chunk.spoken = spokenChunk(chunk, compilePronunciations({ "Xi Jinping": "shee jin ping" }));
  const seen = spokenWordStarts(chunk.spoken.text).map((c) => wordAt(chunk, c));
  assert.deepEqual(seen, ["say", "Xi", "Jinping", "Jinping", "now"]);
});

test("spans are ordered, in bounds, and keep GLOBAL token indexes", () => {
  const c = compilePronunciations({ Theravada: "Terra-vah-dah", "New York City": "Nyork", SUM: "S U M" });
  const chunk = chunkOf("Theravada in New York City, SUM it.", 40);
  const view = spokenChunk(chunk, c);
  let prev = 0;
  view.spans.forEach((s, k) => {
    assert.equal(s.index, 40 + k);
    assert.ok(s.start >= prev && s.end >= s.start && s.end <= view.text.length, JSON.stringify(s));
    prev = s.start;
  });
});

test("applySpokenViews attaches views only where the map changes something, in place", () => {
  // Small caps force two chunks: one plain sentence, one with the key.
  const chunks = chunkTokens(tokenize("A plain first sentence. Then Theravada."), 10, 10);
  assert.ok(chunks.length >= 2);
  const same = applySpokenViews(chunks, compilePronunciations(THERAVADA));
  assert.equal(same, chunks, "mutates and returns the same array");
  assert.equal(chunks[0].spoken, undefined, "a chunk without a match keeps the old code path");
  assert.ok(chunks.at(-1).spoken.text.includes("Terra-vah-dah"));
  applySpokenViews(chunks, null);
  assert.ok(chunks.every((ch) => ch.spoken === undefined), "clearing the map removes every view");
});

test("spokenText falls back to the visible words without a view", () => {
  const chunk = chunkOf("Theravada is old.");
  assert.equal(spokenText(chunk), "Theravada is old.");
  chunk.spoken = spokenChunk(chunk, compilePronunciations(THERAVADA));
  assert.equal(spokenText(chunk), "Terra-vah-dah is old.");
});

test("sliceChunk (seek) slices the spoken view with the tokens", () => {
  const chunk = chunkOf("Read about Theravada and Abu Bakr today.", 10);
  chunk.spoken = spokenChunk(chunk, compilePronunciations({ ...THERAVADA, "Abu Bakr": "Ah-boo Bahk-er" }));
  const fromTheravada = sliceChunk(chunk, 2);
  assert.equal(fromTheravada.tokens[0].index, 12);
  assert.equal(fromTheravada.spoken.text, "Terra-vah-dah and Ah-boo Bahk-er today.");
  assert.equal(spokenTokenAt(fromTheravada, 0).index, 12);
  // Seeking to the second word of a multi-word key keeps the replacement.
  const fromBakr = sliceChunk(chunk, 5);
  assert.equal(fromBakr.spoken.text, "Bahk-er today.");
  assert.equal(spokenTokenAt(fromBakr, 0).text, "Bakr");
  assert.equal(sliceChunk(chunk, 0), chunk, "slicing at 0 is the chunk itself");
});

// -- timings: the Kokoro and build-time (media / external) path ---------------

test("timings follow the spoken text but keep visible token indexes", () => {
  const chunk = chunkOf("Theravada is old.", 5);
  chunk.spoken = spokenChunk(chunk, compilePronunciations(THERAVADA));
  const audio = { samples: new Float32Array(24000 * 2), sampleRate: 24000 }; // 2000 ms
  const words = wordTimingsFromChunk(chunk, audio);
  assert.deepEqual(words.map((w) => w.tokenIndex), [5, 6, 7]);
  const msPerChar = 2000 / chunk.spoken.text.length;
  assert.ok(Math.abs(words[0].endMs - "Terra-vah-dah".length * msPerChar) < 1e-9,
    "Theravada is timed as the longer word the voice actually says");
  assert.ok(Math.abs(words.at(-1).endMs - 2000) < 1e-9, "the last word ends with the audio");
  // The build-time path: the same timings feed the engines' tuple manifest.
  const engine = new ExternalEngine({ words: toEngineManifest(words) });
  assert.deepEqual(engine.words.map((w) => w[0]), [5, 6, 7]);
});

test("an identity view times words exactly like no view", () => {
  const chunk = chunkOf("Speak the words as they light up.");
  const audio = { samples: new Float32Array(24000), sampleRate: 24000 };
  const plain = wordTimingsFromChunk(chunk, audio);
  const viewed = wordTimingsFromChunk({ ...chunk, spoken: spokenChunk(chunk, null) }, audio);
  plain.forEach((w, i) => {
    assert.equal(viewed[i].tokenIndex, w.tokenIndex);
    assert.ok(Math.abs(viewed[i].startMs - w.startMs) < 1e-9);
    assert.ok(Math.abs(viewed[i].endMs - w.endMs) < 1e-9);
  });
});

// -- Web Speech: the utterance says the view, boundaries come back visible ----

function installSpeechStub() {
  const utterances = [];
  const synth = {
    speaking: true, pending: false, paused: false,
    speak(u) { utterances.push(u); },
    cancel() {}, pause() {}, resume() {},
    getVoices() { return []; },
    onvoiceschanged: null,
  };
  globalThis.window = { speechSynthesis: synth };
  globalThis.speechSynthesis = synth;
  globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  globalThis.requestAnimationFrame = () => 0;
  globalThis.cancelAnimationFrame = () => {};
  return {
    utterances,
    restore() {
      for (const k of ["window", "speechSynthesis", "SpeechSynthesisUtterance", "requestAnimationFrame", "cancelAnimationFrame"]) {
        delete globalThis[k];
      }
    },
  };
}

test("WebSpeechEngine speaks the spoken view and maps boundaries to visible words", () => {
  const stub = installSpeechStub();
  try {
    const chunks = [chunkOf("Theravada is the oldest school.")];
    applySpokenViews(chunks, compilePronunciations(THERAVADA));
    const seen = [];
    const e = new WebSpeechEngine({ onToken: (i) => seen.push(i) });
    e.speak(chunks);
    const u = stub.utterances[0];
    assert.equal(u.text, "Terra-vah-dah is the oldest school.", "the voice gets the spoken text");
    for (const c of spokenWordStarts(u.text)) u.onboundary({ name: "word", charIndex: c });
    assert.deepEqual(seen, [0, 1, 2, 3, 4], "boundaries come back as visible word indexes");
    // A boundary inside the hyphenated replacement stays on word 0.
    seen.length = 0;
    e._tokenIndex = -1;
    u.onboundary({ name: "word", charIndex: u.text.indexOf("dah") });
    assert.deepEqual(seen, [0]);
    e.stop();
  } finally {
    stub.restore();
  }
});

test("WebSpeechEngine seek into a chunk speaks the sliced spoken view", () => {
  const stub = installSpeechStub();
  try {
    const chunks = [chunkOf("Monks of Theravada keep the old rules.")];
    applySpokenViews(chunks, compilePronunciations(THERAVADA));
    const seen = [];
    const e = new WebSpeechEngine({ onToken: (i) => seen.push(i) });
    e.speak(chunks, 2); // seek to "Theravada"
    const u = stub.utterances[0];
    assert.equal(u.text, "Terra-vah-dah keep the old rules.");
    u.onboundary({ name: "word", charIndex: 0 });
    u.onboundary({ name: "word", charIndex: u.text.indexOf("keep") });
    assert.deepEqual(seen, [2, 3], "global indexes survive the slice");
    e.stop();
  } finally {
    stub.restore();
  }
});
