import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createReactionDiffusion, normalizeOptions, resolvePalette, parseColor, simUniforms,
  wrapSeed, DEFAULTS, PALETTES, PRESETS, SHADERS, MAX_PALETTE_STOPS,
} from '../src/engine.js';
import { fakeEnvironment } from './fake-dom.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

/* ---------------------------------------------------------------- */
/*  Prop → uniform mapping                                           */
/* ---------------------------------------------------------------- */

test('defaults are the exhibit tuning: coral, Du 1, Dv 0.5, dt 1, 12 steps, lagoon', () => {
  const o = normalizeOptions({});
  assert.equal(o.feed, 0.0545);
  assert.equal(o.kill, 0.062);
  assert.deepEqual(simUniforms(o), { u_feed: 0.0545, u_kill: 0.062, u_du: 1, u_dv: 0.5, u_dt: 1 });
  assert.equal(o.stepsPerFrame, 12);
  assert.equal(o.palette, 'lagoon');
  assert.equal(o.maxPixelRatio, 2);
  assert.equal(o.interactive, false);
  assert.equal(o.forceMotion, false);
  assert.equal(o.seed, undefined);
  assert.deepEqual(PRESETS.coral, { feed: DEFAULTS.feed, kill: DEFAULTS.kill });
});

test('options are clamped into the stable range and junk falls back to defaults', () => {
  const o = normalizeOptions({ feed: -1, kill: 9, diffusionU: 5, diffusionV: Number.NaN, timestep: 3, stepsPerFrame: 1000, gridSize: 3, maxPixelRatio: 99, initialPattern: /** @type {any} */ ('nope') });
  assert.equal(o.feed, 0);
  assert.equal(o.kill, 0.12);
  assert.equal(o.diffusionU, 1.25);
  assert.equal(o.diffusionV, 0.5);
  assert.equal(o.timestep, 1);
  assert.equal(o.stepsPerFrame, 64);
  assert.equal(o.gridSize, 16);
  assert.equal(o.maxPixelRatio, 4);
  assert.equal(o.initialPattern, 'noise');
  // stability: largest diffusion * timestep the clamps allow, times the
  // stencil's worst eigenvalue (1.6), stays under the Euler limit of 2.
  assert.ok(1.25 * 1 * 1.6 <= 2);
});

test('seeds wrap into [0, 1000) like the exhibit, and 123 stays 123', () => {
  assert.equal(wrapSeed(123), 123);
  assert.equal(wrapSeed(1123), 123);
  assert.equal(wrapSeed(-1), 999);
});

test('built-in palettes resolve to the exhibit shader constants', () => {
  const lagoon = resolvePalette('lagoon');
  assert.equal(lagoon.count, 5);
  assert.deepEqual(Array.from(lagoon.at.subarray(0, 5)).map((x) => +x.toFixed(4)), [0, 0.35, 0.6, 0.82, 1]);
  close(lagoon.colors[3 * 2 + 0], 0.090);
  close(lagoon.colors[3 * 2 + 1], 0.584);
  close(lagoon.colors[3 * 2 + 2], 0.498);
  const ink = resolvePalette('ink');
  assert.equal(ink.count, 4);
  assert.deepEqual(Array.from(ink.at.subarray(0, 4)).map((x) => +x.toFixed(4)), [0, 0.45, 0.72, 1]);
  assert.equal(resolvePalette('mono').key, ink.key, '"mono" is the exhibit id for Ink');
  assert.deepEqual(Object.keys(PALETTES), ['lagoon', 'ember', 'ink', 'bio']);
});

