import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { SwiftlaneError } from '../errors.ts';
import { run } from '../exec.ts';
import { log } from '../log.ts';

export interface XcodeProject {
  kind: 'workspace' | 'project';
  path: string;
  /** File name without extension, used to name build products. */
  name: string;
}

export function projectArgs(project: XcodeProject): string[] {
  return [project.kind === 'workspace' ? '-workspace' : '-project', project.path];
}

function describe(projectPath: string): XcodeProject {
  const extension = path.extname(projectPath);
  if (extension !== '.xcworkspace' && extension !== '.xcodeproj') {
    throw new SwiftlaneError(`${projectPath} is neither an .xcworkspace nor an .xcodeproj`);
  }
  try {
    statSync(projectPath);
  } catch {
    throw new SwiftlaneError(`${projectPath} does not exist`);
  }
  return {
    kind: extension === '.xcworkspace' ? 'workspace' : 'project',
    path: projectPath,
    name: path.basename(projectPath, extension),
  };
}

/** Uses the given path, otherwise the only workspace (preferred, CocoaPods & co.) or project in the directory. */
export function resolveProject(given: string | undefined, cwd = process.cwd()): XcodeProject {
  if (given) return describe(path.resolve(cwd, given));
  const entries = readdirSync(cwd);
  for (const extension of ['.xcworkspace', '.xcodeproj']) {
    const matches = entries.filter((entry) => entry.endsWith(extension));
    if (matches.length === 1) {
      const project = describe(path.join(cwd, matches[0]!));
      log.info(`Using ${project.kind} ${matches[0]}`);
      return project;
    }
    if (matches.length > 1) {
      throw new SwiftlaneError(`Found multiple ${extension} files: ${matches.join(', ')}`, { hint: 'Pick one with -w / --workspace' });
    }
  }
  throw new SwiftlaneError(`No .xcworkspace or .xcodeproj found in ${cwd}`, { hint: 'Pass one with -w / --workspace' });
}

/** xcodebuild may print warnings before the JSON payload. */
export function parseJsonOutput<T>(output: string): T {
  const start = output.search(/^[[{]/m);
  if (start < 0) throw new SwiftlaneError('xcodebuild did not return JSON output');
  return JSON.parse(output.slice(start)) as T;
}

export async function listSchemes(project: XcodeProject): Promise<string[]> {
  const { stdout } = await run('xcodebuild', ['-list', '-json', ...projectArgs(project)]);
  const parsed = parseJsonOutput<{ workspace?: { schemes?: string[] }; project?: { schemes?: string[] } }>(stdout);
  return (parsed.workspace ?? parsed.project)?.schemes ?? [];
}

export function pickScheme(schemes: string[], project: XcodeProject): string {
  if (schemes.length === 1) return schemes[0]!;
  const sameName = schemes.find((scheme) => scheme === project.name);
  if (sameName) return sameName;
  if (schemes.length === 0) {
    throw new SwiftlaneError(`No shared schemes found in ${path.basename(project.path)}`, {
      hint: 'Mark the scheme as Shared in Xcode (Manage Schemes…) and commit it',
    });
  }
  throw new SwiftlaneError(`Cannot infer the scheme, ${path.basename(project.path)} has: ${schemes.join(', ')}`, {
    hint: 'Pick one with -s / --scheme',
  });
}

export async function resolveScheme(project: XcodeProject, given: string | undefined): Promise<string> {
  if (given) return given;
  log.info('Inferring scheme…');
  const scheme = pickScheme(await listSchemes(project), project);
  log.info(`Using scheme ${scheme}`);
  return scheme;
}

export type BuildSettings = Record<string, string>;

export async function buildSettings(
  project: XcodeProject,
  scheme: string,
  configuration?: string,
): Promise<{ target: string; buildSettings: BuildSettings }[]> {
  const args = ['-showBuildSettings', '-json', ...projectArgs(project), '-scheme', scheme];
  if (configuration) args.push('-configuration', configuration);
  const { stdout } = await run('xcodebuild', args);
  return parseJsonOutput(stdout);
}

/** Settings of the scheme's main application target, falling back to the first target. */
export function appSettings(targets: { target: string; buildSettings: BuildSettings }[]): BuildSettings | undefined {
  const app = targets.find((entry) => /product-type\.application/.test(entry.buildSettings.PRODUCT_TYPE ?? ''));
  return (app ?? targets[0])?.buildSettings;
}

export type Platform = 'iOS' | 'macOS' | 'tvOS' | 'watchOS' | 'visionOS';

const SDK_PLATFORMS: Record<string, Platform> = {
  iphoneos: 'iOS',
  iphonesimulator: 'iOS',
  macosx: 'macOS',
  appletvos: 'tvOS',
  appletvsimulator: 'tvOS',
  watchos: 'watchOS',
  watchsimulator: 'watchOS',
  xros: 'visionOS',
  xrsimulator: 'visionOS',
};

export function platformFromSettings(settings: BuildSettings | undefined): Platform | undefined {
  const sdk = settings?.PLATFORM_NAME ?? settings?.SDKROOT ?? '';
  const name = path
    .basename(sdk)
    .replace(/[\d.]*\.sdk$/, '')
    .toLowerCase();
  return SDK_PLATFORMS[name];
}

export async function inferPlatform(project: XcodeProject, scheme: string, configuration?: string): Promise<Platform> {
  try {
    const platform = platformFromSettings(appSettings(await buildSettings(project, scheme, configuration)));
    if (platform) return platform;
  } catch (error) {
    log.debug(`Could not read build settings: ${(error as Error).message}`);
  }
  log.warn('Could not infer the platform from build settings, assuming iOS');
  return 'iOS';
}
