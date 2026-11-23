/* diffusion.js — the exhibit page's controls around a live Gray–Scott field.

   The renderer itself (shaders, ping-pong framebuffers, storage probing,
   context loss, pause-when-hidden) lives in component/src/engine.js, the same
   file the React component wraps, so the page and the component share one
   implementation. This file only wires the page's sliders, chips, buttons and
   parameter-space map to it. Zero dependencies, no build step. */
import { createReactionDiffusion, PRESETS } from './component/src/engine.js';

var $ = function (s) { return document.querySelector(s); };
var clamp01 = function (x) { return x < 0 ? 0 : x > 1 ? 1 : x; };

/* feed × kill slider ranges (must match the HTML input min/max) */
var FEED_MIN = 0.010, FEED_MAX = 0.090;
var KILL_MIN = 0.045, KILL_MAX = 0.070;
var STEPS_PER_FRAME = 12;

var canvas   = $("#rd-canvas");
var fallback = $("#rd-fallback");
var controls = $("#rd-controls");
var hintEl   = $("#rd-hint");

var state = { feed: PRESETS.coral.feed, kill: PRESETS.coral.kill, brush: 28, pal: "lagoon", paused: false };
var hintDismissed = false;

function showFallback(msg) {
  canvas.style.display = "none";
  if (hintEl) hintEl.style.display = "none";
  if (controls) controls.style.display = "none";
  fallback.classList.add("show");
  if (msg) {
    var p = document.createElement("p");
    p.className = "muted";
    p.style.fontSize = "13px";
    p.textContent = msg;
    fallback.appendChild(p);
  }
}

function dismissHint() {
  if (hintDismissed || !hintEl) return;
  hintDismissed = true;
  hintEl.classList.add("fade");
  setTimeout(function () { if (hintEl) hintEl.style.display = "none"; }, 450);
}

var field = createReactionDiffusion(canvas, {
  feed: state.feed,
  kill: state.kill,
  palette: state.pal,
  stepsPerFrame: STEPS_PER_FRAME,
  brushSize: state.brush,
  interactive: true,
  // The exhibit is the interactive piece itself and has its own Pause
  // button, so it keeps animating under prefers-reduced-motion as before.
  forceMotion: true,
  onPaintStart: dismissHint,
  onFallback: function (reason) {
    showFallback(reason.code === "no-webgl" ? "" : reason.message);
  },
});

/* ------------------------------------------------------------------ */
/*  Controls: sliders, chips, buttons, parameter-space map            */
/* ------------------------------------------------------------------ */
var feedInput = $("#rd-feed"), killInput = $("#rd-kill"), brushInput = $("#rd-brush");
var feedVal = $("#rd-feed-val"), killVal = $("#rd-kill-val"), brushVal = $("#rd-brush-val");
var presetGroup = $("#rd-presets"), paletteGroup = $("#rd-palettes");
var mapEl = $("#rd-map"), mapDot = $("#rd-map-dot");
var pauseBtn = $("#rd-pause"), statusEl = $("#rd-status");

function feedToX(f) { return clamp01((f - FEED_MIN) / (FEED_MAX - FEED_MIN)); }
function killToY(k) { return clamp01(1 - (k - KILL_MIN) / (KILL_MAX - KILL_MIN)); }

function updateDot() {
  mapDot.style.left = (feedToX(state.feed) * 100) + "%";
  mapDot.style.top  = (killToY(state.kill) * 100) + "%";
}
function setFeed(f) {
  state.feed = Math.max(FEED_MIN, Math.min(FEED_MAX, f));
  feedInput.value = state.feed;
  feedVal.textContent = state.feed.toFixed(4);
  field.update({ feed: state.feed });
  updateDot();
}
function setKill(k) {
  state.kill = Math.max(KILL_MIN, Math.min(KILL_MAX, k));
  killInput.value = state.kill;
  killVal.textContent = state.kill.toFixed(4);
  field.update({ kill: state.kill });
  updateDot();
}
function setBrush(b) {
  state.brush = b;
  brushInput.value = b;
  brushVal.textContent = b + " px";
  field.update({ brushSize: b });
}
function clearChips(group) {
  var c = group.querySelectorAll(".chip");
  for (var i = 0; i < c.length; i++) c[i].setAttribute("aria-pressed", "false");
}
function syncPresetChips() {
  // highlight a preset only if feed & kill match it closely
  var chips = presetGroup.querySelectorAll(".chip"), matched = false;
  for (var i = 0; i < chips.length; i++) {
    var pr = PRESETS[chips[i].dataset.preset];
    var on = pr && Math.abs(pr.feed - state.feed) < 1e-4 && Math.abs(pr.kill - state.kill) < 1e-4;
    chips[i].setAttribute("aria-pressed", on ? "true" : "false");
    if (on) matched = true;
  }
  return matched;
}

