export const NOW = Date.parse('2026-10-13T12:00:00.000Z');
export const COMMIT = 'b8c4474af08d432d9fe7ca0d8de045781d92c614';
export const BLOB = '1091f425fe16b95b64f8b2a12ca82347eaad5984';
export function makePolicy(overrides = {}) {
  return {
    version: 1, repository: 'demo-buyer/agent-delivery', repositoryId: 42424242,
    commit: COMMIT, runId: 9001001, runAttempt: 1, workflowId: 810001,
    workflowPath: '.github/workflows/acceptance.yml', workflowBlobSha: BLOB,
    branch: 'delivery/ci-gate', event: 'push',
    requiredJobs: [{ name: 'unit-tests', steps: ['Run unit tests'] }, { name: 'dependency-check', steps: ['Check dependencies'] }],
    notBeforeMs: NOW - 300_000, maxEvidenceAgeSeconds: 900, requestTtlSeconds: 3600,
    ...overrides,
  };
}
export function makeSnapshot(policy = makePolicy(), now = NOW) {
  const time = offset => new Date(now + offset).toISOString();
  const repository = { id: policy.repositoryId, full_name: policy.repository };
  const run = {
    id: policy.runId, run_attempt: policy.runAttempt, workflow_id: policy.workflowId,
    repository, head_repository: repository, head_sha: policy.commit, path: policy.workflowPath,
    head_branch: policy.branch, event: policy.event, status: 'completed', conclusion: 'success',
    created_at: time(-120_000), run_started_at: time(-120_000), updated_at: time(-60_000),
    html_url: `https://github.com/${policy.repository}/actions/runs/${policy.runId}`,
  };
  return {
    source: { kind: 'fixture', execution: 'node-local', note: 'Synthetic test data; no CRE execution.' },
    observedAtMs: now, repository, run, runConfirmation: structuredClone(run),
    workflow: { id: policy.workflowId, path: policy.workflowPath, state: 'active' },
    workflowFile: { type: 'file', path: policy.workflowPath, sha: policy.workflowBlobSha },
    jobs: {
      total_count: 2,
      jobs: policy.requiredJobs.map((spec, i) => ({
        id: 10000 + i, name: spec.name, run_id: policy.runId, run_attempt: policy.runAttempt,
        head_sha: policy.commit, status: 'completed', conclusion: 'success',
        started_at: time(-110_000), completed_at: time(-70_000),
        steps: spec.steps.map((name, j) => ({
          name, number: j + 1, status: 'completed', conclusion: 'success',
          started_at: time(-100_000), completed_at: time(-80_000),
        })),
      })),
    },
  };
}
