# Screen reader verification — read-along live region

**Status: NOT YET RUN.**

Everything else in `read-along` has been verified by execution. This is the one
claim that cannot be, because there is no headless way to ask a screen reader
whether it spoke.

**The claim under test:** the component announces its state through an
`aria-live="polite"` region inside a shadow root, and a *repeated identical*
message re-announces rather than going silent.

**Verified by execution already** (not part of the manual test):
`<read-along>` upgrades to the `ReadAlong` class; the shadow root exists;
`#ra-live` carries `aria-live="polite"` and is visually hidden; the three
controls are reachable and named; and `_announce()` forces a real DOM mutation
even when the string is unchanged (measured with a MutationObserver — an
identical second call produced a mutation, not a no-op).

**Open:** whether a screen reader *speaks* that mutation.

**How to run it:** `docs/AT-TEST-STEPS.md` — about 4 minutes, with a light-DOM
baseline region included so a silent result can be attributed rather than
guessed at.

---

## Result

_Run the test and paste the generated markdown here. Until then this section
says what the code does, not what a user hears, and the distinction is the whole
point of the exercise._

---

## Why this file exists rather than a pass/fail note in the README

The failure mode this guards against is documenting an accessibility feature
from the spec instead of from use. "The live region is correctly marked up" and
"a blind user hears the status" are different claims, and only the first one is
verifiable by reading code. A package whose entire purpose is access should not
ship the second claim on the strength of the first.

Related: `docs/AT-TEST-STEPS.md`, `src/read-along.js` (`_announce`).
