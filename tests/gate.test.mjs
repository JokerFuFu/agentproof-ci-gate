import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GateService } from '../src/gate.mjs';
import { FileStore, MemoryStore } from '../src/store.mjs';
import { makePolicy, makeSnapshot, NOW } from './helpers.mjs';

const setup = ({ store = new MemoryStore(), acquire, clock } = {}) => new GateService({
  store, clock: clock ?? (() => NOW), acquire: acquire ?? (async request => makeSnapshot(request.policy)),
});
const create = (gate, options = {}) => gate.create({ policy: makePolicy(), buyerId: 'buyer', sellerId: 'agent', mode: 'fixture', scenario: 'pass', ...options });

test('a GitHub failure receipt is retained and its saved pause survives gate restart',async()=>{
  const {EvidenceError}=await import('../src/github.mjs');const store=new MemoryStore();let now=NOW,calls=0;
  const diagnostic={status:403,category:'primary-rate-limit',observedAtMs:NOW,retryAtMs:NOW+60_000,headers:{'x-ratelimit-remaining':'0'}};
  let gate=setup({store,clock:()=>now,acquire:async()=>{calls++;throw new EvidenceError('GITHUB_HTTP_403','Rate pause',diagnostic);}});
  const r=create(gate,{mode:'github-rest'}),failed=await gate.check(r.id);
  assert.equal(failed.acquisitionFailure?.retryAtMs,NOW+60_000);assert.equal(failed.status,'blocked');gate.close();
  gate=setup({store,clock:()=>now,acquire:async request=>{calls++;const s=makeSnapshot(request.policy);s.source.kind='github-rest';s.observedAtMs=now;return s;}});
  await assert.rejects(gate.check(r.id),e=>e.code==='GITHUB_RETRY_NOT_READY');assert.equal(calls,1);
  now+=60_001;const checked=await gate.check(r.id);assert.equal(checked.status,'awaiting_review');assert.equal(checked.acquisitionFailure,null);
});


