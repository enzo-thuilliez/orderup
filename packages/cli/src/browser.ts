import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

export interface Launch {
  command: string;
  args: string[];
}

export interface Platform {
  platform: NodeJS.Platform;
  wsl: boolean;
}

export function detectPlatform(env: NodeJS.ProcessEnv = process.env): Platform {
  const platform = process.platform;
  let wsl = false;
  if (platform === 'linux') {
    wsl = Boolean(env.WSL_DISTRO_NAME);
    if (!wsl) {
      try {
        wsl = /microsoft/i.test(readFileSync('/proc/version', 'utf8'));
      } catch {
        // Not WSL, or /proc unavailable.
      }
    }
  }
  return { platform, wsl };
}

/**
 * How to open a URL in the user's browser. Under WSL, Linux usually has no browser: open
 * the Windows one through interop. WSL forwards Windows' 127.0.0.1 to Linux, so the
 * kitchen URL works unchanged. `rundll32 url.dll` avoids cmd.exe quoting and UNC warnings.
 */
export function browserLaunch(url: string, { platform, wsl }: Platform): Launch {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32' || wsl) {
    return {
      command: platform === 'win32' ? 'rundll32' : 'rundll32.exe',
      args: ['url.dll,FileProtocolHandler', url],
    };
  }
  return { command: 'xdg-open', args: [url] };
}

/** Opens the URL, detached. Resolves false if the opener couldn't be started. */
export function openBrowser(url: string, platform = detectPlatform()): Promise<boolean> {
  const { command, args } = browserLaunch(url, platform);
  return new Promise((resolve) => {
    try {
      const child = spawn(command, args, { detached: true, stdio: 'ignore' });
      child.once('error', () => resolve(false));
      child.once('spawn', () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}
