/**
 * kokoro-engine.js — local neural TTS engine for <read-along> via kokoro-js.
 *
 * Why: Web Speech is free but its sync is guesswork (onboundary fails
 * broadly) and embedded browsers often expose it with zero voices. Kokoro
 * (82M params, WASM, runs locally in-browser) fixes both: real voices
 * everywhere, and because we hold the actual audio samples, word timing is
 * derived from measured chunk durations — not a chars/sec heuristic.
 *
 * Word timing method (honest about its limits): the public ONNX export does
 * not expose the model's native alignment output (Python KPipeline has it;
 * JS does not — the ONNX graph itself lacks the outputs). So we distribute
 * each chunk's REAL audio duration across its characters, then merge char
 * spans into words. Sentence-sized chunks keep the error bounded (the same
 * approach validated in production by ReadAloudTTS's overlay highlighter).
 * Sync source = the AudioContext sample clock, not wall-clock guessing.
 *
 * Playback model: one AudioContext; per chunk, synthesize → cache →
 * schedule as AudioBufferSourceNode. pause() = ctx.suspend() (freezes the
 * sample clock and all scheduled nodes — resume continues from the exact
 * sample). Synthesis runs one chunk ahead so CPU-speed synthesis never
 * stalls playback between chunks (the pipelined-chunker lesson from
 * ReadAloudTTS).
 *
 * This module imports "kokoro-js" — it is NOT part of read-along's zero-dep
 * core. Use it when you want local neural voices; the core component works
 * with it through the same 4-method engine contract as everything else.
 *
 * Usage:
 *   import { KokoroEngine } from "read-along/engines/kokoro.js";
 *   const engine = new KokoroEngine({ voice: "af_heart" });
 *   el.engine = engine;   // set BEFORE first play; loads model on first play
 */

import { KokoroTTS, TextSplitterStream } from "kokoro-js";

const TRAILING_SIL_MS = 250;

import { locateTokenChunk } from "./webspeech.js"; // acoustic buffer so the last word isn't clipped

export class KokoroEngine {
  /**
   * @param {object} [options]
   * @param {string} [options.voice="af_heart"] voice id (af_heart, af_bella,
   *   am_michael, …; af_* = American female, am_* = American male)
   * @param {number} [options.speed=1] synthesis speed multiplier
   * @param {string} [options.model="onnx-community/Kokoro-82M-v1.0-ONNX"]
   * @param {string} [options.dtype="q8"] quantization ("fp32" best / "q8"
   *   small+fast — ~80 MB vs ~300 MB download)
   * @param {string} [options.device="wasm"] execution device: "wasm" (CPU
   *   via WebAssembly — the browser-safe default; "cpu" is a Node-only
   *   device name) or "webgpu" where available
   */
  constructor(options = {}) {
    this.voice = options.voice ?? "af_heart";
    this.speed = options.speed ?? 1;
    this.model = options.model ?? "onnx-community/Kokoro-82M-v1.0-ONNX";
    this.dtype = options.dtype ?? "q8";
    // "cpu" works in Node, but browser transformers.js only accepts
    // wasm/webgpu — translate the Node-ism instead of failing.
    this.device = options.device === "cpu" ? "wasm" : (options.device ?? "wasm");
    this.onToken = options.onToken || null;
    this.onChunkStart = options.onChunkStart || null;
    this.onChunkEnd = options.onChunkEnd || null;
    this.onEnd = options.onEnd || null;
    this.onError = options.onError || null;
    this.onProgress = options.onProgress || null; // (pct 0..1, label)
    this._tts = null;
    this._chunks = [];
    this._cache = new Map(); // cacheKey -> {samples, sampleRate}
    this._ctx = null;
    this._src = null;
    this._raf = null;
    this._timings = null;
    this._startTime = 0;
    this._chunkIdx = -1;
    this._tokenIndex = -1;
    this._stopped = true;
    this._paused = false;
  }

  /** Engine contract: register chunks without speaking. */
  setChunks(chunks) {
    this._chunks = chunks || [];
  }

  /** True once the model is loaded (for UI gating). */
  get ready() {
    return !!this._tts;
  }

  /**
   * Load the model (idempotent). Call up-front to shift the model download
   * off the play button, or let the first play trigger it.
   * @returns {Promise<void>}
   */
  async load() {
    if (this._tts) return;
    this.onProgress?.(0, "Loading voice model");
    try {
      this._tts = await KokoroTTS.from_pretrained(this.model, {
        dtype: this.dtype,
        device: this.device,
      });
      this.onProgress?.(1, "Voice model ready");
    } catch (err) {
      this.onError?.(new Error(`kokoro load failed: ${err?.message ?? err}`));
      throw err;
    }
  }

  async speak(chunks, startWord = 0) {
    this._chunks = chunks || this._chunks;
    this._stopped = false;
    this._paused = false;
    let startChunk = 0;
    let startOffsetMs = 0;
    if (startWord > 0) {
      const ci = locateTokenChunk(this._chunks, startWord);
      if (ci >= 0) {
        startChunk = ci;
        this._seekWord = startWord; // _playBuffer computes the sample offset
      }
    } else {
      this._seekWord = null;
    }
    try {
      await this.load();
    } catch {
      return; // onError already fired
    }
    this._playChunk(startChunk);
  }

