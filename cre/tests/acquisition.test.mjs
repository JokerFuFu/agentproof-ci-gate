import test from 'node:test';
import assert from 'node:assert/strict';
import { acquireReport, portablePolicyHash } from '../acquisition.ts';
import { makePolicy, makeSnapshot, NOW } from '../../tests/helpers.mjs';
import { policyHash } from '../../src/hash.mjs';
const config = () => ({ schedule: '0 */5 * * * *', requestId: '27a84710-d9a0-4af7-bc32-56ead4f96c04', policy: makePolicy(), policyHash: policyHash(makePolicy()) });
function reader(snapshot = makeSnapshot()) {
  const data = [snapshot.repository, snapshot.run, snapshot.workflow, snapshot.workflowFile, snapshot.jobs, snapshot.runConfirmation];
  const calls = []; return { calls, read: url => { calls.push(url); return data[calls.length - 1]; } };
}
test('portable CRE hash matches the frozen Node policy hash', () => {
  assert.equal(portablePolicyHash(makePolicy()), policyHash(makePolicy()));
});
test('CRE acquisition seam evaluates six external GET results and request binding', () => {
  const r = reader(), report = acquireReport(config(), NOW, r.read);
  assert.equal(report.result?.passed, true);
  assert.equal(report.requestId, config().requestId);
  assert.equal(report.policyHash, config().policyHash);
  assert.equal(report.verifiedDON, false);
  assert.equal(r.calls.length, 6);
  assert.ok(r.calls.every(url => url.startsWith('https://api.github.com/')));
});
test('CRE source rejects a changed fixed policy before contacting an API', () => {
  const c = config(); c.policy.runAttempt = 2; const r = reader();
  assert.throws(() => acquireReport(c, NOW, r.read), /policy hash/i);
  assert.equal(r.calls.length, 0);
});
test('CRE seam preserves old-commit and reread-change failures', () => {
  for (const mutate of [s => { s.run.head_sha = '0'.repeat(40); }, s => { s.runConfirmation.run_attempt++; }]) {
    const snapshot = makeSnapshot(); mutate(snapshot); const r = reader(snapshot);
    assert.equal(acquireReport(config(), NOW, r.read).result.passed, false);
  }
});
test('CRE acquisition errors cannot become a success report', () => {
  assert.throws(() => acquireReport(config(), NOW, () => { throw new Error('HTTP 403'); }), /403/);
});
