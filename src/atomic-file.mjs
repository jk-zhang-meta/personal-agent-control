import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function atomicWriteFile(file, content, mode = 0o600) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temp, content, { flag: 'wx', mode });
    await fs.rename(temp, file);
  } finally {
    await fs.unlink(temp).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}
