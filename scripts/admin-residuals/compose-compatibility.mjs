import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, posix } from 'node:path';
import ts from 'typescript';

const git = (args, options = {}) => execFileSync('git', args, { encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], ...options }).trim();
const candidate = git(['rev-parse', process.argv[2] ?? 'HEAD']);
assert.match(candidate, /^[a-f0-9]{40}$/);
const baseline = 'bbc76e18a64b8e3ff75c51fe7d966ae31e5f2fd2';
git(['merge-base', '--is-ancestor', baseline, candidate]);
const baselineTree = git(['rev-parse', baseline + '^{tree}']);
assert.equal(baselineTree, '8d4573601abfd8e7e86f56608cf3181275b5b641');
const read = file => execFileSync('git', ['show', candidate + ':' + file], { encoding: 'utf8', windowsHide: true });
const hash = value => createHash('sha256').update(value).digest('hex');
const binding = JSON.parse(read('scripts/admin-residuals/schema-binding.json'));
assert.equal(binding.baseline, baseline);
assert.equal(hash(read('prisma/migrations/' + binding.migration + '/migration.sql')), binding.migrationSha256);
const recovery = JSON.parse(read('scripts/ordinary-reconciliation/schema-binding.json'));
assert.equal(recovery.baseline, '562bfae09c73c8d93332630b5381e764488a4cab');
assert.equal(hash(read('prisma/migrations/' + recovery.migration + '/migration.sql')), recovery.migrationSha256);
const legacyPaths = [
  'prisma/schema.prisma', 'scripts/ordinary-reconciliation/schema-binding.json',
  'prisma/migrations/' + recovery.migration + '/migration.sql',
  'src/lib/ordinary-email-observation.ts', 'src/lib/ordinary-email-smtp-candidate.ts',
  'src/lib/ordinary-email-service-candidate.ts', 'src/lib/ordinary-email-store-candidate.ts',
  'src/lib/ordinary-email-receipt-reader.ts', 'src/lib/ordinary-email-receipt.ts',
  'src/lib/ordinary-email-inbound-store.ts', 'src/components/ordinary-email-receipts.tsx',
  'src/lib/admin-role-profile-contract.ts', 'src/lib/admin-role-profile-store.ts',
  'src/lib/admin-user-command-contract.ts', 'src/lib/admin-user-commands.ts', 'src/lib/user-actions.ts',
  'src/components/admin-role-profile-account.tsx', 'src/app/settings/users/page.tsx',
  'package.json', 'package-lock.json', 'eslint.config.mjs', 'scripts/lint-minimatch-compat.mjs',
  'src/lib/private-document-versions.ts', 'src/lib/technical-document-acquisition-persistence.ts',
  'src/lib/technical-document-acquired-access.ts', 'src/lib/selective-client-documents.ts',
  'src/lib/admin-practice-formalization-store.ts', 'src/lib/admin-operational-link-contract.ts',
  // Exact interface providers required by the retained privacy/readers overlay.
  'src/components/admin-reference-select.tsx', 'src/lib/admin-records.ts',
  'src/lib/admin-private-document-metadata.ts', 'src/lib/technical-document-catalog.ts',
  'src/lib/technical-work-item-catalog.ts',
  'src/lib/practice-readiness.ts', 'src/lib/ordinary-email-activation.ts', 'src/app/acquired-documents/[id]/route.ts',
  'src/app/clients/[id]/acquired-documents/page.tsx', 'src/app/practice-readiness/page.tsx',
  'scripts/m4/verify-schema.mjs', 'scripts/admin-residuals/schema-binding.json',
  'prisma/migrations/' + binding.migration + '/migration.sql',
];
// A historical image alone would reopen the newly forbidden technical data.
// Keep the entire reviewed privacy delta, including boundary wrappers, then
// close every new residual editor independently of its UI entry point.
const privacyBase = '99f4f6475a7cd6b0dd131ba0e42871dc03168a9b';
git(['merge-base', '--is-ancestor', privacyBase, candidate]);
const listed = revision => git(['ls-tree', '-r', '--name-only', revision, '--', 'src', 'public', 'prisma', 'scripts']).split('\n').filter(Boolean);
const candidateFiles = new Set(listed(candidate)), baseFiles = new Set(listed(baseline));
const cache = new Map();
const source = (revision, file) => {
  const key = revision + ':' + file;
  if (!cache.has(key)) cache.set(key, execFileSync('git', ['show', key], { encoding: 'utf8', windowsHide: true }));
  return cache.get(key);
};
const overlay = new Set(legacyPaths);
for (const file of git(['diff', '--name-only', privacyBase, candidate, '--', 'src', 'public', 'prisma', 'scripts']).split('\n').filter(Boolean)) {
  assert(candidateFiles.has(file), 'Deleted privacy sources need an explicit recovery decision: ' + file);
  overlay.add(file);
}
const mandatoryBoundaries = [];
for (const file of candidateFiles) {
  if (!file.startsWith('src/') || !/\.(ts|tsx)$/.test(file)) continue;
  const content = source(candidate, file);
  if (/withTechnicalPage|assertTechnicalFileRoute|assertTechnicalServerAction/.test(content)) {
    overlay.add(file); mandatoryBoundaries.push(file);
  }
}
const omittedPages = [
  'src/app/admin/links/[model]/[id]/page.tsx',
  'src/app/admin/private-documents/[id]/versions/page.tsx',
  'src/app/settings/roles/[role]/page.tsx',
  'src/app/admin/document-disclosure/[versionId]/page.tsx',
];
const stoppedActions = [
  'src/lib/admin-operational-link-actions.ts',
  'src/lib/admin-private-document-version-actions.ts',
  'src/lib/admin-role-profile-actions.ts',
  'src/lib/admin-technical-disclosure-actions.ts',
  'src/lib/ordinary-email-reconciliation-actions.ts',
];
for (const file of [...omittedPages, ...stoppedActions, 'src/components/ordinary-email-recovery.tsx']) overlay.add(file);
// Close all missing relative/alias imports against the exact candidate tree.
// Existing baseline modules are preserved unless the privacy delta or the
// schema74/75 reader overlay explicitly replaces them.
const imports = (file, content) => {
  const ast = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found = new Set();
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
      found.add(node.moduleSpecifier.text);
    if (ts.isCallExpression(node) && node.arguments.length === 1 && ts.isStringLiteral(node.arguments[0])
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(ast) === 'require'))
      found.add(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(ast); return [...found];
};
const dependencies = [], queue = [...new Set([...baseFiles].filter(file => file.startsWith('src/')).concat([...overlay]))];
for (let index = 0; index < queue.length; index++) {
  const file = queue[index];
  if (!/\.(ts|tsx|js|mjs)$/.test(file)) continue;
  const content = overlay.has(file) ? source(candidate, file) : source(baseline, file);
  for (const request of imports(file, content)) {
    if (!request.startsWith('.') && !request.startsWith('@/')) continue;
    const root = request.startsWith('@/') ? 'src/' + request.slice(2) : posix.normalize(posix.join(posix.dirname(file), request));
    const candidates = [root, ...['.ts', '.tsx', '.js', '.mjs', '.json', '/index.ts', '/index.tsx'].map(suffix => root + suffix)];
    if (candidates.some(path => overlay.has(path) || baseFiles.has(path))) continue;
    const added = candidates.find(path => candidateFiles.has(path));
    assert(added, 'Unresolved recovery import ' + file + ' -> ' + request);
    assert(/\.(ts|tsx|js|mjs|json|css)$/.test(added), 'A new binary recovery dependency needs an exact blob copy: ' + added);
    overlay.add(added); queue.push(added); dependencies.push({ from: file, request, added });
  }
}
const helper = 'src/lib/compatibility-writer-suspension.ts';
const suspension = "export async function assertCompatibilityWriterSuspended(): Promise<void> {\n  throw new Error('ADMIN_RESIDUAL_WRITER_SUSPENDED_DURING_COMPATIBLE_RECOVERY');\n}\n";
const temporary = mkdtempSync(join(tmpdir(), 'fai-admin-compat-index-'));
try {
  const index = join(temporary, 'index'), env = { ...process.env, GIT_INDEX_FILE: index };
  git(['read-tree', baseline], { env });
  const files = [];
  const put = (path, content, original = null) => {
    const blob = git(['hash-object', '-w', '--stdin'], { input: content });
    git(['update-index', '--add', '--cacheinfo', '100644,' + blob + ',' + path], { env });
    files.push({ path, sourceSha256: original === null ? null : hash(original), compatibilitySha256: hash(content), blob });
  };
  for (const path of [...overlay].sort()) {
    const original = read(path); let content = original;
    if (omittedPages.includes(path)) content = "import { notFound } from 'next/navigation';\nexport default async function Page() { notFound(); }\n";
    else if (stoppedActions.includes(path)) {
      const ast = ts.createSourceFile(path, original, ts.ScriptTarget.Latest, true);
      const positions = ast.statements.filter(node => ts.isFunctionDeclaration(node) && node.body
        && node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
        && node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword))
        .map(node => node.body.getStart(ast) + 1);
      assert(positions.length > 0, 'No suspended actions in ' + path);
      for (const at of positions.sort((a, b) => b - a)) content = content.slice(0, at)
        + '\n  await assertCompatibilityWriterSuspended();\n' + content.slice(at);
      const directive = content.indexOf("'use server';") + "'use server';".length;
      assert(directive >= "'use server';".length);
      content = content.slice(0, directive) + "\nimport { assertCompatibilityWriterSuspended } from './compatibility-writer-suspension';" + content.slice(directive);
    } else if (path === 'src/components/ordinary-email-recovery.tsx') {
      content = "export function OrdinaryEmailRecovery(props: { messageId: string; attemptId: string }) { void props; return null; }\n";
    }
    const omittedLink = path === 'src/app/clients/[id]/acquired-documents/page.tsx' ? 'Carica o ripristina una versione privata'
      : path === 'src/app/practice-readiness/page.tsx' ? 'Rettifica contratto, versione firmata e servizio collegato' : null;
    if (omittedLink) {
      const lines = content.split('\n');
      assert.equal(lines.filter(line => line.includes(omittedLink)).length, 1);
      content = lines.filter(line => !line.includes(omittedLink)).join('\n');
    }
    put(path, content, original);
  }
  put(helper, suspension);
  const tree = git(['write-tree'], { env });
  const date = git(['show', '-s', '--format=%cI', candidate]);
  const commitEnv = { ...env, GIT_AUTHOR_NAME: 'FAI Compatibility Builder', GIT_AUTHOR_EMAIL: 'compatibility@invalid.test',
    GIT_COMMITTER_NAME: 'FAI Compatibility Builder', GIT_COMMITTER_EMAIL: 'compatibility@invalid.test',
    GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
  const commit = git(['-c', 'commit.gpgSign=false', 'commit-tree', tree, '-p', baseline],
    { env: commitEnv, input: 'Privacy-preserving compatible readers for candidate ' + candidate
      + '\n\nBaseline application with exact schema74/75 readers, the mandatory privacy delta and its import closure. New residual writers are suspended server-side. This is a composed recovery, not the unmodified historical image.\n' });
  assert.equal(git(['rev-parse', commit + '^{tree}']), tree);
  for (const path of mandatoryBoundaries) {
    if (omittedPages.includes(path) || stoppedActions.includes(path)) continue;
    const emitted = source(commit, path);
    assert(emitted.includes('withTechnicalPage') || emitted.includes('assertTechnicalFileRoute') || emitted.includes('assertTechnicalServerAction'));
  }
  console.log(JSON.stringify({ protocol: 'ADMIN_PRIVACY_COMPATIBILITY_SOURCE_V2', baseline, baselineTree, privacyBase,
    candidate, candidateTree: git(['rev-parse', candidate + '^{tree}']), commit, tree, schema: 75,
    sqlSha256: recovery.migrationSha256, priorSql74Sha256: binding.migrationSha256,
    files, importClosure: dependencies, mandatoryBoundaries, omittedPages, stoppedActions,
    mandatoryTechnicalCeilingRetained: true, unmodifiedHistoricalRecovery: false,
    linkAndPrivateVersionEditorsExposed: false, roleProfileEditorExposed: false,
    technicalClassificationEditorExposed: false, newResidualWritersSuspendedServerSide: true,
    accountCreationUsesStoredProfiles: true, smtpRecoveryEditorExposed: false,
    authoritativeObservationWriterRetained: true, effectiveReconciledReceiptReadersRetained: true,
    originalSourceRowsRewritten: false, productionContact: false }));
} finally {
  assert.equal(dirname(temporary), resolve(tmpdir()));
  assert(temporary.startsWith(join(tmpdir(), 'fai-admin-compat-index-')));
  rmSync(temporary, { recursive: true, force: true });
}
