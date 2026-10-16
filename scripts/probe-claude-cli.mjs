// Probes the real claude CLI for the crew runner (#19, ADR-016 Follow-ups). Runs `claude -p`
// with the head chef's arguments in a throwaway git repo under the temp dir and prints what it
// observed per case. Uses your logged-in CLI: on a subscription it spends usage, with an API key
// it spends money. Cases run on haiku, except two settings-merge runs on your default model
// (they test that your model setting survives --settings): about $0.55 API-equivalent in all
// when the default model is Opus, most of it those two runs.
//
// Usage: npm run build && node scripts/probe-claude-cli.mjs [case ...]
// Cases: agents (a, b), worktree-branch (c), settings-merge (d), append-system-prompt (e),
// budget (f), flags (g), station-policy (h). No case runs them all. Every stream-json line goes to
// scripts/.probe-out/<run>.jsonl (gitignored); the summary goes to stdout and summary.json.
//
// It never runs inside this checkout or in HOME, and never writes ~/.claude/settings.json.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MIN_VERSION = '2.1.217';
const RUN_TIMEOUT_MS = 5 * 60_000;
const PROBE_TURNS = '6';

const root = path.resolve(import.meta.dirname, '..');
const outDir = path.join(import.meta.dirname, '.probe-out');
const serverDist = path.join(root, 'packages', 'server', 'dist', 'index.js');

function fail(message) {
  console.error(`probe: ${message}`);
  process.exit(1);
}

// --- version ---------------------------------------------------------------------------------

function cmpVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

const versionRun = spawnSync('claude', ['--version'], { encoding: 'utf8' });
if (versionRun.error || versionRun.status !== 0)
  fail('`claude --version` failed: is claude on PATH?');
const version = /(\d+\.\d+\.\d+)/.exec(versionRun.stdout)?.[1];
if (!version) fail(`cannot read a version from \`claude --version\`: ${versionRun.stdout.trim()}`);
if (cmpVersion(version, MIN_VERSION) < 0) fail(`claude ${version} is below ${MIN_VERSION}`);

if (!existsSync(serverDist)) fail('packages/server is not built: run `npm run build` first');
const { agentsJson, buildChefArgs } = await import(pathToFileURL(serverDist).href);
const STATION_NAMES = Object.keys(JSON.parse(agentsJson()));

// --- throwaway repo --------------------------------------------------------------------------

const tmp = realpathSync(os.tmpdir());
const home = realpathSync(os.homedir());

function git(cwd, ...args) {
  const run = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd,
    encoding: 'utf8',
  });
  if (run.status !== 0) fail(`git ${args.join(' ')}: ${run.stderr.trim()}`);
  return run.stdout.trim();
}

