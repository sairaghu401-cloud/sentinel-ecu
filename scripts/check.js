import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
let checked = 0;
for (const dir of ['src', 'web', 'web/design', 'scripts', 'tests']) {
  for (const file of readdirSync(resolve(root, dir)).filter(name => /\.(m?js)$/.test(name))) {
    const result = spawnSync(process.execPath, ['--check', resolve(root, dir, file)], { stdio: 'inherit' });
    if (result.error || result.status !== 0) process.exit(1);
    checked++;
  }
}
console.log(`Syntax checked ${checked} JavaScript modules.`);
