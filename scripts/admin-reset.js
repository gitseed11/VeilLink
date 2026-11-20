import net from 'node:net';
import path from 'node:path';
import { AdminAuth } from '../src/secrets.js';
import { createPaths, resolveDataDir } from '../src/paths.js';
import { dataLockStatus } from '../src/data-lock.js';
import { ensureDirPrivate } from '../src/storage.js';
import { hardenDirectory } from '../src/permissions.js';

const dataDir = resolveDataDir(process.env.VEILLINK_DATA_DIR || '');
const paths = createPaths(dataDir);
const rawAdminPort = process.env.VEILLINK_ADMIN_PORT || '8787';
const adminPort = Number(rawAdminPort);
if (!Number.isInteger(adminPort) || adminPort < 1 || adminPort > 65535) {
  console.error('VEILLINK_ADMIN_PORT must be an integer between 1 and 65535.');
  process.exit(1);
}

function portInUse(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    const done = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(750, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

const lock = await dataLockStatus(dataDir);
if (lock.inUse) {
  console.error(`VeilLink data directory is still in use: ${lock.reason}.`);
  console.error('Stop the service first with scripts/stop.ps1.');
  process.exit(1);
}
if (await portInUse(adminPort)) {
  console.error(`VeilLink still appears to be listening on 127.0.0.1:${adminPort}.`);
  console.error('Stop it first with scripts/stop.ps1 so all existing admin sessions are invalidated.');
  process.exit(1);
}

await ensureDirPrivate(dataDir);
await ensureDirPrivate(paths.logsDir);
const rootPermissions = await hardenDirectory(paths.root);
const dataPermissions = await hardenDirectory(dataDir);
if (!rootPermissions.ok || !dataPermissions.ok) {
  console.error(
    `Unable to harden filesystem ACLs: ${rootPermissions.error || dataPermissions.error}`
  );
  process.exit(1);
}

const auth = new AdminAuth(paths);
const token = await auth.reset();

console.log('VeilLink admin token has been reset.');
console.log(`Data directory: ${path.resolve(dataDir)}`);
console.log(`Token file: ${paths.adminTokenFile}`);
if (process.stdout.isTTY) {
  console.log('');
  console.log(token);
  console.log('');
} else {
  console.log('');
  console.log('Token output suppressed because stdout is redirected; read the token file above.');
  console.log('');
}