  async _playChunk(i) {
    if (this._stopped) return;
    if (i >= this._chunks.length) {
      this._finish();
      return;
    }
    const chunk = this._chunks[i];
    this.onChunkStart?.(i, chunk);
    try {
      const audio = await this._synth(chunk);
      if (this._stopped) return;
      // Pipelined synthesis: while chunk i plays, synthesize chunk i+1 so
      // CPU-speed synthesis never inserts a gap between chunks.
      const next = this._chunks[i + 1];
      if (next) this._synth(next).catch(() => {});
      this._playBuffer(audio, i, chunk);
    } catch (err) {
      if (this._stopped) return;
      this.onError?.(new Error(`kokoro synthesis failed: ${err?.message ?? err}`));
    }
  }

  /**
   * Synthesize a chunk to samples (Float32Array @ 24 kHz). Cached: replaying
   * a chunk (restart, click-to-seek) is instant.
   */
  async _synth(chunk) {
    const key = this._cacheKey(chunk);
    const hit = this._cache.get(key);
    if (hit) return hit;
    const text = chunk.tokens.map((t) => t.text).join(" ");
    const splitter = new TextSplitterStream();
    const stream = this._tts.stream(splitter, {
      voice: this.voice,
      speed: this.speed,
    });
    splitter.push(text);
    splitter.close();
    let samples = new Float32Array(0);
    let sampleRate = 24000;
    for await (const part of stream) {
      samples = concatFloat32(samples, part.audio.audio);
      sampleRate = part.audio.sampling_rate || sampleRate;
    }
    const audio = { samples, sampleRate };
    this._cache.set(key, audio);
    return audio;
  }

  /** FNV-1a over voice|speed|dtype|model|chunk-text — the audio identity. */
  _cacheKey(chunk) {
    const s = `${this.voice}|${this.speed}|${this.dtype}|${this.model}|` +
      chunk.tokens.map((t) => t.text).join(" ");
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h.toString(36);
  }

  /**
   * Schedule the chunk's audio on the AudioContext timeline and drive word
   * tokens from the sample clock. A pending `_seekWord` starts playback at
   * that word's sample offset (mid-chunk seek) and is consumed once.
   */
  _playBuffer(audio, chunkIdx, chunk) {
    const ctx = this._ensureCtx();
    this._cancelPoll();
    // Raw pad so the final word's tail isn't clipped by stop timing slop.
    const pad = Math.round(audio.sampleRate * TRAILING_SIL_MS / 1000);
    const padded = concatFloat32(audio.samples, new Float32Array(pad));
    const buffer = ctx.createBuffer(1, padded.length, audio.sampleRate);
    buffer.copyToChannel(padded, 0);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    this._src = src;
    this._chunkIdx = chunkIdx;
    this._tokenIndex = -1;
    this._timings = wordTimingsFromChunk(chunk, audio);

    // Word-level seek: start the source at the word's sample position. The
    // trimmed leading audio shifts every word's timing by the same offset,
    // so the sample clock stays the single source of truth.
    let offsetMs = 0;
    if (this._seekWord != null) {
      const hit = this._timings.find((w) => w.tokenIndex === this._seekWord);
      if (hit) offsetMs = hit.startMs;
      this._seekWord = null;
    }
    const offsetSec = Math.min(offsetMs / 1000, Math.max(0, buffer.duration - 0.05));

    this._startTime = ctx.currentTime - offsetSec; // pos math stays uniform
    src.onended = () => {
      if (this._stopped || this._src !== src) return;
      this.onChunkEnd?.(chunkIdx, chunk);
      this._playChunk(chunkIdx + 1);
    };
    src.start(0, offsetSec);
    this._advanceTo(offsetMs); // show the seeked word immediately
    this._startPoll();
  }

  _ensureCtx() {
    if (!this._ctx || this._ctx.state === "closed") {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      this._ctx = new AC();
    }
    return this._ctx;
  }

  _startPoll() {
    this._cancelPoll();
    const step = () => {
      if (this._stopped || this._paused) return;
      const ctx = this._ctx;
      if (!ctx || ctx.state === "closed") return;
      // Position inside the current chunk, in ms, from the sample clock.
      const posMs = (ctx.currentTime - this._startTime) * 1000;
      this._advanceTo(posMs);
      this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  }

  /** Set the active word to the last one whose startMs <= posMs. */
  _advanceTo(posMs) {
    const t = this._timings;
    if (!t) return;
    let active = -1;
    for (let k = 0; k < t.length; k++) {
      if (t[k].startMs <= posMs) active = k;
      else break;
    }
    if (active >= 0) this._emitToken(t[active].tokenIndex);
  }

  _emitToken(globalIdx) {
    if (globalIdx === this._tokenIndex) return;
    this._tokenIndex = globalIdx;
    this.onToken?.(globalIdx);
  }

  _cancelPoll() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  pause() {
    if (this._stopped || this._paused) return;
    this._paused = true;
    this._cancelPoll();
    // suspend() freezes the sample clock — resume() continues from the
    // exact sample; timings stay correct with zero bookkeeping.
    this._ctx?.suspend().catch(() => {});
  }

  resume() {
    if (!this._paused) return;
    this._paused = false;
    this._ctx?.resume().catch(() => {});
    this._startPoll();
  }

  stop() {
    if (this._stopped) return;
    this._stopped = true;
    this._cancelPoll();
    try { this._src?.stop(); } catch { /* already ended */ }
    try { this._src?.disconnect(); } catch { /* already disconnected */ }
    this._src = null;
    const ctx = this._ctx;
    this._ctx = null;
    ctx?.close?.().catch?.(() => {});
    this.onEnd?.();
  }

  get position() {
    return { chunk: this._chunkIdx, token: this._tokenIndex };
  }

  get mode() {
    return "audio";
  }

  _finish() {
    this._cancelPoll();
    this.onEnd?.();
  }
}

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

function concatFloat32(a, b) {
  if (!b.length) return a;
  if (!a.length) return b;
  const out = new Float32Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}