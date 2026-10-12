import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { SwiftlaneError } from '../errors.ts';
import { displayCommand, which } from '../exec.ts';
import { log } from '../log.ts';

export const PRETTIFIERS = ['auto', 'xcpretty', 'xcbeautify', 'none'] as const;
export type Prettifier = (typeof PRETTIFIERS)[number];

export function resolvePrettifier(choice: Prettifier): { command: string; args: string[] } | undefined {
  const pick = choice === 'auto' ? (which('xcpretty') ? 'xcpretty' : which('xcbeautify') ? 'xcbeautify' : 'none') : choice;
  if (pick === 'none') return undefined;
  if (!which(pick)) {
    throw new SwiftlaneError(`${pick} is not installed`, { hint: `Install it or use -p auto / -p none` });
  }
  if (pick === 'xcbeautify') {
    return { command: pick, args: process.env.GITHUB_ACTIONS === 'true' ? ['--renderer', 'github-actions'] : [] };
  }
  return { command: pick, args: process.stdout.isTTY ? ['--color'] : [] };
}

/** Pulls compiler/signing errors out of the raw log, since prettifiers occasionally swallow them. */
export function extractErrors(rawLog: string, limit = 30): string[] {
  const errors = new Set<string>();
  for (const line of rawLog.split('\n')) {
    if (/(^|\s)(error|fatal error):\s|^\*\* .* FAILED \*\*|^xcodebuild: error/.test(line)) errors.add(line.trim());
    if (errors.size >= limit) break;
  }
  return [...errors];
}

export interface XcodebuildOptions {
  prettifier: Prettifier;
  /** Raw, unprettified output is always kept here. */
  logPath: string;
  secrets?: string[];
  cwd?: string;
}

export async function xcodebuild(args: string[], options: XcodebuildOptions): Promise<void> {
  const prettifier = resolvePrettifier(options.prettifier);
  mkdirSync(path.dirname(options.logPath), { recursive: true });
  const display = displayCommand('xcodebuild', args, options.secrets);
  log.info(`$ ${display}`);
  log.info(
    `Raw log: ${path.relative(process.cwd(), options.logPath) || options.logPath}${prettifier ? `, prettified with ${prettifier.command}` : ''}`,
  );

  const logFile = createWriteStream(options.logPath);
  logFile.write(`$ ${display}\n\n`);

  const child = spawn('xcodebuild', args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const formatter = prettifier
    ? spawn(prettifier.command, prettifier.args, { cwd: options.cwd, stdio: ['pipe', 'inherit', 'inherit'] })
    : undefined;
  formatter?.stdin.on('error', () => {});

  const forward = (chunk: Buffer): void => {
    logFile.write(chunk);
    if (formatter) formatter.stdin.write(chunk);
    else process.stdout.write(chunk);
  };
  child.stdout.on('data', forward);
  child.stderr.on('data', forward);

  const stop = (): void => {
    child.kill('SIGINT');
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  const code = await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (exitCode, signal) => resolve(exitCode ?? (signal ? 130 : 1)));
  }).finally(() => {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
  });

  if (formatter) {
    formatter.stdin.end();
    await new Promise<void>((resolve) => formatter.on('close', () => resolve()));
  }
  await new Promise<void>((resolve) => logFile.end(resolve));

  if (code !== 0) {
    const errors = extractErrors(readFileSync(options.logPath, 'utf8'));
    if (errors.length > 0) {
      log.error('xcodebuild reported:');
      for (const line of errors) log.info(line);
    }
    throw new SwiftlaneError(`xcodebuild failed with exit code ${code}`, { hint: `Full log: ${options.logPath}` });
  }
}
