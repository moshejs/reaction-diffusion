/* engine.js — the Gray–Scott reaction–diffusion renderer, framework-agnostic.

   This is the renderer that powers both the exhibit page (../../diffusion.js)
   and the React component (./ReactionDiffusion.js). It owns one canvas:

     - two U,V state textures ping-ponged through a Gray–Scott fragment shader
       (Karl Sims' 3x3 Laplacian, Du 1.0, Dv 0.5, dt 1.0, 12 steps per frame);
     - storage picked at runtime: half-float → float → 8-bit packed (two bytes
       per concentration), on WebGL2 first and WebGL1 if that is all there is;
     - a display pass that maps V through a palette with a faint emboss.

   Lifecycle: it pauses when the tab is hidden, when the canvas is off screen
   and while `paused`; with prefers-reduced-motion it renders one developed
   still frame unless `forceMotion`; it survives WebGL context loss and
   restore; `dispose()` deletes every GL object it created.

   No `window` access happens at import time, so it is safe to import during
   server rendering. Zero dependencies. */

/**
 * @typedef {'lagoon' | 'ember' | 'ink' | 'bio'} PaletteName
 * @typedef {[number, number, number]} RGB  Linear 0..1 channels.
 * @typedef {{ at: number, color: string | RGB }} PaletteStop
 *   `at` is a position on the 0..1 concentration ramp, `color` is "#rgb",
 *   "#rrggbb" or an [r, g, b] triple of 0..1 floats.
 * @typedef {PaletteName | ReadonlyArray<PaletteStop>} PaletteInput
 * @typedef {'noise' | 'blob' | 'blank'} SeedPattern
 *
 * @typedef {object} EngineOptions
 * @property {number} [feed]            Feed rate f. Default 0.0545 (coral).
 * @property {number} [kill]            Kill rate k. Default 0.0620 (coral).
 * @property {number} [diffusionU]      Diffusion rate of U. Default 1.0.
 * @property {number} [diffusionV]      Diffusion rate of V. Default 0.5.
 * @property {number} [timestep]        Euler timestep. Default 1.0, max 1.0.
 * @property {number} [stepsPerFrame]   Simulation steps per animation frame (speed). Default 12.
 * @property {PaletteInput} [palette]   Built-in palette name or custom stops. Default "lagoon".
 * @property {number} [gridSize]        Simulation grid edge in cells. Default 512 (WebGL2) or 256 (WebGL1).
 * @property {number} [maxPixelRatio]   Device-pixel-ratio cap for the canvas backbuffer. Default 2.
 * @property {number} [resolutionScale] Extra multiplier on the backbuffer size. Default 1.
 * @property {boolean} [paused]         Freeze the simulation. Default false.
 * @property {number} [seed]            Deterministic seed for the initial pattern; random when omitted.
 * @property {SeedPattern} [initialPattern] Starting field. Default "noise".
 * @property {boolean} [interactive]    Let the pointer paint chemical into the field. Default false.
 * @property {number} [brushSize]       Brush radius in CSS pixels. Default 28.
 * @property {boolean} [forceMotion]    Animate even when prefers-reduced-motion is set. Default false.
 * @property {number} [stillFrameSteps] Steps run before showing the reduced-motion still frame. Default 1500.
 * @property {(info: EngineInfo) => void} [onReady]
 * @property {(reason: FallbackReason) => void} [onFallback]
 * @property {() => void} [onContextLost]
 * @property {(info: EngineInfo) => void} [onContextRestored]
 * @property {() => void} [onPaintStart]
 *
 * @typedef {object} EngineInfo
 * @property {'running' | 'idle' | 'lost' | 'unsupported' | 'disposed'} status
 * @property {1 | 2 | 0} webgl
 * @property {'half-float' | 'float' | 'byte' | null} format
 * @property {number} gridSize
 * @property {number} seed
 * @property {boolean} reducedMotion
 *
 * @typedef {{ code: 'no-webgl' | 'no-format' | 'init-failed', message: string }} FallbackReason
 *
 * @typedef {object} SplatOptions
 * @property {number} [radius]  Radius in CSS pixels. Defaults to `brushSize`.
 * @property {number} [amount]  How much V to add at the centre, 0..1. Default 0.9.
 *
 * @typedef {object} ReactionDiffusionEngine
 * @property {(next: EngineOptions) => void} update
 * @property {(pattern?: SeedPattern, seed?: number) => void} reset
 * @property {(steps?: number) => void} step
 * @property {(x: number, y: number, opts?: SplatOptions) => void} splat
 * @property {(type?: string, quality?: number) => string} snapshot
 * @property {() => EngineInfo} getInfo
 * @property {(opts?: { loseContext?: boolean }) => void} dispose
 */

/** Famous points in Gray–Scott parameter space (Pearson 1993 / Karl Sims). */
export const PRESETS = Object.freeze({
  coral: Object.freeze({ feed: 0.0545, kill: 0.0620 }),
  mitosis: Object.freeze({ feed: 0.0367, kill: 0.0649 }),
  worms: Object.freeze({ feed: 0.0580, kill: 0.0650 }),
  maze: Object.freeze({ feed: 0.0290, kill: 0.0570 }),
  fingerprint: Object.freeze({ feed: 0.0370, kill: 0.0600 }),
});

/** @param {number} at @param {RGB} color @returns {PaletteStop} */
const stop = (at, color) => Object.freeze({ at, color: /** @type {RGB} */ (Object.freeze(color)) });

