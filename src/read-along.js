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
 *
 * Two opt-ins sit on top of any engine:
 *   - `pronunciations` — a map applied to what the ENGINE says, never to
 *     what the page shows (pronunciations.js). Every public word index stays
 *     a visible-word index.
 *   - `naturalVoice` — a host-supplied loader for a neural engine, offered to
 *     the reader as a "Natural voice" button (natural-voice.js). The core
 *     never imports the neural engine itself.
 */

import { tokenize, chunkTokens } from "./tokenizer.js";
import {
  Highlighter,
  buildTokenRanges,
  supportsHighlightAPI,
} from "./highlight.js";
import { WebSpeechEngine } from "./engines/webspeech.js";
import { injectHighlightStyles, hasHighlightStyles } from "./styles.js";
import {
  parsePronunciations,
  compilePronunciations,
  applySpokenViews,
} from "./pronunciations.js";
import { NaturalVoice, DEFAULT_DOWNLOAD_SIZE } from "./natural-voice.js";
import { announceTo } from "./announce.js";

const template = document.createElement("template");
template.innerHTML = `
  <style>
    /*
     * Contrast rules. Two kinds of text live here, and each takes its colour
     * from the background it actually sits on:
     *   - controls (buttons, select) paint their OWN background, so they use
     *     the system pair Canvas / CanvasText, which the browser keeps
     *     legible together;
     *   - loose text (status, the natural-voice note) sits on the HOST's
     *     background, so it inherits the HOST's text colour at full strength.
     * The status used to force CanvasText at 75% opacity. On a dark host that
     * did not declare color-scheme, that was near-black text on a near-black
     * page, and axe 4.13 flagged it as a serious WCAG 2.2 AA failure. No
     * opacity, no translucent colours and no color-mix() anywhere in this
     * sheet: the last because hostile engines drop the whole declaration
     * (see the note in read-along.css).
     */
    :host { display: block; }
    [hidden] { display: none !important; }
    .ra-wrap { display: grid; gap: 10px; }
    .ra-controls {
      display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      font: 500 13px/1.2 ui-sans-serif, system-ui, sans-serif;
    }
    .ra-btn {
      display: inline-flex; align-items: center; justify-content: center;
      gap: 6px; min-height: 30px; min-width: 30px; padding: 5px 12px;
      border-radius: 999px; border: 1px solid CanvasText;
      background: Canvas; color: CanvasText; cursor: pointer;
    }
    .ra-btn:hover { box-shadow: inset 0 0 0 1px currentColor; }
    .ra-btn:focus-visible, .ra-speed:focus-visible {
      outline: 2px solid Highlight; outline-offset: 2px;
    }
    /* Pressed reads as a heavier ring, not a tint: no colour is needed to see
       it, and the label or icon changes with it too. */
    .ra-btn[aria-pressed="true"] { box-shadow: inset 0 0 0 2px currentColor; }
    .ra-btn svg { width: 13px; height: 13px; fill: currentColor; flex: none; }
    .ra-status { font-variant-numeric: tabular-nums; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .ra-note { font-variant-numeric: tabular-nums; }
    .ra-speed { border-radius: 8px; padding: 5px 7px; border: 1px solid CanvasText; background: Canvas; color: CanvasText; }
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
      <button class="ra-btn" id="natural" aria-pressed="false" aria-describedby="naturalnote" hidden>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path id="naturalicon" d="M1.5 6h2v4h-2zM5.5 3h2v10h-2zM9.5 5h2v6h-2zM13 7h2v2h-2z"/></svg>
        <span>Natural voice</span>
      </button>
      <span class="ra-note" id="naturalnote" hidden></span>
    </div>
    <div class="ra-content"><slot></slot></div>
    <p id="ra-live" aria-live="polite" style="position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;clip-path:inset(50%);"></p>
  </div>
`;

