import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchGitHubEvidence } from '../src/github.mjs';
import { makePolicy, makeSnapshot, NOW } from './helpers.mjs';

function transport(overrides = {}) {
  const p = makePolicy(), s = makeSnapshot(p), calls = [];
  const bodies = [s.repository, s.run, s.workflow, s.workflowFile, s.jobs, s.runConfirmation];
  return {
    calls,
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), options });
      const i = calls.length - 1;
      if (overrides[i] instanceof Error) throw overrides[i];
      return overrides[i] ?? new Response(JSON.stringify(bodies[i]), { status: 200, headers: { 'Content-Type': 'application/json' } });
    },
  };
}
test('reads six pinned public GETs and stamps live local provenance', async () => {
  const t = transport();
  const result = await fetchGitHubEvidence(makePolicy(), { fetchImpl: t.fetchImpl, clock: () => NOW });
  assert.equal(result.source?.kind, 'github-rest');
  assert.equal(result.source?.execution, 'node-local');
  assert.equal(result.observedAtMs, NOW);
  assert.equal(t.calls.length, 6);
  const urls = t.calls.map(c => c.url);
  assert.ok(urls.includes(`https://api.github.com/repos/demo-buyer/agent-delivery/contents/.github/workflows/acceptance.yml?ref=${makePolicy().commit}`));
  assert.ok(urls.includes('https://api.github.com/repos/demo-buyer/agent-delivery/actions/runs/9001001/attempts/1/jobs?per_page=100'));
  assert.ok(t.calls.every(c => c.options.method === 'GET' && c.options.redirect === 'error'));
  assert.ok(t.calls.every(c => !c.options.headers.Authorization));
  assert.deepEqual(result.runConfirmation, result.run);
});
for (const status of [401, 403, 404, 429, 500]) {
  test(`HTTP ${status} fails closed without reading subsequent endpoints`, async () => {
    const t = transport({ 0: new Response('{"message":"external failure"}', { status, headers: { 'Content-Type': 'application/json' } }) });
    await assert.rejects(fetchGitHubEvidence(makePolicy(), { fetchImpl: t.fetchImpl }), e => e.code === `GITHUB_HTTP_${status}`);
    assert.equal(t.calls.length, 1);
  });
}
test('rejects redirects', async () => {
  const t = transport({ 0: new Response('', { status: 302, headers: { Location: 'https://evil.example/' } }) });
  await assert.rejects(fetchGitHubEvidence(makePolicy(), { fetchImpl: t.fetchImpl }), e => e.code === 'GITHUB_HTTP_302');
});
for (const [name, response] of [
  ['HTML response', new Response('<html>oops</html>', { headers: { 'Content-Type': 'text/html' } })],
  ['invalid JSON', new Response('{bad', { headers: { 'Content-Type': 'application/json' } })],
  ['null JSON', new Response('null', { headers: { 'Content-Type': 'application/json' } })],
  ['array JSON', new Response('[]', { headers: { 'Content-Type': 'application/json' } })],
]) {
  test(`rejects ${name}`, async () => {
    const t = transport({ 0: response });
    await assert.rejects(fetchGitHubEvidence(makePolicy(), { fetchImpl: t.fetchImpl }), e => e.code === 'INVALID_GITHUB_RESPONSE');
  });
}
test('rejects an oversized response body', async () => {
  const t = transport({ 0: new Response('x'.repeat(2_097_153), { headers: { 'Content-Type': 'application/json' } }) });
  await assert.rejects(fetchGitHubEvidence(makePolicy(), { fetchImpl: t.fetchImpl }), e => e.code === 'GITHUB_RESPONSE_TOO_LARGE');
});
test('rejects incomplete job pagination rather than accepting the first page', async () => {
  const s = makeSnapshot(); s.jobs.total_count = 101;
  const t = transport({ 4: new Response(JSON.stringify(s.jobs), { headers: { 'Content-Type': 'application/json' } }) });
  await assert.rejects(fetchGitHubEvidence(makePolicy(), { fetchImpl: t.fetchImpl }), e => e.code === 'INCOMPLETE_JOBS');
});
test('classifies a transport interruption', async () => {
  const t = transport({ 0: new Error('socket closed') });
  await assert.rejects(fetchGitHubEvidence(makePolicy(), { fetchImpl: t.fetchImpl }), e => e.code === 'GITHUB_NETWORK_ERROR');
});
test('bounded acquisition timeout aborts transport', async () => {
  const fetchImpl = (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
  const keeper = setInterval(() => {}, 100);
  try {
    await assert.rejects(fetchGitHubEvidence(makePolicy(), { fetchImpl, timeoutMs: 20 }), e => e.code === 'GITHUB_TIMEOUT');
  } finally { clearInterval(keeper); }
});
test('honors cancellation before starting a request', async () => {
  const controller = new AbortController(); controller.abort();
  const t = transport();
  await assert.rejects(fetchGitHubEvidence(makePolicy(), { fetchImpl: t.fetchImpl, signal: controller.signal }), e => e.code === 'ACQUISITION_CANCELLED');
  assert.equal(t.calls.length, 0);
});
test('invalid repository input never becomes a URL or network request', async () => {
  const t = transport();
  await assert.rejects(fetchGitHubEvidence(makePolicy({ repository: '127.0.0.1/internal' }), { fetchImpl: t.fetchImpl }));
  assert.equal(t.calls.length, 0);
});
