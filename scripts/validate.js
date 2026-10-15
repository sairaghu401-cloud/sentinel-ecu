import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runValidation } from '../src/experiments.js';

const root = fileURLToPath(new URL('../', import.meta.url));

try {
  const seedArg = process.argv.find(arg => arg.startsWith('--seed='));
  const seed = seedArg ? Number(seedArg.slice(7)) : 42;
  const report = runValidation({ seed });
  const destination = resolve(root, 'artifacts', 'validation-report.json');
  await mkdir(resolve(root, 'artifacts'), { recursive: true });
  await writeFile(destination, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  for (const item of report.cases) {
    console.log(`${item.passed ? 'PASS' : 'FAIL'} ${item.name}`);
    for (const check of item.checks.filter(check => !check.passed)) console.error(`  ${check.name}: ${check.detail}`);
  }
  console.log(`${report.summary.passed}/${report.summary.total} synthetic validation cases passed.`);
  console.log(`Report saved to ${destination}`);
  if (report.summary.passed !== report.summary.total) process.exitCode = 1;
} catch (error) {
  console.error(`Validation failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
