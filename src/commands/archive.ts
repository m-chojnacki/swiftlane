import { rmSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { type ApiKeyOptions, loadApiKey, withApiKeyFile, xcodebuildAuthArgs } from '../lib/asc/key.ts';
import { log } from '../lib/log.ts';
import { setOutput } from '../lib/output.ts';
import { inferPlatform, projectArgs, resolveProject, resolveScheme } from '../lib/xcode/project.ts';
import { xcodebuild } from '../lib/xcode/xcodebuild.ts';
import { addApiKeyOptions, addProjectOptions, type ProjectOptions } from '../options.ts';

interface ArchiveOptions extends ProjectOptions, ApiKeyOptions {
  destination?: string;
  archivePath?: string;
}

async function archive(options: ArchiveOptions): Promise<void> {
  const apiKey = loadApiKey(options);
  log.step('Preparing archive');
  const project = resolveProject(options.workspace);
  const scheme = await resolveScheme(project, options.scheme);
  const destination = options.destination ?? `generic/platform=${await inferPlatform(project, scheme, options.configuration)}`;
  const buildDirectory = path.resolve(options.build);
  const archivePath = path.resolve(options.archivePath ?? path.join(buildDirectory, `${project.name}.xcarchive`));
  log.info(`Destination: ${destination}`);

  rmSync(archivePath, { recursive: true, force: true });

  await withApiKeyFile(apiKey, (keyFile) =>
    log.group(`Archiving ${scheme}`, () =>
      xcodebuild(
        [
          ...projectArgs(project),
          '-scheme',
          scheme,
          ...(options.configuration ? ['-configuration', options.configuration] : []),
          '-destination',
          destination,
          '-archivePath',
          archivePath,
          '-derivedDataPath',
          path.join(buildDirectory, 'DerivedData'),
          ...xcodebuildAuthArgs(apiKey, keyFile.path),
          'archive',
        ],
        { prettifier: options.prettifier, logPath: path.join(buildDirectory, 'logs', 'archive.log') },
      ),
    ),
  );

  setOutput('archive-path', archivePath);
  log.success(`Archive ready: ${archivePath}`);
}

export function archiveCommand(): Command {
  return addApiKeyOptions(
    addProjectOptions(new Command('archive').description('archive the app with automatic signing driven by the App Store Connect API key'))
      .option('-d, --destination <destination>', 'xcodebuild destination (default: generic/platform=<platform of the scheme>)')
      .option('-a, --archive-path <path>', 'where to write the .xcarchive (default: <build>/<project name>.xcarchive)'),
  ).action(archive);
}
