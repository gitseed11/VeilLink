import fs from 'node:fs/promises';
import path from 'node:path';

export async function ensureDirPrivate(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(dir, 0o700);
  } catch {
    // Windows does not expose POSIX modes. Install scripts apply an ACL instead.
  }
}

export async function readJsonIfExists(file, fallback) {
  try {
    const text = await fs.readFile(file, 'utf8');
    return JSON.parse(text);
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback;
    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${file}: ${error.message}`);
    }
    throw error;
  }
}

export async function writeFileAtomic(file, data, { mode = 0o600, encoding = 'utf8' } = {}) {
  await ensureDirPrivate(path.dirname(file));
  const suffix = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  const temp = `${file}.tmp-${suffix}`;
  try {
    await fs.writeFile(temp, data, { mode, encoding, flag: 'w' });
    await fs.chmod(temp, mode).catch(() => {});
    // Flush the temporary file before the atomic rename. This makes the
    // contents durable on a best-effort basis; the parent directory is not
    // fsynced, so a power loss immediately after rename can still lose the
    // directory entry on some filesystems.
    const handle = await fs.open(temp, 'r+');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(temp, file);
    await fs.chmod(file, mode).catch(() => {});
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => {});
    throw error;
  }
}

export async function writeJsonAtomic(file, value, options = {}) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await writeFileAtomic(file, text, { mode: 0o600, encoding: 'utf8', ...options });
}

export async function readTextIfExists(file) {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

export async function fileMtimeMs(file) {
  try {
    return (await fs.stat(file)).mtimeMs;
  } catch (error) {
    if (error?.code === 'ENOENT') return 0;
    throw error;
  }
}
