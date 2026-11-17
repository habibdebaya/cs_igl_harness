// Tiny server: serves the page and relays IGL calls to ai& (keeps the API key off the browser).
// No dependencies. Run: node server.js  ->  http://localhost:8787
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');

const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}
const KEY = process.env.AIAND_API_KEY;
const BASE = process.env.AIAND_BASE_URL || 'https://api.aiand.com/v1';
const MODEL = process.env.AIAND_MODEL || 'moonshotai/kimi-k3';
const EFFORT = process.env.AIAND_EFFORT || 'low';
const PORT = Number(process.env.PORT || 8787);
if (!KEY) { console.error('Missing AIAND_API_KEY in .env'); process.exit(1); }

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

async function igl(req, res) {
  let body = '';
  for await (const c of req) body += c;
  const { messages, tools } = JSON.parse(body);
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store' });
  const send = (o) => res.write(JSON.stringify(o) + '\n');
  const ctrl = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ctrl.abort(); });
  const t0 = Date.now();
  try {
    const up = await fetch(BASE + '/chat/completions', {
      method: 'POST', signal: ctrl.signal,
      headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MODEL, messages, tools, tool_choice: 'auto', reasoning_effort: EFFORT, max_tokens: 2000, stream: true }),
    });
    if (!up.ok) { send({ t: 'err', d: `ai& ${up.status}: ${(await up.text()).slice(0, 300)}` }); return res.end(); }
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of up.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let ev; try { ev = JSON.parse(data); } catch { continue; }
        for (const ch of ev.choices || []) {
          const d = ch.delta || {};
          if (d.reasoning_content) send({ t: 'r', d: d.reasoning_content });
          if (d.content) send({ t: 'c', d: d.content });
          for (const tc of d.tool_calls || []) if (tc.function?.arguments) send({ t: 'a', i: tc.index || 0, d: tc.function.arguments });
        }
      }
    }
    send({ t: 'end', ms: Date.now() - t0 });
    console.log(`[igl] ${MODEL} answered in ${Date.now() - t0}ms`);
  } catch (e) {
    send({ t: 'err', d: String(e.message || e) });
    console.log(`[igl] error after ${Date.now() - t0}ms: ${e.message || e}`);
  }
  res.end();
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/igl') return await igl(req, res);
    if (req.method === 'GET' && req.url === '/api/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ model: MODEL, effort: EFFORT }));
    }
    if (req.method !== 'GET') { res.writeHead(405); return res.end(); }
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p === '/') p = '/index.html';
    const file = path.normalize(path.join(PUBLIC, p));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    const data = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch (e) {
    if (!res.headersSent) res.writeHead(e.code === 'ENOENT' ? 404 : 500);
    res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => console.log(`AI Shotcaller → http://localhost:${PORT}   (model ${MODEL}, effort ${EFFORT})`));
