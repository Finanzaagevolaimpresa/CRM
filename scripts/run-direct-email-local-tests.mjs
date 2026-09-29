import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

// Windows fallback when tsx cannot call os.userInfo in the execution sandbox.
// Uses the same TypeScript sources; it does not mock assertions or transport tests.
const root = process.cwd();
const output = path.join(root, '.next', 'direct-email-unit', String(Date.now()));
const files = ['src/lib/canonical-json.ts', 'src/lib/direct-email-test.ts',
  'src/lib/direct-email-test-smtp.ts', 'tests/direct-email-test.test.ts'];
for (const file of files) {
  const result = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    fileName: file, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const destination = path.join(output, file.replace(/\.ts$/, '.js'));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, result.outputText);
}
const result = spawnSync(process.execPath, ['--test', path.join(output, 'tests/direct-email-test.test.js')], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
