import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
let count = 0;
for (const dir of ['src', 'public', 'scripts', 'tests']) {
  for (const file of readdirSync(resolve(root, dir))) if (file.endsWith('.mjs')) {
    const result = spawnSync(process.execPath, ['--check', resolve(root, dir, file)], { encoding: 'utf8' });
    if (result.status !== 0) { console.error(result.stderr); process.exit(result.status ?? 1); }
    count++;
  }
}
console.log(`Syntax checks passed for ${count} JavaScript modules.`);
