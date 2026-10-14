import test from 'node:test';
import assert from 'node:assert/strict';
const module = await import('../public/session.mjs').catch(() => null);
const make = () => {assert.ok(module?.RequestSession,'request ordering session is missing');return new module.RequestSession();};
const ready={id:'ready',status:'awaiting_review'},cancelled={id:'ready',status:'cancelled'};
test('latest load wins when older requests complete later', () => {
  const s=make(),old=s.beginLoad(),fresh=s.beginLoad();
  assert.equal(s.applyLoad(fresh,[cancelled]),true);assert.equal(s.applyLoad(old,[ready]),false);assert.equal(s.current.status,'cancelled');
});
test('a pre-cancellation read cannot reopen the UI after mutation completes', () => {
  const s=make();s.applyLoad(s.beginLoad(),[ready]);const stale=s.beginLoad(),op=s.beginOperation('cancel','ready');
  s.applyOperation(op,cancelled);s.endOperation(op);
  assert.equal(s.applyLoad(stale,[ready]),false);assert.equal(s.current.status,'cancelled');
});
test('rapid mutation is rejected synchronously before duplicate network calls', () => {
  const s=make(),first=s.beginOperation('freeze',null);assert.ok(first);assert.equal(s.beginOperation('freeze',null),null);
  s.endOperation(first);assert.ok(s.beginOperation('freeze',null));
});
test('an operation targets the captured request even when history selection changes', () => {
  const s=make();s.applyLoad(s.beginLoad(),[ready,{id:'other',status:'pending'}]);const op=s.beginOperation('cancel','ready');
  s.select('other');s.applyOperation(op,cancelled);s.endOperation(op);
  assert.equal(op.requestId,'ready');assert.equal(s.current.id,'other');assert.equal(s.requests.find(x=>x.id==='ready').status,'cancelled');
});
test('a delayed created record does not steal a newer history selection', () => {
  const s=make();s.applyLoad(s.beginLoad(),[ready,{id:'other',status:'pending'}]);const op=s.beginOperation('freeze',null);
  s.select('other');s.applyOperation(op,{id:'new',status:'pending'},{select:true});s.endOperation(op);assert.equal(s.current.id,'other');
});
test('polls during a mutation cannot roll back its operation result', () => {
  const s=make();s.applyLoad(s.beginLoad(),[ready]);const op=s.beginOperation('cancel','ready'),poll=s.beginLoad();
  assert.equal(s.applyLoad(poll,[ready]),false);s.applyOperation(op,cancelled);s.endOperation(op);assert.equal(s.current.status,'cancelled');
});
test('an obsolete failed load cannot mark a newer successful connection offline', () => {
  const s=make(),old=s.beginLoad(),fresh=s.beginLoad();s.applyLoad(fresh,[ready]);assert.equal(s.failLoad(old),false);assert.equal(s.online,true);
});
