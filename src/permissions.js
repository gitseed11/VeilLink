import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const HARDEN_SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'harden-acl.ps1'
);
const SYSTEM_ROOT = process.env.SystemRoot || 'C:\\Windows';
const POWERSHELL = path.join(
  SYSTEM_ROOT,
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe'
);
// Node may have been started by PowerShell 7, which rewrites PSModulePath for
// its own runtime. Windows PowerShell 5.1 then cannot autoload Get-Acl from
// Microsoft.PowerShell.Security. Give the short-lived helper a clean module
// path so the ACL verification is deterministic.
const POWERSHELL_ENV = {
  ...process.env,
  PSModulePath: [
    process.env.USERPROFILE
      ? path.join(process.env.USERPROFILE, 'Documents', 'WindowsPowerShell', 'Modules')
      : '',
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'WindowsPowerShell', 'Modules'),
    path.join(SYSTEM_ROOT, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules')
  ]
    .filter(Boolean)
    .join(';')
};

/**
 * Restrict a directory tree to the current Windows account plus SYSTEM and
 * Administrators. The PowerShell helper resets pre-existing explicit ACEs,
 * applies the restricted DACL, and verifies the final ACL before returning.
 */
export async function hardenDirectory(dir) {
  if (process.platform !== 'win32') {
    return { ok: true, skipped: true };
  }
  try {
    await execFileAsync(
      POWERSHELL,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HARDEN_SCRIPT, '-Path', dir],
      {
        windowsHide: true,
        timeout: 120000,
        maxBuffer: 2 * 1024 * 1024,
        env: POWERSHELL_ENV
      }
    );
    return { ok: true, skipped: false };
  } catch (error) {
    return {
      ok: false,
      error:
        (error?.stderr || '').trim() ||
        (error?.stdout || '').trim() ||
        error?.message ||
        'ACL hardening failed.'
    };
  }
}

export const hardenDataDirectory = hardenDirectory;
