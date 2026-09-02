/**
 * webspeech.js — Web Speech API engine with the Chrome cutoff defeated.
 *
 * Failure modes handled:
 *  1. The ~15s watchdog in desktop Chrome's bridge to OS speech engines kills
 *     long utterances (chromium:40747712) and long strings get truncated
 *     (~200+ chars). Defeat: every utterance stays under the cap via the
 *     chunker (chunk 0 ≤ 80 chars, later ≤ 180), plus a pause()/resume()
 *     keep-alive every 10s as a belt-and-suspenders guard.
 *  2. onboundary is unreliable (remote voices never fire it; Firefox is
 *     partial). Defeat: lock onto charIndex boundary events when they arrive;
 *     if none arrive within BOUNDARY_GRACE_MS, fall back to char-proportional
 *     interpolation (the proven ReadAloudTTS approach) driven by rAF, using a
 *     ~14.5 chars/sec @ rate 1 speaking-rate heuristic.
 *
 * Voice loading: getVoices() is async and platform-dependent; re-queried on
 * voiceschanged, best-match picked per lang at speak time.
 */

const KEEPALIVE_MS = 10_000;
const BOUNDARY_GRACE_MS = 600;
const CHARS_PER_SEC = 14.5; // ~150 wpm × ~5.8 chars/word, heuristic at rate 1

export class WebSpeechEngine {
  constructor(options = {}) {
    this.lang = options.lang ?? navigator.language ?? "en-US";
    this.rate = options.rate ?? 1;
    this.pitch = options.pitch ?? 1;
    this.voiceName = options.voiceName ?? null;
    this.onToken = options.onToken || null; // (tokenIndex) word boundary
    this.onChunkStart = options.onChunkStart || null;
    this.onChunkEnd = options.onChunkEnd || null;
    this.onEnd = options.onEnd || null;
    this.onError = options.onError || null;
    this.onVoices = options.onVoices || null;
    this._voices = [];
    this._keepalive = null;
    this._raf = null;
    this._stopped = true;
    this._paused = false;
    this._chunkIdx = -1;
    this._tokenIndex = -1;
    this._chunkT0 = 0;
    if (WebSpeechEngine.available) {
      this._refreshVoices();
      speechSynthesis.onvoiceschanged = () => this._refreshVoices();
    }
  }

  static get available() {
    return typeof window !== "undefined" && "speechSynthesis" in window;
  }

  _refreshVoices() {
    this._voices = speechSynthesis.getVoices() || [];
    if (this._voices.length) this.onVoices?.(this._voices);
  }

  get voices() {
    return this._voices;
  }

  /**
   * Speak chunks sequentially. Each chunk is one short utterance.
   * @param {Array<{tokens:Array,start:number,end:number}>} chunks
   */
  speak(chunks, startChunk = 0) {
    if (!WebSpeechEngine.available) {
      this.onError?.(new Error("speechSynthesis unavailable in this browser"));
      return;
    }
    this._chunks = chunks;
    this._stopped = false;
    this._paused = false;
    this._startKeepalive();
    this._speakChunk(startChunk);
  }

  _speakChunk(i) {
    if (this._stopped) return;
    if (i >= this._chunksLength()) {
      this._finish();
      return;
    }
    this._chunkIdx = i;
    const chunk = this._chunks[i];
    const utter = new SpeechSynthesisUtterance(chunkText(chunk));
    utter.lang = this.lang;
    utter.rate = this.rate;
    utter.pitch = this.pitch;
    const voice = this._pickVoice();
    if (voice) {
      utter.voice = voice;
      utter.lang = voice.lang;
    }
    this.onChunkStart?.(i, chunk);

    let boundarySeen = false;
    this._chunkT0 = performance.now();
    this._tokenIndex = -1;

    utter.onboundary = (e) => {
      if (this._stopped) return;
      if (e.name && e.name !== "word") return;
      boundarySeen = true;
      this._cancelInterpolation();
      const tok = tokenAtChar(chunk, e.charIndex ?? 0);
      if (tok) this._emitToken(tok.index);
    };

    utter.onstart = () => {
      if (this._stopped) return;
      // If this engine/voice never fires boundaries, interpolate instead.
      setTimeout(() => {
        if (!this._stopped && !boundarySeen && this._chunkIdx === i) {
          this._startInterpolation(chunk, i);
        }
      }, BOUNDARY_GRACE_MS);
    };

    utter.onend = () => {
      if (this._stopped) return;
      this._cancelInterpolation();
      this.onChunkEnd?.(i, chunk);
      this._speakChunk(i + 1);
    };

    utter.onerror = (ev) => {
      // cancel() surfaces as interrupted/canceled — a clean stop, not an error.
      const err = ev?.error ?? "unknown";
      if (err === "interrupted" || err === "canceled" || err === "Canceled") return;
      this._cancelInterpolation();
      this._stopKeepalive();
      this.onError?.(new Error(`speech synthesis error: ${err}`));
    };

    speechSynthesis.speak(utter);
  }

