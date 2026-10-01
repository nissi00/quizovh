import { spawnSync } from 'node:child_process';

const compose = ['compose','-f','compose.test.yaml'];
const run = args => spawnSync('docker',[...compose,...args],{ stdio:'inherit',shell:false });

let exitCode = 1;
try {
  const result = run(['up','--build','--abort-on-container-exit','--exit-code-from','e2e']);
  exitCode = result.error ? 1 : (result.status ?? 1);
  if (result.error) console.error(`Impossible de lancer Docker : ${result.error.message}`);
} finally {
  run(['down','--volumes','--remove-orphans']);
}
process.exit(exitCode);
