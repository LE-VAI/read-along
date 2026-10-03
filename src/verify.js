/**
 * verify.js — the pure core of the read-along-verify CLI.
 *
 * The CLI answers one question: does the voice say what the page says? A
 * neural voice can render a word fluently and wrongly ("Theravada" comes out
 * as "The Ravada"), and nothing in a TTS pipeline reports it. So the check
 * is done from the outside:
 *
 *   1. synthesize each sentence with the voice under test;
 *   2. transcribe it back with an independent model (Whisper), in SENTENCE
 *      context — isolated words transcribe back scrambled;
 *   3. diff the transcript against the written words;
 *   4. control-test every mismatch: say the same sentence with a SECOND
 *      voice and transcribe that too.
 *
 * Step 4 is not optional. A transcriber has its own spelling habits, and two
 * "defects" in the session that motivated this tool (mihrab → "mirab",
 * Sawm → "Psalm") were Whisper respellings: the second voice was heard the
 * same way. A reported defect is a hypothesis until a second engine
 * confirms it.
 *
 * Everything here is pure — no file system, no models, no processes — so
 * the logic that decides what counts as a defect is unit-tested without
 * downloading anything. bin/read-along-verify.js does the I/O.
 */

// -- script text ----------------------------------------------------------------

/**
 * Markdown to speakable plain text. Headings and list items become their own
 * paragraphs (they are separate utterances), fenced code is dropped (nobody
 * proofreads a code block by ear), and link/emphasis syntax is unwrapped to
 * the words a reader sees. Deliberately small: enough for study notes and
 * READMEs, not a CommonMark implementation.
 *
 * @param {string} md
 * @returns {string}
 */
export function markdownToText(md) {
  let s = md.replace(/\r\n?/g, "\n");
  s = s.replace(/^---\n[\s\S]*?\n---\n/, ""); // front matter
  s = s.replace(/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?^ {0,3}\1[^\n]*$/gm, "");
  s = s.replace(/<!--[\s\S]*?-->/g, "").replace(/<\/?[A-Za-z][^>\n]*>/g, "");
  s = s.replace(/^ {0,3}\[[^\]\n]+\]:\s*\S.*$/gm, ""); // link definitions
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  s = s.replace(/\[([^\]]+)\]\[[^\]]*\]/g, "$1");
  s = s.replace(/`([^`\n]*)`/g, "$1");
  s = s
    .split("\n")
    .map((line) => {
      let l = line;
      if (/^ {0,3}([-*_])( *\1){2,} *$/.test(l)) return ""; // horizontal rule
      if (/^ *\|? *:?-{3,}:? *(\| *:?-{3,}:? *)*\|? *$/.test(l)) return ""; // table rule
      while (/^ {0,3}> ?/.test(l)) l = l.replace(/^ {0,3}> ?/, "");
      const heading = /^ {0,3}#{1,6} +(.*?)(?: +#+)? *$/.exec(l);
      if (heading) return `\n${heading[1]}\n`;
      const item = /^ *(?:[-*+]|\d+[.)]) +(.*)$/.exec(l);
      if (item) return `\n${item[1]}\n`;
      if (/^ *\|.*\| *$/.test(l)) {
        const cells = l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).filter(Boolean);
        return `\n${cells.join(". ")}\n`;
      }
      return l;
    })
    .join("\n");
  s = s.replace(/~~(?=\S)([^~\n]*?\S)~~/g, "$1");
  s = s.replace(/(\*\*|__)(?=\S)([^\n]*?\S)\1/g, "$2");
  s = s.replace(/\*(?=\S)([^*\n]*?\S)\*/g, "$1");
  s = s.replace(/(^|[^\p{L}\p{N}_])_(?=\S)([^_\n]*?\S)_(?![\p{L}\p{N}_])/gu, "$1$2");
  s = s.replace(/\\([\\`*_{}[\]()#+\-.!|>~])/g, "$1");
  return s;
}

