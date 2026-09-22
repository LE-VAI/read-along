# Manual screen reader test — read-along live region

**What this is:** a ~4 minute manual test to close the last unverified claim in
`read-along`. Everything else in the package has been verified by execution.
This one cannot be: there is no headless way to ask "did NVDA say that."

**What is already verified by execution** (so you are not re-testing it):
the component upgrades, the shadow root exists, `#ra-live` carries
`aria-live="polite"`, it is visually hidden, the three controls are reachable
and named, and `_announce()` forces a real DOM mutation even when the message
is an identical repeat. What remains open is whether a screen reader *speaks*
that mutation.

**Why it still needs a person:** a region can be present, changed, and silent.
Two known ways that happens — a screen reader that does not observe live regions
inside shadow roots, and a clearing-and-setting that lands such that the region
is empty when the browser snapshots it. Spec-correct code is not evidence that a
user heard anything.

---

## Setup (1 minute)

1. **Start your screen reader first**, then open the page. A screen reader
   started after the page loads may not observe the region from its beginning.
2. Serve the page — do not open the file directly:
   ```bash
   cd D:\1ATLAS\read-along
   python3 -m http.server 8793
   ```
   Then open **http://127.0.0.1:8793/demo/at-test.html**
3. **If you are testing with NVDA, turn on the Speech Viewer** — this removes all
   guesswork:
   <kbd>NVDA</kbd>+<kbd>N</kbd> → Tools → Speech Viewer.
   Every announcement appears there as text. A message either shows up or it
   does not, and you can copy the transcript into the report.

---

## The six checks

Work down the page. Each check has three buttons — *Heard it*, *Nothing
announced*, *Not sure*. Recording *Not sure* is fine and is better than a
guess; it keeps the claim honest.

| # | Do this | Pass looks like |
|---|---|---|
| 1 | Press **Play** | Speech starts, and a status message is announced |
| 2 | Press **Pause** → **Play** → **Pause** | **All three** announce, including the second Pause (same word as the first) |
| 3 | Press **Play**, let it finish untouched | A completion message is announced |
| 4 | Press **Play**, then **Restart** mid-speech | Restart announces, and only once for the one press |
| 5 | Change **Speed** while playing | Rate changes, word highlighting keeps up — no stall, no skip |
| 6 | <kbd>Tab</kbd> through the controls | Each is reachable and says what it does, not just "button" |

**Check 2 is the important one.** It is the exact failure the clear-then-set
exists to prevent: a live region announces a *change*, and assigning an
identical string produces no change — so a naive implementation goes silent on
every repeated message. A user cannot tell "the tool ignored me" from "the tool
is broken."

**Check 6 is not a live-region check** — it is the shadow-DOM markup check. A
control that announces as an unnamed button is unusable without sight.

---

## The baseline (this is what makes the result mean something)

Below the checks there is a **light-DOM** live region — same announcement logic,
but *outside* any shadow root. Press its button twice (the second press repeats
the same text deliberately).

This is the control condition:

- **Light DOM announces, component's did not** → the shadow root is
  conclusively the cause. That is a bug in our markup, and fixable.
- **Neither announces** → the environment is the problem (speech viewer off, a
  screen reader that needs a different setting). The test tells you nothing
  about read-along, and it should be recorded as inconclusive rather than a
  failure.

Without this baseline, a silent result cannot be attributed, and a failure would
send the investigation the wrong way.

---

## Recording the result

1. Fill in the **screen reader and version** field, e.g.
   `NVDA 2026.1, Firefox 151, Windows 11`.
2. Add any notes — a stray announcement, a word cut off, a pause that felt too
   long. The notes are usually more useful than the pass marks.
3. Press **Build the result report**. It produces markdown.
4. Paste that markdown into `docs/AT-TEST-RESULT.md`, below the header.

The generator will not overstate the run: with any check unrun or unclear, the
summary says the live region is **not yet fully verified** rather than claiming
a pass.

---

## What to do with each outcome

**All six pass →** update the claim. `read-along`'s README and the package
description can say the live region is screen-reader verified, with the
environment recorded. Remove the "unverified" caveat wherever it appears.

**The baseline also fails →** record it as inconclusive, not as a failure.
Re-run after confirming the screen reader is running and the speech viewer is
on. If it still fails with the viewer on, the environment cannot run this test.

**The baseline passes and the component's does not →** this is a real finding
and the most valuable outcome of the exercise. The shadow root is the cause, and
the fix is to hoist the live region to the light DOM (the component can render
one and keep it out of the visual layout), or to mirror announcements to a
host-provided region. File it as an issue with the transcript; the doc's verdict
line becomes "shadow-root live regions are not universally announced — hoisting
required."

**Everything announces but a message is wrong or missing →** a content bug
rather than a plumbing bug, and the easiest kind to fix. Record the exact text
you heard versus what you expected.
