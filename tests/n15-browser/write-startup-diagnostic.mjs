import { readFileSync, writeFileSync } from 'node:fs';

const [logPath, outputPath, reasonCode, rawStatus = 'unknown'] = process.argv.slice(2);
const allowedReasons = new Set(['READY', 'EARLY_EXIT', 'HEALTH_TIMEOUT']);
if (!logPath || !outputPath || !allowedReasons.has(reasonCode)) {
  process.stderr.write('N15_BROWSER_DIAGNOSTIC_INPUT_INVALID\n');
  process.exit(64);
}

let log = '';
try { log = readFileSync(logPath, 'utf8').slice(-64 * 1024); } catch { /* absence is a finite signal */ }
const status = /^(?:unknown|[0-9]{1,3})$/u.test(rawStatus) ? rawStatus : 'invalid';
const diagnostic = {
  reasonCode,
  processExitStatus: status,
  logAvailable: log.length > 0,
  markers: {
    ready: /(?:^|\n).*Ready in/u.test(log),
    registryActivationBlocked: /INTERNAL_SESSION_REGISTRY_ACTIVATION_BLOCKED/u.test(log),
    databaseInitializationError: /PrismaClientInitializationError/u.test(log),
    addressInUse: /EADDRINUSE/u.test(log),
    nextConfigurationError: /Invalid next\.config|next\.config.*error/iu.test(log),
  },
};
writeFileSync(outputPath, `${JSON.stringify(diagnostic, null, 2)}\n`, { mode: 0o600 });
