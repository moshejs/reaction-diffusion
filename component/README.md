# `<ReactionDiffusion />`

The Gray–Scott reaction–diffusion shader from [A garden of reaction–diffusion](../README.md),
packaged as a self-contained React component.

- **No dependencies beyond React** (peer, 18 or later). Raw WebGL, about 8 kB min+gzip.
- **Same pixels as the exhibit.** With the same seed and the same number of frames, the
  component's output is byte-for-byte identical to the original page (checked in Chromium,
  Firefox and WebKit; see [Tests](#tests)).
- **One implementation.** The exhibit page (`../diffusion.js`) now runs on the same
  renderer, `src/engine.js`, that the component wraps.

> This package is `"private": true`. It is not published to npm or anywhere else; install
> it from source as below.

## Install from source

The package lives in `component/` of this repository. Pick one:

**Tarball (recommended).** Works with npm, pnpm, yarn and Next.js/Turbopack, which rejects
symlinked packages from outside the project root.

```bash
git clone https://github.com/moshejs/reaction-diffusion.git
cd reaction-diffusion/component
npm pack                     # writes moshejs-reaction-diffusion-react-0.1.0.tgz
cd /path/to/your-app
npm install /path/to/reaction-diffusion/component/moshejs-reaction-diffusion-react-0.1.0.tgz
```

**Copy the source.** `src/` is plain ES modules with no build step: copy
`component/src/` into your project and import from it.

## Use

```jsx
import { ReactionDiffusion, PRESETS } from '@moshejs/reaction-diffusion-react';

export function Hero() {
  return (
    <ReactionDiffusion style={{ height: 480 }} feed={PRESETS.mitosis.feed} kill={PRESETS.mitosis.kill}>
      <h1>Content sits on top of the field</h1>
    </ReactionDiffusion>
  );
}
```

The field fills the component's box, so **give it a size** (`style`, `className`, or
content). Children are layered above the field.

In **Next.js** (App Router) import it from a server component as-is: the component file
starts with `'use client'`, and nothing touches `window` at import time. Verified with
Next.js 16.4.6: `next build` prerenders the page (decorative wrapper, palette base colour,
children) and the field starts on hydration.

### Imperative handle

```jsx
const ref = useRef(null);
<ReactionDiffusion ref={ref} paused />;

ref.current.step(600);              // advance 600 simulation steps now (works while paused)
ref.current.reset('blob', 42);      // re-seed: 'noise' | 'blob' | 'blank', optional seed
ref.current.splat(0.5, 0.5);        // paint at the centre (fractions of the box, top-left origin)
const png = ref.current.snapshot(); // data URL of the current frame
ref.current.getInfo();              // { status, webgl, format, gridSize, seed, reducedMotion }
```

### Without React

`src/engine.js` is the framework-agnostic renderer the component wraps; the exhibit page
uses it directly:

```js
import { createReactionDiffusion } from './component/src/engine.js';
const field = createReactionDiffusion(canvas, { feed: 0.029, kill: 0.057 });
field.update({ palette: 'ember' });
field.dispose();
```

## Props

| Prop | Type | Default | What it does |
|---|---|---|---|
| `feed` | number | `0.0545` | Feed rate *f* (clamped 0 to 0.12). |
| `kill` | number | `0.0620` | Kill rate *k* (clamped 0 to 0.12). |
| `diffusionU` | number | `1.0` | Diffusion rate of U (clamped 0 to 1.25). |
| `diffusionV` | number | `0.5` | Diffusion rate of V (clamped 0 to 1.25). |
| `timestep` | number | `1.0` | Euler timestep (clamped 0.01 to 1). The clamps keep the explicit integration stable. |
| `stepsPerFrame` | number | `12` | Simulation steps per animation frame: the speed (0 to 64). |
| `palette` | `'lagoon' \| 'ember' \| 'ink' \| 'bio'` or stops | `'lagoon'` | The exhibit's palettes, or 2 to 8 custom stops `{ at: 0..1, color: '#rrggbb' \| [r, g, b] }` blended with the same smoothstep chain. |
| `gridSize` | number | `512` (WebGL2), `256` (WebGL1) | Simulation grid edge in cells. Larger means finer, smaller features on screen. |
| `maxPixelRatio` | number | `2` | Cap on device pixel ratio for the canvas backbuffer. |
| `resolutionScale` | number | `1` | Extra multiplier on the backbuffer (0.1 to 2); lower it on weak GPUs. |
| `paused` | boolean | `false` | Freeze the simulation (the last frame stays). |
| `seed` | number | random | Deterministic starting pattern; wrapped into [0, 1000). Same seed, same frames, same pixels. |
| `initialPattern` | `'noise' \| 'blob' \| 'blank'` | `'noise'` | Scattered droplets, one central blob, or empty. |
| `interactive` | boolean | `false` | Let the pointer paint chemical in. Off by default because it sets `touch-action: none`, which would block page scrolling on phones. |
| `brushSize` | number | `28` | Brush radius in CSS pixels. |
| `forceMotion` | boolean | `false` | Animate even when the user prefers reduced motion. |
| `stillFrameSteps` | number | `1500` | Steps run before showing the reduced-motion still frame. |
| `label` | string | none | Accessible name. Without it the field is decorative (`aria-hidden`); with it, the field is `role="img"`. |
| `fallback` | ReactNode | flat palette tone | Shown when WebGL is unavailable. |
| `className`, `style` | | | Applied to the outer box (which is `position: relative; overflow: hidden`). |
| `children` | ReactNode | | Layered above the field. |
| `onReady` | `(info) => void` | | Fired once the field is running. `info` has `webgl`, `format` (`'half-float' \| 'float' \| 'byte'`) and `gridSize`. |
| `onFallback` | `(reason) => void` | | `reason.code` is `'no-webgl'`, `'no-format'` or `'init-failed'`. |
| `onContextLost`, `onContextRestored` | `() => void` | | GPU context lost and recovered. |

