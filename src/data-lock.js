import fs from 'node:fs/promises';
import path from 'node:path';

export async function dataLockStatus(dataDir) {
  const lockFile = path.join(dataDir, 'veillink.lock');
  let text;
  try {
    text = await fs.readFile(lockFile, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { inUse: false, reason: '' };
    return { inUse: true, reason: 'the data-directory lock is unreadable' };
  }

  let pid = 0;
  try {
    const parsed = JSON.parse(text);
    if (Number.isInteger(parsed?.pid) && parsed.pid > 0) pid = parsed.pid;
  } catch {
    const legacy = Number.parseInt(String(text).trim(), 10);
    if (Number.isInteger(legacy) && legacy > 0) pid = legacy;
  }
  if (!pid) {
    return { inUse: true, reason: 'the data-directory lock is incomplete' };
  }
  try {
    process.kill(pid, 0);
    return { inUse: true, reason: `PID ${pid} holds the data-directory lock` };
  } catch (error) {
    if (error?.code === 'EPERM') {
      return { inUse: true, reason: `PID ${pid} holds the data-directory lock` };
    }
    return { inUse: false, reason: '' };
  }
}
