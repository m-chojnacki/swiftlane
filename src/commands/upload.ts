import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Command, Option } from 'commander';
import { type ApiKey, type ApiKeyOptions, loadApiKey, withApiKeyFile } from '../lib/asc/key.ts';
import { SwiftlaneError } from '../lib/errors.ts';
import { run } from '../lib/exec.ts';
import { log } from '../lib/log.ts';
import { exportArchive, resolveArchive } from '../lib/xcode/export.ts';
import type { Prettifier } from '../lib/xcode/xcodebuild.ts';
import { addApiKeyOptions, prettifierOption } from '../options.ts';

const PLATFORMS = ['ios', 'macos', 'appletvos', 'visionos'] as const;

interface UploadOptions extends ApiKeyOptions {
  archive?: string;
  ipa?: string;
  build: string;
  teamId?: string;
  platform?: (typeof PLATFORMS)[number];
  prettifier: Prettifier;
}

/** Lets Xcode export and upload in one go, signing with the cloud-managed distribution certificate. */
async function uploadArchive(apiKey: ApiKey, options: UploadOptions): Promise<void> {
  const buildDirectory = path.resolve(options.build);
  const archivePath = resolveArchive(options.archive, buildDirectory);
  const exportPath = mkdtempSync(path.join(os.tmpdir(), 'swiftlane-upload-'));
  try {
    await log.group(`Uploading ${path.basename(archivePath)} to App Store Connect`, () =>
      exportArchive(apiKey, {
        archivePath,
        exportPath,
        method: 'app-store-connect',
        destination: 'upload',
        teamId: options.teamId,
        prettifier: options.prettifier,
        logPath: path.join(buildDirectory, 'logs', 'upload.log'),
      }),
    );
  } finally {
    rmSync(exportPath, { recursive: true, force: true });
  }
}

async function uploadPackage(apiKey: ApiKey, options: UploadOptions & { ipa: string }): Promise<void> {
  const file = path.resolve(options.ipa);
  if (!existsSync(file)) throw new SwiftlaneError(`${file} does not exist`);
  const platform = options.platform ?? (file.endsWith('.pkg') ? 'macos' : 'ios');
  log.step(`Uploading ${path.basename(file)} to App Store Connect (${platform}), this can take a while`);
  await withApiKeyFile(apiKey, (keyFile) =>
    run('xcrun', ['altool', '--upload-app', '--file', file, '--type', platform, '--apiKey', apiKey.keyId, '--apiIssuer', apiKey.issuerId], {
      // altool only looks up keys by ID in a handful of directories, this adds ours.
      env: { ...process.env, API_PRIVATE_KEYS_DIR: keyFile.directory },
      stream: true,
      hint: 'Check the output above, common causes are a build number that was already uploaded or a missing app record',
    }),
  );
}

async function upload(options: UploadOptions): Promise<void> {
  if (options.ipa && options.archive) throw new SwiftlaneError('Pass either -a / --archive or -i / --ipa, not both');
  const apiKey = loadApiKey(options);
  if (options.ipa) {
    await uploadPackage(apiKey, { ...options, ipa: options.ipa });
  } else {
    await uploadArchive(apiKey, options);
  }
  log.success('Uploaded to App Store Connect');
  log.hint('The build appears in TestFlight once Apple finishes processing it, usually within minutes');
}

export function uploadCommand(): Command {
  return addApiKeyOptions(
    new Command('upload')
      .description('upload to App Store Connect / TestFlight, from an archive (signed via Xcode) or an already exported .ipa/.pkg')
      .option('-a, --archive <path>', 'the .xcarchive to upload (default: the only one in the build directory)')
      .option('-i, --ipa <path>', 'upload an exported .ipa or .pkg with altool instead of an archive')
      .option('-b, --build <directory>', 'build directory used by swiftlane archive', 'build')
      .option('-t, --team-id <id>', 'development team ID, normally taken from the archive')
      .addOption(new Option('--platform <platform>', 'platform of the --ipa package (default: ios, macos for .pkg)').choices(PLATFORMS))
      .addOption(prettifierOption()),
  ).action(upload);
}
