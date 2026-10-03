/**
 * verify.test.mjs — read-along-verify's decisions, without a single model.
 *
 * The CLI's verdicts are only as good as four pure pieces: what counts as a
 * sentence, how a transcript is aligned to the written words, how a
 * mismatch is classified against the control voice, and how audio reaches
 * the transcriber. Each is pinned here with no download, so CI can hold the
 * line on the logic that tells a reader "this word is mispronounced".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

import {
  markdownToText,
  splitSentences,
  normalizeWord,
  words,
  expectedWords,
  alignWords,
  compareTranscript,
  classifyRegion,
  overlaps,
  regionTokens,
  parseWav,
  resample,
  summarize,
  formatReport,
} from "../src/verify.js";
import { tokenize } from "../src/tokenizer.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function expectedOf(text) {
  return expectedWords(tokenize(text));
}

// -- script text ----------------------------------------------------------------

test("markdownToText unwraps syntax to the words a reader sees", () => {
  const md = [
    "---", "title: notes", "---",
    "# Buddhist schools",
    "",
    "**Theravada** is the *oldest* school, see [the notes](https://example.com).",
    "![A stupa](stupa.png) and `inline code` and snake_case_name stay.",
    "",
    "```js", "const ignored = true;", "```",
    "",
    "> A quoted line.",
    "- first item",
    "2. second item",
    "",
    "| Term | Meaning |", "|---|---|", "| Sawm | fasting |",
    "<!-- hidden --> <b>bold</b> ~~old~~",
  ].join("\n");
  const text = markdownToText(md);
  assert.ok(!/[*#`[\]|~<>]/.test(text.replace(/\n/g, " ")), `syntax left in: ${text}`);
  assert.ok(!text.includes("title: notes"), "front matter dropped");
  assert.ok(!text.includes("ignored"), "fenced code dropped");
  assert.ok(!text.includes("example.com") && !text.includes("stupa.png"), "URLs dropped");
  for (const keep of ["Buddhist schools", "Theravada is the oldest school, see the notes.",
    "A stupa and inline code and snake_case_name stay.", "A quoted line.", "first item",
    "second item", "Sawm. fasting", "bold old"]) {
    assert.ok(text.includes(keep), `missing "${keep}" in:\n${text}`);
  }
});

test("splitSentences: plain sentences, ! and ?, closing quotes", () => {
  assert.deepEqual(
    splitSentences('The first one is here. Is the second here? Yes, it really is! "Quoted end," she said today.'),
    ["The first one is here.", "Is the second here?", "Yes, it really is!", '"Quoted end," she said today.']
  );
});

test("splitSentences: titles, initials, decimals and lowercase continuations do not split", () => {
  const out = splitSentences(
    "Dr. Smith met J. R. R. Tolkien in 1950. Costs rose 3.5 percent, e.g. the rent went up. " +
    "It moved to the U.S. The next year was calm."
  );
  assert.deepEqual(out, [
    "Dr. Smith met J. R. R. Tolkien in 1950.",
    "Costs rose 3.5 percent, e.g. the rent went up.",
    "It moved to the U.S.",
    "The next year was calm.",
  ]);
});

test("splitSentences keeps terms in sentence context: short fragments merge", () => {
  // A one-word heading transcribes back badly on its own, so it joins the
  // next sentence, with a full stop where the join needs one.
  assert.deepEqual(
    splitSentences("Theravada\n\nThe oldest surviving school of Buddhism.\n\nThe end."),
    ["Theravada. The oldest surviving school of Buddhism. The end."]
  );
  assert.deepEqual(splitSentences("Just two"), ["Just two"]);
  assert.deepEqual(splitSentences("   \n\n  "), []);
});

test("splitSentences never merges across paragraphs otherwise", () => {
  assert.deepEqual(
    splitSentences("A full first sentence here\nwrapped onto two lines.\n\nA second paragraph sentence stands."),
    ["A full first sentence here wrapped onto two lines.", "A second paragraph sentence stands."]
  );
});

// -- words -------------------------------------------------------------------------

test("words normalize case, accents, apostrophes and punctuation; hyphens split", () => {
  assert.equal(normalizeWord("Theravada's,"), "theravadas");
  assert.equal(normalizeWord("Café"), "cafe");
  assert.deepEqual(words("Read-along & café — ok!").map((w) => w.norm), ["read", "along", "and", "cafe", "ok"]);
  assert.deepEqual(words("(Theravada).").map((w) => w.raw), ["Theravada"]);
});

test("expectedWords tags every word with its token index", () => {
  const ws = expectedOf("A read-along test.");
  assert.deepEqual(ws.map((w) => [w.norm, w.token]), [["a", 0], ["read", 1], ["along", 1], ["test", 2]]);
});

// -- alignment ---------------------------------------------------------------------

test("alignWords: equal, substitution, insertion, deletion", () => {
  const types = (a, b) => alignWords(a, b).map((o) => o.type);
  assert.deepEqual(types(["a", "b"], ["a", "b"]), ["equal", "equal"]);
  assert.deepEqual(types(["a", "b"], ["a", "x"]), ["equal", "sub"]);
  assert.deepEqual(types(["a", "b"], ["a", "x", "b"]), ["equal", "ins", "equal"]);
  assert.deepEqual(types(["a", "b", "c"], ["a", "c"]), ["equal", "del", "equal"]);
  assert.deepEqual(types([], ["a"]), ["ins"]);
  assert.deepEqual(types(["a"], []), ["del"]);
});

test("compareTranscript: punctuation and case differences are not mismatches", () => {
  const r = compareTranscript(expectedOf("Theravada is the oldest school."), " theravada, IS the oldest school");
  assert.deepEqual(r.regions, []);
});

test("compareTranscript catches 'The Ravada', the same letters split in two", () => {
  const expected = expectedOf("Theravada is the oldest surviving school of Buddhism.");
  const r = compareTranscript(expected, " The Ravada is the oldest surviving school of Buddhism.");
  assert.equal(r.regions.length, 1);
  const [g] = r.regions;
  assert.deepEqual(g.expected.map((w) => w.raw), ["Theravada"]);
  assert.deepEqual(g.heard.map((w) => w.raw), ["The", "Ravada"]);
  assert.deepEqual(regionTokens(g, expected), [0, 0]);
});

test("compareTranscript drops a transcript that only JOINED split written words", () => {
  const joined = compareTranscript(expectedOf("A read-along test today."), "A readalong test today.");
  assert.deepEqual(joined.regions, [], "a spelling convention, not a sound");
  const split = compareTranscript(expectedOf("Good healthcare matters today."), "Good health care matters today.");
  assert.equal(split.regions.length, 1, "splitting a written word is kept for the control test");
});

test("overlaps treats an insertion as touching both neighbours", () => {
  assert.equal(overlaps({ expStart: 1, expEnd: 2 }, 0, 1), false, "adjacent spans do not overlap");
  assert.equal(overlaps({ expStart: 1, expEnd: 2 }, 1, 3), true);
  assert.equal(overlaps({ expStart: 2, expEnd: 2 }, 0, 2), true, "insertion right after the span");
  assert.equal(overlaps({ expStart: 0, expEnd: 2 }, 2, 2), true);
  assert.equal(overlaps({ expStart: 3, expEnd: 3 }, 0, 2), false);
});

test("an inserted heard word borrows its neighbour's token", () => {
  const expected = expectedOf("one two three");
  const r = compareTranscript(expected, "one two uh three");
  assert.equal(r.regions.length, 1);
  assert.deepEqual(regionTokens(r.regions[0], expected), [1, 1]);
});

// -- classification ----------------------------------------------------------------

const THERAVADA = "Theravada is the oldest surviving school of Buddhism.";
const MIHRAB = "The mihrab shows the direction of prayer.";

test("synthesis-defect: the control voice is heard as written, Kokoro is not", () => {
  const expected = expectedOf(THERAVADA);
  const tested = compareTranscript(expected, "The Ravada is the oldest surviving school of Buddhism.");
  const control = compareTranscript(expected, "Theravada is the oldest surviving school of Buddhism.");
  const v = classifyRegion(tested.regions[0], tested, control, expected);
  assert.equal(v.classification, "synthesis-defect");
  assert.equal(v.expected, "Theravada");
  assert.equal(v.heard, "The Ravada");
  assert.equal(v.control, "Theravada");
});

test("transcription-artifact: both voices come back with the same respelling", () => {
  const expected = expectedOf(MIHRAB);
  const tested = compareTranscript(expected, "The Mirab shows the direction of prayer.");
  const control = compareTranscript(expected, "The mirab shows the direction of prayer.");
  const v = classifyRegion(tested.regions[0], tested, control, expected);
  assert.equal(v.classification, "transcription-artifact");
  assert.equal(v.control, "mirab");
});

test("inconclusive: the control is wrong too, but differently", () => {
  const expected = expectedOf(MIHRAB);
  const tested = compareTranscript(expected, "The Mirab shows the direction of prayer.");
  const control = compareTranscript(expected, "The me rob shows the direction of prayer.");
  assert.equal(classifyRegion(tested.regions[0], tested, control, expected).classification, "inconclusive");
});

test("unconfirmed: no control transcript at all", () => {
  const expected = expectedOf(THERAVADA);
  const tested = compareTranscript(expected, "The Ravada is the oldest surviving school of Buddhism.");
  const v = classifyRegion(tested.regions[0], tested, null, expected);
  assert.equal(v.classification, "unconfirmed");
  assert.equal(v.control, null);
  assert.equal(v.heard, "The Ravada");
});

test("overlapping regions are merged before comparing, so spans line up", () => {
  // The control's mismatch spans two written words; Kokoro's covers one of
  // them. Compared over the merged span, the two transcripts agree.
  const expected = expectedOf("We read Abu Bakr today.");
  const tested = compareTranscript(expected, "We read Abu Baker today.");
  const control = compareTranscript(expected, "We read Abu Baker today.");
  assert.equal(classifyRegion(tested.regions[0], tested, control, expected).classification, "transcription-artifact");
  const control2 = compareTranscript(expected, "We read a boo Baker today.");
  assert.equal(classifyRegion(tested.regions[0], tested, control2, expected).classification, "inconclusive");
});

// -- audio --------------------------------------------------------------------------

/** Minimal WAV writer for the parser tests. */
function wav({ rate = 16000, channels = 1, bits = 16, format = 1, frames, extra = [], fmtSize = 16, dataSize }) {
  const width = bits / 8;
  const data = new Uint8Array(frames.length * channels * width);
  const dv = new DataView(data.buffer);
  frames.forEach((frame, f) => {
    for (let c = 0; c < channels; c++) {
      const v = Array.isArray(frame) ? frame[c] : frame;
      const at = (f * channels + c) * width;
      if (format === 3) dv.setFloat32(at, v, true);
      else if (bits === 16) dv.setInt16(at, Math.round(v * 32767), true);
      else if (bits === 24) {
        const n = Math.round(v * 8388607);
        data[at] = n & 0xff; data[at + 1] = (n >> 8) & 0xff; data[at + 2] = (n >> 16) & 0xff;
      } else if (bits === 8) data[at] = Math.round(v * 127) + 128;
    }
  });
  const chunks = [];
  const fmt = new Uint8Array(8 + fmtSize);
  const fv = new DataView(fmt.buffer);
  fmt.set([0x66, 0x6d, 0x74, 0x20]);
  fv.setUint32(4, fmtSize, true);
  fv.setUint16(8, format === "ext" ? 0xfffe : format, true);
  fv.setUint16(10, channels, true);
  fv.setUint32(12, rate, true);
  fv.setUint32(16, rate * channels * width, true);
  fv.setUint16(20, channels * width, true);
  fv.setUint16(22, bits, true);
  if (format === "ext") fv.setUint16(8 + 24, 1, true); // sub-format: PCM
  chunks.push(fmt);
  for (const e of extra) chunks.push(e);
  const head = new Uint8Array(8);
  head.set([0x64, 0x61, 0x74, 0x61]);
  new DataView(head.buffer).setUint32(4, dataSize ?? data.length, true);
  chunks.push(head, data);
  const body = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(12 + body);
  out.set([0x52, 0x49, 0x46, 0x46]);
  new DataView(out.buffer).setUint32(4, 4 + body, true);
  out.set([0x57, 0x41, 0x56, 0x45], 8);
  let at = 12;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

const close = (a, b, eps = 1e-3) => Math.abs(a - b) < eps;

test("parseWav: 16-bit PCM with SAPI's 18-byte fmt chunk", () => {
  const w = parseWav(wav({ frames: [0, 0.5, -0.5], fmtSize: 18 }));
  assert.equal(w.sampleRate, 16000);
  assert.ok(close(w.samples[1], 0.5) && close(w.samples[2], -0.5));
});

test("parseWav: stereo 24-bit mixes down; float32; 8-bit; extensible", () => {
  const st = parseWav(wav({ channels: 2, bits: 24, frames: [[0.5, -0.5], [0.25, 0.25]] }));
  assert.ok(close(st.samples[0], 0) && close(st.samples[1], 0.25));
  const fl = parseWav(wav({ format: 3, bits: 32, frames: [0.125] }));
  assert.ok(close(fl.samples[0], 0.125, 1e-7));
  const b8 = parseWav(wav({ bits: 8, frames: [0, 0.5] }));
  assert.ok(close(b8.samples[1], 0.5, 0.01));
  const ext = parseWav(wav({ format: "ext", fmtSize: 40, frames: [0.5] }));
  assert.ok(close(ext.samples[0], 0.5));
});

test("parseWav: skips other chunks with RIFF padding, tolerates oversize data", () => {
  const list = new Uint8Array(8 + 3 + 1); // odd-sized LIST chunk + pad byte
  list.set([0x4c, 0x49, 0x53, 0x54]);
  new DataView(list.buffer).setUint32(4, 3, true);
  const w = parseWav(wav({ frames: [0.25, 0.5], extra: [list] }));
  assert.equal(w.samples.length, 2);
  assert.ok(close(w.samples[1], 0.5));
  const streamed = parseWav(wav({ frames: [0.25, 0.5], dataSize: 0xffffffff }));
  assert.equal(streamed.samples.length, 2, "an unset size reads to the end of the file");
});

test("parseWav rejects what it cannot read, loudly", () => {
  assert.throws(() => parseWav(new Uint8Array(4)), /RIFF/);
  assert.throws(() => parseWav(wav({ format: 2, frames: [0] })), /unsupported/);
});

function sine(freq, rate, seconds) {
  return Float32Array.from({ length: Math.round(rate * seconds) }, (_, i) => Math.sin((2 * Math.PI * freq * i) / rate));
}
function rms(x, from = 0.1, to = 0.9) {
  const a = Math.floor(x.length * from);
  const b = Math.floor(x.length * to);
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / (b - a));
}

