// Browser-test harness: exposes window.rd so scripts/browser-check.mjs can
// mount, unmount and inspect the component. Not shipped.
import { createElement, StrictMode, createRef } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { ReactionDiffusion } from '../../src/index.js';

/* Count WebGL object creation and deletion on every context type. Installed
   before any component mounts. */
const counts = /** @type {Record<string, number>} */ ({});
const kinds = ['Texture', 'Framebuffer', 'Buffer', 'Program', 'Shader', 'Renderbuffer'];
for (const Ctx of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) {
  if (!Ctx) continue;
  for (const k of kinds) {
    for (const verb of ['create', 'delete']) {
      const name = verb + k;
      const orig = Ctx.prototype[name];
      if (!orig) continue;
      Ctx.prototype[name] = function (...args) {
        const key = verb + k;
        if (verb === 'delete' && !args[0]) return orig.apply(this, args);
        counts[key] = (counts[key] || 0) + 1;
        return orig.apply(this, args);
      };
    }
  }
}
let contexts = 0, contextsLost = 0;
const origGetContext = HTMLCanvasElement.prototype.getContext;
const seenCanvases = new WeakSet();
HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
  const ctx = origGetContext.call(this, type, ...rest);
  if (ctx && /webgl/.test(type) && !seenCanvases.has(this)) { seenCanvases.add(this); contexts++; }
  return ctx;
};
const loseProto = () => {
  const gl = origGetContext.call(document.createElement('canvas'), 'webgl2');
  const ext = gl && gl.getExtension('WEBGL_lose_context');
  if (ext) ext.loseContext();
  return ext && Object.getPrototypeOf(ext);
};
const LoseProto = loseProto();
if (LoseProto) {
  const orig = LoseProto.loseContext;
  LoseProto.loseContext = function () { contextsLost++; return orig.call(this); };
}

const host = document.getElementById('root');
const root = createRoot(host);
const handle = createRef();
const events = [];

function live() {
  const o = {};
  for (const k of kinds) o[k] = (counts['create' + k] || 0) - (counts['delete' + k] || 0);
  o.contexts = contexts - contextsLost;
  return o;
}

window.rd = {
  events,
  handle,
  counts: () => ({ ...counts, contexts, contextsLost }),
  live,
  /** @param {Record<string, any>} props @param {{ strict?: boolean, box?: Record<string, any> }} [o] */
  mount(props = {}, o = {}) {
    const el = createElement(ReactionDiffusion, {
      ref: handle,
      style: { width: '100%', height: '100%', ...(o.box || {}) },
      onReady: (info) => events.push(['ready', info]),
      onFallback: (r) => events.push(['fallback', r]),
      onContextLost: () => events.push(['lost']),
      onContextRestored: (info) => events.push(['restored', info]),
      ...props,
    });
    flushSync(() => root.render(o.strict === false ? el : createElement(StrictMode, null, el)));
  },
  unmount() {
    flushSync(() => root.render(null));
  },
  canvas: () => host.querySelector('canvas'),
  gl: () => {
    const c = host.querySelector('canvas');
    return c && (origGetContext.call(c, 'webgl2') || origGetContext.call(c, 'webgl'));
  },
  info: () => handle.current && handle.current.getInfo(),
};
