import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createLocalServer, startPreview } from '../src/server.mjs';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GateService } from '../src/gate.mjs';
import { MemoryStore } from '../src/store.mjs';
import { makePolicy, makeSnapshot, NOW } from './helpers.mjs';

async function environment(t, acquire = async request => makeSnapshot(request.policy)) {
  const gate = new GateService({ store: new MemoryStore(), clock: () => NOW, acquire });
  const server = createLocalServer({ gate }); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); gate.close(); });
  return { gate, server, url,
    post: (path, body, overrides = {}) => fetch(url + path, { method: 'POST',
      headers: { Origin: url, 'Content-Type': 'application/json', 'X-AgentProof-Client': 'local-preview', ...overrides }, body: JSON.stringify(body) }),
  };
}
test('HTTP delivery → fixed evidence → separate buyer acceptance', async t => {
  const { post, url } = await environment(t);
  let response = await post('/api/requests', { policy: makePolicy(), mode: 'fixture', scenario: 'pass' });
  assert.equal(response.status, 201);
  const r = await response.json();
  response = await post(`/api/requests/${r.id}/accept`, { actorId: 'local-buyer' });
  assert.equal(response.status, 409);
  assert.equal((await post(`/api/requests/${r.id}/check`, {})).status, 202);
  const state = await (await fetch(url + '/api/state')).json();
  assert.equal(state.requests[0].status, 'awaiting_review');
  assert.equal(state.capabilities.creSimulation, 'not-run');
  assert.equal((await post(`/api/requests/${r.id}/accept`, { actorId: 'local-agent' })).status, 403);
  response = await post(`/api/requests/${r.id}/accept`, { actorId: 'local-buyer' });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'accepted');
  const exported = await fetch(url + `/api/requests/${r.id}/export`);
  const data = await exported.json();
  assert.equal(data.assurance, 'local-prototype-record');
  assert.equal(data.request.evidence.source.kind, 'fixture');
});
test('HTTP acquisition failure is visible and preserves the manual block', async t => {
  const { post, url } = await environment(t, async () => { const error = new Error('GitHub returned HTTP 403'); error.code = 'GITHUB_HTTP_403'; throw error; });
  const r = await (await post('/api/requests', { policy: makePolicy(), mode: 'github-rest', scenario: 'pass' })).json();
  await post(`/api/requests/${r.id}/check`, {});
  const state = await (await fetch(url + '/api/state')).json();
  assert.equal(state.requests[0].status, 'blocked');
  assert.equal(state.requests[0].evaluation.reasons[0].code, 'GITHUB_HTTP_403');
  assert.equal((await post(`/api/requests/${r.id}/accept`, { actorId: 'local-buyer' })).status, 409);
});
test('HTTP cancellation invalidates an in-flight completion', async t => {
  let finish;
  const { post, url } = await environment(t, request => new Promise(resolve => { finish = () => resolve(makeSnapshot(request.policy)); }));
  const r = await (await post('/api/requests', { policy: makePolicy(), mode: 'fixture', scenario: 'pass' })).json();
  await post(`/api/requests/${r.id}/check`, {});
  const cancellation = await post(`/api/requests/${r.id}/cancel`, { actorId: 'local-agent' });
  assert.equal(cancellation.status, 200); finish();
  const state = await (await fetch(url + '/api/state')).json();
  assert.equal(state.requests[0].status, 'cancelled');
  assert.equal(state.requests[0].evidence, null);
});
test('cross-origin mutation is denied before creating state', async t => {
  const { post, gate } = await environment(t);
  const response = await post('/api/requests', { policy: makePolicy(), mode: 'fixture', scenario: 'pass' }, { Origin: 'https://other.example' });
  assert.equal(response.status, 403); assert.equal(gate.list().length, 0);
});
test('missing client header is denied', async t => {
  const { url } = await environment(t);
  const response = await fetch(url + '/api/requests', { method: 'POST', headers: { Origin: url, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 403);
});
test('interaction modules are explicit static routes; other core source stays inaccessible', async t => {
  const { url } = await environment(t);
  for (const path of ['/review.mjs', '/session.mjs', '/policy.mjs']) {
    const response = await fetch(url + path);
    assert.equal(response.status, 200, path + ' must be available for browser imports');
    assert.match(response.headers.get('content-type'), /text\/javascript/);
  }
  assert.equal((await fetch(url + '/src/gate.mjs')).status, 404);
  assert.equal((await fetch(url + '/src/store.mjs')).status, 404);
});
test('unknown input fields and arbitrary evidence are rejected', async t => {
  const { post } = await environment(t);
  assert.equal((await post('/api/requests', { policy: makePolicy(), mode: 'fixture', scenario: 'pass', evidence: makeSnapshot() })).status, 400);
  assert.equal((await post('/api/requests', { policy: { ...makePolicy(), approved: true }, mode: 'fixture', scenario: 'pass' })).status, 400);
  assert.equal((await post('/api/requests', { policy: makePolicy(), mode: 'cre-don', scenario: 'pass' })).status, 400);
});
test('payload and route boundaries fail closed', async t => {
  const { post, url } = await environment(t);
  assert.equal((await post('/api/requests', { oversized: 'x'.repeat(70_000) })).status, 413);
  assert.equal((await post('/api/not-a-route', {})).status, 404);
  assert.equal((await fetch(url + '/api/requests/missing/export')).status, 404);
  assert.equal((await fetch(url + '/src/store.mjs')).status, 404);
});
test('invalid check state and duplicate checks return errors without unhandled rejection', async t => {
  let complete;
  const { post } = await environment(t, request => new Promise(resolve => { complete = () => resolve(makeSnapshot(request.policy)); }));
  const r = await (await post('/api/requests', { policy: makePolicy(), mode: 'fixture', scenario: 'pass' })).json();
  assert.equal((await post(`/api/requests/${r.id}/check`, {})).status, 202);
  assert.equal((await post(`/api/requests/${r.id}/check`, {})).status, 409);
  complete();
  assert.equal((await post(`/api/requests/${r.id}/check`, {})).status, 409);
  assert.equal((await post('/api/requests/00000000-0000-0000-0000-000000000000/check', {})).status, 404);
});
test('failed listener startup releases its process lock so the local preview can be retried', async t => {
  const env = await environment(t), dir = mkdtempSync(join(tmpdir(), 'agentproof-startup-'));
  try {
    await assert.rejects(startPreview({ port: env.server.address().port, stateDir: dir }), e => e.code === 'EADDRINUSE');
    assert.equal(existsSync(join(dir, 'gate.lock')), false);
    const preview = await startPreview({ port: 0, stateDir: dir }); preview.shutdown();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