/** The exhibit's four palettes, as the colour stops its shader used. */
export const PALETTES = Object.freeze({
  lagoon: Object.freeze([
    stop(0.00, [0.016, 0.067, 0.059]),
    stop(0.35, [0.043, 0.231, 0.224]),
    stop(0.60, [0.090, 0.584, 0.498]),
    stop(0.82, [0.184, 0.839, 0.765]),
    stop(1.00, [0.847, 1.000, 0.965]),
  ]),
  ember: Object.freeze([
    stop(0.00, [0.039, 0.020, 0.012]),
    stop(0.35, [0.290, 0.059, 0.016]),
    stop(0.62, [0.761, 0.231, 0.055]),
    stop(0.84, [1.000, 0.616, 0.184]),
    stop(1.00, [1.000, 0.949, 0.769]),
  ]),
  ink: Object.freeze([
    stop(0.00, [0.027, 0.031, 0.043]),
    stop(0.45, [0.227, 0.255, 0.314]),
    stop(0.72, [0.486, 0.518, 0.580]),
    stop(1.00, [0.949, 0.957, 0.973]),
  ]),
  bio: Object.freeze([
    stop(0.00, [0.020, 0.024, 0.102]),
    stop(0.35, [0.141, 0.102, 0.420]),
    stop(0.60, [0.420, 0.184, 0.702]),
    stop(0.82, [0.184, 0.839, 0.765]),
    stop(1.00, [0.918, 1.000, 0.941]),
  ]),
});

export const MAX_PALETTE_STOPS = 8;

export const DEFAULTS = Object.freeze({
  feed: PRESETS.coral.feed,
  kill: PRESETS.coral.kill,
  diffusionU: 1.0,
  diffusionV: 0.5,
  timestep: 1.0,
  stepsPerFrame: 12,
  palette: /** @type {PaletteInput} */ ('lagoon'),
  gridSize: /** @type {number | undefined} */ (undefined),
  maxPixelRatio: 2,
  resolutionScale: 1,
  paused: false,
  seed: /** @type {number | undefined} */ (undefined),
  initialPattern: /** @type {SeedPattern} */ ('noise'),
  interactive: false,
  brushSize: 28,
  forceMotion: false,
  stillFrameSteps: 1500,
});

/* ---------------------------------------------------------------------- */
/*  Pure helpers (exported for tests and for wrappers)                     */
/* ---------------------------------------------------------------------- */

/** @param {number} x @param {number} lo @param {number} hi */
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
/** @param {unknown} x @param {number} d @returns {number} */
const num = (x, d) => (typeof x === 'number' && Number.isFinite(x) ? x : d);

/**
 * Parse "#rgb", "#rrggbb" or an [r, g, b] triple into 0..1 floats.
 * @param {string | RGB} color
 * @returns {RGB}
 */
export function parseColor(color) {
  if (Array.isArray(color) && color.length === 3) {
    return [clamp(num(color[0], 0), 0, 1), clamp(num(color[1], 0), 0, 1), clamp(num(color[2], 0), 0, 1)];
  }
  if (typeof color === 'string') {
    let h = color.trim().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(h)) h = h.replace(/./g, (c) => c + c);
    if (/^[0-9a-f]{6}$/i.test(h)) {
      const n = parseInt(h, 16);
      return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
    }
  }
  throw new TypeError('reaction-diffusion: palette colours must be "#rgb", "#rrggbb" or [r, g, b] in 0..1, got ' + JSON.stringify(color));
}

/**
 * Turn a palette name or a list of stops into the uniform arrays the display
 * shader reads. Stops are sorted by `at`; 2 to 8 stops are allowed.
 * @param {PaletteInput} palette
 * @returns {{ count: number, at: Float32Array, colors: Float32Array, key: string }}
 */
export function resolvePalette(palette) {
  /** @type {ReadonlyArray<PaletteStop>} */
  let stops;
  if (typeof palette === 'string') {
    /** @type {string} */
    let name = palette;
    if (name === 'mono') name = 'ink'; // the exhibit's original id for Ink
    const named = /** @type {Record<string, ReadonlyArray<PaletteStop>>} */ (PALETTES)[name];
    if (!named) throw new TypeError('reaction-diffusion: unknown palette "' + palette + '". Use one of ' + Object.keys(PALETTES).join(', ') + ' or an array of stops.');
    stops = named;
  } else if (Array.isArray(palette)) {
    stops = palette;
  } else {
    throw new TypeError('reaction-diffusion: palette must be a name or an array of { at, color } stops.');
  }
  if (stops.length < 2 || stops.length > MAX_PALETTE_STOPS) {
    throw new RangeError('reaction-diffusion: a palette needs 2 to ' + MAX_PALETTE_STOPS + ' stops, got ' + stops.length + '.');
  }
  const sorted = stops
    .map((s) => ({ at: clamp(num(s.at, 0), 0, 1), color: parseColor(s.color) }))
    .sort((a, b) => a.at - b.at);
  const at = new Float32Array(MAX_PALETTE_STOPS);
  const colors = new Float32Array(MAX_PALETTE_STOPS * 3);
  sorted.forEach((s, i) => {
    at[i] = s.at;
    colors.set(s.color, i * 3);
  });
  return { count: sorted.length, at, colors, key: JSON.stringify(sorted) };
}

/**
 * Fill in defaults and clamp every option into a range the shader is stable in.
 * Explicit Euler with this Laplacian is stable while diffusion * timestep <= 1.25.
 * @param {EngineOptions} o
 */
