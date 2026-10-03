import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
// Local fallback where the Windows sandbox cannot supply os.userInfo to tsx.
const root = process.cwd(), output = path.join(root, '.next', 'role-unit', String(Date.now()));
const tests = process.argv.slice(2);
if (!tests.length || tests.some(file => !/^tests\/[a-z0-9-]+\.test\.ts$/.test(file))) throw new Error('Explicit unit test paths required');
const libraryFiles = fs.readdirSync(path.join(root, 'src/lib'), { recursive: true }).filter(file => file.endsWith('.ts')).map(file => path.join('src/lib', file));
for (const file of [...libraryFiles, ...tests]) {
  const result = ts.transpileModule(fs.readFileSync(path.join(root, file), 'utf8'), {
    fileName: file, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  });
  const destination = path.join(output, file.replace(/\.ts$/, '.js'));
  fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, result.outputText);
}
const result = spawnSync(process.execPath, ['--test', ...tests.map(file => path.join(output, file.replace(/\.ts$/, '.js')))], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
