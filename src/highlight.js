/**
 * highlight.js — karaoke highlight over arbitrary inline markup.
 *
 * Primary path: CSS Custom Highlight API (Highlight + CSS.highlights +
 * ::highlight() pseudo) — paints a Range without touching the DOM, so host
 * markup (links, emphasis, listeners) stays intact.
 * Fallback path: wrap the active word in <mark data-read-along> for engines
 * without the Highlight API. The mark is moved (unwrapped/re-wrapped) only
 * when the token changes; unwrap is clean and normalizes the text node.
 */

const HL_WORD = "read-along-word";
const HL_SENTENCE = "read-along-sentence";
const FALLBACK_TAG = "mark";

export function supportsHighlightAPI() {
  return (
    typeof Highlight !== "undefined" &&
    typeof CSS !== "undefined" &&
    typeof CSS.highlights !== "undefined" &&
    CSS.highlights instanceof HighlightRegistry
  );
}

/**
 * Map token text-offsets to DOM Ranges by walking the host's text nodes once.
 * Offsets are into the concatenated text-node content (what tokenize() saw).
 * @returns {Map<number, Range>} token index -> Range
 */
export function buildTokenRanges(host, tokens) {
  const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  const ranges = new Map();
  let node = walker.nextNode();
  let nodeStart = 0;
  for (const tok of tokens) {
    while (node !== null && nodeStart + node.data.length <= tok.start) {
      nodeStart += node.data.length;
      node = walker.nextNode();
    }
    if (node === null) break; // tokens outlive the DOM text — stop
    const localStart = Math.max(0, tok.start - nodeStart);
    const localEnd = Math.min(node.data.length, tok.end - nodeStart);
    if (localEnd <= localStart) continue; // token straddles a node boundary —
    // partially covering this node is fine; the next token maps onward.
    const r = document.createRange();
    r.setStart(node, localStart);
    r.setEnd(node, localEnd);
    ranges.set(tok.index, r);
  }
  return ranges;
}

export class Highlighter {
  constructor(host) {
    this.host = host;
    this.native = supportsHighlightAPI();
    this.tokenRanges = new Map();
    this.wordHighlight = null;
    this.sentenceHighlight = null;
    this.markEl = null;
    this._markIndex = -2;
    if (this.native) {
      this.wordHighlight = new Highlight();
      this.sentenceHighlight = new Highlight();
      CSS.highlights.set(HL_WORD, this.wordHighlight);
      CSS.highlights.set(HL_SENTENCE, this.sentenceHighlight);
    }
  }

  setTokenRanges(ranges) {
    this.tokenRanges = ranges;
  }

  /** Highlight token index i as the active word; clear the previous word. */
  setActive(i) {
    if (this.native) {
      this.wordHighlight.clear();
      const r = this.tokenRanges.get(i);
      if (r) this.wordHighlight.add(r);
    } else {
      this._fallbackMark(i);
    }
  }

  /**
   * Sentence-track tint: keep the current chunk's range softly highlighted
   * while the word pointer moves through it. Range or null.
   */
  setSentence(range) {
    if (!this.native) return;
    this.sentenceHighlight.clear();
    if (range) this.sentenceHighlight.add(range);
  }

  clear() {
    if (this.native) {
      this.wordHighlight.clear();
      this.sentenceHighlight.clear();
    }
    this._unwrapMark();
  }

  destroy() {
    this.clear();
    if (this.native) {
      try {
        CSS.highlights.delete(HL_WORD);
        CSS.highlights.delete(HL_SENTENCE);
      } catch { /* already gone */ }
    }
  }

  // -- fallback path ------------------------------------------------------

  _fallbackMark(i) {
    if (i === this._markIndex) return;
    const r = this.tokenRanges.get(i);
    this._unwrapMark();
    this._markIndex = -2;
    if (!r) return;
    try {
      const contents = r.extractContents();
      const mark = document.createElement(FALLBACK_TAG);
      mark.dataset.readAlong = "";
      this._markIndex = i;
      mark.appendChild(contents);
      r.insertNode(mark);
      this.markEl = mark;
    } catch { /* DOM changed mid-speech — skip this token */ }
  }

  _unwrapMark() {
    const mark = this.markEl;
    if (!mark) return;
    const parent = mark.parentNode;
    if (!parent) {
      this.markEl = null;
      return;
    }
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
    this.markEl = null;
    this._markIndex = -2;
  }
}