/** A fresh repo with one commit on main, then a task branch with one more (the chef's HEAD). */
function makeRepo(label) {
  const dir = realpathSync(mkdtempSync(path.join(tmp, `orderup-probe-${label}-`)));
  // Checked before anything runs in it: never this checkout, never HOME itself.
  const inside = (parent) => dir === parent || dir.startsWith(parent + path.sep);
  if (!inside(tmp) || inside(root) || dir === home) fail(`refusing to use ${dir}`);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'OrderUp probe');
  git(dir, 'config', 'user.email', 'probe@orderup.invalid');
  writeFileSync(
    path.join(dir, 'README.md'),
    '# probe\n\nA throwaway repo for the OrderUp probe.\n',
  );
  writeFileSync(path.join(dir, 'kitchen.txt'), 'stations: hot, commis\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'chore: initial commit');
  const mainHead = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', '-b', 'orderup/task-probe');
  writeFileSync(path.join(dir, 'task.txt'), 'task branch marker\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'chore: task branch commit');
  return { dir, mainHead, taskHead: git(dir, 'rev-parse', 'HEAD') };
}

const repos = [];
function repo(label) {
  const made = makeRepo(label);
  repos.push(made.dir);
  return made;
}

// --- running claude --------------------------------------------------------------------------

const chefEnv = {
  ...process.env,
  CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: '8',
  CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: '1',
};

/** buildChefArgs (with agentsJson as --agents) plus the probe's model and turn cap. */
function chefArgs(options = {}) {
  const args = buildChefArgs({ model: 'haiku', ...options });
  const turns = args.indexOf('--max-turns');
  if (turns >= 0) args[turns + 1] = PROBE_TURNS;
  else args.push('--max-turns', PROBE_TURNS);
  return args;
}

function withoutFlag(args, flag, hasValue = true) {
  const i = args.indexOf(flag);
  if (i < 0) return [...args];
  return [...args.slice(0, i), ...args.slice(i + (hasValue ? 2 : 1))];
}

/** Runs claude -p with the prompt on stdin, saving every stdout line to <name>.jsonl. */
function runClaude(name, { args, prompt, cwd }) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn('claude', args, { cwd, env: chefEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.stdin.on('error', () => undefined);
    child.stdin.end(prompt);
    const timer = setTimeout(() => child.kill('SIGKILL'), RUN_TIMEOUT_MS);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      writeFileSync(path.join(outDir, `${name}.jsonl`), stdout);
      const lines = [];
      for (const line of stdout.split('\n')) {
        try {
          const msg = JSON.parse(line);
          if (msg && typeof msg === 'object') lines.push(msg);
        } catch {
          // Not JSON (text output, or a partial line): kept in the file only.
        }
      }
      resolve({
        lines,
        exitCode: code,
        signal,
        // The CLI's own error message: only its first line, and only used by some cases.
        stderrFirstLine: stderr.trim().split('\n')[0] ?? '',
        nonJsonStdout: stdout.trim().length > 0 && lines.length === 0,
        seconds: Math.round((Date.now() - started) / 1000),
      });
    });
  });
}

// --- stream helpers --------------------------------------------------------------------------

const AGENT_TOOLS = new Set(['Agent', 'Task']);
const initOf = (run) => run.lines.find((m) => m.type === 'system' && m.subtype === 'init');
const resultOf = (run) => run.lines.findLast((m) => m.type === 'result');
const blocks = (m) => (Array.isArray(m.message?.content) ? m.message.content : []);

function countBy(items, key) {
  const counts = {};
  for (const item of items) counts[key(item) ?? '?'] = (counts[key(item) ?? '?'] ?? 0) + 1;
  return counts;
}
const systemSubtypes = (run) =>
  countBy(
    run.lines.filter((m) => m.type === 'system'),
    (m) => m.subtype,
  );
const messageTypes = (run) => countBy(run.lines, (m) => m.type);

function toolResultText(block) {
  if (!block) return '';
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) {
    return block.content.map((c) => (typeof c.text === 'string' ? c.text : '')).join('\n');
  }
  return '';
}

/** Scalar fields of a structured tool result (no `content` or `prompt` text). */
function pick(obj) {
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'content' || key === 'prompt') continue;
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) out[key] = value;
    else out[key] = Array.isArray(value) ? `[array ${value.length}]` : '[object]';
  }
  return out;
}

/** The Agent/Task calls in the stream, with their result line. Never the `prompt` input. */
function agentCalls(run) {
  const calls = [];
  for (const m of run.lines) {
    if (m.type !== 'assistant') continue;
    for (const b of blocks(m)) {
      if (b.type !== 'tool_use' || !AGENT_TOOLS.has(b.name)) continue;
      const resultLine = run.lines.find(
        (r) =>
          r.type === 'user' &&
          blocks(r).some((rb) => rb.type === 'tool_result' && rb.tool_use_id === b.id),
      );
      const resultBlock = resultLine
        ? blocks(resultLine).find((rb) => rb.tool_use_id === b.id)
        : undefined;
      const structured = resultLine?.tool_use_result;
      const isStructured = structured && typeof structured === 'object';
      calls.push({
        tool: b.name,
        parentToolUseId: m.parent_tool_use_id ?? null,
        inputKeys: Object.keys(b.input ?? {}).sort(),
        subagentType: b.input?.subagent_type ?? null,
        result: resultLine
          ? {
              isError: resultBlock?.is_error === true,
              toolUseResultKeys: isStructured ? Object.keys(structured).sort() : null,
              toolUseResult: isStructured ? pick(structured) : null,
              text: toolResultText(resultBlock),
            }
          : null,
        subagentLines: run.lines.filter((x) => x.parent_tool_use_id === b.id).length,
      });
    }
  }
  return calls;
}

