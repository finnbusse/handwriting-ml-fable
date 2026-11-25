// Tiny static server for web/ on localhost (a secure context for Chromium).
// Mimics the static Space host: "/" redirects to /index.html, unknown paths 404.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', 'web');
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
};

function start(port = 0) {
  const srv = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://localhost');
    if (u.pathname === '/') { res.writeHead(302, { location: '/index.html' }); res.end(); return; }
    const f = path.join(ROOT, decodeURIComponent(u.pathname));
    if (!f.startsWith(ROOT + path.sep) || !fs.existsSync(f) || !fs.statSync(f).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((resolve) => srv.listen(port, '127.0.0.1', () => resolve({
    srv, port: srv.address().port, url: `http://localhost:${srv.address().port}/index.html`,
    close: () => new Promise((r) => { srv.closeAllConnections && srv.closeAllConnections(); srv.close(r); }),
  })));
}
module.exports = { start, ROOT };
