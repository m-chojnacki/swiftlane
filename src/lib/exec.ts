import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { CommandError } from './errors.ts';
import { log } from './log.ts';

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string | Buffer;
  /** Return a non-zero result instead of throwing. */
  allowFailure?: boolean;
  /** Values replaced with *** wherever the command line is displayed. */
  secrets?: (string | undefined)[];
  hint?: string;
  /** Show output live instead of capturing it, for long-running tools. */
  stream?: boolean;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (command: string, args: string[], options: RunOptions) => Promise<RunResult>;

export function displayCommand(command: string, args: string[], secrets: (string | undefined)[] = []): string {
  const quoted = args.map((arg) => {
    const out = mask(arg, secrets);
    return /^[\w@%+=:,./-]+$/.test(out) ? out : `'${out.replace(/'/g, `'\\''`)}'`;
  });
  return [command, ...quoted].join(' ');
}

const spawnRunner: Runner = (command, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', options.stream ? 'inherit' : 'pipe', options.stream ? 'inherit' : 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({
        code: code ?? (signal ? 128 : 1),
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
      });
    });
    child.stdin?.on('error', () => {});
    child.stdin?.end(options.input);
  });

let runner: Runner = spawnRunner;

/** Swaps the process runner, used by tests to avoid touching the real system. */
export function setRunner(next: Runner | undefined): void {
  runner = next ?? spawnRunner;
}

export async function run(command: string, args: string[], options: RunOptions = {}): Promise<RunResult> {
  const display = displayCommand(command, args, options.secrets);
  log.command(display);
  let result: RunResult;
  try {
    result = await runner(command, args, options);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new CommandError(display, 127, '', `${command}: command not found`, options.hint);
    }
    throw error;
  }
  if (result.code !== 0 && !options.allowFailure) {
    throw new CommandError(display, result.code, mask(result.stdout, options.secrets), mask(result.stderr, options.secrets), options.hint);
  }
  return result;
}

function mask(text: string, secrets: (string | undefined)[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret) out = out.split(secret).join('***');
  }
  return out;
}

export function which(command: string): string | undefined {
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not in this directory
    }
  }
  return undefined;
}
