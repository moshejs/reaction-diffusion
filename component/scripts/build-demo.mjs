// Bundles the demo and the browser-test harness into demo/dist (git-ignored).
//   node scripts/build-demo.mjs            build once
//   node scripts/build-demo.mjs --serve    build and serve on http://127.0.0.1:5199
// React is bundled from node_modules, so nothing is fetched from a CDN.
import * as esbuild from 'esbuild';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'demo', 'dist');
const serve = process.argv.includes('--serve');
const portArg = process.argv.find((a) => a.startsWith('--port='));
const port = portArg ? Number(portArg.slice(7)) : 5199;

const page = (title, script, body = '') => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${title}</title>
<link rel="stylesheet" href="demo.css" />
</head>
<body>
${body}<div id="root"></div>
<script type="module" src="${script}"></script>
</body>
</html>
`;

await mkdir(out, { recursive: true });
await writeFile(join(out, 'index.html'), page('ReactionDiffusion component demo', 'demo.js'));
await writeFile(join(out, 'harness.html'), page('ReactionDiffusion test harness', 'harness.js'));

// The harness uses React's development build so StrictMode really
// double-invokes effects; the demo uses the production build.
const harness = {
  entryPoints: { harness: join(root, 'test', 'browser', 'harness.js') },
  bundle: true,
  format: /** @type {const} */ ('esm'),
  outdir: out,
  sourcemap: true,
  target: 'es2020',
  define: { 'process.env.NODE_ENV': '"development"' },
  logLevel: /** @type {const} */ ('warning'),
};
const options = {
  entryPoints: { demo: join(root, 'demo', 'main.js') },
  bundle: true,
  format: /** @type {const} */ ('esm'),
  outdir: out,
  sourcemap: true,
  target: 'es2020',
  define: { 'process.env.NODE_ENV': serve ? '"development"' : '"production"' },
  logLevel: /** @type {const} */ ('warning'),
};

await copyFile(join(root, 'demo', 'demo.css'), join(out, 'demo.css'));
await esbuild.build(harness);
await esbuild.build(options);

if (serve) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  const { hosts, port: p } = await ctx.serve({ servedir: out, port, host: '127.0.0.1' });
  console.log(`demo: http://${hosts[0]}:${p}/  harness: http://${hosts[0]}:${p}/harness.html`);
} else {
  console.log('built', out);
}
