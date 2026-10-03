/**
 * Type definitions for @designesy/read-along.
 *
 * Hand-written. The element's public surface is a deliberate API: play/pause/
 * stop/toggle, word-level seek, an engine slot, and the reading position. The
 * engine contract is described here too, because a host implementing its own
 * engine needs the exact shape the component calls.
 */

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

export interface Token {
  text: string;
  /** Offset into the ORIGINAL text. Ranges are built from these, so they must not shift. */
  start: number;
  end: number;
  index: number;
}

export interface Chunk {
  tokens: Token[];
  start: number;
  end: number;
  /**
   * Present only when a pronunciations map changes this chunk. Engines say
   * `spoken.text` instead of the visible words and map their char offsets back
   * through `spoken.spans`. Tokens (and every public index) stay visible.
   */
  spoken?: SpokenView;
}

export interface Sentence {
  text: string;
  start: number;
  end: number;
}

export declare function tokenize(text: string): Token[];
export declare function sentences(text: string): Sentence[];
export declare function chunkTokens(tokens: Token[]): Chunk[];

// ---------------------------------------------------------------------------
// Pronunciations — spoken-text substitutions (pronunciations.js)
// ---------------------------------------------------------------------------

/** Visible text -> what the engine should say, e.g. `{ Theravada: "Terra-vah-dah" }`. */
export type PronunciationMap = Record<string, string>;

export interface CompiledPronunciations {
  /** Entries in force (keys and values whitespace-collapsed), longest key first. */
  readonly size: number;
  readonly entries: ReadonlyArray<{ key: string; spoken: string }>;
  readonly pattern: RegExp | null;
  /** Keys skipped because the key or value was not a non-empty string. */
  readonly skipped: string[];
}

/** The slice of `SpokenView.text` that says one visible token. Empty when a shorter replacement passed over it. */
export interface SpokenSpan {
  /** Global token index (visible). */
  index: number;
  start: number;
  end: number;
}

export interface PronunciationMatch {
  key: string;
  spoken: string;
  /** First and last visible token index the match covers. */
  first: number;
  last: number;
}

export interface SpokenView {
  /** What the engine says. */
  text: string;
  /** One span per chunk token, same order. */
  spans: SpokenSpan[];
  matches: PronunciationMatch[];
}

/** Parse the attribute's JSON form. Throws on invalid JSON or a non-object. */
export declare function parsePronunciations(json: string): PronunciationMap;
/** Validate and compile. Invalid entries are skipped (and listed), never thrown. */
export declare function compilePronunciations(
  map: PronunciationMap | Map<string, string> | null | undefined,
): CompiledPronunciations;
/** Whole-word, case-insensitive, leftmost-then-longest, single-pass matches. */
export declare function findPronunciations(
  text: string,
  compiled: CompiledPronunciations | null,
): Array<{ start: number; end: number; key: string; spoken: string }>;
export declare function spokenChunk(chunk: Pick<Chunk, 'tokens'>, compiled: CompiledPronunciations | null): SpokenView;
/** Attach `spoken` to every chunk the map changes and remove it elsewhere. Mutates and returns `chunks`. */
export declare function applySpokenViews<T extends Chunk[]>(chunks: T, compiled: CompiledPronunciations | null): T;
/** Plain-text form for a build step: the text an engine would be handed, whitespace collapsed. */
export declare function applyPronunciations(text: string, compiled: CompiledPronunciations | null): string;
/** `chunk.spoken.text`, or the visible words joined by spaces. */
export declare function spokenText(chunk: Chunk): string;
/** The visible token being said at a char offset into `spokenText(chunk)`. */
export declare function spokenTokenAt(chunk: Chunk, charIndex: number): Token | null;
/** The chunk from its k-th token on, with the spoken view sliced to match (used by seek). */
export declare function sliceChunk(chunk: Chunk, k: number): Chunk;

// ---------------------------------------------------------------------------
// Highlight
// ---------------------------------------------------------------------------

export interface HighlighterOptions {
  forceFallback?: boolean;
}

export declare class Highlighter {
  constructor(host: HTMLElement, options?: HighlighterOptions);
  /** True when the CSS Custom Highlight API path is in use. */
  readonly native: boolean;
  readonly destroyed: boolean;
  tokenRanges: Map<number, Range>;
  setTokenRanges(ranges: Map<number, Range>): void;
  setActive(i: number): void;
  setSentence(range: Range | null): void;
  clear(): void;
  destroy(): void;
}

/** False when the Highlight API is unavailable, in which case the mark fallback is used. */
export declare function supportsHighlightAPI(): boolean;
export declare function buildTokenRanges(host: HTMLElement, tokens: Token[]): Map<number, Range>;

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

