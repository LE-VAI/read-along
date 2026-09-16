# read-along

An embeddable, engine-agnostic web component for **bimodal reading**:
karaoke-style word highlighting synchronized to spoken audio, for the open web.

Wrap it around any content. Press Listen. The words light up as they're read.

```html
<script type="module" src="read-along.js"></script>

<read-along>
  <p>Any content. Any <em>inline markup</em>. Your links stay clickable,
  your styles stay yours — the highlight paints over the text without
  touching the DOM.</p>
</read-along>
```

## Why

- **Evidence-backed.** Bimodal (listen-while-read) presentation measurably
  improves comprehension for readers with dyslexia and other reading
  disabilities — strongest when highlighting follows the voice word-by-word
  (Wood et al. 2017 meta-analysis). Word-level and sentence-level
  highlighting are both provided: karaoke word tracking over a soft sentence
  tint, since research treats granularity as a user preference
  (w3c/epub-specs#2917). Yet no embeddable, open-source read-along component
  exists for the web. This is that missing primitive.
- **For everyone.** Dyslexic readers, language learners, low-vision readers,
  tired commuters, cooks with flour on their hands.
- **Local-first.** Speech runs in the browser. Nothing is sent anywhere by
  default.

## How this relates to prior art (honest table)

| | read-along | `@liiift-studio/speechtype` | MS Immersive Reader | ReadSpeaker / NaturalReader |
|---|---|---|---|---|
| Open source | ✅ MIT | ✅ MIT | ❌ Azure commercial | ❌ subscription |
| Embeddable web component | ✅ | ⚠️ React/vanilla functions | ⚠️ Azure SDK | ⚠️ embed script |
| Engine-agnostic | ✅ pluggable | ❌ Web Speech only | ❌ | ❌ |
| Sync when `boundary` events don't fire | ✅ interpolation fallback | ❌ ("text simply stays un-emphasised") | — | — |
| Markup-safe highlighting | ✅ Range-based (Highlight API) | ❌ span-wrapping, flattens markup | — | — |

`speechtype` is the closest open prior art and a genuinely nice piece — its
README honestly documents the Safari boundary-event gap that read-along's
interpolation fallback exists to close. The abandoned `readalong` npm
package (2018) played pre-aligned audio files; not TTS, not embeddable.
Everything else in the space is commercial.

## Features

- **Zero dependencies**, MIT license. The core import chain
  (`read-along.js` + `tokenizer.js` + `highlight.js` + `engines/webspeech.js`)
  measures **~12.1 kB gzipped** (38.5 kB raw). Measure for yourself with a
  bundler analyser rather than trusting a number in a README — including this
  one, which previously said "~5 kB" and was simply wrong.
- **Markup-safe highlighting** via the CSS Custom Highlight API (`Highlight`
  + `::highlight()`), with a graceful `<mark>` fallback. Your content's DOM
  is never re-wrapped on the modern path.
- **Chrome's 15-second speech bug defeated.** Desktop Chrome's speech engine
  watchdog kills long utterances (a bug open for years, ~200–250 chars).
  read-along speaks in sentence-bounded chunks that stay under the cap,
  plus a desktop-only keep-alive (skipped on Android, where it breaks
  synthesis).
- **Robust word sync.** Locks onto `onboundary` events when the engine
  provides them; falls back to char-proportional interpolation when it
  doesn't (remote voices, Firefox).
- **Never a silent dead end.** Browsers that expose `speechSynthesis` with
  zero voices (common in embedded/webview browsers) get detected by a stall
  watchdog and the component switches to visual-only mode — karaoke word
  pacing without sound, announced to screen readers, instead of hanging on
  "Playing" forever.
- **One-voice policy.** Starting one `<read-along>` stops any other
  currently playing on the page.
- **Word-level seek.** `seekToToken(i)` (or the `seekable` attribute — click
  any word mid-read) restarts playback at an exact word, in every engine.
- **External clock.** An engine that renders-only: a host process outside
  the browser supplies word timings and ticks the clock — the bridge
  contract for desktop readers and assistive controllers.
- **Theming.** `--ra-highlight` / `--ra-accent` CSS custom properties set
  the highlight color per page or per instance (plain `rgb()` values —
  exotic color functions risk silent drops in hostile engines).
- **Pluggable engines.** Ships with Web Speech (default), a
  pre-synthesized-media engine (build-time TTS + JSON timing manifest —
  Piper/kokoro/cloud batch outputs all fit), a local neural voice (Kokoro),
  and the external-clock engine. Bring any engine implementing
  `speak/pause/resume/stop/setChunks` + `onToken` callbacks.
- **Accessible controls.** Real buttons, `aria-pressed`, visible focus,
  polite live announcements, keyboard operable end to end.

## Install

```bash
npm install @designesy/read-along
```

or vendor the files — it's dependency-free ES modules.

## Attributes

| Attribute | Default | Purpose |
|---|---|---|
| `lang` | page language | BCP-47 tag passed to the speech engine |
| `rate` | `1` | initial speaking rate |
| `seekable` | off | clicking/tapping a word while playing restarts the reading from that word (never steals clicks on links/buttons) |
| `force-fallback` | off | skip the CSS Custom Highlight API and wrap the active word in a `<mark>` element instead — for engines that expose the highlight registry but never paint it (undetectable programmatically), or when you want maximum-render-compatibility certainty |

The word highlight is page-global: all `<read-along>` elements share one
`Highlight` registry entry per name, so multiple instances on a page
coexist correctly (each contributes and removes only the Ranges it owns).

## Controls

- `play()` / `pause()` / `stop()` / `toggle()`
- `seekToToken(i)` — start playing from word *i* (0-based)
- `activeToken` — index of the word currently spoken (-1 when idle)
- `engine` property — swap in your own engine before first play
- `state` — `"idle" | "playing" | "paused"`
- events: `play` / `pause` / `stop` / `done` / `seek` (bubbles). `detail.token`
  is **always a word index, whichever engine is in use** — the component
  normalises it, because the engines do not agree on what `position` returns
  (`ExternalEngine` gives a bare number, the others give `{ chunk, token }`).
  `detail.position` carries the engine's own value unchanged if you want it.
  Hosts driving an external clock use these to anchor their own timers.

## Custom engines

Anything with this shape works — WASM neural TTS, pre-synthesized audio, a
remote service, or a lab prototype:

```js
class MyEngine {
  setChunks(chunks) {}
  speak(chunks, startWord = 0) { /* call onToken(i) as words start */ }
  pause() {}
  resume() {}
  stop() {}
}
readAlongEl.engine = new MyEngine();
```

`startWord` is a global token index — seek lands on the exact word, not the
containing chunk.

The engine contract and token/chunk formats live in `src/tokenizer.js` and
`src/engines/*.js`.

## External clock (host-driven highlighting)

`src/engines/external.js` — render-only mode: the host owns the audio and the
clock, the component just highlights. This is the bridge contract for
non-browser speech systems:

- a **desktop reader daemon** (e.g. a Piper TTS process) streaming word
  timings while it plays audio itself
- an **assistive/BCI controller** that knows the reading position and needs
  a text surface to mirror it
- **build-time timings with no audio at all** — silent visual karaoke

```js
import { ExternalEngine } from "@designesy/read-along/engines/external.js";
const engine = new ExternalEngine({ words: [] }); // [tokenIndex, startMs, endMs]
el.engine = engine;
el.play();
engine.setWords([[0, 0, 260], [1, 260, 520], /* … */]); // whenever ready
engine.tick(1234); // host heartbeat: elapsed playback ms
```

Semantics: `tick()` advances the word pointer (monotonic; jumps larger than
a word are followed, so a host restarting earlier works too). If the host
goes silent for >250 ms the engine falls back to real time — a dead bridge
never freezes the karaoke. `setWords()` can arrive late and grow during
playback (progressive synthesis). `speak(chunks, startWord)` starts at any
word. Pause freezes everything until `resume()`.

Timings format matches the MediaEngine manifest (`[tokenIndex, startMs,
endMs]`) — one producer can feed both engines.

## Local neural voice (Kokoro)

`src/engines/kokoro.js` is an optional engine that runs the
[Kokoro-82M](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX)
neural voice (via [kokoro-js](https://www.npmjs.com/package/kokoro-js))
entirely in the browser — real voices on any tab, including embedded
browsers whose Web Speech has none.

```js
import { KokoroEngine } from "@designesy/read-along/engines/kokoro.js"; // (or vendor the file)
const engine = new KokoroEngine({ voice: "af_heart" }); // af_bella, am_michael, …
await engine.load();          // optional: preload the ~80 MB model (q8)
el.engine = engine;           // else it loads on first play
```

Honest notes:

- **Timing.** The public ONNX export does not expose the model's native
  word alignment (Python `KPipeline` has it; the ONNX graph itself does
  not). The engine distributes each chunk's *measured* audio duration
  across its characters — real durations, sentence-bounded error — and
  drives the highlight from the `AudioContext` sample clock, not wall-clock
  guessing. Pause is sample-accurate (`AudioContext.suspend()` freezes the
  clock; resume continues from the exact sample).
- **Cost.** First load downloads ~80 MB (q8) and compiles WASM — expect
  ~30–60 s on a cold cache, seconds warm. Synthesis is cached per chunk
  (restart/seek is instant) and pipelined one chunk ahead.
- **Demo wiring.** kokoro-js's ESM dist statically imports the Node
  built-ins `path` and `fs/promises`, which browsers can't resolve — an
  import map must stub both (see `demo/index.html`). And in the browser,
  transformers.js accepts only `wasm`/`webgpu` devices — `"cpu"` is a
  Node-only device name (the engine translates it).
- This engine pulls in `kokoro-js` as a dependency, so it lives outside
  the zero-dependency core; the component itself never imports it.

## Engine notes (Web Speech, 2026)

- Desktop Chrome truncates long utterances (~15 s watchdog, ~200–250 chars;
  [chromium:41294170](https://issues.chromium.org/issues/41294170)) — handled
  by sentence-bounded chunking (every utterance under the cap), plus a
  desktop-only pause/resume keep-alive (the keep-alive is skipped on Android,
  where it breaks synthesis).
- `onboundary` is an optimization, not a sync source: it doesn't fire for
  remote voices (Chromium 41195426), fails on Chrome Android, fires sparsely
  on Safari, and iOS effectively never — read-along falls back to
  char-proportional interpolation whenever boundaries stay silent.
- Voices load async (`voiceschanged`); first `getVoices()` may be empty —
  handled. Pick a voice explicitly via `engine.voiceName` if it matters.
- iOS requires `speak()` inside a user gesture — playing from the Listen
  button satisfies this; don't call `play()` from timers on iOS.
- The Web Speech spec is actively maintained under the Web Audio CG (draft
  dated 2026-08-10); read-along tracks it conservatively.

## Browser support

- **Highlighting:** CSS Custom Highlight API is Baseline 2025 (Chrome/Edge
  105+, Safari 17.2+, Firefox 140+). Older engines get the `<mark>` fallback.
- **Speech:** Web Speech synthesis is available in all desktop evergreen
  browsers; Firefox for Android lacks it entirely — that's what the pluggable
  engine slot is for (kokoro-js / Piper WASM / pre-synthesized media all fit
  the same contract).

## Accessibility

- Real `<button>`s (≥ 30×30 px targets — WCAG 2.5.8 needs 24×24), visible
  focus (2.4.7), full keyboard operability (2.1.1).
- Polite `aria-live` region for state changes (4.1.3): announces
  play/pause/finish — deliberately NOT per-word (per-word announcements
  flood screen readers; sentence-boundary announcing is the considerate
  pattern).
- The Highlight API paints carry no semantic meaning (MDN) — visual karaoke
  is decoration; the semantic channel is the live region + natural DOM order
  (1.3.2), which the Range-based approach never disturbs.

## Status

**Published.** `@designesy/read-along@0.1.4` on npm, MIT, 45 tests, CI green on
Node 18/20/22. Core engine, highlight layer, four engines (Web Speech, media,
Kokoro, external clock), word-level seek + click-to-seek, CSS-var theming,
live demos.

### Integrating it into a server-rendered app — read this first

**The module cannot be imported in any server context.** It builds its template
and calls `customElements.define()` at module top level, so a static import in
a Node/prerender environment throws `ReferenceError: document is not defined`.
Verified. This means:

- **Client Components are still prerendered on the server**, so a *static*
  import inside a `'use client'` file fails at build time too.
- Register it with a **dynamic `import()` inside `useEffect`**, or
  `next/dynamic` with `ssr: false` — and `ssr: false` only works inside a
  Client Component.
- Render the **tag and its children** server-side; never the module. The
  children are plain HTML and read fine before upgrade, so progressive
  enhancement works by construction.

**The stylesheet is opt-in and separate.** `src/read-along.css` carries the
`::highlight()` rules and must be linked (or imported) by the page. Without it
the karaoke highlight paints nothing, silently — there is no error, because the
component injects no styles itself and therefore cannot notice their absence.

Import it by its **published specifier**, not by the path inside the package:

```js
import "@designesy/read-along/read-along.css";
```

**Do not write `@designesy/read-along/src/read-along.css`.** This package uses an
`exports` map, which gates every subpath: a path not listed there is unimportable
even though the file ships in the tarball. Until 0.1.4 the map listed only the JS
entry points, so the CSS was published but **unreachable** — `require.resolve`
returned `ERR_PACKAGE_PATH_NOT_EXPORTED`, and an integration written against the
path failed at resolver time while looking correct. On 0.1.3 or earlier, upgrade
or copy the file into your own tree.

`scripts/audit-exports.py` guards that class of defect: it compares the `files`
list against the `exports` map and reports anything shipped but unimportable.

**Add `read-along { display: block }` in your own CSS.** The element is
inline-level before upgrade and `display: block` after, so without this the
player's appearance shifts layout.

## License

MIT © 2026 Le Vain Bey