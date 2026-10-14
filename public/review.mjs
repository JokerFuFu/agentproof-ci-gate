export const STATE_LABELS = {pending:'等待读取',checking:'正在读取',awaiting_review:'等待人工验收',blocked:'验收阻挡',accepted:'本地已验收',rejected:'已拒绝',cancelled:'已取消',expired:'已过期'};
const ended = new Set(['accepted','rejected','cancelled','expired']);
const acquisition = code => /^(GITHUB_|FIXTURE_(TIMEOUT|INTERRUPTED)|ACQUISITION_|STORAGE_)/.test(code ?? '');
export function sourceDescription(mode='fixture',evidence=null) {
  const fixture = mode==='fixture';
  return {kind:fixture?'fixture':'github-rest',label:fixture?'Fixture / 合成证据':'公开 GitHub / 本地读取',tone:fixture?'fixture':'live',
    hasEvidence:Boolean(evidence?.snapshot),note:fixture?'本地生成的合成证据；没有 GitHub、CRE simulation 或 DON 执行。':'仅通过公开 GitHub GET 读取；由本地进程判断，没有 CRE 或 DON 执行。'};
}
export function summarizeRequest(r,{nowMs=Date.now(),online=true,busy=false}={}) {
  const source = sourceDescription(r?.mode,r?.evidence);
  const checked=r?.evaluation?.checks?.filter(c=>c.kind==='job')??[];
  const jobs={total:r?.policy.requiredJobs.length??0,passed:checked.filter(c=>c.passed).length,inspected:checked.length>0,
    stepsTotal:r?.policy.requiredJobs.reduce((n,j)=>n+j.steps.length,0)??0,stepsPassed:checked.reduce((n,j)=>n+(j.steps??[]).filter(s=>s.passed).length,0)};
  const deadline=r?Math.min(r.expiresAtMs,Number.isFinite(r.evaluation?.validUntil)?r.evaluation.validUntil:Infinity):null;
  const expired=Boolean(r&&!ended.has(r.status)&&nowMs>=deadline);
  const writable=online&&!busy&&!r?.storageFault&&!expired;
  const pauseRemainingMs=r?.mode==='github-rest'&&Number.isSafeInteger(r.acquisitionFailure?.retryAtMs)?Math.max(0,r.acquisitionFailure.retryAtMs-nowMs):0;
  const m={source,jobs,deadline,pauseRemainingMs,remainingMs:r&&!ended.has(r.status)?Math.max(0,deadline-nowMs):null,
    canCheck:Boolean(r&&writable&&pauseRemainingMs===0&&['pending','blocked'].includes(r.status)),canAccept:Boolean(r&&writable&&r.status==='awaiting_review'&&r.evaluation?.passed&&r.evidence),
    canCancel:Boolean(r&&writable&&!ended.has(r.status)),canReject:Boolean(r&&writable&&!ended.has(r.status)),
    stateLabel:r?STATE_LABELS[r.status]:'未开始',tone:'wait',title:'从一份固定交付开始',detail:'先确认来源和必需检查，冻结后再读取证据。',primary:{action:'freeze',label:'确认并冻结策略'},elapsedMs:null};
  const offlineView={stateLabel:'连接中断',title:'连接中断，等待确认当前状态',detail:'旧显示不能继续操作。恢复连接后重新读取服务状态。',primary:{action:'reconnect',label:'重新连接'},tone:'error'};
  if(!r){if(!online)Object.assign(m,offlineView);return m;}
  const state=expired?'expired':r.status,reason=r.evaluation?.reasons?.[0];
  m.stateLabel=expired?'有效期结束':m.stateLabel;
  switch(state) {
    case 'pending':Object.assign(m,{title:'策略已固定，下一步读取证据',detail:'仅检查这一份仓库、commit、run 与 workflow。人工开关仍关闭。',primary:{action:'check',label:'读取 CI 证据'}});break;
    case 'checking':Object.assign(m,{title:'正在读取固定 run 的证据',detail:'返回后核对绑定、必需检查与时效。此时尚无通过结论，可取消请求。',primary:{action:'cancel',label:'取消本次请求'},elapsedMs:Math.max(0,nowMs-(r.history.findLast(e=>e.type==='checking')?.atMs??nowMs))});break;
    case 'awaiting_review':Object.assign(m,{tone:'success',title:'CI 前置条件已满足，轮到人工判断',detail:'证据满足冻结策略。请审阅代码与实际交付，再在有效期内作出决定。',primary:{action:'review',label:'进入人工审阅'}});break;
    case 'blocked':Object.assign(m,{tone:'error',title:acquisition(reason?.code)?'证据获取未完成，验收保持关闭':'证据未满足冻结策略',detail:reason?.detail??'请查看判断依据，再决定重新读取或准备新请求。',
      primary:acquisition(reason?.code)||reason?.code==='RUN_NOT_SUCCESSFUL'?{action:'check',label:'重新读取证据'}:{action:'judgment',label:'查看原因与下一步'}});break;
    case 'cancelled':Object.assign(m,{tone:'error',title:'本次请求已取消',detail:'晚到结果不会重新开放验收。继续同一交付时，需确认并冻结一份新请求。',primary:{action:'restart',label:'复制策略，创建新请求'}});break;
    case 'expired':Object.assign(m,{tone:'error',title:'有效期已结束，人工开关关闭',detail:'需要一份新的有效交付。已占用的 run 仍受重放保护，不会因过期释放。',primary:{action:'new',label:'准备新交付'}});break;
    case 'accepted':Object.assign(m,{tone:'success',title:'买方已在本地记录验收',detail:'这是独立人工决定。记录没有钱包签名或链上最终性。',primary:{action:'record',label:'查看人工决定与记录'}});break;
    case 'rejected':Object.assign(m,{tone:'error',title:'买方已拒绝这份交付',detail:'该请求已结束。证据与决定保留在本地，可查看或导出。',primary:{action:'record',label:'查看拒绝记录'}});break;
  }
  if(!online)Object.assign(m,offlineView);
  if(pauseRemainingMs>0&&r.status==='blocked')Object.assign(m,{title:'GitHub 读取暂停，验收保持关闭',detail:'已按实际响应设置最早重试时间。等待期间不会再次发送请求；恢复后仍须取得完整证据。'});
  if(r.storageFault)Object.assign(m,{title:'保存结果不确定，操作已停止',detail:'请停止本地服务，检查实际状态文件后再重启；不要清空记录绕过重放保护。',primary:{action:'judgment',label:'查看保存异常'},tone:'error'});
  return m;
}
export function bindingRows(r) {
  const p=r.policy,s=r.evidence?.snapshot;
  const identity = repo => repo?.id && typeof repo.full_name==='string' ? repo.full_name.toLowerCase()+' (#'+repo.id+')' : null;
  const rows = [
    ['repository','仓库',p.repository,s?.repository?.full_name?.toLowerCase()],
    ['repositoryId','仓库数字 ID',p.repositoryId,s?.repository?.id],
    ['runRepository','run 所属仓库',p.repository+' (#'+p.repositoryId+')',identity(s?.run?.repository)],
    ['headRepository','代码来源仓库',p.repository+' (#'+p.repositoryId+')',identity(s?.run?.head_repository)],
    ['commit','完整 commit',p.commit,s?.run?.head_sha],
    ['runId','run ID',p.runId,s?.run?.id],['runAttempt','run attempt',p.runAttempt,s?.run?.run_attempt],
    ['workflowId','run 的 workflow ID',p.workflowId,s?.run?.workflow_id],
    ['workflowFileId','workflow 元数据 ID',p.workflowId,s?.workflow?.id],
    ['workflowPath','run 的 workflow 路径',p.workflowPath,s?.run?.path],
    ['workflowMetadataPath','workflow 元数据路径',p.workflowPath,s?.workflow?.path],
    ['workflowBlob','workflow 文件 SHA',p.workflowBlobSha,s?.workflowFile?.sha],
    ['branch','分支',p.branch,s?.run?.head_branch],['event','触发事件',p.event,s?.run?.event]
  ];
  return rows.map(([key,label,expected,observed])=>({key,label,expected,observed:observed??null,match:observed===undefined||observed===null?null:observed===expected}));
}
export function reasonHelp(reason,r=null) {
  const code=reason?.code??'UNKNOWN';
  if(r?.acquisitionFailure?.category==='primary-rate-limit')return {title:'匿名读取额度已耗尽',body:'按响应中的 reset / Retry-After 等待最早重试时间，不要通过新建请求回避暂停。等待结束不保证已恢复额度。'};
  if(r?.acquisitionFailure?.category==='secondary-rate-limit')return {title:'GitHub 要求暂缓请求',body:'遵循实际 Retry-After 或至少一分钟的等待。此处不会自动轮询 GitHub 直至成功。'};
  if(r?.acquisitionFailure?.category==='access-denied')return {title:'访问被拒绝，原因不是已确认的限流',body:'核对仓库是否公开、路径和访问权限。保持验收关闭，不改路由或换身份绕过拒绝。'};
  if(code==='REPLAY_DETECTED')return {title:'这份 run 已占用',body:'使用新的 run/attempt 重新交付。复制请求或刷新页面不能释放已占用证据。'};
  if(/EXPIRED|STALE|BEFORE_POLICY|OBSERVATION_TIME|INVALID_.*TIME/.test(code))return {title:'核对检查窗口和有效期',body:'查看实际时间，准备新的 CI 结果或交付请求。不能把旧结果重新标为新证据。'};
  if(/COMMIT_MISMATCH/.test(code))return {title:'先核对两个完整 commit',body:'在「策略」中比较固定 commit 与 CI 实际 commit。修改交付坐标须新建请求，不能编辑已冻结策略。'};
  if(/MISMATCH|CHANGED/.test(code))return {title:'核对固定坐标与实际证据',body:'查看仓库、run/attempt、workflow 与文件版本。确认一致后重新读取；坐标改变须新建请求。'};
  if(/JOB|STEP|RUN_NOT_SUCCESSFUL/.test(code))return {title:'查看未满足的检查',body:'展开必需 job 与 step，确认实际执行结果。修复或完成 CI 后可重新读取固定 run；改变 run/attempt 须新建请求。'};
  if(acquisition(code))return {title:'主动重新读取',body:'没有可用于验收的完整证据。检查网络或 GitHub 访问状态，再主动重试；本地 Fixture 的超时情境仍是合成演示。'};
  if(code==='REQUEST_CANCELLED')return {title:'取消后需要新请求',body:'旧请求不能重新打开。可以复制策略再冻结，仍会保留时效与重放限制。'};
  return {title:'查看原始判断与来源',body:'当前证据不足以开放验收。核对来源和字段，补全有效证据后再继续。'};
}
export function groupReasons(reasons=[]){
  const groups=new Map();for(const reason of reasons){let group=groups.get(reason.code);if(!group){group={code:reason.code,count:0,details:[]};groups.set(reason.code,group);}group.count++;if(!group.details.includes(reason.detail))group.details.push(reason.detail);}return [...groups.values()];
}
export function stepOutcomeLabel(step){return !step?'未取得':step.passed?'通过':step.conclusion==='success'?'执行成功 / 未满足':step.conclusion;}
export function publicLinks(r) {
  const p=r?.policy;
  if(r?.mode!=='github-rest'||!p||! /^[a-z0-9][a-z0-9-]{0,38}\/[a-z0-9][a-z0-9_.-]{0,99}$/i.test(p.repository)||p.repository.includes('..')||
    !/^[a-f0-9]{40}$/i.test(p.commit)||!Number.isSafeInteger(p.runId)||p.runId<1)return [];
  const base='https://github.com/'+p.repository;
  return [{label:'打开固定 commit',url:base+'/commit/'+p.commit},{label:'打开固定 run',url:base+'/actions/runs/'+p.runId}];
}
