import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * The head chef's git setup (#19, issue comment on ADR-016): one worktree per task, outside the
 * user's checkout, and a pre-push hook that only the chef process sees. Every git call runs
 * with `execFile` (no shell) and a short timeout, against the configured repo with `-C`.
 */

/** Task ids become a directory and a branch name, so they are kept to a safe alphabet. */
const TASK_ID_RE = /^[A-Za-z0-9_-]+$/;
const GIT_TIMEOUT_MS = 30_000;

export function isValidTaskId(taskId: string): boolean {
  return TASK_ID_RE.test(taskId) && !taskId.startsWith('-') && taskId.length <= 100;
}

/** `~/.orderup`. Follows `$HOME`, so tests get their temporary one. */
export function defaultOrderupDir(): string {
  return path.join(os.homedir(), '.orderup');
}

/** `~/.orderup/git-hooks`: the chef's `core.hooksPath`. Never the repo's `.git/hooks`. */
export function hooksDir(orderupDir: string = defaultOrderupDir()): string {
  return path.join(orderupDir, 'git-hooks');
}

/** `~/.orderup/worktrees/<repo-basename>/<taskId>`. */
export function chefWorktreePath(
  repoPath: string,
  taskId: string,
  orderupDir: string = defaultOrderupDir(),
): string {
  return path.join(orderupDir, 'worktrees', path.basename(path.resolve(repoPath)), taskId);
}

/** `orderup/<taskId>`: the task branch the chef works on. */
export function taskBranch(taskId: string): string {
  return `orderup/${taskId}`;
}

/** Git with no shell. Rejects with git's stderr in the message (git output, never a prompt). */
export function git(repoPath: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', repoPath, ...args],
      {
        timeout: GIT_TIMEOUT_MS,
        encoding: 'utf8',
        windowsHide: true,
        // The guard variables are for the chef only, never for OrderUp's own git calls.
        env: withoutGitConfigEnv(process.env),
      },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`git ${args[0] ?? ''} failed: ${stderr.trim() || err.message}`));
        else resolve(stdout.trim());
      },
    );
  });
}

function withoutGitConfigEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (
      !key.startsWith('GIT_CONFIG_') ||
      key === 'GIT_CONFIG_GLOBAL' ||
      key === 'GIT_CONFIG_SYSTEM'
    )
      out[key] = value;
  }
  return out;
}

async function gitOk(repoPath: string, args: readonly string[]): Promise<boolean> {
  return git(repoPath, args).then(
    () => true,
    () => false,
  );
}

async function gitCommonDir(dir: string): Promise<string> {
  const common = await git(dir, ['rev-parse', '--git-common-dir']);
  return realpath(path.resolve(dir, common));
}

/**
 * The repo's default branch: `origin/HEAD` when the remote names one, else `main` or `master`
 * when it exists locally.
 */
export async function defaultBranch(repoPath: string): Promise<string> {
  const remoteHead = await git(repoPath, [
    'symbolic-ref',
    '--quiet',
    '--short',
    'refs/remotes/origin/HEAD',
  ]).catch(() => '');
  if (remoteHead.startsWith('origin/')) return remoteHead.slice('origin/'.length);
  for (const name of ['main', 'master']) {
    if (await gitOk(repoPath, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]))
      return name;
  }
  throw new Error('cannot tell the repo default branch (no origin/HEAD, main or master)');
}

export interface ChefWorktree {
  path: string;
  branch: string;
  /** The default branch the task branch was created from, refused by the pre-push hook. */
  defaultBranch: string;
  /** False when an existing worktree for the task was reused (a `send-back`). */
  created: boolean;
}

/**
 * Creates the chef's worktree for a task on a new `orderup/<taskId>` branch from the repo's
 * default branch, or reuses the one a previous run of the task left. Never checks anything out
 * in the user's own working tree.
 */
