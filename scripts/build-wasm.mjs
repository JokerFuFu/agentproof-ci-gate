import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const version = 'v8.1.0';
const os = process.platform === 'darwin' ? 'macos' : process.platform === 'linux' ? 'linux' : null;
const arch = process.arch === 'arm64' ? 'arm' : process.arch === 'x64' ? 'x86_64' : null;
if (!os || !arch) throw new Error('Local WASM build currently supports macOS/Linux arm64/x64.');
const name = `javy-${arch}-${os}-${version}`, base = `https://github.com/bytecodealliance/javy/releases/download/${version}/${name}.gz`;
const cache = resolve(root, '.local', 'javy', version); mkdirSync(cache, { recursive: true });
const binary = resolve(cache, 'javy'), manifest = resolve(cache, 'download.json');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
if (!existsSync(binary)) {
  const responses = await Promise.all([fetch(base), fetch(`${base}.sha256`)]);
  if (responses.some(r => !r.ok)) throw new Error(`Official Javy download failed: ${responses.map(r => r.status).join(',')}`);
  const archive = Buffer.from(await responses[0].arrayBuffer()), expected = (await responses[1].text()).trim().split(/\s+/)[0];
  if (!/^[a-f0-9]{64}$/.test(expected) || sha(archive) !== expected) throw new Error('Official Javy archive checksum mismatch; refusing to execute');
  const bytes = gunzipSync(archive);
  writeFileSync(binary, bytes, { mode: 0o755 });
  writeFileSync(manifest, JSON.stringify({ version, archiveURL: base, checksumURL: `${base}.sha256`, archiveSha256: expected, binarySha256: sha(bytes) }, null, 2));
}
const metadata = JSON.parse(readFileSync(manifest, 'utf8'));
if (sha(readFileSync(binary)) !== metadata.binarySha256) throw new Error('Cached Javy binary changed; refusing to execute');
const pluginDir = resolve(root, 'cre/node_modules/@chainlink/cre-sdk-javy-plugin/dist');
const input = resolve(root, 'cre/artifacts/ci-gate.js'), output = resolve(root, 'cre/artifacts/ci-gate.wasm');
if (!existsSync(input)) throw new Error('First run: cd cre && npm run build:js');
execFileSync(binary, ['build', '-C', `wit=${resolve(pluginDir,'workflow.wit')}`, '-C', 'wit-world=workflow',
  '-C', `plugin=${resolve(pluginDir,'javy-chainlink-sdk.plugin.wasm')}`, '-C', 'deterministic=y', input, '-o', output], { stdio: 'inherit' });
const bytes = readFileSync(output), module = await WebAssembly.compile(bytes);
const evidence = { checkedAt: new Date().toISOString(), sdk: '1.23.0', plugin: '1.7.0',
  javy: metadata, wasmBytes: bytes.byteLength, wasmSha256: sha(bytes), imports: WebAssembly.Module.imports(module),
  exports: WebAssembly.Module.exports(module), status: 'compiled-only', simulated: false, deployed: false };
mkdirSync(resolve(root, 'evidence'), { recursive: true });
writeFileSync(resolve(root, 'evidence/cre-build.json'), JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ status: evidence.status, wasmBytes: evidence.wasmBytes, wasmSha256: evidence.wasmSha256, simulated: false, deployed: false }));
