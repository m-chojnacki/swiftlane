import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { SwiftlaneError } from '../lib/errors.ts';
import { run } from '../lib/exec.ts';
import { log } from '../lib/log.ts';
import { setOutput } from '../lib/output.ts';

interface ProjectLocation {
  /** Directory agvtool runs in, it operates on the .xcodeproj found there. */
  directory: string;
  pbxproj: string;
}

interface GetOptions {
  workspace?: string;
  marketing: boolean;
  build: boolean;
  json: boolean;
}

interface SetOptions {
  workspace?: string;
  marketing?: string;
  build?: string;
  increment: boolean;
}

const AGVTOOL_HINT = 'agvtool needs "Versioning System" set to "Apple Generic" and "Current Project Version" set in the build settings';

function locateProject(given: string | undefined): ProjectLocation {
  let projectPath: string | undefined;
  if (given?.endsWith('.xcodeproj')) {
    projectPath = path.resolve(given);
  } else {
    const directory = given
      ? statSync(given).isDirectory() && !given.endsWith('.xcworkspace')
        ? path.resolve(given)
        : path.dirname(path.resolve(given))
      : process.cwd();
    const projects = readdirSync(directory).filter((entry) => entry.endsWith('.xcodeproj') && entry !== 'Pods.xcodeproj');
    if (projects.length !== 1) {
      throw new SwiftlaneError(
        projects.length === 0 ? `No .xcodeproj found in ${directory}` : `Found multiple projects in ${directory}: ${projects.join(', ')}`,
        {
          hint: 'Pass the .xcodeproj with -w / --workspace',
        },
      );
    }
    projectPath = path.join(directory, projects[0]!);
  }
  return { directory: path.dirname(projectPath), pbxproj: path.join(projectPath, 'project.pbxproj') };
}

/** Distinct values of a build setting across all configurations of the project. */
export function buildSettingValues(pbxproj: string, setting: string): string[] {
  const values = new Set<string>();
  for (const match of pbxproj.matchAll(new RegExp(`^\\s*${setting} = ("?)([^";\\n]*)\\1;`, 'gm'))) {
    values.add(match[2]!);
  }
  return [...values];
}

export function replaceBuildSetting(pbxproj: string, setting: string, value: string): string {
  const quoted = /^[\w.]+$/.test(value) ? value : `"${value}"`;
  return pbxproj.replace(new RegExp(`^(\\s*${setting} = )("?)[^";\\n]*\\2;`, 'gm'), `$1${quoted};`);
}

function isResolved(value: string): boolean {
  return value !== '' && !value.includes('$(') && !value.includes('${');
}

async function agvtool(location: ProjectLocation, args: string[]): Promise<string> {
  const { stdout } = await run('xcrun', ['agvtool', ...args], { cwd: location.directory, hint: AGVTOOL_HINT });
  return stdout.replace(/\s+/g, ' ').trim();
}

/** agvtool reads Info.plist, which in modern projects only references build settings, so fall back to those. */
async function currentVersions(location: ProjectLocation): Promise<{ marketing: string; build: string }> {
  const pbxproj = readFileSync(location.pbxproj, 'utf8');

  const fromSettings = (setting: string, kind: string): string => {
    const values = buildSettingValues(pbxproj, setting).filter(isResolved);
    if (values.length > 1) log.warn(`Targets use different ${kind}s (${values.join(', ')}), showing the first one`);
    return values[0] ?? '';
  };

  let marketing = (
    await run('xcrun', ['agvtool', 'what-marketing-version', '-terse1'], { cwd: location.directory, allowFailure: true })
  ).stdout.trim();
  if (!isResolved(marketing)) marketing = fromSettings('MARKETING_VERSION', 'marketing version');

  let build = (await run('xcrun', ['agvtool', 'what-version', '-terse'], { cwd: location.directory, allowFailure: true })).stdout.trim();
  if (!isResolved(build)) build = fromSettings('CURRENT_PROJECT_VERSION', 'build number');

  return { marketing, build };
}

async function get(options: GetOptions): Promise<void> {
  const versions = await currentVersions(locateProject(options.workspace));
  if (options.json) {
    process.stdout.write(`${JSON.stringify(versions)}\n`);
  } else if (options.marketing || options.build) {
    if (options.marketing) process.stdout.write(`${versions.marketing}\n`);
    if (options.build) process.stdout.write(`${versions.build}\n`);
  } else {
    process.stdout.write(`${versions.marketing || '?'} (${versions.build || '?'})\n`);
  }
  setOutput('marketing-version', versions.marketing);
  setOutput('build-number', versions.build);
}

async function set(options: SetOptions): Promise<void> {
  if (!options.marketing && !options.build && !options.increment) {
    throw new SwiftlaneError('Nothing to set', { hint: 'Pass -m / --marketing, -b / --build or -i / --increment' });
  }
  if (options.build && options.increment) throw new SwiftlaneError('Pass either -b / --build or -i / --increment, not both');
  if (options.build && !/^\d+(\.\d+){0,2}$/.test(options.build)) {
    throw new SwiftlaneError(`Invalid build number "${options.build}"`, {
      hint: 'Use up to three period-separated integers, e.g. 42 or 1.2.3',
    });
  }

  const location = locateProject(options.workspace);
  const usesBuildSettings = (setting: string): boolean => buildSettingValues(readFileSync(location.pbxproj, 'utf8'), setting).length > 0;

  if (options.marketing) {
    log.step(`Setting marketing version to ${options.marketing}`);
    if (usesBuildSettings('MARKETING_VERSION')) {
      // agvtool would hardcode the version into Info.plist files that reference $(MARKETING_VERSION).
      writeFileSync(location.pbxproj, replaceBuildSetting(readFileSync(location.pbxproj, 'utf8'), 'MARKETING_VERSION', options.marketing));
      log.info('Updated MARKETING_VERSION in all build configurations');
    } else {
      log.info(await agvtool(location, ['new-marketing-version', options.marketing]));
    }
  }

  if (options.build || options.increment) {
    // With CURRENT_PROJECT_VERSION in the project, -all would also hardcode the number into Info.plist files.
    const all = usesBuildSettings('CURRENT_PROJECT_VERSION') ? [] : ['-all'];
    if (options.build) {
      log.step(`Setting build number to ${options.build}`);
      log.info(await agvtool(location, ['new-version', ...all, options.build]));
    } else {
      log.step('Incrementing build number');
      log.info(await agvtool(location, ['next-version', ...all]));
    }
  }

  const versions = await currentVersions(location);
  setOutput('marketing-version', versions.marketing);
  setOutput('build-number', versions.build);
  log.success(`Version is now ${versions.marketing || '?'} (${versions.build || '?'})`);
}

export function versionCommand(): Command {
  const command = new Command('version').description('read and update the app version with agvtool');

  command
    .command('get')
    .description('print the marketing version and build number, e.g. "1.2.0 (42)"')
    .option('-w, --workspace <path>', '.xcodeproj, or a directory/.xcworkspace next to it (default: current directory)')
    .option('-m, --marketing', 'print only the marketing version', false)
    .option('-b, --build', 'print only the build number', false)
    .option('--json', 'print both as JSON', false)
    .action(get);

  command
    .command('set')
    .description('update the marketing version and/or build number')
    .option('-w, --workspace <path>', '.xcodeproj, or a directory/.xcworkspace next to it (default: current directory)')
    .option('-m, --marketing <version>', 'new marketing version, e.g. 1.2.0')
    .option('-b, --build <number>', 'new build number, e.g. 42')
    .option('-i, --increment', 'increment the build number', false)
    .action(set);

  return command;
}