`PRESETS` exports the exhibit's five regimes (`coral`, `mitosis`, `worms`, `maze`,
`fingerprint`) as `{ feed, kill }`; `PALETTES` exports the palette stops.

## Behaviour

- **Lifecycle.** Each mount creates its own canvas and GL context; unmount deletes every
  texture, framebuffer, program and buffer, removes every listener and observer, and
  releases the context with `WEBGL_lose_context` instead of waiting for garbage collection.
  React StrictMode's double effects are safe because the second mount gets a new canvas.
- **Pausing.** No frames run while `paused`, while the tab is hidden, or while the field is
  scrolled off screen (IntersectionObserver). It resumes where it left off.
- **Reduced motion.** With `prefers-reduced-motion: reduce` it develops the pattern for
  `stillFrameSteps` steps and shows that single frame, with no animation loop, unless
  `forceMotion`. It follows the OS setting live.
- **Resizing.** A ResizeObserver keeps the backbuffer at box size times
  `min(devicePixelRatio, maxPixelRatio) * resolutionScale`. The simulation grid does not
  change with the box; the pattern tiles horizontally, so a wide box shows more of it.
- **Context loss.** It stops, asks the browser to restore, then rebuilds everything and
  regrows the field from the same seed (the evolved pattern itself is gone).
- **Fallback.** Storage is probed at runtime: half-float, then float, then a packed 8-bit
  format, on WebGL2 and then WebGL1. If no WebGL context or renderable format exists, the
  canvas is hidden and `fallback` is shown.
- **Accessibility.** Decorative by default (`aria-hidden`), never focusable, no keyboard
  trap. Painting is pointer-only; it is an enhancement, not content.

## Performance

Measured on an Apple M2 Ultra Mac, Chromium 159
headless, `npm run test:browser -- --perf`. One frame is 12 Gray–Scott steps on the grid
plus the display pass, timed over 300 frames with a GPU sync at the end.

| Renderer | Box (CSS) | DPR | Backbuffer | Grid | ms per frame |
|---|---|---|---|---|---|
| Apple M2 Ultra (ANGLE Metal) | 1280×720 | 2 | 2560×1440 | 512 | 0.46 |
| Apple M2 Ultra (ANGLE Metal) | 390×260 | 3 (capped to 2) | 780×520 | 512 | 0.45 |
| Apple M2 Ultra (ANGLE Metal) | 1280×720 | 2 | 2560×1440 | 256 | 0.46 |
| SwiftShader (CPU software GL) | 1280×720 | 2 | 2560×1440 | 512 | 77 to 103 |
| SwiftShader (CPU software GL) | 390×260 | 3 (capped to 2) | 780×520 | 512 | 38 to 43 |
| SwiftShader (CPU software GL) | 1280×720 | 2 | 2560×1440 | 256 | 34 to 38 |

On the M2 Ultra the cost does not move with box or grid size up to 1024 (per-frame
overhead dominates; forcing a full GPU round trip every frame measures about 1.2 ms, and
1.8 ms at a 2048 grid). On software GL (no GPU, or a GPU blocklisted by the browser) it
falls to roughly 10 to 25 fps at full size; `gridSize={256}`, `maxPixelRatio={1}` and a
lower `stepsPerFrame` are the levers. **Not measured on a phone or on integrated laptop
GPUs.**

## Browser support (as tested)

Tested headless with Playwright 1.65.1 on macOS, all checks passing:

| Browser | Version | GL | Result |
|---|---|---|---|
| Chromium | 159 | SwiftShader and Apple GPU (Metal) | all checks, plus demo/exhibit layout at 1440 px and 390 px |
| Firefox | 159 | Apple GPU | all checks |
| WebKit | 27.2 | Apple GPU | all checks; see the WebKit note below |

Not tested: real iOS/Android devices, Safari proper (WebKit build only), Windows/Linux
GPUs, a WebGL1-only browser (the WebGL1 and 8-bit paths are covered by unit tests against
a mocked context, not by a real browser).

**WebKit note.** WebKit counts contexts released with `WEBGL_lose_context` against its
16-context cap until they are garbage-collected. In the test that mounts and unmounts 50
times in StrictMode (100 contexts in a tight loop) it logs "There are too many active
WebGL contexts on this page" while evicting already-released contexts; the instance on
screen is unaffected (checked). Normal mounting does not come near this.

## Limitations

- The simulation grid is square and tiles horizontally; it does not stretch to the box.
- Context restore regrows from the seed; it cannot recover the evolved pattern.
- `snapshot()` returns the field only, not children layered over it.
- Painting has no keyboard equivalent.
- A custom palette is limited to 8 stops.
- The seed hash runs in the GPU's float precision, so patterns for the same seed are
  identical within a GPU and driver but may differ slightly between GPUs.

## Development

```bash
cd component
npm install
npx playwright install chromium firefox webkit   # browsers for the headless checks
npm run typecheck      # tsc over the JSDoc-typed sources and the .d.ts files
npm test               # node:test unit tests: option/uniform mapping, lifecycle with a mocked GL, SSR
npm run test:browser   # builds the harness, then headless Playwright checks (Chromium)
node scripts/browser-check.mjs --browsers=chromium,firefox,webkit --perf
npm run demo           # demo page on http://127.0.0.1:5199
```

The browser check serves the repository and the exhibit as it shipped (extracted from git
at `c0ac335`) from its own server on a free port, and writes screenshots and
`results.json` to `test-results/`.

## Licence

MIT, the same licence as the rest of this repository (see `LICENSE`).
