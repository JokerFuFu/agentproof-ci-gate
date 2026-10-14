import { randomUUID } from 'node:crypto';
import { normalizePolicy, CLOCK_SKEW_MS } from './policy.mjs';
import { evaluateEvidence } from './evaluate.mjs';
import { policyHash, digest } from './hash.mjs';
import { EvidenceError } from './github.mjs';

export class GateError extends Error {
  constructor(code, message) { super(message); this.name = 'GateError'; this.code = code; }
}
const deny = (code, detail) => { throw new GateError(code, detail); };
const terminal = new Set(['accepted', 'rejected', 'cancelled', 'expired']);
const reasonResult = (code, detail) => ({ passed: false, reasons: [{ code, detail }], checks: [], validUntil: null });
const event = (request, type, atMs, detail) => request.history.push({ type, atMs, detail });
const runKey = p => `${p.repositoryId}:${p.runId}:${p.runAttempt}`;
const actorValid = actor => typeof actor === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(actor);

export class GateService {
  #store; #state; #clock; #acquire; #controllers = new Map(); #closed = false; #storageFault = false;
  constructor({ store, clock = Date.now, acquire }) {
    this.#store = store; this.#clock = clock; this.#acquire = acquire; this.#state = store.load();
    const s = this.#state;
    if (s?.schemaVersion !== 1 || !s.requests || Array.isArray(s.requests) || !s.usedRuns || Array.isArray(s.usedRuns)) {
      throw new Error('Invalid persistent gate state; refusing to discard replay protection.');
    }
    for (const request of Object.values(s.requests)) {
      if (policyHash(normalizePolicy(request.policy)) !== request.policyHash) throw new Error('Frozen policy integrity mismatch in persistent state');
    }
    if (Object.values(s.requests).some(r => r.status === 'checking')) {
      this.#mutate(next => {
        for (const r of Object.values(next.requests)) if (r.status === 'checking') {
          r.status = 'blocked'; r.operationId = null; r.evidence = null;
          r.evaluation = reasonResult('ACQUISITION_INTERRUPTED', '上次读取被进程中断。需主动重新读取，不能沿用旧结果。');
          event(r, 'interrupted', this.#clock(), '重启后关闭未完成的证据读取。');
        }
      });
    }
  }
  #mutate(fn) {
    this.#assertWritable();
    if (this.#closed) deny('SERVICE_CLOSED', '服务已关闭。');
    const next = structuredClone(this.#state); const value = fn(next);
    // The in-memory state changes only after durable persistence succeeds.
    try { this.#store.save(next); } catch (error) { this.#storageFault = true; throw error; }
    this.#state = next;
    return structuredClone(value);
  }
  #assertWritable() {
    if (this.#storageFault) deny('STORAGE_FAULT', '本地保存结果不确定，已停止后续变更。停止服务后检查状态文件，再重启读取。');
  }
  #view(request) {
    const r = structuredClone(request);
    if (this.#storageFault) {
      r.storageFault = true;
      if (!terminal.has(r.status)) {
        r.status = 'blocked'; r.evidence = null;
        r.evaluation = reasonResult('STORAGE_FAULT', '保存结果不确定；旧的 CI 开放状态已撤回，服务停止变更直到重启。');
      }
    }
    return r;
  }
  #expire() {
    if (this.#storageFault) return;
    const now = this.#clock();
    const expiring = Object.values(this.#state.requests).filter(r => !terminal.has(r.status) &&
      (now >= r.expiresAtMs || (r.status === 'awaiting_review' && now >= r.evaluation.validUntil)));
    if (expiring.length === 0) return;
    this.#mutate(next => {
      for (const previous of expiring) {
        const r = next.requests[previous.id]; r.status = 'expired'; r.operationId = null;
        r.evaluation = { ...(r.evaluation ?? { checks: [] }), passed: false, validUntil: null,
          reasons: [{ code: 'REQUEST_OR_EVIDENCE_EXPIRED', detail: '验收窗口或 CI 证据已过期，请创建新的固定交付请求。' }] };
        event(r, 'expired', now, '有效期结束，人工验收关闭。');
      }
    });
    for (const r of expiring) this.#controllers.get(r.id)?.abort();
  }
  #request(id) { const r = this.#state.requests[id]; if (!r) deny('NOT_FOUND', '交付请求不存在。'); return r; }
  get(id) { this.#expire(); return this.#view(this.#request(id)); }
  list() { this.#expire(); return Object.values(this.#state.requests).sort((a, b) => b.createdAtMs - a.createdAtMs).map(r => this.#view(r)); }
  create({ policy: input, buyerId, sellerId, mode, scenario = 'pass' }) {
    this.#assertWritable();
    const policy = normalizePolicy(input), now = this.#clock();
    if (!actorValid(buyerId) || !actorValid(sellerId) || buyerId === sellerId) deny('INVALID_ACTORS', '买方与提交者须是不同的有效本地角色 ID。');
    if (!['fixture', 'github-rest'].includes(mode)) deny('INVALID_MODE', '仅支持 fixture 或公开 GitHub REST 读取。');
    if (typeof scenario !== 'string' || scenario.length > 32) deny('INVALID_SCENARIO', '演示场景无效。');
    if (policy.notBeforeMs > now + CLOCK_SKEW_MS) deny('INVALID_POLICY_TIME', '检查窗口不能从未来开始。');
    if (Object.keys(this.#state.requests).length >= 200) deny('LOCAL_CAPACITY', '本地演示已达 200 个请求上限，请使用新的本地状态目录。');
    const r = { id: randomUUID(), policy, policyHash: policyHash(policy), buyerId, sellerId, mode, scenario,
      createdAtMs: now, expiresAtMs: now + policy.requestTtlSeconds * 1000, status: 'pending',
      operationId: null, evidence: null, evaluation: null, decision: null, history: [] };
    event(r, 'frozen', now, '买方策略与交付坐标已冻结。');
    return this.#mutate(next => { next.requests[r.id] = r; return r; });
  }
  async check(id) {
    this.#assertWritable();
    this.#expire(); const current = this.#request(id);
    if (current.status === 'checking') deny('CHECK_ALREADY_RUNNING', '已有证据读取正在进行。');
    if (terminal.has(current.status)) deny('INVALID_STATE', '此请求已结束，不能重新读取。');
    if (current.status === 'awaiting_review') deny('REVIEW_ALREADY_READY', 'CI 门禁已通过，请在有效期内人工决定。');
    if (current.mode === 'github-rest' && this.#clock() < (current.acquisitionFailure?.retryAtMs ?? 0)) {
      deny('GITHUB_RETRY_NOT_READY', 'GitHub 读取暂停期间不会再次发送请求；请等到记录中的最早重试时间。');
    }
    const operationId = randomUUID(), controller = new AbortController();
    this.#mutate(next => {
      const r = next.requests[id]; r.status = 'checking'; r.operationId = operationId; r.evidence = null; r.evaluation = null;
      r.acquisitionFailure = null;
      event(r, 'checking', this.#clock(), '开始读取固定 run/attempt 的证据。');
    });
    this.#controllers.set(id, controller);
    try {
      const snapshot = await this.#acquire(structuredClone(current), { signal: controller.signal });
      if (this.#closed) return structuredClone(this.#request(id));
      this.#expire();
      if (this.#request(id).operationId !== operationId) return this.get(id);
      const evaluation = evaluateEvidence(current.policy, snapshot, this.#clock());
      if (snapshot?.source?.kind !== current.mode || snapshot?.source?.execution !== 'node-local') {
        evaluation.passed = false; evaluation.validUntil = null;
        evaluation.reasons.push({ code: 'SOURCE_MISMATCH', detail: '证据来源与固定适配器不符，不能提升为 DON 证据。' });
      }
      return this.#mutate(next => {
        const r = next.requests[id], key = runKey(r.policy);
        if (evaluation.passed && next.usedRuns[key] && next.usedRuns[key] !== id) {
          evaluation.passed = false; evaluation.validUntil = null;
          evaluation.reasons.push({ code: 'REPLAY_DETECTED', detail: '此仓库/run/attempt 已用于另一请求，不能重放。' });
        }
        evaluation.validUntil = evaluation.passed ? Math.min(evaluation.validUntil, r.expiresAtMs) : null;
        r.status = evaluation.passed ? 'awaiting_review' : 'blocked'; r.operationId = null;
        r.evidence = { snapshot, source: snapshot.source, observedAtMs: snapshot.observedAtMs,
          digest: digest('agentproof-ci-gate/evidence/v1', { requestId: id, policyHash: r.policyHash, snapshot }) };
        r.evaluation = evaluation;
        if (evaluation.passed) next.usedRuns[key] = id;
        event(r, evaluation.passed ? 'ci_passed' : 'blocked', this.#clock(), evaluation.passed ? 'CI 前置条件满足，等待人工验收。' : 'CI 前置条件未满足。');
        return r;
      });
    } catch (error) {
      if (this.#closed) return structuredClone(this.#request(id));
      this.#expire();
      if (this.#request(id).operationId !== operationId) return this.get(id);
      return this.#mutate(next => {
        const r = next.requests[id]; r.status = 'blocked'; r.operationId = null; r.evidence = null;
        r.acquisitionFailure = error instanceof EvidenceError && error.diagnostics ? structuredClone(error.diagnostics) : null;
        const known = /^[A-Z_0-9]{1,60}$/.test(error.code ?? '');
        r.evaluation = reasonResult(known ? error.code : 'ACQUISITION_FAILED', known ? error.message : '证据读取失败，需主动重新读取。');
        event(r, 'acquisition_failed', this.#clock(), r.evaluation.reasons[0].detail); return r;
      });
    } finally { if (this.#controllers.get(id) === controller) this.#controllers.delete(id); }
  }
  #decide(id, actorId, outcome) {
    this.#assertWritable();
    this.#expire(); const current = this.#request(id);
    if (actorId !== current.buyerId) deny('UNAUTHORIZED', '仅固定的买方角色可人工验收或拒绝。');
    if (terminal.has(current.status)) deny('INVALID_STATE', '此请求已结束。');
    if (outcome === 'accepted' && current.status !== 'awaiting_review') deny('REVIEW_NOT_READY', 'CI 前置条件尚未满足，不能人工验收。');
    if (outcome === 'accepted') {
      const fresh = evaluateEvidence(current.policy, current.evidence.snapshot, this.#clock());
      if (!fresh.passed || this.#clock() >= current.evaluation.validUntil) deny('REVIEW_NOT_READY', '证据已失效，不能人工验收。');
    }
    const decided = this.#mutate(next => {
      const r = next.requests[id], atMs = this.#clock();
      if (outcome === 'accepted' && (atMs >= r.expiresAtMs || atMs >= r.evaluation.validUntil ||
          !evaluateEvidence(r.policy, r.evidence.snapshot, atMs).passed)) {
        deny('REVIEW_NOT_READY', '记录人工决定时证据已失效，不能验收。');
      }
      r.status = outcome; r.operationId = null;
      r.decision = { outcome, actorId, atMs, kind: 'local-human',
        note: 'Local role model; no wallet signature or onchain finality.' };
      event(r, outcome, atMs, outcome === 'accepted' ? '买方在本地记录人工验收。' : '买方在本地拒绝交付。'); return r;
    });
    this.#controllers.get(id)?.abort(); return decided;
  }
  accept(id, actorId) { return this.#decide(id, actorId, 'accepted'); }
  reject(id, actorId) { return this.#decide(id, actorId, 'rejected'); }
  cancel(id, actorId) {
    this.#assertWritable();
    this.#expire(); const current = this.#request(id);
    if (![current.buyerId, current.sellerId].includes(actorId)) deny('UNAUTHORIZED', '仅买方或提交者可取消。');
    if (terminal.has(current.status)) deny('INVALID_STATE', '此请求已结束。');
    const r = this.#mutate(next => {
      const request = next.requests[id]; request.status = 'cancelled'; request.operationId = null; request.evidence = null;
      request.evaluation = reasonResult('REQUEST_CANCELLED', '交付请求已取消，晚到证据不会重新开放验收。');
      event(request, 'cancelled', this.#clock(), `${actorId} 取消了请求。`); return request;
    });
    this.#controllers.get(id)?.abort(); return r;
  }
  close() { this.#closed = true; for (const controller of this.#controllers.values()) controller.abort(); this.#store.close(); }
}
