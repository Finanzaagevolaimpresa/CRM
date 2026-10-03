import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const source = dirname(fileURLToPath(import.meta.url));
export const root = resolve(source, '../../..');
export const work = resolve(root, 'node_modules/.cache/braces-qualification');
export const evidence = resolve(work, 'evidence');
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export const json = file => JSON.parse(readFileSync(file, 'utf8'));
export const manifest = json(resolve(source, 'provenance.json'));
