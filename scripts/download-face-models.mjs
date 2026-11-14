// Immutable model revisions and SHA-256 verification, including existing files.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = join(root, 'models');
mkdirSync(dir, { recursive: true });
const models = JSON.parse(readFileSync(join(root, 'face-models.json'), 'utf8'));
const hash = (buffer) => createHash('sha256').update(buffer).digest('hex');

for (const [name, model] of Object.entries(models)) {
  const out = join(dir, name);
  if (existsSync(out)) {
    if (hash(readFileSync(out)) !== model.sha256) {
      throw new Error(`${name}: existing model checksum mismatch; preserve it and investigate before replacing it.`);
    }
    console.log(`✓ ${name} (checksum verified)`);
    continue;
  }
  const response = await fetch(model.url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (hash(buffer) !== model.sha256) throw new Error(`${name}: downloaded checksum mismatch`);
  const temporary = join(dir, `.${name}.${randomUUID()}.download`);
  try {
    writeFileSync(temporary, buffer, { flag: 'wx' });
    renameSync(temporary, out);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
  console.log(`✓ ${name} (${Math.round(buffer.length / 1024)} KB, checksum verified)`);
}
