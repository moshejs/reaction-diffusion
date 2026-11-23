// A minimal fake browser + WebGL context for unit tests under node:test.
// Records GL object lifetimes, uniform writes, draw calls and listeners.

/** Stable numeric value for every GL constant name. */
const constant = (name) => {
  let h = 7;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h;
};

/**
 * @param {{ webgl2?: boolean, extensions?: string[], failCompile?: boolean }} [o]
 */
export function fakeGL(o = {}) {
  const exts = new Set(o.extensions ?? ['EXT_color_buffer_float', 'EXT_color_buffer_half_float', 'OES_texture_float_linear', 'WEBGL_lose_context']);
  const log = {
    live: /** @type {Record<string, number>} */ ({}),
    created: /** @type {Record<string, number>} */ ({}),
    uniforms: /** @type {Record<string, any>} */ ({}),
    uniformHistory: /** @type {[string, any][]} */ ([]),
    draws: 0,
    lost: false,
    lostCalls: 0,
  };
  let id = 0;
  /** @type {any} */
  let gl;
  const make = (kind) => () => {
    log.live[kind] = (log.live[kind] || 0) + 1;
    log.created[kind] = (log.created[kind] || 0) + 1;
    return { kind, id: ++id };
  };
  const del = (kind) => (obj) => {
    if (!obj) return;
    if (obj.deleted) throw new Error('double delete of ' + kind);
    obj.deleted = true;
    log.live[kind] -= 1;
  };
  let currentProgram = null;
  const target = {
    log,
    createTexture: make('texture'), deleteTexture: del('texture'),
    createFramebuffer: make('framebuffer'), deleteFramebuffer: del('framebuffer'),
    createBuffer: make('buffer'), deleteBuffer: del('buffer'),
    createProgram: make('program'), deleteProgram: del('program'),
    createShader: make('shader'), deleteShader: del('shader'),
    getExtension: (name) => {
      if (!exts.has(name)) return null;
      if (name === 'WEBGL_lose_context') {
        return {
          loseContext: () => { log.lost = true; log.lostCalls++; },
          restoreContext: () => { log.lost = false; },
        };
      }
      return { HALF_FLOAT_OES: constant('HALF_FLOAT_OES') };
    },
    checkFramebufferStatus: () => gl.FRAMEBUFFER_COMPLETE,
    getError: () => gl.NO_ERROR,
    getShaderParameter: () => !o.failCompile,
    getShaderInfoLog: () => 'fake compile error',
    getProgramParameter: () => true,
    getProgramInfoLog: () => '',
    getParameter: (p) => (p === gl.MAX_TEXTURE_SIZE ? 4096 : 0),
    getUniformLocation: (p, name) => ({ program: p, name }),
    getAttribLocation: () => 0,
    isContextLost: () => log.lost,
    useProgram: (p) => { currentProgram = p; },
    drawArrays: () => { log.draws++; },
  };
  const setUniform = (loc, ...v) => {
    if (!loc) return;
    const value = v.length === 1 ? v[0] : v;
    log.uniforms[loc.name] = value;
    log.uniformHistory.push([loc.name, value]);
  };
  for (const fn of ['uniform1f', 'uniform1i', 'uniform2f', 'uniform1fv', 'uniform3fv']) target[fn] = setUniform;
  gl = new Proxy(target, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (typeof prop === 'string' && /^[A-Z0-9_]+$/.test(prop)) return constant(prop);
      return () => {};
    },
  });
  void currentProgram;
  return gl;
}

class FakeObserver {
  /** @param {Function} cb */
  constructor(cb) { this.cb = cb; this.observing = 0; this.disconnected = false; FakeObserver.instances.push(this); }
  observe() { this.observing++; }
  disconnect() { this.disconnected = true; this.observing = 0; }
}
FakeObserver.instances = /** @type {FakeObserver[]} */ ([]);

/** Wraps an EventTarget so the number of live listeners can be read. */
function countingTarget() {
  const t = new EventTarget();
  const live = new Set();
  const add = t.addEventListener.bind(t), remove = t.removeEventListener.bind(t);
  t.addEventListener = (type, fn, opt) => { live.add(type + ':' + (fn.name || fn)); live.add(fn); add(type, fn, opt); };
  t.removeEventListener = (type, fn, opt) => { live.delete(type + ':' + (fn.name || fn)); live.delete(fn); remove(type, fn, opt); };
  /** @type {any} */ (t).listenerCount = () => [...live].filter((x) => typeof x === 'function').length;
  return /** @type {any} */ (t);
}

/**
 * @param {{ webgl?: false | 1 | 2, reducedMotion?: boolean, hidden?: boolean, glOptions?: Parameters<typeof fakeGL>[0] }} [o]
 */
export function fakeEnvironment(o = {}) {
  const raf = /** @type {Map<number, Function>} */ (new Map());
  let rafId = 0;
  const mqListeners = new Set();
  const mq = {
    matches: !!o.reducedMotion,
    addEventListener: (_t, fn) => mqListeners.add(fn),
    removeEventListener: (_t, fn) => mqListeners.delete(fn),
  };
  const resizeObservers = [];
  const intersectionObservers = [];
  const win = countingTarget();
  Object.assign(win, {
    devicePixelRatio: 3,
    console: { error() {}, warn() {}, log() {} },
    requestAnimationFrame: (fn) => { raf.set(++rafId, fn); return rafId; },
    cancelAnimationFrame: (i) => { raf.delete(i); },
    matchMedia: () => mq,
    ResizeObserver: class extends FakeObserver { constructor(cb) { super(cb); resizeObservers.push(this); } },
    IntersectionObserver: class extends FakeObserver { constructor(cb) { super(cb); intersectionObservers.push(this); } },
  });
  const doc = countingTarget();
  doc.hidden = !!o.hidden;
  doc.defaultView = win;

  const contexts = [];
  const webgl = o.webgl === undefined ? 2 : o.webgl;
  function makeCanvas(cssW = 600, cssH = 400) {
    const c = countingTarget();
    let ctx = null;
    Object.assign(c, {
      ownerDocument: doc,
      width: 300, height: 150,
      clientWidth: cssW, clientHeight: cssH,
      style: {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: c.clientWidth, height: c.clientHeight }),
      toDataURL: (type) => 'data:' + (type || 'image/png') + ';base64,AAAA',
      setPointerCapture() {},
      getContext(type) {
        if (ctx) return ctx.type === type ? ctx.gl : null;
        if (webgl === false) return null;
        if (type === 'webgl2' && webgl !== 2) return null;
        if (!/^(webgl2|webgl|experimental-webgl)$/.test(type)) return null;
        ctx = { type, gl: fakeGL(o.glOptions) };
        contexts.push(ctx.gl);
        return ctx.gl;
      },
    });
    return c;
  }

  return {
    win, doc, mq, contexts, makeCanvas, resizeObservers, intersectionObservers,
    /** Run queued animation frames. */
    frames(n = 1) {
      for (let i = 0; i < n; i++) {
        const batch = [...raf.entries()];
        raf.clear();
        for (const [, fn] of batch) fn(0);
      }
    },
    pendingFrames: () => raf.size,
    setReducedMotion(v) { mq.matches = v; for (const fn of mqListeners) fn(); },
    mqListenerCount: () => mqListeners.size,
    setHidden(v) { doc.hidden = v; doc.dispatchEvent(new Event('visibilitychange')); },
  };
}
