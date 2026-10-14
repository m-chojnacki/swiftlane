import { readFileSync } from 'node:fs';
import { Command } from 'commander';
import { archiveCommand } from './commands/archive.ts';
import { cleanCommand } from './commands/clean.ts';
import { exportCommand } from './commands/export.ts';
import { keychainCommand } from './commands/keychain.ts';
import { signingCommand } from './commands/signing.ts';
import { testCommand } from './commands/test.ts';
import { uploadCommand } from './commands/upload.ts';
import { versionCommand } from './commands/version.ts';
import { setVerbose } from './lib/log.ts';

// Resolves to the package root both from src/ (development) and dist/ (published).
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };

export function createProgram(): Command {
  const program = new Command('swiftlane')
    .description('All you need is an App Store Connect API key: keychains, signing, archiving and uploading Xcode projects on CI')
    .version(version, '-V, --version')
    .option('--verbose', 'print every executed command and API request (also SWIFTLANE_VERBOSE=1)')
    .showHelpAfterError()
    .hook('preAction', () => setVerbose(Boolean(program.opts().verbose)));

  program
    .addCommand(keychainCommand())
    .addCommand(signingCommand())
    .addCommand(archiveCommand())
    .addCommand(exportCommand())
    .addCommand(uploadCommand())
    .addCommand(testCommand())
    .addCommand(cleanCommand())
    .addCommand(versionCommand());

  addHelpCommands(program);
  return program;
}

/**
 * Commander only gives commands with subcommands a `help` subcommand, and it resolves a single level.
 * Giving every command one that resolves the whole path makes `help a b`, `a help b`, `a b help`
 * and `a b -h` equivalent everywhere.
 */
function addHelpCommands(command: Command): void {
  const subcommands = [...command.commands];
  subcommands.forEach(addHelpCommands);

  const isLeaf = subcommands.length === 0;
  // The hidden help subcommand would otherwise add "[command]" to the usage line.
  if (isLeaf) command.usage('[options]');
  command.helpCommand(false);
  command.addCommand(
    new Command('help')
      .description('display help for command')
      .argument('[command...]', 'command path to show help for')
      .action((path: string[]) => {
        let target = command;
        for (const name of path) {
          const next = target.commands.find((candidate) => candidate.name() === name && candidate.name() !== 'help');
          if (!next) target.error(`error: unknown command '${name}'`);
          target = next!;
        }
        target.help();
      }),
    { hidden: isLeaf },
  );
}
