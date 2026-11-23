// Headless browser checks for the component and the exhibit page.
//
//   npm run test:browser                  (builds the harness first)
//   node scripts/browser-check.mjs --browsers=chromium,firefox,webkit --perf
//
// Serves the repo and the pre-component exhibit (extracted from git at
// REFERENCE) from its own server on a free port, then checks:
//   look      component and refactored page are pixel-identical to the original
//             after the same number of frames with the same seed
//   mounts    50 StrictMode mount/unmount cycles leave no GL objects or contexts
//   motion    prefers-reduced-motion renders a developed still frame, no loop
//   context   WEBGL_lose_context loss and restore recover the field
//   fallback  no WebGL -> static fallback, no errors
//   pausing   off-screen and hidden-tab pausing
//   paint     a pointer press paints under the pointer
//   layout    demo page at 1440px and 390px: no horizontal overflow, no errors
//   perf      (--perf) ms per frame at two sizes on the GPU
import { chromium, firefox, webkit } from 'playwright';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DETERMINISTIC, framesAndRead, diff, stats } from '../test/browser/compare.mjs';

const REFERENCE = 'c0ac335'; // last commit before the component: the exhibit as it shipped
const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, '..');
const repo = join(pkg, '..');
const outDir = join(pkg, 'test-results');
mkdirSync(outDir, { recursive: true });

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const browserNames = String(args.browsers || 'chromium').split(',');
const wantPerf = !!args.perf;

/* ---- the original exhibit, straight from git ---- */
const original = mkdtempSync(join(tmpdir(), 'rd-original-'));
for (const f of ['index.html', 'diffusion.js', 'lab.css']) {
  writeFileSync(join(original, f), execFileSync('git', ['show', `${REFERENCE}:${f}`], { cwd: repo }));
}

/* ---- static server on a free port ---- */
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.map': 'application/json', '.png': 'image/png' };
const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const [, root, ...rest] = url.pathname.split('/');
  const base = root === 'repo' ? repo : root === 'original' ? original : null;
  let file = base && normalize(join(base, ...rest.map(decodeURIComponent)));
  if (file && existsSync(file) && statSync(file).isDirectory()) file = join(file, 'index.html');
  if (!file || !file.startsWith(base) || !existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;
const HARNESS = `${BASE}/repo/component/demo/dist/harness.html`;
const DEMO = `${BASE}/repo/component/demo/dist/index.html`;
const SITE = `${BASE}/repo/index.html`;
const ORIGINAL = `${BASE}/original/index.html`;

/* ---- reporting ---- */
const results = [];
let failed = 0;
function record(browser, name, ok, detail) {
  results.push({ browser, name, ok, detail });
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  [${browser}] ${name}${detail ? '  ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)) : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const watchErrors = (page, list) => {
  page.on('pageerror', (e) => list.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' || /too many active webgl/i.test(m.text())) list.push(m.text()); });
};

async function rendererOf(page) {
  return page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return 'no webgl2';
    const e = gl.getExtension('WEBGL_debug_renderer_info');
    return e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  });
}

/* ================================================================== */

async function lookCheck(browser, label) {
  for (const vw of [1440, 390]) {
    const ctx = await browser.newContext({ viewport: { width: vw, height: 900 }, deviceScaleFactor: 1 });
    await ctx.addInitScript(DETERMINISTIC);
    const o = await ctx.newPage(); await o.goto(ORIGINAL);
    const s = await ctx.newPage(); await s.goto(SITE);
    const errs = []; watchErrors(s, errs);
    for (const p of [o, s]) await p.waitForFunction(() => /\d+×\d+/.test(document.querySelector('#rd-status').textContent));
    const box = await o.evaluate(() => { const r = document.querySelector('#rd-canvas').getBoundingClientRect(); return { w: r.width, h: r.height }; });
    const c = await ctx.newPage(); watchErrors(c, errs); await c.goto(HARNESS);
    await c.evaluate((b) => window.rd.mount({ seed: 123 }, { box: { width: b.w + 'px', height: b.h + 'px' } }), box);
    let worst = { component: 0, site: 0 };
    for (const [frames, total] of [[1, 1], [49, 50], [150, 200]]) {
      const A = await framesAndRead(o, '#rd-canvas', frames);
      const B = await framesAndRead(c, 'canvas', frames);
      const S = await framesAndRead(s, '#rd-canvas', frames);
      const dc = diff(A, B), ds = diff(A, S);
      worst.component = Math.max(worst.component, dc.maxChannelDiff ?? 255);
      worst.site = Math.max(worst.site, ds.maxChannelDiff ?? 255);
      if (total === 200) {
        const st = stats(A);
        record(label, `look ${vw}px: component vs original after ${total} frames (${total * 12} steps), seed 123`, dc.sameSize && dc.maxChannelDiff <= 2, { ...dc, original: st });
        record(label, `look ${vw}px: exhibit page vs original after ${total} frames`, ds.sameSize && ds.maxChannelDiff <= 2, ds);
        await o.locator('#rd-hint').evaluate((e) => { e.style.display = 'none'; });
        await o.locator('#rd-canvas').screenshot({ path: join(outDir, `${label}-${vw}-original.png`) });
        await c.locator('canvas').screenshot({ path: join(outDir, `${label}-${vw}-component.png`) });
      }
    }
    record(label, `look ${vw}px: worst channel diff over 1/50/200 frames`, worst.component <= 2 && worst.site <= 2, worst);
    record(label, `look ${vw}px: no page errors`, errs.length === 0, errs.slice(0, 3));
    await ctx.close();
  }
}

async function harnessPage(browser, opts = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1, ...opts.context });
  if (opts.init) await ctx.addInitScript(opts.init);
  const page = await ctx.newPage();
  const errs = []; watchErrors(page, errs);
  await page.goto(HARNESS);
  return { ctx, page, errs };
}

