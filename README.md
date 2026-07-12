# A garden of reaction–diffusion

Two make-believe chemicals, one simple rule, and a whole zoo of living patterns. Paint
into the field and watch it grow.

**[▶ Live demo](https://moshejs.github.io/reaction-diffusion/)**

A **WebGL Gray–Scott reaction–diffusion** sandbox. Two imaginary chemicals slosh around
a grid following one short equation, painted onto the screen a few thousand times a
second by your GPU. Spots, stripes, mazes, and dividing cells all fall out of the *same
rule* — the only difference is how fast one chemical is fed and the other killed. Drag
to squirt chemical in, nudge the sliders, and watch the whole regime tip from coral to
fingerprints. This is Alan Turing's 1952 idea, running live.

## Run it

```bash
python3 -m http.server 8000   # then open http://localhost:8000
```

## How it's built

Vanilla HTML/CSS/JS + WebGL, **zero dependencies**. Ping-pong framebuffers, a Gray–Scott
fragment shader, runtime probing for float-texture support (half-float → float → 8-bit
packed fallback), and a display pass that maps concentration through a palette.

Part of [The Lab](https://github.com/moshejs) — handmade interactive explainers.

## License

MIT