const ICON_PLAY = "M4 2.5v11l9-5.5z";
const ICON_PAUSE = "M3.5 2.5h3.2v11H3.5zM9.3 2.5h3.2v11H9.3z";
const ICON_VOICE = "M1.5 6h2v4h-2zM5.5 3h2v10h-2zM9.5 5h2v6h-2zM13 7h2v2h-2z";
const ICON_CHECK = "M6.2 11.6 2.7 8.1l1.1-1.1 2.4 2.4 6-6 1.1 1.1z";

/** Instances holding the voice right now — enforces a one-voice policy. */
const ACTIVE = new Set();

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
    this._pron = null;          // compiled pronunciations, or null
    this._natural = null;       // NaturalVoice controller, when offered
    this._naturalOption = null; // what the host assigned to naturalVoice
    this._standardEngine = null;
    this._resumeWord = null;    // where play() resumes after a paused swap
    this._swapping = false;
    this._wireUI();
    // A property assigned before the element upgraded is an own property
    // that shadows the accessor. Re-assign it so the setter runs.
    for (const prop of ["pronunciations", "naturalVoice"]) {
      if (Object.prototype.hasOwnProperty.call(this, prop)) {
        const value = this[prop];
        delete this[prop];
        this[prop] = value;
      }
    }
  }

  connectedCallback() {
    /**
     * Adopt the highlight stylesheet.
     *
     * This is not optional, and the failure mode when it is missing is silent
     * in the worst way: the Ranges register, the component plays, the words are
     * spoken, and NOTHING IS EVER HIGHLIGHTED. Verified in a browser before
     * this was added — activeToken 5, one Range registered, zero ::highlight
     * rules in the document.
     *
     * A host may suppress injection with `no-inject-styles` (strict CSP, or a
     * page that loads the published stylesheet itself). In that case the
     * stylesheet's presence is still CHECKED, and if it is absent the component
     * says so rather than looking broken for no visible reason.
     */
    if (!this.hasAttribute("no-inject-styles")) {
      injectHighlightStyles(this.ownerDocument);
    }
    if (!hasHighlightStyles(this.ownerDocument)) {
      this._setStatus?.("Stylesheet missing — see read-along.css");
      this._announce?.(
        "The highlight stylesheet is not loaded, so words will not light up. " +
        "Add read-along.css to the page."
      );
    }

    if (this._prepared && this._highlighter?.destroyed) {
      // Re-connected after disconnect destroyed the highlighter — rebuild
      // it and re-map token ranges (the DOM may have changed too).
      this._highlighter = new Highlighter(this, {
        forceFallback: this.hasAttribute("force-fallback"),
      });
      this._highlighter.setTokenRanges(buildTokenRanges(this, this._tokens));
    }
    this._prepare();
    // A reader who chose the natural voice on an earlier visit gets it again.
    this._natural?.autoUpgrade();
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
    if (e && this._chunks.length) e.setChunks?.(this._chunks);
    // A host assigning its own engine takes the voice out of the toggle's
    // hands; the button must stop claiming the natural voice is speaking.
    if (!this._swapping && this._natural?.state === "on" && e !== this._natural.engine) {
      this._natural.detach();
    }
  }

  /**
   * Spoken-text substitutions: `{ "Theravada": "Terra-vah-dah" }`.
   *
   * Applied to what the engine SAYS, for every engine, and never to what the
   * page shows. Highlighting, events, seek and `position` all keep counting
   * visible words. Whole-word, case-insensitive, multi-word keys allowed,
   * longest key wins (pronunciations.js has the exact rules).
   *
   * Accepts an object, a Map, a JSON string or null. An invalid value is
   * ignored with a console warning and the previous map stays in force: a
   * typo in a pronunciation must never cost a reader their audio. Reading the
   * property returns the entries actually in force, or null.
   */
  get pronunciations() {
    if (!this._pron) return null;
    return Object.fromEntries(this._pron.entries.map((e) => [e.key, e.spoken]));
  }
  set pronunciations(value) {
    this._setPronunciations(value, "property");
  }

  /**
   * Opt-in natural voice. A function returning an engine (or a promise of
   * one), or `{ load, downloadSize }` when the download is not Kokoro's
   * ~80–90 MB. Setting it shows a "Natural voice" button; pressing it loads
   * the engine, swaps it in at the current word and remembers the choice.
   * The component never imports the engine itself: the host's loader does.
   *
   *   el.naturalVoice = async () => {
   *     const { KokoroEngine } = await import("@designesy/read-along/engines/kokoro.js");
   *     return new KokoroEngine({ voice: "af_heart" });
   *   };
   */
  get naturalVoice() { return this._naturalOption; }
  set naturalVoice(option) {
    const load = typeof option === "function" ? option
      : typeof option?.load === "function" ? option.load : null;
    if (option != null && !load) {
      console.warn("read-along: naturalVoice must be a function that returns an engine, or { load, downloadSize }");
      return;
    }
    if (option === this._naturalOption) return;
    if (this._natural) {
      const wasOn = this._natural.state === "on";
      this._natural.destroy();
      this._natural = null;
      if (wasOn) this._swapEngine(this._standardEngine || this._defaultEngine());
    }
    this._naturalOption = option ?? null;
    if (load) {
      this._natural = new NaturalVoice({
        loader: () => load(),
        downloadSize: typeof option.downloadSize === "string" ? option.downloadSize : DEFAULT_DOWNLOAD_SIZE,
        announce: (msg) => this._announce(msg),
        render: (state, info) => this._renderNatural(state, info),
        swap: (engine) => this._swapNatural(engine),
      });
    }
    this._renderNatural(this._natural?.state ?? "off", { downloadSize: this._natural?.downloadSize });
    if (this.isConnected && this._prepared) this._natural?.autoUpgrade();
  }

  play() { this._play(); }
  pause() { this._pause(); }
  toggle() { this._state === "playing" ? this._pause() : this._play(); }
  stop() { this._stop(); }

  /**
   * Seek to a token index and start playing from there (word granularity).
   * No-op while paused — resume first, or stop() then seekToToken().
   * @param {number} i token index (0-based)
   */
  seekToToken(i) {
    this._prepare();
    if (!this._engine || this._state === "paused") return;
    if (i < 0 || i >= this._tokens.length) return;
    this._seekTo(i);
    this._announce(`Playing from word ${i + 1}`);
    this._emitEvent("seek");
  }

  /** Index of the word currently being spoken (-1 when idle). */
  get activeToken() { return this._highlighter ? this._highlighter._markIndex : -1; }

  static get observedAttributes() { return ["lang", "rate", "seekable", "no-inject-styles", "pronunciations"]; }

  attributeChangedCallback(name, _old, value) {
    // no-inject-styles changes whether the rules were adopted, so it must be
    // honoured even before an engine exists.
    if (name === "no-inject-styles") {
      if (value === null) injectHighlightStyles(this.ownerDocument);
      return;
    }
    // Pronunciations are stored before any engine exists and applied when the
    // chunks are built. Removing the attribute (or emptying it) clears them.
    if (name === "pronunciations") {
      this._setPronunciations(value === null || !value.trim() ? null : value, "attribute");
      return;
    }
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
      natural: $("natural"), naturalicon: $("naturalicon"), naturalnote: $("naturalnote"),
      live: $("ra-live"),
    };
    this._els.play.addEventListener("click", () => this.toggle());
    this._els.natural.addEventListener("click", () => this._natural?.toggle());
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
    this._highlighter = new Highlighter(this, {
      forceFallback: this.hasAttribute("force-fallback"),
    });
    this._highlighter.setTokenRanges(buildTokenRanges(this, this._tokens));
    applySpokenViews(this._chunks, this._pron);
    if (this.hasAttribute("seekable")) this._wireSeek();
    if (!this._engine) this.engine = this._defaultEngine();
  }

  _defaultEngine() {
    return new WebSpeechEngine({
      lang: this.getAttribute("lang") || undefined,
      rate: parseFloat(this.getAttribute("rate")) || 1,
    });
  }

  // -- pronunciations --------------------------------------------------------

  _setPronunciations(value, source) {
    let map = value;
    if (typeof value === "string") {
      try {
        map = parsePronunciations(value);
      } catch (err) {
        console.warn(`read-along: ignoring the pronunciations ${source}: ${err.message}`);
        return;
      }
    } else if (value != null && (typeof value !== "object" || Array.isArray(value))) {
      console.warn(
        `read-along: ignoring the pronunciations ${source}: expected an object like {"Theravada": "Terra-vah-dah"}`
      );
      return;
    }
    const compiled = map == null ? null : compilePronunciations(map);
    if (compiled?.skipped.length) {
      console.warn(
        `read-along: skipped pronunciation entries that need a non-empty text key and value: ${compiled.skipped.join(", ")}`
      );
    }
    this._pron = compiled?.size ? compiled : null;
    if (!this._prepared) return; // applied when the chunks are built
    applySpokenViews(this._chunks, this._pron);
    // Same chunk objects, now carrying (or shedding) spoken views. A chunk
    // already being spoken finishes as it started; the next one uses the map.
    this._engine?.setChunks?.(this._chunks);
  }

  // -- natural voice ---------------------------------------------------------

  /** Called by the controller: switch to `engine`, or back when null. */
  _swapNatural(engine) {
    if (engine && this._engine !== engine) this._standardEngine = this._engine;
    return this._swapEngine(engine || this._standardEngine || this._defaultEngine());
  }

  /**
   * Swap engines without losing the reading position. Playing: the new
   * engine continues from the current word. Paused: the next play() resumes
   * from that word. Returns a sentence for the announcement, or "".
   */
  _swapEngine(next) {
    const wasPlaying = this._state === "playing";
    const at = this._state === "idle" ? (this._resumeWord ?? -1) : this._readingWord();
    this._swapping = true;
    try {
      this.engine = next; // stops the old engine if it was speaking
    } finally {
      this._swapping = false;
    }
    if (at < 0) return "";
    if (wasPlaying) {
      this._seekTo(at);
      this._emitEvent("seek");
      return `Continuing from word ${at + 1}.`;
    }
    this._resumeWord = at;
    this._setStatus("Paused");
    return `Press Listen to continue from word ${at + 1}.`;
  }

  /** The word being read right now, from the highlight or the engine. */
  _readingWord() {
    const shown = this.activeToken;
    if (shown >= 0) return shown;
    const pos = this._engine?.position;
    const token = typeof pos === "number" ? pos : (pos?.token ?? -1);
    return token >= 0 ? token : -1;
  }

  _renderNatural(state, info = {}) {
    const { natural, naturalicon, naturalnote } = this._els;
    const offered = !!this._natural;
    natural.hidden = !offered;
    naturalnote.hidden = !offered;
    if (!offered) return;
    // Pressed means CHOSEN: true while loading too, with the note saying how
    // far along the download is. The note is the button's description, so a
    // screen reader hears the state and the reason together.
    natural.setAttribute("aria-pressed", String(state === "loading" || state === "on"));
    naturalicon.setAttribute("d", state === "on" ? ICON_CHECK : ICON_VOICE);
    const size = info.downloadSize || DEFAULT_DOWNLOAD_SIZE;
    naturalnote.textContent =
      state === "on" ? "On, runs on this device"
      : state === "loading" ? (info.pct > 0 ? `Downloading voice model, ${Math.round(info.pct * 100)}%` : "Loading voice model")
      : state === "failed" ? "Could not load, using the standard voice"
      : info.loaded ? "Off, standard voice"
      : `Downloads a voice model once (${size})`;
  }

  // -- click-to-seek ---------------------------------------------------------

  /**
   * When the `seekable` attribute is present, clicks/taps on the host's
   * words restart playback from that word. Word hit-testing reuses the
   * token ranges (a click inside a token's Range owns that token); clicks
   * between words fall to the NEAREST token, so every tap seeks somewhere
   * useful instead of only exact hits.
   */
  _wireSeek() {
    if (this._seekWired) return;
    this._seekWired = true;
    const isInteractive = (el) =>
      el.closest && el.closest("a, button, input, select, textarea, [contenteditable]");
    const handler = (ev) => {
      if (this._state !== "playing") return; // seek only while reading
      if (isInteractive(ev.target)) return;  // never steal link/button clicks
      const i = this._tokenAt(ev);
      if (i >= 0) {
        ev.preventDefault();
        this.seekToToken(i);
      }
    };
    this.addEventListener("pointerdown", handler);
  }

  /** Token index under a pointer event, or nearest if between words. */
  _tokenAt(ev) {
    const host = this;
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(ev.clientX, ev.clientY);
      if (r && host.contains(r.startContainer)) return this._tokenForOffset(r.startContainer, r.startOffset, true);
    } else if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(ev.clientX, ev.clientY);
      if (p && host.contains(p.offsetNode)) return this._tokenForOffset(p.offsetNode, p.offset, true);
    }
    return -1;
  }

  /**
   * Map a (text node, offset) pair to a token index by binary search over
   * the concatenated text. When the offset falls in whitespace (not inside
   * any token), snap to the nearest token.
   */
  _tokenForOffset(node, offset, _snap) {
    // Absolute offset of this node's start within the host's text stream.
    const walker = document.createTreeWalker(this, NodeFilter.SHOW_TEXT);
    let absBase = 0, n = walker.nextNode(), target = null, targetBase = 0;
    while (n !== null) {
      if (n === node) { target = n; targetBase = absBase; break; }
      absBase += n.data.length;
      n = walker.nextNode();
    }
    if (!target) return -1;
    const abs = targetBase + offset;
    // Binary search tokens by [start, end).
    let lo = 0, hi = this._tokens.length - 1, best = -1, bestDist = Infinity;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const t = this._tokens[mid];
      if (abs < t.start) { hi = mid - 1; }
      else if (abs >= t.end) { lo = mid + 1; }
      else return t.index; // inside a word
      // Track nearest edge for the whitespace-snap fallback.
      const d = Math.min(Math.abs(abs - t.start), Math.abs(abs - t.end));
      if (d < bestDist) { bestDist = d; best = t.index; }
    }
    return best; // between words → nearest
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
    // Every engine calls onEnd from stop() as well as at a natural end. _stop()
    // goes idle BEFORE stopping the engine, and a swapped-out engine is no
    // longer this._engine, so either condition means "stopped", not "finished".
    // Without this, Restart, the one-voice handoff and every voice swap told a
    // screen reader "Finished reading" and fired `done` ahead of `stop`.
    e.onEnd = () => {
      if (this._engine !== e || this._state === "idle") return;
      this._finish();
    };
    e.onError = (err) => {
      this._announce(`Read-along error: ${err.message}`);
      this._setStatus("Error");
      this._setPlayingUi(false);
      this._state = "idle";
    };
    e.onMode = (mode) => {
      if (mode !== "visual") return;
      this._setStatus("Visual mode — no voices");
      this._announce("No speech voices are available in this browser. Following the words without sound.");
    };
    if (this._chunks.length) e.setChunks?.(this._chunks);
  }

  _play() {
    this._prepare();
    if (!this._engine) return;
    // One-voice policy: starting this player stops any other on the page.
    for (const other of ACTIVE) if (other !== this) other.stop();
    ACTIVE.add(this);
    if (this._state === "paused") {
      this._state = "playing";
      this._engine.resume();
      this._setPlayingUi(true);
      this._emitEvent("play"); // resumed
      return;
    }
    if (this._state === "playing") return;
    if (!this._chunks.length) return;
    // After an engine swap while paused, pick up where the reader left off.
    const from = this._resumeWord ?? 0;
    this._resumeWord = null;
    this._state = "playing";
    this._bindEngine();
    this._engine.rate = parseFloat(this._els.speed.value) || 1;
    this._engine.speak(this._chunks, from);
    this._setPlayingUi(true);
    this._announce(from > 0 ? `Playing from word ${from + 1}` : "Playing, automated voice");
    this._emitEvent("play");
  }

  /**
   * Start the engine at word i. The one-voice policy applies: seeking is
   * playing, so it stops any other player and registers this one. Before,
   * a click-to-seek left the player out of ACTIVE, and the next player
   * started speaking over it.
   */
  _seekTo(i) {
    this._stop();
    for (const other of ACTIVE) if (other !== this) other.stop();
    ACTIVE.add(this);
    this._state = "playing";
    this._bindEngine();
    this._engine.rate = parseFloat(this._els.speed.value) || 1;
    this._engine.speak(this._chunks, i);
    this._setPlayingUi(true);
  }

  _pause() {
    if (this._state !== "playing") return;
    this._state = "paused";
    this._engine.pause();
    this._setPlayingUi(false);
    this._announce("Paused");
    this._emitEvent("pause");
  }

  _stop() {
    ACTIVE.delete(this);
    this._resumeWord = null;
    if (this._state === "idle") return;
    const wasEngine = this._engine;
    this._state = "idle";
    wasEngine?.stop?.();
    this._highlighter?.clear();
    this._setPlayingUi(false);
    this._setStatus("Ready");
    this._emitEvent("stop");
  }

  _finish() {
    ACTIVE.delete(this);
    this._state = "idle";
    this._highlighter?.clear();
    this._setPlayingUi(false);
    this._setStatus("Done");
    this._announce("Finished reading");
    this._emitEvent("done");
  }

  /**
   * Hosts (e.g. an external-clock bridge) listen to these to stay in sync.
   *
   * `detail.token` is ALWAYS the word index, whichever engine is in use.
   *
   * The engines do not agree on what `position` returns: ExternalEngine returns
   * a bare number (it only tracks a word), while WebSpeech, Media and Kokoro
   * return `{ chunk, token }`. Emitting that value directly — which this did —
   * meant a host reading `detail.token` got a number from one engine and an
   * object from the other three. Found by writing the type definitions, which
   * could not describe both shapes under one property.
   *
   * The component owns its event contract, so it normalises here rather than
   * making every host branch on the engine. `detail.position` carries the
   * engine's own value unchanged, for a host that wants the extra detail.
   */
  _emitEvent(name) {
    const pos = this._engine?.position;
    const token = typeof pos === 'number' ? pos : (pos?.token ?? -1);
    this.dispatchEvent(
      new CustomEvent(name, { bubbles: true, detail: { token, position: pos } })
    );
  }

  // -- UI helpers ----------------------------------------------------------

  _setPlayingUi(on) {
    this._els.play.setAttribute("aria-pressed", String(on));
    this._els.playicon.setAttribute("d", on ? ICON_PAUSE : ICON_PLAY);
    this._els.playlabel.textContent = on ? "Pause" : "Listen";
    this._setStatus(on ? "Playing" : "Paused");
  }

  _setStatus(msg) { this._els.status.textContent = msg; }

  /**
   * Announce a status message to assistive technology.
   *
   * The rule lives in announce.js so it can be unit-tested (this module cannot
   * be imported outside a browser). The short version: an identical repeat
   * needs the clear and the set in DIFFERENT tasks — same-task writes are
   * coalesced into no net change and a screen reader stays silent. Measured
   * 2026-10-02, Chrome 153 + NVDA 2026.2.
   *
   * The sequence token stops a pending repeat from overwriting a newer
   * message: only the most recent call may complete its scheduled write.
   */
  _announce(msg) {
    announceTo(
      this._els.live,
      msg,
      {
        nextSeq: () => (this._announceSeq = (this._announceSeq || 0) + 1),
        isCurrent: (seq) => this._announceSeq === seq,
      }
    );
  }
}

if (!customElements.get("read-along")) {
  customElements.define("read-along", ReadAlong);
}

export { ReadAlong, WebSpeechEngine, tokenize, chunkTokens, Highlighter, buildTokenRanges, supportsHighlightAPI };
export { compilePronunciations, spokenChunk, applyPronunciations } from "./pronunciations.js";