import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SwiftlaneError } from './errors.ts';
import { run } from './exec.ts';

const SECURITY = '/usr/bin/security';

const RESERVED_NAMES = new Set(['login', 'system', 'systemrootcertificates', 'icloud', 'local items', 'metadata', 'apsd']);

/** Applications allowed to use imported keys without prompting. */
const TRUSTED_APPS = ['/usr/bin/codesign', '/usr/bin/security', '/usr/bin/productsign', '/usr/bin/productbuild'];

export function keychainsDirectory(): string {
  return path.join(os.homedir(), 'Library', 'Keychains');
}

function stripSuffix(name: string): string {
  return name.replace(/\.keychain(-db)?$/, '');
}

/**
 * Turns a keychain name ("swiftlane") or path into the absolute path of its file.
 * Names live in ~/Library/Keychains, mirroring what `security create-keychain <name>` does.
 */
export function resolveKeychainPath(nameOrPath: string): string {
  const trimmed = nameOrPath.trim();
  if (!trimmed) throw new SwiftlaneError('Keychain name cannot be empty');
  const isPath = trimmed.includes('/') || trimmed.startsWith('~');
  const expanded = trimmed.startsWith('~') ? path.join(os.homedir(), trimmed.slice(1)) : trimmed;
  const base = stripSuffix(isPath ? path.resolve(expanded) : path.join(keychainsDirectory(), trimmed));
  for (const candidate of [`${base}.keychain-db`, `${base}.keychain`]) {
    if (existsSync(candidate)) return candidate;
  }
  return `${base}.keychain-db`;
}

export function keychainName(keychainPath: string): string {
  return stripSuffix(path.basename(keychainPath));
}

/** Guards destructive operations from ever being pointed at keychains the system relies on. */
export function assertCustomKeychain(nameOrPath: string): void {
  const resolved = resolveKeychainPath(nameOrPath);
  const name = keychainName(resolved).toLowerCase();
  if (RESERVED_NAMES.has(name) || resolved.startsWith('/Library/') || resolved.startsWith('/System/')) {
    throw new SwiftlaneError(`Refusing to manage system keychain "${nameOrPath}"`, {
      hint: 'Pick a dedicated keychain name, e.g. the default "swiftlane"',
    });
  }
}

export function keychainExists(keychainPath: string): boolean {
  return existsSync(keychainPath);
}

function samePath(a: string, b: string): boolean {
  return stripSuffix(a) === stripSuffix(b);
}

function parseKeychainList(output: string): string[] {
  return output
    .split('\n')
    .map((line) => line.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
}

export async function searchList(): Promise<string[]> {
  const { stdout } = await run(SECURITY, ['list-keychains', '-d', 'user']);
  return parseKeychainList(stdout);
}

export async function setSearchList(paths: string[]): Promise<void> {
  await run(SECURITY, ['list-keychains', '-d', 'user', '-s', ...paths]);
}

export function loginKeychainPath(): string {
  return path.join(keychainsDirectory(), 'login.keychain-db');
}

/** Puts the keychain first in the user search list, keeping everything else (login in particular). */
export async function addToSearchList(keychainPath: string): Promise<void> {
  const current = (await searchList()).filter((entry) => !samePath(entry, keychainPath));
  if (!current.some((entry) => keychainName(entry) === 'login')) current.push(loginKeychainPath());
  await setSearchList([keychainPath, ...current]);
}

export async function removeFromSearchList(keychainPath: string): Promise<boolean> {
  const current = await searchList();
  const next = current.filter((entry) => !samePath(entry, keychainPath));
  if (next.length === current.length) return false;
  if (next.length === 0) next.push(loginKeychainPath());
  await setSearchList(next);
  return true;
}

export async function defaultKeychain(): Promise<string | undefined> {
  const { stdout } = await run(SECURITY, ['default-keychain', '-d', 'user']);
  return parseKeychainList(stdout)[0];
}

export async function setDefaultKeychain(keychainPath: string): Promise<void> {
  await run(SECURITY, ['default-keychain', '-d', 'user', '-s', keychainPath]);
}

export async function isDefaultKeychain(keychainPath: string): Promise<boolean> {
  const current = await defaultKeychain();
  return current !== undefined && samePath(current, keychainPath);
}

export async function createKeychain(keychainPath: string, password: string): Promise<void> {
  await run(SECURITY, ['create-keychain', '-p', password, keychainPath], { secrets: [password] });
}

export async function deleteKeychain(keychainPath: string): Promise<void> {
  await run(SECURITY, ['delete-keychain', keychainPath]);
}

/** A timeout of 0 disables auto-locking entirely. */
export async function setLockTimeout(keychainPath: string, timeoutSeconds: number): Promise<void> {
  const args = timeoutSeconds > 0 ? ['-lut', String(timeoutSeconds)] : [];
  await run(SECURITY, ['set-keychain-settings', ...args, keychainPath]);
}

export async function unlockKeychain(keychainPath: string, password: string): Promise<void> {
  await run(SECURITY, ['unlock-keychain', '-p', password, keychainPath], {
    secrets: [password],
    hint: 'Check the keychain password (-p / --password)',
  });
}

/** Lets codesign use the keychain's keys without the "allow access" UI prompt, which would hang CI. */
export async function setKeyPartitionList(keychainPath: string, password: string): Promise<void> {
  await run(SECURITY, ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', password, keychainPath], {
    secrets: [password],
    hint: 'Check the keychain password (-p / --password)',
  });
}

/** Returns false when the identity was already in the keychain (e.g. imported earlier but not trusted yet). */
export async function importPkcs12(keychainPath: string, p12Path: string, passphrase: string): Promise<boolean> {
  const trusted = TRUSTED_APPS.flatMap((app) => ['-T', app]);
  const args = ['import', p12Path, '-k', keychainPath, '-f', 'pkcs12', '-P', passphrase, ...trusted];
  const result = await run(SECURITY, args, { secrets: [passphrase], allowFailure: true });
  if (result.code === 0) return true;
  if (/already exists/i.test(result.stderr)) return false;
  await run(SECURITY, args, { secrets: [passphrase] });
  return true;
}

export async function importCertificate(keychainPath: string, certificatePath: string): Promise<void> {
  const result = await run(SECURITY, ['import', certificatePath, '-k', keychainPath], { allowFailure: true });
  if (result.code !== 0 && !/already exists/i.test(result.stderr)) {
    await run(SECURITY, ['import', certificatePath, '-k', keychainPath]);
  }
}

/** SHA-1 fingerprints (uppercase hex) of valid code signing identities in the keychain. */
export async function codesigningIdentities(keychainPath: string): Promise<Set<string>> {
  const { stdout } = await run(SECURITY, ['find-identity', '-v', '-p', 'codesigning', keychainPath], { allowFailure: true });
  const fingerprints = new Set<string>();
  for (const match of stdout.matchAll(/^\s*\d+\)\s+([0-9A-F]{40})\s/gm)) {
    fingerprints.add(match[1]!);
  }
  return fingerprints;
}

/** PEMs of all certificates with the given common name in the search list and the System keychains. */
export async function findCertificates(commonName: string): Promise<string[]> {
  const keychains = [
    ...(await searchList()),
    '/Library/Keychains/System.keychain',
    '/System/Library/Keychains/SystemRootCertificates.keychain',
  ];
  const result = await run(SECURITY, ['find-certificate', '-a', '-p', '-c', commonName, ...keychains], { allowFailure: true });
  return result.stdout.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
}