test("resample 24 kHz -> 16 kHz keeps a speech-band tone and its length", () => {
  const out = resample(sine(1000, 24000, 0.5), 24000, 16000);
  assert.equal(out.length, 8000);
  assert.ok(close(rms(out), Math.SQRT1_2, 0.02), `rms ${rms(out)}`);
  // Zero crossings: 1 kHz over the measured 0.4 s is about 800.
  let crossings = 0;
  for (let i = 801; i < 7200; i++) if ((out[i - 1] < 0) !== (out[i] < 0)) crossings++;
  assert.ok(Math.abs(crossings - 800) <= 4, `crossings ${crossings}`);
});

test("resample removes content above the new Nyquist instead of aliasing it", () => {
  const out = resample(sine(10000, 24000, 0.5), 24000, 16000);
  assert.ok(rms(out) < 0.03, `a 10 kHz tone should vanish at 16 kHz, rms ${rms(out)}`);
});

test("resample: equal rates copy, upsampling keeps the tone", () => {
  const x = sine(440, 16000, 0.1);
  const same = resample(x, 16000, 16000);
  assert.notEqual(same, x);
  assert.deepEqual(same, x);
  const up = resample(sine(1000, 16000, 0.5), 16000, 24000);
  assert.equal(up.length, 12000);
  assert.ok(close(rms(up), Math.SQRT1_2, 0.02));
});

