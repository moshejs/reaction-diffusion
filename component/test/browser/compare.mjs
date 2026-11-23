// Shared helpers for the browser checks: deterministic frames and pixel reads.

/** Init script: fixed Math.random and a manual requestAnimationFrame queue. */
export const DETERMINISTIC = `
  Math.random = () => 0.123; // the exhibit seeds with Math.random() * 1000 -> 123
  (() => {
    const q = []; let id = 0;
    window.requestAnimationFrame = (cb) => { q.push([++id, cb]); return id; };
    window.cancelAnimationFrame = (i) => { const k = q.findIndex((e) => e[0] === i); if (k >= 0) q.splice(k, 1); };
    window.__frames = (n) => { for (let i = 0; i < n; i++) { const batch = q.splice(0); batch.forEach(([, cb]) => cb(performance.now())); } return q.length; };
    window.__pending = () => q.length;
  })();
`;

/**
 * Run `frames` animation frames on the page, then read the canvas back in the
 * same task (the drawing buffer is not preserved), returned as base64 RGBA.
 * @param {import('playwright').Page} page
 * @param {string} selector
 * @param {number} frames
 */
export async function framesAndRead(page, selector, frames) {
  return page.evaluate(({ selector, frames }) => {
    const c = /** @type {HTMLCanvasElement} */ (document.querySelector(selector));
    /** @type {any} */ (window).__frames(frames);
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    const w = c.width, h = c.height;
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let s = '';
    for (let i = 0; i < px.length; i += 0x8000) s += String.fromCharCode.apply(null, Array.from(px.subarray(i, i + 0x8000)));
    return { w, h, b64: btoa(s) };
  }, { selector, frames });
}

/** @param {{ w: number, h: number, b64: string }} a @param {{ w: number, h: number, b64: string }} b */
export function diff(a, b) {
  if (a.w !== b.w || a.h !== b.h) return { sameSize: false, a: [a.w, a.h], b: [b.w, b.h] };
  const A = Buffer.from(a.b64, 'base64'), B = Buffer.from(b.b64, 'base64');
  let differing = 0, max = 0, sum = 0;
  for (let i = 0; i < A.length; i += 4) {
    let m = 0;
    for (let c = 0; c < 3; c++) { const d = Math.abs(A[i + c] - B[i + c]); sum += d; if (d > m) m = d; }
    if (m > 2) differing++;
    if (m > max) max = m;
  }
  const n = A.length / 4;
  return { sameSize: true, pixels: n, identical: A.equals(B), differingPct: +(100 * differing / n).toFixed(4), maxChannelDiff: max, meanAbsDiff: +(sum / (n * 3)).toFixed(4) };
}

/** Mean luminance and the share of "bright" pixels, to tell a developed pattern from noise or black. */
export function stats(img) {
  const A = Buffer.from(img.b64, 'base64');
  let lum = 0, bright = 0;
  for (let i = 0; i < A.length; i += 4) {
    const l = 0.2126 * A[i] + 0.7152 * A[i + 1] + 0.0722 * A[i + 2];
    lum += l; if (l > 100) bright++;
  }
  const n = A.length / 4;
  return { meanLum: +(lum / n).toFixed(2), brightPct: +(100 * bright / n).toFixed(2) };
}