const ZERO = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
function addUsage(sum, usage = {}) {
  sum.input += usage.input_tokens ?? 0;
  sum.output += usage.output_tokens ?? 0;
  sum.cacheRead += usage.cache_read_input_tokens ?? 0;
  sum.cacheWrite += usage.cache_creation_input_tokens ?? 0;
}

/** Per-message usage, deduped by message id, split chef / subagents and by model. */
function usageSums(run) {
  const seen = new Set();
  const chef = ZERO();
  const subagents = ZERO();
  const byModel = {};
  run.lines.forEach((m, i) => {
    if (m.type !== 'assistant' || !m.message?.usage) return;
    const id = m.message.id ?? `line-${i}`;
    if (seen.has(id)) return;
    seen.add(id);
    addUsage(m.parent_tool_use_id ? subagents : chef, m.message.usage);
    const model = m.message.model ?? '?';
    byModel[model] ??= ZERO();
    addUsage(byModel[model], m.message.usage);
  });
  return { chef, subagents, byModel, messages: seen.size };
}

function resultSummary(result) {
  if (!result) return null;
  const modelUsage = {};
  for (const [model, u] of Object.entries(result.modelUsage ?? {})) {
    modelUsage[model] = {
      input: u.inputTokens,
      output: u.outputTokens,
      cacheRead: u.cacheReadInputTokens,
      cacheWrite: u.cacheCreationInputTokens,
      costUSD: u.costUSD,
    };
  }
  return {
    subtype: result.subtype,
    is_error: result.is_error,
    num_turns: result.num_turns,
    total_cost_usd: result.total_cost_usd,
    usage: {
      input: result.usage?.input_tokens,
      output: result.usage?.output_tokens,
      cacheRead: result.usage?.cache_read_input_tokens,
      cacheWrite: result.usage?.cache_creation_input_tokens,
    },
    modelUsage,
    permission_denials: (result.permission_denials ?? []).map((d) => d.tool_name),
    errors: result.errors,
    resultKeys: Object.keys(result).sort(),
  };
}

const tail = (text, n = 60) => (typeof text === 'string' ? text.trim().slice(-n) : null);

// --- cases -----------------------------------------------------------------------------------

/** a + b: one dispatch to orderup-commis; --agents, subagent_type, agentId and the cost. */
async function caseAgents() {
  const { dir } = repo('agents');
  const run = await runClaude('agents', {
    cwd: dir,
    args: chefArgs(),
    prompt:
      'Use the Agent tool exactly once with subagent_type "orderup-commis" and ask it: ' +
      '"Read kitchen.txt and reply with its first line." Do not read the file yourself. ' +
      'Then reply with what the commis said, in one line.',
  });
  const init = initOf(run);
  const result = resultOf(run);
  return {
    exitCode: run.exitCode,
    seconds: run.seconds,
    messageTypes: messageTypes(run),
    systemSubtypes: systemSubtypes(run),
    initOrderupAgents: init?.agents?.filter((a) => a.startsWith('orderup-')) ?? null,
    stationsMissingFromInit: STATION_NAMES.filter((n) => !(init?.agents ?? []).includes(n)),
    initModel: init?.model ?? null,
    agentCalls: agentCalls(run).map(({ result: r, ...call }) => ({
      ...call,
      result: r && {
        ...r,
        text: undefined,
        agentIdInText: /agentId:\s*([\w-]+)/.exec(r.text)?.[1] ?? null,
      },
    })),
    cost: {
      result: resultSummary(result),
      perMessageUsage: usageSums(run),
      sumModelUsageCostUSD: Object.values(result?.modelUsage ?? {}).reduce(
        (s, u) => s + (u.costUSD ?? 0),
        0,
      ),
    },
  };
}

