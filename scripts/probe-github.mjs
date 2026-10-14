import { readJSONResponse, githubResponseDiagnostics } from '../src/github.mjs';
// Read-only discovery; output is metadata, never a passed CI verdict.
const repository = process.argv[2] ?? 'JokerFuFu/agentproof-ci-gate';
const runId = process.argv[3];
if (!/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(repository) ||
    (runId && (!/^\d+$/.test(runId) || !Number.isSafeInteger(Number(runId)) || Number(runId) < 1))) {
  throw new Error('Usage: npm run probe:github -- owner/repo [numericRunId]');
}
const base = `https://api.github.com/repos/${repository}`;
const output = { checkedAt: new Date().toISOString(), provenance: 'real-public-github-get-no-token',
  assurance: 'metadata-only-not-a-CI-verdict', requests: [] };
const take = (value, keys) => Object.fromEntries(keys.filter(k => value?.[k] !== undefined).map(k => [k, value[k]]));
const summarizeRun = value => ({ ...take(value, ['id','name','run_attempt','workflow_id','path','head_sha','head_branch','event','status','conclusion','created_at','run_started_at','updated_at','html_url']),
  repository: take(value.repository, ['id','full_name']), head_repository: take(value.head_repository, ['id','full_name']) });
function summarize(value) {
  if (Array.isArray(value.workflow_runs)) return { total_count: value.total_count, workflow_runs: value.workflow_runs.map(summarizeRun) };
  if (Array.isArray(value.jobs)) return { total_count: value.total_count, jobs: value.jobs.map(j => take(j, ['id','name','run_id','run_attempt','head_sha','status','conclusion','started_at','completed_at','steps'])) };
  if (value.head_sha && value.run_attempt) return summarizeRun(value);
  return take(value, ['id','full_name','private','default_branch','name','path','sha','type','state','html_url','download_url']);
}
async function read(url) {
  let item;
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000),
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10', 'User-Agent': 'AgentProof-CI-Gate-local/0.1' } });
    item = { ...githubResponseDiagnostics(response, { url }), rateLimitRemaining: response.headers.get('x-ratelimit-remaining'),
      rateLimitReset: response.headers.get('x-ratelimit-reset') };
    output.requests.push(item);
    const data = await readJSONResponse(response, { url }); item.data = summarize(data); return data;
  } catch (error) {
    if (!item) { item = { url }; output.requests.push(item); }
    Object.assign(item, error.diagnostics ?? {}, { error: error.code ?? error.name,
      detail: error.code ? error.message : '公开网络读取未完成；没有 CI 结论。' }); return null;
  }
}
const repo = await read(base);
if (repo) {
  if (!runId) await read(`${base}/actions/runs?per_page=5`);
  else {
    const run = await read(`${base}/actions/runs/${runId}`);
    if (run) {
      await read(`${base}/actions/workflows/${run.workflow_id}`);
      await read(`${base}/contents/${run.path}?ref=${run.head_sha}`);
      await read(`${base}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`);
    }
  }
}
console.log(JSON.stringify(output, null, 2));
if (output.requests.some(r => r.status !== 200 || r.error)) process.exitCode = 1;