// -- the report ----------------------------------------------------------------------

function sampleResult(overrides = {}) {
  const findings = [
    { sentence: 1, text: THERAVADA, expected: "Theravada", heard: "The Ravada", control: "Theravada", classification: "synthesis-defect" },
    { sentence: 2, text: MIHRAB, expected: "mihrab", heard: "Mirab", control: "mirab", classification: "transcription-artifact" },
  ];
  const fixes = [];
  const r = {
    version: "0.0.0", script: "notes.md", sentences: 2,
    tts: { model: "kokoro", voice: "af_heart", dtype: "q8" },
    transcriber: { model: "whisper", dtype: "q8" },
    control: { engine: "Windows SAPI", voice: "Microsoft David Desktop" },
    pronunciations: null, findings, fixes, unused: [],
    ...overrides,
  };
  r.summary = summarize(r.findings, r.fixes);
  r.ok = r.summary["synthesis-defect"] === 0 && r.summary.fixes["not-fixed"] === 0;
  return r;
}

test("summarize keeps findings and fix statuses apart", () => {
  const s = summarize(
    [{ classification: "unconfirmed" }, { classification: "synthesis-defect" }],
    [{ status: "fixed" }, { status: "unconfirmed" }]
  );
  assert.equal(s.unconfirmed, 1);
  assert.equal(s["synthesis-defect"], 1);
  assert.deepEqual(s.fixes, { fixed: 1, "not-fixed": 0, unverifiable: 0, unconfirmed: 1 });
});

