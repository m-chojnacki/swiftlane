export class SwiftlaneError extends Error {
  readonly hint: string | undefined;

  constructor(message: string, options: { hint?: string; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'SwiftlaneError';
    this.hint = options.hint;
  }
}

export class CommandError extends SwiftlaneError {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(display: string, code: number, stdout: string, stderr: string, hint?: string) {
    const output = (stderr.trim() || stdout.trim()).split('\n').slice(-15).join('\n');
    super(`Command failed with exit code ${code}: ${display}${output ? `\n${output}` : ''}`, { hint });
    this.name = 'CommandError';
    this.code = code;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}
