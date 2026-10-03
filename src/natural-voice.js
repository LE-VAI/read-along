/**
 * natural-voice.js — the opt-in "Natural voice" upgrade, without the DOM.
 *
 * Web Speech stays the default: it is free, instant and already on the
 * device. A neural voice (Kokoro, af_heart) sounds far better but costs a
 * one-time download of roughly 80–90 MB, so it is never fetched unasked. The
 * host opts in by giving the component a LOADER — a function returning an
 * engine — which keeps kokoro-js out of the zero-dependency core entirely.
 * The reader opts in by pressing the button, and the choice is remembered.
 *
 * This module owns the decisions; the component owns the pixels. It decides
 * when to load, what to announce, what to remember and when to swap engines,
 * and reports through four callbacks (announce, render, swap, storage). That
 * split is what lets every branch below be tested in plain Node.
 *
 * States: "off" → "loading" → "on", or "loading" → "failed" (which renders
 * as off, with the reason). Pressing during "loading" cancels: the download
 * cannot be aborted, but the swap is, and the opt-in is forgotten.
 *
 * Storage is wrapped at every touch. localStorage THROWS in sandboxed
 * iframes, with site data blocked, and in some private modes — and merely
 * reading the property can throw too. A preference must never be the reason
 * the component fails to load.
 */

export const NATURAL_VOICE_STORAGE_KEY = "read-along:natural-voice";

/** What the button discloses before anything is downloaded. */
export const DEFAULT_DOWNLOAD_SIZE = "about 80–90 MB";

/** localStorage, or null where touching it throws. */
export function safeStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