test('custom palettes: hex and rgb, sorted, 2..8 stops', () => {
  const p = resolvePalette([{ at: 1, color: '#fff' }, { at: 0, color: [0, 0.5, 1] }]);
  assert.equal(p.count, 2);
  assert.deepEqual(Array.from(p.colors.subarray(0, 6)), [0, 0.5, 1, 1, 1, 1]);
  assert.deepEqual(parseColor('#2fd6c3').map((x) => Math.round(x * 255)), [0x2f, 0xd6, 0xc3]);
  assert.throws(() => resolvePalette([{ at: 0, color: '#000' }]), RangeError);
  assert.throws(() => resolvePalette(Array.from({ length: MAX_PALETTE_STOPS + 1 }, (_, i) => ({ at: i / 9, color: '#000' }))), RangeError);
  assert.throws(() => resolvePalette(/** @type {any} */ ('neon')), TypeError);
  assert.throws(() => parseColor('red'), TypeError);
});

test('shaders: Gray-Scott update and Karl Sims Laplacian weights are intact', () => {
  assert.match(SHADERS.FRAG_SIM, /float dU = \(u_du\*lapU - uvv \+ u_feed\*\(1\.0-U\)\) \* u_dt;/);
  assert.match(SHADERS.FRAG_SIM, /float dV = \(u_dv\*lapV \+ uvv - \(u_feed\+u_kill\)\*V\) \* u_dt;/);
  assert.match(SHADERS.FRAG_SIM, /0\.2\*\(READ_U/);
  assert.match(SHADERS.FRAG_SIM, /0\.05\*\(READ_U/);
  assert.match(SHADERS.FRAG_DISPLAY, /uniform vec3 u_col\[8\]/);
});

/* ---------------------------------------------------------------- */
/*  Lifecycle against a mocked GL context                            */
/* ---------------------------------------------------------------- */

test('creates programs, quad and two state targets, and uploads the uniforms', () => {
  const env = fakeEnvironment();
  const canvas = env.makeCanvas(600, 400);
  /** @type {any[]} */ const ready = [];
  const rd = createReactionDiffusion(canvas, { seed: 123, onReady: (i) => ready.push(i) });
  const gl = env.contexts[0];
  assert.equal(gl.log.live.program, 4);
  assert.equal(gl.log.live.buffer, 1);
  assert.equal(gl.log.live.texture, 2);
  assert.equal(gl.log.live.framebuffer, 2);
  assert.equal(gl.log.live.shader, 0, 'shaders are deleted after linking');
  assert.equal(ready.length, 1);
  assert.deepEqual(ready[0], { status: 'running', webgl: 2, format: 'half-float', gridSize: 512, seed: 123, reducedMotion: false });
  assert.equal(gl.log.uniforms.u_seed, 123);
  assert.equal(gl.log.uniforms.u_mode, 1);

  // backbuffer: CSS size times min(devicePixelRatio 3, cap 2)
  assert.equal(canvas.width, 1200);
  assert.equal(canvas.height, 800);

  env.frames(1);
  assert.equal(gl.log.uniforms.u_feed, 0.0545);
  assert.equal(gl.log.uniforms.u_kill, 0.062);
  assert.equal(gl.log.uniforms.u_du, 1);
  assert.equal(gl.log.uniforms.u_dv, 0.5);
  assert.equal(gl.log.uniforms.u_aspect, 1.5);
  assert.equal(gl.log.uniforms.u_count, 5);

  const draws = gl.log.draws;
  env.frames(1);
  assert.equal(gl.log.draws - draws, 13, '12 simulation steps + 1 display pass per frame');

  rd.update({ feed: 0.0367, kill: 0.0649, palette: 'ink', stepsPerFrame: 3 });
  const d2 = gl.log.draws;
  env.frames(1);
  assert.equal(gl.log.uniforms.u_feed, 0.0367);
  assert.equal(gl.log.uniforms.u_kill, 0.0649);
  assert.equal(gl.log.uniforms.u_count, 4);
  assert.equal(gl.log.draws - d2, 4);
  rd.dispose();
});

test('dispose deletes every GL object, listener and observer; 50 cycles leak nothing', () => {
  const env = fakeEnvironment();
  for (let i = 0; i < 50; i++) {
    const canvas = env.makeCanvas();
    const rd = createReactionDiffusion(canvas, { interactive: true });
    assert.ok(canvas.listenerCount() > 0);
    rd.dispose({ loseContext: true });
    const gl = env.contexts[i];
    for (const [kind, n] of Object.entries(gl.log.live)) assert.equal(n, 0, `${kind} leaked on cycle ${i}`);
    assert.equal(gl.log.lostCalls, 1, 'loseContext releases the context right away');
    assert.equal(canvas.listenerCount(), 0, 'canvas listeners removed');
    assert.equal(canvas.style.touchAction, undefined, 'touch-action restored');
    assert.equal(rd.getInfo().status, 'disposed');
  }
  assert.equal(env.doc.listenerCount(), 0, 'document listeners removed');
  assert.equal(env.mqListenerCount(), 0, 'media-query listeners removed');
  assert.ok(env.resizeObservers.every((o) => o.disconnected));
  assert.ok(env.intersectionObservers.every((o) => o.disconnected));
  assert.equal(env.pendingFrames(), 0, 'no animation frame left queued');
});

test('dispose is idempotent and methods are safe afterwards', () => {
  const env = fakeEnvironment();
  const rd = createReactionDiffusion(env.makeCanvas());
  rd.dispose();
  rd.dispose();
  rd.update({ feed: 0.03 });
  rd.reset();
  rd.step(10);
  rd.splat(0.5, 0.5);
  assert.equal(rd.snapshot(), '');
});

test('pauses for `paused`, a hidden tab and an off-screen canvas, and resumes', () => {
  const env = fakeEnvironment();
  const rd = createReactionDiffusion(env.makeCanvas());
  assert.equal(env.pendingFrames(), 1);
  assert.equal(rd.getInfo().status, 'running');

  rd.update({ paused: true });
  assert.equal(env.pendingFrames(), 0);
  assert.equal(rd.getInfo().status, 'idle');
  rd.update({ paused: false });
  assert.equal(env.pendingFrames(), 1);

  env.setHidden(true);
  assert.equal(env.pendingFrames(), 0);
  env.setHidden(false);
  assert.equal(env.pendingFrames(), 1);

  const io = env.intersectionObservers[0];
  io.cb([{ isIntersecting: false }]);
  assert.equal(env.pendingFrames(), 0);
  io.cb([{ isIntersecting: true }]);
  assert.equal(env.pendingFrames(), 1);
  rd.dispose();
});

test('prefers-reduced-motion renders one developed still frame unless forceMotion', () => {
  const env = fakeEnvironment({ reducedMotion: true });
  const rd = createReactionDiffusion(env.makeCanvas(), { stillFrameSteps: 100 });
  const gl = env.contexts[0];
  assert.equal(env.pendingFrames(), 0, 'no animation loop');
  assert.equal(rd.getInfo().status, 'idle');
  // seed pass + 100 still-frame steps + display passes
  assert.ok(gl.log.draws >= 102, 'pattern developed before the still frame: ' + gl.log.draws);

  rd.update({ forceMotion: true });
  assert.equal(env.pendingFrames(), 1, 'forceMotion animates');
  rd.update({ forceMotion: false });
  assert.equal(env.pendingFrames(), 0);

  env.setReducedMotion(false);
  assert.equal(env.pendingFrames(), 1, 'follows the OS setting live');
  rd.dispose();
});

test('context loss stops the loop; restore rebuilds resources and regrows the same seed', () => {
  const env = fakeEnvironment();
  const canvas = env.makeCanvas();
  const events = [];
  const rd = createReactionDiffusion(canvas, {
    seed: 42,
    onContextLost: () => events.push('lost'),
    onContextRestored: (i) => events.push('restored:' + i.seed),
  });
  const gl = env.contexts[0];
  const lostEvent = new Event('webglcontextlost', { cancelable: true });
  canvas.dispatchEvent(lostEvent);
  assert.equal(lostEvent.defaultPrevented, true, 'preventDefault asks the browser to restore');
  assert.equal(rd.getInfo().status, 'lost');
  assert.equal(env.pendingFrames(), 0);
  rd.step(5); // safe no-op while lost

  const before = gl.log.created.program;
  canvas.dispatchEvent(new Event('webglcontextrestored'));
  assert.equal(gl.log.created.program - before, 4, 'programs rebuilt');
  assert.equal(rd.getInfo().status, 'running');
  assert.equal(gl.log.uniforms.u_seed, 42);
  assert.deepEqual(events, ['lost', 'restored:42']);
  rd.dispose();
});

test('no WebGL: onFallback, unsupported status, no-op methods', () => {
  const env = fakeEnvironment({ webgl: false });
  const reasons = [];
  const rd = createReactionDiffusion(env.makeCanvas(), { onFallback: (r) => reasons.push(r) });
  assert.equal(reasons.length, 1);
  assert.equal(reasons[0].code, 'no-webgl');
  assert.equal(rd.getInfo().status, 'unsupported');
  rd.step(); rd.reset(); rd.splat(0, 0);
  assert.equal(rd.snapshot(), '');
  rd.dispose();
});

test('shader compile failure falls back and frees what was created', () => {
  const env = fakeEnvironment({ glOptions: { failCompile: true } });
  const reasons = [];
  createReactionDiffusion(env.makeCanvas(), { onFallback: (r) => reasons.push(r.code) });
  assert.deepEqual(reasons, ['init-failed']);
  const gl = env.contexts[0];
  for (const [kind, n] of Object.entries(gl.log.live)) assert.equal(n, 0, kind + ' leaked');
});

test('WebGL1 without float extensions uses packed 8-bit storage on a 256 grid', () => {
  const env = fakeEnvironment({ webgl: 1, glOptions: { extensions: [] } });
  const rd = createReactionDiffusion(env.makeCanvas());
  assert.deepEqual([rd.getInfo().webgl, rd.getInfo().format, rd.getInfo().gridSize], [1, 'byte', 256]);
  rd.dispose();
});

test('gridSize and seed changes reallocate and reseed without leaking', () => {
  const env = fakeEnvironment();
  const rd = createReactionDiffusion(env.makeCanvas(), { seed: 1 });
  const gl = env.contexts[0];
  rd.update({ gridSize: 128 });
  assert.equal(rd.getInfo().gridSize, 128);
  assert.equal(gl.log.live.texture, 2);
  assert.equal(gl.log.live.framebuffer, 2);
  rd.update({ seed: 7 });
  assert.equal(gl.log.uniforms.u_seed, 7);
  const seeds = gl.log.uniformHistory.filter(([n]) => n === 'u_seed').length;
  rd.update({ seed: 7, palette: [...PALETTES.lagoon] });
  assert.equal(gl.log.uniformHistory.filter(([n]) => n === 'u_seed').length, seeds, 'same seed + equal palette does not reseed');
  rd.dispose();
});

test('splat maps box fractions to field coordinates with y up (fixes the exhibit mirror)', () => {
  const env = fakeEnvironment();
  const rd = createReactionDiffusion(env.makeCanvas(600, 400), { paused: true });
  const gl = env.contexts[0];
  rd.splat(0.2, 0.15, { radius: 40 });
  const [u, v] = gl.log.uniforms.u_point;
  close(u, 0.2 * 1.5); // x is in aspect units: the field tiles horizontally
  close(v, 0.85);
  close(gl.log.uniforms.u_radius, 0.1);
  close(gl.log.uniforms.u_amount, 0.9);
  rd.dispose();
});

test('step() and snapshot() work while paused', () => {
  const env = fakeEnvironment();
  const rd = createReactionDiffusion(env.makeCanvas(), { paused: true });
  const gl = env.contexts[0];
  const d = gl.log.draws;
  rd.step(30);
  assert.equal(gl.log.draws - d, 31);
  assert.match(rd.snapshot(), /^data:image\/png/);
  rd.dispose();
});
