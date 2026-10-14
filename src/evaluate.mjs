import { normalizePolicy, parseTimestamp, CLOCK_SKEW_MS, runIdentity } from './policy.mjs';

const record = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const positiveId = v => Number.isSafeInteger(v) && v > 0;
const scalar = value => typeof value === 'string' ? value.slice(0, 80) :
  typeof value === 'number' || typeof value === 'boolean' ? String(value) : 'unknown';
const repoMatches = (repo, p) => record(repo) && repo.id === p.repositoryId &&
  typeof repo.full_name === 'string' && repo.full_name.toLowerCase() === p.repository;

export function evaluateEvidence(input, snapshot, nowMs) {
  const reasons = [], checks = [], expiries = [];
  const block = (code, detail) => reasons.push({ code, detail });
  const result = () => ({ passed: reasons.length === 0, reasons, checks,
    validUntil: reasons.length === 0 && expiries.length ? Math.min(...expiries) : null });
  let p;
  try { p = normalizePolicy(input); } catch {
    block('INVALID_POLICY', '冻结的验收策略无效。'); return result();
  }
  if (!record(snapshot) || !record(snapshot.run) || !record(snapshot.repository) ||
      !record(snapshot.workflow) || !record(snapshot.workflowFile) || !record(snapshot.jobs) ||
      !Array.isArray(snapshot.jobs.jobs) || !Number.isSafeInteger(nowMs)) {
    block('MALFORMED_EVIDENCE', '证据缺少必需字段，不能开放验收。'); return result();
  }
  const ageMs = p.maxEvidenceAgeSeconds * 1000;
  const observed = snapshot.observedAtMs;
  if (!Number.isSafeInteger(observed) || observed > nowMs || observed < nowMs - ageMs) {
    block('INVALID_OBSERVATION_TIME', '证据读取时间无效或已过期。');
  }
  const upperTime = Math.min(Number.isSafeInteger(observed) ? observed : nowMs, nowMs) + CLOCK_SKEW_MS;
  const fresh = (time, label) => {
    if (Number.isFinite(time)) {
      expiries.push(time + ageMs);
      if (time + ageMs <= nowMs) block('STALE_EVIDENCE', `${label}已超过证据有效期。`);
    }
  };
  const bind = (condition, code, detail) => { if (!condition) block(code, detail); };
  const run = snapshot.run;
  bind(repoMatches(snapshot.repository, p), 'REPOSITORY_MISMATCH', '仓库 ID 或名称与冻结策略不同。');
  bind(repoMatches(run.repository, p), 'RUN_REPOSITORY_MISMATCH', '此 run 属于另一仓库。');
  bind(repoMatches(run.head_repository, p), 'HEAD_REPOSITORY_MISMATCH', '此 run 的代码来自另一仓库或 fork。');
  bind(run.head_sha === p.commit, 'COMMIT_MISMATCH', 'CI 检查的 commit 与交付 commit 不同。');
  bind(run.id === p.runId, 'RUN_MISMATCH', 'run ID 与冻结策略不同。');
  bind(run.run_attempt === p.runAttempt, 'ATTEMPT_MISMATCH', 'run attempt 与冻结策略不同。');
  bind(run.workflow_id === p.workflowId && snapshot.workflow.id === p.workflowId,
    'WORKFLOW_MISMATCH', 'workflow ID 与买方冻结策略不同。');
  bind(run.path === p.workflowPath && snapshot.workflow.path === p.workflowPath,
    'WORKFLOW_PATH_MISMATCH', 'workflow 路径与冻结策略不同。');
  bind(snapshot.workflowFile.type === 'file' && snapshot.workflowFile.path === p.workflowPath &&
    snapshot.workflowFile.sha === p.workflowBlobSha, 'WORKFLOW_BLOB_MISMATCH', '交付 commit 上的 workflow 文件哈希与买方确认版本不同。');
  bind(run.head_branch === p.branch, 'BRANCH_MISMATCH', 'CI 分支与冻结策略不同。');
  bind(run.event === p.event, 'EVENT_MISMATCH', 'CI 触发事件与冻结策略不同。');
  bind(run.status === 'completed' && run.conclusion === 'success', 'RUN_NOT_SUCCESSFUL', `CI run 尚未成功完成（${scalar(run.status)} / ${scalar(run.conclusion)}）。`);
  const confirmed = runIdentity(snapshot.runConfirmation);
  bind(confirmed !== null && JSON.stringify(runIdentity(run)) === JSON.stringify(confirmed),
    'RUN_CHANGED_DURING_FETCH', '读取期间 run 已变化或缺少第二次确认，需重新读取。');
  const runCreated = parseTimestamp(run.created_at), runStart = parseTimestamp(run.run_started_at), runEnd = parseTimestamp(run.updated_at);
  bind([runCreated, runStart, runEnd].every(Number.isFinite) && runCreated <= runStart && runStart <= runEnd &&
    runEnd <= upperTime, 'INVALID_RUN_TIME', 'CI run 时间无效、顺序异常或来自未来。');
  bind(Number.isFinite(runStart) && runStart >= p.notBeforeMs, 'RUN_BEFORE_POLICY_WINDOW', 'CI run 早于买方规定的检查窗口。');
  fresh(runEnd, 'CI run');

  const jobs = snapshot.jobs.jobs;
  bind(Number.isSafeInteger(snapshot.jobs.total_count) && snapshot.jobs.total_count >= 0 &&
    snapshot.jobs.total_count === jobs.length && jobs.length <= 100 && jobs.every(record),
    'INCOMPLETE_JOBS', 'job 列表不完整或超过本版 100 个 job 的检查上限。');
  if (jobs.some(job => !record(job) || !positiveId(job.id)) || new Set(jobs.map(job => job?.id)).size !== jobs.length) {
    block('MALFORMED_JOBS', 'job ID 缺失或重复。');
  }
  for (const spec of p.requiredJobs) {
    const matches = jobs.filter(job => record(job) && job.name === spec.name);
    const before = reasons.length;
    if (matches.length !== 1) {
      block(matches.length === 0 ? 'REQUIRED_JOB_MISSING' : 'AMBIGUOUS_JOB', `必需 job「${spec.name}」缺失或出现重名。`);
      checks.push({ kind: 'job', name: spec.name, passed: false, status: 'missing', steps: [] }); continue;
    }
    const job = matches[0];
    bind(job.run_id === p.runId && job.run_attempt === p.runAttempt && job.head_sha === p.commit,
      'JOB_BINDING_MISMATCH', `job「${spec.name}」不属于固定的 run/attempt/commit。`);
    bind(job.status === 'completed' && job.conclusion === 'success', 'JOB_NOT_SUCCESSFUL', `必需 job「${spec.name}」未成功完成（${scalar(job.conclusion ?? job.status)}）。`);
    const start = parseTimestamp(job.started_at), end = parseTimestamp(job.completed_at);
    bind(Number.isFinite(start) && Number.isFinite(end) && start <= end && end <= upperTime &&
      start >= runStart - CLOCK_SKEW_MS && end <= runEnd + CLOCK_SKEW_MS,
      'INVALID_JOB_TIME', `job「${spec.name}」时间无效或顺序异常。`);
    fresh(end, `job「${spec.name}」`);
    const steps = Array.isArray(job.steps) ? job.steps : [];
    const stepChecks = [];
    for (const name of spec.steps) {
      const found = steps.filter(step => record(step) && step.name === name);
      const stepBefore = reasons.length;
      if (found.length !== 1) {
        block(found.length === 0 ? 'REQUIRED_STEP_MISSING' : 'AMBIGUOUS_STEP', `job「${spec.name}」中的必需 step「${name}」缺失或重名。`);
      } else {
        const step = found[0];
        bind(step.status === 'completed' && step.conclusion === 'success', 'STEP_NOT_SUCCESSFUL', `必需 step「${name}」未成功完成（${scalar(step.conclusion ?? step.status)}）。`);
        const stepStart = parseTimestamp(step.started_at), stepEnd = parseTimestamp(step.completed_at);
        bind(Number.isFinite(stepStart) && Number.isFinite(stepEnd) && stepStart <= stepEnd && stepEnd <= upperTime &&
          stepStart >= start - CLOCK_SKEW_MS && stepEnd <= end + CLOCK_SKEW_MS,
          'INVALID_STEP_TIME', `step「${name}」时间无效或顺序异常。`);
        fresh(stepEnd, `step「${name}」`);
      }
      stepChecks.push({ name, passed: reasons.length === stepBefore, conclusion: scalar(found[0]?.conclusion ?? 'missing') });
    }
    checks.push({ kind: 'job', name: spec.name, passed: reasons.length === before,
      status: scalar(job.conclusion ?? job.status), completedAt: job.completed_at, steps: stepChecks });
  }
  checks.unshift({ kind: 'binding', name: '固定仓库 / commit / run / workflow', passed: !reasons.some(r => /MISMATCH|CHANGED|MALFORMED/.test(r.code)) });
  return result();
}
