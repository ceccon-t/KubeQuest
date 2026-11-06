// Build: UI bundle + Electron main/preload. Everything lands in ./dist.
import { build } from 'esbuild';
import { mkdir, copyFile, readdir, stat, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(root, 'dist');
// The app version shown in the UI comes from package.json at build time (src/game/version.ts).
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const define = { __KQ_VERSION__: JSON.stringify(pkg.version) };
await mkdir(path.join(dist, 'web'), { recursive: true });
await mkdir(path.join(dist, 'desktop'), { recursive: true });

const ui = await build({
  entryPoints: [path.join(root, 'src/ui/main.ts')],
  bundle: true,
  format: 'esm',
  target: ['es2022'],
  outfile: path.join(dist, 'web/app.js'),
  sourcemap: true,
  minify: process.env.KQ_MINIFY === '1',
  logLevel: 'warning',
  metafile: true,
  define,
});
for (const f of await readdir(path.join(root, 'web'))) await copyFile(path.join(root, 'web', f), path.join(dist, 'web', f));
{
  const stamp = Date.now().toString(36);
  const html = (await readFile(path.join(dist, 'web/index.html'), 'utf8')).replace('styles.css"', `styles.css?v=${stamp}"`).replace('app.js"', `app.js?v=${stamp}"`);
  await writeFile(path.join(dist, 'web/index.html'), html);
}

await build({ entryPoints: [path.join(root, 'src/desktop/main.ts')], bundle: true, platform: 'node', format: 'cjs', target: ['node20'], external: ['electron'], outfile: path.join(dist, 'desktop/main.cjs'), logLevel: 'warning', define });
await build({ entryPoints: [path.join(root, 'src/desktop/preload.ts')], bundle: true, platform: 'node', format: 'cjs', target: ['node20'], external: ['electron'], outfile: path.join(dist, 'desktop/preload.cjs'), logLevel: 'warning', define });

const size = (await stat(path.join(dist, 'web/app.js'))).size;
const budget = 600 * 1024;
console.log(`build ok: dist/web/app.js ${(size / 1024).toFixed(0)} KB (budget ${budget / 1024} KB)${size > budget ? '  ⚠ over budget' : ''}`);
void ui;