  // -- chunks are attached by the controller before speak() --------------
  setChunks(chunks) {
    this._chunks = chunks;
  }
  _chunksLength() {
    return this._chunks ? this._chunks.length : 0;
  }

  _emitToken(globalIdx) {
    if (globalIdx === this._tokenIndex) return;
    this._tokenIndex = globalIdx;
    this.onToken?.(globalIdx);
  }

  _startInterpolation(chunk, chunkIdx) {
    this._cancelInterpolation();
    const step = () => {
      if (this._stopped || this._chunkIdx !== chunkIdx) return;
      const elapsed = (performance.now() - this._chunkT0) / 1000;
      const chars = elapsed * CHARS_PER_SEC * this.rate;
      const tok = tokenAtChar(chunk, Math.floor(chars));
      if (tok) this._emitToken(tok.index);
      this._raf = requestAnimationFrame(step);
    };
    this._raf = requestAnimationFrame(step);
  }

  _cancelInterpolation() {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = null;
  }

  _pickVoice() {
    if (!this._voices.length) return null;
    if (this.voiceName) {
      const named = this._voices.find((v) => v.name === this.voiceName);
      if (named) return named;
    }
    const base = this.lang.split("-")[0];
    return (
      this._voices.find((v) => v.lang === this.lang) ||
      this._voices.find((v) => v.lang?.startsWith(base)) ||
      null
    );
  }

  _startKeepalive() {
    this._stopKeepalive();
    // Desktop-Chrome-only belt-and-suspenders for the ~15s watchdog
    // (chromium:41294170). On Android, pause()/resume() mid-utterance
    // breaks synthesis entirely (documented Chromium bug) — the sentence
    // chunking alone is the fix there, since chunks stay under the cap.
    if (/Android/i.test(navigator.userAgent)) return;
    this._keepalive = setInterval(() => {
      if (this._stopped || this._paused) return;
      if (speechSynthesis.speaking && !speechSynthesis.paused) {
        speechSynthesis.pause();
        speechSynthesis.resume();
      }
    }, KEEPALIVE_MS);
  }

  _stopKeepalive() {
    if (this._keepalive) clearInterval(this._keepalive);
    this._keepalive = null;
  }

  _finish() {
    this._stopKeepalive();
    this._cancelInterpolation();
    this.onEnd?.();
  }

  pause() {
    if (this._stopped || this._paused) return;
    this._paused = true;
    this._cancelInterpolation();
    speechSynthesis.pause();
  }

  resume() {
    if (!this._paused) return;
    speechSynthesis.resume();
    this._paused = false;
    // Restart interpolation clock so estimates don't jump across the pause.
    this._chunkT0 = performance.now();
    this._tokenIndex = -1;
  }

  stop() {
    if (this._stopped) return;
    this._stopped = true;
    this._stopKeepalive();
    this._cancelInterpolation();
    try { speechSynthesis.cancel(); } catch { /* not speaking — fine */ }
    this.onEnd?.();
  }

  get position() {
    return { chunk: this._chunkIdx, token: this._tokenIndex };
  }
}

/** Join a chunk's tokens back into speakable text. */
export function chunkText(chunk) {
  return chunk.tokens.map((t) => t.text).join(" ");
}

/** Token whose chunk-local [offset, offset+len) contains charIndex. */
export function tokenAtChar(chunk, charIndex) {
  let offset = 0;
  for (const tok of chunk.tokens) {
    if (charIndex >= offset && charIndex <= offset + tok.text.length) return tok;
    offset += tok.text.length + 1;
  }
  return chunk.tokens.length ? chunk.tokens[chunk.tokens.length - 1] : null;
}