export interface EnginePosition {
  chunk: number;
  token: number;
}

/**
 * The engines do NOT agree on what `position` returns, and this type records
 * that rather than pretending otherwise: ExternalEngine returns a bare number
 * (it tracks only a word), while the other three return EnginePosition.
 *
 * The COMPONENT normalises it — see `ReadAlongEventDetail.token`, which is
 * always a word index. A host writing its own engine may return either.
 */
export type EnginePositionValue = number | EnginePosition;

/**
 * The contract every engine implements. A host's own engine needs exactly this:
 * the four lifecycle methods, an optional setChunks, the callbacks, and a
 * position. The component never touches speechSynthesis directly.
 */
export interface ReadAlongEngine {
  onToken?: ((i: number) => void) | null;
  onChunkStart?: ((chunkIndex: number, chunk: Chunk) => void) | null;
  onChunkEnd?: ((chunkIndex: number, chunk: Chunk) => void) | null;
  onEnd?: (() => void) | null;
  onError?: ((err: Error) => void) | null;
  /** 'visual' when audio is unavailable and the component must degrade honestly. */
  onMode?: ((mode: string) => void) | null;
  rate: number;
  lang?: string;
  readonly position: EnginePositionValue;
  setChunks?(chunks: Chunk[]): void;
  speak(chunks: Chunk[], startWord?: number): void;
  pause(): void;
  resume(): void;
  stop(): void;
}

export interface WebSpeechEngineOptions {
  lang?: string;
  rate?: number;
  pitch?: number;
  voiceName?: string | null;
  onToken?: (i: number) => void;
  onChunkStart?: (chunkIndex: number, chunk: Chunk) => void;
  onChunkEnd?: (chunkIndex: number, chunk: Chunk) => void;
  onEnd?: () => void;
  onError?: (err: Error) => void;
  onVoices?: (voices: SpeechSynthesisVoice[]) => void;
  onMode?: (mode: string) => void;
}

export declare class WebSpeechEngine implements ReadAlongEngine {
  constructor(options?: WebSpeechEngineOptions);
  /** False outside a browser, or where speechSynthesis is absent. */
  static readonly available: boolean;
  rate: number;
  lang: string;
  readonly voices: SpeechSynthesisVoice[];
  readonly position: EnginePosition;
  setChunks(chunks: Chunk[]): void;
  speak(chunks: Chunk[], startWord?: number): void;
  pause(): void;
  resume(): void;
  stop(): void;
}

export declare function chunkText(chunk: Chunk): string;
export declare function locateTokenChunk(chunks: Chunk[], word: number): number;
export declare function tokenAtChar(chunk: Chunk, charIndex: number): Token | null;

export interface MediaChunkEntry {
  src: string;
  duration?: number;
  /** [tokenIndex, startMs, endMs] — the same shape ExternalEngine consumes. */
  words?: Array<[number, number, number]>;
}

export interface MediaManifest {
  chunks: MediaChunkEntry[];
}

export declare class MediaEngine implements ReadAlongEngine {
  constructor(options?: { manifest?: MediaManifest } & Partial<ReadAlongEngine>);
  manifest: MediaManifest;
  rate: number;
  readonly position: EnginePosition;
  setChunks(chunks: Chunk[]): void;
  speak(chunks: Chunk[], startWord?: number): void;
  pause(): void;
  resume(): void;
  stop(): void;
}

export declare class ExternalEngine implements ReadAlongEngine {
  constructor(options?: {
    /** [tokenIndex, startMs, endMs], sorted by startMs. */
    words?: Array<[number, number, number]>;
  } & Partial<ReadAlongEngine>);
  words: Array<[number, number, number]>;
  /** The chunks the component handed over, with `spoken` views when a pronunciations map applies. */
  readonly chunks: Chunk[];
  readonly rate: number;
  /** A bare word index — this engine tracks no chunk. Normalised on the event path. */
  readonly position: number;
  setWords(words: Array<[number, number, number]>): void;
  setChunks(chunks: Chunk[]): void;
  /** Host heartbeat: elapsed playback milliseconds, monotonic, may jump. */
  tick(ms: number): void;
  speak(chunks: Chunk[], startWord?: number): void;
  pause(): void;
  resume(): void;
  stop(): void;
}

export interface WordTiming {
  tokenIndex: number;
  startMs: number;
  endMs: number;
}

