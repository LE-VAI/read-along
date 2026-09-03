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

- **Zero dependencies**, ~5 kB unminified, MIT license.
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
- **Pluggable engines.** Ships with Web Speech (default) and a
  pre-synthesized-media engine (build-time TTS + JSON timing manifest —
  Piper/kokoro/cloud batch outputs all fit). Bring any engine implementing
  `speak/pause/resume/stop/setChunks` + `onToken` callbacks.
- **Accessible controls.** Real buttons, `aria-pressed`, visible focus,
  polite live announcements, keyboard operable end to end.

## Install (once published)

```bash
npm install read-along
```

or vendor the files — it's dependency-free ES modules.

## Attributes

| Attribute | Default | Purpose |
|---|---|---|
| `lang` | page language | BCP-47 tag passed to the speech engine |
| `rate` | `1` | initial speaking rate |
| `force-fallback` | off | skip the CSS Custom Highlight API and wrap the active word in a `<mark>` element instead — for engines that expose the highlight registry but never paint it (undetectable programmatically), or when you want maximum-render-compatibility certainty |

The word highlight is page-global: all `<read-along>` elements share one
`Highlight` registry entry per name, so multiple instances on a page
coexist correctly (each contributes and removes only the Ranges it owns).

## Controls

- `play()` / `pause()` / `stop()` / `toggle()`
- `engine` property — swap in your own engine before first play
- `state` — `"idle" | "playing" | "paused"`

## Custom engines

Anything with this shape works — WASM neural TTS, pre-synthesized audio, a
remote service, or a lab prototype:

```js
class MyEngine {
  setChunks(chunks) {}
  speak(chunks, startChunk = 0) { /* call onToken(i) as words start */ }
  pause() {}
  resume() {}
  stop() {}
}
readAlongEl.engine = new MyEngine();
```

The engine contract and token/chunk formats live in `src/tokenizer.js` and
`src/engines/*.js`.

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

v0 — core engine, highlight layer, both engines, demo. Roadmap: sentence
click-to-seek, per-token click-to-play-from, kokoro-js engine package,
tests, npm publish. Not yet production-hardened; verify on your target
browsers.

## License

MIT © 2026 Le Vain Bey