// Serves wallet/sign-test.html on 127.0.0.1 only. Browser wallets do not inject into file:// pages.
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const page = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'sign-test.html'));
const port = Number(process.argv[2] ?? 8787);
createServer((req, res) => {
  if (req.url !== '/' && req.url !== '/sign-test.html') { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'" });
  res.end(page);
}).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}/  (Ctrl+C to stop)`));
