import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
// Fallback for Windows sandboxes where tsx cannot access os.userInfo.
const root = process.cwd(), output = path.join(root, '.next', 'profile-unit', String(Date.now()));
for (const file of ['src/lib/canonical-json.ts', 'src/lib/record-profile-contract.ts', 'tests/record-profiles.test.ts']) {
  const result = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    fileName: file, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const destination = path.join(output, file.replace(/\.ts$/, '.js'));
  fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, result.outputText);
}
const result = spawnSync(process.execPath, ['--test', path.join(output, 'tests/record-profiles.test.js')], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
