import { CronCapability, HTTPClient, Runner, handler, consensusIdenticalAggregation,
  type Runtime, type NodeRuntime } from '@chainlink/cre-sdk';
import { acquireReport, validateConfig, type Config } from './acquisition.ts';

// This uses real CRE capability APIs. This workflow has not been simulated or deployed.
const onCron = (runtime: Runtime<Config>): string => {
  const observedAtMs = runtime.now().getTime();
  const serialized = runtime.runInNodeMode((node: NodeRuntime<Config>, nowMs: number) => {
    const client = new HTTPClient();
    const report = acquireReport(node.config, nowMs, url => {
      const response = client.sendRequest(node, { url, method: 'GET', timeout: '5s',
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2026-03-10',
          'User-Agent': 'AgentProof-CI-Gate-CRE/0.1', 'Cache-Control': 'no-cache' },
        // Pinned SDK 1.23.0 uses store/maxAge (the website currently shows newer field names).
        cacheSettings: { store: false, maxAge: '0s' } }).result();
      if (response.statusCode !== 200) throw new Error(`GitHub HTTP ${response.statusCode}; no evidence report`);
      if (response.body.byteLength > 2_097_152) throw new Error('GitHub response exceeds 2 MiB');
      const value = JSON.parse(new TextDecoder().decode(response.body));
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid GitHub JSON');
      return value;
    });
    // Identical consensus on the reduced binding/verdict, not volatile GitHub response fields.
    return JSON.stringify(report);
  }, consensusIdenticalAggregation<string>())(observedAtMs).result();
  runtime.log('CI prerequisite evaluated; human acceptance remains a separate decision.');
  return serialized;
};
const initWorkflow = (config: Config) => {
  validateConfig(config);
  return [handler(new CronCapability().trigger({ schedule: config.schedule }), onCron)];
};
export async function main() {
  const runner = await Runner.newRunner<Config>();
  await runner.run(initWorkflow);
}