export function normalizeOptions(o) {
  const d = DEFAULTS;
  const pattern = o.initialPattern === 'blob' || o.initialPattern === 'blank' ? o.initialPattern : 'noise';
  const grid = o.gridSize == null ? undefined : Math.round(clamp(num(o.gridSize, 512), 16, 4096));
  return {
    feed: clamp(num(o.feed, d.feed), 0, 0.12),
    kill: clamp(num(o.kill, d.kill), 0, 0.12),
    diffusionU: clamp(num(o.diffusionU, d.diffusionU), 0, 1.25),
    diffusionV: clamp(num(o.diffusionV, d.diffusionV), 0, 1.25),
    timestep: clamp(num(o.timestep, d.timestep), 0.01, 1),
    stepsPerFrame: Math.round(clamp(num(o.stepsPerFrame, d.stepsPerFrame), 0, 64)),
    palette: o.palette == null ? d.palette : o.palette,
    gridSize: grid,
    maxPixelRatio: clamp(num(o.maxPixelRatio, d.maxPixelRatio), 0.25, 4),
    resolutionScale: clamp(num(o.resolutionScale, d.resolutionScale), 0.1, 2),
    paused: !!o.paused,
    seed: typeof o.seed === 'number' && Number.isFinite(o.seed) ? o.seed : undefined,
    initialPattern: /** @type {SeedPattern} */ (pattern),
    interactive: !!o.interactive,
    brushSize: clamp(num(o.brushSize, d.brushSize), 1, 400),
    forceMotion: !!o.forceMotion,
    stillFrameSteps: Math.round(clamp(num(o.stillFrameSteps, d.stillFrameSteps), 0, 20000)),
  };
}

/**
 * The uniforms the simulation pass receives for a set of options.
 * @param {ReturnType<typeof normalizeOptions>} o
 */
export function simUniforms(o) {
  return { u_feed: o.feed, u_kill: o.kill, u_du: o.diffusionU, u_dv: o.diffusionV, u_dt: o.timestep };
}

/** Seeds are wrapped into [0, 1000), the range the exhibit always used. @param {number} s */
export const wrapSeed = (s) => ((s % 1000) + 1000) % 1000;

/** u_mode values of the seed shader. */
export const PATTERN_MODE = Object.freeze({ blank: 0, noise: 1, blob: 2 });

/* ---------------------------------------------------------------------- */
/*  Shaders (GLSL ES 1.00, so one source runs on WebGL1 and WebGL2)        */
/* ---------------------------------------------------------------------- */

/* storage header: float mode reads channels directly; byte mode packs each
   concentration into 16 bits across two bytes so an 8-bit target still
   simulates cleanly. */
const HEAD_FLOAT =
  'precision highp float;\n' +
  '#define READ_U(s) (s).x\n' +
  '#define READ_V(s) (s).y\n' +
  '#define PACK(U,V) vec4((U),(V),0.0,1.0)\n';
const HEAD_BYTE =
  'precision highp float;\n' +
  'vec2 enc16(float v){v=clamp(v,0.0,1.0);float s=v*65535.0;float hi=floor(s/256.0);float lo=floor(s-hi*256.0);return vec2(hi,lo)/255.0;}\n' +
  'float dec16(vec2 e){return (e.x*255.0*256.0+e.y*255.0)/65535.0;}\n' +
  '#define READ_U(s) dec16((s).xy)\n' +
  '#define READ_V(s) dec16((s).zw)\n' +
  '#define PACK(U,V) vec4(enc16(U),enc16(V))\n';

const VERT =
  'attribute vec2 a_pos;\n' +
  'varying vec2 v_uv;\n' +
  'void main(){ v_uv = a_pos*0.5+0.5; gl_Position = vec4(a_pos,0.0,1.0); }\n';

/* Gray–Scott update with a 3x3 Laplacian (center -1, ortho 0.2, diag 0.05) */
const FRAG_SIM =
  'varying vec2 v_uv;\n' +
  'uniform sampler2D u_prev;\n' +
  'uniform vec2 u_texel;\n' +
  'uniform float u_feed, u_kill, u_du, u_dv, u_dt;\n' +
  'void main(){\n' +
  '  vec2 uv = v_uv;\n' +
  '  vec4 c  = texture2D(u_prev, uv);\n' +
  '  float U = READ_U(c); float V = READ_V(c);\n' +
  '  vec4 l  = texture2D(u_prev, uv + vec2(-u_texel.x, 0.0));\n' +
  '  vec4 r  = texture2D(u_prev, uv + vec2( u_texel.x, 0.0));\n' +
  '  vec4 up = texture2D(u_prev, uv + vec2(0.0, -u_texel.y));\n' +
  '  vec4 dn = texture2D(u_prev, uv + vec2(0.0,  u_texel.y));\n' +
  '  vec4 lu = texture2D(u_prev, uv + vec2(-u_texel.x,-u_texel.y));\n' +
  '  vec4 ru = texture2D(u_prev, uv + vec2( u_texel.x,-u_texel.y));\n' +
  '  vec4 ld = texture2D(u_prev, uv + vec2(-u_texel.x, u_texel.y));\n' +
  '  vec4 rd = texture2D(u_prev, uv + vec2( u_texel.x, u_texel.y));\n' +
  '  float lapU = -U + 0.2*(READ_U(l)+READ_U(r)+READ_U(up)+READ_U(dn))\n' +
  '                  + 0.05*(READ_U(lu)+READ_U(ru)+READ_U(ld)+READ_U(rd));\n' +
  '  float lapV = -V + 0.2*(READ_V(l)+READ_V(r)+READ_V(up)+READ_V(dn))\n' +
  '                  + 0.05*(READ_V(lu)+READ_V(ru)+READ_V(ld)+READ_V(rd));\n' +
  '  float uvv = U*V*V;\n' +
  '  float dU = (u_du*lapU - uvv + u_feed*(1.0-U)) * u_dt;\n' +
  '  float dV = (u_dv*lapV + uvv - (u_feed+u_kill)*V) * u_dt;\n' +
  '  U = clamp(U + dU, 0.0, 1.0);\n' +
  '  V = clamp(V + dV, 0.0, 1.0);\n' +
  '  gl_FragColor = PACK(U, V);\n' +
  '}\n';

