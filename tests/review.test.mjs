import test from 'node:test';
import assert from 'node:assert/strict';
import { GateService } from '../src/gate.mjs';
import { MemoryStore } from '../src/store.mjs';
import { makePolicy, makeSnapshot, NOW } from './helpers.mjs';
const module = await import('../public/review.mjs').catch(() => null);
const api = () => { assert.ok(module?.summarizeRequest, 'request review model is missing'); return module; };
const setup = (acquire = async r => makeSnapshot(r.policy)) => new GateService({store:new MemoryStore(),clock:()=>NOW,acquire});
const create = gate => gate.create({policy:makePolicy(),buyerId:'buyer',sellerId:'agent',mode:'fixture',scenario:'pass'});

test('future upstream retry time disables the real re-read control',()=>{
  const r=create(setup());r.mode='github-rest';r.status='blocked';r.acquisitionFailure={category:'primary-rate-limit',retryAtMs:NOW+60_000};
  r.evaluation={passed:false,reasons:[{code:'GITHUB_HTTP_403',detail:'Limited'}],checks:[]};
  const m=api().summarizeRequest(r,{nowMs:NOW});assert.equal(m.canCheck,false);assert.equal(m.pauseRemainingMs,60_000);
});
test('grouped reasons retain counts and actual details without mutating the record',()=>{
  assert.equal(typeof api().groupReasons,'function');
  const reasons=[{code:'STALE_EVIDENCE',detail:'run old'},{code:'STALE_EVIDENCE',detail:'step old'},{code:'STALE_EVIDENCE',detail:'step old'},{code:'AMBIGUOUS_STEP',detail:'two names'}];
  const before=structuredClone(reasons),groups=api().groupReasons(reasons);
  assert.deepEqual(groups[0],{code:'STALE_EVIDENCE',count:3,details:['run old','step old']});assert.deepEqual(reasons,before);
});
test('an executed-success step is not presented as accepted when time checks failed',()=>{
  assert.equal(typeof api().stepOutcomeLabel,'function');
  assert.equal(api().stepOutcomeLabel({passed:false,conclusion:'success'}),'执行成功 / 未满足');
  assert.equal(api().stepOutcomeLabel({passed:true,conclusion:'success'}),'通过');assert.equal(api().stepOutcomeLabel(null),'未取得');
});

test('freeze review provenance works before any request or evidence exists', () => {
  assert.equal(typeof api().sourceDescription, 'function');
  const source = api().sourceDescription('fixture');
  assert.equal(source.kind, 'fixture');assert.equal(source.hasEvidence, false);assert.match(source.note, /合成/);
});
test('an unread request shows unknown evidence and cannot offer acceptance', () => {
  const r=create(setup()),m=api().summarizeRequest(r,{nowMs:NOW});
  assert.equal(m.source.hasEvidence,false);assert.equal(m.jobs.inspected,false);assert.equal(m.canAccept,false);assert.equal(m.primary.action,'check');
});
test('CI pass retains a separate human review action and synthetic provenance', async () => {
  const gate=setup(),r=await gate.check(create(gate).id),m=api().summarizeRequest(r,{nowMs:NOW});
  assert.equal(m.canAccept,true);assert.equal(m.primary.action,'review');assert.equal(m.source.kind,'fixture');
  assert.match(m.source.note,/合成/);assert.equal(m.jobs.passed,r.policy.requiredJobs.length);
});
test('the UI deadline independently closes acceptance before the next server poll', async () => {
  const gate=setup(),r=await gate.check(create(gate).id),m=api().summarizeRequest(r,{nowMs:r.evaluation.validUntil});
  assert.equal(m.canAccept,false);assert.equal(m.remainingMs,0);assert.equal(m.primary.action,'new');
});
test('offline or uncertain storage never enables an acceptance control', async () => {
  const gate=setup(),r=await gate.check(create(gate).id);
  assert.equal(api().summarizeRequest(r,{nowMs:NOW,online:false}).canAccept,false);
  assert.equal(api().summarizeRequest({...r,storageFault:true},{nowMs:NOW}).canAccept,false);
});
test('connection failure has an explicit recovery action even without a saved request', () => {
  const m=api().summarizeRequest(null,{nowMs:NOW,online:false});
  assert.equal(m.primary.action,'reconnect');assert.equal(m.stateLabel,'连接中断');
});
test('expected and observed full commit remain visibly distinct on mismatch', async () => {
  const gate=setup(async r=>{const s=makeSnapshot(r.policy);s.run.head_sha='0'.repeat(40);s.runConfirmation=structuredClone(s.run);return s;});
  const r=await gate.check(create(gate).id),rows=api().bindingRows(r),commit=rows.find(x=>x.key==='commit');
  assert.equal(commit.expected,r.policy.commit);assert.equal(commit.observed,'0'.repeat(40));assert.equal(commit.match,false);
  assert.equal(api().summarizeRequest(r,{nowMs:NOW}).primary.action,'judgment');
});
test('acquisition failure offers re-read and does not invent inspected checks', async () => {
  const gate=setup(async()=>{const e=new Error('Synthetic timeout');e.code='FIXTURE_TIMEOUT';throw e;});
  const r=await gate.check(create(gate).id),m=api().summarizeRequest(r,{nowMs:NOW});
  assert.equal(m.primary.action,'check');assert.equal(m.jobs.inspected,false);assert.equal(m.source.hasEvidence,false);
});
test('cancelled request recovery means a new frozen request, never same-request retry', () => {
  const gate=setup(),r=create(gate),m=api().summarizeRequest(gate.cancel(r.id,'agent'),{nowMs:NOW});
  assert.equal(m.canCheck,false);assert.equal(m.primary.action,'restart');assert.equal(m.canAccept,false);
});
test('accepted or rejected histories do not offer another acceptance', async () => {
  const gate=setup(),r=create(gate);await gate.check(r.id);const accepted=gate.accept(r.id,'buyer');
  assert.equal(api().summarizeRequest(accepted,{nowMs:NOW}).canAccept,false);
  assert.equal(api().summarizeRequest(accepted,{nowMs:NOW}).primary.action,'record');
});
test('GitHub links use fixed validated coordinates and never supplied HTML URLs', () => {
  const r=create(setup());assert.deepEqual(api().publicLinks(r),[]);
  const links=api().publicLinks({...r,mode:'github-rest',evidence:{snapshot:{run:{html_url:'https://evil.test'}}}});
  assert.equal(links.length,2);assert.ok(links.every(x=>x.url.startsWith('https://github.com/'+r.policy.repository+'/')));
});
test('missing observed binding fields stay unknown rather than passed', () => {
  const rows=api().bindingRows(create(setup()));assert.ok(rows.length>5);assert.ok(rows.every(x=>x.match===null));
});
