// Builds the browser app into dist/public:
//   - compiles web/, shared/, engine/src and server/room.ts to plain ES modules
//   - copies index.html, style.css, the manifest and icons next to them
//   - writes sw.js (offline support) listing every file
// No bundler: modern browsers load the modules directly.
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/public', { recursive: true });
execSync('npx tsc -p tsconfig.web.json', { stdio: 'inherit' });
cpSync('web/index.html', 'dist/public/index.html');
cpSync('web/style.css', 'dist/public/style.css');
cpSync('web/manifest.webmanifest', 'dist/public/manifest.webmanifest');
cpSync('web/icons', 'dist/public/icons', { recursive: true });

// The service worker caches every file of the app. Its name changes whenever any file changes,
// which is how phones learn that a new version is available.
const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
const files = walk('dist/public').map((f) => '/' + f.slice('dist/public/'.length)).filter((f) => f !== '/index.html').sort(); // the page itself is cached as '/' (hosts may redirect /index.html)
const hash = createHash('sha256');
for (const f of files) hash.update(f).update(readFileSync('dist/public' + f));
const sw = readFileSync('web/sw.js', 'utf8')
  .replace('__BUILD__', hash.digest('hex').slice(0, 10))
  .replace('__FILES__', JSON.stringify(['/', ...files], null, 2));
writeFileSync('dist/public/sw.js', sw);
console.log('Built dist/public');
