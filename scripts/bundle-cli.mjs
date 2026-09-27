// Builds the publishable orderup-cli package (ADR-013): one ESM bundle of cli + server + shared
// in packages/cli/dist, the built kitchen in packages/cli/dist/web, plus README, LICENSE and the
// notices of bundled third-party code. Run after `npm run build -w orderup-web`.
// `--check` only verifies that a build is there (npm runs it before packing).
import { build } from 'esbuild';
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const cli = path.join(root, 'packages', 'cli');
const webBuild = path.join(root, 'packages', 'web', 'dist');
const pkg = JSON.parse(readFileSync(path.join(cli, 'package.json'), 'utf8'));
const repoUrl = 'https://github.com/enzo-thuilliez/orderup';

if (process.argv.includes('--check')) {
  const missing = ['dist/index.js', 'dist/web/index.html', 'README.md', 'LICENSE'].filter(
    (file) => !existsSync(path.join(cli, file)),
  );
  if (missing.length) {
    console.error(
      `orderup-cli isn't built (missing ${missing.join(', ')}). Run \`npm run build\`.`,
    );
    process.exit(1);
  }
  process.exit(0);
}

if (!existsSync(path.join(webBuild, 'index.html'))) {
  console.error('packages/web/dist is missing. Run `npm run build -w orderup-web` first.');
  process.exit(1);
}

rmSync(path.join(cli, 'dist'), { recursive: true, force: true });

// Runtime dependencies stay external and are installed by npm; everything else is inlined.
const external = Object.keys(pkg.dependencies ?? {});
const { metafile } = await build({
  entryPoints: [path.join(cli, 'src', 'index.ts')],
  outfile: path.join(cli, 'dist', 'index.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22.13',
  // Workspace packages resolve to their TypeScript sources, as in dev.
  conditions: ['source'],
  external,
  sourcemap: false,
  legalComments: 'eof',
  metafile: true,
  logLevel: 'warning',
});

cpSync(webBuild, path.join(cli, 'dist', 'web'), {
  recursive: true,
  filter: (src) => !src.endsWith('.map'),
});

// npm shows the package README on npmjs.com, where repo-relative links don't resolve.
// Images (the demo GIF) need the raw file, links the GitHub page.
const readme = readFileSync(path.join(root, 'README.md'), 'utf8')
  .replace(
    /\bsrc="(?!https?:)([^"]+)"/g,
    (_, file) => `src="https://raw.githubusercontent.com/enzo-thuilliez/orderup/main/${file}"`,
  )
  .replace(/\]\((?!https?:|#|mailto:)([^)]+)\)/g, (_, link) => `](${repoUrl}/blob/main/${link})`);
writeFileSync(path.join(cli, 'README.md'), readme);
cpSync(path.join(root, 'LICENSE'), path.join(cli, 'LICENSE'));

// Third-party code shipped inside the tarball: bundled into dist, and the web app's deps.
const bundled = new Set();
for (const input of Object.keys(metafile.inputs)) {
  const match = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input);
  if (match) bundled.add(match[1]);
}
const webPkg = JSON.parse(readFileSync(path.join(root, 'packages', 'web', 'package.json'), 'utf8'));
for (const dep of Object.keys(webPkg.dependencies ?? {})) {
  if (!dep.startsWith('orderup-')) bundled.add(dep);
}
const notices = [...bundled].sort().map((name) => {
  const dir = path.join(root, 'node_modules', name);
  const { version, license } = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  const file = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license'].find((f) =>
    existsSync(path.join(dir, f)),
  );
  if (!file) throw new Error(`no license file for bundled dependency ${name}`);
  const text = readFileSync(path.join(dir, file), 'utf8').trim();
  return `${name}@${version} (${license})\n\n${text}\n`;
});
writeFileSync(
  path.join(cli, 'dist', 'THIRD-PARTY-NOTICES.txt'),
  `orderup-cli bundles the following third-party packages.\n\n${notices.join('\n---\n\n')}`,
);

console.log(
  `bundled orderup-cli ${pkg.version} (third-party notices: ${[...bundled].sort().join(', ')})`,
);