/** Abbreviations that may end a sentence only when a capital follows. */
const ABBREVIATIONS = new Set([
  "etc", "vs", "cf", "al", "approx", "no", "fig", "figs", "vol", "ch", "pp",
  "inc", "ltd", "co", "corp", "dept", "est", "jan", "feb", "mar", "apr",
  "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
]);

/** Titles come before a name, so they never end a sentence. */
const TITLES = new Set([
  "mr", "mrs", "ms", "mx", "dr", "prof", "st", "mt", "gen", "col", "lt",
  "sgt", "capt", "rev", "hon", "sr", "jr",
]);

/**
 * Split text into sentences for synthesis.
 *
 * Paragraphs (blank-line separated) never merge across their boundary,
 * except that a fragment shorter than `minWords` — a heading, a one-word
 * line — is joined to its neighbour. That is what keeps a term in sentence
 * context: "Theravada" alone transcribes back worse than "Theravada. The
 * oldest school…". A full stop is added where the join needs one; this is
 * the text SPOKEN for the check, and the input file is never written.
 *
 * @param {string} text
 * @param {{minWords?: number}} [options]
 * @returns {string[]}
 */
export function splitSentences(text, { minWords = 4 } = {}) {
  const raw = [];
  for (const para of text.replace(/\r\n?/g, "\n").split(/\n\s*\n/)) {
    const flat = para.replace(/\s+/g, " ").trim();
    if (!flat) continue;
    const re = /[.!?…]+["'”’)\]]*(?= |$)/g;
    let last = 0;
    let m;
    while ((m = re.exec(flat)) !== null) {
      const end = m.index + m[0].length;
      if (end < flat.length && !isBoundary(flat, m.index, end)) continue;
      raw.push(flat.slice(last, end).trim());
      last = end;
    }
    if (last < flat.length) raw.push(flat.slice(last).trim());
  }
  return mergeShort(raw.filter(Boolean), minWords);
}

function isBoundary(flat, punctAt, end) {
  const next = flat.slice(end).trimStart()[0] ?? "";
  if (/\p{Ll}/u.test(next)) return false; // "approx. five", "e.g. the"
  if (flat[punctAt] !== ".") return true;
  const word = (/(\S+)$/.exec(flat.slice(0, punctAt + 1))?.[1] ?? "")
    .replace(/^[("'“‘[]+/, "")
    .replace(/\.+$/, "")
    .toLowerCase();
  if (TITLES.has(word)) return false;
  if (/^\p{L}$/u.test(word)) return false; // an initial: "J. R. Tolkien"
  if (/^(?:\p{L}\.)+\p{L}$/u.test(word)) return word !== "e.g" && word !== "i.e"; // U.S. at a sentence end
  return true; // ABBREVIATIONS followed by a capital do end the sentence
}

function mergeShort(sentences, minWords) {
  const out = [];
  let carry = "";
  for (const s of sentences) {
    const joined = carry ? `${terminate(carry)} ${s}` : s;
    if (countWords(joined) < minWords) {
      carry = joined;
      continue;
    }
    out.push(joined);
    carry = "";
  }
  if (carry) {
    if (out.length) out[out.length - 1] = `${terminate(out[out.length - 1])} ${carry}`;
    else out.push(carry);
  }
  return out;
}

function terminate(s) {
  return /[.!?…:;]["'”’)\]]*$/.test(s) ? s : `${s}.`;
}

function countWords(s) {
  return s.split(/\s+/).filter(Boolean).length;
}

// -- words ------------------------------------------------------------------------

/**
 * One comparable form of a word: case, accents and punctuation removed.
 * "Theravada's," → "theravadas", "Café" → "cafe".
 */
export function normalizeWord(w) {
  return w
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/['’‘`]/g, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

/**
 * Comparable words of a text. Hyphens, dashes and slashes split words, so
 * "read-along" and "read along" compare equal; `raw` keeps the word as
 * written (outer punctuation trimmed) for the report.
 *
 * @returns {Array<{raw: string, norm: string}>}
 */
export function words(text) {
  const out = [];
  for (const piece of String(text).split(/[\s\-‐‑‒–—―/]+/)) {
    const norm = piece === "&" ? "and" : normalizeWord(piece);
    if (!norm) continue;
    out.push({ raw: piece.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "") || piece, norm });
  }
  return out;
}

/** The written words of a token list, each tagged with its token index. */
export function expectedWords(tokens) {
  const out = [];
  for (const tok of tokens) {
    for (const w of words(tok.text)) out.push({ ...w, token: tok.index });
  }
  return out;
}

// -- alignment --------------------------------------------------------------------

/**
 * Word-level edit alignment (Levenshtein, unit costs) of `a` (written) and
 * `b` (heard), as ops in order: equal, sub, del (written but not heard) and
 * ins (heard but not written).
 *
 * @param {string[]} a
 * @param {string[]} b
 * @returns {Array<{type: "equal"|"sub"|"del"|"ins", e: number|null, h: number|null}>}
 */
export function alignWords(a, b) {
  const n = a.length;
  const m = b.length;
  const d = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = 0; i <= n; i++) d[i][0] = i;
  for (let j = 0; j <= m; j++) d[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      d[i][j] = Math.min(
        d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
        d[i - 1][j] + 1,
        d[i][j - 1] + 1
      );
    }
  }
  const ops = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1] && d[i][j] === d[i - 1][j - 1]) {
      ops.push({ type: "equal", e: --i, h: --j });
    } else if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + 1) {
      ops.push({ type: "sub", e: --i, h: --j });
    } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
      ops.push({ type: "del", e: --i, h: null });
    } else {
      ops.push({ type: "ins", e: null, h: --j });
    }
  }
  return ops.reverse();
}

