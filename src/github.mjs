import { normalizePolicy } from './policy.mjs';
import { isIP } from 'node:net';

export class EvidenceError extends Error {
  constructor(code,message,diagnostics=null){super(message);this.name='EvidenceError';this.code=code;if(diagnostics)this.diagnostics=diagnostics;}
}
export function githubPaths(input){
  const p=normalizePolicy(input),base='https://api.github.com/repos/'+p.repository;
  return {repository:base,run:base+'/actions/runs/'+p.runId,workflow:base+'/actions/workflows/'+p.workflowId,
    workflowFile:base+'/contents/'+p.workflowPath+'?ref='+p.commit,jobs:base+'/actions/runs/'+p.runId+'/attempts/'+p.runAttempt+'/jobs?per_page=100'};
}
const MAX_BODY=2_097_152,MAX_ERROR_BODY=8192;
const HEADER_NAMES=['date','content-type','x-ratelimit-limit','x-ratelimit-remaining','x-ratelimit-used','x-ratelimit-reset','x-ratelimit-resource','retry-after','x-github-api-version-selected'];
const sanitize=value=>String(value??'').replace(/[\x00-\x1f\x7f]/g,' ')
  .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g,'[IP redacted]').replace(/(?<![\w:])[a-f0-9:]{2,}(?![\w:])/gi,value=>isIP(value)===6?'[IP redacted]':value)
  .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g,'[token redacted]').slice(0,300);
