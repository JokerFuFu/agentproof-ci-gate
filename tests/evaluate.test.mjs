import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePolicy } from '../src/policy.mjs';
import { evaluateEvidence } from '../src/evaluate.mjs';
import { policyHash } from '../src/hash.mjs';
import { makePolicy, makeSnapshot, NOW } from './helpers.mjs';

test('a fixed successful delivery unlocks review until its earliest evidence expiry', () => {
  const policy = normalizePolicy(makePolicy());
  const result = evaluateEvidence(policy, makeSnapshot(policy), NOW);
  assert.equal(result.passed, true);
  assert.equal(result.validUntil, NOW - 80_000 + 900_000);
  assert.equal(result.reasons.length, 0);
  assert.equal(result.checks.filter(c => c.kind === 'job').length, 2);
});

const failures = [
  ['old commit', s => { s.run.head_sha = '0'.repeat(40); }, 'COMMIT_MISMATCH'],
  ['foreign repository ID', s => { s.repository.id++; }, 'REPOSITORY_MISMATCH'],
  ['renamed repository', s => { s.repository.full_name = 'other/agent-delivery'; }, 'REPOSITORY_MISMATCH'],
  ['foreign run repository', s => { s.run.repository = { id: 77, full_name: 'other/repo' }; }, 'RUN_REPOSITORY_MISMATCH'],
  ['fork head repository', s => { s.run.head_repository = { id: 77, full_name: 'other/fork' }; }, 'HEAD_REPOSITORY_MISMATCH'],
  ['wrong run', s => { s.run.id++; }, 'RUN_MISMATCH'],
  ['wrong attempt', s => { s.run.run_attempt++; }, 'ATTEMPT_MISMATCH'],
  ['wrong workflow', s => { s.run.workflow_id++; }, 'WORKFLOW_MISMATCH'],
  ['wrong workflow metadata', s => { s.workflow.id++; }, 'WORKFLOW_MISMATCH'],
  ['wrong workflow path', s => { s.run.path = '.github/workflows/other.yml'; }, 'WORKFLOW_PATH_MISMATCH'],
  ['wrong workflow file', s => { s.workflowFile.sha = 'f'.repeat(40); }, 'WORKFLOW_BLOB_MISMATCH'],
  ['symlink workflow', s => { s.workflowFile.type = 'symlink'; }, 'WORKFLOW_BLOB_MISMATCH'],
  ['different branch', s => { s.run.head_branch = 'main'; }, 'BRANCH_MISMATCH'],
  ['unsafe trigger event', s => { s.run.event = 'pull_request_target'; }, 'EVENT_MISMATCH'],
  ['failed run', s => { s.run.conclusion = 'failure'; }, 'RUN_NOT_SUCCESSFUL'],
  ['cancelled run', s => { s.run.conclusion = 'cancelled'; }, 'RUN_NOT_SUCCESSFUL'],
  ['in progress run', s => { s.run.status = 'in_progress'; s.run.conclusion = null; }, 'RUN_NOT_SUCCESSFUL'],
  ['missing job', s => { s.jobs.jobs.pop(); s.jobs.total_count--; }, 'REQUIRED_JOB_MISSING'],
  ['partial job list', s => { s.jobs.total_count++; }, 'INCOMPLETE_JOBS'],
  ['empty jobs', s => { s.jobs = { jobs: [], total_count: 0 }; }, 'REQUIRED_JOB_MISSING'],
  ['duplicate job name', s => { s.jobs.jobs.push({ ...s.jobs.jobs[0], id: 555 }); s.jobs.total_count++; }, 'AMBIGUOUS_JOB'],
  ['failed job', s => { s.jobs.jobs[0].conclusion = 'failure'; }, 'JOB_NOT_SUCCESSFUL'],
  ['skipped mandatory job', s => { s.jobs.jobs[0].conclusion = 'skipped'; }, 'JOB_NOT_SUCCESSFUL'],
  ['neutral mandatory job', s => { s.jobs.jobs[0].conclusion = 'neutral'; }, 'JOB_NOT_SUCCESSFUL'],
  ['job from another run', s => { s.jobs.jobs[0].run_id++; }, 'JOB_BINDING_MISMATCH'],
  ['job from another attempt', s => { s.jobs.jobs[0].run_attempt++; }, 'JOB_BINDING_MISMATCH'],
  ['job on another commit', s => { s.jobs.jobs[0].head_sha = '0'.repeat(40); }, 'JOB_BINDING_MISMATCH'],
  ['missing mandatory step', s => { s.jobs.jobs[0].steps = []; }, 'REQUIRED_STEP_MISSING'],
  ['duplicate mandatory step', s => { s.jobs.jobs[0].steps.push({ ...s.jobs.jobs[0].steps[0], number: 5 }); }, 'AMBIGUOUS_STEP'],
  ['failure hidden by continue-on-error', s => { s.jobs.jobs[0].steps[0].conclusion = 'failure'; }, 'STEP_NOT_SUCCESSFUL'],
  ['skipped mandatory step', s => { s.jobs.jobs[0].steps[0].conclusion = 'skipped'; }, 'STEP_NOT_SUCCESSFUL'],
  ['expired evidence', s => { s.jobs.jobs[0].completed_at = new Date(NOW - 901_000).toISOString(); }, 'STALE_EVIDENCE'],
  ['future observation', s => { s.observedAtMs = NOW + 60_000; }, 'INVALID_OBSERVATION_TIME'],
  ['future run', s => { s.run.updated_at = new Date(NOW + 60_000).toISOString(); }, 'INVALID_RUN_TIME'],
  ['future job', s => { s.jobs.jobs[0].completed_at = new Date(NOW + 60_000).toISOString(); }, 'INVALID_JOB_TIME'],
  ['future mandatory step', s => { s.jobs.jobs[0].steps[0].completed_at = new Date(NOW + 60_000).toISOString(); }, 'INVALID_STEP_TIME'],
  ['run before policy time', s => { s.run.run_started_at = new Date(NOW - 500_000).toISOString(); }, 'RUN_BEFORE_POLICY_WINDOW'],
  ['invalid timestamp', s => { s.jobs.jobs[0].completed_at = 'yesterday'; }, 'INVALID_JOB_TIME'],
  ['impossible calendar date', s => { s.run.updated_at = '2026-02-30T12:00:00Z'; }, 'INVALID_RUN_TIME'],
  ['changed attempt while fetching', s => { s.runConfirmation.run_attempt++; }, 'RUN_CHANGED_DURING_FETCH'],
  ['changed status while fetching', s => { s.runConfirmation.conclusion = 'cancelled'; }, 'RUN_CHANGED_DURING_FETCH'],
  ['missing confirming read', s => { delete s.runConfirmation; }, 'RUN_CHANGED_DURING_FETCH'],
];
for (const [name, mutate, code] of failures) {
  test(`blocks ${name}`, () => {
    const policy = makePolicy();
    const snapshot = makeSnapshot(policy);
    mutate(snapshot);
    const result = evaluateEvidence(policy, snapshot, NOW);
    assert.equal(result.passed, false);
    assert.ok(result.reasons.some(r => r.code === code), JSON.stringify(result));
  });
}
test('missing or malformed payloads fail closed without throwing', () => {
  for (const data of [null, {}, [], { jobs: {} }, { run: null }]) {
    const result = evaluateEvidence(makePolicy(), data, NOW);
    assert.equal(result.passed, false);
    assert.ok(result.reasons.length > 0);
  }
});
test('expired mandatory steps cannot inherit a newer job completion', () => {
  const s = makeSnapshot();
  s.jobs.jobs[0].steps[0].completed_at = new Date(NOW - 901_000).toISOString();
  assert.ok(evaluateEvidence(makePolicy(), s, NOW).reasons.some(r => r.code === 'STALE_EVIDENCE'));
});
test('malformed nested repository names produce a blocking result without throwing', () => {
  for (const modify of [
    s => { s.run.repository = { id: 42424242, full_name: 123 }; },
    s => { s.runConfirmation.repository = { id: 42424242, full_name: 123 }; },
    s => { s.run.head_repository = { id: 42424242, full_name: [] }; },
  ]) {
    const s = makeSnapshot(); modify(s);
    assert.equal(evaluateEvidence(makePolicy(), s, NOW).passed, false);
  }
});
test('malformed status objects cannot throw while forming failure diagnostics', () => {
  for (const modify of [
    s => { s.run.status = { toString: 0 }; },
    s => { s.run.conclusion = { toString: 0 }; },
    s => { s.jobs.jobs[0].conclusion = { toString: 0 }; },
    s => { s.jobs.jobs[0].steps[0].conclusion = { toString: 0 }; },
  ]) {
    const s = makeSnapshot(); modify(s);
    assert.equal(evaluateEvidence(makePolicy(), s, NOW).passed, false);
  }
});
test('policy canonicalization is deterministic and detached from its input', () => {
  const input = makePolicy({ repository: 'Demo-Buyer/Agent-Delivery' });
  const policy = normalizePolicy(input);
  assert.equal(policy.repository, 'demo-buyer/agent-delivery');
  input.requiredJobs[0].steps.push('Injected later');
  assert.equal(policy.requiredJobs[0].steps.length, 1);
  const reversedKeys = Object.fromEntries(Object.entries(policy).reverse());
  assert.match(policyHash(policy), /^[a-f0-9]{64}$/);
  assert.equal(policyHash(policy), policyHash(reversedKeys));
  assert.notEqual(policyHash(policy), policyHash({ ...policy, runAttempt: 2 }));
});
for (const [name, mutate] of [
  ['short commit', p => { p.commit = '7a1a48e'; }],
  ['invalid repository', p => { p.repository = '../bad'; }],
  ['URL repository', p => { p.repository = 'https://github.com/a/b'; }],
  ['zero repository ID', p => { p.repositoryId = 0; }],
  ['unsafe run ID', p => { p.runId = Number.MAX_SAFE_INTEGER + 1; }],
  ['unknown field', p => { p.approved = true; }],
  ['unsafe workflow path', p => { p.workflowPath = '.github/workflows/../ci.yml'; }],
  ['empty mandatory jobs', p => { p.requiredJobs = []; }],
  ['duplicate mandatory jobs', p => { p.requiredJobs.push(p.requiredJobs[0]); }],
  ['empty mandatory steps', p => { p.requiredJobs[0].steps = []; }],
  ['duplicate mandatory steps', p => { p.requiredJobs[0].steps.push(p.requiredJobs[0].steps[0]); }],
  ['unknown job fields', p => { p.requiredJobs[0].allowFailure = true; }],
  ['unsafe trigger', p => { p.event = 'pull_request_target'; }],
  ['unbounded evidence age', p => { p.maxEvidenceAgeSeconds = Infinity; }],
  ['expired lifetime', p => { p.requestTtlSeconds = 0; }],
  ['malformed not-before', p => { p.notBeforeMs = NaN; }],
]) {
  test(`policy rejects ${name}`, () => {
    const policy = makePolicy(); mutate(policy);
    assert.throws(() => normalizePolicy(policy), { name: 'PolicyError' });
  });
}
