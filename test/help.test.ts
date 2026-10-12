import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Command } from 'commander';
import { createProgram } from '../src/program.ts';

/** Runs argv against a fresh program whose real actions are stubbed, so nothing touches the system. */
function invoke(argv: string[]): { code: number; output: string; ran: boolean } {
  const program = createProgram();
  let output = '';
  let ran = false;
  const configure = (command: Command): void => {
    command.exitOverride();
    command.configureOutput({ writeOut: (text) => (output += text), writeErr: (text) => (output += text) });
    if (command.name() !== 'help' && command.commands.every((child) => child.name() === 'help')) {
      command.action(() => {
        ran = true;
      });
    }
    command.commands.forEach(configure);
  };
  configure(program);
  let code = 0;
  try {
    program.parse(argv, { from: 'user' });
  } catch (error) {
    code = (error as { exitCode?: number }).exitCode ?? -1;
  }
  return { code, output, ran };
}

function commandPaths(command: Command, prefix: string[] = []): string[][] {
  return command.commands
    .filter((child) => child.name() !== 'help')
    .flatMap((child) => [[...prefix, child.name()], ...commandPaths(child, [...prefix, child.name()])]);
}

describe('help', () => {
  const paths = commandPaths(createProgram());

  it('covers every command', () => {
    assert.ok(paths.length >= 14);
  });

  for (const path of paths) {
    const name = path.join(' ');
    it(`is the same for every form of "${name}"`, () => {
      const expected = invoke([...path, '--help']);
      assert.equal(expected.code, 0);
      assert.match(expected.output, new RegExp(`^Usage: swiftlane ${name} `));
      const forms = [
        [...path, '-h'],
        ['help', ...path],
        [...path, 'help'],
      ];
      if (path.length > 1) forms.push([...path.slice(0, -1), 'help', path.at(-1)!]);
      for (const form of forms) {
        const result = invoke(form);
        assert.deepEqual(
          { code: result.code, output: result.output, ran: result.ran },
          { code: 0, output: expected.output, ran: false },
          form.join(' '),
        );
      }
    });
  }

  it('shows root help', () => {
    assert.equal(invoke(['help']).output, invoke(['--help']).output);
  });

  it('rejects unknown commands instead of falling back to a parent help', () => {
    for (const form of [
      ['help', 'bogus'],
      ['help', 'keychain', 'bogus'],
      ['help', 'archive', 'x'],
      ['keychain', 'bogus'],
    ]) {
      const result = invoke(form);
      assert.equal(result.code, 1, form.join(' '));
      assert.match(result.output, /unknown command/);
    }
  });

  it('does not list the help command on leaves', () => {
    const { output } = invoke(['archive', '--help']);
    assert.match(output, /^Usage: swiftlane archive \[options\]\n/);
    assert.doesNotMatch(output, /Commands:/);
  });

  it('still runs leaves and rejects stray arguments', () => {
    assert.equal(invoke(['archive', '-s', 'App']).ran, true);
    assert.equal(invoke(['archive', 'foo']).code, 1);
    assert.equal(invoke(['archive', '--bogus']).code, 1);
  });
});
