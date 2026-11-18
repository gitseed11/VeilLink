import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

export function resolveDataDir(override = '') {
  if (!override) return path.join(PROJECT_ROOT, 'data');
  const resolved = path.resolve(override);
  const driveRoot = path.parse(resolved).root.replace(/[\\/]+$/, '');
  const normalized = resolved.replace(/[\\/]+$/, '');
  const projectRoot = PROJECT_ROOT.replace(/[\\/]+$/, '');
  if (normalized.toLowerCase() === driveRoot.toLowerCase()) {
    throw new Error('VEILLINK_DATA_DIR must not be a drive root.');
  }
  if (normalized.toLowerCase() === projectRoot.toLowerCase()) {
    throw new Error('VEILLINK_DATA_DIR must not be the project root.');
  }
  if (process.platform === 'win32' && process.env.SystemRoot) {
    const windowsDir = path.resolve(process.env.SystemRoot).replace(/[\\/]+$/, '');
    if (
      normalized.toLowerCase() === windowsDir.toLowerCase() ||
      normalized.toLowerCase().startsWith(`${windowsDir.toLowerCase()}${path.sep}`)
    ) {
      throw new Error('VEILLINK_DATA_DIR must not be inside the Windows system directory.');
    }
  }
  const broadRoots = [
    process.env.USERPROFILE,
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.ProgramData,
    process.env.LOCALAPPDATA,
    process.env.APPDATA
  ].filter(Boolean);
  for (const broadRoot of broadRoots) {
    const normalizedBroad = path.resolve(broadRoot).replace(/[\\/]+$/, '');
    if (normalized.toLowerCase() === normalizedBroad.toLowerCase()) {
      throw new Error(
        'VEILLINK_DATA_DIR must be a dedicated directory, not a broad user/Program Files/AppData/ProgramData root.'
      );
    }
  }
  return resolved;
}

export function createPaths(dataDir) {
  return {
    root: PROJECT_ROOT,
    dataDir,
    configFile: path.join(dataDir, 'config.json'),
    keysFile: path.join(dataDir, 'keys.json'),
    masterKeyFile: path.join(dataDir, 'master.key'),
    adminFile: path.join(dataDir, 'admin.json'),
    adminTokenFile: path.join(dataDir, 'ADMIN_TOKEN.txt'),
    logsDir: path.join(dataDir, 'logs'),
    accessLogFile: path.join(dataDir, 'logs', 'access.log'),
    webDir: path.join(PROJECT_ROOT, 'web'),
    tunnelDir: path.join(dataDir, 'tunnel'),
    binDir: path.join(PROJECT_ROOT, 'bin')
  };
}
