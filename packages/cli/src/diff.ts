export interface DiffLine {
  op: ' ' | '+' | '-';
  text: string;
}

/** Line diff by longest common subsequence. Settings files are small; O(n·m) is fine. */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = splitLines(before);
  const b = splitLines(after);
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = length of the LCS of a[i..] and b[j..]
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i]![j] =
        a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push({ op: ' ', text: a[i++]! });
      j++;
    } else if (i < n && (j === m || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      out.push({ op: '-', text: a[i++]! });
    } else {
      out.push({ op: '+', text: b[j++]! });
    }
  }
  return out;
}

function splitLines(text: string): string[] {
  if (text === '') return [];
  return text.replace(/\n$/, '').split('\n');
}

const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

/** Unified-style diff with `context` unchanged lines around each change. Empty if equal. */
export function formatDiff(
  before: string,
  after: string,
  { context = 3, color = false }: { context?: number; color?: boolean } = {},
): string {
  const lines = diffLines(before, after);
  const changedAt = lines.flatMap((line, index) => (line.op === ' ' ? [] : [index]));
  if (changedAt.length === 0) return '';
  const near = (index: number) => changedAt.some((k) => Math.abs(k - index) <= context);
  const paint = (code: string, text: string) => (color ? `${code}${text}${RESET}` : text);
  const out: string[] = [];
  let skipped = false;
  lines.forEach((line, index) => {
    if (!near(index)) {
      skipped = true;
      return;
    }
    if (skipped) out.push(paint(DIM, '  …'));
    skipped = false;
    const text = `${line.op} ${line.text}`;
    out.push(line.op === '+' ? paint(GREEN, text) : line.op === '-' ? paint(RED, text) : text);
  });
  if (skipped) out.push(paint(DIM, '  …'));
  return `${out.join('\n')}\n`;
}