async function mountsCheck(browser, label) {
  const { ctx, page, errs } = await harnessPage(browser);
  const res = await page.evaluate(async () => {
    const perCycle = [];
    for (let i = 0; i < 50; i++) {
      window.rd.mount({ seed: i }, { box: { width: '400px', height: '300px' } });
      await new Promise(requestAnimationFrame);
      const mounted = window.rd.live();
      window.rd.unmount();
      perCycle.push({ mounted, after: window.rd.live() });
    }
    return { first: perCycle[0], last: perCycle[49], leakyCycles: perCycle.filter((c) => Object.values(c.after).some((n) => n !== 0)).length, counts: window.rd.counts(), readyEvents: window.rd.events.filter((e) => e[0] === 'ready').length };
  });
  const ok = res.leakyCycles === 0 && res.last.mounted.contexts === 1 && res.last.mounted.Texture === 2;
  record(label, '50 StrictMode mount/unmount cycles: live GL objects and contexts return to 0', ok, res);
  // After the churn, a fresh instance must be alive and keep running.
  await page.evaluate(() => window.rd.mount({ seed: 5 }, { box: { width: '400px', height: '300px' } }));
  await sleep(500);
  const survivor = await page.evaluate(() => ({ status: window.rd.info().status, lost: window.rd.gl().isContextLost(), events: window.rd.events.slice(-3).map((e) => e[0]) }));
  record(label, 'after 50 cycles a new instance is running with a live context', survivor.status === 'running' && !survivor.lost && !survivor.events.includes('lost'), survivor);
  // WebKit counts explicitly lost contexts against its 16-context cap until
  // garbage collection, so 100 contexts in a tight loop log its eviction
  // warning (and a follow-on "already lost" warning) even though every one was
  // released. Anything else is an error.
  const webkitGc = /too many active webgl contexts|loseContext: context already lost/i;
  const real = errs.filter((e) => !(label === 'webkit' && webkitGc.test(e)));
  record(label, 'mount cycles: no errors' + (label === 'webkit' ? ' (WebKit GC-timing context warnings reported separately)' : ' or context-limit warnings'), real.length === 0, real.slice(0, 3));
  if (label === 'webkit') console.log(`NOTE  [webkit] ${errs.length - real.length} WebKit context-cap warnings during 100 context creations (expected until GC; see README)`);
  await ctx.close();
}

async function motionCheck(browser, label) {
  const { ctx, page, errs } = await harnessPage(browser, { context: { reducedMotion: 'reduce' } });
  await page.evaluate(() => window.rd.mount({ seed: 123 }, { box: { width: '600px', height: '400px' } }));
  await sleep(400);
  const info = await page.evaluate(() => window.rd.info());
  const a = await page.locator('canvas').screenshot();
  await sleep(600);
  const b = await page.locator('canvas').screenshot();
  writeFileSync(join(outDir, `${label}-reduced-motion.png`), a);
  record(label, 'reduced motion: no animation loop, frame unchanged after 600 ms', info.status === 'idle' && info.reducedMotion && a.equals(b), info);
  // compare against the bare seed (blank noise dots) to prove it is a developed pattern
  await page.evaluate(() => { window.rd.unmount(); window.rd.mount({ seed: 123, stillFrameSteps: 0 }, { box: { width: '600px', height: '400px' } }); });
  await sleep(300);
  const raw = await page.locator('canvas').screenshot();
  record(label, 'reduced motion: still frame is a developed pattern, not raw seed noise', !raw.equals(a));
  await page.evaluate(() => { window.rd.unmount(); window.rd.mount({ seed: 123, forceMotion: true }, { box: { width: '600px', height: '400px' } }); });
  await sleep(300);
  record(label, 'reduced motion + forceMotion: animates', (await page.evaluate(() => window.rd.info().status)) === 'running');
  record(label, 'reduced motion: no errors', errs.length === 0, errs.slice(0, 3));
  await ctx.close();
}

