import { createHash } from 'node:crypto';
import { canonicalJSON } from './canonical.mjs';
export { canonicalJSON } from './canonical.mjs';
export function digest(domain, value) {
  return createHash('sha256').update(`${domain}\0${canonicalJSON(value)}`).digest('hex');
}
export function policyHash(policy) { return digest('agentproof-ci-gate/policy/v1', policy); }
