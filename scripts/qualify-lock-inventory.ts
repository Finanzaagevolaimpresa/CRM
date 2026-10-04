import { readFileSync } from 'node:fs';
import { parseNpmLockInventory, provisionPinnedOsvScanner, runOsvFallback } from './npm-audit-gate';

async function main() {
  const inventory = parseNpmLockInventory(readFileSync('package-lock.json'));
  const scanner = await provisionPinnedOsvScanner();
  try {
    await runOsvFallback({
      osvBinaryPath: scanner.binaryPath,
      osvConfigPath: scanner.configPath,
      expectedOsvBinarySha256: scanner.expectedBinarySha256,
    });
    console.log(JSON.stringify({ status: 'REAL_OSV_INVENTORY_PASS', entries: inventory.entryCount, uniquePackages: inventory.coordinates.size }));
  } finally {
    await scanner.cleanup();
  }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : 'LOCK_INVENTORY_QUALIFICATION_FAILED');
  process.exitCode = 1;
});
