import fs from 'node:fs';
import { resolveContext } from './config.mjs';
import { applyUpdatedSource } from './commands.mjs';
import { asPacError } from './errors.mjs';
import { pendingRetirement } from './backup-retention.mjs';

try {
  const request = JSON.parse(fs.readFileSync(0, 'utf8'));
  const data = await applyUpdatedSource(resolveContext({ home: request.home }), request);
  process.stdout.write(`${JSON.stringify({ ok: true, data, retireBackup: data.retention?.[pendingRetirement] })}\n`);
} catch (error) {
  const { code, message, details } = asPacError(error);
  process.stdout.write(`${JSON.stringify({ ok: false, error: { code, message, details } })}\n`);
}
