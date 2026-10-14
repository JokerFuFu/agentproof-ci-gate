export class PolicyError extends Error {
  constructor(message) { super(message); this.name = 'PolicyError'; }
}
const KEYS = ['version', 'repository', 'repositoryId', 'commit', 'runId', 'runAttempt',
  'workflowId', 'workflowPath', 'workflowBlobSha', 'branch', 'event', 'requiredJobs',
  'notBeforeMs', 'maxEvidenceAgeSeconds', 'requestTtlSeconds'];
const fail = message => { throw new PolicyError(message); };
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys, label) => {
  const ownKeys = isRecord(value) ? Object.keys(value).sort() : [];
  if (!isRecord(value) || ownKeys.length !== keys.length ||
      ownKeys.some(key => !keys.includes(key))) fail(`${label}: missing or unknown fields`);
};
const boundedInteger = (value, min, max, label) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`${label}: invalid integer`);
  return value;
};
const exactName = value => typeof value === 'string' && value.trim() === value &&
  value.length > 0 && value.length <= 150 && !/[\x00-\x1f\x7f]/.test(value);
export const CLOCK_SKEW_MS = 30_000;

export function normalizePolicy(input) {
  exactKeys(input, KEYS, 'Policy');
  if (input.version !== 1) fail('Unsupported policy version');
  const p = { ...input };
  if (typeof p.repository !== 'string') fail('Repository must be owner/name');
  p.repository = p.repository.toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9_.-]{0,99}$/.test(p.repository) ||
      p.repository.includes('..') || p.repository.endsWith('.git')) fail('Repository must be owner/name');
  for (const key of ['repositoryId', 'runId', 'runAttempt', 'workflowId']) {
    boundedInteger(p[key], 1, Number.MAX_SAFE_INTEGER, key);
  }
  for (const key of ['commit', 'workflowBlobSha']) {
    if (typeof p[key] !== 'string' || !/^[a-fA-F0-9]{40}$/.test(p[key])) fail(`${key}: full 40-character SHA required`);
    p[key] = p[key].toLowerCase();
  }
  if (typeof p.workflowPath !== 'string' || !/^\.github\/workflows\/[A-Za-z0-9_-][A-Za-z0-9_.-]*\.(yml|yaml)$/.test(p.workflowPath) ||
      p.workflowPath.includes('..') || p.workflowPath.length > 200) fail('Invalid workflow path');
  if (typeof p.branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(p.branch) ||
      p.branch.includes('..') || p.branch.includes('//') || /[/.]$/.test(p.branch)) fail('Invalid branch');
  if (!['push', 'workflow_dispatch'].includes(p.event)) fail('Only push or workflow_dispatch is supported');
  boundedInteger(p.notBeforeMs, 0, 8_640_000_000_000_000, 'notBeforeMs');
  boundedInteger(p.maxEvidenceAgeSeconds, 30, 86400, 'maxEvidenceAgeSeconds');
  boundedInteger(p.requestTtlSeconds, 1, 86400, 'requestTtlSeconds');
  if (!Array.isArray(p.requiredJobs) || p.requiredJobs.length < 1 || p.requiredJobs.length > 25) fail('Require 1–25 mandatory jobs');
  const jobNames = new Set();
  p.requiredJobs = p.requiredJobs.map(job => {
    exactKeys(job, ['name', 'steps'], 'Required job');
    if (!exactName(job.name) || jobNames.has(job.name)) fail('Invalid or duplicate mandatory job name');
    jobNames.add(job.name);
    if (!Array.isArray(job.steps) || job.steps.length < 1 || job.steps.length > 25 ||
        job.steps.some(step => !exactName(step)) || new Set(job.steps).size !== job.steps.length) {
      fail('Require distinct, nonempty mandatory step names');
    }
    return { name: job.name, steps: [...job.steps] };
  });
  return p;
}

export function parseTimestamp(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value)) return NaN;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return NaN;
  const normalized = value.includes('.') ? value : value.replace('Z', '.000Z');
  return new Date(time).toISOString() === normalized ? time : NaN;
}

// Comparison uses only evidence-binding fields, not volatile response metadata.
export function runIdentity(run) {
  if (!isRecord(run)) return null;
  const repoName = repo => typeof repo?.full_name === 'string' ? repo.full_name.toLowerCase() : null;
  return ['id', 'run_attempt', 'workflow_id', 'head_sha', 'path', 'head_branch', 'event',
    'status', 'conclusion', 'created_at', 'run_started_at', 'updated_at']
    .map(key => run[key] ?? null).concat([
      run.repository?.id ?? null, repoName(run.repository),
      run.head_repository?.id ?? null, repoName(run.head_repository),
    ]);
}
