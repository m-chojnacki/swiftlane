import { type KeyObject, X509Certificate } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AppStoreConnectApiError, type AppStoreConnectClient, type Certificate, isApiCreated } from './asc/client.ts';
import type { ApiKey } from './asc/key.ts';
import { DecryptionError, decrypt, encrypt } from './crypto/envelope.ts';
import {
  type CertificateInfo,
  certificateMatchesKey,
  createCsr,
  createPkcs12,
  describeCertificate,
  generateSigningKey,
  privateKeyFromPem,
  privateKeyToPem,
} from './crypto/identity.ts';
import { SwiftlaneError } from './errors.ts';
import { type CertificateStore, STORE_REF } from './git/store.ts';
import {
  codesigningIdentities,
  findCertificates,
  importCertificate,
  importPkcs12,
  setKeyPartitionList,
  unlockKeychain,
} from './keychain.ts';
import { log } from './log.ts';

const WWDR_INTERMEDIATES: Record<string, string> = {
  G3: 'https://www.apple.com/certificateauthority/AppleWWDRCAG3.cer',
  G4: 'https://www.apple.com/certificateauthority/AppleWWDRCAG4.cer',
  G5: 'https://www.apple.com/certificateauthority/AppleWWDRCAG5.cer',
  G6: 'https://www.apple.com/certificateauthority/AppleWWDRCAG6.cer',
};

export interface Identity {
  certificate: Certificate;
  key: KeyObject;
}

export interface Classification {
  /** Ours and valid, the longest-lived first. */
  usable: Identity[];
  /** Ours but expired. */
  expired: Identity[];
  /** Decryptable by our key but no longer backed by a certificate, or not matching it. */
  stale: string[];
  /** Encrypted with another API key, e.g. a different team sharing the repository. */
  foreign: string[];
}

export type SigningApi = Pick<AppStoreConnectClient, 'listCertificates' | 'createCertificate' | 'revokeCertificate'>;
export type SigningStore = Pick<CertificateStore, 'read' | 'update' | 'assertWritable' | 'describe'>;

