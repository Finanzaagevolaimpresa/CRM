import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const root = path.resolve('src');
function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(item => item.isDirectory()
    ? files(path.join(dir, item.name)) : /\.tsx?$/.test(item.name) ? [path.join(dir, item.name)] : []);
}
const publicRoutes = new Set(['/api/health', '/api/integrations/website/leads', '/api/integrations/website/leads/v2']);
function exported(node: ts.Node) {
  return ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword);
}
function guarded(body: ts.ConciseBody | undefined, name: string, value: string): boolean {
  if (!body || !ts.isBlock(body)) return false;
  const first = body.statements[0];
  if (!first || !ts.isExpressionStatement(first) || !ts.isAwaitExpression(first.expression)) return false;
  const call = first.expression.expression;
  return ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.expression.text === name
    && call.arguments.length === 1 && ts.isStringLiteral(call.arguments[0]) && call.arguments[0].text === value;
}
test('all pages, API/file handlers and server actions enforce the technical ceiling before reading input or data', () => {
  const failures: string[] = [];
  let pages = 0, routes = 0, actions = 0;
  for (const file of files(root)) {
    const rel = path.relative(root, file).replaceAll('\\', '/');
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const page = rel.startsWith('app/') && rel.endsWith('/page.tsx');
    const route = rel.startsWith('app/') && rel.endsWith('/route.ts');
    const routeName = '/' + path.posix.dirname(rel.slice(4)).replace(/^\.$/, '');
    if (page) {
      pages++;
      const defaults = source.statements.filter(ts.isExportAssignment);
      if (defaults.length !== 1) failures.push(rel + ': guarded default export missing');
      else {
        const e = defaults[0].expression;
        if (!(ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'withTechnicalPage'
          && e.arguments.length === 2 && ts.isStringLiteral(e.arguments[0]) && e.arguments[0].text === routeName))
          failures.push(rel + ': wrong page guard');
      }
      if (source.statements.some(s => exported(s) && ts.isFunctionDeclaration(s)
        && ['generateMetadata', 'generateStaticParams', 'generateViewport'].includes(s.name?.text ?? '')))
        failures.push(rel + ': new metadata surface requires explicit privacy review');
    }
    const server = source.statements.some(s => ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression) && s.expression.text === 'use server');
    const declarations = new Map(source.statements.filter(ts.isFunctionDeclaration).map(s => [s.name?.text, s]));
    if (route && !publicRoutes.has(routeName)) {
      routes++;
      for (const s of source.statements) {
        if (!exported(s)) continue;
        if (ts.isFunctionDeclaration(s) && /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(s.name?.text ?? '')
          && !guarded(s.body, 'assertTechnicalFileRoute', routeName)) failures.push(rel + ': unguarded ' + s.name?.text);
        if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) {
          if (!ts.isIdentifier(d.name) || !/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)$/.test(d.name.text)) continue;
          const target = d.initializer && ts.isIdentifier(d.initializer) ? declarations.get(d.initializer.text) : undefined;
          if (!target || !guarded(target.body, 'assertTechnicalFileRoute', routeName)) failures.push(rel + ': unguarded alias ' + d.name.text);
        }
        if (ts.isExportDeclaration(s)) failures.push(rel + ': handler re-export needs privacy review');
      }
    }
    if (server) for (const s of source.statements) {
      if (!exported(s)) continue;
      if (ts.isFunctionDeclaration(s) && s.name) {
        actions++;
        const key = path.basename(file, path.extname(file)) + ':' + s.name.text;
        if (!guarded(s.body, 'assertTechnicalServerAction', key)) failures.push(rel + ': unguarded action ' + key);
      } else if (!ts.isTypeAliasDeclaration(s) && !ts.isInterfaceDeclaration(s)) failures.push(rel + ': server action export shape requires privacy review');
    }
    function visit(node: ts.Node) {
      if (ts.isFunctionLike(node) && 'body' in node && node.body && ts.isBlock(node.body)
        && node.body.statements.some(s => ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression) && s.expression.text === 'use server'))
        failures.push(rel + ': inline action requires guarded admission');
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  assert(pages > 130 && routes >= 25 && actions > 60, 'inventory unexpectedly incomplete');
  assert.deepEqual(failures, []);
});
