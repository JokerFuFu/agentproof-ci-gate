import { normalizePolicy } from './policy.mjs';
import { RequestSession } from './session.mjs';
import { STATE_LABELS, summarizeRequest, bindingRows, reasonHelp, publicLinks, sourceDescription, groupReasons, stepOutcomeLabel } from './review.mjs';

const $=id=>document.getElementById(id), session=new RequestSession();
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const text=(id,value)=>{const el=$(id),next=String(value??'');if(el&&el.textContent!==next)el.textContent=next;};
const stamp=ms=>Number.isFinite(ms)?new Date(ms).toLocaleString('zh-CN',{hour12:false,timeZone:'UTC',timeZoneName:'short'}):'未取得';
const short=value=>String(value??'').slice(0,12);
const remaining=ms=>{const seconds=Math.max(0,Math.ceil(ms/1000));return seconds>=3600?Math.floor(seconds/3600)+' 小时 '+Math.floor(seconds%3600/60)+' 分':Math.floor(seconds/60)+' 分 '+String(seconds%60).padStart(2,'0')+' 秒';};
const ended=new Set(['accepted','rejected','cancelled','expired']);
let draft=null,draftSerial=Date.now(),draftEpoch=0,draftLoading=false,jsonDirty=false,freezeContext=null,decisionContext=null,detailContext=null,noticeTimer;
const rendered=new Map(),dialogOpeners=new Map();
const source=()=>document.querySelector('input[name=source]:checked').value;
const scenarioDescriptions={
  pass:'完整合成证据满足固定策略，之后仍需人工决定。',
  'failed-step':'run 显示成功，但一个必需 step 失败；展开检查定位问题。',
  'old-commit':'CI 实际 commit 与交付版本不同；可查看两份完整 SHA。',
  'expired-evidence':'合成结果包含过期时间，不能沿用历史检查。',
  'wrong-repository':'实际证据来自另一仓库，名称和数字 ID 都要核对。',
  'wrong-workflow':'workflow 文件版本变化，即使 job 成功也不能开放验收。',
  'partial-jobs':'返回的 job 列表不完整，不能只验证已取得部分。',
  'cancelled-run':'CI run 已取消，不能作为成功交付证据。',
  'in-progress':'CI run 尚未完成，状态会保持阻挡。',
  timeout:'模拟外部读取超时。没有真实网络请求，可观察恢复操作。',
  interrupted:'模拟读取中断。未取得证据，不会显示任何通过结论。',
  'short-expiry':'冻结后仅有 8 秒窗口。CI 通过后仍可能在审阅时过期。'
};
function announce(message,error=false){
  clearTimeout(noticeTimer);$('notice').hidden=false;$('notice').className=error?'notice error':'notice';
  text('notice-text',message);if(!error)noticeTimer=setTimeout(()=>$('notice').hidden=true,6500);
}
async function api(path,body){
  const options={cache:'no-store',signal:AbortSignal.timeout(6500)};
  if(body!==undefined)Object.assign(options,{method:'POST',headers:{'Content-Type':'application/json','X-AgentProof-Client':'local-preview'},body:JSON.stringify(body)});
  const response=await fetch(path,options),data=await response.json();
  if(!response.ok){const e=new Error(data.detail??('HTTP '+response.status));e.code=data.error;throw e;}
  return data;
}
function patch(id,key,html){
  if(rendered.get(id)===key)return;
  const node=$(id),open=[...node.querySelectorAll('details[open][data-disclosure]')].map(e=>e.dataset.disclosure);
  const active=document.activeElement,focus=node.contains(active)?active.dataset.focusKey:null;
  node.innerHTML=html;rendered.set(id,key);
  for(const item of node.querySelectorAll('details[data-disclosure]'))if(open.includes(item.dataset.disclosure))item.open=true;
  if(focus)node.querySelectorAll('[data-focus-key]').forEach(el=>{if(el.dataset.focusKey===focus)el.focus({preventScroll:true});});
}
function stage(id,state,label){const el=$(id);el.className=state;textStage(el,label);}
function textStage(el,label){const value=el.querySelector('.stage-result');if(value.textContent!==label)value.textContent=label;}
function draftCandidate(){
  if(!draft||draftLoading)throw new Error('策略仍在准备，请稍后重试。');
  const mode=source(),policy=mode==='fixture'?normalizePolicy(draft):normalizePolicy(JSON.parse($('policy-json').value));
  if(mode==='github-rest'&&(policy.repository==='demo-buyer/agent-delivery'||policy.repositoryId===42424242))throw new Error('当前仍是合成模板。请替换为买方已审核的真实仓库和 CI 坐标。');
  return {policy,mode,scenario:mode==='fixture'?$('scenario').value:'pass',intent:'冻结后不会自动读取证据，也不会自动验收。'};
}
function renderDraft(){
  if(!draft)return;
  const p=draft;
  $('draft-binding').innerHTML=[['仓库',p.repository],['commit',short(p.commit)+'…'],['必需检查',p.requiredJobs.length+' job / '+p.requiredJobs.reduce((n,j)=>n+j.steps.length,0)+' step'],['验收窗口',p.requestTtlSeconds+' 秒']]
    .map(([k,v])=>'<dt>'+esc(k)+'</dt><dd>'+esc(v)+'</dd>').join('');
  text('scenario-description',scenarioDescriptions[$('scenario').value]);
}
async function newDraft(){
  const epoch=++draftEpoch;draftLoading=true;render();
  try {
    const preset=await api('/api/preset');if(epoch!==draftEpoch)return;
    draft=preset.policy;draft.runId=Math.max(Date.now(),++draftSerial);
    if($('scenario').value==='short-expiry')draft.requestTtlSeconds=8;
    if(!jsonDirty)$('policy-json').value=JSON.stringify(draft,null,2);
    renderDraft();
  } finally {if(epoch===draftEpoch){draftLoading=false;render();}}
}
function renderHistory(){
  text('request-count',session.requests.length);
  const query=$('history-search').value.trim().toLowerCase(),filter=$('history-filter').value;
  const found=session.requests.filter(r=>(filter==='all'||(filter==='ended'?ended.has(r.status):r.status===filter))&&
    [r.policy.repository,r.policy.commit,String(r.policy.runId),r.id].some(value=>value.toLowerCase().includes(query)));
  const key=JSON.stringify([session.selectedId,query,filter,found.map(r=>[r.id,r.status])]);
  patch('request-list',key,found.length?found.map(r=>'<button class="request-item '+(r.id===session.selectedId?'selected':'')+'" data-request="'+esc(r.id)+'" data-focus-key="'+esc(r.id)+'" aria-current="'+(r.id===session.selectedId)+'"><strong>'+esc(r.policy.repository)+'</strong><span>'+esc(STATE_LABELS[r.status])+' · '+(r.mode==='fixture'?'Fixture':'GitHub')+'</span><span class="mono">run '+r.policy.runId+' / '+short(r.policy.commit)+'</span></button>').join(''):'<p class="muted small">'+(session.requests.length?'没有匹配记录。调整搜索或筛选条件。':'冻结策略后，记录会出现在这里。')+'</p>');
}
function jobsMarkup(r){
  const actual=r.evaluation?.checks?.filter(c=>c.kind==='job')??[];
  return r.policy.requiredJobs.map((spec,i)=>{
    const job=actual.find(c=>c.name===spec.name),state=job?(job.passed?'pass':'fail'):'unknown';
    return '<details class="job-card '+state+'" data-disclosure="job-'+i+'"><summary data-focus-key="job-'+i+'"><span class="check-icon '+state+'">'+(job?(job.passed?'✓':'×'):'·')+'</span><span class="job-identity"><strong>'+esc(spec.name)+'</strong><small>'+spec.steps.length+' 个必需 step'+(job?' · 实际结果 '+esc(job.status):' · 尚无检查结果')+'</small></span><span class="job-result">'+(job?(job.passed?'满足':'未满足'):'等待证据')+'</span><span class="disclosure-icon" aria-hidden="true">+</span></summary><div class="job-details">'+
      spec.steps.map((name,j)=>{const step=job?.steps?.find(s=>s.name===name);return '<div class="step-result"><span class="step-index">'+(j+1)+'</span><span>'+esc(name)+'</span><strong class="'+(step?(step.passed?'pass':'fail'):'')+'">'+esc(stepOutcomeLabel(step))+'</strong></div>';}).join('')+
      '<p class="muted small">'+(job?'job 完成时间：'+esc(job.completedAt??'未取得'):'冻结策略要求以上精确名称。未读取前，不推断 step 是否成功。')+'</p></div></details>';
  }).join('');
}
function render(){
  const r=session.current,m=summarizeRequest(r,{online:session.online,busy:session.busy});
  if(!r&&session.online&&!draft&&!draftLoading){m.title='策略尚未准备完成';m.detail='重新获取本地策略模板，再确认来源和固定坐标。';m.primary={action:'new',label:'重新准备策略'};}
  document.body.dataset.gate=session.online?(r?.status??'idle'):'offline';text('scene-status',m.stateLabel);
  text('delivery-title',r?.policy.repository??'等待一份固定交付');
  text('delivery-subtitle',r?'run '+r.policy.runId+' / attempt '+r.policy.runAttempt+' · commit '+short(r.policy.commit):'准备策略，读取证据，作出人工决定。');
  text('state-badge',m.stateLabel);$('state-badge').className='badge '+m.tone;
  $('provenance').className='provenance '+m.source.tone;text('source-label',m.source.label);text('source-note',m.source.note);
  const ciPass=Boolean(r?.evaluation?.passed),expired=m.remainingMs===0;
  stage('stage-freeze',r?'done':'',r?'已冻结':'等待');
  stage('stage-ci',ciPass&&!expired?'done':r?.status==='checking'?'active':r?.status==='pending'||!r?'':'failed',ciPass&&!expired?'通过':r?.status==='checking'?'读取中':r?.status==='pending'||!r?'未读取':'阻挡');
  stage('stage-human',r?.status==='accepted'?'done':m.canAccept?'active':r?.status==='rejected'?'failed':'',r?.status==='accepted'?'本地记录':m.canAccept?'待决定':r?.status==='rejected'?'已拒绝':'未开放');
  $('result-message').className='result-message '+m.tone;text('result-title',m.title);text('result-detail',m.detail);text('result-symbol',m.tone==='success'?'✓':m.tone==='error'?'!':'◇');
  $('reading-feedback').hidden=r?.status!=='checking';text('reading-time',m.elapsedMs===null?'':'已等待 '+Math.floor(m.elapsedMs/1000)+' 秒 · 返回前无验证结论');
  $('check').hidden=m.primary.action!=='check';$('check').disabled=!m.canCheck;text('check',m.primary.label);
  $('next-action').hidden=m.primary.action==='check';text('next-action',m.primary.label);$('next-action').dataset.action=m.primary.action;
  $('next-action').disabled=session.busy||((m.primary.action==='freeze')&&(!draft||draftLoading||!session.online))||m.primary.action==='review'&&!m.canAccept;
  $('cancel').hidden=!r||ended.has(r.status);$('cancel').disabled=!m.canCancel;
  $('new-request').hidden=!r||m.primary.action==='new';$('new-request').disabled=session.busy||!session.online;
  $('accept').disabled=!m.canAccept;$('reject').disabled=!m.canReject;
  $('export').disabled=!r||!session.online||session.busy;
  for(const id of ['source-detail','binding-card','evidence-card','validity-card','copy-commit','view-evidence','view-events'])$(id).disabled=!r;
  $('replay').disabled=!r||!session.online||session.busy||r.storageFault||!r.history.some(e=>e.type==='ci_passed');
  let candidateValid=false;try{draftCandidate();candidateValid=true;}catch{}
  $('freeze').disabled=!candidateValid||!session.online||session.busy;
  text('freeze',draftLoading?'正在准备策略…':'审阅并冻结策略');
  text('operation-feedback',session.busy?'正在保存'+(session.operation.requestId?'请求 '+short(session.operation.requestId):'新请求')+'，请等待确认。':m.pauseRemainingMs>0?'最早重试还需 '+remaining(m.pauseRemainingMs)+'。未再次发送 GitHub 请求。':'');
  renderHistory();
  if(r){
    const rows=bindingRows(r),different=rows.filter(x=>x.match===false),binding=r.evaluation?.checks?.find(c=>c.kind==='binding');
    text('binding-value',short(r.policy.commit)+'…');text('binding-caption',r.policy.workflowPath);
    text('binding-status',!r.evidence?'固定值，尚未比对':different.length?different.length+' 处字段不一致':binding?.passed?'固定字段已对齐':'需要查看实际绑定');
    $('binding-card').classList.toggle('lens-error',different.length>0);$('binding-card').classList.toggle('lens-pass',Boolean(binding?.passed&&!different.length));
    const snapshot=r.evidence?.snapshot;
    text('evidence-value',snapshot?((snapshot.jobs?.jobs?.length??0)+' 个 job 已返回'):'尚无完整快照');
    text('evidence-caption',snapshot?'读取于 '+stamp(r.evidence.observedAtMs):r.status==='checking'?'正在等待读取结果':'需要完整、可核对的实际快照');
    text('evidence-status',snapshot?'run: '+(snapshot.run?.status??'未取得')+' / '+(snapshot.run?.conclusion??'未取得'):m.source.label);
    text('validity-value',r.decision?'决定已记录':ended.has(r.status)?'本次请求已结束':remaining(m.remainingMs));
    text('validity-caption',r.decision?'记录于 '+stamp(r.decision.atMs):'截止 '+stamp(m.deadline));
    text('validity-status',m.canAccept?'CI 已开放，等待人决定':r.status==='accepted'?'本地人工验收':expired||r.status==='expired'?'有效期结束':'人工开关未开放');
    text('check-summary',m.jobs.inspected?m.jobs.passed+' / '+m.jobs.total+' job 满足 · '+m.jobs.stepsPassed+' / '+m.jobs.stepsTotal+' step':m.jobs.total+' 个必需 job，尚未核验');
    patch('checks',JSON.stringify([r.id,r.evaluation?.checks]),jobsMarkup(r));
    text('human-help',m.canAccept?'固定 CI 条件通过。打开审阅面板，核对版本、证据和实际交付后再决定。':r.decision?'买方 '+r.decision.actorId+' 已'+(r.decision.outcome==='accepted'?'验收':'拒绝')+'，'+stamp(r.decision.atMs):m.stateLabel+'。人工开关仍未开放。');
    patch('timeline',JSON.stringify([r.id,r.history]),r.history.slice(-3).reverse().map(e=>'<li>'+esc(e.detail)+'<time>'+esc(stamp(e.atMs))+'</time></li>').join(''));
  }
  renderDetail();renderDecision();if($('freeze-dialog').open)$('confirm-freeze').disabled=!$('policy-ack').checked||session.busy||freezeContext?.submitted||!session.online;
}
async function refresh(){
  const ticket=session.beginLoad();
  try{
    const state=await api('/api/state');if(!Array.isArray(state.requests))throw Error('Invalid local state');
    if(session.applyLoad(ticket,state.requests)){$('connection-error').hidden=true;render();}
  }catch{
    if(session.failLoad(ticket)){$('connection-error').hidden=false;$('connection-error').textContent='本地服务连接中断。旧显示不能继续操作；重新连接后确认当前状态。';render();}
  }
}
async function mutate(action,id,data){
  const op=session.beginOperation(action,id);if(!op)return null;render();
  try{
    let r;
    if(action==='freeze'||action==='replay'){
      r=await api('/api/requests',data);session.applyOperation(op,r,{select:true});
      if(action==='replay'){r=await api('/api/requests/'+r.id+'/check',{});session.applyOperation(op,r);}
    }else{
      r=await api('/api/requests/'+id+'/'+action,action==='check'?{}:{actorId:action==='cancel'?'local-agent':'local-buyer'});
      session.applyOperation(op,r);
    }
    announce((action==='check'?'已开始读取；证据来源会保留。':action==='freeze'?'策略已冻结，下一步读取证据。':action==='cancel'?'请求已取消，晚到结果不会重新开放。':action==='accept'?'买方验收已记录在本地。':action==='reject'?'买方拒绝已记录。':'同坐标新请求已创建，正在检查重放保护。')+' 请求 '+short(r.id));
    return r;
  }catch(e){announce(e.message,true);throw e;}
  finally{session.endOperation(op);render();await refresh();}
}
function showDialog(id,opener){
  dialogOpeners.set(id,opener??document.activeElement);document.body.classList.add('dialog-open');$(id).showModal();
}
function closeDialog(id){if($(id).open)$(id).close();}
for(const id of ['freeze-dialog','detail-dialog','decision-dialog']){
  $(id).addEventListener('close',()=>{
    if(!document.querySelector('dialog[open]'))document.body.classList.remove('dialog-open');
    if(id==='detail-dialog'){detailContext=null;rendered.delete('detail-panel');}
    if(id==='freeze-dialog')freezeContext=null;
    if(id==='decision-dialog')decisionContext=null;
    const opener=dialogOpeners.get(id);dialogOpeners.delete(id);
    if(!document.querySelector('dialog[open]')){
      const target=opener?.isConnected&&!opener.disabled&&opener.getClientRects().length?opener:$('freeze');
      if(!target.disabled)target.focus({preventScroll:true});else $('verification-workspace').querySelector('h2')?.focus({preventScroll:true});
    }
  });
}
const pair=(label,value,key)=>'<div class="data-pair"><span>'+esc(label)+'</span><div><code>'+esc(value??'未取得')+'</code>'+(key?'<button class="copy-value text-button" data-copy="'+esc(key)+'" data-focus-key="copy-'+esc(key)+'">复制</button>':'')+'</div></div>';
const provenance=(r)=>{const s=sourceDescription(r.mode,r.evidence);return '<strong>'+esc(s.label)+'</strong><p>'+esc(s.note)+'</p>';};
function policySummary(p){
  return '<div class="policy-preview">'+pair('仓库',p.repository)+pair('完整 commit',p.commit)+pair('固定 run / attempt',p.runId+' / '+p.runAttempt)+pair('workflow 文件',p.workflowPath)+
    '<details class="inner-disclosure"><summary>更多固定坐标与时效</summary>'+pair('仓库数字 ID',p.repositoryId)+pair('workflow ID',p.workflowId)+pair('workflow blob SHA',p.workflowBlobSha)+pair('分支 / 事件',p.branch+' / '+p.event)+pair('最早 run 时间',stamp(p.notBeforeMs))+pair('证据最长年龄',p.maxEvidenceAgeSeconds+' 秒')+pair('请求验收窗口',p.requestTtlSeconds+' 秒')+'</details><h3>必须成功的检查</h3><ul class="required-spec">'+p.requiredJobs.map(j=>'<li><strong>'+esc(j.name)+'</strong><span>'+j.steps.map(esc).join(' / ')+'</span></li>').join('')+'</ul></div>';
}
function openFreeze(candidate,opener){
  freezeContext={...candidate,policy:structuredClone(candidate.policy),submitted:false};
  $('policy-ack').checked=false;$('freeze-error').hidden=true;
  $('freeze-provenance').innerHTML=provenance({mode:candidate.mode});text('freeze-intent',candidate.intent);
  $('freeze-summary').innerHTML=policySummary(candidate.policy);$('confirm-freeze').disabled=true;showDialog('freeze-dialog',opener);
}
function openDetail(tab='evidence',opener,requestId=session.selectedId){
  if(!session.requests.some(r=>r.id===requestId))return;
  detailContext={requestId,tab};rendered.delete('detail-panel');renderDetail();showDialog('detail-dialog',opener);
  $('tab-'+tab).focus({preventScroll:true});
}
function comparisonRow(row){
  const state=row.match===null?'unknown':row.match?'pass':'fail';
  return '<div class="comparison-row '+state+'"><div class="comparison-heading"><strong>'+esc(row.label)+'</strong><span class="mini-status">'+(row.match===null?'未取得':row.match?'字段一致':'不一致')+'</span></div><div class="comparison-values"><div><span>冻结策略</span><code>'+esc(row.expected)+'</code></div><div><span>实际证据</span><code>'+esc(row.observed??'未取得')+'</code></div></div></div>';
}
function acquisitionMarkup(r){
  const failure=r.acquisitionFailure,receipts=failure?[...(failure.completedRequests??[]),failure]:(r.evidence?.snapshot?.acquisition??[]);
  if(!receipts.length)return '';
  return '<details class="inner-disclosure" data-disclosure="http-receipts"><summary>查看实际获取记录与限流响应 ('+receipts.length+')</summary><p class="muted small">只保存白名单状态和响应头；没有令牌、Cookie 或完整错误正文。</p>'+receipts.map(item=>
    '<section class="http-receipt"><div class="section-row"><strong>'+esc(item.resource??'读取暂停')+'</strong><span class="mini-status">'+(item.status===null?'未发送新请求':'HTTP '+esc(item.status))+'</span></div>'+pair('实际读取时间',stamp(item.observedAtMs))+(item.category!=='ok'?pair('实际分类',item.category):'')+
    (item.upstreamMessage?pair('脱敏错误原因',item.upstreamMessage):'')+(Number.isFinite(item.retryAtMs)?pair('最早重试时间',stamp(item.retryAtMs)):'')+
    (item.url?pair('固定 GET 地址',item.url):'')+Object.entries(item.headers??{}).map(([name,value])=>pair(name,value)).join('')+'</section>').join('')+'</details>';
}
function dossierMarkup(r,tab){
  const m=summarizeRequest(r,{online:session.online}),s=r.evidence?.snapshot;
  if(tab==='policy'){
    const rows=bindingRows(r),important=new Set(['repository','commit','runId','workflowBlob']);
    const top=rows.filter(row=>important.has(row.key)||row.match===false),rest=rows.filter(row=>!top.includes(row));
    return '<p class="dialog-intro">左侧是不可修改的买方策略，右侧来自本次已取得的快照。字段一致仍需满足检查与时效。</p>'+top.map(comparisonRow).join('')+
      '<details class="inner-disclosure" data-disclosure="binding-more"><summary>其余固定坐标 ('+rest.length+')</summary>'+rest.map(comparisonRow).join('')+'</details>'+
      pair('策略 SHA-256',r.policyHash,'policyHash')+pair('请求 ID',r.id,'requestId')+'<h3>固定的必需检查</h3><ul class="required-spec">'+r.policy.requiredJobs.map(j=>'<li><strong>'+esc(j.name)+'</strong><span>'+j.steps.map(esc).join(' / ')+'</span></li>').join('')+'</ul>';
  }
  if(tab==='evidence'){
    const links=publicLinks(r);
    return '<div class="source-explanation '+m.source.tone+'">'+provenance(r)+'</div>'+acquisitionMarkup(r)+
      (s?pair('本次读取时间',stamp(r.evidence.observedAtMs))+pair('实际 run 状态',String(s.run?.status??'未取得')+' / '+String(s.run?.conclusion??'未取得'))+
        pair('实际 job 返回数',(s.jobs?.jobs?.length??0)+' / 声明总数 '+String(s.jobs?.total_count??'未取得'))+pair('本地证据 SHA-256',r.evidence.digest,'digest')+
        '<p class="muted small">哈希用于标识此请求的本地快照，不是 oracle 签名或独立安全证明。</p><h3>逐项检查结果</h3>'+jobsMarkup(r)+
        '<details class="inner-disclosure" data-disclosure="raw-evidence"><summary>查看已保存的原始快照 JSON</summary><label class="sr-only" for="raw-evidence">原始本地证据快照</label><textarea id="raw-evidence" class="raw-json" rows="10" readonly spellcheck="false">'+esc(JSON.stringify(s,null,2))+'</textarea><button class="quiet" data-copy="snapshot" data-focus-key="copy-snapshot">复制快照 JSON</button></details>':
        '<div class="dossier-empty"><span aria-hidden="true">◌</span><h3>尚无完整证据快照</h3><p>'+esc(r.status==='checking'?'正在等待读取完成。此处不会提前展示通过结果。':'读取未开始、失败或已取消。先查看判断依据，再主动继续。')+'</p></div>')+
      (links.length?'<div class="external-links">'+links.map(link=>'<a href="'+esc(link.url)+'" target="_blank" rel="noopener noreferrer">'+esc(link.label)+' ↗</a>').join('')+'</div>':'')+
      '<div class="scope-note"><strong>CRE：compiled-only</strong><p>Simulation 未执行，DON 未部署。当前页面只展示本地适配器记录。</p></div>';
  }
  if(tab==='judgment'){
    const reasons=r.evaluation?.reasons??[];
    return '<div class="judgment-banner '+m.tone+'"><h3>'+esc(m.title)+'</h3><p>'+esc(m.detail)+'</p></div>'+
      (reasons.length?'<ol class="reason-list">'+groupReasons(reasons).map(group=>{const help=reasonHelp({code:group.code},r);return '<li><code>'+esc(group.code)+'</code><span class="reason-count">'+group.count+' 条实际判断</span><p>'+esc(group.details[0])+'</p><strong>'+esc(help.title)+'</strong><p class="muted">'+esc(help.body)+'</p>'+(group.details.length>1?'<details class="inner-disclosure" data-disclosure="reason-'+esc(group.code)+'"><summary>展开 '+group.details.length+' 种具体原因</summary><ul>'+group.details.map(detail=>'<li>'+esc(detail)+'</li>').join('')+'</ul></details>':'')+'</li>';}).join('')+'</ol>':
        r.evaluation?'<div class="judgment-facts"><p>本地 evaluator 对固定策略的全部必需条件给出通过结论。</p><p>该结论只对应此 run/attempt 和证据快照；人工决定仍独立进行。</p></div>':'<p class="dossier-empty">尚无判断结果。未读取不等于失败，也不等于通过。</p>')+
    acquisitionMarkup(r)+'<h3>两种时效都要满足</h3>'+pair('最早可接受的 run 时间',stamp(r.policy.notBeforeMs))+pair('证据最长年龄',r.policy.maxEvidenceAgeSeconds+' 秒')+
      pair('请求截止',stamp(r.expiresAtMs))+pair('通过证据有效至',stamp(r.evaluation?.validUntil))+
      '<div class="risk-note"><strong>人工仍需判断的范围</strong><ul><li>测试是否覆盖实际交付，代码是否满足需求。</li><li>固定一个 workflow 文件不会固定所有传递依赖。</li><li>快照后的 GitHub 变化无法由已缓存证据持续观察。</li><li>本地角色与文件记录不具备钱包签名或链上最终性。</li></ul></div>';
  }
  return (r.decision?'<div class="decision-record"><strong>买方已'+(r.decision.outcome==='accepted'?'验收':'拒绝')+'</strong>'+pair('本地角色',r.decision.actorId)+pair('决定时间',stamp(r.decision.atMs))+'<p class="muted small">无钱包签名 / 无链上最终性</p></div>':'<p class="dialog-intro">还没有人工决定。CI 通过不会自动写入验收。</p>')+
    '<ol class="dossier-timeline">'+r.history.slice().reverse().map(e=>'<li><span class="event-marker" aria-hidden="true"></span><div><strong>'+esc(e.detail)+'</strong><time>'+esc(stamp(e.atMs))+'</time><code>'+esc(e.type)+'</code></div></li>').join('')+'</ol>'+
    '<div class="scope-note"><strong>保留完整本地记录</strong><p>导出包含固定策略、快照、判断与事件记录。它不是 DON 签名报告。</p><button class="quiet" data-export="'+esc(r.id)+'">导出这份本地记录</button></div>';
}
function renderDetail(){
  if(!detailContext||!$('detail-dialog').open&&rendered.has('detail-panel'))return;
  const r=session.requests.find(x=>x.id===detailContext.requestId);if(!r)return;
  text('detail-repository',r.policy.repository);text('detail-request','请求 '+short(r.id)+' · run '+r.policy.runId);
  text('detail-source',summarizeRequest(r).source.label);$('detail-source').className='source-pill '+(r.mode==='fixture'?'fixture':'live');
  for(const tab of document.querySelectorAll('[data-tab]')){const selected=tab.dataset.tab===detailContext.tab;tab.setAttribute('aria-selected',String(selected));tab.tabIndex=selected?0:-1;}
  $('detail-panel').setAttribute('aria-labelledby','tab-'+detailContext.tab);
  const key=JSON.stringify([r.id,detailContext.tab,r.status,r.evaluation,r.evidence?.digest,r.acquisitionFailure,r.history.length,r.storageFault,session.online]);
  patch('detail-panel',key,dossierMarkup(r,detailContext.tab));
}
function openDecision(outcome,opener){
  const r=session.current,m=summarizeRequest(r,{online:session.online,busy:session.busy});
  if(!r||(outcome==='accept'?!m.canAccept:!m.canReject))return;
  decisionContext={requestId:r.id,outcome,submitted:false};
  text('decision-title',outcome==='accept'?'审阅后记录验收':'确认拒绝这份交付');text('confirm-decision',outcome==='accept'?'确认本地验收':'确认拒绝交付');
  $('confirm-decision').className=outcome==='accept'?'accept':'reject-confirm';
  $('decision-provenance').innerHTML=provenance(r);
  $('decision-summary').innerHTML=pair('固定仓库',r.policy.repository)+pair('完整 commit',r.policy.commit)+pair('run / attempt',r.policy.runId+' / '+r.policy.runAttempt)+
    pair('通过证据有效至',stamp(r.evaluation?.validUntil))+'<p class="dialog-intro">'+(outcome==='accept'?'下面的决定只记录为本地买方操作。请确认您审阅的是这一份完整版本。':'拒绝后本请求结束，无法再用它记录验收。证据与事件仍保留。')+'</p>';
  $('decision-checklist').hidden=outcome!=='accept';$('code-ack').checked=false;$('risk-ack').checked=false;$('decision-error').hidden=true;
  renderDecision();showDialog('decision-dialog',opener);
}
function renderDecision(){
  if(!decisionContext)return;
  const r=session.requests.find(x=>x.id===decisionContext.requestId),m=summarizeRequest(r,{online:session.online,busy:session.busy});
  const eligible=Boolean(r&&(decisionContext.outcome==='accept'?m.canAccept:m.canReject));
  $('confirm-decision').disabled=!eligible||decisionContext.submitted||(decisionContext.outcome==='accept'&&(!$('code-ack').checked||!$('risk-ack').checked));
  text('decision-live',eligible?(decisionContext.outcome==='accept'?'CI 证据当前仍有效；提交时服务会再次检查时效。':'当前请求允许买方拒绝。'):'当前状态「'+m.stateLabel+'」或连接状态不允许记录此决定。请返回验证台。');
  $('decision-live').className='decision-live '+(eligible?'':'error');
}
async function copyValue(key,requestId=detailContext?.requestId??session.selectedId){
  const r=session.requests.find(x=>x.id===requestId);if(!r)return;
  const values={commit:r.policy.commit,policyHash:r.policyHash,requestId:r.id,digest:r.evidence?.digest,snapshot:r.evidence?.snapshot?JSON.stringify(r.evidence.snapshot,null,2):null},value=values[key];
  if(value==null)return;
  try{
    await navigator.clipboard.writeText(value);announce('已复制'+({commit:'完整 commit',policyHash:'策略哈希',requestId:'请求 ID',digest:'本地证据哈希',snapshot:'快照 JSON'}[key])+'。');
  }catch{
    const active=document.activeElement,buffer=document.createElement('textarea');buffer.className='copy-buffer';buffer.value=value;document.body.append(buffer);buffer.select();
    const ok=document.execCommand('copy');buffer.remove();active?.focus({preventScroll:true});
    announce(ok?'已复制固定值。':'自动复制未完成。请在档案中选中原始文本手动复制。',!ok);
  }
}
async function performAction(action,opener){
  const r=session.current;
  try{
    if(action==='freeze')openFreeze(draftCandidate(),opener);
    else if(action==='check'||action==='cancel'){if(r)await mutate(action,r.id);}
    else if(action==='review')openDecision('accept',opener);
    else if(action==='judgment'||action==='record')openDetail(action,opener);
    else if(action==='reconnect'){if(!draft)await newDraft();await refresh();}
    else if(action==='restart'&&r)openFreeze({policy:r.policy,mode:r.mode,scenario:r.scenario,intent:'复制取消请求的固定策略，创建新请求。时效与重放限制仍适用；不会重新打开旧请求。'},opener);
    else if(action==='new'){
      if(source()==='fixture'){await newDraft();announce('新演示交付已准备。请审阅新的 run 和策略。');}
      else announce('请在草稿中更新真实交付坐标和检查窗口，再审阅冻结。');
      $('freeze').focus();$('freeze').scrollIntoView({block:'center',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
    }
  }catch(e){if(action==='freeze')announce(e instanceof SyntaxError?'JSON 格式无效，请修正后预览。':e.message,true);}
}
$('freeze').addEventListener('click',e=>performAction('freeze',e.currentTarget));
$('check').addEventListener('click',e=>performAction('check',e.currentTarget));
$('next-action').addEventListener('click',e=>performAction(e.currentTarget.dataset.action,e.currentTarget));
$('cancel').addEventListener('click',e=>performAction('cancel',e.currentTarget));
$('new-request').addEventListener('click',e=>performAction('new',e.currentTarget));
$('accept').addEventListener('click',e=>openDecision('accept',e.currentTarget));
$('reject').addEventListener('click',e=>openDecision('reject',e.currentTarget));
$('copy-commit').addEventListener('click',()=>copyValue('commit',session.selectedId));
$('export').addEventListener('click',()=>{if(session.current)window.location.assign('/api/requests/'+session.current.id+'/export');});
$('replay').addEventListener('click',async()=>{
  const r=session.current;if(!r)return;try{await mutate('replay',r.id,{policy:r.policy,mode:r.mode,scenario:r.mode==='fixture'?'pass':'pass'});}catch{}
});
$('policy-ack').addEventListener('change',render);
$('confirm-freeze').addEventListener('click',async()=>{
  const context=freezeContext;if(!context||context.submitted||!$('policy-ack').checked)return;
  context.submitted=true;render();
  try{
    const r=await mutate('freeze',null,{policy:context.policy,mode:context.mode,scenario:context.scenario});
    if(r){closeDialog('freeze-dialog');if(source()==='fixture')await newDraft();$('check').focus({preventScroll:true});}
  }catch(e){if(freezeContext===context){context.submitted=false;$('freeze-error').hidden=false;$('freeze-error').textContent=e.message;render();}}
});
$('code-ack').addEventListener('change',renderDecision);$('risk-ack').addEventListener('change',renderDecision);
$('confirm-decision').addEventListener('click',async()=>{
  const context=decisionContext;if(!context||context.submitted||$('confirm-decision').disabled)return;
  context.submitted=true;renderDecision();
  try{const r=await mutate(context.outcome,context.requestId);if(r)closeDialog('decision-dialog');}
  catch(e){if(decisionContext===context){context.submitted=false;$('decision-error').hidden=false;$('decision-error').textContent=e.message;renderDecision();}}
});
$('request-list').addEventListener('click',e=>{const button=e.target.closest('[data-request]');if(button&&session.select(button.dataset.request))render();});
$('history-filter').addEventListener('change',renderHistory);$('history-search').addEventListener('input',renderHistory);
$('scenario').addEventListener('change',()=>newDraft().catch(e=>announce(e.message,true)));
document.querySelectorAll('input[name=source]').forEach(input=>input.addEventListener('change',()=>{
  draftEpoch++;draftLoading=false;$('fixture-controls').hidden=source()!=='fixture';$('github-controls').hidden=source()!=='github-rest';render();
}));
$('policy-json').addEventListener('input',()=>{jsonDirty=true;text('draft-feedback','输入已修改，请检查并预览策略。');render();});
$('validate-policy').addEventListener('click',e=>{
  try{const candidate=draftCandidate();text('draft-feedback','格式通过。请在审阅面板逐项确认固定坐标。');$('policy-json').setAttribute('aria-invalid','false');openFreeze(candidate,e.currentTarget);}
  catch(error){text('draft-feedback',error instanceof SyntaxError?'JSON 格式无效，请修正后重试。':error.message);$('policy-json').setAttribute('aria-invalid','true');$('policy-json').focus();}
});
$('dismiss-notice').addEventListener('click',()=>$('notice').hidden=true);
document.addEventListener('click',e=>{
  const close=e.target.closest('[data-close]');if(close){closeDialog(close.dataset.close);return;}
  const detail=e.target.closest('[data-detail]');if(detail){openDetail(detail.dataset.detail,detail);return;}
  const tab=e.target.closest('[data-tab]');if(tab&&detailContext){detailContext.tab=tab.dataset.tab;renderDetail();return;}
  const copy=e.target.closest('[data-copy]');if(copy){copyValue(copy.dataset.copy);return;}
  const exported=e.target.closest('[data-export]');if(exported&&session.online)window.location.assign('/api/requests/'+exported.dataset.export+'/export');
});
document.querySelector('.dossier-tabs').addEventListener('keydown',e=>{
  const tabs=[...document.querySelectorAll('[data-tab]')],index=tabs.indexOf(document.activeElement);if(index<0)return;
  let next;if(e.key==='ArrowRight')next=(index+1)%tabs.length;else if(e.key==='ArrowLeft')next=(index+tabs.length-1)%tabs.length;else if(e.key==='Home')next=0;else if(e.key==='End')next=tabs.length-1;else return;
  e.preventDefault();detailContext.tab=tabs[next].dataset.tab;renderDetail();tabs[next].focus();
});
try{await newDraft();await refresh();}catch(e){announce(e.message,true);render();}
async function poll(){await refresh();setTimeout(poll,900);}setTimeout(poll,900);
setInterval(render,500);