/**
 * Compare a transcript with the written words.
 *
 * Returns the heard words and the mismatch REGIONS: maximal runs of edits,
 * each a written span [expStart, expEnd) and a heard span. A region is
 * dropped only when the transcript JOINED written words that the text
 * splits ("read-along" heard as "readalong"): a spelling convention, not a
 * sound. The reverse is kept on purpose — "Theravada" heard as "The Ravada"
 * is the same letters, and exactly the defect this tool exists to catch.
 *
 * @param {Array<{raw: string, norm: string}>} expected
 * @param {string} heardText
 */
export function compareTranscript(expected, heardText) {
  const heard = words(heardText);
  const ops = alignWords(expected.map((w) => w.norm), heard.map((w) => w.norm));
  const heardAt = new Array(expected.length).fill(-1);
  const regions = [];
  let cur = null;
  let p = 0;
  let q = 0;
  const close = () => {
    if (!cur) return;
    cur.expEnd = p;
    cur.heardEnd = q;
    cur.expected = expected.slice(cur.expStart, cur.expEnd);
    cur.heard = heard.slice(cur.heardStart, cur.heardEnd);
    const joinedOnly =
      cur.heard.length < cur.expected.length &&
      squash(cur.heard) === squash(cur.expected);
    if (!joinedOnly) regions.push(cur);
    cur = null;
  };
  for (const op of ops) {
    if (op.type === "equal") {
      close();
      heardAt[op.e] = op.h;
    } else if (!cur) {
      cur = { expStart: p, heardStart: q };
    }
    if (op.e !== null) p++;
    if (op.h !== null) q++;
  }
  close();
  return { heard, heardAt, regions };
}

function squash(ws) {
  return ws.map((w) => w.norm).join("");
}

/**
 * Whether a region touches the written span [lo, hi). An empty span (an
 * insertion) touches its neighbours on both sides, which errs towards
 * "these overlap" — and so towards inconclusive rather than a false verdict.
 */
export function overlaps(r, lo, hi) {
  if (r.expStart === r.expEnd || lo === hi) return r.expStart <= hi && lo <= r.expEnd;
  return r.expStart < hi && lo < r.expEnd;
}

