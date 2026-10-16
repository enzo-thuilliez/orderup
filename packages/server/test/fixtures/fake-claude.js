#!/usr/bin/env node
// A fake `claude` CLI for the crew runner tests. It reads the prompt from stdin, the way the
// runner sends it, and picks a scenario from it ("scenario:<name>"). It replays recorded
// stream-json lines on stdout, and writes what it was given (args, cwd, the env it cares
// about, its pid) as JSON to $FAKE_CLAUDE_LOG, one file per run. Executable, with a shebang: the runner spawns it as the `claude` binary.
import { spawn } from 'node:child_process';
import { renameSync, writeFileSync } from 'node:fs';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const prompt = Buffer.concat(chunks).toString('utf8');
// "scenario-<name>" too, so a valid ticket repo (o/scenario-slow) can pick one.
const scenario = /scenario[:-]([a-z-]+)/.exec(prompt)?.[1] ?? 'ok';
const session = process.argv.includes('--resume')
  ? process.argv[process.argv.indexOf('--resume') + 1]
  : `sess-${process.pid}`;

const ENV_KEYS = [
  'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS',
  'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_KEY_0',
  'GIT_CONFIG_VALUE_0',
  'ORDERUP_PROTECTED_BRANCH',
];

const log = {
  args: process.argv.slice(2),
  cwd: process.cwd(),
  env: Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key] ?? null])),
  pid: process.pid,
  prompt,
  grandchild: null,
};

function save() {
  if (process.env.FAKE_CLAUDE_LOG) {
    // Atomic: tests poll this file while the fake runs, and must never read half of it.
    const file = `${process.env.FAKE_CLAUDE_LOG}/${process.pid}.json`;
    writeFileSync(`${file}.tmp`, JSON.stringify(log));
    renameSync(`${file}.tmp`, file);
  }
}

const out = (value) =>
  process.stdout.write((typeof value === 'string' ? value : JSON.stringify(value)) + '\n');

const init = { type: 'system', subtype: 'init', session_id: session, model: 'fake' };
const usage = (input, output) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: 3,
  cache_creation_input_tokens: 4,
});
const result = (cost, extra = {}) => ({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'Done.\n```json\n{"schema":1}\n```',
  session_id: session,
  total_cost_usd: cost,
  num_turns: 2,
  usage: usage(100, 50),
  ...extra,
});
const hang = () => setInterval(() => undefined, 1000);

save();
out(init);