async function contextCheck(browser, label) {
  const { ctx, page, errs } = await harnessPage(browser);
  await page.evaluate(() => window.rd.mount({ seed: 9 }, { box: { width: '600px', height: '400px' } }));
  await sleep(300);
  const r = await page.evaluate(async () => {
    const ext = window.rd.gl().getExtension('WEBGL_lose_context');
    ext.loseContext();
    await new Promise((res) => setTimeout(res, 200));
    const during = window.rd.info().status;
    ext.restoreContext();
    await new Promise((res) => setTimeout(res, 400));
    return { during, after: window.rd.info().status, events: window.rd.events.map((e) => e[0]) };
  });
  const shot = await page.locator('canvas').screenshot();
  writeFileSync(join(outDir, `${label}-after-context-restore.png`), shot);
  const ok = r.during === 'lost' && r.after === 'running' && r.events.includes('lost') && r.events.includes('restored');
  record(label, 'context loss via WEBGL_lose_context, then restore: field regrows and runs', ok, r);
  record(label, 'context loss: no errors', errs.length === 0, errs.slice(0, 3));
  await ctx.close();
}

async function fallbackCheck(browser, label) {
  const init = `(() => { const g = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (t, ...a) { return /webgl/.test(t) ? null : g.call(this, t, ...a); }; })();`;
  const { ctx, page, errs } = await harnessPage(browser, { init });
  await page.evaluate(() => window.rd.mount({}, { box: { width: '600px', height: '400px' } }));
  await sleep(100);
  const r = await page.evaluate(() => ({
    mode: document.querySelector('[data-reaction-diffusion]').dataset.reactionDiffusion,
    events: window.rd.events.map((e) => e[0] + (e[1] && e[1].code ? ':' + e[1].code : '')),
    canvasVisible: [...document.querySelectorAll('canvas')].some((c) => c.style.display !== 'none'),
  }));
  record(label, 'no WebGL: static fallback, onFallback(no-webgl), canvas hidden, no errors', r.mode === 'fallback' && r.events.includes('fallback:no-webgl') && !r.canvasVisible && errs.length === 0, r);
  const site = await ctx.newPage(); const siteErrs = []; watchErrors(site, siteErrs);
  await site.goto(SITE);
  const shown = await site.evaluate(() => document.querySelector('#rd-fallback').classList.contains('show'));
  record(label, 'no WebGL: exhibit page shows its fallback message', shown && siteErrs.length === 0, siteErrs.slice(0, 3));
  await ctx.close();
}

async function pausingCheck(browser, label) {
  const { ctx, page } = await harnessPage(browser);
  await page.evaluate(() => {
    document.body.insertAdjacentHTML('afterbegin', '<div id="spacer" style="height:3000px"></div>');
    window.rd.mount({}, { box: { width: '600px', height: '400px' } });
  });
  await sleep(300);
  const offscreen = await page.evaluate(() => window.rd.info().status);
  await page.locator('canvas').scrollIntoViewIfNeeded();
  await sleep(300);
  const onscreen = await page.evaluate(() => window.rd.info().status);
  const hidden = await page.evaluate(async () => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    const s = window.rd.info().status;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
    return [s, window.rd.info().status];
  });
  record(label, 'pauses off screen (IntersectionObserver) and in a hidden tab, resumes after', offscreen === 'idle' && onscreen === 'running' && hidden[0] === 'idle' && hidden[1] === 'running', { offscreen, onscreen, hidden });
  await ctx.close();
}

async function paintCheck(browser, label) {
  const { ctx, page } = await harnessPage(browser);
  await page.evaluate(() => window.rd.mount({ interactive: true, paused: true, initialPattern: 'blank' }, { box: { width: '600px', height: '400px' } }));
  await sleep(200);
  const box = await page.locator('canvas').boundingBox();
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.15);
  await page.mouse.down(); await page.mouse.up();
  await sleep(200);
  const png = await page.locator('canvas').screenshot();
  const c = await page.evaluate(async (b64) => {
    const img = new Image(); img.src = 'data:image/png;base64,' + b64; await img.decode();
    const o = document.createElement('canvas'); o.width = img.width; o.height = img.height;
    const g = o.getContext('2d'); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, o.width, o.height).data;
    let sy = 0, n = 0;
    for (let y = 0; y < o.height; y++) for (let x = 0; x < o.width; x++) if (d[(y * o.width + x) * 4 + 1] > 60) { sy += y; n++; }
    return { n, cy: sy / n / o.height };
  }, png.toString('base64'));
  record(label, 'pointer paints where pressed (y 0.15 from top)', c.n > 0 && Math.abs(c.cy - 0.15) < 0.03, { centroidY: +c.cy.toFixed(3) });
  await ctx.close();
}

