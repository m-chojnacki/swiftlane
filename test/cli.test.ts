import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Command } from 'commander';
import { archiveCommand } from '../src/commands/archive.ts';
import { keychainCommand } from '../src/commands/keychain.ts';
import { signingCommand } from '../src/commands/signing.ts';
import { uploadCommand } from '../src/commands/upload.ts';

/** Parses argv like the real CLI does, but captures the options instead of running the command. */
async function parse(
  command: Command,
  argv: string[],
  subcommand?: string,
): Promise<{ options: Record<string, unknown>; target: Command }> {
  const target = subcommand ? command.commands.find((candidate) => candidate.name() === subcommand)! : command;
  let options: Record<string, unknown> = {};
  target.action((parsed: Record<string, unknown>) => {
    options = parsed;
  });
  command.exitOverride();
  target.exitOverride();
  await command.parseAsync(subcommand ? [subcommand, ...argv] : argv, { from: 'user' });
  return { options, target };
}

describe('option parsing', () => {
  it('parses API key and project options on archive', async () => {
    const { options } = await parse(archiveCommand(), [
      '--private-key',
      'KEY',
      '--key-identifier',
      'ID',
      '--issuer-id',
      'ISSUER',
      '-p',
      'none',
      '-s',
      'App',
    ]);
    assert.equal(options.privateKey, 'KEY');
    assert.equal(options.keyIdentifier, 'ID');
    assert.equal(options.issuerId, 'ISSUER');
    assert.equal(options.prettifier, 'none');
    assert.equal(options.scheme, 'App');
    assert.equal(options.build, 'build');
  });

  it('falls back to the environment for API key options', async () => {
    process.env.APP_STORE_CONNECT_KEY_IDENTIFIER = 'FROM_ENV';
    try {
      const { options } = await parse(archiveCommand(), []);
      assert.equal(options.keyIdentifier, 'FROM_ENV');
    } finally {
      delete process.env.APP_STORE_CONNECT_KEY_IDENTIFIER;
    }
  });

  it('rejects unknown prettifiers', async () => {
    await assert.rejects(parse(archiveCommand(), ['-p', 'fancy']), /Allowed choices/);
  });

  it('applies keychain init defaults', async () => {
    const { options } = await parse(keychainCommand(), [], 'init');
    assert.deepEqual(options, { keychain: 'swiftlane', password: '', default: false, timeout: 3600 });
  });

  it('validates the keychain timeout', async () => {
    await assert.rejects(parse(keychainCommand(), ['-t', 'soon'], 'init'), /non-negative integer/);
  });

  it('tells whether the keychain was given explicitly to signing sync', async () => {
    const implicit = await parse(signingCommand(), [], 'sync');
    assert.equal(implicit.target.getOptionValueSource('keychain'), 'default');
    const explicit = await parse(signingCommand(), ['-k', 'ci', '-o', 'upstream', '-g', 'TOKEN'], 'sync');
    assert.equal(explicit.target.getOptionValueSource('keychain'), 'cli');
    assert.equal(explicit.options.origin, 'upstream');
    assert.equal(explicit.options.githubToken, 'TOKEN');
  });

  it('keeps -i (ipa) and --issuer-id apart on upload', async () => {
    const { options } = await parse(uploadCommand(), ['-i', 'App.ipa', '--issuer-id', 'ISSUER']);
    assert.equal(options.ipa, 'App.ipa');
    assert.equal(options.issuerId, 'ISSUER');
  });
});
