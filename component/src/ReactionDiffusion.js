'use client';
/* ReactionDiffusion.js — React wrapper around ./engine.js.

   Written with createElement rather than JSX so the source runs as-is in a
   browser, in Node (server rendering) and in any bundler, with no build step.

   The canvas is created inside the effect and thrown away in its cleanup.
   That is deliberate: a fresh canvas per mount means StrictMode's
   mount → unmount → mount never reuses a context that cleanup released, and
   unmounting can release the GL context immediately instead of waiting for
   garbage collection (browsers cap live WebGL contexts at about 16). */

import { createElement, forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createReactionDiffusion, DEFAULTS, resolvePalette } from './engine.js';

/** @typedef {import('./engine.js').EngineOptions} EngineOptions */
/** @typedef {import('./engine.js').ReactionDiffusionEngine} ReactionDiffusionEngine */

/** Engine options that are passed straight through from props. */
const ENGINE_KEYS = /** @type {const} */ ([
  'feed', 'kill', 'diffusionU', 'diffusionV', 'timestep', 'stepsPerFrame',
  'palette', 'gridSize', 'maxPixelRatio', 'resolutionScale', 'paused', 'seed',
  'initialPattern', 'interactive', 'brushSize', 'forceMotion', 'stillFrameSteps',
]);

/** @param {Record<string, any>} props @returns {EngineOptions} */
function engineOptions(props) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const k of ENGINE_KEYS) if (props[k] !== undefined) out[k] = props[k];
  return out;
}

/** CSS colour of a palette stop, used for the static background and fallback. */
/** @param {import('./engine.js').PaletteInput | undefined} palette @param {number} index */
function paletteCss(palette, index) {
  try {
    const p = resolvePalette(palette == null ? DEFAULTS.palette : palette);
    const i = Math.min(index, p.count - 1);
    const c = Array.from(p.colors.subarray(i * 3, i * 3 + 3), (x) => Math.round(x * 255));
    return 'rgb(' + c.join(' ') + ')';
  } catch (e) {
    return '#000';
  }
}

const FILL = { position: 'absolute', inset: 0 };

/**
 * A live Gray–Scott reaction–diffusion field. See README.md for every prop.
 * @type {import('react').ForwardRefExoticComponent<import('./index.js').ReactionDiffusionProps & import('react').RefAttributes<import('./index.js').ReactionDiffusionHandle>>}
 */
export const ReactionDiffusion = forwardRef(function ReactionDiffusion(props, ref) {
  const {
    className, style, label, fallback, children,
    onReady, onFallback, onContextLost, onContextRestored,
  } = /** @type {import('./index.js').ReactionDiffusionProps} */ (props);

  const layerRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const engineRef = useRef(/** @type {ReactionDiffusionEngine | null} */ (null));
  const [unsupported, setUnsupported] = useState(false);

  const opts = engineOptions(props);
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const cbRef = useRef({ onReady, onFallback, onContextLost, onContextRestored });
  cbRef.current = { onReady, onFallback, onContextLost, onContextRestored };

  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return undefined;
    const canvas = layer.ownerDocument.createElement('canvas');
    canvas.setAttribute('aria-hidden', 'true');
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    layer.appendChild(canvas);

    const engine = createReactionDiffusion(canvas, {
      ...optsRef.current,
      onReady: (info) => cbRef.current.onReady?.(info),
      onFallback: (reason) => {
        setUnsupported(true);
        cbRef.current.onFallback?.(reason);
      },
      onContextLost: () => cbRef.current.onContextLost?.(),
      onContextRestored: (info) => cbRef.current.onContextRestored?.(info),
    });
    engineRef.current = engine;
    if (engine.getInfo().status === 'unsupported') canvas.style.display = 'none';

    return () => {
      engineRef.current = null;
      engine.dispose({ loseContext: true });
      canvas.remove();
    };
  }, []);

  // Push prop changes into the running engine. It diffs internally, so a new
  // palette array with the same stops, or an unchanged seed, costs nothing.
  useEffect(() => {
    engineRef.current?.update(opts);
  });

  useImperativeHandle(ref, () => /** @type {import('./index.js').ReactionDiffusionHandle} */ ({
    reset: (/** @type {import('./engine.js').SeedPattern | undefined} */ pattern, /** @type {number | undefined} */ seed) => engineRef.current?.reset(pattern, seed),
    step: (/** @type {number | undefined} */ steps) => engineRef.current?.step(steps),
    splat: (/** @type {number} */ x, /** @type {number} */ y, /** @type {import('./engine.js').SplatOptions | undefined} */ o) => engineRef.current?.splat(x, y, o),
    snapshot: (/** @type {string | undefined} */ type, /** @type {number | undefined} */ quality) => engineRef.current?.snapshot(type, quality) ?? '',
    getInfo: () => engineRef.current?.getInfo() ?? null,
  }), []);

  const layerProps = label
    ? { role: 'img', 'aria-label': label }
    : { 'aria-hidden': true };

  return createElement(
    'div',
    {
      className,
      style: { position: 'relative', overflow: 'hidden', background: paletteCss(opts.palette, 0), ...style },
      'data-reaction-diffusion': unsupported ? 'fallback' : 'live',
    },
    createElement(
      'div',
      { ref: layerRef, style: FILL, ...layerProps },
      unsupported
        ? (fallback !== undefined
          ? fallback
          : createElement('div', { style: { ...FILL, background: paletteCss(opts.palette, 1) } }))
        : null,
    ),
    children != null ? createElement('div', { style: { position: 'relative' } }, children) : null,
  );
});

ReactionDiffusion.displayName = 'ReactionDiffusion';
