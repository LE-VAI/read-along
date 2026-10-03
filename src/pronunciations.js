/**
 * pronunciations.js — spoken-text substitutions applied at the engine
 * boundary, while the visible text stays exactly as written.
 *
 * WHY. A neural voice can be fluently, confidently wrong. Kokoro reads
 * "Theravada" as "The Ravada", with nothing in the pipeline to say so, and
 * in an assistive tool a mispronounced term is a correctness failure: it
 * teaches the wrong word with full confidence. The fix that works is to
 * change what the ENGINE is given ("Terra-vah-dah") and never what the
 * READER sees. Editing the source text to satisfy a TTS engine corrupts it
 * for every sighted reader, every screen reader and every other engine.
 *
 * THE HARD PART is not the substitution. It is keeping every index honest
 * afterwards. The component, its events, seek and `position` all count in
 * VISIBLE words, while engines report progress in offsets into the SPOKEN
 * string: Web Speech's `onboundary` gives a charIndex into the utterance,
 * and Kokoro's timings divide audio duration across spoken characters. So a
 * substitution yields a spoken VIEW of a chunk: the text to say, plus, for
 * every visible token, the [start, end) slice of that text which says it.
 * Engines map back through the view, and the highlight never leaves the
 * word on the page.
 *
 * Matching rules:
 *   - whole word, case-insensitive. "Whole" means the match does not touch
 *     a letter, digit or combining mark, so "Theravada," "(Theravada" and
 *     "Theravada's" all match and "Theravadin" does not
 *   - multi-word keys are allowed; whitespace in a key matches the single
 *     space between tokens, so a key can span a line break in the source
 *   - leftmost match first, and at one position the LONGEST key wins
 *   - one pass: a replacement is never matched again
 *
 * DOM-free and dependency-free. The component, the engines, a build step
 * that pre-synthesizes audio, and the read-along-verify CLI all use this one
 * implementation, so a map means the same thing everywhere it is applied.
 */

/** Letters, digits and combining marks: what a whole-word match may not touch. */
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;

/**
 * Parse the JSON form of a map (the `pronunciations` attribute).
 *
 * Throws on anything that is not a JSON object, so the caller can decide
 * what a bad value means. The component's answer is: warn and ignore it,
 * because a typo in a pronunciation must never cost a reader their audio.
 *
 * @param {string} json
 * @returns {Record<string, string>}
 */
export function parsePronunciations(json) {
  const value = JSON.parse(json);
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(
      'pronunciations must be a JSON object, e.g. {"Theravada": "Terra-vah-dah"}'
    );
  }
  return value;
}

/**
 * Validate and compile a map for matching.
 *
 * Accepts a plain object or a Map. Entries whose key or replacement is not a
 * non-empty string are skipped and listed in `skipped`, never thrown: one
 * bad entry should not disable the good ones. Keys that differ only in case
 * collapse to one entry, and the later one wins.
 *
 * An empty replacement is skipped on purpose. Silencing a word would leave a
 * visible token with nothing spoken for it, and the reader would watch the
 * highlight skip a word the voice never mentions.
 *
 * @param {Record<string, string>|Map<string, string>|null|undefined} map
 * @returns {{size: number, entries: Array<{key: string, spoken: string}>,
 *   pattern: RegExp|null, skipped: string[]}}
 */
export function compilePronunciations(map) {
  const pairs = map instanceof Map ? [...map] : map && typeof map === "object" ? Object.entries(map) : [];
  const byFold = new Map();
  const skipped = [];
  for (const [rawKey, rawSpoken] of pairs) {
    const key = typeof rawKey === "string" ? collapse(rawKey) : "";
    const spoken = typeof rawSpoken === "string" ? collapse(rawSpoken) : "";
    if (!key || !spoken) {
      skipped.push(String(rawKey));
      continue;
    }
    const fold = key.toLowerCase();
    byFold.delete(fold); // re-insert so "later wins" also means later order
    byFold.set(fold, { key, spoken });
  }
  const entries = [...byFold.values()];
  if (!entries.length) return { size: 0, entries, pattern: null, skipped };

  // Longest key first: a regex alternation takes the FIRST alternative that
  // matches at a position, so ordering by length is what makes the longest
  // key win. Each key gets its own capture group, so the matched entry is
  // found by group number rather than by re-folding the matched text
  // (toLowerCase and the regex's case folding disagree on a few letters).
  const order = entries
    .map((e, i) => ({ e, i }))
    .sort((a, b) => b.e.key.length - a.e.key.length || a.i - b.i)
    .map(({ e }) => e);
  const source = order.map((e) => `(${escapeRegExp(e.key)})`).join("|");
  // The trailing boundary is a lookahead, so the engine backtracks to a
  // shorter key when a longer one ends mid-word ("Abu Bakrs" still matches
  // a key "Abu"). The LEADING boundary is checked by hand in
  // findPronunciations: lookbehind would be a SyntaxError on Safari < 16.4.
  const pattern = new RegExp(`(?:${source})(?![\\p{L}\\p{N}\\p{M}])`, "giu");
  return { size: order.length, entries: order, pattern, skipped };
}

