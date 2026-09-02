/**
 * read-along.js — <read-along> custom element: bimodal read-along player.
 *
 * Usage:
 *   <read-along>
 *     <p>Any inline markup. The words light up as they're spoken.</p>
 *   </read-along>
 *
 * The element wraps host content in a player (play/pause, restart, speed) and
 * speaks the text with a pluggable engine. Default engine: Web Speech with
 * the Chrome ~15s cutoff defeated. Pass your own engine via the `engine`
 * property — anything implementing { speak(chunks), pause(), resume(),
 * stop(), setChunks() } and calling back onToken/onChunkStart/onEnd works
 * (e.g. a kokoro-js or Piper WASM adapter, or a pre-synthesized-audio
 * engine with per-chunk audio + timings).
 *
 * Engine-agnostic by design: the controller never touches speechSynthesis;
 * it only consumes token/chunk offsets and drives the Highlighter.
 */

import { tokenize, chunkTokens } from "./tokenizer.js";
import {
  Highlighter,
  buildTokenRanges,
  supportsHighlightAPI,
} from "./highlight.js";
import { WebSpeechEngine } from "./engines/webspeech.js";

const template = document.createElement("template");
template.innerHTML = `
  <style>
    :host { display: block; }
    .ra-wrap { display: grid; gap: 10px; }
    .ra-controls {
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      font: 500 13px/1.2 ui-sans-serif, system-ui, sans-serif;
      color: CanvasText;
    }
    .ra-btn {
      display: inline-flex; align-items: center; justify-content: center;
      gap: 6px; min-height: 30px; min-width: 30px; padding: 5px 12px;
      border-radius: 999px; border: 1px solid color-mix(in oklab, currentColor 30%, transparent);
      background: Canvas; color: CanvasText; cursor: pointer;
    }
    .ra-btn:hover { border-color: currentColor; }
    .ra-btn:focus-visible, .ra-speed:focus-visible {
      outline: 2px solid Highlight; outline-offset: 2px;
    }
    .ra-btn[aria-pressed="true"] { background: color-mix(in oklab, Highlight 18%, Canvas); }
    .ra-btn svg { width: 13px; height: 13px; fill: currentColor; flex: none; }
    .ra-status { font-variant-numeric: tabular-nums; opacity: 0.75; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ra-speed { border-radius: 8px; padding: 5px 7px; border: 1px solid color-mix(in oklab, currentColor 25%, transparent); background: Canvas; color: CanvasText; }
    .ra-content { display: block; }
  </style>
  <div class="ra-wrap" part="wrap">
    <div class="ra-controls" role="group" aria-label="Read-along controls">
      <button class="ra-btn" id="play" aria-pressed="false">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path id="playicon" d="M4 2.5v11l9-5.5z"/></svg>
        <span id="playlabel">Listen</span>
      </button>
      <button class="ra-btn" id="restart" aria-label="Restart from the beginning">
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3a5 5 0 1 1-4.9 6h1.55A3.5 3.5 0 1 0 8 4.5V7L4 4l4-3z"/></svg>
      </button>
      <label class="ra-nowrap" style="display:inline-flex;align-items:center;gap:6px">
        <span class="ra-status" id="status">Ready</span>
      </label>
      <select class="ra-speed" id="speed" aria-label="Reading speed">
        <option value="0.75">0.75×</option>
        <option value="1" selected>1×</option>
        <option value="1.25">1.25×</option>
        <option value="1.5">1.5×</option>
        <option value="2">2×</option>
      </select>
    </div>
    <div class="ra-content"><slot></slot></div>
    <p id="ra-live" aria-live="polite" style="position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip-path:inset(50%);"></p>
  </div>
`;

const ICON_PLAY = "M4 2.5v11l9-5.5z";
const ICON_PAUSE = "M3.5 2.5h3.2v11H3.5zM9.3 2.5h3.2v11H9.3z";