const integer=value=>typeof value==='string'&&/^\d{1,15}$/.test(value)&&Number.isSafeInteger(Number(value))?Number(value):null;
const validTime=value=>Number.isSafeInteger(value)&&value>=0&&value<=8_640_000_000_000_000;
function safeURL(value){
  try{const url=new URL(value);if(url.protocol!=='https:'||!['docs.github.com','developer.github.com'].includes(url.hostname)||url.username||url.password)return null;return url.origin+url.pathname;}catch{return null;}
}
export function githubResponseDiagnostics(response,{url=null,resource=null,observedAtMs=Date.now(),upstream=null,bodyState='not-read'}={}){
  const headers=Object.fromEntries(HEADER_NAMES.filter(k=>response.headers.has(k)).map(k=>[k,sanitize(response.headers.get(k)).slice(0,80)]));
  const status=response.status,message=typeof upstream?.message==='string'?sanitize(upstream.message):null,remaining=integer(headers['x-ratelimit-remaining']);
  let category=status===200?'ok':status===403?'access-denied':status===401?'authentication-required':status===404?'not-found':status>=500?'server-error':'http-error';
  if([403,429].includes(status)){
    if(remaining===0||/API rate limit exceeded/i.test(message??''))category='primary-rate-limit';
    else if(/secondary rate limit|abuse detection/i.test(message??'')||status===429)category='secondary-rate-limit';
  }
  const limits=[];
  const retrySeconds=integer(headers['retry-after']),resetSeconds=integer(headers['x-ratelimit-reset']);
  if(status!==200&&retrySeconds!==null&&validTime(observedAtMs+retrySeconds*1000))limits.push(observedAtMs+retrySeconds*1000);
  if(status!==200&&remaining===0&&resetSeconds!==null&&validTime(resetSeconds*1000))limits.push(resetSeconds*1000);
  if(/rate-limit$/.test(category)&&limits.length===0)limits.push(observedAtMs+60_000);
  const quotaPauseUntilMs=remaining===0?resetSeconds!==null&&validTime(resetSeconds*1000)?Math.max(observedAtMs,resetSeconds*1000):observedAtMs+60_000:null;
  return {resource,url,status,observedAtMs,headers,category,upstreamMessage:message,documentationURL:safeURL(upstream?.documentation_url),bodyState,quotaPauseUntilMs,
    retryAtMs:limits.length?Math.max(observedAtMs,...limits):null};
}
async function readBytes(response,limit){
  if(Number(response.headers.get('content-length'))>limit){await response.body?.cancel().catch(()=>{});return {tooLarge:true};}
  const reader=response.body?.getReader();if(!reader)return {missing:true};
  const chunks=[];let size=0;
  try{
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>limit){await reader.cancel();return {tooLarge:true};}chunks.push(value);}
    const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}return {bytes};
  }finally{reader.releaseLock();}
}
export async function readJSONResponse(response,{clock=Date.now,url=null,resource=null}={}){
  const observedAtMs=clock();
  if(response.status!==200){
    let upstream=null,bodyState='not-json';
    if(/application\/(?:[\w.+-]*\+)?json/i.test(response.headers.get('content-type')??'')){
      try{const result=await readBytes(response,MAX_ERROR_BODY);bodyState=result.tooLarge?'too-large':result.missing?'missing':'invalid-json';
        if(result.bytes){const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(result.bytes));if(value&&typeof value==='object'&&!Array.isArray(value)){upstream=value;bodyState='parsed';}}}
      catch{bodyState='unavailable';}
    }else await response.body?.cancel().catch(()=>{});
    const diagnostic=githubResponseDiagnostics(response,{url,resource,observedAtMs,upstream,bodyState});
    const suffix=diagnostic.category==='primary-rate-limit'?'匿名主限流已触发。':diagnostic.category==='secondary-rate-limit'?'二级限流已触发。':diagnostic.category==='access-denied'?'访问被拒绝；不能仅凭 403 认定为限流。':'未取得完整证据。';
    const wait=diagnostic.retryAtMs?' 最早可重试 '+new Date(diagnostic.retryAtMs).toISOString()+'；此时刻不保证额度已恢复。':'';
    throw new EvidenceError('GITHUB_HTTP_'+response.status,'GitHub 返回 HTTP '+response.status+'；'+suffix+wait,diagnostic);
  }
  if(!/application\/(?:[\w.+-]*\+)?json/i.test(response.headers.get('content-type')??''))throw new EvidenceError('INVALID_GITHUB_RESPONSE','GitHub 返回了非 JSON 响应。');
  try{
    const result=await readBytes(response,MAX_BODY);
    if(result.tooLarge)throw new EvidenceError('GITHUB_RESPONSE_TOO_LARGE','GitHub 响应超过 2 MiB 上限。');
    if(!result.bytes)throw new EvidenceError('INVALID_GITHUB_RESPONSE','GitHub 响应缺少正文。');
    const value=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(result.bytes));
    if(value===null||typeof value!=='object'||Array.isArray(value))throw Error('Expected object');return value;
  }catch(e){if(e instanceof EvidenceError)throw e;throw new EvidenceError('INVALID_GITHUB_RESPONSE','GitHub 返回了无效 JSON 或读取未完成。');}
}
export async function fetchGitHubEvidence(input,{fetchImpl=fetch,signal,timeoutMs=15000,clock=Date.now}={}){
  const paths=githubPaths(input);
  if(signal?.aborted)throw new EvidenceError('ACQUISITION_CANCELLED','证据读取已取消。');
  const timeout=AbortSignal.timeout(timeoutMs),combined=signal?AbortSignal.any([signal,timeout]):timeout,acquisition=[];
  let quotaPauseUntilMs=0;
  const read=async(resource,url)=>{
    combined.throwIfAborted();
    if(clock()<quotaPauseUntilMs)throw new EvidenceError('GITHUB_RETRY_NOT_READY','上一项 GET 已耗尽匿名额度；未发送下一项请求。',
      {category:'retry-pause',status:null,url,resource,observedAtMs:clock(),retryAtMs:quotaPauseUntilMs,headers:{},upstreamMessage:null,bodyState:'not-read',completedRequests:structuredClone(acquisition)});
    const response=await fetchImpl(url,{method:'GET',redirect:'error',cache:'no-store',signal:combined,
      headers:{Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2026-03-10','User-Agent':'AgentProof-CI-Gate-local/0.1','Cache-Control':'no-cache'}});
    const observedAtMs=clock();
    try{
      const value=await readJSONResponse(response,{clock:()=>observedAtMs,url,resource});
      const receipt=githubResponseDiagnostics(response,{url,resource,observedAtMs});acquisition.push(receipt);
      quotaPauseUntilMs=Math.max(quotaPauseUntilMs,receipt.quotaPauseUntilMs??0);return value;
    }catch(e){if(e.diagnostics)e.diagnostics.completedRequests=structuredClone(acquisition);throw e;}
  };
  try{
    const repository=await read('repository',paths.repository),run=await read('run',paths.run),workflow=await read('workflow',paths.workflow),
      workflowFile=await read('workflowFile',paths.workflowFile),jobs=await read('jobs',paths.jobs);
    if(!Array.isArray(jobs.jobs)||jobs.total_count!==jobs.jobs.length||jobs.jobs.length>100)throw new EvidenceError('INCOMPLETE_JOBS','job 列表不完整或超过本版 100 个 job 的上限。');
    const runConfirmation=await read('runConfirmation',paths.run);
    return {repository,run,workflow,workflowFile,jobs,runConfirmation,observedAtMs:clock(),
      source:{kind:'github-rest',execution:'node-local',note:'Live public GitHub GETs via this local process; no CRE or DON execution.'},endpoints:paths,acquisition};
  }catch(e){
    if(signal?.aborted)throw new EvidenceError('ACQUISITION_CANCELLED','证据读取已取消。');
    if(e instanceof EvidenceError&&e.diagnostics)throw e;
    if(timeout.aborted||e.name==='TimeoutError')throw new EvidenceError('GITHUB_TIMEOUT','GitHub 读取超过时间上限，请重新读取。');
    if(e instanceof EvidenceError)throw e;throw new EvidenceError('GITHUB_NETWORK_ERROR','GitHub 网络读取中断或失败，未取得完整证据。');
  }
}
export function createGitHubAcquirer({fetchImpl=fetch,clock=Date.now,resumeAfterMs=0}={}){
  let pauseUntil=Number.isSafeInteger(resumeAfterMs)?resumeAfterMs:0;
  return async(input,options={})=>{
    normalizePolicy(input);
    if(options.signal?.aborted)throw new EvidenceError('ACQUISITION_CANCELLED','证据读取已取消。');
    const now=clock();
    if(now<pauseUntil)throw new EvidenceError('GITHUB_RETRY_NOT_READY','GitHub 读取暂停至 '+new Date(pauseUntil).toISOString()+'；未再次发送请求。',
      {category:'retry-pause',status:null,url:null,resource:null,observedAtMs:now,retryAtMs:pauseUntil,headers:{},upstreamMessage:null,documentationURL:null,bodyState:'not-read'});
    try{const result=await fetchGitHubEvidence(input,{...options,fetchImpl,clock});pauseUntil=Math.max(pauseUntil,...result.acquisition.map(r=>r.quotaPauseUntilMs??0));return result;}
    catch(e){if(Number.isSafeInteger(e.diagnostics?.retryAtMs))pauseUntil=Math.max(pauseUntil,e.diagnostics.retryAtMs);throw e;}
  };
}
