export type PaletteName = 'lagoon' | 'ember' | 'ink' | 'bio';
/** Linear 0..1 channels. */
export type RGB = readonly [number, number, number];
/** `at` is a position on the 0..1 concentration ramp; `color` is "#rgb", "#rrggbb" or an [r, g, b] triple of 0..1 floats. */
export interface PaletteStop {
  at: number;
  color: string | RGB;
}
export type PaletteInput = PaletteName | ReadonlyArray<PaletteStop>;
export type SeedPattern = 'noise' | 'blob' | 'blank';

export interface EngineInfo {
  status: 'running' | 'idle' | 'lost' | 'unsupported' | 'disposed';
  webgl: 0 | 1 | 2;
  format: 'half-float' | 'float' | 'byte' | null;
  gridSize: number;
  seed: number;
  reducedMotion: boolean;
}

export interface FallbackReason {
  code: 'no-webgl' | 'no-format' | 'init-failed';
  message: string;
}

export interface SimulationOptions {
  /** Feed rate f. Default 0.0545 (coral). Clamped to 0..0.12. */
  feed?: number;
  /** Kill rate k. Default 0.0620 (coral). Clamped to 0..0.12. */
  kill?: number;
  /** Diffusion rate of U. Default 1.0. Clamped to 0..1.25. */
  diffusionU?: number;
  /** Diffusion rate of V. Default 0.5. Clamped to 0..1.25. */
  diffusionV?: number;
  /** Euler timestep. Default 1.0. Clamped to 0.01..1. */
  timestep?: number;
  /** Simulation steps per animation frame: the speed. Default 12. Clamped to 0..64. */
  stepsPerFrame?: number;
  /** Built-in palette name or 2 to 8 custom stops. Default "lagoon". */
  palette?: PaletteInput;
  /** Simulation grid edge in cells. Default 512 on WebGL2, 256 on WebGL1. */
  gridSize?: number;
  /** Device-pixel-ratio cap for the canvas backbuffer. Default 2. */
  maxPixelRatio?: number;
  /** Extra multiplier on the backbuffer size (0.1..2). Default 1. */
  resolutionScale?: number;
  /** Freeze the simulation. Default false. */
  paused?: boolean;
  /** Deterministic seed for the starting pattern, wrapped into [0, 1000). Random when omitted. */
  seed?: number;
  /** Starting field. Default "noise". */
  initialPattern?: SeedPattern;
  /** Let the pointer paint chemical into the field. Default false. */
  interactive?: boolean;
  /** Brush radius in CSS pixels. Default 28. */
  brushSize?: number;
  /** Animate even when the user prefers reduced motion. Default false. */
  forceMotion?: boolean;
  /** Steps run before showing the reduced-motion still frame. Default 1500. */
  stillFrameSteps?: number;
}

export interface EngineCallbacks {
  onReady?: (info: EngineInfo) => void;
  onFallback?: (reason: FallbackReason) => void;
  onContextLost?: () => void;
  onContextRestored?: (info: EngineInfo) => void;
  onPaintStart?: () => void;
}

export type EngineOptions = SimulationOptions & EngineCallbacks;

export interface SplatOptions {
  /** Radius in CSS pixels. Defaults to `brushSize`. */
  radius?: number;
  /** How much V to add at the centre, 0..1. Default 0.9. */
  amount?: number;
}

export interface ReactionDiffusionEngine {
  update(next: EngineOptions): void;
  reset(pattern?: SeedPattern, seed?: number): void;
  step(steps?: number): void;
  /** x, y are fractions of the canvas box, (0, 0) top-left. */
  splat(x: number, y: number, opts?: SplatOptions): void;
  snapshot(type?: string, quality?: number): string;
  getInfo(): EngineInfo;
  dispose(opts?: { loseContext?: boolean }): void;
}

export declare const PRESETS: Readonly<Record<'coral' | 'mitosis' | 'worms' | 'maze' | 'fingerprint', Readonly<{ feed: number; kill: number }>>>;
export declare const PALETTES: Readonly<Record<PaletteName, ReadonlyArray<PaletteStop>>>;
export declare const MAX_PALETTE_STOPS: 8;
export declare const DEFAULTS: Readonly<Required<Omit<SimulationOptions, 'gridSize' | 'seed'>> & { gridSize: number | undefined; seed: number | undefined }>;
export declare const PATTERN_MODE: Readonly<Record<SeedPattern, number>>;
export declare const SHADERS: Readonly<Record<'HEAD_FLOAT' | 'HEAD_BYTE' | 'VERT' | 'FRAG_SIM' | 'FRAG_SPLAT' | 'FRAG_SEED' | 'FRAG_DISPLAY', string>>;

export declare function parseColor(color: string | RGB): [number, number, number];
export declare function resolvePalette(palette: PaletteInput): { count: number; at: Float32Array; colors: Float32Array; key: string };
export declare function normalizeOptions(o: EngineOptions): Required<Omit<SimulationOptions, 'gridSize' | 'seed'>> & { gridSize: number | undefined; seed: number | undefined };
export declare function simUniforms(o: ReturnType<typeof normalizeOptions>): { u_feed: number; u_kill: number; u_du: number; u_dv: number; u_dt: number };
export declare function wrapSeed(seed: number): number;
export declare function createReactionDiffusion(canvas: HTMLCanvasElement, options?: EngineOptions): ReactionDiffusionEngine;