/** c: orderup-hot creates one file; where do the worktree path and branch show up? */
async function caseWorktree(name, extraArgs) {
  const made = repo(name);
  const run = await runClaude(name, {
    cwd: made.dir,
    args: [...chefArgs(), ...extraArgs],
    prompt:
      'Use the Agent tool exactly once with subagent_type "orderup-hot" and ask it: ' +
      '"Create a file named probe.txt containing the single line: plated. Commit it with the ' +
      'message chore: add probe file. Then report your branch." Do not edit files yourself. ' +
      'Then reply with the station report in one line.',
  });
  const worktrees = git(made.dir, 'worktree', 'list', '--porcelain')
    .split('\n\n')
    .map((entry) => ({
      path: /^worktree (.+)$/m.exec(entry)?.[1] ?? null,
      branch: /^branch refs\/heads\/(.+)$/m.exec(entry)?.[1] ?? null,
    }))
    .filter((w) => w.path && w.path !== made.dir);
  const branches = git(made.dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')
    .split('\n')
    .filter((b) => b && b !== 'main' && b !== 'orderup/task-probe');
  const isAncestor = (rev, of) =>
    spawnSync('git', ['merge-base', '--is-ancestor', rev, of], { cwd: made.dir }).status === 0;
  const mentions = (text) => ({
    worktreePath: /\.claude\/worktrees\/[\w./-]+/.test(text),
    worktreeBranchName: branches.some((b) => text.includes(b)),
    branchLine: /Branch:\s*`?[\w./-]+/.test(text),
  });
  const result = resultOf(run);
  return {
    exitCode: run.exitCode,
    seconds: run.seconds,
    extraArgs,
    systemSubtypes: systemSubtypes(run),
    systemLinesMentioningWorktree: run.lines
      .filter((m) => m.type === 'system' && JSON.stringify(m).includes('worktree'))
      .map((m) => ({ subtype: m.subtype, keys: Object.keys(m).sort() })),
    agentCalls: agentCalls(run).map(({ result: r, ...call }) => ({
      ...call,
      result: r && { ...r, text: undefined, textMentions: mentions(r.text) },
    })),
    stationToolUses: run.lines
      .filter((m) => m.type === 'assistant' && m.parent_tool_use_id)
      .flatMap((m) =>
        blocks(m)
          .filter((b) => b.type === 'tool_use')
          .map((b) => b.name),
      ),
    worktrees: worktrees.map((w) => ({
      path: path.relative(made.dir, w.path),
      branch: w.branch,
    })),
    stationBranches: branches.map((branch) => ({
      branch,
      containsTaskHead: isAncestor(made.taskHead, branch),
      containsMainHead: isAncestor(made.mainHead, branch),
      commitsAboveTaskHead: Number(
        git(made.dir, 'rev-list', '--count', `${made.taskHead}..${branch}`),
      ),
      commitsAboveMainOnly: Number(
        git(made.dir, 'rev-list', '--count', `${made.mainHead}..${branch}`, `^${made.taskHead}`),
      ),
    })),
    result: resultSummary(result),
    finalTextMentions: mentions(result?.result ?? ''),
  };
}

/**
 * d: --settings must merge with the other settings sources. Compares the init line with and
 * without --settings (your user settings: model, permission mode, tools, hooks; values are not
 * printed), then checks a project-local layer the probe controls (a model and a deny rule).
 */
async function caseSettings() {
  const { dir } = repo('settings');
  // No --model: the model comes from the settings sources.
  const base = withoutFlag(chefArgs(), '--model');
  const quiet = 'Reply with the single word OK. Do not use any tool.';
  const fingerprint = (run) => {
    const init = initOf(run);
    return {
      exitCode: run.exitCode,
      model: init?.model ?? null,
      permissionMode: init?.permissionMode ?? null,
      tools: init?.tools?.length ?? null,
      mcpServers: init?.mcp_servers?.length ?? null,
      agents: init?.agents?.length ?? null,
      slashCommands: init?.slash_commands?.length ?? null,
      hookLines: run.lines.filter((m) => m.type === 'system' && /^hook/.test(m.subtype ?? ''))
        .length,
    };
  };
  const without = fingerprint(
    await runClaude('settings-merge-baseline', {
      cwd: dir,
      args: withoutFlag(base, '--settings'),
      prompt: quiet,
    }),
  );
  const withFlag = fingerprint(
    await runClaude('settings-merge', { cwd: dir, args: base, prompt: quiet }),
  );
  const same = Object.fromEntries(Object.keys(without).map((k) => [k, without[k] === withFlag[k]]));

  // A layer the probe controls: project-local settings in the throwaway repo only.
  const local = repo('settings-local');
  mkdirSync(path.join(local.dir, '.claude'));
  writeFileSync(
    path.join(local.dir, '.claude', 'settings.local.json'),
    JSON.stringify({ model: 'haiku', permissions: { deny: ['Read(./kitchen.txt)'] } }),
  );
  const layered = await runClaude('settings-merge-local', {
    cwd: local.dir,
    args: base,
    prompt: 'Use the Read tool on kitchen.txt, then reply with its first line or the error.',
  });
  const denials = (resultOf(layered)?.permission_denials ?? []).map((d) => d.tool_name);
  return {
    userLayer: {
      // The model and permission mode are compared, not printed.
      sameWithAndWithoutSettingsFlag: same,
      withSettingsFlag: { ...withFlag, model: undefined, permissionMode: undefined },
    },
    localLayer: {
      exitCode: layered.exitCode,
      initModelIsHaiku: /haiku/i.test(initOf(layered)?.model ?? ''),
      denyRuleApplied: denials.includes('Read'),
      permission_denials: denials,
    },
  };
}

/** e: --append-system-prompt with -p, --agents and --resume. */
async function caseAppend() {
  const { dir } = repo('append');
  const append = ['--append-system-prompt', 'Always end with the word PLATE.'];
  const first = await runClaude('append-system-prompt', {
    cwd: dir,
    args: [...chefArgs(), ...append],
    prompt: 'Name one kitchen station in one short sentence. Do not use any tool.',
  });
  const firstResult = resultOf(first);
  const sessionId = firstResult?.session_id ?? initOf(first)?.session_id;
  const resumed = sessionId
    ? await runClaude('append-system-prompt-resume', {
        cwd: dir,
        args: [...chefArgs({ resumeSessionId: sessionId }), ...append],
        prompt: 'Name another one in one short sentence. Do not use any tool.',
      })
    : null;
  const resumedResult = resumed && resultOf(resumed);
  const endsWithPlate = (r) => /PLATE[.!]?\W*$/.test(r?.result ?? '');
  return {
    first: {
      exitCode: first.exitCode,
      initOrderupAgents: initOf(first)?.agents?.filter((a) => a.startsWith('orderup-')) ?? null,
      subtype: firstResult?.subtype ?? null,
      endsWithPlate: endsWithPlate(firstResult),
      resultTail: tail(firstResult?.result, 40),
    },
    resumed: resumed && {
      exitCode: resumed.exitCode,
      sameSession: resumedResult?.session_id === sessionId,
      subtype: resumedResult?.subtype ?? null,
      endsWithPlate: endsWithPlate(resumedResult),
      resultTail: tail(resumedResult?.result, 40),
    },
  };
}

/** f: --max-budget-usd on a cheap run, then a cap the run will cross. */
async function caseBudget() {
  const { dir } = repo('budget');
  const arg = (args) => args[args.indexOf('--max-budget-usd') + 1];
  const describe = (run, maxBudgetArg) => {
    const result = resultOf(run);
    return {
      maxBudgetArg,
      exitCode: run.exitCode,
      seconds: run.seconds,
      result: resultSummary(result),
      resultTail: tail(result?.result, 80),
      linesAfterResult: result ? run.lines.length - 1 - run.lines.lastIndexOf(result) : null,
      stderrFirstLine: run.stderrFirstLine.slice(0, 160),
    };
  };
  const cheapArgs = chefArgs({ maxBudgetUsd: 0.05 });
  const cheap = await runClaude('budget-0.05', {
    cwd: dir,
    args: cheapArgs,
    prompt: 'Reply with the single word OK. Do not use any tool.',
  });
  const tightArgs = chefArgs({ maxBudgetUsd: 0.01 });
  const tight = await runClaude('budget-0.01', {
    cwd: dir,
    args: tightArgs,
    // More than a cent of work: a dispatch, then a long answer, then a second dispatch.
    prompt:
      'Use the Agent tool with subagent_type "orderup-commis" to read README.md and summarise ' +
      'it. Then write a 1500-word history of the kitchen brigade system. Then use the Agent ' +
      'tool again with subagent_type "orderup-commis" to read kitchen.txt. Do not stop early.',
  });
  return { cheap: describe(cheap, arg(cheapArgs)), tight: describe(tight, arg(tightArgs)) };
}

/** g: does stream-json still need --verbose in print mode? */
async function caseFlags() {
  const { dir } = repo('flags');
  const run = await runClaude('flags-no-verbose', {
    cwd: dir,
    args: withoutFlag(chefArgs(), '--verbose', false),
    prompt: 'Reply with the single word OK. Do not use any tool.',
  });
  return {
    exitCode: run.exitCode,
    jsonLines: run.lines.length,
    nonJsonStdout: run.nonJsonStdout,
    messageTypes: messageTypes(run),
    stderrFirstLine: run.stderrFirstLine.slice(0, 200),
  };
}

/**
 * h: the station permission policy of buildChefArgs as-is: `permissionMode: acceptEdits` and
 * `disallowedTools` in --agents, `permissions.allow` in --settings. A writing station creates
 * and commits a file, then tries to push to a local bare remote. Also records the shapes of
 * the system lines the runner reads (permission_denied, vcs_state_changed, task_started,
 * task_notification), without any `prompt` field.
 */
async function caseStationPolicy(name, transformAgents = (agents) => agents) {
  const made = repo(name);
  const remote = realpathSync(mkdtempSync(path.join(tmp, 'orderup-probe-remote-')));
  repos.push(remote);
  git(remote, 'init', '-q', '--bare');
  git(made.dir, 'remote', 'add', 'origin', remote);
  const args = chefArgs();
  const agentsAt = args.indexOf('--agents') + 1;
  args[agentsAt] = JSON.stringify(transformAgents(JSON.parse(args[agentsAt])));
  const run = await runClaude(name, {
    cwd: made.dir,
    args,
    prompt:
      'Use the Agent tool exactly once with subagent_type "orderup-hot" and ask it: ' +
      '"Create a file named probe.txt containing the single line: plated. Commit it with the ' +
      'message chore: add probe file. Run git status. Then run git push origin HEAD and say ' +
      'whether it worked." Do not edit files or run commands yourself. Wait for the station, ' +
      'then reply with its report in one line.',
  });
  const systemOf = (subtype) =>
    run.lines.filter((m) => m.type === 'system' && m.subtype === subtype).map(pick);
  const branches = git(made.dir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')
    .split('\n')
    .filter((b) => b && b !== 'main' && b !== 'orderup/task-probe');
  const stationTools = run.lines
    .filter((m) => m.type === 'assistant' && m.parent_tool_use_id)
    .flatMap((m) =>
      blocks(m)
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          name: b.name,
          // The command is the probe's own instruction, not user text.
          command: typeof b.input?.command === 'string' ? b.input.command.slice(0, 80) : null,
        })),
    );
  // Errors of the station's own tool calls (the probe repo's git output, no user text).
  const stationToolErrors = run.lines
    .filter((m) => m.type === 'user' && m.parent_tool_use_id)
    .flatMap((m) => blocks(m).filter((b) => b.type === 'tool_result' && b.is_error === true))
    .map((b) => toolResultText(b).slice(0, 160));
  return {
    exitCode: run.exitCode,
    seconds: run.seconds,
    stationDefinition: pick(JSON.parse(args[agentsAt])['orderup-hot']),
    initAgents: initOf(run)?.agents?.filter((a) => a.startsWith('orderup-')),
    initPermissionMode: initOf(run)?.permissionMode,
    systemSubtypes: systemSubtypes(run),
    permissionDenied: systemOf('permission_denied'),
    vcsStateChanged: systemOf('vcs_state_changed'),
    taskStarted: systemOf('task_started'),
    taskNotification: systemOf('task_notification'),
    stationTools,
    stationToolErrors,
    agentCalls: agentCalls(run).map(({ result: r, ...call }) => ({
      ...call,
      result: r && { ...r, text: undefined },
    })),
    stationBranches: branches.map((branch) => ({
      branch,
      commitsAboveTaskHead: Number(
        git(made.dir, 'rev-list', '--count', `${made.taskHead}..${branch}`),
      ),
      hasProbeFile:
        spawnSync('git', ['cat-file', '-e', `${branch}:probe.txt`], { cwd: made.dir }).status === 0,
    })),
    remoteBranches: git(remote, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')
      .split('\n')
      .filter(Boolean),
    results: run.lines.filter((m) => m.type === 'result').map(resultSummary),
  };
}

// --- main ------------------------------------------------------------------------------------

const CASES = {
  agents: caseAgents,
  'worktree-branch': async () => ({
    asIs: await caseWorktree('worktree-branch', []),
    // The same dispatch with edits and a few git commands allowed, in case -p denies them.
    allowed: await caseWorktree('worktree-branch-allowed', [
      '--permission-mode',
      'acceptEdits',
      '--allowedTools',
      'Bash(git add:*)',
      'Bash(git commit:*)',
      'Bash(git branch:*)',
      'Bash(git status:*)',
      'Bash(git rev-parse:*)',
    ]),
  }),
  'settings-merge': caseSettings,
  'append-system-prompt': caseAppend,
  budget: caseBudget,
  flags: caseFlags,
  'station-policy': async () => ({
    asIs: await caseStationPolicy('station-policy'),
    // The same without disallowedTools, to tell its effect from the allow rules'.
    withoutDisallowed: await caseStationPolicy('station-policy-no-disallowed', (agents) =>
      Object.fromEntries(
        Object.entries(agents).map(([key, { disallowedTools: _d, ...def }]) => [key, def]),
      ),
    ),
  }),
};

const wanted = process.argv.slice(2);
for (const name of wanted) if (!(name in CASES)) fail(`unknown case ${name}`);
const selected = wanted.length > 0 ? wanted : Object.keys(CASES);

mkdirSync(outDir, { recursive: true });
console.error(`probe: claude ${version}, cases: ${selected.join(', ')}`);
const summary = { claudeVersion: version, at: new Date().toISOString(), cases: {} };
try {
  for (const name of selected) {
    console.error(`probe: running ${name}…`);
    summary.cases[name] = await CASES[name]();
  }
} finally {
  if (process.env.ORDERUP_PROBE_KEEP) console.error(`probe: kept ${repos.join(', ')}`);
  else for (const dir of repos) rmSync(dir, { recursive: true, force: true });
}
writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