export interface SigningContext {
  apiKey: ApiKey;
  api: SigningApi;
  store: SigningStore;
  now?: () => Date;
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function label(certificate: Certificate): string {
  return `${certificate.id} "${certificate.name}"`;
}

export function classifyEntries(entries: Map<string, string>, certificates: Certificate[], apiKey: ApiKey, now: Date): Classification {
  const byId = new Map(certificates.map((certificate) => [certificate.id, certificate]));
  const result: Classification = { usable: [], expired: [], stale: [], foreign: [] };

  for (const [id, contents] of entries) {
    let key: KeyObject;
    try {
      key = privateKeyFromPem(decrypt(contents, apiKey.key, id));
    } catch (error) {
      if (!(error instanceof DecryptionError)) throw error;
      log.debug(`${id}: ${error.message}, keeping it`);
      result.foreign.push(id);
      continue;
    }

    const certificate = byId.get(id);
    if (!certificate) {
      log.info(`${id}: certificate no longer exists in App Store Connect, its key will be removed`);
      result.stale.push(id);
      continue;
    }
    if (!certificateMatchesKey(certificate.content, key)) {
      log.warn(`${id}: stored key does not match the certificate, it will be removed`);
      result.stale.push(id);
      continue;
    }
    const identity = { certificate, key };
    if (certificate.expirationDate > now) {
      result.usable.push(identity);
    } else {
      result.expired.push(identity);
    }
  }

  result.usable.sort((a, b) => b.certificate.expirationDate.getTime() - a.certificate.expirationDate.getTime());
  return result;
}

async function revokeQuietly(api: SigningApi, certificate: Certificate): Promise<boolean> {
  try {
    log.info(`Revoking ${label(certificate)} (expires ${formatDate(certificate.expirationDate)})`);
    await api.revokeCertificate(certificate.id);
    return true;
  } catch (error) {
    if (error instanceof AppStoreConnectApiError && error.status === 404) return true;
    log.warn(`Could not revoke ${certificate.id}: ${(error as Error).message}`);
    return false;
  }
}

function removeEntries(ids: string[]): (entries: Map<string, string>) => Map<string, string> | undefined {
  return (entries) => {
    let changed = false;
    for (const id of ids) changed = entries.delete(id) || changed;
    return changed ? entries : undefined;
  };
}

async function loadState(
  context: SigningContext,
): Promise<{ certificates: Certificate[]; entries: Map<string, string>; classification: Classification }> {
  log.step('Fetching development certificates from App Store Connect');
  const certificates = await context.api.listCertificates('DEVELOPMENT');
  const apiCreated = certificates.filter(isApiCreated);
  log.info(`Found ${certificates.length} development certificate(s), ${apiCreated.length} created via the API`);

  log.step(`Reading signing keys from ${await context.store.describe()} (${STORE_REF})`);
  const { entries } = await context.store.read();
  log.info(entries.size === 0 ? 'No keys stored yet' : `Found ${entries.size} stored key(s)`);

  const classification = classifyEntries(entries, certificates, context.apiKey, context.now?.() ?? new Date());
  if (classification.foreign.length > 0) {
    log.info(`${classification.foreign.length} key(s) belong to other App Store Connect API keys, keeping them`);
  }
  return { certificates, entries, classification };
}

/**
 * Finds a valid development identity whose private key lives in the hidden ref, or creates one.
 * New certificates are only created after write access to the ref is confirmed, and are
 * revoked again if their key cannot be stored, so builds never leave orphaned certificates behind.
 */
export async function ensureIdentity(context: SigningContext): Promise<Identity> {
  const { api, store, apiKey } = context;
  const { classification } = await loadState(context);
  const { usable, expired, stale } = classification;

  const current = usable[0];
  if (current) {
    log.success(`Using certificate ${label(current.certificate)}, valid until ${formatDate(current.certificate.expirationDate)}`);
    if (expired.length > 0 || stale.length > 0) {
      log.step('Cleaning up expired and stale keys');
      try {
        const revoked: string[] = [];
        for (const identity of expired) {
          if (await revokeQuietly(api, identity.certificate)) revoked.push(identity.certificate.id);
        }
        await store.update(removeEntries([...revoked, ...stale]));
      } catch (error) {
        log.warn(`Cleanup skipped: ${(error as Error).message}`);
      }
    }
    return current;
  }

  log.step(
    expired.length > 0 ? 'Stored certificates have expired, creating a new one' : 'No usable certificate stored, creating a new one',
  );
  log.info(`Checking write access to ${await store.describe()}`);
  await store.assertWritable();

  const revoked: string[] = [];
  for (const identity of expired) {
    if (await revokeQuietly(api, identity.certificate)) revoked.push(identity.certificate.id);
  }

  log.info('Generating RSA 2048 key and certificate signing request');
  const key = await generateSigningKey();
  const certificate = await api.createCertificate(createCsr(key), 'DEVELOPMENT');
  log.success(`Created certificate ${label(certificate)}, valid until ${formatDate(certificate.expirationDate)}`);

  try {
    if (!certificateMatchesKey(certificate.content, key)) {
      throw new SwiftlaneError(`App Store Connect returned certificate ${certificate.id} that does not match the generated key`);
    }
    log.info(`Encrypting the private key and pushing it to ${STORE_REF}`);
    const encrypted = encrypt(Buffer.from(privateKeyToPem(key)), apiKey.key, apiKey.keyId, certificate.id);
    await store.update((entries) => {
      for (const id of [...revoked, ...stale]) entries.delete(id);
      entries.set(certificate.id, encrypted);
      return entries;
    });
  } catch (error) {
    log.error(`Could not store the key for ${certificate.id}, revoking the certificate so it does not linger`);
    await revokeQuietly(api, certificate);
    throw error;
  }
  log.success('Key stored');
  return { certificate, key };
}

export interface RevokeOptions {
  /** Also revoke API-created development certificates that have no key in the ref. */
  all?: boolean;
  dryRun?: boolean;
}

export async function revokeIdentities(context: SigningContext, options: RevokeOptions): Promise<{ revoked: string[]; remaining: number }> {
  const { api, store } = context;
  const { certificates, entries, classification } = await loadState(context);

  const ours = [...classification.usable, ...classification.expired].map((identity) => identity.certificate);
  const orphans = options.all ? certificates.filter((certificate) => isApiCreated(certificate) && !entries.has(certificate.id)) : [];
  const targets = [...ours, ...orphans];
  const toRemove = [...ours.map((certificate) => certificate.id), ...classification.stale];

  if (targets.length === 0 && toRemove.length === 0) {
    log.success('Nothing to revoke');
    return { revoked: [], remaining: entries.size };
  }

  if (options.dryRun) {
    for (const certificate of targets) log.info(`Would revoke ${label(certificate)}`);
    for (const id of toRemove) log.info(`Would remove key ${id} from ${STORE_REF}`);
    return { revoked: [], remaining: entries.size - toRemove.length };
  }

  if (toRemove.length > 0) {
    log.info(`Checking write access to ${await store.describe()}`);
    await store.assertWritable();
  }

  log.step(`Revoking ${targets.length} certificate(s)`);
  const revoked: string[] = [];
  for (const certificate of targets) {
    if (await revokeQuietly(api, certificate)) revoked.push(certificate.id);
  }

  const removable = toRemove.filter((id) => revoked.includes(id) || classification.stale.includes(id));
  let remaining = entries.size;
  if (removable.length > 0) {
    log.step(`Removing ${removable.length} key(s) from ${STORE_REF}`);
    const snapshot = await store.update(removeEntries(removable));
    remaining = snapshot.entries.size;
    log.info(remaining === 0 ? `No keys left, ${STORE_REF} was deleted` : `${remaining} key(s) of other API keys kept`);
  }
  return { revoked, remaining };
}

async function withTempFile<T>(name: string, data: Buffer, fn: (file: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'swiftlane-'));
  try {
    const file = path.join(directory, name);
    writeFileSync(file, data, { mode: 0o600 });
    return await fn(file);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Codesign needs the issuing WWDR intermediate to build the chain, fresh machines do not always have it. */
async function ensureIntermediate(info: CertificateInfo, keychainPath: string): Promise<void> {
  const present = (await findCertificates(info.issuerCommonName)).some((pem) => {
    try {
      return new X509Certificate(pem).subject === info.issuer;
    } catch {
      return false;
    }
  });
  if (present) {
    log.debug(`Intermediate certificate "${info.issuerCommonName}" ${info.issuerOrganizationalUnit ?? ''} already installed`);
    return;
  }

  const url = info.issuerOrganizationalUnit ? WWDR_INTERMEDIATES[info.issuerOrganizationalUnit] : undefined;
  if (!url) {
    log.warn(`Intermediate certificate "${info.issuer.replace(/\n/g, ', ')}" is missing and swiftlane does not know where to get it`);
    return;
  }
  log.info(`Installing missing intermediate certificate ${info.issuerCommonName} (${info.issuerOrganizationalUnit}) from ${url}`);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const der = Buffer.from(await response.arrayBuffer());
    if (new X509Certificate(der).subject !== info.issuer) throw new Error('downloaded certificate does not match the issuer');
    await withTempFile('intermediate.cer', der, (file) => importCertificate(keychainPath, file));
  } catch (error) {
    log.warn(`Could not install the intermediate certificate: ${(error as Error).message}`);
  }
}

export interface InstallOptions {
  keychainPath: string;
  password: string;
  /** For a keychain swiftlane manages, a wrong password is an error; for the user's default one only a warning. */
  strict: boolean;
}

export async function installIdentity(identity: Identity, options: InstallOptions): Promise<CertificateInfo> {
  const { keychainPath, password, strict } = options;
  const info = describeCertificate(identity.certificate.content);
  log.step(`Importing "${info.commonName}" into ${keychainPath}`);

  try {
    await unlockKeychain(keychainPath, password);
  } catch (error) {
    if (strict) throw error;
    log.warn(`Could not unlock ${keychainPath} with the given password, assuming it is already unlocked`);
  }

  if ((await codesigningIdentities(keychainPath)).has(info.sha1)) {
    log.info('Identity is already in the keychain');
  } else {
    const p12 = createPkcs12(identity.certificate.content, identity.key, info.commonName);
    const imported = await withTempFile('identity.p12', p12.data, (file) => importPkcs12(keychainPath, file, p12.passphrase));
    log.info(imported ? 'Identity imported' : 'Identity was already in the keychain but not trusted yet');
  }

  try {
    await setKeyPartitionList(keychainPath, password);
  } catch (error) {
    if (strict) throw error;
    log.warn('Could not set the key partition list, codesign may ask for keychain access');
    log.hint('Pass the keychain password with -p / --password, or use a dedicated keychain (swiftlane keychain init)');
  }

  await ensureIntermediate(info, keychainPath);
  if (!(await codesigningIdentities(keychainPath)).has(info.sha1)) {
    log.warn(`"${info.commonName}" is in the keychain but macOS does not report it as a valid signing identity`);
    log.hint(`Check the certificate chain with: security find-identity -p codesigning ${keychainPath}`);
  }
  log.success(`Signing identity ready: ${info.commonName} (${info.sha1})`);
  return info;
}