export async function ensureChefWorktree(options: {
  repoPath: string;
  taskId: string;
  orderupDir?: string;
}): Promise<ChefWorktree> {
  const { repoPath, taskId } = options;
  if (!isValidTaskId(taskId)) throw new Error(`invalid task id: ${JSON.stringify(taskId)}`);
  const top = await git(repoPath, ['rev-parse', '--show-toplevel']);
  const worktree = chefWorktreePath(top, taskId, options.orderupDir);
  const inside = path.relative(path.resolve(top), worktree);
  if (!inside.startsWith('..') && !path.isAbsolute(inside)) {
    throw new Error('the chef worktree would be inside the repo checkout');
  }
  const branch = taskBranch(taskId);
  const base = await defaultBranch(top);

  if (existsSync(worktree)) {
    // Reuse it only if it is this repo's worktree on the task branch (two repos can share a
    // basename).
    const [current, common, own] = await Promise.all([
      git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => ''),
      gitCommonDir(worktree).catch(() => ''),
      gitCommonDir(top),
    ]);
    if (current === branch && common === own) {
      return { path: worktree, branch, defaultBranch: base, created: false };
    }
    throw new Error(`${worktree} exists and is not this repo's worktree of ${branch}`);
  }

  await mkdir(path.dirname(worktree), { recursive: true, mode: 0o700 });
  // Drop stale metadata of a worktree directory removed by hand, so `add` does not refuse.
  await git(top, ['worktree', 'prune']);
  if (await gitOk(top, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])) {
    await git(top, ['worktree', 'add', worktree, branch]);
  } else {
    const local = await gitOk(top, ['rev-parse', '--verify', '--quiet', `refs/heads/${base}`]);
    await git(top, ['worktree', 'add', '-b', branch, worktree, local ? base : `origin/${base}`]);
  }
  return { path: worktree, branch, defaultBranch: base, created: true };
}

/**
 * Removes a task's chef worktree and its `orderup/<taskId>` branch, once its card is approved
 * or sent back. Missing pieces are fine: removing twice is a no-op.
 */
export async function removeChefWorktree(options: {
  repoPath: string;
  taskId: string;
  orderupDir?: string;
}): Promise<void> {
  const { repoPath, taskId } = options;
  if (!isValidTaskId(taskId)) throw new Error(`invalid task id: ${JSON.stringify(taskId)}`);
  const top = await git(repoPath, ['rev-parse', '--show-toplevel']);
  const worktree = chefWorktreePath(top, taskId, options.orderupDir);
  if (existsSync(worktree)) {
    if (!(await gitOk(top, ['worktree', 'remove', '--force', worktree]))) {
      await rm(worktree, { recursive: true, force: true });
    }
  }
  await git(top, ['worktree', 'prune']);
  const branch = taskBranch(taskId);
  if (await gitOk(top, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])) {
    await git(top, ['branch', '-D', branch]);
  }
}

/** Environment variable naming the branch the pre-push hook refuses. */
export const PROTECTED_BRANCH_ENV = 'ORDERUP_PROTECTED_BRANCH';

/**
 * The pre-push hook. git passes `<local ref> <local sha> <remote ref> <remote sha>` lines on
 * stdin; any push (or deletion) of the protected branch, or of the remote's own HEAD branch,
 * is refused. With neither known it refuses `main` and `master`.
 */
export const PRE_PUSH_HOOK = `#!/bin/sh
# Managed by OrderUp: the crew's push guard (ADR-015, ADR-016). The head chef and its stations
# get this directory as core.hooksPath through their environment only; your own pushes never
# run it.
remote="$1"
protected="\${${PROTECTED_BRANCH_ENV}:-}"
remote_head=$(git symbolic-ref --quiet --short "refs/remotes/$remote/HEAD" 2>/dev/null)
remote_head="\${remote_head#"$remote"/}"
if [ -z "$protected" ] && [ -z "$remote_head" ]; then
  protected=main
  remote_head=master
fi
status=0
while read -r local_ref local_sha remote_ref remote_sha; do
  for branch in "$protected" "$remote_head"; do
    if [ -n "$branch" ] && [ "$remote_ref" = "refs/heads/$branch" ]; then
      echo "OrderUp: the crew never pushes to $branch. Push the task branch and open a PR." >&2
      status=1
    fi
  done
done
exit $status
`;

/** Writes the pre-push hook into OrderUp's hooks dir (atomically) and returns the dir. */
export async function installPushGuard(orderupDir: string = defaultOrderupDir()): Promise<string> {
  const dir = hooksDir(orderupDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'pre-push');
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, PRE_PUSH_HOOK, { mode: 0o755 });
  await chmod(tmp, 0o755);
  await rename(tmp, file);
  return dir;
}