/**
 * Distribute a chunk's real audio duration across its words by character count.
 * Char-proportional because the public ONNX export has no word timestamps —
 * sentence-sized chunks keep the error bounded. When the chunk carries a
 * spoken view, the duration is divided over the SPOKEN characters and each
 * visible token gets its spoken span's share; indexes stay visible.
 */
export declare function wordTimingsFromChunk(
  chunk: Chunk,
  audio: { samples: Float32Array | number[]; sampleRate: number },
): WordTiming[];

// ---------------------------------------------------------------------------
// The element
// ---------------------------------------------------------------------------

export type ReadAlongState = 'idle' | 'playing' | 'paused';

/**
 * An engine the natural-voice loader may return: the normal contract, plus an
 * optional `load()` the component awaits (narrating `onProgress`) before
 * swapping it in. KokoroEngine is one.
 */
export interface NaturalVoiceEngine extends ReadAlongEngine {
  load?(): Promise<void>;
  /** pct is 0..1; 1 means ready, not merely downloaded. */
  onProgress?: ((pct: number, label: string) => void) | null;
}

/** Returns the engine to load when the reader presses "Natural voice". */
export type NaturalVoiceLoader = () => NaturalVoiceEngine | Promise<NaturalVoiceEngine>;

/**
 * A loader, or a loader plus the download size the button must disclose when
 * it is not Kokoro's default ("about 80–90 MB").
 */
export type NaturalVoiceOption = NaturalVoiceLoader | { load: NaturalVoiceLoader; downloadSize?: string };

export interface ReadAlongElement extends HTMLElement {
  readonly state: ReadAlongState;
  engine: ReadAlongEngine | null;
  /**
   * Spoken-text substitutions, applied to what every engine says and never to
   * what the page shows. Accepts an object, a Map or a JSON string; reads back
   * the entries in force, or null. Invalid values are ignored with a warning.
   * Also settable as the `pronunciations` attribute (JSON).
   */
  get pronunciations(): PronunciationMap | null;
  set pronunciations(value: PronunciationMap | Map<string, string> | string | null);
  /**
   * Opt-in neural voice. Setting it renders a "Natural voice" toggle; pressing it
   * loads the engine, swaps it in at the current word and remembers the choice.
   */
  naturalVoice: NaturalVoiceOption | null;
  /** Index of the word currently being spoken (-1 when idle). */
  readonly activeToken: number;
  play(): void;
  pause(): void;
  toggle(): void;
  stop(): void;
  /**
   * Seek to a token index and play from there. No-op while paused — resume
   * first, or stop() then seekToToken().
   */
  seekToToken(i: number): void;
}

export interface ReadAlongEventDetail {
  /** ALWAYS the word index, whichever engine is in use — the component normalises it. */
  token: number;
  /** The engine's own value, unchanged, for a host that wants the extra detail. */
  position: EnginePositionValue | undefined;
}

export declare class ReadAlong extends HTMLElement implements ReadAlongElement {
  constructor();
  readonly state: ReadAlongState;
  engine: ReadAlongEngine | null;
  get pronunciations(): PronunciationMap | null;
  set pronunciations(value: PronunciationMap | Map<string, string> | string | null);
  naturalVoice: NaturalVoiceOption | null;
  readonly activeToken: number;
  play(): void;
  pause(): void;
  toggle(): void;
  stop(): void;
  seekToToken(i: number): void;
}

// ---------------------------------------------------------------------------
// Ambient declarations — the element in JSX and in querySelector
// ---------------------------------------------------------------------------

declare global {
  interface HTMLElementTagNameMap {
    'read-along': ReadAlong;
  }
}

/**
 * REACT 19 NOTE — no JSX declaration is shipped here on purpose.
 *
 * Declaring `JSX.IntrinsicElements` requires the React types, which this package
 * does not depend on; shipping the declaration made the file fail to compile for
 * anyone without React installed, including this package's own CI.
 *
 * React 19 supports custom elements natively (props are assigned as properties
 * client-side, primitives render as attributes server-side), so no wrapper is
 * needed. If you want JSX typing, add this to YOUR project:
 *
 *   declare module 'react' {
 *     namespace JSX {
 *       interface IntrinsicElements {
 *         'read-along': React.DetailedHTMLProps<
 *           React.HTMLAttributes<HTMLElement> & { lang?: string; rate?: string | number; seekable?: string; pronunciations?: string },
 *           HTMLElement
 *         >;
 *       }
 *     }
 *   }
 *
 * Pass presence-only attributes as STRINGS (`seekable=""`). A JSX boolean renders
 * the attribute in lowercase (`forceFallback={true}` becomes `forcefallback`),
 * which the element never reads because it checks `hasAttribute('force-fallback')`.
 */
