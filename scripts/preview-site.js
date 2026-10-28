import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const root = fileURLToPath(new URL('../dist/', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.json': 'application/json', '.xml': 'application/xml', '.txt': 'text/plain' };
export function createPreviewServer() {
return http.createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const pagePath = pathname.endsWith('/') ? `${pathname}index.html` : ['/laboratory', '/simulator', '/how-it-works', '/attack-scenarios', '/validation'].includes(pathname) ? `${pathname}/index.html` : pathname;
    const file = resolve(root, `.${pagePath}`);
    if (!file.startsWith(resolve(root) + sep) || !types[extname(file)]) { res.writeHead(404); res.end(); return; }
    const content = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)], 'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
    res.end(content);
  } catch { res.writeHead(404); res.end('Not found'); }
});
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  createPreviewServer().listen(8788, '127.0.0.1', () => console.log('Browser edition preview: http://127.0.0.1:8788'));
}
