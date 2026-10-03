# Changelog

All notable changes to `@designesy/read-along`. Releases before 0.3.0 are
described in the git history.

## [0.3.0] — unreleased

### Added

- **`pronunciations`**: spoken-text substitutions, as a JSON attribute or a
  property (object, Map or JSON string), e.g. `{"Theravada": "Terra-vah-dah"}`.
  They apply to what every engine says, never to the visible text. Highlighting
  and every public word index (events, `seekToToken`, `activeToken`, `position`)
  stay on the visible words. Matching is whole-word and case-insensitive, allows
  multi-word keys, and the longest key wins. Invalid JSON is ignored with a
  console warning and never stops playback.
- **`pronunciations.js`** export: the same mapping for build steps that
  pre-synthesize audio, and for custom engines (`compilePronunciations`,
  `spokenChunk`, `applySpokenViews`, `applyPronunciations`, `spokenText`,
  `spokenTokenAt`, `sliceChunk`, …). `wordTimingsFromChunk` times words over the
  spoken text when a chunk carries a spoken view. `ExternalEngine.chunks`
  exposes those views to host bridges.
- **`naturalVoice`**: an opt-in neural voice. The host supplies a loader that
  returns an engine, so the core never imports kokoro-js. The component shows a
  "Natural voice" toggle (`aria-pressed`, visible focus) that discloses the
  one-time ~80–90 MB download. It narrates progress through the live region in
  quarters, swaps engines at the current word, and remembers the choice. On a
  load failure it falls back to Web Speech and says so.
- **`read-along-verify`** CLI: synthesizes a script with Kokoro, transcribes it
  back with Whisper, and control-tests every mismatch with the OS voice (Windows
  SAPI, macOS `say`, espeak-ng). Each finding is classified as
  `synthesis-defect`, `transcription-artifact`, `inconclusive` or `unconfirmed`.
  `--pronunciations` checks that each fixed word comes back as written. Also
  takes `--json`, `--voice`, `--model` and `--dtype`.
- `kokoro-js` and `@huggingface/transformers` are declared as optional peer
  dependencies. The core is still dependency-free.
- `KokoroEngine.load()` reports real download progress through `onProgress`.

### Fixed

- **A repeated identical announcement was silent.** The live region cleared and
  re-set in the same task; Chromium coalesces two same-task writes into no net
  change, so a screen reader saw no mutation and stayed quiet on the repeat. A
  pause/resume cycle ("Paused" twice) or a seek to the same word announced only
  once. The clear now lands in one task and the re-set in a later one (~60 ms),
  with a sequence token so a pending repeat can never overwrite a newer message.
  Measured with the NVDA Speech Viewer as the judge: same-task produced 1
  announcement for 2 identical calls, a split produced 2 in both test orders.
  Found during the 2026-10-02 manual pass; the test page's light-DOM baseline
  button carried the same bug and is fixed with it.
- **Stopping no longer says "Finished reading".** Every engine calls `onEnd`
  from `stop()` as well as at a natural end, and the component treated both as
  a finish. Restart, the one-voice handoff and every voice swap announced
  "Finished reading" to screen readers and fired `done` ahead of `stop`. Now
  `done` and the announcement mean the text was actually read to the end.
- **Contrast (WCAG 2.2 AA, axe `color-contrast`, serious).** The status text
  forced `CanvasText` at 75% opacity, which on a dark host page without
  `color-scheme` was near-black on near-black (measured 1.15:1). Loose text now
  inherits the host's text colour at full strength. The shadow styles no longer
  use any opacity, translucent colour or `color-mix()`: control borders are
  solid `CanvasText`, and the pressed state is a heavier ring plus a label or
  icon change. axe 4.13.0 reports zero violations on light and dark hosts, while
  idle, playing (including the `<mark>` fallback) and downloading.
- `KokoroEngine` ignored the speed control: `rate` now maps to `speed`.
- `seekToToken` (and click-to-seek) bypassed the one-voice policy, so another
  player could start speaking over a seeked one.
- A `pronunciations` or `naturalVoice` value assigned before the element
  upgraded is now applied rather than shadowed.

### Changed

- `KokoroEngine`'s audio cache is keyed on the spoken text, so changing a
  pronunciation re-synthesizes instead of replaying the old audio.
- The core import chain is larger (README has the measured numbers). Most of
  the growth is comments, which a minifier removes.
