// Helpers shared by the browser tests. These need Playwright, which is NOT a dependency of the
// app: install it with `npm i -D playwright && npx playwright install chromium` to run them.
import { createRequire } from 'node:module';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
export const { chromium, devices } = require('playwright');

const root = join(process.cwd(), 'dist', 'public');
const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };

export function startStatic(port: number): Promise<Server> {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const file = join(root, path === '/' ? 'index.html' : path);
    if (!file.startsWith(root)) return void res.writeHead(403).end();
    try {
      res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(await readFile(file));
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

/** Load a module that was compiled into dist/public/js by `npm run build:web`. */
export const loadBuilt = (path: string) => import(pathToFileURL(join(root, 'js', path)).href);

export function watchErrors(page: any, label: string, sink: string[]): void {
  page.on('pageerror', (e: Error) => sink.push(`${label} pageerror: ${e.message}`));
  page.on('console', (m: any) => {
    if (m.type() === 'error') sink.push(`${label} console.error: ${m.text()}`);
  });
}

export function check(condition: unknown, message: string): void {
  if (!condition) throw new Error(`CHECK FAILED: ${message}`);
  console.log(`  ok  ${message}`);
}

/** Wait until `read()` satisfies `test`, or fail with what we last saw. */
export async function eventually<T>(read: () => Promise<T>, test: (v: T) => boolean, message: string, ms = 5000): Promise<T> {
  const deadline = Date.now() + ms;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = await read();
    if (test(last)) {
      console.log(`  ok  ${message}`);
      return last;
    }
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`TIMEOUT: ${message} (last seen: ${JSON.stringify(last)})`);
}
