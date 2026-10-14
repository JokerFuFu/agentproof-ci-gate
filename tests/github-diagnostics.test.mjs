import test from 'node:test';
import assert from 'node:assert/strict';
import * as github from '../src/github.mjs';
import { makePolicy, makeSnapshot, NOW } from './helpers.mjs';
const response=(status,message,headers={})=>new Response(JSON.stringify({message,documentation_url:'https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api'}),{status,headers:{'Content-Type':'application/json',...headers}});
async function failure(r){try{await github.readJSONResponse(r,{clock:()=>NOW,url:'https://api.github.com/repos/demo-buyer/agent-delivery',resource:'repository'});assert.fail('HTTP failure accepted');}catch(e){assert.equal(e.name,'EvidenceError');return e;}}
test('primary quota exhaustion records status and reset without body IP or token',async()=>{
  const e=await failure(response(403,'API rate limit exceeded for 203.0.113.12 token ghp_abcdefghijklmnop',{ 'X-RateLimit-Remaining':'0','X-RateLimit-Limit':'60','X-RateLimit-Reset':String(NOW/1000+90),'Set-Cookie':'private','Authorization':'secret'}));
  assert.equal(e.code,'GITHUB_HTTP_403');assert.equal(e.diagnostics?.category,'primary-rate-limit');
  assert.equal(e.diagnostics.retryAtMs,NOW+90_000);assert.equal(e.diagnostics.headers['x-ratelimit-remaining'],'0');
  assert.ok(!JSON.stringify(e.diagnostics).includes('203.0.113.12'));assert.ok(!JSON.stringify(e.diagnostics).includes('ghp_'));
  assert.ok(!JSON.stringify(e.diagnostics).includes('private'));assert.ok(!JSON.stringify(e.diagnostics).includes('secret'));
});
test('ordinary 403 is access denial, not guessed rate exhaustion',async()=>{
  const e=await failure(response(403,'Resource not accessible',{ 'X-RateLimit-Remaining':'45' }));
  assert.equal(e.diagnostics?.category,'access-denied');assert.equal(e.diagnostics.retryAtMs,null);
});
test('safe receipts preserve Date header clocks while redacting actual IPv6 addresses',async()=>{
  const e=await failure(response(403,'Denied for 2001:db8::1 and ::1',{'Date':'Wed, 14 Oct 2026 01:55:27 GMT'}));
  assert.equal(e.diagnostics.headers.date,'Wed, 14 Oct 2026 01:55:27 GMT');
  assert.ok(!e.diagnostics.upstreamMessage.includes('2001:db8::1'));assert.ok(!e.diagnostics.upstreamMessage.includes('::1'));
});
test('secondary limit without Retry-After waits at least a minute',async()=>{
  const e=await failure(response(403,'You have exceeded a secondary rate limit.'));
  assert.equal(e.diagnostics?.category,'secondary-rate-limit');assert.equal(e.diagnostics.retryAtMs,NOW+60_000);
});
test('Retry-After and primary reset both constrain the earliest retry',async()=>{
  const e=await failure(response(429,'API rate limit exceeded',{ 'Retry-After':'120','X-RateLimit-Remaining':'0','X-RateLimit-Reset':String(NOW/1000+90) }));
  assert.equal(e.diagnostics?.retryAtMs,NOW+120_000);
});
test('invalid retry headers never become fabricated exact reset time',async()=>{
  const e=await failure(response(403,'Resource not accessible',{ 'Retry-After':'bad','X-RateLimit-Reset':'not-a-time' }));
  assert.equal(e.diagnostics?.retryAtMs,null);
});
test('out-of-Date-range reset cannot crash or become an exact reset time',async()=>{
  const e=await failure(response(403,'API rate limit exceeded',{'X-RateLimit-Remaining':'0','X-RateLimit-Reset':'9000000000000'}));
  assert.equal(e.diagnostics.category,'primary-rate-limit');assert.equal(e.diagnostics.retryAtMs,NOW+60_000);
});
test('oversized error body is cancelled while preserving header-only diagnosis',async()=>{
  let cancelled=false;const body=new ReadableStream({start(c){c.enqueue(new Uint8Array(9000));},cancel(){cancelled=true;}});
  const e=await failure(new Response(body,{status:403,headers:{'Content-Type':'application/json','X-RateLimit-Remaining':'0','X-RateLimit-Reset':String(NOW/1000+60)}}));
  assert.equal(e.diagnostics?.bodyState,'too-large');assert.equal(e.diagnostics.category,'primary-rate-limit');assert.equal(cancelled,true);
});
test('non-JSON error stays blocked and contains no reflected HTML',async()=>{
  const e=await failure(new Response('<script>private</script>',{status:403,headers:{'Content-Type':'text/html'}}));
  assert.equal(e.diagnostics?.upstreamMessage,null);assert.equal(e.diagnostics.category,'access-denied');
});
test('shared reader blocks a second repository during an actual rate pause',async()=>{
  assert.equal(typeof github.createGitHubAcquirer,'function');let now=NOW,calls=0;
  const reader=github.createGitHubAcquirer({clock:()=>now,fetchImpl:async()=>{calls++;return response(403,'API rate limit exceeded',{'X-RateLimit-Remaining':'0','X-RateLimit-Reset':String(NOW/1000+60)});}});
  await assert.rejects(reader(makePolicy()),e=>e.code==='GITHUB_HTTP_403');
  await assert.rejects(reader(makePolicy({repository:'another/public-repo'})),e=>e.code==='GITHUB_RETRY_NOT_READY');
  assert.equal(calls,1);now+=60_001;
  await assert.rejects(reader(makePolicy()),e=>e.code==='GITHUB_HTTP_403');assert.equal(calls,2);
});
test('restored rate pause makes no network request',async()=>{
  assert.equal(typeof github.createGitHubAcquirer,'function');let calls=0;
  const reader=github.createGitHubAcquirer({clock:()=>NOW,resumeAfterMs:NOW+60_000,fetchImpl:async()=>{calls++;throw Error('not expected')}});
  await assert.rejects(reader(makePolicy()),e=>e.code==='GITHUB_RETRY_NOT_READY');assert.equal(calls,0);
});
test('a successful GET exhausting quota stops before the next evidence endpoint',async()=>{
  let calls=0;const s=makeSnapshot();
  await assert.rejects(github.fetchGitHubEvidence(makePolicy(),{clock:()=>NOW,fetchImpl:async()=>{calls++;return new Response(JSON.stringify(s.repository),{headers:{'Content-Type':'application/json','X-RateLimit-Remaining':'0','X-RateLimit-Reset':String(NOW/1000+60)}});}}),e=>e.code==='GITHUB_RETRY_NOT_READY'&&e.diagnostics.completedRequests[0].status===200);
  assert.equal(calls,1);
});
test('quota exhaustion on the final successful GET pauses subsequent acquisitions',async()=>{
  let calls=0;const s=makeSnapshot(),bodies=[s.repository,s.run,s.workflow,s.workflowFile,s.jobs,s.runConfirmation];
  const reader=github.createGitHubAcquirer({clock:()=>NOW,fetchImpl:async()=>{const i=calls++;return new Response(JSON.stringify(bodies[i]),{headers:{'Content-Type':'application/json','X-RateLimit-Remaining':i===5?'0':'5','X-RateLimit-Reset':String(NOW/1000+60)}});}});
  const result=await reader(makePolicy());assert.equal(result.acquisition.length,6);
  await assert.rejects(reader(makePolicy()),e=>e.code==='GITHUB_RETRY_NOT_READY');assert.equal(calls,6);
});
test('successful real adapter shape includes six safe HTTP receipts',async()=>{
  const p=makePolicy(),s=makeSnapshot(p),bodies=[s.repository,s.run,s.workflow,s.workflowFile,s.jobs,s.runConfirmation];let i=0;
  const result=await github.fetchGitHubEvidence(p,{clock:()=>NOW,fetchImpl:async()=>new Response(JSON.stringify(bodies[i++]),{headers:{'Content-Type':'application/json','X-RateLimit-Remaining':'30','Set-Cookie':'secret'}})});
  assert.equal(result.acquisition?.length,6);assert.ok(result.acquisition.every(x=>x.status===200&&x.observedAtMs===NOW));
  assert.ok(!JSON.stringify(result.acquisition).includes('secret'));
});