test("formatReport: every finding, a legend only for what occurred, a plain verdict", () => {
  const out = formatReport(sampleResult());
  assert.match(out, /1\. synthesis-defect, sentence 1/);
  assert.match(out, /heard: {4}The Ravada/);
  assert.match(out, /control: {2}Theravada/);
  assert.match(out, /transcription-artifact: both voices/);
  assert.doesNotMatch(out, /inconclusive: the control/, "no legend line for a class that did not occur");
  assert.match(out, /Result: confirmed problems need attention \(exit code 1\)\./);
  assert.doesNotMatch(out, /\x1b\[/, "no colour codes: it must read the same in a screen reader");
});

test("formatReport: fixes, unused keys, and the missing-control warning", () => {
  const out = formatReport(sampleResult({
    control: null,
    findings: [],
    fixes: [{ sentence: 1, key: "Theravada", spoken: "Terra-vah-dah", heard: "Theravada", status: "fixed" }],
    unused: ["Sawm"],
    pronunciations: { file: "fixes.json", entries: 2 },
  }));
  assert.match(out, /pronunciations: fixes\.json \(2 entries\)/);
  assert.match(out, /fixed: Theravada, spoken as "Terra-vah-dah", heard "Theravada" \(sentence 1\)/);
  assert.match(out, /unused: "Sawm" does not occur in the script/);
  assert.match(out, /No OS voice was found for the control test/);
  assert.match(out, /Result: no confirmed problems\./);
});

// -- the CLI, on the paths that need no model ---------------------------------------

function cli(args, cwd = ROOT, binDir = join(ROOT, "bin")) {
  return spawnSync(process.execPath, [join(binDir, "read-along-verify.js"), ...args], { cwd, encoding: "utf8" });
}

test("CLI: --help exits 0, bad usage and unreadable input exit 2", () => {
  const help = cli(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: read-along-verify/);
  assert.equal(cli([]).status, 2);
  assert.equal(cli(["--bogus", "x.txt"]).status, 2);
  const missing = cli(["does-not-exist.txt"]);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /cannot read does-not-exist\.txt/);
});