/** True when the reader opted in on an earlier visit. */
export function readOptIn(storage) {
  try {
    return storage?.getItem(NATURAL_VOICE_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

/** Remember (or forget) the opt-in. Never throws. */
export function writeOptIn(storage, on) {
  try {
    if (on) storage?.setItem(NATURAL_VOICE_STORAGE_KEY, "on");
    else storage?.removeItem(NATURAL_VOICE_STORAGE_KEY);
  } catch {
    /* storage unavailable — the choice lasts for this page only */
  }
}

/** The engine contract's lifecycle methods — anything less is not an engine. */
function isEngine(e) {
  return !!e && ["speak", "pause", "resume", "stop"].every((m) => typeof e[m] === "function");
}

export class NaturalVoice {
  /**
   * @param {object} o
   * @param {() => object|Promise<object>} o.loader returns the engine
   * @param {(msg: string) => void} o.announce polite live-region message
   * @param {(state: string, info: object) => void} o.render update the control
   * @param {(engine: object|null) => string} o.swap switch to `engine` (null =
   *   back to the standard voice) and return a sentence about the reading
   *   position for the announcement, or ""
   * @param {() => object|null} [o.storage] storage provider
   * @param {string} [o.downloadSize] human size for the disclosure
   */
  constructor({ loader, announce, render, swap, storage = safeStorage, downloadSize = DEFAULT_DOWNLOAD_SIZE }) {
    this._loader = loader;
    this._announce = announce;
    this._render = render;
    this._swap = swap;
    this._storage = storage;
    this.downloadSize = downloadSize;
    this._state = "off";
    this._engine = null;
    this._gen = 0;
    this._step = 0; // last announced quarter of the download
    this._autoTried = false;
    this._destroyed = false;
  }

  /** "off" | "loading" | "on" | "failed" */
  get state() { return this._state; }

  /** The loaded engine, once a load has succeeded (kept for instant re-enable). */
  get engine() { return this._engine; }

  /** True when the reader opted in on an earlier visit. */
  get remembered() { return readOptIn(this._storage()); }

  toggle() {
    if (this._state === "loading" || this._state === "on") this.disable();
    else this.enable();
  }

  /**
   * On a later visit, a remembered opt-in upgrades by itself — once per
   * controller, however many times the element is re-connected.
   */
  autoUpgrade() {
    if (this._autoTried || this._destroyed || this._state !== "off") return;
    this._autoTried = true;
    if (this.remembered) this.enable({ remembered: true });
  }

  /**
   * Load (if needed) and switch to the natural voice.
   *
   * A REMEMBERED upgrade happens at page load, so it stays quiet unless it
   * has something the reader needs: a failure, or a swap that moved the
   * reading position. A pressed button narrates the download, because the
   * reader asked for it and is waiting on it.
   *
   * @param {{remembered?: boolean}} [opts]
   */
  async enable({ remembered = false } = {}) {
    if (this._destroyed || this._state === "loading" || this._state === "on") return;
    writeOptIn(this._storage(), true);

    if (this._engine) {
      // Loaded earlier this session: no download, just swap back.
      this._state = "on";
      this._emit();
      this._announce(joinSentences("Natural voice on.", this._swap(this._engine)));
      return;
    }

    const gen = ++this._gen;
    this._state = "loading";
    this._step = 0;
    this._emit();
    if (!remembered) {
      this._announce(
        `Downloading the natural voice, ${this.downloadSize}, once. ` +
        "The standard voice keeps reading meanwhile."
      );
    }

    let engine;
    try {
      engine = await this._loader();
      if (!isEngine(engine)) {
        throw new TypeError("naturalVoice did not return an engine (speak, pause, resume, stop)");
      }
      if (typeof engine.load === "function") {
        const hostProgress = engine.onProgress;
        engine.onProgress = (pct, label) => {
          hostProgress?.call(engine, pct, label);
          if (gen === this._gen) this._progress(pct, remembered);
        };
        await engine.load();
      }
    } catch (err) {
      if (gen !== this._gen) return; // cancelled meanwhile — nothing to report
      console.warn("read-along: the natural voice could not be loaded —", err);
      // A failed load is not remembered: the next visit starts on the
      // standard voice instead of re-downloading into the same failure.
      writeOptIn(this._storage(), false);
      this._state = "failed";
      this._emit();
      this._announce("The natural voice could not be loaded. The standard voice is reading.");
      return;
    }

    if (this._destroyed) return;
    this._engine = engine; // kept even if cancelled: re-enabling is then instant
    if (gen !== this._gen) return;
    this._state = "on";
    this._emit();
    const where = this._swap(engine);
    if (!remembered || where) this._announce(joinSentences("Natural voice on.", where));
  }

  /** Back to the standard voice, or cancel a load in progress. */
  disable() {
    if (this._destroyed) return;
    if (this._state === "loading") {
      this._gen++; // the pending load will finish but not swap
      this._state = "off";
      writeOptIn(this._storage(), false);
      this._emit();
      this._announce("Natural voice cancelled. The standard voice stays.");
      return;
    }
    if (this._state !== "on") return;
    this._state = "off";
    writeOptIn(this._storage(), false);
    this._emit();
    this._announce(joinSentences("Standard voice on.", this._swap(null)));
  }

  /**
   * The host assigned its own engine while the natural voice was on. The
   * toggle no longer describes what is speaking, so it shows off — without
   * swapping anything back and without touching the reader's saved choice.
   */
  detach() {
    if (this._state !== "on") return;
    this._state = "off";
    this._emit();
  }

  /** The host removed the loader: forget pending work, never call back again. */
  destroy() {
    this._gen++;
    this._destroyed = true;
    this._state = "off";
  }

  // -- internals -----------------------------------------------------------

  _progress(pct, remembered) {
    if (this._state !== "loading" || !(pct >= 0)) return;
    this._emit({ pct: Math.min(pct, 1) });
    // Narrate in quarters, never per event: a screen reader fed every
    // progress tick would talk over the reading the whole time.
    const step = Math.floor(Math.min(pct, 0.99) * 4);
    if (!remembered && step > this._step) {
      this._step = step;
      this._announce(`Natural voice ${step * 25} percent downloaded.`);
    }
  }

  _emit(info = {}) {
    this._render(this._state, {
      downloadSize: this.downloadSize,
      loaded: !!this._engine,
      ...info,
    });
  }
}

function joinSentences(a, b) {
  return b ? `${a} ${b}` : a;
}