/** The token indexes a region covers (an insertion borrows its neighbour). */
export function regionTokens(region, expected) {
  if (region.expEnd > region.expStart) {
    return [expected[region.expStart].token, expected[region.expEnd - 1].token];
  }
  const t = (expected[region.expStart - 1] ?? expected[region.expStart])?.token ?? -1;
  return [t, t];
}

/**
 * Classify one mismatch of the voice under test, using the control voice's
 * transcript of the same sentence.
 *
 *   synthesis-defect       the control was heard as written there, the voice
 *                          under test was not: the fault is in the speech
 *   transcription-artifact both voices were heard the same wrong way: the
 *                          transcriber respells this word, whoever says it
 *   inconclusive           the control was also heard wrongly, differently
 *   unconfirmed            there was no control transcript (`control` null)
 *
 * Regions from both transcripts that overlap are merged first (repeatedly,
 * until stable), so the two are compared over the same written span.
 *
 * @returns {{classification: string, control: string|null, expected: string, heard: string}}
 */
export function classifyRegion(region, tested, control, expected) {
  if (!control) {
    return {
      expected: expected.slice(region.expStart, region.expEnd).map((w) => w.raw).join(" "),
      heard: region.heard.map((w) => w.raw).join(" "),
      control: null,
      classification: "unconfirmed",
    };
  }
  let lo = region.expStart;
  let hi = region.expEnd;
  const fromTested = new Set([region]);
  const fromControl = new Set();
  for (let grew = true; grew;) {
    grew = false;
    for (const [list, seen] of [[control.regions, fromControl], [tested.regions, fromTested]]) {
      for (const r of list) {
        if (seen.has(r) || !overlaps(r, lo, hi)) continue;
        seen.add(r);
        lo = Math.min(lo, r.expStart);
        hi = Math.max(hi, r.expEnd);
        grew = true;
      }
    }
  }
  const t = heardOver(tested, lo, hi, expected);
  const c = heardOver(control, lo, hi, expected);
  const base = {
    expected: expected.slice(lo, hi).map((w) => w.raw).join(" "),
    heard: t.raw.join(" "),
    control: c.raw.join(" "),
  };
  if (!fromControl.size) return { ...base, classification: "synthesis-defect" };
  if (t.norm.join(" ") === c.norm.join(" ")) return { ...base, classification: "transcription-artifact" };
  return { ...base, classification: "inconclusive" };
}

/** What a transcript heard over the written span [lo, hi). */
function heardOver(result, lo, hi, expected) {
  const raw = [];
  const norm = [];
  const push = (ws) => {
    for (const w of ws) {
      raw.push(w.raw);
      norm.push(w.norm);
    }
  };
  for (let pos = lo; pos <= hi; pos++) {
    for (const r of result.regions) {
      if (r.expStart === r.expEnd && r.expStart === pos) push(r.heard);
    }
    if (pos === hi) break;
    const r = result.regions.find((x) => x.expStart <= pos && pos < x.expEnd);
    if (r) {
      if (r.expStart === pos) push(r.heard);
    } else {
      const h = result.heardAt[pos];
      push([h >= 0 ? result.heard[h] : expected[pos]]);
    }
  }
  return { raw, norm };
}

// -- audio --------------------------------------------------------------------------

/**
 * Parse a RIFF/WAVE file to mono Float32 samples.
 *
 * Handles PCM 8/16/24/32-bit, IEEE float 32/64 and WAVE_FORMAT_EXTENSIBLE,
 * any channel count (mixed down), odd-sized chunks (RIFF pads them), and a
 * size field larger than the file (streaming writers leave it unset).
 *
 * @param {Uint8Array|ArrayBuffer} bytes
 * @returns {{sampleRate: number, channels: number, samples: Float32Array}}
 */