feedInput.addEventListener("input", function () { setFeed(parseFloat(feedInput.value)); syncPresetChips(); });
killInput.addEventListener("input", function () { setKill(parseFloat(killInput.value)); syncPresetChips(); });
brushInput.addEventListener("input", function () { setBrush(parseInt(brushInput.value, 10)); });

presetGroup.addEventListener("click", function (e) {
  var chip = e.target.closest(".chip"); if (!chip) return;
  var pr = PRESETS[chip.dataset.preset]; if (!pr) return;
  setFeed(pr.feed); setKill(pr.kill);
  clearChips(presetGroup);
  chip.setAttribute("aria-pressed", "true");
});
paletteGroup.addEventListener("click", function (e) {
  var chip = e.target.closest(".chip"); if (!chip) return;
  clearChips(paletteGroup);
  chip.setAttribute("aria-pressed", "true");
  state.pal = chip.dataset.pal || "lagoon";   // "mono" is the engine's alias for Ink
  field.update({ palette: state.pal });
});

$("#rd-seed").addEventListener("click", function () { field.reset("noise"); });
$("#rd-clear").addEventListener("click", function () { field.reset("blank"); });
pauseBtn.addEventListener("click", function () {
  state.paused = !state.paused;
  pauseBtn.innerHTML = state.paused ? "► Play" : "❚❚ Pause";
  field.update({ paused: state.paused });
});

/* parameter-space map: static backdrop + preset markers, draggable dot */
function drawMap() {
  var mc = $("#rd-map-canvas"); if (!mc) return;
  var g = mc.getContext("2d"); if (!g) return;
  var W = mc.width, H = mc.height;
  g.clearRect(0, 0, W, H);
  g.fillStyle = "#0d1117"; g.fillRect(0, 0, W, H);
  var grd = g.createLinearGradient(0, 0, W, H);
  grd.addColorStop(0.0, "rgba(47,214,195,0.04)");
  grd.addColorStop(0.5, "rgba(47,214,195,0.15)");
  grd.addColorStop(1.0, "rgba(47,214,195,0.03)");
  g.fillStyle = grd; g.fillRect(0, 0, W, H);
  for (var key in PRESETS) {
    if (!Object.prototype.hasOwnProperty.call(PRESETS, key)) continue;
    var p = PRESETS[key];
    g.beginPath();
    g.arc(feedToX(p.feed) * W, killToY(p.kill) * H, 2.4, 0, Math.PI * 2);
    g.fillStyle = "rgba(215,255,246,0.5)"; g.fill();
  }
}
function mapPoint(e) {
  var rect = mapEl.getBoundingClientRect();
  var cx = (e.touches ? e.touches[0].clientX : e.clientX);
  var cy = (e.touches ? e.touches[0].clientY : e.clientY);
  var x = clamp01((cx - rect.left) / rect.width);
  var y = clamp01((cy - rect.top) / rect.height);
  setFeed(FEED_MIN + x * (FEED_MAX - FEED_MIN));
  setKill(KILL_MAX - y * (KILL_MAX - KILL_MIN));
  syncPresetChips();
}
var mapDrag = false;
mapEl.addEventListener("mousedown", function (e) { mapDrag = true; mapPoint(e); e.preventDefault(); });
window.addEventListener("mousemove", function (e) { if (mapDrag) mapPoint(e); });
window.addEventListener("mouseup", function () { mapDrag = false; });
mapEl.addEventListener("touchstart", function (e) { mapDrag = true; mapPoint(e); e.preventDefault(); }, { passive: false });
mapEl.addEventListener("touchmove", function (e) { if (mapDrag) { mapPoint(e); e.preventDefault(); } }, { passive: false });
window.addEventListener("touchend", function () { mapDrag = false; });

/* ------------------------------------------------------------------ */
/*  Boot                                                              */
/* ------------------------------------------------------------------ */
var info = field.getInfo();
if (info.status !== "unsupported") {
  setFeed(state.feed);
  setKill(state.kill);
  setBrush(state.brush);
  syncPresetChips();
  drawMap();
  updateDot();
  if (statusEl) {
    statusEl.innerHTML = "simulating <b>" + info.gridSize + "×" + info.gridSize + "</b> cells · <b>" +
      STEPS_PER_FRAME + "</b> steps / frame" + (info.format === "byte" ? " · <b>8-bit</b>" : "");
  }
}
