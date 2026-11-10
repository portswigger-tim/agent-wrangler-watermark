import { spawnSync } from 'node:child_process';

for (const file of process.argv.slice(2)) {
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
