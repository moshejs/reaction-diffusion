import type { CSSProperties, ForwardRefExoticComponent, ReactNode, RefAttributes } from 'react';
import type { EngineInfo, FallbackReason, SeedPattern, SimulationOptions, SplatOptions } from './engine.js';

export * from './engine.js';

export interface ReactionDiffusionProps extends SimulationOptions {
  className?: string;
  /** Applied to the outer box. Give it a size: the field fills it. */
  style?: CSSProperties;
  /** Accessible name. Without it the field is decorative (aria-hidden). With it, the field is role="img". */
  label?: string;
  /** Shown instead of the canvas when WebGL is unavailable. Default: a flat block in the palette's dark tone. */
  fallback?: ReactNode;
  /** Content layered above the field. */
  children?: ReactNode;
  onReady?: (info: EngineInfo) => void;
  onFallback?: (reason: FallbackReason) => void;
  onContextLost?: () => void;
  onContextRestored?: (info: EngineInfo) => void;
}

export interface ReactionDiffusionHandle {
  /** Re-seed. Without a seed: the `seed` prop, else a new random one. */
  reset(pattern?: SeedPattern, seed?: number): void;
  /** Run `steps` simulation steps now (default one frame's worth) and draw. Works while paused. */
  step(steps?: number): void;
  /** Paint at x, y given as fractions of the box, (0, 0) top-left. */
  splat(x: number, y: number, opts?: SplatOptions): void;
  /** The current frame as a data URL ("" when unsupported). */
  snapshot(type?: string, quality?: number): string;
  getInfo(): EngineInfo | null;
}

export declare const ReactionDiffusion: ForwardRefExoticComponent<ReactionDiffusionProps & RefAttributes<ReactionDiffusionHandle>>;
