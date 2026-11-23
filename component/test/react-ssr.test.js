// Server rendering: the component must import and render in Node, where
// there is no window, document or WebGL.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';

test('importing the package touches no browser globals', async () => {
  assert.equal(typeof globalThis.window, 'undefined');
  const mod = await import('../src/index.js');
  assert.equal(typeof mod.ReactionDiffusion, 'object'); // forwardRef exotic component
  assert.equal(typeof mod.createReactionDiffusion, 'function');
});

test('server render is decorative by default: aria-hidden, no canvas, palette background', async () => {
  const { ReactionDiffusion } = await import('../src/index.js');
  const html = renderToString(createElement(ReactionDiffusion, { className: 'bg', style: { height: 300 } }));
  assert.match(html, /class="bg"/);
  assert.match(html, /aria-hidden="true"/);
  assert.doesNotMatch(html, /role="img"/);
  assert.doesNotMatch(html, /<canvas/);
  assert.doesNotMatch(html, /tabindex/i, 'never focusable');
  assert.match(html, /background:rgb\(4 17 15\)/, 'lagoon base tone paints before hydration');
  assert.match(html, /height:300px/);
});

test('label makes it an image with an accessible name; children render on top', async () => {
  const { ReactionDiffusion } = await import('../src/index.js');
  const html = renderToString(createElement(ReactionDiffusion, { label: 'Coral pattern growing', palette: 'ember' }, createElement('h1', null, 'Hello')));
  assert.match(html, /role="img"/);
  assert.match(html, /aria-label="Coral pattern growing"/);
  assert.doesNotMatch(html, /aria-hidden/);
  assert.match(html, /<div style="position:relative"><h1>Hello<\/h1><\/div>/);
  assert.match(html, /background:rgb\(10 5 3\)/, 'ember base tone');
});