export function parseWav(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const tag = (o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  if (b.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }
  let fmt = null;
  let data = null;
  let o = 12;
  while (o + 8 <= b.length) {
    const id = tag(o);
    const body = o + 8;
    let size = dv.getUint32(o + 4, true);
    if (body + size > b.length || (id === "data" && size === 0)) size = b.length - body;
    if (id === "fmt " && size >= 16) {
      fmt = {
        format: dv.getUint16(body, true),
        channels: dv.getUint16(body + 2, true),
        sampleRate: dv.getUint32(body + 4, true),
        bits: dv.getUint16(body + 14, true),
      };
      if (fmt.format === 0xfffe && size >= 26) fmt.format = dv.getUint16(body + 24, true);
    } else if (id === "data") {
      data = { offset: body, size };
    }
    o = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error("WAV is missing its fmt or data chunk");
  const { format, channels, sampleRate, bits } = fmt;
  const width = bits / 8;
  const read =
    format === 1 && bits === 8 ? (at) => (b[at] - 128) / 128
    : format === 1 && bits === 16 ? (at) => dv.getInt16(at, true) / 32768
    : format === 1 && bits === 24 ? (at) => (((b[at + 2] << 24) | (b[at + 1] << 16) | (b[at] << 8)) >> 8) / 8388608
    : format === 1 && bits === 32 ? (at) => dv.getInt32(at, true) / 2147483648
    : format === 3 && bits === 32 ? (at) => dv.getFloat32(at, true)
    : format === 3 && bits === 64 ? (at) => dv.getFloat64(at, true)
    : null;
  if (!read || !channels) throw new Error(`unsupported WAV encoding (format ${format}, ${bits}-bit)`);
  const frames = Math.floor(data.size / (width * channels));
  const samples = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += read(data.offset + (f * channels + c) * width);
    samples[f] = sum / channels;
  }
  return { sampleRate, channels, samples };
}

/**
 * Band-limited resampling (Hann-windowed sinc). Whisper wants 16 kHz;
 * Kokoro speaks at 24 kHz, and OS voices at whatever they like. Plain linear
 * interpolation would fold everything between 8 and 12 kHz back into the
 * band the transcriber listens to; the low-pass here removes it first.
 *
 * @param {Float32Array|number[]} input
 * @param {number} fromRate
 * @param {number} toRate
 * @returns {Float32Array}
 */
export function resample(input, fromRate, toRate) {
  if (fromRate === toRate) return Float32Array.from(input);
  const ratio = toRate / fromRate;
  const out = new Float32Array(Math.round(input.length * ratio));
  const cutoff = Math.min(1, ratio) * 0.95; // fraction of the input Nyquist
  const half = Math.ceil(16 / cutoff); // window half-width, in input samples
  for (let n = 0; n < out.length; n++) {
    const t = n / ratio;
    const k0 = Math.max(0, Math.ceil(t - half));
    const k1 = Math.min(input.length - 1, Math.floor(t + half));
    let acc = 0;
    for (let k = k0; k <= k1; k++) {
      const x = t - k;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * cutoff * x) / (Math.PI * cutoff * x);
      const w = 0.5 * (1 + Math.cos((Math.PI * x) / half));
      acc += input[k] * cutoff * sinc * w;
    }
    out[n] = acc;
  }
  return out;
}

// -- report -------------------------------------------------------------------------

const LEGEND = {
  "synthesis-defect":
    "the control voice was heard as written and the voice under test was not. The fault is in the speech: add a pronunciation.",
  "transcription-artifact":
    "both voices were heard the same wrong way. The transcriber respells this word; the speech is probably fine. Do not \"fix\" it.",
  inconclusive:
    "the control voice was also heard wrongly, and differently. Listen yourself before changing anything.",
  unconfirmed:
    "no control voice was available, so this is a hypothesis, not a verdict. A reported defect is a hypothesis until a second engine confirms it.",
  "not-fixed": "the spoken form was applied, and the word still does not come back as written.",
  unverifiable: "the transcriber respells this word even from the control voice, so transcription cannot confirm a fix.",
};

