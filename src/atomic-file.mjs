import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function atomicWriteFile(file, content, mode) {
  let before;
  try { before = await fs.lstat(file); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (before && !before.isFile()) throw new Error(`Refusing to replace a non-regular file: ${file}`);
  const targetMode = mode ?? (before ? before.mode & 0o7777 : 0o600);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temp, content, { flag: 'wx', mode: targetMode });
    if (before && process.platform !== 'win32') {
      const current = await fs.stat(temp);
      if (current.uid !== before.uid || current.gid !== before.gid) await fs.chown(temp, before.uid, before.gid);
    }
    await fs.chmod(temp, targetMode);
    await fs.rename(temp, file);
  } finally {
    await fs.unlink(temp).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  }
}
