import { existsSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command } from 'commander';
import { SwiftlaneError } from '../lib/errors.ts';
import { log } from '../lib/log.ts';

interface CleanOptions {
  build: string;
}

function contains(directory: string, candidate: string): boolean {
  const relative = path.relative(directory, candidate);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Returns whether there was anything to remove. */
export function removeBuildDirectory(given: string, cwd = process.cwd()): boolean {
  const directory = path.resolve(cwd, given);
  // A slip like `-b .` or `-b ~` would otherwise wipe the project or the home folder.
  for (const kept of [cwd, os.homedir()]) {
    if (contains(directory, kept)) {
      throw new SwiftlaneError(`Refusing to remove ${directory}, it contains ${kept}`, {
        hint: 'Point -b / --build at the build directory itself',
      });
    }
  }
  if (!existsSync(directory)) return false;
  rmSync(directory, { recursive: true, force: true });
  return true;
}

function clean(options: CleanOptions): void {
  const directory = path.resolve(options.build);
  if (removeBuildDirectory(options.build)) log.success(`Removed ${directory}`);
  else log.info(`Nothing to clean, ${directory} does not exist`);
}

export function cleanCommand(): Command {
  return new Command('clean')
    .description('remove the build directory with archives, exports, test results, DerivedData and logs')
    .option('-b, --build <directory>', 'build directory used by the other commands', 'build')
    .action(clean);
}