/* soft circular brush that squirts V (and burns a little U) into the torus */
const FRAG_SPLAT =
  'varying vec2 v_uv;\n' +
  'uniform sampler2D u_src;\n' +
  'uniform vec2 u_point;\n' +
  'uniform float u_radius, u_amount;\n' +
  'void main(){\n' +
  '  vec4 s = texture2D(u_src, v_uv);\n' +
  '  float U = READ_U(s); float V = READ_V(s);\n' +
  '  vec2 d = v_uv - u_point;\n' +
  '  d -= floor(d + 0.5);\n' + // wrap difference onto the torus
  '  float b = u_amount * exp(-dot(d,d)/(u_radius*u_radius));\n' +
  '  V = min(1.0, V + b);\n' +
  '  U = max(0.0, U - b*0.5);\n' +
  '  gl_FragColor = PACK(U, V);\n' +
  '}\n';

/* seed the field: mode 0 blank, 1 scattered noise, 2 central blob */
const FRAG_SEED =
  'varying vec2 v_uv;\n' +
  'uniform float u_mode, u_seed;\n' +
  'float hash(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }\n' +
  'void main(){\n' +
  '  float U = 1.0; float V = 0.0;\n' +
  '  if (u_mode > 1.5) {\n' +
  '    vec2 d = v_uv - vec2(0.5);\n' +
  '    if (exp(-dot(d,d)/0.0016) > 0.5) { U = 0.5; V = 0.28; }\n' +
  '  } else if (u_mode > 0.5) {\n' +
  '    float h  = hash(floor(v_uv*56.0) + u_seed);\n' +
  '    float h2 = hash(floor(v_uv*56.0) + u_seed + 7.3);\n' +
  '    if (h > 0.62 && h2 > 0.45) { U = 0.5; V = 0.27; }\n' +
  '  }\n' +
  '  gl_FragColor = PACK(U, V);\n' +
  '}\n';

/* display: map V through a palette, with a faint emboss for depth. The
   palette is a chain of smoothstep blends between up to 8 stops; the four
   built-ins reproduce the exhibit's hand-written palette functions exactly. */
const FRAG_DISPLAY =
  'varying vec2 v_uv;\n' +
  'uniform sampler2D u_state;\n' +
  'uniform vec2 u_texel;\n' +
  'uniform float u_aspect;\n' +
  'uniform int u_count;\n' +
  'uniform float u_at[' + MAX_PALETTE_STOPS + '];\n' +
  'uniform vec3 u_col[' + MAX_PALETTE_STOPS + '];\n' +
  'vec3 palette(float t){\n' +
  '  vec3 c = u_col[0];\n' +
  '  for (int i = 1; i < ' + MAX_PALETTE_STOPS + '; i++) {\n' +
  '    if (i >= u_count) break;\n' +
  '    c = mix(c, u_col[i], smoothstep(u_at[i-1], u_at[i], t));\n' +
  '  }\n' +
  '  return c; }\n' +
  'void main(){\n' +
  '  vec2 uv = vec2(v_uv.x * u_aspect, v_uv.y);\n' + // square texels, seamless tiling
  '  float V  = READ_V(texture2D(u_state, uv));\n' +
  '  float vR = READ_V(texture2D(u_state, uv + vec2(u_texel.x,0.0)));\n' +
  '  float vL = READ_V(texture2D(u_state, uv - vec2(u_texel.x,0.0)));\n' +
  '  float vD = READ_V(texture2D(u_state, uv + vec2(0.0,u_texel.y)));\n' +
  '  float vU = READ_V(texture2D(u_state, uv - vec2(0.0,u_texel.y)));\n' +
  '  float t = clamp(V/0.42, 0.0, 1.0);\n' +
  '  t = pow(t, 0.85);\n' +
  '  vec3 col = palette(t);\n' +
  '  float emboss = (vR - vL)*3.0 + (vD - vU)*2.0;\n' +
  '  col *= 1.0 + clamp(emboss, -0.25, 0.25);\n' +
  '  gl_FragColor = vec4(col, 1.0);\n' +
  '}\n';

/** The shader sources, exported so tests can assert on them. */
export const SHADERS = Object.freeze({ HEAD_FLOAT, HEAD_BYTE, VERT, FRAG_SIM, FRAG_SPLAT, FRAG_SEED, FRAG_DISPLAY });

const GL_OPTS = {
  antialias: false, depth: false, stencil: false, alpha: false,
  premultipliedAlpha: false, preserveDrawingBuffer: false,
  powerPreference: /** @type {const} */ ('high-performance'),
};

/* ---------------------------------------------------------------------- */
/*  The engine                                                             */
/* ---------------------------------------------------------------------- */

/**
 * Start a reaction–diffusion field on `canvas`. Always returns an engine; if
 * WebGL is unavailable `getInfo().status` is "unsupported" and `onFallback`
 * has been called, and every method is a safe no-op.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {EngineOptions} [options]
 * @returns {ReactionDiffusionEngine}
 */