test("CLI: a bad pronunciations file stops before any model loads", () => {
  const dir = mkdtempSync(join(tmpdir(), "rav-test-"));
  try {
    writeFileSync(join(dir, "s.txt"), "Theravada is the oldest surviving school.");
    writeFileSync(join(dir, "bad.json"), "{nope");
    const r = cli(["s.txt", "--pronunciations", "bad.json"], dir);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /cannot use bad\.json/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI: without the optional peers it prints the exact install command, input untouched", (t) => {
  // A copy of the package with no node_modules anywhere above it: the state
  // of a fresh install, and of this package's own CI.
  const dir = mkdtempSync(join(tmpdir(), "rav-nodeps-"));
  try {
    const pkg = join(dir, "pkg");
    mkdirSync(pkg);
    for (const p of ["bin", "src", "package.json"]) cpSync(join(ROOT, p), join(pkg, p), { recursive: true });
    try {
      createRequire(join(pkg, "bin", "x.js")).resolve("kokoro-js");
      t.skip("kokoro-js resolves from the temp directory (a parent node_modules), so this path is unreachable here");
      return;
    } catch { /* not resolvable: exactly the state under test */ }
    const script = join(dir, "script.txt");
    const original = "Theravada is the oldest surviving school of Buddhism.\n";
    writeFileSync(script, original);
    const r = cli([script], dir, join(pkg, "bin"));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /npm install --save-dev kokoro-js @huggingface\/transformers@\^3/);
    assert.match(r.stderr, /- kokoro-js/);
    assert.equal(readFileSync(script, "utf8"), original, "the script is only ever read");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
