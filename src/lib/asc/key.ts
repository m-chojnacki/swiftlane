import { createPrivateKey, type KeyObject } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SwiftlaneError } from '../errors.ts';

export const ENV_PRIVATE_KEY = 'APP_STORE_CONNECT_PRIVATE_KEY';
export const ENV_KEY_IDENTIFIER = 'APP_STORE_CONNECT_KEY_IDENTIFIER';
export const ENV_ISSUER_ID = 'APP_STORE_CONNECT_ISSUER_ID';

export interface ApiKey {
  keyId: string;
  issuerId: string;
  /** PKCS#8 PEM, normalized regardless of how the key was provided. */
  pem: string;
  key: KeyObject;
}

export interface ApiKeyOptions {
  privateKey?: string;
  keyIdentifier?: string;
  issuerId?: string;
}

function tryCreateKey(input: string | Buffer): KeyObject | undefined {
  try {
    return typeof input === 'string'
      ? createPrivateKey({ key: input, format: 'pem' })
      : createPrivateKey({ key: input, format: 'der', type: 'pkcs8' });
  } catch {
    return undefined;
  }
}

function fromPem(text: string): KeyObject | undefined {
  // Secrets pasted into CI variables frequently arrive with literal "\n" instead of newlines.
  return tryCreateKey(text.includes('\\n') ? text.replace(/\\n/g, '\n') : text);
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/** Accepts the .p8 contents, a base64-encoded .p8 (or raw PKCS#8 DER), or a path to the .p8 file. */
export function parsePrivateKey(input: string): KeyObject {
  const value = input.trim();
  let key: KeyObject | undefined;

  if (value.includes('-----BEGIN')) {
    key = fromPem(value);
  } else if (!value.includes('\n') && value.length < 4096 && isFile(value.replace(/^~(?=\/)/, os.homedir()))) {
    const contents = readFileSync(value.replace(/^~(?=\/)/, os.homedir()));
    key = fromPem(contents.toString('utf8')) ?? tryCreateKey(contents);
  } else if (/^[A-Za-z0-9+/=_\-\s]+$/.test(value)) {
    const decoded = Buffer.from(value.replace(/\s/g, ''), value.includes('-') || value.includes('_') ? 'base64url' : 'base64');
    const text = decoded.toString('utf8');
    key = text.includes('-----BEGIN') ? fromPem(text) : tryCreateKey(decoded);
  }

  if (!key) {
    throw new SwiftlaneError('Could not read the App Store Connect private key', {
      hint: 'Pass the .p8 file contents, its base64 encoding, or a path to the .p8 file',
    });
  }
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new SwiftlaneError('The App Store Connect private key must be an EC P-256 key (.p8 downloaded from App Store Connect)');
  }
  return key;
}

export function loadApiKey(options: ApiKeyOptions): ApiKey {
  const missing: string[] = [];
  if (!options.privateKey) missing.push(`--private-key (or $${ENV_PRIVATE_KEY})`);
  if (!options.keyIdentifier) missing.push(`--key-identifier (or $${ENV_KEY_IDENTIFIER})`);
  if (!options.issuerId) missing.push(`--issuer-id (or $${ENV_ISSUER_ID})`);
  if (missing.length > 0) {
    throw new SwiftlaneError(`Missing App Store Connect API key options: ${missing.join(', ')}`, {
      hint: 'Create a Team API key in App Store Connect → Users and Access → Integrations',
    });
  }
  const key = parsePrivateKey(options.privateKey!);
  return {
    keyId: options.keyIdentifier!.trim(),
    issuerId: options.issuerId!.trim(),
    key,
    pem: key.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/**
 * xcodebuild and altool only take the key as a file, so it lives in a private temp
 * directory for the duration of the callback and is removed afterwards, even on failure.
 */
export async function withApiKeyFile<T>(apiKey: ApiKey, fn: (file: { path: string; directory: string }) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'swiftlane-key-'));
  const keyPath = path.join(directory, `AuthKey_${apiKey.keyId}.p8`);
  const cleanup = (): void => rmSync(directory, { recursive: true, force: true });
  process.once('exit', cleanup);
  try {
    writeFileSync(keyPath, apiKey.pem, { mode: 0o600 });
    return await fn({ path: keyPath, directory });
  } finally {
    cleanup();
    process.off('exit', cleanup);
  }
}

/** xcodebuild flags that let it talk to the developer portal for automatic signing. */
export function xcodebuildAuthArgs(apiKey: ApiKey, keyPath: string): string[] {
  return [
    '-allowProvisioningUpdates',
    '-authenticationKeyPath',
    keyPath,
    '-authenticationKeyID',
    apiKey.keyId,
    '-authenticationKeyIssuerID',
    apiKey.issuerId,
  ];
}
