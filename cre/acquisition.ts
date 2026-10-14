import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { normalizePolicy } from '../src/policy.mjs';
import { canonicalJSON } from '../src/canonical.mjs';
import { evaluateEvidence } from '../src/evaluate.mjs';
export type Config = { schedule: string; requestId: string; policyHash: string; policy: unknown };
export type ReadJSON = (url: string) => Record<string, any>;
export function portablePolicyHash(policy: unknown): string {
  return bytesToHex(sha256(new TextEncoder().encode(`agentproof-ci-gate/policy/v1\0${canonicalJSON(policy)}`)));
}
export function validateConfig(config: Config) {
  if (!config || typeof config.schedule !== 'string' || config.schedule.length > 100 ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(config.requestId ?? '')) throw new Error('Invalid frozen request config');
  const policy = normalizePolicy(config.policy);
  if (portablePolicyHash(policy) !== config.policyHash) throw new Error('Frozen policy hash mismatch');
  return policy;
}
export function acquireReport(config: Config, nowMs: number, read: ReadJSON) {
  const policy = validateConfig(config), base = `https://api.github.com/repos/${policy.repository}`;
  const runURL = `${base}/actions/runs/${policy.runId}`;
  const snapshot = {
    repository: read(base), run: read(runURL),
    workflow: read(`${base}/actions/workflows/${policy.workflowId}`),
    workflowFile: read(`${base}/contents/${policy.workflowPath}?ref=${policy.commit}`),
    jobs: read(`${base}/actions/runs/${policy.runId}/attempts/${policy.runAttempt}/jobs?per_page=100`),
    runConfirmation: read(runURL), observedAtMs: nowMs,
  };
  // Returning runtime data is not verification of a DON-signed report. The local app cannot import it.
  return { version: 1, requestId: config.requestId, policyHash: config.policyHash,
    repositoryId: policy.repositoryId, commit: policy.commit, runId: policy.runId, runAttempt: policy.runAttempt,
    workflowId: policy.workflowId, workflowPath: policy.workflowPath, workflowBlobSha: policy.workflowBlobSha,
    observedAtMs: nowMs, verifiedDON: false, assurance: 'runtime-output-requires-independent-verification',
    result: evaluateEvidence(policy, snapshot, nowMs) };
}
