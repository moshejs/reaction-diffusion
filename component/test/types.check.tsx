// Compile-only: checks that the hand-written declarations describe a usable API.
import { useRef } from 'react';
import { ReactionDiffusion, PRESETS, PALETTES, type ReactionDiffusionHandle } from '../src/index.js';

export function Example() {
  const ref = useRef<ReactionDiffusionHandle>(null);
  return (
    <ReactionDiffusion
      ref={ref}
      className="hero"
      style={{ height: 400 }}
      feed={PRESETS.mitosis.feed}
      kill={PRESETS.mitosis.kill}
      palette={[{ at: 0, color: '#041110' }, { at: 1, color: [1, 1, 1] }]}
      seed={42}
      paused={false}
      onReady={(info) => info.format}
      onFallback={(r) => r.code}
    >
      <button onClick={() => ref.current?.reset('noise', 7)}>{PALETTES.lagoon.length}</button>
    </ReactionDiffusion>
  );
}

// @ts-expect-error unknown palette names are rejected
export const bad = <ReactionDiffusion palette="neon" />;
