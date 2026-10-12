import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type ApiKey, withApiKeyFile, xcodebuildAuthArgs } from '../asc/key.ts';
import { SwiftlaneError } from '../errors.ts';
import { log } from '../log.ts';
import { type PlistValue, toPlist } from './plist.ts';
import { type Prettifier, xcodebuild } from './xcodebuild.ts';

/** Uses the given archive, otherwise the only .xcarchive in the build directory. */
export function resolveArchive(given: string | undefined, buildDirectory: string): string {
  if (given) return path.resolve(given);
  let archives: string[] = [];
  try {
    archives = readdirSync(buildDirectory).filter((entry) => entry.endsWith('.xcarchive'));
  } catch {
    // build directory does not exist
  }
  if (archives.length === 1) return path.join(buildDirectory, archives[0]!);
  throw new SwiftlaneError(
    archives.length === 0
      ? `No .xcarchive found in ${buildDirectory}`
      : `Found multiple archives in ${buildDirectory}: ${archives.join(', ')}`,
    { hint: 'Run swiftlane archive first or pass -a / --archive' },
  );
}

export interface ExportArchiveOptions {
  archivePath: string;
  exportPath: string;
  method: string;
  destination: 'export' | 'upload';
  teamId?: string;
  prettifier: Prettifier;
  logPath: string;
}

export function exportOptions(options: Pick<ExportArchiveOptions, 'method' | 'destination' | 'teamId'>): { [key: string]: PlistValue } {
  const plist: { [key: string]: PlistValue } = {
    method: options.method,
    destination: options.destination,
    // Cloud-managed distribution certificates only work with automatic signing.
    signingStyle: 'automatic',
  };
  if (options.teamId) plist.teamID = options.teamId;
  if (/^app-store/.test(options.method)) {
    plist.uploadSymbols = true;
    plist.manageAppVersionAndBuildNumber = false;
  }
  return plist;
}

export async function exportArchive(apiKey: ApiKey, options: ExportArchiveOptions): Promise<void> {
  const plistDirectory = mkdtempSync(path.join(os.tmpdir(), 'swiftlane-export-'));
  try {
    const plistPath = path.join(plistDirectory, 'ExportOptions.plist');
    const plist = exportOptions(options);
    writeFileSync(plistPath, toPlist(plist));
    log.debug(`ExportOptions: ${JSON.stringify(plist)}`);
    mkdirSync(options.exportPath, { recursive: true });

    await withApiKeyFile(apiKey, (keyFile) =>
      xcodebuild(
        [
          '-exportArchive',
          '-archivePath',
          options.archivePath,
          '-exportPath',
          options.exportPath,
          '-exportOptionsPlist',
          plistPath,
          ...xcodebuildAuthArgs(apiKey, keyFile.path),
        ],
        { prettifier: options.prettifier, logPath: options.logPath },
      ),
    );
  } finally {
    rmSync(plistDirectory, { recursive: true, force: true });
  }
}
