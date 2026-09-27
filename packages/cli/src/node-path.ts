/**
 * Node version managers that keep one directory per version. A hook pointing into one keeps
 * using that exact version, and fails (silently) once it is uninstalled.
 */
const VERSION_MANAGERS: [name: string, pattern: RegExp][] = [
  ['nvm', /[\\/]\.?nvm[\\/](versions[\\/]node[\\/])?v\d/i],
  ['fnm', /[\\/]fnm[\\/]node-versions[\\/]|[\\/]fnm_multishells[\\/]/i],
  ['volta', /[\\/]\.?volta[\\/]tools[\\/]image[\\/]node[\\/]/i],
  ['asdf', /[\\/]\.asdf[\\/]installs[\\/]nodejs[\\/]/i],
  ['mise', /[\\/]mise[\\/]installs[\\/]node[\\/]/i],
  ['nodenv', /[\\/]\.nodenv[\\/]versions[\\/]/i],
  ['n', /[\\/]n[\\/]versions[\\/]node[\\/]/i],
];

/** The version manager owning this Node binary, or null for a system-wide install. */
export function versionManagerOf(nodePath: string): string | null {
  return VERSION_MANAGERS.find(([, pattern]) => pattern.test(nodePath))?.[0] ?? null;
}

export function versionManagerWarning(nodePath: string): string | null {
  const manager = versionManagerOf(nodePath);
  if (!manager) return null;
  return (
    `Hooks run ${nodePath}, a Node managed by ${manager}. They keep using this exact ` +
    'version: after switching Node versions, re-run `orderup --install-hooks` to update ' +
    'them. If this version is uninstalled, hooks stop reporting (silently, by design).\n'
  );
}
