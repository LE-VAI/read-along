# Screen reader verification — read-along live region

**Status: VERIFIED — all six checks passed.** 2026-09-22 16:29 EDT (Tuesday).

The claim under test: the component announces its state through an
`aria-live="polite"` region inside a shadow root, and a *repeated identical*
message re-announces rather than going silent.

Both halves now hold under a real screen reader, not just under inspection.

---

## Run — 2026-09-22

**Environment:** NVDA 2026.2.0.57664 (installed via winget as NVAccess.NVDA
2026.1.1, self-updated to 2026.2.0), Brave / Chromium 153.0.8010.36,
Windows 11 (build 10.0.26200).

**Method:** NVDA's **Speech Viewer** was used, so each announcement was read as
text in a log rather than judged by ear. A message either appeared there or it
did not. The six checks in `demo/at-test.html` were run in order.

**Result: all 6 checks passed.**

| # | Check | Verdict |
|---|---|---|
| 1 | Play announces | PASS — heard it |
| 2 | Repeated message re-announces | PASS — all three announced, including the second identical "Paused" |
| 3 | Completion announces | PASS — heard it |
| 4 | Restart announces exactly once | PASS — once, correct |
| 5 | Speed change keeps sync | PASS — changed cleanly |
| 6 | Controls reachable and named | PASS — all reachable, all named |

**The light-DOM baseline was not needed.** It exists to attribute a *failure*:
if the component's region had been silent and the baseline had announced, the
shadow root would have been conclusively the cause. With no failure there was
nothing to attribute. The baseline button remains on the page for the next run.

**Notes:** none recorded beyond the verdicts. No stray announcements, no
truncated words, no double-fires.

**What this establishes:** the shadow-root live region IS announced by NVDA, and
a repeated identical message DOES re-announce. The `clear-then-set` in
`_announce()` — which forces a DOM mutation when the same string is assigned
twice — is doing the job it was written for, in a real screen reader, on a real
pause/resume cycle.

**What it does not establish:** that every screen reader behaves this way. This
is one screen reader on one browser on one platform. NVDA + Chromium is the
most-used combination among Windows screen-reader users, so it is the highest-
value single data point, but JAWS, Narrator, and VoiceOver are untested and are
not implied by this result. The specific risk — a screen reader that does not
traverse shadow roots when observing live regions — is a per-implementation
behaviour, and the shadow root is the part most likely to differ between them.

---

## What was already verified by execution

Listed separately, because these were never part of the manual test and do not
need re-testing:

- `<read-along>` upgrades to the `ReadAlong` class; the shadow root is created.
- `#ra-live` carries `aria-live="polite"` and is visually hidden
  (`clip-path: inset(50%)`, 1px).
- The three controls are reachable and named ("Listen", "Restart from the
  beginning", "Reading speed").
- `_announce()` forces a real DOM mutation on an identical repeat — measured
  with a MutationObserver: a second identical call produced a mutation, not a
  no-op. This is the mechanism; the manual run above is the proof it reaches a
  user.

---

## Why this file exists rather than a pass/fail note in the README

The failure mode it guards against is documenting an accessibility feature from
the spec instead of from use. "The live region is correctly marked up" and "a
blind user hears the status" are different claims, and only the first is
verifiable by reading code. A package whose entire purpose is access should not
ship the second claim on the strength of the first.

That distinction is what made this file say NOT YET RUN before the test, and
what makes it worth keeping now that it says VERIFIED: the record states the
environment, so a future reader can tell what was actually measured rather than
what was assumed.

Related: `docs/AT-TEST-STEPS.md`, `src/read-along.js` (`_announce`).

---

## Run — 2026-10-02 (automated, NVDA Speech Viewer as the instrument)

**Environment:** NVDA 2026.2.0.57664, Chrome 153.0.8010.54, Windows 11 (build 10.0.26200).
**Method:** the component was driven programmatically (real control activation over CDP) while NVDA's
**Speech Viewer** was read as text cross-process via `WM_GETTEXT` on its RICHEDIT control. This
removes the ear-judgement from every step: an announcement is a line in the log, or it is not.

**Result: 1 real defect found, root-caused, fixed, and re-verified live.**

### The defect — the repeat announced only once

`sources/read-along.js` `_announce()` cleared the live region and re-set it **in the same task**.
Chromium coalesces those two writes into no net change, so NVDA saw no mutation and stayed silent
on a repeated identical message. This is exactly the failure check 2 exists to catch, and it was
reproducible on the shipped build:

| Test | Writes | NVDA announcements |
|---|---|---|
| `_announce("Paused")` twice, as shipped | clear+set, same task | **1** (the second was silent) |
| Page baseline button, as shipped | clear+set, same task | **1** |
| Patched: clear now, set +120 ms | split across tasks | **2** |
| Patched in reverse order (control) | split across tasks | **2** |

The 2026-09-22 record ("all three announced") did **not** reproduce on this Chrome + NVDA pair.

### The fix

- `src/announce.js` (new) — the repeat rule as a pure module: different message → write now;
  identical message → clear now, re-set on a ~60 ms timer, with a sequence token so a stale timer
  can never overwrite a newer message.
- `src/read-along.js` — `_announce()` delegates to it.
- `demo/at-test.html` — the light-DOM baseline button uses the same contract (it had the same bug).
- `tests/announce.test.mjs` (new, 8 tests) — pins the rule, including the exact field defect.

### Re-verified live, after the fix

| Check | Page writes | NVDA announcements | Verdict |
|---|---|---|---|
| 2 — pause/resume/pause (2 identical "Paused") | `Paused` → `""` → `Paused` | **2** | PASS |
| Baseline — 3 identical presses | `announcement` → `""` → `announcement` (×3) | **3** | PASS |
| 4 — restart mid-speech | — | `Finished reading` **+0** | PASS |
| 3 — play to completion | — | `Finished reading` **+1** | PASS |
| 6 — control names | — | `Listen toggle button`, `Restart from the beginning button`, `Reading speed combo box` | PASS |

Unit suite: **133/133** (125 before + 8 new).

### What this adds to the standing claim

The 2026-09-22 run established that NVDA announces the shadow-root live region **at all**. This run
found that it did **not** re-announce an identical repeat — the second half of that claim — and fixed
it. The verification method (Speech Viewer read as text) is new and is what made the defect visible
without a person listening.
