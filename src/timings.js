/**
 * timings.js — word-timing utilities shared across engines and hosts.
 *
 * wordTimingsFromChunk derives per-word spans from a chunk's REAL audio
 * duration (char-proportional). It lives here rather than in
 * engines/kokoro.js so hosts can build MediaEngine/ExternalEngine
 * manifests from kokoro output without importing kokoro-js (an optional
 * peer dep that must never be required to import the core package).
 */

/**
 * Word timings from a chunk's real audio duration, distributed by char
 * count and merged into the chunk's tokens (global token indexes).
 * Returns [{tokenIndex, startMs, endMs}, ...] sorted by startMs.
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