/**
 * Every match of a compiled map in `text`, left to right, non-overlapping.
 *
 * @param {string} text
 * @param {ReturnType<typeof compilePronunciations>|null} compiled
 * @returns {Array<{start: number, end: number, key: string, spoken: string}>}
 */
export function findPronunciations(text, compiled) {
  const out = [];
  if (!compiled || !compiled.size || !text) return out;
  const re = compiled.pattern;
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > 0 && WORD_CHAR.test(codePointBefore(text, m.index))) {
      // Inside a word ("vada" in "Theravada"): not a whole-word match. Retry
      // from the next position, which keeps every later start reachable.
      re.lastIndex = m.index + 1;
      continue;
    }
    const g = m.findIndex((v, i) => i > 0 && v !== undefined);
    const entry = compiled.entries[g - 1];
    out.push({ start: m.index, end: m.index + m[0].length, key: entry.key, spoken: entry.spoken });
  }
  return out;
}

/**
 * Build the spoken view of a chunk.
 *
 * The visible string is the chunk's tokens joined by single spaces, exactly
 * what every engine spoke before pronunciations existed. `spans[k]` is the
 * slice of `text` that says `chunk.tokens[k]`, in the same order, so engines
 * can map a spoken offset back to a visible word and a visible word to its
 * spoken offset.
 *
 * Inside a multi-word replacement, the replacement's spoken words are dealt
 * out across the matched visible words, first to first and last to last, so
 * the highlight walks through a multi-word span in order and never leaves
 * it. When the replacement has FEWER words than its key, the words in
 * between get an empty span: the highlight passes over them, because the
 * voice does too.
 *
 * @param {{tokens: Array<{text: string, index: number}>}} chunk
 * @param {ReturnType<typeof compilePronunciations>|null} compiled
 * @returns {{text: string, spans: Array<{index: number, start: number, end: number}>,
 *   matches: Array<{key: string, spoken: string, first: number, last: number}>}}
 */
export function spokenChunk(chunk, compiled) {
  const tokens = chunk.tokens;
  const vstart = new Array(tokens.length);
  let visible = "";
  for (let k = 0; k < tokens.length; k++) {
    if (k) visible += " ";
    vstart[k] = visible.length;
    visible += tokens[k].text;
  }

  // Pieces tile the visible string: identity runs, and replacements carrying
  // the word-to-word mapping described above.
  const pieces = [];
  let text = "";
  let v = 0;
  const found = findPronunciations(visible, compiled);
  for (const f of found) {
    if (f.start > v) {
      pieces.push({ vs: v, ve: f.start, ss: text.length });
      text += visible.slice(v, f.start);
    }
    const ss = text.length;
    text += f.spoken;
    pieces.push({ vs: f.start, ve: f.end, ss, se: text.length, words: dealWords(visible, f, ss) });
    v = f.end;
  }
  if (v < visible.length) {
    pieces.push({ vs: v, ve: visible.length, ss: text.length });
    text += visible.slice(v);
  }

  const spans = tokens.map((tok, k) => {
    const start = mapStart(pieces, vstart[k], text.length);
    const end = Math.max(start, mapEnd(pieces, vstart[k] + tok.text.length, text.length));
    return { index: tok.index, start, end };
  });

  const matches = found.map((f) => {
    let first = -1;
    let last = -1;
    for (let k = 0; k < tokens.length; k++) {
      const a = vstart[k];
      const b = a + tokens[k].text.length;
      if (b > f.start && a < f.end) {
        if (first < 0) first = tokens[k].index;
        last = tokens[k].index;
      }
    }
    return { key: f.key, spoken: f.spoken, first, last };
  });

  return { text, spans, matches };
}

/**
 * Attach a spoken view to every chunk that a map changes, and remove it from
 * every chunk it does not. A chunk without a match keeps no view at all, so
 * it takes exactly the code path it always took.
 *
 * Mutates and returns `chunks`, so engines already holding the array see
 * the change on the next chunk they speak.
 *
 * @param {Array<object>} chunks
 * @param {ReturnType<typeof compilePronunciations>|null} compiled
 */
export function applySpokenViews(chunks, compiled) {
  for (const chunk of chunks) {
    const view = compiled && compiled.size ? spokenChunk(chunk, compiled) : null;
    if (view && view.matches.length) chunk.spoken = view;
    else delete chunk.spoken;
  }
  return chunks;
}

/**
 * Plain-text form, for a build step or a CLI: the text an engine would be
 * handed for `text` under this map, whitespace collapsed as the engines
 * receive it.
 *
 * @param {string} text
 * @param {ReturnType<typeof compilePronunciations>|null} compiled
 */
export function applyPronunciations(text, compiled) {
  const tokens = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(text)) !== null) tokens.push({ text: m[0], index: tokens.length });
  return spokenChunk({ tokens }, compiled).text;
}

