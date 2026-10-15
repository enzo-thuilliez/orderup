import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** `~/.orderup/command-token`. Follows `$HOME`, so tests get their temporary one. */
export function defaultTokenPath(): string {
  return path.join(os.homedir(), '.orderup', 'command-token');
}

/** A fresh command channel token (ADR-015): 32 random bytes, hex. Never logged. */
export function generateToken(): string {
  return randomBytes(32).toString('hex');
}

/**
 * Writes the token readable by the user only (`0600`), or throws. The file is created next to
 * its final name and renamed over it, so an existing file or symlink there is replaced, not
 * written through. On POSIX the mode is checked after writing; Windows has no POSIX modes, and
 * the file lives in the user's own profile directory.
 */
export function writeTokenFile(file: string, token: string): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const fd = openSync(tmp, 'wx', 0o600);
    try {
      fchmodSync(fd, 0o600);
      if (process.platform !== 'win32' && (fstatSync(fd).mode & 0o777) !== 0o600) {
        throw new Error('the file did not keep 0600 permissions');
      }
      writeSync(fd, `${token}\n`);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, file);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // The directory itself is unusable: there is no temporary file to remove.
    }
    throw new Error(`cannot write the crew command token to ${file}: ${(err as Error).message}`, {
      cause: err,
    });
  }
}

/** Removes the token file on shutdown, unless another OrderUp has replaced it since. */
export function removeTokenFile(file: string, token: string): void {
  try {
    if (readFileSync(file, 'utf8').trim() === token) rmSync(file, { force: true });
  } catch {
    // Already gone or unreadable: nothing to clean up.
  }
}

/** Constant-time comparison of a presented token with the expected one. */
export function tokenMatches(expected: string, presented: unknown): boolean {
  if (typeof presented !== 'string') return false;
  // Hashing gives equal lengths, so timingSafeEqual never leaks the expected length.
  const a = createHash('sha256').update(expected).digest();
  const b = createHash('sha256').update(presented).digest();
  return timingSafeEqual(a, b);
}