test('CI is a prerequisite; only a separate buyer decision accepts the delivery', async () => {
  const gate = setup(), r = create(gate);
  assert.equal(r.status, 'pending');
  assert.throws(() => gate.accept(r.id, 'buyer'), e => e.code === 'REVIEW_NOT_READY');
  const checked = await gate.check(r.id);
  assert.equal(checked.status, 'awaiting_review');
  assert.equal(checked.decision, null);
  assert.throws(() => gate.accept(r.id, 'agent'), e => e.code === 'UNAUTHORIZED');
  const accepted = gate.accept(r.id, 'buyer');
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.decision.actorId, 'buyer');
  assert.equal(accepted.decision.kind, 'local-human');
  assert.equal(accepted.evidence.source.kind, 'fixture');
  assert.throws(() => gate.accept(r.id, 'buyer'), e => e.code === 'INVALID_STATE');
});
test('caller mutation cannot edit the frozen policy or returned state', () => {
  const gate = setup(), p = makePolicy(), r = create(gate, { policy: p });
  p.commit = '0'.repeat(40); r.policy.runAttempt = 99;
  assert.equal(gate.get(r.id).policy.commit, makePolicy().commit);
  assert.equal(gate.get(r.id).policy.runAttempt, 1);
});
test('failures remain visible and cannot be accepted', async () => {
  const gate = setup({ acquire: async request => {
    const s = makeSnapshot(request.policy); s.run.head_sha = '0'.repeat(40); return s;
  }});
  const r = create(gate), checked = await gate.check(r.id);
  assert.equal(checked.status, 'blocked');
  assert.ok(checked.evaluation.reasons.some(e => e.code === 'COMMIT_MISMATCH'));
  assert.throws(() => gate.accept(r.id, 'buyer'), e => e.code === 'REVIEW_NOT_READY');
});
test('source cannot be upgraded to DON provenance by injected report data', async () => {
  const gate = setup({ acquire: async () => ({ ...makeSnapshot(), source: { kind: 'cre-don' } }) });
  const checked = await gate.check(create(gate).id);
  assert.equal(checked.status, 'blocked');
  assert.ok(checked.evaluation.reasons.some(e => e.code === 'SOURCE_MISMATCH'));
});
test('consumed repository/run/attempt cannot open a second request', async () => {
  const gate = setup();
  const first = create(gate); await gate.check(first.id);
  const second = create(gate), checked = await gate.check(second.id);
  assert.equal(checked.status, 'blocked');
  assert.ok(checked.evaluation.reasons.some(e => e.code === 'REPLAY_DETECTED'));
});
test('a failed check does not consume its run', async () => {
  let fail = true;
  const gate = setup({ acquire: async () => { const s = makeSnapshot(); if (fail) s.run.conclusion = 'failure'; return s; } });
  const r = create(gate); await gate.check(r.id); fail = false;
  assert.equal((await gate.check(r.id)).status, 'awaiting_review');
});
test('no second acquisition is launched while checking', async () => {
  let resolve, count = 0;
  const gate = setup({ acquire: () => { count++; return new Promise(r => { resolve = r; }); } });
  const r = create(gate), checking = gate.check(r.id);
  assert.equal(gate.get(r.id).status, 'checking');
  await assert.rejects(gate.check(r.id), e => e.code === 'CHECK_ALREADY_RUNNING');
  assert.equal(count, 1);
  resolve(makeSnapshot()); await checking;
});
test('cancelled in-flight evidence cannot unlock review when it arrives late', async () => {
  let resolve;
  const gate = setup({ acquire: () => new Promise(r => { resolve = r; }) });
  const r = create(gate), checking = gate.check(r.id);
  gate.cancel(r.id, 'agent'); resolve(makeSnapshot()); await checking;
  assert.equal(gate.get(r.id).status, 'cancelled');
  assert.equal(gate.get(r.id).evidence, null);
  assert.throws(() => gate.accept(r.id, 'buyer'), e => e.code === 'INVALID_STATE');
});
test('cancellation requires buyer or submitter; accepted decisions are terminal', async () => {
  const gate = setup(), r = create(gate);
  assert.throws(() => gate.cancel(r.id, 'outsider'), e => e.code === 'UNAUTHORIZED');
  await gate.check(r.id); gate.accept(r.id, 'buyer');
  assert.throws(() => gate.cancel(r.id, 'agent'), e => e.code === 'INVALID_STATE');
});
test('buyer can reject without CI pass; submitter cannot reject', () => {
  const gate = setup(), r = create(gate);
  assert.throws(() => gate.reject(r.id, 'agent'), e => e.code === 'UNAUTHORIZED');
  assert.equal(gate.reject(r.id, 'buyer').status, 'rejected');
});
test('expired requests cannot begin acquisition', async () => {
  let clock = NOW;
  const gate = setup({ clock: () => clock }), r = create(gate, { policy: makePolicy({ requestTtlSeconds: 1 }) });
  clock += 1000;
  assert.equal(gate.get(r.id).status, 'expired');
  await assert.rejects(gate.check(r.id), e => e.code === 'INVALID_STATE');
});
test('evidence expiring between CI pass and acceptance closes the gate', async () => {
  let clock = NOW;
  const gate = setup({ clock: () => clock }), r = create(gate); await gate.check(r.id);
  clock += 821_000;
  assert.throws(() => gate.accept(r.id, 'buyer'), e => e.code === 'INVALID_STATE');
  assert.equal(gate.get(r.id).status, 'expired');
});
test('transport timeout is visible and clears the old evidence', async () => {
  const error = new Error('API timed out'); error.code = 'GITHUB_TIMEOUT';
  const gate = setup({ acquire: async () => { throw error; } });
  const checked = await gate.check(create(gate).id);
  assert.equal(checked.status, 'blocked');
  assert.equal(checked.evidence, null);
  assert.equal(checked.evaluation.reasons[0].code, 'GITHUB_TIMEOUT');
});
test('replay ledger survives an atomic file-store restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentproof-gate-'));
  try {
    const gate = setup({ store: new FileStore(dir) });
    await gate.check(create(gate).id); gate.close();
    const restarted = setup({ store: new FileStore(dir) });
    const checked = await restarted.check(create(restarted).id);
    assert.equal(checked.status, 'blocked');
    assert.ok(checked.evaluation.reasons.some(e => e.code === 'REPLAY_DETECTED'));
    restarted.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('restart converts interrupted checking to a blocking state', () => {
  const store = new MemoryStore();
  const gate = setup({ store, acquire: () => new Promise(() => {}) });
  const r = create(gate); void gate.check(r.id); gate.close();
  const restarted = setup({ store });
  const recovered = restarted.get(r.id);
  assert.equal(recovered.status, 'blocked');
  assert.equal(recovered.evaluation.reasons[0].code, 'ACQUISITION_INTERRUPTED');
  restarted.close();
});
test('a second process store cannot overwrite an active process state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentproof-lock-'));
  try {
    const store = new FileStore(dir);
    assert.throws(() => new FileStore(dir), /locked/);
    store.close();
    const next = new FileStore(dir); next.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('unknown requests and invalid modes never start acquisition', () => {
  const gate = setup();
  assert.throws(() => gate.get('missing'), e => e.code === 'NOT_FOUND');
  assert.throws(() => create(gate, { mode: 'cre-don' }), e => e.code === 'INVALID_MODE');
  assert.throws(() => create(gate, { buyerId: 'agent' }), e => e.code === 'INVALID_ACTORS');
});
test('persist failure does not produce a successful in-memory mutation', () => {
  const store = new MemoryStore(), gate = setup({ store });
  store.save = () => { throw new Error('disk full'); };
  assert.throws(() => create(gate), /disk full/);
  assert.equal(gate.list().length, 0);
});
test('an ambiguous durable-save failure quarantines further mutations', async () => {
  const store = new MemoryStore(), gate = setup({ store }), r = create(gate);
  await gate.check(r.id);
  const originalSave = store.save.bind(store);
  store.save = next => { originalSave(next); throw new Error('directory fsync EIO after rename'); };
  assert.throws(() => gate.cancel(r.id, 'agent'), /EIO/);
  store.save = originalSave;
  assert.equal(store.load().requests[r.id].status, 'cancelled');
  assert.throws(() => gate.accept(r.id, 'buyer'), e => e.code === 'STORAGE_FAULT');
  assert.equal(gate.get(r.id).status, 'blocked');
});
test('acceptance cannot cross expiry while obtaining its recorded timestamp', async () => {
  let at = NOW, calls = 0;
  const gate = setup({ clock: () => at }), r = create(gate); await gate.check(r.id);
  const expiry = gate.get(r.id).evaluation.validUntil;
  const volatileGate = new GateService({ store: { load: () => ({ schemaVersion: 1,
    requests: { [r.id]: gate.get(r.id) }, usedRuns: { [`${r.policy.repositoryId}:${r.policy.runId}:1`]: r.id } }), save() {}, close() {} },
    clock: () => (++calls >= 4 ? expiry : expiry - 1), acquire: async () => makeSnapshot() });
  assert.throws(() => volatileGate.accept(r.id, 'buyer'), e => e.code === 'INVALID_STATE' || e.code === 'REVIEW_NOT_READY');
  assert.notEqual(volatileGate.get(r.id).status, 'accepted');
});
test('an interrupted acquisition recovers from the actual persisted file after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agentproof-interruption-'));
  try {
    const gate = setup({ store: new FileStore(dir), acquire: () => new Promise(() => {}) });
    const r = create(gate); void gate.check(r.id); gate.close();
    const restarted = setup({ store: new FileStore(dir) });
    assert.equal(restarted.get(r.id).evaluation.reasons[0].code, 'ACQUISITION_INTERRUPTED');
    assert.equal((await restarted.check(r.id)).status, 'awaiting_review'); restarted.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