/** What an engine should say for a chunk: the spoken view when there is one. */
export function spokenText(chunk) {
  return chunk.spoken ? chunk.spoken.text : chunk.tokens.map((t) => t.text).join(" ");
}

/**
 * The VISIBLE token being said at a char offset into `spokenText(chunk)`.
 *
 * Same contract as webspeech.js's tokenAtChar (a word's end offset belongs
 * to that word; past the end clamps to the last token), extended through the
 * spoken view. Empty spans are skipped: they belong to visible words that a
 * shorter replacement passed over, and the word being spoken at that offset
 * is the next one.
 *
 * @param {{tokens: Array, spoken?: {spans: Array<{start: number, end: number}>}}} chunk
 * @param {number} charIndex
 */
export function spokenTokenAt(chunk, charIndex) {
  const tokens = chunk.tokens;
  if (!tokens.length) return null;
  const c = Math.max(0, charIndex);
  const spans = chunk.spoken?.spans;
  if (spans) {
    for (let k = 0; k < tokens.length; k++) {
      const s = spans[k];
      if (s.end > s.start && c >= s.start && c <= s.end) return tokens[k];
    }
    return tokens[tokens.length - 1];
  }
  let offset = 0;
  for (const tok of tokens) {
    if (c >= offset && c <= offset + tok.text.length) return tok;
    offset += tok.text.length + 1;
  }
  return tokens[tokens.length - 1];
}

/**
 * A chunk starting at its k-th token, with its spoken view sliced to match.
 *
 * Seek uses this. Slicing the view, rather than re-matching the shorter token
 * list, keeps a replacement in force when a seek lands in the middle of a
 * multi-word key: the voice says the rest of the replacement instead of
 * suddenly reading the raw visible word.
 *
 * @param {{tokens: Array, end: number, spoken?: object}} chunk
 * @param {number} k token position within the chunk
 */
export function sliceChunk(chunk, k) {
  if (k <= 0) return chunk;
  const tokens = chunk.tokens.slice(k);
  const out = { tokens, start: tokens[0].start, end: chunk.end };
  const view = chunk.spoken;
  if (view) {
    const from = view.spans[k].start;
    out.spoken = {
      text: view.text.slice(from),
      spans: view.spans.slice(k).map((s) => ({ index: s.index, start: s.start - from, end: s.end - from })),
      matches: view.matches.filter((m) => m.last >= tokens[0].index),
    };
  }
  return out;
}

// -- internals ---------------------------------------------------------------

function collapse(s) {
  return s.trim().replace(/\s+/g, " ");
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The code point ending just before index i (surrogate-pair aware). */
function codePointBefore(s, i) {
  const lo = s.charCodeAt(i - 1);
  if (i >= 2 && lo >= 0xdc00 && lo <= 0xdfff) {
    const hi = s.charCodeAt(i - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return s.slice(i - 2, i);
  }
  return s[i - 1];
}

/**
 * For one replacement: the spoken [start, end) owed to each visible word of
 * the match. Spoken word w goes to visible word round(w * (n-1) / (m-1)),
 * which pins first to first and last to last whatever the counts.
 */
function dealWords(visible, f, ss) {
  const vwords = [];
  let p = f.start;
  for (const w of visible.slice(f.start, f.end).split(" ")) {
    vwords.push({ s: p, e: p + w.length });
    p += w.length + 1;
  }
  const swords = [];
  const re = /\S+/g;
  let m;
  while ((m = re.exec(f.spoken)) !== null) {
    swords.push({ s: ss + m.index, e: ss + m.index + m[0].length });
  }
  const n = vwords.length;
  const mm = swords.length;
  const owner = (w) => (mm === 1 ? 0 : Math.round((w * (n - 1)) / (mm - 1)));
  for (let j = 0; j < n; j++) {
    let start = Infinity;
    let end = -Infinity;
    for (let w = 0; w < mm; w++) {
      const o = owner(w);
      if (o >= j) start = Math.min(start, swords[w].s);
      if (o <= j) end = Math.max(end, swords[w].e);
    }
    vwords[j].start = start === Infinity ? ss + f.spoken.length : start;
    vwords[j].end = end === -Infinity ? ss : end;
  }
  return vwords;
}

/** Spoken offset where a visible token starting at v starts. */
function mapStart(pieces, v, textLength) {
  for (const p of pieces) {
    if (v < p.vs || v >= p.ve) continue;
    if (!p.words) return p.ss + (v - p.vs);
    let j = 0;
    while (j + 1 < p.words.length && p.words[j + 1].s <= v) j++;
    return p.words[j].start;
  }
  return textLength;
}

/** Spoken offset where a visible token ending at v ends. */
function mapEnd(pieces, v, textLength) {
  for (const p of pieces) {
    if (v <= p.vs || v > p.ve) continue;
    if (!p.words) return p.ss + (v - p.vs);
    if (v === p.ve) return p.se;
    let j = 0;
    while (j < p.words.length - 1 && p.words[j].e < v) j++;
    return p.words[j].end;
  }
  return textLength;
}
