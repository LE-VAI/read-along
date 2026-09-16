/**
 * styles.js — the highlight stylesheet, injected by the component.
 *
 * WHY THIS FILE EXISTS. The karaoke highlight is painted by `::highlight()`
 * rules, and those rules previously lived ONLY in a separate `read-along.css`
 * that the component never loaded. Nothing told a consumer it was required, so
 * the default outcome for an npm install was:
 *
 *   - in a browser with the CSS Custom Highlight API (every modern one), the
 *     Ranges were registered and the headline feature painted NOTHING. Silent.
 *   - in a browser without it, the `<mark>` fallback rendered with
 *     browser-default yellow, so the fallback looked better than the primary
 *     path.
 *
 * Verified in a real browser before the fix: `activeToken: 5`, `rangeCount: 1`,
 * and `::highlight rules in document: 0`. The component was working perfectly
 * and showing the user nothing.
 *
 * A stylesheet the feature depends on cannot be optional and undocumented. It
 * is now adopted automatically, and the standalone file stays published for
 * hosts who prefer a `<link>` (and for CSP-strict hosts, who can set
 * `no-inject-styles` and load it themselves — see the README).
 *
 * SCOPE. `::highlight()` rules must live where the highlight RANGES live, which
 * is the document — not the shadow root. Adopting into the document is
 * therefore architecturally required, not a shortcut.
 */

/** The rules, kept as a string so there is one source of truth. */
export const HIGHLIGHT_CSS = `
::highlight(read-along-sentence) {
  background-color: rgb(64 132 255 / 0.16);
}

::highlight(read-along-word) {
  background-color: var(--ra-highlight, rgb(64 132 255 / 0.5));
  color: inherit;
  text-decoration: underline;
  text-decoration-color: var(--ra-accent, rgb(33 74 255));
}

/* The <mark> fallback path, for engines without the Highlight API. */
mark[data-read-along] {
  background-color: var(--ra-highlight, rgb(64 132 255 / 0.5));
  color: inherit;
  text-decoration: underline;
  text-decoration-color: var(--ra-accent, rgb(33 74 255));
}
`;

/** Marks the style element so repeated injections are detectable. */
const STYLE_ID = 'read-along-highlight-styles';

/** Tracks whether we have already injected, per document. */
const injected = new WeakSet();

/**
 * Inject the highlight rules into a document, once.
 *
 * Prefers a constructable stylesheet (`adoptedStyleSheets`), which avoids
 * touching the DOM and cannot be observed as a layout change. Falls back to a
 * `<style>` element where constructable sheets are unavailable.
 *
 * Returns true when the rules are present, false when it could not be done —
 * and the caller reports that, because a silent failure to style the highlight
 * is the exact bug this exists to prevent.
 *
 * @param {Document} doc
 * @returns {boolean}
 */
export function injectHighlightStyles(doc = document) {
  if (!doc) return false;
  if (injected.has(doc)) return true;

  // Already present from a previous import (two copies of the module, or a
  // host that added the <link>)? Then there is nothing to do.
  if (doc.getElementById?.(STYLE_ID)) {
    injected.add(doc);
    return true;
  }
  if (doc.adoptedStyleSheets?.some?.((s) => s.__readAlong === true)) {
    injected.add(doc);
    return true;
  }

  // Preferred: a constructable stylesheet.
  try {
    if (typeof CSSStyleSheet === 'function' && doc.adoptedStyleSheets) {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(HIGHLIGHT_CSS);
      sheet.__readAlong = true;
      doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
      injected.add(doc);
      return true;
    }
  } catch {
    // Some engines expose adoptedStyleSheets but reject cross-origin sheets,
    // or a CSP may block constructable sheets. Fall through to the element.
  }

  // Fallback: a <style> element. This can be blocked by a strict `style-src`
  // CSP without a nonce, which is why the constructable path is attempted
  // first and why the return value must be checked.
  try {
    const style = doc.createElement('style');
    style.id = STYLE_ID;
    style.textContent = HIGHLIGHT_CSS;
    (doc.head || doc.documentElement).appendChild(style);
    injected.add(doc);
    return true;
  } catch {
    return false;
  }
}

/** True when the highlight rules are present in this document. */
export function hasHighlightStyles(doc = document) {
  if (!doc) return false;
  if (doc.getElementById?.(STYLE_ID)) return true;
  if (doc.adoptedStyleSheets?.some?.((s) => s.__readAlong === true)) return true;
  // A host may have loaded the published stylesheet themselves.
  try {
    for (const sheet of doc.styleSheets) {
      try {
        for (const rule of sheet.cssRules) {
          if (String(rule.cssText).includes('::highlight')) return true;
        }
      } catch { /* cross-origin sheet — cannot inspect, keep looking */ }
    }
  } catch { /* no styleSheets (non-browser) */ }
  return false;
}