class ReadAlong extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this.shadowRoot.appendChild(template.content.cloneNode(true));
    this._engine = null;
    this._tokens = [];
    this._chunks = [];
    this._highlighter = null;
    this._state = "idle"; // idle | playing | paused
    this._wireUI();
  }

  connectedCallback() {
    this._prepare();
  }

  disconnectedCallback() {
    this.stop();
    this._highlighter?.destroy();
  }

  // -- public API ----------------------------------------------------------

  get state() { return this._state; }

  /** Engine instance (WebSpeechEngine default). Set before first play. */
  get engine() { return this._engine; }
  set engine(e) {
    if (this._state !== "idle") this.stop();
    this._engine = e;
    this._bindEngine();
    if (e && this._chunks.length) e.setChunks(this._chunks);
  }

  play() { this._play(); }
  pause() { this._pause(); }
  toggle() { this._state === "playing" ? this._pause() : this._play(); }
  stop() { this._stop(); }

  static get observedAttributes() { return ["lang", "rate"]; }

  attributeChangedCallback(name, _old, value) {
    if (!this._engine) return;
    if (name === "lang") this._engine.lang = value;
    if (name === "rate") this._engine.rate = parseFloat(value) || 1;
  }

  // -- internals -----------------------------------------------------------

  _wireUI() {
    const $ = (id) => this.shadowRoot.getElementById(id);
    this._els = {
      play: $("play"), playicon: $("playicon"), playlabel: $("playlabel"),
      restart: $("restart"), status: $("status"), speed: $("speed"),
      live: $("ra-live"),
    };
    this._els.play.addEventListener("click", () => this.toggle());
    this._els.restart.addEventListener("click", () => {
      this.stop();
      this.play();
    });
    this._els.speed.addEventListener("change", () => {
      const r = parseFloat(this._els.speed.value) || 1;
      if (this._engine) this._engine.rate = r;
    });
  }

  _prepare() {
    if (this._prepared) return;
    this._prepared = true;
    // Tokenize the RAW textContent — no whitespace collapsing, because
    // offsets must match what the TreeWalker sees in the real text nodes.
    const text = this.textContent || "";
    this._tokens = tokenize(text);
    this._chunks = chunkTokens(this._tokens);
    this._highlighter = new Highlighter(this);
    this._highlighter.setTokenRanges(buildTokenRanges(this, this._tokens));
    if (!this._engine) {
      this.engine = new WebSpeechEngine({
        lang: this.getAttribute("lang") || undefined,
        rate: parseFloat(this.getAttribute("rate")) || 1,
      });
    }
  }

  _bindEngine() {
    const e = this._engine;
    if (!e) return;
    e.onToken = (i) => {
      this._highlighter?.setActive(i);
    };
    e.onChunkStart = (idx, chunk) => {
      // Sentence tint under the word karaoke (native highlight only).
      if (this._highlighter?.native) {
        const first = this._highlighter.tokenRanges.get(chunk.tokens[0].index);
        const last = this._highlighter.tokenRanges.get(
          chunk.tokens[chunk.tokens.length - 1].index
        );
        if (first && last) {
          const r = document.createRange();
          try {
            r.setStart(first.startContainer, first.startOffset);
            r.setEnd(last.endContainer, last.endOffset);
            this._highlighter.setSentence(r);
          } catch { /* straddles weird markup — skip tint */ }
        }
      }
    };
    e.onEnd = () => this._finish();
    e.onError = (err) => {
      this._announce(`Read-along error: ${err.message}`);
      this._setStatus("Error");
      this._stopUi();
    };
    if (this._chunks.length) e.setChunks(this._chunks);
  }

  _play() {
    this._prepare();
    if (!this._engine) return;
    if (this._state === "paused") {
      this._state = "playing";
      this._engine.resume();
      this._setPlayingUi(true);
      return;
    }
    if (this._state === "playing") return;
    if (!this._chunks.length) return;
    this._state = "playing";
    this._bindEngine();
    this._engine.rate = parseFloat(this._els.speed.value) || 1;
    this._engine.speak(this._chunks);
    this._setPlayingUi(true);
    this._announce("Playing, automated voice");
  }

  _pause() {
    if (this._state !== "playing") return;
    this._state = "paused";
    this._engine.pause();
    this._setPlayingUi(false);
    this._announce("Paused");
  }

  _stop() {
    if (this._state === "idle") return;
    const wasEngine = this._engine;
    this._state = "idle";
    wasEngine?.stop?.();
    this._highlighter?.clear();
    this._setPlayingUi(false);
    this._setStatus("Ready");
  }

  _finish() {
    this._state = "idle";
    this._highlighter?.clear();
    this._setPlayingUi(false);
    this._setStatus("Done");
    this._announce("Finished reading");
  }

  // -- UI helpers ----------------------------------------------------------

  _setPlayingUi(on) {
    this._els.play.setAttribute("aria-pressed", String(on));
    this._els.playicon.setAttribute("d", on ? ICON_PAUSE : ICON_PLAY);
    this._els.playlabel.textContent = on ? "Pause" : "Listen";
    this._setStatus(on ? "Playing" : "Paused");
  }

  _setStatus(msg) { this._els.status.textContent = msg; }

  _announce(msg) { this._els.live.textContent = msg; }
}

if (!customElements.get("read-along")) {
  customElements.define("read-along", ReadAlong);
}

export { ReadAlong, WebSpeechEngine, tokenize, chunkTokens, Highlighter, buildTokenRanges, supportsHighlightAPI };