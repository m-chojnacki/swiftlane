import { readdirSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { type ApiKeyOptions, loadApiKey } from '../lib/asc/key.ts';
import { log } from '../lib/log.ts';
import { setOutput } from '../lib/output.ts';
import { exportArchive, resolveArchive } from '../lib/xcode/export.ts';
import type { Prettifier } from '../lib/xcode/xcodebuild.ts';
import { addApiKeyOptions, prettifierOption } from '../options.ts';

interface ExportCommandOptions extends ApiKeyOptions {
  archive?: string;
  build: string;
  output?: string;
  method: string;
  teamId?: string;
  prettifier: Prettifier;
}

async function exportCommandAction(options: ExportCommandOptions): Promise<void> {
  const apiKey = loadApiKey(options);
  const buildDirectory = path.resolve(options.build);
  const archivePath = resolveArchive(options.archive, buildDirectory);
  const exportPath = path.resolve(options.output ?? buildDirectory);

  await log.group(`Exporting ${path.basename(archivePath)} (${options.method})`, () =>
    exportArchive(apiKey, {
      archivePath,
      exportPath,
      method: options.method,
      destination: 'export',
      teamId: options.teamId,
      prettifier: options.prettifier,
      logPath: path.join(buildDirectory, 'logs', 'export.log'),
    }),
  );

  const products = readdirSync(exportPath).filter((entry) => /\.(ipa|pkg|app)$/.test(entry));
  for (const product of products) log.info(`Exported ${path.join(exportPath, product)}`);
  const ipa = products.find((product) => product.endsWith('.ipa') || product.endsWith('.pkg'));
  if (ipa) setOutput('ipa-path', path.join(exportPath, ipa));
  log.success(`Export finished: ${exportPath}`);
}

export function exportCommand(): Command {
  return addApiKeyOptions(
    new Command('export')
      .description('export an .ipa from an archive, distribution signing is handled by the cloud-managed certificate')
      .option('-a, --archive <path>', 'the .xcarchive to export (default: the only one in the build directory)')
      .option('-b, --build <directory>', 'build directory used by swiftlane archive', 'build')
      .option('-o, --output <directory>', 'where to put the exported product (default: the build directory)')
      .option(
        '-m, --method <method>',
        'export method: app-store-connect, release-testing, enterprise, debugging (or legacy names)',
        'app-store-connect',
      )
      .option('-t, --team-id <id>', 'development team ID, normally taken from the archive')
      .addOption(prettifierOption()),
  ).action(exportCommandAction);
}
