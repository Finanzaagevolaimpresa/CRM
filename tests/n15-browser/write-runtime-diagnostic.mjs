import { readFileSync, writeFileSync } from 'node:fs';

const [logPath, outputPath] = process.argv.slice(2);
if (!logPath || !outputPath) {
  process.stderr.write('N15_BROWSER_RUNTIME_DIAGNOSTIC_INPUT_INVALID\n');
  process.exit(64);
}

let log = '';
try { log = readFileSync(logPath, 'utf8').slice(-64 * 1024); } catch { /* finite absence */ }
for (const secret of [process.env.N15_BROWSER_PASSWORD, process.env.PRIVILEGED_STEP_UP_SECRET]) {
  if (secret) log = log.replaceAll(secret, '[REDACTED]');
}
log = log
  .replaceAll(/postgres(?:ql)?:\/\/[^\s/@:]+:[^\s/@]+@/giu, 'postgresql://[REDACTED]@')
  .replaceAll(/(authorization|cookie|set-cookie):[^\r\n]*/giu, '$1: [REDACTED]')
  .replaceAll(/((?:password|token|secret)=)[^&\s]+/giu, '$1[REDACTED]')
  .replaceAll(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, '[REDACTED_EMAIL]');

const relevant = log.split(/\r?\n/u)
  .filter((line) => /error|server action|failed|exception|POST \/login|at\s+[^ ]+|Blocked cross-origin request to Next\.js dev resource/iu.test(line))
  .slice(-80)
  .join('\n')
  .slice(0, 8 * 1024);
const diagnostic = {
  phase: 'POST_BROWSER_SERVER',
  logAvailable: log.length > 0,
  classifications: {
    originOrHostMismatch: /origin|host.*mismatch|does not match/iu.test(log),
    devResourceBlocked: /Blocked cross-origin request to Next\.js dev resource/iu.test(log),
    missingOrUnknownAction: /failed to find server action|unknown server action|missing.*action/iu.test(log),
    invalidActionRequest: /invalid.*server action|invalid action request/iu.test(log),
    compilationOrModuleError: /module not found|failed to compile|compilation error/iu.test(log),
    registryError: /internal_session|registry/iu.test(log),
    prismaError: /prisma/iu.test(log),
  },
  frameworkExcerpt: relevant || null,
};
writeFileSync(outputPath, `${JSON.stringify(diagnostic, null, 2)}\n`, { mode: 0o600 });
