import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { GateService, GateError } from './gate.mjs';
import { FileStore } from './store.mjs';
import { PolicyError } from './policy.mjs';
import { createGitHubAcquirer } from './github.mjs';
import { acquireFixture, demoPolicy, SCENARIOS } from './fixtures.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LIMIT = 65_536;
const error = (code, message, status = 400) => Object.assign(new Error(message), { code, status });
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && Object.keys(value).every(key => keys.includes(key));
async function bodyJSON(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] ?? '')) throw error('JSON_REQUIRED', '请求须使用 JSON。', 415);
  if (Number(req.headers['content-length']) > LIMIT) throw error('PAYLOAD_TOO_LARGE', '请求超过 64 KiB。', 413);
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length; if (size > LIMIT) throw error('PAYLOAD_TOO_LARGE', '请求超过 64 KiB。', 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw error('INVALID_JSON', 'JSON 格式无效。'); }
}

export function createLocalServer({ gate, publicDir = resolve(ROOT, 'public') }) {
  const files = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.mjs': ['app.mjs', 'text/javascript; charset=utf-8'],
    '/review.mjs': ['review.mjs', 'text/javascript; charset=utf-8'], '/session.mjs': ['session.mjs', 'text/javascript; charset=utf-8'],
    '/policy.mjs': ['../src/policy.mjs', 'text/javascript; charset=utf-8'],
    '/style.css': ['style.css', 'text/css; charset=utf-8'], '/favicon.svg': ['favicon.svg', 'image/svg+xml'] };
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const send = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
    try {
      const port = server.address()?.port;
      const host = `127.0.0.1:${port}`;
      if (req.headers.host !== host) throw error('HOST_DENIED', '仅允许 loopback 主机访问。', 421);
      const url = new URL(req.url, `http://${host}`), path = url.pathname;
      if (req.method === 'POST') {
        if (req.headers.origin !== `http://${host}` || req.headers['x-agentproof-client'] !== 'local-preview') {
          throw error('ORIGIN_DENIED', '仅允许本地预览页面发起变更。', 403);
        }
        const body = await bodyJSON(req);
        if (path === '/api/requests') {
          if (!exact(body, ['policy', 'mode', 'scenario'])) throw error('INVALID_INPUT', '创建请求仅接受 policy、mode 和 scenario。');
          if (body.mode === 'fixture' && !SCENARIOS.includes(body.scenario)) throw error('INVALID_SCENARIO', '演示场景无效。');
          if (body.mode === 'github-rest' && body.scenario !== 'pass') throw error('INVALID_SCENARIO', '真实 GitHub 路径不使用 fixture 场景。');
          send(201, gate.create({ ...body, buyerId: 'local-buyer', sellerId: 'local-agent' })); return;
        }
        const match = /^\/api\/requests\/([a-f0-9-]{36})\/(check|accept|reject|cancel)$/.exec(path);
        if (!match) throw error('NOT_FOUND', '接口不存在。', 404);
        const [, id, action] = match;
        if (action === 'check') {
          if (!exact(body, [])) throw error('INVALID_INPUT', '读取接口不接受证据或 verdict。');
          const before = gate.get(id);
          if (before.storageFault) throw new GateError('STORAGE_FAULT', '本地保存结果不确定，已停止变更。');
          if (before.status === 'checking') throw new GateError('CHECK_ALREADY_RUNNING', '已有证据读取正在进行。');
          if (!['pending', 'blocked'].includes(before.status)) throw new GateError('INVALID_STATE', '当前状态不允许再次读取。');
          const promise = gate.check(id);
          promise.catch(e => { console.error(`Background check failed: ${e.code ?? e.name}`); });
          send(202, gate.get(id)); return;
        }
        if (!exact(body, ['actorId'])) throw error('INVALID_INPUT', '人工操作仅接受本地 actorId。');
        send(200, gate[action](id, body.actorId)); return;
      }
      if (req.method !== 'GET') throw error('METHOD_DENIED', '仅支持 GET 或 POST。', 405);
      if (path === '/api/state') {
        send(200, { requests: gate.list(), capabilities: { creSimulation: 'not-run', don: 'not-deployed',
          humanIdentity: 'local-role-model', externalEvidence: 'public-github-rest-no-token' } }); return;
      }
      if (path === '/api/preset') { send(200, { policy: demoPolicy(), scenarios: SCENARIOS }); return; }
      const exported = /^\/api\/requests\/([a-f0-9-]{36})\/export$/.exec(path);
      if (exported) {
        res.setHeader('Content-Disposition', `attachment; filename="agentproof-ci-gate-${exported[1]}.json"`);
        send(200, { version: 1, assurance: 'local-prototype-record',
          warning: 'Exported data is not authoritative evidence or a DON-signed report. No wallet signature or chain finality.', request: gate.get(exported[1]) }); return;
      }
      const file = files[path];
      if (!file) throw error('NOT_FOUND', '页面不存在。', 404);
      const content = readFileSync(resolve(publicDir, file[0]));
      res.writeHead(200, { 'Content-Type': file[1] }); res.end(content);
    } catch (e) {
      const status = e.status ?? (e instanceof PolicyError ? 400 : e instanceof GateError ?
        ({ UNAUTHORIZED: 403, NOT_FOUND: 404, INVALID_MODE: 400, INVALID_ACTORS: 400, INVALID_SCENARIO: 400, INVALID_POLICY_TIME: 400 }[e.code] ?? 409) : 500);
      send(status, { error: e.code ?? e.name, detail: status === 500 ? '本地服务无法完成操作，状态未确认；请检查终端。' : e.message });
      if (status === 500) console.error(`Local server error: ${e.code ?? e.name}`);
    }
  });
  server.requestTimeout = 10_000; server.headersTimeout = 5000;
  return server;
}

export async function startPreview({ port = 5213, stateDir = resolve(ROOT, '.local', 'gate') } = {}) {
  const store = new FileStore(stateDir);
  let gate, acquireGitHub;
  try { gate = new GateService({ store, acquire: (request, options) => request.mode === 'fixture' ?
    acquireFixture(request, options) : acquireGitHub(request.policy, options) });
    const resumeAfterMs = Math.max(0, ...gate.list().filter(r => r.mode === 'github-rest')
      .flatMap(r => [r.acquisitionFailure?.retryAtMs, ...(r.evidence?.snapshot?.acquisition ?? []).map(d => d.quotaPauseUntilMs)])
      .filter(Number.isSafeInteger));
    acquireGitHub = createGitHubAcquirer({ resumeAfterMs });
  }
  catch (e) { store.close(); throw e; }
  const server = createLocalServer({ gate });
  try { await new Promise((ready, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', ready); }); }
  catch (e) { gate.close(); throw e; }
  const shutdown = () => { gate.close(); server.close(); server.closeAllConnections(); };
  return { server, gate, shutdown, url: `http://127.0.0.1:${server.address().port}` };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const preview = await startPreview({ port: Number(process.env.AGENTPROOF_GATE_PORT ?? 5213),
      stateDir: process.env.AGENTPROOF_GATE_STATE_DIR ?? resolve(ROOT, '.local', 'gate') });
    console.log(`AgentProof CI Gate local preview: ${preview.url}\nFixture ≠ CRE simulation ≠ DON. No external writes.`);
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { preview.shutdown(); process.exit(0); });
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