export function createReactionDiffusion(canvas, options = {}) {
  const doc = canvas.ownerDocument;
  const win = /** @type {Window & typeof globalThis} */ (doc.defaultView);

  let cb = pickCallbacks(options);
  let opts = normalizeOptions(options);
  let pal = resolvePalette(opts.palette);

  /** @type {any} */ let gl = null; // WebGLRenderingContext | WebGL2RenderingContext
  let isGL2 = false;
  /** @type {null | { internalFormat: number, format: number, type: number, mode: 'float' | 'byte', name: 'half-float' | 'float' | 'byte', linear: boolean }} */
  let fmt = null;
  /** @type {null | { sim: Program, splat: Program, seed: Program, disp: Program, quad: WebGLBuffer, tex: WebGLTexture[], fbo: WebGLFramebuffer[] }} */
  let res = null;
  let simSize = 0;
  let src = 0;
  let seedValue = 0;
  let pattern = opts.initialPattern;
  /** @type {{ u: number, v: number, r: number, amt: number }[]} */
  let pending = [];

  let ready = false, lost = false, disposed = false, unsupported = false;
  let rafId = 0;
  let tabHidden = !!doc.hidden;
  let onscreen = true;
  const motionQuery = typeof win.matchMedia === 'function' ? win.matchMedia('(prefers-reduced-motion: reduce)') : null;
  let reducedMotion = !!(motionQuery && motionQuery.matches);

  let painting = false, lastX = 0, lastY = 0, pointerBound = false;
  let prevTouchAction = '', prevCursor = '';
  /** @type {ResizeObserver | null} */ let ro = null;
  /** @type {IntersectionObserver | null} */ let io = null;

  /* ---- context ---------------------------------------------------- */
  try {
    gl = canvas.getContext('webgl2', GL_OPTS);
    if (gl) isGL2 = true;
    else gl = canvas.getContext('webgl', GL_OPTS) || canvas.getContext('experimental-webgl', GL_OPTS);
  } catch (e) { gl = null; }

  if (!gl) {
    return fail({ code: 'no-webgl', message: 'WebGL is not available in this browser or on this device.' });
  }

  const initError = initGL();
  if (initError) return fail(initError);

  /* ---- listeners -------------------------------------------------- */
  canvas.addEventListener('webglcontextlost', onContextLost, false);
  canvas.addEventListener('webglcontextrestored', onContextRestored, false);
  doc.addEventListener('visibilitychange', onVisibility);
  if (motionQuery) addMQListener(motionQuery, onMotionChange);
  if (typeof win.ResizeObserver === 'function') {
    ro = new win.ResizeObserver(() => resize());
    ro.observe(canvas);
  } else {
    win.addEventListener('resize', resize);
  }
  if (typeof win.IntersectionObserver === 'function') {
    io = new win.IntersectionObserver((entries) => {
      const e = entries[entries.length - 1];
      onscreen = !!(e && e.isIntersecting);
      refreshLoop();
    });
    io.observe(canvas);
  }
  if (opts.interactive) bindPointer();

  /* ---- boot ------------------------------------------------------- */
  resize();
  seedField(pattern, opts.seed);
  ready = true;
  developStill();
  drawDisplay();
  refreshLoop();
  safe(cb.onReady, getInfo());

  /** @type {ReactionDiffusionEngine} */
  const api = { update, reset, step, splat, snapshot, getInfo, dispose };
  return api;

  /* ================================================================= */

  /** @param {FallbackReason} reason @returns {ReactionDiffusionEngine} */
  function fail(reason) {
    unsupported = true;
    if (gl && res) freeGL();
    safe(cb.onFallback, reason);
    const noop = () => {};
    return {
      update(next) { cb = pickCallbacks({ ...cb, ...next }); },
      reset: noop, step: noop, splat: noop,
      snapshot: () => '',
      getInfo: () => ({ status: disposed ? 'disposed' : 'unsupported', webgl: 0, format: null, gridSize: 0, seed: 0, reducedMotion }),
      dispose() { disposed = true; },
    };
  }

  /** @returns {FallbackReason | null} */
  function initGL() {
    fmt = pickFormat();
    if (!fmt) return { code: 'no-format', message: 'No renderable texture format was available.' };
    const head = fmt.mode === 'byte' ? HEAD_BYTE : HEAD_FLOAT;
    /** @type {Program[]} */ const made = [];
    try {
      const sim = makeProgram(head + FRAG_SIM); made.push(sim);
      const splatP = makeProgram(head + FRAG_SPLAT); made.push(splatP);
      const seedP = makeProgram(head + FRAG_SEED); made.push(seedP);
      const disp = makeProgram(head + FRAG_DISPLAY); made.push(disp);
      const quad = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      res = { sim, splat: splatP, seed: seedP, disp, quad, tex: [], fbo: [] };
      allocTargets(targetGridSize());
    } catch (err) {
      if (res) freeGL(); else made.forEach((p) => gl.deleteProgram(p.p));
      res = null;
      if (win.console) win.console.error('[reaction-diffusion] init failed:', err);
      return { code: 'init-failed', message: 'WebGL initialisation failed on this device.' };
    }
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    return null;
  }

  function targetGridSize() {
    const want = opts.gridSize || (isGL2 ? 512 : 256);
    const max = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
    return Math.min(want, max);
  }

  /** @param {number} size */
  function allocTargets(size) {
    if (!res || !fmt) return;
    res.tex.forEach((t) => gl.deleteTexture(t));
    res.fbo.forEach((f) => gl.deleteFramebuffer(f));
    res.tex = []; res.fbo = [];
    const filter = fmt.mode !== 'byte' && fmt.linear ? gl.LINEAR : gl.NEAREST;
    for (let i = 0; i < 2; i++) {
      const t = gl.createTexture();
      res.tex.push(t);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internalFormat, size, size, 0, fmt.format, fmt.type, null);
      const f = gl.createFramebuffer();
      res.fbo.push(f);
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error('simulation framebuffer incomplete');
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    simSize = size;
    src = 0;
  }

  function freeGL() {
    if (!res) return;
    if (!lost && gl && !gl.isContextLost()) {
      res.tex.forEach((t) => gl.deleteTexture(t));
      res.fbo.forEach((f) => gl.deleteFramebuffer(f));
      [res.sim, res.splat, res.seed, res.disp].forEach((p) => gl.deleteProgram(p.p));
      gl.deleteBuffer(res.quad);
    }
    res = null;
  }

  /** @param {{ internalFormat: number, format: number, type: number }} c */
  function probe(c) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    let ok = true;
    /** @type {WebGLFramebuffer | null} */ let fbo = null;
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, c.internalFormat, 4, 4, 0, c.format, c.type, null);
      fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE && gl.getError() === gl.NO_ERROR;
    } catch (e) { ok = false; }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (fbo) gl.deleteFramebuffer(fbo);
    gl.deleteTexture(tex);
    return ok;
  }

  function pickFormat() {
    /** @type {NonNullable<typeof fmt>[]} */
    const cands = [];
    if (isGL2) {
      const cbf = gl.getExtension('EXT_color_buffer_float');
      const cbhf = gl.getExtension('EXT_color_buffer_half_float');
      if (cbf || cbhf) cands.push({ internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, mode: 'float', name: 'half-float', linear: true });
      if (cbf) cands.push({ internalFormat: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT, mode: 'float', name: 'float', linear: !!gl.getExtension('OES_texture_float_linear') });
      cands.push({ internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, mode: 'byte', name: 'byte', linear: true });
    } else {
      const hf = gl.getExtension('OES_texture_half_float');
      if (hf) cands.push({ internalFormat: gl.RGBA, format: gl.RGBA, type: hf.HALF_FLOAT_OES, mode: 'float', name: 'half-float', linear: !!gl.getExtension('OES_texture_half_float_linear') });
      const f = gl.getExtension('OES_texture_float');
      if (f) cands.push({ internalFormat: gl.RGBA, format: gl.RGBA, type: gl.FLOAT, mode: 'float', name: 'float', linear: !!gl.getExtension('OES_texture_float_linear') });
      cands.push({ internalFormat: gl.RGBA, format: gl.RGBA, type: gl.UNSIGNED_BYTE, mode: 'byte', name: 'byte', linear: true });
    }
    for (let i = 0; i < cands.length; i++) if (probe(cands[i])) return cands[i];
    return null;
  }

  /**
   * @typedef {{ p: WebGLProgram, aPos: number, u: (name: string) => WebGLUniformLocation | null }} Program
   */
  /** @param {number} type @param {string} source */
  function compile(type, source) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error('shader compile failed: ' + log);
    }
    return sh;
  }
  /** @param {string} fsrc @returns {Program} */
  function makeProgram(fsrc) {
    const vs = compile(gl.VERTEX_SHADER, VERT);
    let fs;
    try { fs = compile(gl.FRAGMENT_SHADER, fsrc); } catch (e) { gl.deleteShader(vs); throw e; }
    const p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs);
    gl.bindAttribLocation(p, 0, 'a_pos');
    gl.linkProgram(p);
    gl.deleteShader(vs); gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new Error('program link failed: ' + log);
    }
    /** @type {Record<string, WebGLUniformLocation | null>} */
    const cache = {};
    return {
      p,
      aPos: gl.getAttribLocation(p, 'a_pos'),
      u: (n) => (n in cache ? cache[n] : (cache[n] = gl.getUniformLocation(p, n))),
    };
  }

  /* ---- passes ----------------------------------------------------- */
  /** @param {Program} pr */
  function drawQuad(pr) {
    if (!res) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, res.quad);
    gl.enableVertexAttribArray(pr.aPos);
    gl.vertexAttribPointer(pr.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  /** @param {WebGLUniformLocation | null} loc @param {WebGLTexture} texture */
  function bindTex(loc, texture) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(loc, 0);
  }

  function simStep() {
    if (!res) return;
    const dst = 1 - src;
    const p = res.sim;
    const u = simUniforms(opts);
    const texel = 1 / simSize;
    gl.bindFramebuffer(gl.FRAMEBUFFER, res.fbo[dst]);
    gl.viewport(0, 0, simSize, simSize);
    gl.useProgram(p.p);
    bindTex(p.u('u_prev'), res.tex[src]);
    gl.uniform2f(p.u('u_texel'), texel, texel);
    gl.uniform1f(p.u('u_feed'), u.u_feed);
    gl.uniform1f(p.u('u_kill'), u.u_kill);
    gl.uniform1f(p.u('u_du'), u.u_du);
    gl.uniform1f(p.u('u_dv'), u.u_dv);
    gl.uniform1f(p.u('u_dt'), u.u_dt);
    drawQuad(p);
    src = dst;
  }

  /** @param {{ u: number, v: number, r: number, amt: number }} sp */
  function splatOnce(sp) {
    if (!res) return;
    const dst = 1 - src;
    const p = res.splat;
    gl.bindFramebuffer(gl.FRAMEBUFFER, res.fbo[dst]);
    gl.viewport(0, 0, simSize, simSize);
    gl.useProgram(p.p);
    bindTex(p.u('u_src'), res.tex[src]);
    gl.uniform2f(p.u('u_point'), sp.u, sp.v);
    gl.uniform1f(p.u('u_radius'), sp.r);
    gl.uniform1f(p.u('u_amount'), sp.amt);
    drawQuad(p);
    src = dst;
  }

  /** @param {SeedPattern} mode @param {number | undefined} seed */
  function seedField(mode, seed) {
    if (!res) return;
    pattern = mode;
    seedValue = wrapSeed(seed === undefined ? Math.random() * 1000 : seed);
    pending.length = 0;
    const p = res.seed;
    gl.bindFramebuffer(gl.FRAMEBUFFER, res.fbo[src]); // seed ignores input, no feedback
    gl.viewport(0, 0, simSize, simSize);
    gl.useProgram(p.p);
    gl.uniform1f(p.u('u_mode'), PATTERN_MODE[mode]);
    gl.uniform1f(p.u('u_seed'), seedValue);
    drawQuad(p);
  }

  function drawDisplay() {
    if (!res || lost) return;
    const p = res.disp;
    const texel = 1 / simSize;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.useProgram(p.p);
    bindTex(p.u('u_state'), res.tex[src]);
    gl.uniform2f(p.u('u_texel'), texel, texel);
    gl.uniform1f(p.u('u_aspect'), canvas.width / canvas.height);
    gl.uniform1i(p.u('u_count'), pal.count);
    gl.uniform1fv(p.u('u_at'), pal.at);
    gl.uniform3fv(p.u('u_col'), pal.colors);
    drawQuad(p);
  }

  function applyPending() {
    if (!pending.length) return;
    for (let i = 0; i < pending.length; i++) splatOnce(pending[i]);
    pending.length = 0;
  }

  /* ---- loop ------------------------------------------------------- */
  function motionAllowed() { return !reducedMotion || opts.forceMotion; }
  function shouldRun() {
    return ready && !lost && !disposed && !opts.paused && !tabHidden && onscreen && motionAllowed() && opts.stepsPerFrame > 0;
  }
  function tick() {
    rafId = 0;
    if (!shouldRun()) return;
    applyPending();
    for (let i = 0; i < opts.stepsPerFrame; i++) simStep();
    drawDisplay();
    rafId = win.requestAnimationFrame(tick);
  }
  function refreshLoop() {
    if (shouldRun()) {
      if (!rafId) rafId = win.requestAnimationFrame(tick);
    } else {
      stopLoop();
      drawStill();
    }
  }
  function stopLoop() {
    if (rafId) win.cancelAnimationFrame(rafId);
    rafId = 0;
  }
  /** one-shot draw while the loop is idle */
  function drawStill() {
    if (!ready || lost || disposed) return;
    applyPending();
    drawDisplay();
  }
  /** With reduced motion, show a developed pattern instead of raw seed noise. */
  function developStill() {
    if (motionAllowed() || pattern === 'blank') return;
    for (let i = 0; i < opts.stillFrameSteps; i++) simStep();
  }

  /* ---- environment ------------------------------------------------ */
  function onVisibility() {
    tabHidden = !!doc.hidden;
    refreshLoop();
  }
  function onMotionChange() {
    reducedMotion = !!(motionQuery && motionQuery.matches);
    refreshLoop();
  }
  function resize() {
    if (disposed) return;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (!cssW || !cssH) return;
    const dpr = Math.min(opts.maxPixelRatio, win.devicePixelRatio || 1) * opts.resolutionScale;
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    if (!rafId) drawStill();
  }

  /** @param {Event} e */
  function onContextLost(e) {
    e.preventDefault(); // tells the browser we want the context back
    lost = true;
    ready = false;
    stopLoop();
    res = null; // every object died with the context
    safe(cb.onContextLost);
  }
  function onContextRestored() {
    if (disposed) return;
    lost = false;
    const err = initGL();
    if (err) {
      unsupported = true;
      safe(cb.onFallback, err);
      return;
    }
    seedField(pattern, seedValue); // the evolved field is gone; regrow from the same seed
    ready = true;
    developStill();
    drawDisplay();
    refreshLoop();
    safe(cb.onContextRestored, getInfo());
  }

  /* ---- pointer painting -------------------------------------------- */

  /** CSS-pixel event position → field coordinates (x in aspect units, y 0 at top of the field). */
  /** @param {PointerEvent} e */
  function toField(e) {
    const rect = canvas.getBoundingClientRect();
    const fx = (e.clientX - rect.left) / rect.width;
    const fy = (e.clientY - rect.top) / rect.height;
    const aspect = rect.width / rect.height;
    // The display pass puts texture v = 0 at the bottom of the canvas, so
    // flip y: the exhibit before this package painted mirrored vertically.
    return { X: fx * aspect, Y: 1 - fy, rectH: rect.height };
  }
  /** @param {number} u @param {number} v @param {number} radiusPx @param {number} rectH @param {number} amount */
  function queueSplat(u, v, radiusPx, rectH, amount) {
    if (pending.length > 500) return;
    const r = clamp(radiusPx / rectH, 0.008, 0.5);
    pending.push({ u: u - Math.floor(u), v: clamp(v, 0, 1), r, amt: amount });
  }
  /** @param {PointerEvent} e */
  function onPointerDown(e) {
    if (e.button !== undefined && e.button !== 0 && e.pointerType === 'mouse') return;
    painting = true;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* synthetic events */ }
    const p = toField(e);
    lastX = p.X; lastY = p.Y;
    queueSplat(p.X, p.Y, opts.brushSize, p.rectH, 0.9);
    safe(cb.onPaintStart);
    if (!rafId) drawStill();
    e.preventDefault();
  }
  /** @param {PointerEvent} e */
  function onPointerMove(e) {
    if (!painting) return;
    const p = toField(e);
    const dx = p.X - lastX, dy = p.Y - lastY;
    const dist = Math.sqrt(dx * dx + dy * dy);
    const rr = opts.brushSize / p.rectH;
    const steps = Math.max(1, Math.min(60, Math.floor(dist / (rr * 0.5))));
    for (let i = 1; i <= steps; i++) queueSplat(lastX + (dx * i) / steps, lastY + (dy * i) / steps, opts.brushSize, p.rectH, 0.9);
    lastX = p.X; lastY = p.Y;
    if (!rafId) drawStill();
    e.preventDefault();
  }
  function onPointerUp() { painting = false; }

  function bindPointer() {
    if (pointerBound) return;
    pointerBound = true;
    prevTouchAction = canvas.style.touchAction;
    prevCursor = canvas.style.cursor;
    canvas.style.touchAction = 'none';
    canvas.style.cursor = 'crosshair';
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('lostpointercapture', onPointerUp);
  }
  function unbindPointer() {
    if (!pointerBound) return;
    pointerBound = false;
    painting = false;
    canvas.style.touchAction = prevTouchAction;
    canvas.style.cursor = prevCursor;
    canvas.removeEventListener('pointerdown', onPointerDown);
    canvas.removeEventListener('pointermove', onPointerMove);
    canvas.removeEventListener('pointerup', onPointerUp);
    canvas.removeEventListener('pointercancel', onPointerUp);
    canvas.removeEventListener('lostpointercapture', onPointerUp);
  }

  /* ---- public API -------------------------------------------------- */
  /** @param {EngineOptions} next */
  function update(next) {
    if (disposed) return;
    cb = pickCallbacks({ ...cb, ...next });
    const prev = opts;
    opts = normalizeOptions({ ...prev, ...next });
    const nextPal = resolvePalette(opts.palette);
    const palChanged = nextPal.key !== pal.key;
    pal = nextPal;

    if (opts.interactive !== prev.interactive) (opts.interactive ? bindPointer : unbindPointer)();
    if (opts.maxPixelRatio !== prev.maxPixelRatio || opts.resolutionScale !== prev.resolutionScale) resize();

    if (ready && !lost) {
      const gridChanged = targetGridSize() !== simSize;
      if (gridChanged) {
        try { allocTargets(targetGridSize()); } catch (err) { if (win.console) win.console.error('[reaction-diffusion] resize grid failed:', err); }
      }
      if (gridChanged || opts.seed !== prev.seed || opts.initialPattern !== prev.initialPattern) {
        seedField(opts.initialPattern, opts.seed);
        developStill();
        drawDisplay();
      } else if (palChanged && !rafId) {
        drawDisplay();
      }
    }
    refreshLoop();
  }

  /**
   * Re-seed the field. With no seed, uses the `seed` option, else a fresh random one.
   * @param {SeedPattern} [mode] @param {number} [seed]
   */
  function reset(mode, seed) {
    if (!ready || lost || disposed) return;
    seedField(mode || opts.initialPattern, seed !== undefined ? seed : opts.seed);
    developStill();
    drawDisplay();
    refreshLoop();
  }

  /** Run `steps` simulation steps now (default one frame's worth) and draw. @param {number} [steps] */
  function step(steps) {
    if (!ready || lost || disposed) return;
    applyPending();
    const n = Math.max(0, Math.round(steps === undefined ? opts.stepsPerFrame : steps));
    for (let i = 0; i < n; i++) simStep();
    drawDisplay();
  }

  /**
   * Paint chemical at a point given as fractions of the canvas box (0,0 top-left).
   * @param {number} x @param {number} y @param {SplatOptions} [o]
   */
  function splat(x, y, o = {}) {
    if (!ready || lost || disposed) return;
    const rect = canvas.getBoundingClientRect();
    const h = rect.height || canvas.clientHeight || 1;
    const aspect = (rect.width || canvas.clientWidth || 1) / h;
    queueSplat(x * aspect, 1 - y, num(o.radius, opts.brushSize), h, clamp(num(o.amount, 0.9), 0, 1));
    if (!rafId) drawStill();
  }

  /** Draw the current field and return it as a data URL. */
  /** @param {string} [type] @param {number} [quality] */
  function snapshot(type = 'image/png', quality) {
    if (!ready || lost || disposed) return '';
    applyPending();
    drawDisplay();
    return canvas.toDataURL(type, quality);
  }

  /** @returns {EngineInfo} */
  function getInfo() {
    return {
      status: disposed ? 'disposed' : unsupported ? 'unsupported' : lost ? 'lost' : rafId ? 'running' : 'idle',
      webgl: isGL2 ? 2 : 1,
      format: fmt ? fmt.name : null,
      gridSize: simSize,
      seed: seedValue,
      reducedMotion,
    };
  }

  /**
   * Stop, remove every listener and observer, and delete every GL object.
   * `loseContext: true` also releases the context itself right away, which is
   * what a component that created its own canvas wants; never use it on a
   * canvas you will call getContext on again.
   * @param {{ loseContext?: boolean }} [o]
   */
  function dispose(o = {}) {
    if (disposed) return;
    stopLoop();
    unbindPointer();
    canvas.removeEventListener('webglcontextlost', onContextLost, false);
    canvas.removeEventListener('webglcontextrestored', onContextRestored, false);
    doc.removeEventListener('visibilitychange', onVisibility);
    if (motionQuery) removeMQListener(motionQuery, onMotionChange);
    if (ro) ro.disconnect(); else win.removeEventListener('resize', resize);
    if (io) io.disconnect();
    freeGL();
    disposed = true;
    ready = false;
    pending = [];
    if (o.loseContext && gl && !gl.isContextLost()) {
      const ext = gl.getExtension('WEBGL_lose_context');
      if (ext) ext.loseContext();
    }
    gl = null;
  }
}

/** @param {EngineOptions} o */
function pickCallbacks(o) {
  return {
    onReady: o.onReady, onFallback: o.onFallback, onContextLost: o.onContextLost,
    onContextRestored: o.onContextRestored, onPaintStart: o.onPaintStart,
  };
}

/** @param {Function | undefined} fn @param {...unknown} args */
function safe(fn, ...args) {
  if (typeof fn !== 'function') return;
  try { fn(...args); } catch (e) { setTimeout(() => { throw e; }); }
}

/** @param {MediaQueryList} mq @param {() => void} fn */
function addMQListener(mq, fn) {
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', fn);
  else if (typeof mq.addListener === 'function') mq.addListener(fn);
}
/** @param {MediaQueryList} mq @param {() => void} fn */
function removeMQListener(mq, fn) {
  if (typeof mq.removeEventListener === 'function') mq.removeEventListener('change', fn);
  else if (typeof mq.removeListener === 'function') mq.removeListener(fn);
}