/**
 * Counts: findings by classification, and pronunciation fixes by status.
 * Kept apart because "unconfirmed" means something different for each.
 */
export function summarize(findings, fixes) {
  const counts = {
    "synthesis-defect": 0, "transcription-artifact": 0, inconclusive: 0, unconfirmed: 0,
    fixes: { fixed: 0, "not-fixed": 0, unverifiable: 0, unconfirmed: 0 },
  };
  for (const f of findings) counts[f.classification]++;
  for (const f of fixes) counts.fixes[f.status]++;
  return counts;
}

function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The human-readable report: plain lines, no colour, no cursor tricks, so it
 * reads the same in a terminal, a CI log and a screen reader.
 */
export function formatReport(r) {
  const L = [];
  L.push(`read-along-verify ${r.version}`);
  L.push(`  script:         ${r.script} (${plural(r.sentences, "sentence")})`);
  L.push(`  voice:          ${r.tts.model} (${r.tts.voice}, ${r.tts.dtype})`);
  L.push(`  transcriber:    ${r.transcriber.model} (${r.transcriber.dtype})`);
  L.push(`  control:        ${r.control ? [r.control.engine, r.control.voice].filter(Boolean).join(", ") : "none found"}`);
  if (r.pronunciations) {
    L.push(`  pronunciations: ${r.pronunciations.file} (${plural(r.pronunciations.entries, "entry", "entries")})`);
  }
  L.push("");

  if (!r.findings.length) {
    L.push("Findings: none. Every word came back as written.");
  } else {
    L.push("Findings");
    r.findings.forEach((f, i) => {
      L.push(`  ${i + 1}. ${f.classification}, sentence ${f.sentence}`);
      L.push(`     written:  ${f.expected || "(nothing; extra words were heard)"}`);
      L.push(`     heard:    ${f.heard || "(nothing)"}`);
      if (f.control !== null) L.push(`     control:  ${f.control || "(nothing)"}`);
      L.push(`     sentence: ${f.text}`);
    });
  }

  const unused = r.unused ?? [];
  if (r.fixes.length || unused.length) {
    L.push("");
    L.push("Pronunciation fixes");
    for (const f of r.fixes) {
      L.push(`  ${f.status}: ${f.key}, spoken as "${f.spoken}", heard "${f.heard}" (sentence ${f.sentence})`);
    }
    for (const key of unused) L.push(`  unused: "${key}" does not occur in the script`);
  }

  const s = r.summary;
  const parts = [
    `${s["synthesis-defect"]} synthesis-defect`,
    `${s["transcription-artifact"]} transcription-artifact`,
    `${s.inconclusive} inconclusive`,
    `${s.unconfirmed} unconfirmed`,
  ];
  let line = `Summary: ${parts.join(", ")}`;
  if (r.fixes.length) {
    const x = s.fixes;
    line += `. Fixes: ${x.fixed} fixed, ${x["not-fixed"]} not-fixed, ${x.unverifiable} unverifiable, ${x.unconfirmed} unconfirmed`;
  }
  L.push("");
  L.push(`${line}.`);

  const present = Object.keys(LEGEND).filter((k) =>
    k === "not-fixed" || k === "unverifiable" ? s.fixes[k] > 0 : s[k] > 0 || (k === "unconfirmed" && s.fixes.unconfirmed > 0)
  );
  if (present.length) {
    L.push("");
    for (const k of present) L.push(`  ${k}: ${LEGEND[k]}`);
  }
  if (!r.control) {
    L.push("");
    L.push("  No OS voice was found for the control test. It uses Windows SAPI, macOS `say`, or espeak-ng on Linux.");
  }
  L.push("");
  L.push(r.ok ? "Result: no confirmed problems." : "Result: confirmed problems need attention (exit code 1).");
  return L.join("\n");
}
