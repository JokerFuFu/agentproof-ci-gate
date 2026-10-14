import { EvidenceError } from './github.mjs';
export const SCENARIOS = ['pass', 'failed-step', 'old-commit', 'expired-evidence', 'wrong-repository',
  'wrong-workflow', 'partial-jobs', 'cancelled-run', 'in-progress', 'timeout', 'interrupted', 'short-expiry'];
export function demoPolicy(nowMs = Date.now(), runId = nowMs) {
  return {
    version: 1, repository: 'demo-buyer/agent-delivery', repositoryId: 42424242,
    commit: 'b8c4474af08d432d9fe7ca0d8de045781d92c614', runId, runAttempt: 1,
    workflowId: 810001, workflowPath: '.github/workflows/acceptance.yml',
    workflowBlobSha: '1091f425fe16b95b64f8b2a12ca82347eaad5984',
    branch: 'delivery/ci-gate', event: 'push',
    requiredJobs: [{ name: 'unit-tests', steps: ['Run unit tests'] }, { name: 'dependency-check', steps: ['Check dependencies'] }],
    notBeforeMs: nowMs - 900_000, maxEvidenceAgeSeconds: 900, requestTtlSeconds: 3600,
  };
}
function snapshotFor(policy, nowMs) {
  const t = offset => new Date(nowMs + offset).toISOString();
  const repository = { id: policy.repositoryId, full_name: policy.repository };
  const run = { id: policy.runId, run_attempt: policy.runAttempt, workflow_id: policy.workflowId,
    repository, head_repository: repository, head_sha: policy.commit, path: policy.workflowPath,
    head_branch: policy.branch, event: policy.event, status: 'completed', conclusion: 'success',
    created_at: t(-10_000), run_started_at: t(-10_000), updated_at: t(-1000) };
  return {
    observedAtMs: nowMs,
    source: { kind: 'fixture', execution: 'node-local', note: 'Synthetic fixtures generated locally; no GitHub HTTP, CRE simulation, or DON execution.' },
    repository, run, runConfirmation: structuredClone(run),
    workflow: { id: policy.workflowId, path: policy.workflowPath, state: 'active' },
    workflowFile: { type: 'file', path: policy.workflowPath, sha: policy.workflowBlobSha },
    jobs: { total_count: policy.requiredJobs.length, jobs: policy.requiredJobs.map((spec, i) => ({
      id: 10000 + i, name: spec.name, run_id: policy.runId, run_attempt: policy.runAttempt,
      head_sha: policy.commit, status: 'completed', conclusion: 'success', started_at: t(-9000), completed_at: t(-1500),
      steps: spec.steps.map((name, j) => ({ name, number: j + 1, status: 'completed', conclusion: 'success',
        started_at: t(-8000), completed_at: t(-2000) })),
    })) },
  };
}
export async function acquireFixture(request, { signal, delayMs = 550, clock = Date.now } = {}) {
  if (!SCENARIOS.includes(request.scenario)) throw new EvidenceError('INVALID_SCENARIO', 'fixture 场景无效。');
  signal?.throwIfAborted();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, delayMs);
    function abort() { clearTimeout(timer); reject(signal.reason); }
    signal?.addEventListener('abort', abort, { once: true });
  });
  if (request.scenario === 'timeout') throw new EvidenceError('FIXTURE_TIMEOUT', '模拟外部读取超时；没有真实网络请求。');
  if (request.scenario === 'interrupted') throw new EvidenceError('FIXTURE_INTERRUPTED', '模拟证据读取中断；需主动重新读取。');
  const s = snapshotFor(request.policy, clock());
  switch (request.scenario) {
    case 'failed-step': s.jobs.jobs[0].steps[0].conclusion = 'failure'; break;
    case 'old-commit': s.run.head_sha = '0'.repeat(40); break;
    case 'expired-evidence': s.jobs.jobs[0].completed_at = new Date(clock() - 901_000).toISOString(); break;
    case 'wrong-repository': s.repository = { id: 17, full_name: 'another-owner/fork' }; break;
    case 'wrong-workflow': s.workflowFile.sha = 'f'.repeat(40); break;
    case 'partial-jobs': s.jobs.total_count++; break;
    case 'cancelled-run': s.run.conclusion = 'cancelled'; break;
    case 'in-progress': s.run.status = 'in_progress'; s.run.conclusion = null; break;
  }
  s.runConfirmation = structuredClone(s.run);
  return s;
}
