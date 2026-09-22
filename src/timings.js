/**
 * timings.js — word-timing utilities shared across engines and hosts.
 *
 * wordTimingsFromChunk derives per-word spans from a chunk's REAL audio
 * duration (char-proportional). It lives here rather than in
 * engines/kokoro.js so hosts can build MediaEngine/ExternalEngine
 * manifests from kokoro output without importing kokoro-js (an optional
 * peer dep that must never be required to import the core package).
 *
 * TWO SHAPES, AND WHY THIS FILE OWNS BOTH.
 *
 * `wordTimingsFromChunk` returns OBJECTS (`{tokenIndex, startMs, endMs}`)
 * because kokoro.js reads them by name. But `ExternalEngine` and `MediaEngine`
 * both take TUPLES (`[tokenIndex, startMs, endMs]`) — their manifest format,
 * and the format their own docstrings describe.
 *
 * This file's header used to say it existed "so hosts can build
 * MediaEngine/ExternalEngine manifests" while handing them the wrong shape. A
 * host following that sentence crashed at `words.find(([tok]) => ...)` with
 * "object is not iterable". The mismatch went unnoticed because the only
 * in-package consumer is kokoro.js, which uses named fields, so no test and no
 * demo ever crossed the seam.
 *
 * `toEngineManifest` closes it. Hosts get both: the named-field form for their
 * own bookkeeping, and the tuple form the engines require.
 */

/**
 * Word timings from a chunk's real audio duration, distributed by char
 * count and merged into the chunk's tokens (global token indexes).
 * Returns [{tokenIndex, startMs, endMs}, ...] sorted by startMs.
 *
 * The named-field form. Pass the result to `toEngineManifest()` before giving
 * it to ExternalEngine or MediaEngine — they take tuples, not objects.
 */
export function wordTimingsFromChunk(chunk, audio) {
  const chars = chunk.tokens.map((t) => t.text).join(" ");
  if (!chars.length) return [];
  const durMs = (audio.samples.length / audio.sampleRate) * 1000;
  const charMs = durMs / chars.length;
  const words = [];
  let acc = 0; // chars consumed so far (including joining spaces)
  for (const tok of chunk.tokens) {
    const startMs = acc * charMs;
    acc += tok.text.length + 1; // +1 for the joining space
    const endMs = (acc - 1) * charMs;
    words.push({ tokenIndex: tok.index, startMs, endMs });
  }
  return words;
}

/**
 * Convert named-field timings into the tuple manifest the engines consume.
 *
 * Accepts either shape so a host can pass whatever it has: the objects from
 * `wordTimingsFromChunk`, or tuples it built itself (a media manifest read from
 * a JSON file, a Piper bridge's own output). Passing tuples through is a
 * no-op copy, which keeps call sites uniform.
 *
 * Sorted by startMs, because both engines require it — MediaEngine's lookup
 * walks the array assuming ascending time, and an unsorted manifest makes it
 * silently report the wrong word rather than fail.
 *
 * @param {Array<{tokenIndex: number, startMs: number, endMs: number}|[number, number, number]>} timings
 * @returns {Array<[number, number, number]>}
 */
export function toEngineManifest(timings) {
  if (!Array.isArray(timings)) return [];
  const tuples = timings.map((t) => (
    Array.isArray(t)
      ? [t[0], t[1], t[2]]
      : [t.tokenIndex, t.startMs, t.endMs]
  ));
  tuples.sort((a, b) => a[1] - b[1]);
  return tuples;
}