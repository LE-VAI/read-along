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
 * sentence-sized chunks keep the error bounded.
 */
export declare function wordTimingsFromChunk(
  chunk: Chunk,
  audio: { samples: Float32Array | number[]; sampleRate: number },
): WordTiming[];

// ---------------------------------------------------------------------------
// The element
// ---------------------------------------------------------------------------

export type ReadAlongState = 'idle' | 'playing' | 'paused';

export interface ReadAlongElement extends HTMLElement {
  readonly state: ReadAlongState;
  engine: ReadAlongEngine | null;
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
 *           React.HTMLAttributes<HTMLElement> & { lang?: string; rate?: string | number; seekable?: string },
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
