import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
const ROOT = 'D:/dsh/_compare';
http.createServer(async (reqq, res) => {
  const u = new URL(reqq.url, 'http://127.0.0.1');
  const f = path.join(ROOT, u.pathname === '/' ? 'local.html' : u.pathname.slice(1));
  try { const d = await readFile(f); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); res.end(d); }
  catch { res.writeHead(404); res.end('nf'); }
}).listen(8911, '127.0.0.1', () => console.log('compare on 8911'));
