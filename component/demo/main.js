// Demo of <ReactionDiffusion>: the field as a page background, with every
// prop wired to a control. Build with `npm run demo` (serves on :5199).
import { createElement as h, StrictMode, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ReactionDiffusion, PRESETS, PALETTES } from '../src/index.js';

const PRESET_LABELS = { coral: 'Coral', mitosis: 'Mitosis', worms: 'Spots & worms', maze: 'Maze', fingerprint: 'Fingerprint' };

function Field({ id, label, value, min, max, step, onChange, format = (v) => v }) {
  return h('label', { className: 'field', htmlFor: id },
    h('span', { className: 'field-head' }, label, h('b', null, format(value))),
    h('input', { id, type: 'range', min, max, step, value, onChange: (e) => onChange(Number(e.target.value)) }));
}

function Demo() {
  const ref = useRef(null);
  const [preset, setPreset] = useState('coral');
  const [feed, setFeed] = useState(PRESETS.coral.feed);
  const [kill, setKill] = useState(PRESETS.coral.kill);
  const [palette, setPalette] = useState('lagoon');
  const [speed, setSpeed] = useState(12);
  const [paused, setPaused] = useState(false);
  const [interactive, setInteractive] = useState(true);
  const [info, setInfo] = useState(null);

  const choosePreset = (key) => {
    setPreset(key);
    setFeed(PRESETS[key].feed);
    setKill(PRESETS[key].kill);
  };

  return h('main', { className: 'demo' },
    h(ReactionDiffusion, {
      ref,
      className: 'hero',
      feed, kill, palette, paused, interactive,
      stepsPerFrame: speed,
      label: 'A live reaction–diffusion pattern. Drag to paint into it.',
      onReady: setInfo,
    },
    h('div', { className: 'hero-copy' },
      h('p', { className: 'eyebrow' }, '<ReactionDiffusion />'),
      h('h1', null, 'A garden of reaction–diffusion, as a component'),
      h('p', { className: 'dek' }, 'The exhibit’s Gray–Scott shader, packaged for React. Drag on the field to paint chemical into it.'))),

    h('section', { className: 'panel', 'aria-label': 'Component props' },
      h('div', { className: 'group' },
        h('span', { className: 'group-label', id: 'preset-label' }, 'preset'),
        h('div', { className: 'chips', role: 'group', 'aria-labelledby': 'preset-label' },
          Object.keys(PRESETS).map((k) => h('button', {
            key: k, type: 'button', className: 'chip', 'aria-pressed': preset === k && PRESETS[k].feed === feed && PRESETS[k].kill === kill,
            onClick: () => choosePreset(k),
          }, PRESET_LABELS[k])))),
      h('div', { className: 'group' },
        h('span', { className: 'group-label', id: 'palette-label' }, 'palette'),
        h('div', { className: 'chips', role: 'group', 'aria-labelledby': 'palette-label' },
          Object.keys(PALETTES).map((k) => h('button', {
            key: k, type: 'button', className: 'chip', 'aria-pressed': palette === k, onClick: () => setPalette(k),
          }, k)))),
      h('div', { className: 'sliders' },
        h(Field, { id: 'feed', label: 'feed', value: feed, min: 0.01, max: 0.09, step: 0.0001, onChange: setFeed, format: (v) => v.toFixed(4) }),
        h(Field, { id: 'kill', label: 'kill', value: kill, min: 0.045, max: 0.07, step: 0.0001, onChange: setKill, format: (v) => v.toFixed(4) }),
        h(Field, { id: 'speed', label: 'stepsPerFrame', value: speed, min: 1, max: 32, step: 1, onChange: setSpeed })),
      h('div', { className: 'buttons' },
        h('button', { type: 'button', className: 'btn primary', onClick: () => setPaused((p) => !p) }, paused ? 'Play' : 'Pause'),
        h('button', { type: 'button', className: 'btn', onClick: () => ref.current?.reset('noise') }, 'Reseed'),
        h('button', { type: 'button', className: 'btn', onClick: () => ref.current?.reset('blank') }, 'Clear'),
        h('button', {
          type: 'button', className: 'btn',
          onClick: () => {
            const url = ref.current?.snapshot();
            if (!url) return;
            const a = document.createElement('a');
            a.href = url; a.download = 'reaction-diffusion.png'; a.click();
          },
        }, 'Snapshot PNG'),
        h('label', { className: 'toggle' },
          h('input', { type: 'checkbox', checked: interactive, onChange: (e) => setInteractive(e.target.checked) }),
          ' interactive')),
      h('p', { className: 'status' }, info
        ? `WebGL${info.webgl} · ${info.format} storage · ${info.gridSize}×${info.gridSize} grid${info.reducedMotion ? ' · reduced motion: still frame' : ''}`
        : 'starting…')));
}

createRoot(document.getElementById('root')).render(h(StrictMode, null, h(Demo)));
