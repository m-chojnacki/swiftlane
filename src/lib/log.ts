import { styleText } from 'node:util';

type Style = Parameters<typeof styleText>[0];

const inGitHubActions = process.env.GITHUB_ACTIONS === 'true';
let verbose = process.env.SWIFTLANE_VERBOSE === '1' || process.env.RUNNER_DEBUG === '1';

export function setVerbose(value: boolean): void {
  verbose = verbose || value;
}

export function isVerbose(): boolean {
  return verbose;
}

// All diagnostics go to stderr so stdout stays clean for values meant to be piped (e.g. `version get`).
function write(line: string): void {
  process.stderr.write(`${line}\n`);
}

function paint(style: Style, text: string): string {
  // GitHub Actions renders ANSI colors even though stderr is not a TTY.
  return styleText(style, text, { validateStream: !inGitHubActions, stream: process.stderr });
}

export const log = {
  step(message: string): void {
    write(paint(['bold', 'cyan'], '▸ ') + paint('bold', message));
  },
  info(message: string): void {
    write(`  ${message}`);
  },
  success(message: string): void {
    write(paint('green', '✔ ') + message);
  },
  warn(message: string): void {
    write(paint('yellow', `⚠ ${message}`));
  },
  error(message: string): void {
    write(paint('red', `✖ ${message}`));
  },
  hint(message: string): void {
    write(paint('dim', `  ↳ ${message}`));
  },
  debug(message: string): void {
    if (verbose) write(paint('dim', `  · ${message}`));
  },
  command(display: string): void {
    if (verbose) write(paint('dim', `  $ ${display}`));
  },
  async group<T>(title: string, fn: () => Promise<T>): Promise<T> {
    if (!inGitHubActions) {
      log.step(title);
      return fn();
    }
    write(`::group::${title}`);
    try {
      return await fn();
    } finally {
      write('::endgroup::');
    }
  },
};
