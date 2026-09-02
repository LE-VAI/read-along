/**
 * media.js — pre-synthesized audio engine (build-time TTS, e.g. Piper Opus).
 *
 * The designesy.org Listen pattern: synthesize audio at build time, serve as
 * static files, and map playback position to tokens. This engine consumes
 * one audio file per chunk plus word timings (ms) per chunk — both formats
 * are plain JSON so any offline synthesizer (Piper CLI, kokoro export,
 * cloud TTS batch) can produce them.
 *
 * manifest format:
 *   {
 *     "chunks": [
 *       { "src": "audio/c000.opus", "duration": 6.4,
 *         "words": [[tokenIndex, startMs, endMs], ...] },
 *       ...
 *     ]
 *   }
 * `tokenIndex` refers to the token array produced by tokenize() on the host.
 */

const POLL_MS = 60;

export class MediaEngine {
  constructor(options = {}) {
    this.manifest = options.manifest ?? { chunks: [] };
    this.onToken = options.onToken || null;
    this.onChunkStart = options.onChunkStart || null;
    this.onChunkEnd = options.onChunkEnd || null;
    this.onEnd = options.onEnd || null;
    this.onError = options.onError || null;
    this._audio = null;
    this._timer = null;
    this._chunkIdx = -1;
    this._stopped = true;
    this._paused = false;
  }

  setChunks(_chunks) { /* chunk plan comes from the manifest, not tokens */ }

  get rate() { return this._audio?.playbackRate ?? 1; }
  set rate(r) { if (this._audio) this._audio.playbackRate = r; }

  speak(_chunks, startChunk = 0) {
    this._stopped = false;
    this._paused = false;
    this._playChunk(startChunk);
  }

  _playChunk(i) {
    if (this._stopped) return;
    const entry = this.manifest.chunks[i];
    if (!entry) { this.onEnd?.(); return; }
    this._chunkIdx = i;

    if (!this._audio) {
      this._audio = new Audio();
      this._audio.preload = "auto";
      this._audio.addEventListener("ended", () => {
        if (this._stopped) return;
        this.onChunkEnd?.(this._chunkIdx, null);
        this._playChunk(this._chunkIdx + 1);
      });
      this._audio.addEventListener("error", () => {
        if (this._stopped) return;
        this._stopPoll();
        this.onError?.(new Error(`audio failed: ${this.manifest.chunks[this._chunkIdx]?.src}`));
      });
    }

    this._audio.src = entry.src;
    this.onChunkStart?.(i, null);
    this._audio.play().catch((e) => {
      if (this._stopped) return;
      this.onError?.(new Error(`playback blocked: ${e.message}`));
    });
    this._stopPoll();
    this._timer = setInterval(() => this._poll(entry), POLL_MS);
  }

  _poll(entry) {
    if (this._stopped || !this._audio) return;
    const t = this._audio.currentTime * 1000;
    // Last word whose startMs has been reached (timings must be sorted).
    const words = entry.words;
    let idx = -1;
    for (let k = 0; k < words.length; k++) {
      if (words[k][1] <= t) idx = words[k][0];
      else break;
    }
    if (idx >= 0 && idx !== this._lastToken) {
      this._lastToken = idx;
      this.onToken?.(idx);
    }
  }

  _stopPoll() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  pause() {
    if (this._stopped || this._paused) return;
    this._paused = true;
    this._audio?.pause();
  }

  resume() {
    if (!this._paused) return;
    this._paused = false;
    this._audio?.play().catch(() => {});
  }

  stop() {
    if (this._stopped) return;
    this._stopped = true;
    this._stopPoll();
    if (this._audio) { this._audio.pause(); this._audio.removeAttribute("src"); }
    this.onEnd?.();
  }

  get position() { return { chunk: this._chunkIdx, token: this._lastToken ?? -1 }; }
}