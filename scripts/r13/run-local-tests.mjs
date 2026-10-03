import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Uses the repository's TypeScript compiler directly; no tsx temporary-user lookup,
// new dependency, network, DATABASE_URL, container or persistent test database.
const directory = `.next/r13-tests-${Date.now()}`;
mkdirSync(directory, { recursive: true });
const run = args => {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', shell: false });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};
run([
  'node_modules/typescript/bin/tsc', '--outDir', directory,
  '--module', 'commonjs', '--moduleResolution', 'node', '--target', 'ES2022',
  '--jsx', 'react-jsx', '--esModuleInterop', '--skipLibCheck', '--strict', '--noEmit', 'false',
  'tests/marketing-preferences-r13.test.ts', 'tests/marketing-preferences-r13-postgres.test.ts',
  'tests/db/marketing-preferences-r13-db.test.ts',
]);
run(['--test', resolve(directory, 'tests/marketing-preferences-r13.test.js'),
  resolve(directory, 'tests/marketing-preferences-r13-postgres.test.js')]);
