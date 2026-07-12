/* diffusion.js — a live Gray–Scott reaction–diffusion field on the GPU.
   Two float channels (U,V) are ping-ponged through a fragment shader each
   step; you paint V into the field and watch Turing patterns organise.
   WebGL2 preferred, WebGL1 fallback, half-float → float → 8-bit-packed
   storage, graceful message if none of it works. Zero dependencies. */
(function () {
  "use strict";

  var $ = function (s) { return document.querySelector(s); };
  var clamp01 = function (x) { return x < 0 ? 0 : x > 1 ? 1 : x; };
  var fract = function (x) { return x - Math.floor(x); };

  /* ---- model constants (Karl Sims' canonical Gray–Scott tuning) ---- */
  var DU = 1.0, DV = 0.5, DT = 1.0;   // diffusion of U, of V, and timestep
  var SIM_STEPS = 12;                  // simulation iterations per animation frame

  /* feed × kill slider ranges (must match the HTML input min/max) */
  var FEED_MIN = 0.010, FEED_MAX = 0.090;
  var KILL_MIN = 0.045, KILL_MAX = 0.070;

  /* famous points in Gray–Scott parameter space */
  var PRESETS = {
    coral:       { feed: 0.0545, kill: 0.0620 },
    mitosis:     { feed: 0.0367, kill: 0.0649 },
    worms:       { feed: 0.0580, kill: 0.0650 },
    maze:        { feed: 0.0290, kill: 0.0570 },
    fingerprint: { feed: 0.0370, kill: 0.0600 }
  };
  var PAL_INDEX = { lagoon: 0, ember: 1, mono: 2, bio: 3 };

  var canvas   = $("#rd-canvas");
  var fallback = $("#rd-fallback");
  var controls = $("#rd-controls");
  var hintEl   = $("#rd-hint");

  /* ------------------------------------------------------------------ */
  /*  WebGL context                                                     */
  /* ------------------------------------------------------------------ */
  var glOpts = { antialias: false, depth: false, stencil: false, alpha: false,
                 premultipliedAlpha: false, preserveDrawingBuffer: false,
                 powerPreference: "high-performance" };
  var gl = null, isGL2 = false;
  try {
    gl = canvas.getContext("webgl2", glOpts);
    if (gl) isGL2 = true;
    else gl = canvas.getContext("webgl", glOpts) || canvas.getContext("experimental-webgl", glOpts);
  } catch (e) { gl = null; }

  if (!gl) { showFallback(); return; }

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

  /* ------------------------------------------------------------------ */
  /*  Pick a renderable, ideally-filterable storage format              */
  /* ------------------------------------------------------------------ */
  function probe(c) {
    var tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    var ok = true;
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, c.internalFormat, 4, 4, 0, c.format, c.type, null);
      var fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE
           && gl.getError() === gl.NO_ERROR;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.deleteFramebuffer(fbo);
    } catch (e) { ok = false; }
    gl.deleteTexture(tex);
    return ok;
  }

  function pickFormat() {
    var cands = [];
    if (isGL2) {
      var cbf  = gl.getExtension("EXT_color_buffer_float");
      var cbhf = gl.getExtension("EXT_color_buffer_half_float");
      if (cbf || cbhf)
        cands.push({ internalFormat: gl.RGBA16F, format: gl.RGBA, type: gl.HALF_FLOAT, mode: "float", linear: true });
      if (cbf)
        cands.push({ internalFormat: gl.RGBA32F, format: gl.RGBA, type: gl.FLOAT, mode: "float",
                     linear: !!gl.getExtension("OES_texture_float_linear") });
      cands.push({ internalFormat: gl.RGBA8, format: gl.RGBA, type: gl.UNSIGNED_BYTE, mode: "byte", linear: true });
    } else {
      var hf = gl.getExtension("OES_texture_half_float");
      if (hf)
        cands.push({ internalFormat: gl.RGBA, format: gl.RGBA, type: hf.HALF_FLOAT_OES, mode: "float",
                     linear: !!gl.getExtension("OES_texture_half_float_linear") });
      var f = gl.getExtension("OES_texture_float");
      if (f)
        cands.push({ internalFormat: gl.RGBA, format: gl.RGBA, type: gl.FLOAT, mode: "float",
                     linear: !!gl.getExtension("OES_texture_float_linear") });
      cands.push({ internalFormat: gl.RGBA, format: gl.RGBA, type: gl.UNSIGNED_BYTE, mode: "byte", linear: true });
    }
    for (var i = 0; i < cands.length; i++) if (probe(cands[i])) return cands[i];
    return null;
  }

  var fmt = pickFormat();
  if (!fmt) { showFallback("No renderable texture format was available."); return; }

  /* higher resolution where we have the GPU headroom of WebGL2 */
  var simSize = isGL2 ? 512 : 256;

  /* ------------------------------------------------------------------ */
  /*  Shaders (all GLSL ES 1.00 so one source runs on WebGL1 and 2)     */
  /* ------------------------------------------------------------------ */

  /* storage header: float mode reads channels directly; byte mode packs
     each concentration into 16 bits across two bytes so an 8-bit target
     still simulates cleanly. Chosen at runtime, prepended to fragments. */
  var HEAD_FLOAT =
    "precision highp float;\n" +
    "#define READ_U(s) (s).x\n" +
    "#define READ_V(s) (s).y\n" +
    "#define PACK(U,V) vec4((U),(V),0.0,1.0)\n";
  var HEAD_BYTE =
    "precision highp float;\n" +
    "vec2 enc16(float v){v=clamp(v,0.0,1.0);float s=v*65535.0;float hi=floor(s/256.0);float lo=floor(s-hi*256.0);return vec2(hi,lo)/255.0;}\n" +
    "float dec16(vec2 e){return (e.x*255.0*256.0+e.y*255.0)/65535.0;}\n" +
    "#define READ_U(s) dec16((s).xy)\n" +
    "#define READ_V(s) dec16((s).zw)\n" +
    "#define PACK(U,V) vec4(enc16(U),enc16(V))\n";
  var HEAD = fmt.mode === "byte" ? HEAD_BYTE : HEAD_FLOAT;

  var VERT =
    "attribute vec2 a_pos;\n" +
    "varying vec2 v_uv;\n" +
    "void main(){ v_uv = a_pos*0.5+0.5; gl_Position = vec4(a_pos,0.0,1.0); }\n";

  /* Gray–Scott update with a 3x3 Laplacian (center -1, ortho 0.2, diag 0.05) */
  var FRAG_SIM = HEAD +
    "varying vec2 v_uv;\n" +
    "uniform sampler2D u_prev;\n" +
    "uniform vec2 u_texel;\n" +
    "uniform float u_feed, u_kill, u_du, u_dv, u_dt;\n" +
    "void main(){\n" +
    "  vec2 uv = v_uv;\n" +
    "  vec4 c  = texture2D(u_prev, uv);\n" +
    "  float U = READ_U(c); float V = READ_V(c);\n" +
    "  vec4 l  = texture2D(u_prev, uv + vec2(-u_texel.x, 0.0));\n" +
    "  vec4 r  = texture2D(u_prev, uv + vec2( u_texel.x, 0.0));\n" +
    "  vec4 up = texture2D(u_prev, uv + vec2(0.0, -u_texel.y));\n" +
    "  vec4 dn = texture2D(u_prev, uv + vec2(0.0,  u_texel.y));\n" +
    "  vec4 lu = texture2D(u_prev, uv + vec2(-u_texel.x,-u_texel.y));\n" +
    "  vec4 ru = texture2D(u_prev, uv + vec2( u_texel.x,-u_texel.y));\n" +
    "  vec4 ld = texture2D(u_prev, uv + vec2(-u_texel.x, u_texel.y));\n" +
    "  vec4 rd = texture2D(u_prev, uv + vec2( u_texel.x, u_texel.y));\n" +
    "  float lapU = -U + 0.2*(READ_U(l)+READ_U(r)+READ_U(up)+READ_U(dn))\n" +
    "                  + 0.05*(READ_U(lu)+READ_U(ru)+READ_U(ld)+READ_U(rd));\n" +
    "  float lapV = -V + 0.2*(READ_V(l)+READ_V(r)+READ_V(up)+READ_V(dn))\n" +
    "                  + 0.05*(READ_V(lu)+READ_V(ru)+READ_V(ld)+READ_V(rd));\n" +
    "  float uvv = U*V*V;\n" +
    "  float dU = (u_du*lapU - uvv + u_feed*(1.0-U)) * u_dt;\n" +
    "  float dV = (u_dv*lapV + uvv - (u_feed+u_kill)*V) * u_dt;\n" +
    "  U = clamp(U + dU, 0.0, 1.0);\n" +
    "  V = clamp(V + dV, 0.0, 1.0);\n" +
    "  gl_FragColor = PACK(U, V);\n" +
    "}\n";

  /* soft circular brush that squirts V (and burns a little U) into the torus */
  var FRAG_SPLAT = HEAD +
    "varying vec2 v_uv;\n" +
    "uniform sampler2D u_src;\n" +
    "uniform vec2 u_point;\n" +
    "uniform float u_radius, u_amount;\n" +
    "void main(){\n" +
    "  vec4 s = texture2D(u_src, v_uv);\n" +
    "  float U = READ_U(s); float V = READ_V(s);\n" +
    "  vec2 d = v_uv - u_point;\n" +
    "  d -= floor(d + 0.5);\n" +               // wrap difference onto the torus
    "  float b = u_amount * exp(-dot(d,d)/(u_radius*u_radius));\n" +
    "  V = min(1.0, V + b);\n" +
    "  U = max(0.0, U - b*0.5);\n" +
    "  gl_FragColor = PACK(U, V);\n" +
    "}\n";

  /* seed the field: mode 0 blank, 1 scattered noise, 2 central blob */
  var FRAG_SEED = HEAD +
    "varying vec2 v_uv;\n" +
    "uniform float u_mode, u_seed;\n" +
    "float hash(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }\n" +
    "void main(){\n" +
    "  float U = 1.0; float V = 0.0;\n" +
    "  if (u_mode > 1.5) {\n" +
    "    vec2 d = v_uv - vec2(0.5);\n" +
    "    if (exp(-dot(d,d)/0.0016) > 0.5) { U = 0.5; V = 0.28; }\n" +
    "  } else if (u_mode > 0.5) {\n" +
    "    float h  = hash(floor(v_uv*56.0) + u_seed);\n" +
    "    float h2 = hash(floor(v_uv*56.0) + u_seed + 7.3);\n" +
    "    if (h > 0.62 && h2 > 0.45) { U = 0.5; V = 0.27; }\n" +
    "  }\n" +
    "  gl_FragColor = PACK(U, V);\n" +
    "}\n";

  /* display: map V through a palette, with a faint emboss for depth */
  var FRAG_DISPLAY = HEAD +
    "varying vec2 v_uv;\n" +
    "uniform sampler2D u_state;\n" +
    "uniform vec2 u_texel;\n" +
    "uniform float u_aspect;\n" +
    "uniform int u_pal;\n" +
    "vec3 palLagoon(float t){\n" +
    "  vec3 c = vec3(0.016,0.067,0.059);\n" +
    "  c = mix(c, vec3(0.043,0.231,0.224), smoothstep(0.00,0.35,t));\n" +
    "  c = mix(c, vec3(0.090,0.584,0.498), smoothstep(0.35,0.60,t));\n" +
    "  c = mix(c, vec3(0.184,0.839,0.765), smoothstep(0.60,0.82,t));\n" +
    "  c = mix(c, vec3(0.847,1.000,0.965), smoothstep(0.82,1.00,t));\n" +
    "  return c; }\n" +
    "vec3 palEmber(float t){\n" +
    "  vec3 c = vec3(0.039,0.020,0.012);\n" +
    "  c = mix(c, vec3(0.290,0.059,0.016), smoothstep(0.00,0.35,t));\n" +
    "  c = mix(c, vec3(0.761,0.231,0.055), smoothstep(0.35,0.62,t));\n" +
    "  c = mix(c, vec3(1.000,0.616,0.184), smoothstep(0.62,0.84,t));\n" +
    "  c = mix(c, vec3(1.000,0.949,0.769), smoothstep(0.84,1.00,t));\n" +
    "  return c; }\n" +
    "vec3 palInk(float t){\n" +
    "  vec3 c = vec3(0.027,0.031,0.043);\n" +
    "  c = mix(c, vec3(0.227,0.255,0.314), smoothstep(0.00,0.45,t));\n" +
    "  c = mix(c, vec3(0.486,0.518,0.580), smoothstep(0.45,0.72,t));\n" +
    "  c = mix(c, vec3(0.949,0.957,0.973), smoothstep(0.72,1.00,t));\n" +
    "  return c; }\n" +
    "vec3 palBio(float t){\n" +
    "  vec3 c = vec3(0.020,0.024,0.102);\n" +
    "  c = mix(c, vec3(0.141,0.102,0.420), smoothstep(0.00,0.35,t));\n" +
    "  c = mix(c, vec3(0.420,0.184,0.702), smoothstep(0.35,0.60,t));\n" +
    "  c = mix(c, vec3(0.184,0.839,0.765), smoothstep(0.60,0.82,t));\n" +
    "  c = mix(c, vec3(0.918,1.000,0.941), smoothstep(0.82,1.00,t));\n" +
    "  return c; }\n" +
    "vec3 palette(int id, float t){\n" +
    "  if (id == 0) return palLagoon(t);\n" +
    "  else if (id == 1) return palEmber(t);\n" +
    "  else if (id == 2) return palInk(t);\n" +
    "  return palBio(t); }\n" +
    "void main(){\n" +
    "  vec2 uv = vec2(v_uv.x * u_aspect, v_uv.y);\n" +   // square texels, seamless tiling
    "  float V  = READ_V(texture2D(u_state, uv));\n" +
    "  float vR = READ_V(texture2D(u_state, uv + vec2(u_texel.x,0.0)));\n" +
    "  float vL = READ_V(texture2D(u_state, uv - vec2(u_texel.x,0.0)));\n" +
    "  float vD = READ_V(texture2D(u_state, uv + vec2(0.0,u_texel.y)));\n" +
    "  float vU = READ_V(texture2D(u_state, uv - vec2(0.0,u_texel.y)));\n" +
    "  float t = clamp(V/0.42, 0.0, 1.0);\n" +
    "  t = pow(t, 0.85);\n" +
    "  vec3 col = palette(u_pal, t);\n" +
    "  float emboss = (vR - vL)*3.0 + (vD - vU)*2.0;\n" +
    "  col *= 1.0 + clamp(emboss, -0.25, 0.25);\n" +
    "  gl_FragColor = vec4(col, 1.0);\n" +
    "}\n";

  /* ------------------------------------------------------------------ */
  /*  Program / buffer helpers                                          */
  /* ------------------------------------------------------------------ */
  function compile(type, src) {
    var sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      var log = gl.getShaderInfoLog(sh);
      gl.deleteShader(sh);
      throw new Error("shader compile failed: " + log);
    }
    return sh;
  }
  function makeProgram(fsrc) {
    var vs = compile(gl.VERTEX_SHADER, VERT);
    var fs = compile(gl.FRAGMENT_SHADER, fsrc);
    var p = gl.createProgram();
    gl.attachShader(p, vs); gl.attachShader(p, fs);
    gl.bindAttribLocation(p, 0, "a_pos");
    gl.linkProgram(p);
    gl.deleteShader(vs); gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      var log = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new Error("program link failed: " + log);
    }
    var cache = {};
    return {
      p: p,
      aPos: gl.getAttribLocation(p, "a_pos"),
      use: function () { gl.useProgram(p); return this; },
      u: function (n) { return (n in cache) ? cache[n] : (cache[n] = gl.getUniformLocation(p, n)); }
    };
  }

  var simP, splatP, seedP, dispP, quad, tex = [], fbo = [];
  try {
    simP   = makeProgram(FRAG_SIM);
    splatP = makeProgram(FRAG_SPLAT);
    seedP  = makeProgram(FRAG_SEED);
    dispP  = makeProgram(FRAG_DISPLAY);

    quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER,
      new Float32Array([-1,-1, 1,-1, -1,1,  -1,1, 1,-1, 1,1]), gl.STATIC_DRAW);

    var filter = (fmt.mode !== "byte" && fmt.linear) ? gl.LINEAR : gl.NEAREST;
    for (var i = 0; i < 2; i++) {
      var t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
      gl.texImage2D(gl.TEXTURE_2D, 0, fmt.internalFormat, simSize, simSize, 0,
                    fmt.format, fmt.type, null);
      var f = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
        throw new Error("simulation framebuffer incomplete");
      tex.push(t); fbo.push(f);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  } catch (err) {
    if (window.console) console.error("[reaction–diffusion] init failed:", err);
    showFallback("WebGL initialisation failed on this device.");
    return;
  }

  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.BLEND);

  var src = 0;                 // which texture currently holds the live state
  var texel = 1 / simSize;

  function drawQuad(pr) {
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.enableVertexAttribArray(pr.aPos);
    gl.vertexAttribPointer(pr.aPos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }
  function bindTex(loc, texture) {
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(loc, 0);
  }

  /* ------------------------------------------------------------------ */
  /*  Passes                                                            */
  /* ------------------------------------------------------------------ */
  function simStep() {
    var dst = 1 - src;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo[dst]);
    gl.viewport(0, 0, simSize, simSize);
    simP.use();
    bindTex(simP.u("u_prev"), tex[src]);
    gl.uniform2f(simP.u("u_texel"), texel, texel);
    gl.uniform1f(simP.u("u_feed"), state.feed);
    gl.uniform1f(simP.u("u_kill"), state.kill);
    gl.uniform1f(simP.u("u_du"), DU);
    gl.uniform1f(simP.u("u_dv"), DV);
    gl.uniform1f(simP.u("u_dt"), DT);
    drawQuad(simP);
    src = dst;
  }

  function splatOnce(sp) {
    var dst = 1 - src;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo[dst]);
    gl.viewport(0, 0, simSize, simSize);
    splatP.use();
    bindTex(splatP.u("u_src"), tex[src]);
    gl.uniform2f(splatP.u("u_point"), sp.u, sp.v);
    gl.uniform1f(splatP.u("u_radius"), sp.r);
    gl.uniform1f(splatP.u("u_amount"), sp.amt);
    drawQuad(splatP);
    src = dst;
  }

  function seed(mode) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo[src]);   // seed ignores input, no feedback
    gl.viewport(0, 0, simSize, simSize);
    seedP.use();
    gl.uniform1f(seedP.u("u_mode"), mode);
    gl.uniform1f(seedP.u("u_seed"), Math.random() * 1000.0);
    drawQuad(seedP);
  }

  function drawDisplay() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, canvas.width, canvas.height);
    dispP.use();
    bindTex(dispP.u("u_state"), tex[src]);
    gl.uniform2f(dispP.u("u_texel"), texel, texel);
    gl.uniform1f(dispP.u("u_aspect"), canvas.width / canvas.height);
    gl.uniform1i(dispP.u("u_pal"), state.pal);
    drawQuad(dispP);
  }

  /* ------------------------------------------------------------------ */
  /*  State + paint queue                                               */
  /* ------------------------------------------------------------------ */
  var state = { feed: PRESETS.coral.feed, kill: PRESETS.coral.kill, brush: 28, pal: 0 };
  var pending = [];      // queued paint splats, applied at the top of each frame

  function applyPending() {
    if (!pending.length) return;
    for (var i = 0; i < pending.length; i++) splatOnce(pending[i]);
    pending.length = 0;
  }

  /* ------------------------------------------------------------------ */
  /*  Animation loop + lifecycle                                        */
  /* ------------------------------------------------------------------ */
  var paused = false, hiddenTab = false, active = false, rafId = 0, ready = false;

  function render() {
    applyPending();
    for (var i = 0; i < SIM_STEPS; i++) simStep();
    drawDisplay();
  }
  function tick() {
    rafId = 0;
    if (paused || hiddenTab) { active = false; return; }
    render();
    active = true;
    rafId = requestAnimationFrame(tick);
  }
  function ensureLoop() {
    if (!active && !paused && !hiddenTab && ready) {
      active = true;
      rafId = requestAnimationFrame(tick);
    }
  }
  function paintFlush() {          // one-shot draw when the loop is idle (paused)
    if (!ready) return;
    applyPending();
    drawDisplay();
  }

  document.addEventListener("visibilitychange", function () {
    hiddenTab = document.hidden;
    if (hiddenTab) { if (rafId) cancelAnimationFrame(rafId); rafId = 0; active = false; }
    else ensureLoop();
  });
  canvas.addEventListener("webglcontextlost", function (e) {
    e.preventDefault();
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0; active = false; ready = false;
  }, false);

  /* ------------------------------------------------------------------ */
  /*  Resize + devicePixelRatio                                         */
  /* ------------------------------------------------------------------ */
  function resize() {
    var cssW = canvas.clientWidth;
    var cssH = canvas.clientHeight;
    if (!cssW || !cssH) return;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var w = Math.max(1, Math.round(cssW * dpr));
    var h = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w; canvas.height = h;
    }
    if (ready && (paused || hiddenTab)) drawDisplay();
  }
  if (window.ResizeObserver) {
    try { new ResizeObserver(resize).observe(canvas); } catch (e) {}
  }
  window.addEventListener("resize", resize);

  /* ------------------------------------------------------------------ */
  /*  Painting                                                          */
  /* ------------------------------------------------------------------ */
  var painting = false, lastX = 0, lastY = 0, hintDismissed = false;

  function toField(e) {
    var rect = canvas.getBoundingClientRect();
    var cx = (e.touches ? e.touches[0].clientX : e.clientX);
    var cy = (e.touches ? e.touches[0].clientY : e.clientY);
    var fx = (cx - rect.left) / rect.width;
    var fy = (cy - rect.top) / rect.height;
    var aspect = rect.width / rect.height;          // matches display aspect
    return { X: fx * aspect, Y: fy, rectH: rect.height, aspect: aspect };
  }
  function addSplat(u, v, rectH) {
    if (pending.length > 500) return;
    var r = state.brush / rectH;                     // brush px → sim-uv radius
    r = Math.max(0.008, Math.min(0.5, r));
    pending.push({ u: fract(u), v: clamp01(v), r: r, amt: 0.9 });
  }
  function dismissHint() {
    if (hintDismissed || !hintEl) return;
    hintDismissed = true;
    hintEl.classList.add("fade");
    setTimeout(function () { if (hintEl) hintEl.style.display = "none"; }, 450);
  }

  function beginPaint(e) {
    painting = true;
    var p = toField(e);
    lastX = p.X; lastY = p.Y;
    addSplat(p.X, p.Y, p.rectH);
    dismissHint();
    if (paused || hiddenTab) paintFlush();
    e.preventDefault();
  }
  function movePaint(e) {
    if (!painting) return;
    var p = toField(e);
    var dx = p.X - lastX, dy = p.Y - lastY;
    var dist = Math.sqrt(dx * dx + dy * dy);
    var rr = state.brush / p.rectH;
    var steps = Math.max(1, Math.min(60, Math.floor(dist / (rr * 0.5))));
    for (var i = 1; i <= steps; i++) {
      addSplat(lastX + dx * i / steps, lastY + dy * i / steps, p.rectH);
    }
    lastX = p.X; lastY = p.Y;
    if (paused || hiddenTab) paintFlush();
    e.preventDefault();
  }
  function endPaint() { painting = false; }

  canvas.addEventListener("mousedown", beginPaint);
  window.addEventListener("mousemove", function (e) { if (painting) movePaint(e); });
  window.addEventListener("mouseup", endPaint);
  canvas.addEventListener("touchstart", beginPaint, { passive: false });
  canvas.addEventListener("touchmove", function (e) { if (painting) movePaint(e); }, { passive: false });
  window.addEventListener("touchend", endPaint);
  window.addEventListener("touchcancel", endPaint);

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
    updateDot();
  }
  function setKill(k) {
    state.kill = Math.max(KILL_MIN, Math.min(KILL_MAX, k));
    killInput.value = state.kill;
    killVal.textContent = state.kill.toFixed(4);
    updateDot();
  }
  function setBrush(b) {
    state.brush = b;
    brushInput.value = b;
    brushVal.textContent = b + " px";
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
    state.pal = PAL_INDEX[chip.dataset.pal] || 0;
    if (paused || hiddenTab) paintFlush();
  });

  $("#rd-seed").addEventListener("click", function () { seed(1); if (paused || hiddenTab) paintFlush(); });
  $("#rd-clear").addEventListener("click", function () { seed(0); if (paused || hiddenTab) paintFlush(); });
  pauseBtn.addEventListener("click", function () {
    paused = !paused;
    pauseBtn.innerHTML = paused ? "► Play" : "❚❚ Pause";
    if (!paused) ensureLoop();
    else if (rafId) { cancelAnimationFrame(rafId); rafId = 0; active = false; }
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
      if (!PRESETS.hasOwnProperty(key)) continue;
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
  function boot() {
    setFeed(state.feed);
    setKill(state.kill);
    setBrush(state.brush);
    syncPresetChips();
    drawMap();
    updateDot();
    if (statusEl) {
      statusEl.innerHTML = "simulating <b>" + simSize + "×" + simSize + "</b> cells · <b>" +
        SIM_STEPS + "</b> steps / frame" + (fmt.mode === "byte" ? " · <b>8-bit</b>" : "");
    }
    resize();
    seed(1);          // start with a living, scattered field
    ready = true;
    drawDisplay();
    ensureLoop();
  }
  boot();
})();
