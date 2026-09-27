# Releasing orderup-cli

Only `orderup-cli` is published. It bundles the private workspaces: `cli`, `server` and
`shared` go into one ESM file (`packages/cli/dist/index.js`, built by
[scripts/bundle-cli.mjs](../scripts/bundle-cli.mjs)), and the built kitchen goes into
`packages/cli/dist/web/`. Its runtime dependencies are `ws` and `jsonc-parser`. See ADR-013.

Publishing runs in GitHub Actions ([release.yml](../.github/workflows/release.yml)) with npm
trusted publishing: no npm token is stored anywhere, and every version gets a provenance
attestation that links it to the workflow run and commit that built it.

## One-time setup

### npm (npmjs.com, logged in as the owner of `orderup-cli`)

1. Account → **Two-Factor Authentication**: enable it for authorization and writes.
2. `orderup-cli` → **Settings** → **Trusted Publisher** → **GitHub Actions**:

   | Field                | Value            |
   | -------------------- | ---------------- |
   | Organization or user | `enzo-thuilliez` |
   | Repository           | `orderup`        |
   | Workflow filename    | `release.yml`    |
   | Environment name     | `npm`            |

3. Once a release has gone through, same page → **Publishing access**: choose **Require
   two-factor authentication and disallow tokens**, and revoke any old automation or
   granular tokens. Trusted publishing keeps working and 2FA still allows manual publishes;
   only tokens stop working.

### GitHub (repo settings)

1. **Environments** → **New environment** → `npm`:
   - **Required reviewers**: yourself, so each publish waits for your approval.
   - **Deployment branches and tags**: selected, `main` and the tag pattern `v*`.
2. **Rules** → the `main` ruleset → **Require status checks**: replace the `ci (node …)`
   checks with the single `ci-pass` check. It passes only when the whole Node matrix and
   the macOS/Windows smoke tests pass.
3. Optional: a tag ruleset on `v*` that restricts creation to you.

## Day to day: changesets

A PR that changes what `orderup-cli` users get adds a changeset (`npx changeset`: pick
`orderup-cli`, the bump and a one-line summary). Changesets only bumps versions here: user-facing
notes still go under `Unreleased` in [CHANGELOG.md](../CHANGELOG.md).

## Cutting a release

1. From an up-to-date `main`: `git switch -c chore/release-x.y.z`.
2. `npx changeset version`. It bumps `packages/cli/package.json` and deletes the consumed
   changesets. Then run `npm install` to update the lockfile.
3. In CHANGELOG.md, rename `Unreleased` to `[x.y.z] - YYYY-MM-DD` and start a new empty
   `Unreleased` above it.
4. Check the package locally: `npm run build && npm run smoke`.
5. Open the PR, wait for `ci-pass`, merge.
6. Optional dry run: **Actions** → **Release** → **Run workflow** on `main`, with **dry-run**
   checked. It runs every check, the smoke test and `npm publish --dry-run`.
7. Tag the merge commit and push the tag. This starts the real publish:

   ```sh
   git fetch origin && git tag vx.y.z origin/main && git push origin vx.y.z
   ```

8. Approve the `npm` environment deployment in the run. The workflow checks that the tag
   matches the package version and that the version isn't on npm yet, runs the full CI
   sequence and the smoke test, then publishes with provenance.
9. Verify: `npm view orderup-cli version`, the provenance badge on the npm page, and
   `npx orderup-cli@x.y.z --version` from another directory.

A manual **Run workflow** with dry-run unchecked also publishes, but only from `main`.

**0.1.0:** the version is already set in `packages/cli/package.json`, so skip steps 1 to 5
and start at step 6.

## Manual fallback

If CI can't publish, from a clean checkout of the release tag:

```sh
npm ci && npm run build && npm run smoke
npm publish -w orderup-cli --access public   # asks for your 2FA code
```

A manual publish has no provenance attestation.