async function layoutCheck(browser, label) {
  for (const width of [1440, 390]) {
    const ctx = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, deviceScaleFactor: width === 390 ? 3 : 1 });
    const overflowOf = async (url) => {
      const page = await ctx.newPage(); await page.goto(url); await sleep(500);
      const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      await page.close(); return o;
    };
    // The shipped exhibit already overflows at 390px (its preset chip row);
    // the check here is that the page is no worse than the original.
    const allowed = { demo: 0, exhibit: await overflowOf(ORIGINAL) };
    for (const [name, url] of [['demo', DEMO], ['exhibit', SITE]]) {
      const page = await ctx.newPage();
      const errs = []; watchErrors(page, errs);
      await page.goto(url);
      await sleep(800);
      const r = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        canvas: (() => { const c = document.querySelector('canvas'); return c ? [c.width, c.height, Math.round(c.getBoundingClientRect().width)] : null; })(),
      }));
      await page.screenshot({ path: join(outDir, `${label}-${name}-${width}.png`) });
      const what = allowed[name] > 0 ? `horizontal overflow no worse than the original (${allowed[name]}px, pre-existing)` : 'no horizontal overflow';
      record(label, `${name} at ${width}px: ${what}, canvas sized, no errors`, r.overflow <= allowed[name] && r.canvas && r.canvas[0] > 0 && errs.length === 0, { ...r, errors: errs.slice(0, 3) });
      await page.close();
    }
    await ctx.close();
  }
}

async function perfCheck(browser, label) {
  const rows = [];
  for (const [w, h, dpr, grid] of [[1280, 720, 2, 512], [390, 260, 3, 512], [1280, 720, 2, 256]]) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: dpr });
    const page = await ctx.newPage();
    await page.goto(HARNESS);
    await page.evaluate(({ w, h, grid }) => window.rd.mount({ seed: 1, paused: true, gridSize: grid }, { box: { width: w + 'px', height: h + 'px' } }), { w, h, grid });
    await sleep(200);
    const ms = await page.evaluate(() => {
      const gl = window.rd.gl(); const px = new Uint8Array(4);
      const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
      for (let i = 0; i < 30; i++) window.rd.handle.current.step(12); // warm-up
      sync();
      const N = 300;
      const t0 = performance.now();
      for (let i = 0; i < N; i++) window.rd.handle.current.step(12);
      sync();
      return (performance.now() - t0) / N;
    });
    const canvas = await page.evaluate(() => [window.rd.canvas().width, window.rd.canvas().height]);
    rows.push({ css: `${w}x${h}`, dpr, backbuffer: canvas.join('x'), grid, msPerFrame: +ms.toFixed(3) });
    await ctx.close();
  }
  record(label, 'perf: ms per frame (12 Gray-Scott steps + display), GPU-synced over 300 frames', true, rows);
  return rows;
}

/* ================================================================== */

const launchers = {
  chromium: () => chromium.launch(),                       // SwiftShader (software GL): deterministic baseline
  'chromium-gpu': () => chromium.launch({ channel: 'chromium' }), // new headless with the real GPU
  firefox: () => firefox.launch(),
  webkit: () => webkit.launch(),
};
const runs = browserNames.flatMap((n) => (n === 'chromium' ? ['chromium', 'chromium-gpu'] : [n]));
const renderers = {};
for (const name of runs) {
  let browser;
  try { browser = await launchers[name](); } catch (e) { record(name, 'launch', false, e.message.split('\n')[0]); continue; }
  const probe = await browser.newPage(); await probe.goto(HARNESS);
  renderers[name] = `${browser.version()} | ${await rendererOf(probe)}`;
  console.log(`\n== ${name}: ${renderers[name]}`);
  await probe.close();
  await lookCheck(browser, name);
  await mountsCheck(browser, name);
  await motionCheck(browser, name);
  await contextCheck(browser, name);
  await fallbackCheck(browser, name);
  await pausingCheck(browser, name);
  await paintCheck(browser, name);
  if (name === 'chromium-gpu' || name === 'chromium') await layoutCheck(browser, name);
  if (wantPerf && (name === 'chromium-gpu' || name === 'chromium')) await perfCheck(browser, name);
  await browser.close();
}
server.close();
writeFileSync(join(outDir, 'results.json'), JSON.stringify({ reference: REFERENCE, renderers, results }, null, 2));
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots and results.json in ${outDir}`);
process.exit(failed ? 1 : 0);