switch (scenario) {
  case 'ok': {
    // Recorded shapes, with malformed and unknown lines mixed in.
    out('not json at all');
    out('{"type":"assistant","message":');
    out('[1,2,3]');
    out('null');
    out({ type: 'mystery', foo: 1 });
    out({ type: 'assistant', message: { content: 'not an array' } });
    out({
      type: 'assistant',
      parent_tool_use_id: null,
      session_id: session,
      message: { content: [{ type: 'text', text: 'Splitting the task.' }] },
    });
    out({
      type: 'assistant',
      parent_tool_use_id: null,
      session_id: session,
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_agent_1',
            name: 'Agent',
            input: {
              subagent_type: 'orderup-hot',
              description: 'Add the endpoint',
              prompt: 'SECRET PROMPT TEXT',
            },
          },
        ],
      },
    });
    out({
      type: 'assistant',
      parent_tool_use_id: 'toolu_agent_1',
      session_id: session,
      message: {
        content: [
          { type: 'tool_use', id: 'toolu_edit_1', name: 'Edit', input: { file_path: 'a.ts' } },
        ],
      },
    });
    out({
      type: 'user',
      parent_tool_use_id: null,
      session_id: session,
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_agent_1', content: 'ok' }] },
      tool_use_result: { agentId: 'agent-abc', status: 'completed' },
    });
    out({ type: 'stream_event', event: { delta: { type: 'text_delta', text: 'All ' } } });
    out(result(0.25));
    process.exit(0);
    break;
  }
  case 'error': {
    out({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      result: '',
      session_id: session,
      total_cost_usd: 0.1,
      usage: usage(10, 0),
    });
    process.exit(1);
    break;
  }
  case 'slow': {
    // A long run that also started a process of its own, like a Bash tool call would.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    log.grandchild = child.pid;
    save();
    out({
      type: 'assistant',
      parent_tool_use_id: null,
      message: { content: [{ type: 'text', text: 'Working on it.' }] },
    });
    hang();
    break;
  }
  case 'expensive': {
    // A turn that reports more than the daily cap, then keeps the process open (background
    // work), so only the runner's kill ends it.
    out(result(10));
    hang();
    break;
  }
  case 'resumed': {
    // A resumed session reports the conversation's whole total.
    out(result(1.75));
    process.exit(0);
    break;
  }
  case 'background': {
    // Probe case a and h (2.1.301): a background station. The Agent result comes back at
    // once, the chef's turn ends with a first result, then the station's lines and a second
    // turn in the same process. Costs and modelUsage are cumulative for the process.
    const modelUsage = (output) => ({
      'claude-haiku-5-5': {
        inputTokens: 10,
        outputTokens: output,
        cacheReadInputTokens: 300,
        cacheCreationInputTokens: 400,
        costUSD: 0.3,
      },
    });
    out({
      type: 'assistant',
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_bg',
            name: 'Agent',
            input: {
              subagent_type: 'orderup-hot',
              description: 'Add probe file',
              prompt: 'SECRET DISPATCH',
            },
          },
        ],
      },
    });
    out({
      type: 'system',
      subtype: 'task_started',
      task_id: 'a7b6',
      tool_use_id: 'toolu_bg',
      subagent_type: 'orderup-hot',
      description: 'Add probe file',
      prompt: 'SECRET TASK PROMPT',
      is_backgrounded: true,
    });
    out({
      type: 'user',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_bg', content: 'launched' }] },
      tool_use_result: { status: 'async_launched', agentId: 'a7b6', prompt: 'SECRET DISPATCH' },
    });
    out(
      result(0.1, {
        result: 'Dispatched.',
        result_index: 0,
        usage: usage(5, 5),
        modelUsage: modelUsage(50),
      }),
    );
    out({
      type: 'assistant',
      parent_tool_use_id: 'toolu_bg',
      message: {
        content: [
          {
            type: 'tool_use',
            id: 'toolu_w',
            name: 'Write',
            input: { file_path: `${process.cwd()}/probe.txt` },
          },
        ],
      },
    });
    out({
      type: 'system',
      subtype: 'permission_denied',
      tool_name: 'Bash',
      tool_use_id: 'toolu_b',
      parent_tool_use_id: 'toolu_bg',
      decision_reason_type: 'asyncAgent',
    });
    out({
      type: 'system',
      subtype: 'vcs_state_changed',
      kind: 'commit',
      branch: 'worktree-agent-a7b6',
      cwd: `${process.cwd()}/.claude/worktrees/agent-a7b6`,
    });
    out({
      type: 'system',
      subtype: 'task_notification',
      task_id: 'a7b6',
      tool_use_id: 'toolu_bg',
      status: 'completed',
      summary: 'SECRET STATION SUMMARY',
    });
    out(init);
    out(result(0.3, { result_index: 1, usage: usage(5, 5), modelUsage: modelUsage(70) }));
    if (/hold/.test(prompt)) hang();
    else process.exit(0);
    break;
  }
  case 'budget': {
    // Probe case f: the CLI stops on --max-budget-usd between turns, after a first result.
    out(result(0.05));
    out({
      type: 'result',
      subtype: 'error_max_budget_usd',
      is_error: true,
      session_id: session,
      total_cost_usd: 0.12,
      terminal_reason: 'budget_exhausted',
      errors: ['Reached maximum budget ($0.10)'],
      usage: usage(1, 1),
    });
    process.exit(1);
    break;
  }
  default:
    process.exit(2);
}
