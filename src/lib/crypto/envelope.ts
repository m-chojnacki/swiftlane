import { createCipheriv, createDecipheriv, hkdfSync, type KeyObject, randomBytes } from 'node:crypto';
import { SwiftlaneError } from '../errors.ts';

const VERSION = 1;
const INFO = Buffer.from('swiftlane/signing-key/v1');

/**
 * What is stored in the hidden ref for every certificate. Only the ciphertext is secret;
 * `keyId` is informational so other API keys can tell early that an entry is not theirs.
 */
export interface Envelope {
  version: typeof VERSION;
  keyId: string;
  kdf: 'HKDF-SHA256';
  cipher: 'AES-256-GCM';
  salt: string;
  iv: string;
  tag: string;
  ciphertext: string;
}

export class DecryptionError extends SwiftlaneError {}

/** The EC private scalar is the stable secret behind every encoding of the same .p8 file. */
function keyMaterial(apiKey: KeyObject): Buffer {
  const jwk = apiKey.export({ format: 'jwk' });
  if (!jwk.d) throw new SwiftlaneError('The App Store Connect key is not a private key');
  return Buffer.from(jwk.d, 'base64url');
}

function deriveKey(apiKey: KeyObject, salt: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', keyMaterial(apiKey), salt, INFO, 32));
}

/** `associatedData` binds the ciphertext to its entry name, so entries cannot be swapped around in the ref. */
export function encrypt(plaintext: Buffer, apiKey: KeyObject, keyId: string, associatedData: string): string {
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(apiKey, salt), iv);
  cipher.setAAD(Buffer.from(associatedData));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const envelope: Envelope = {
    version: VERSION,
    keyId,
    kdf: 'HKDF-SHA256',
    cipher: 'AES-256-GCM',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
  return `${JSON.stringify(envelope, null, 2)}\n`;
}

export function parseEnvelope(serialized: string): Envelope {
  let envelope: Partial<Envelope>;
  try {
    envelope = JSON.parse(serialized) as Partial<Envelope>;
  } catch {
    throw new DecryptionError('Entry is not a swiftlane envelope');
  }
  if (envelope.version !== VERSION || !envelope.salt || !envelope.iv || !envelope.tag || !envelope.ciphertext) {
    throw new DecryptionError(`Unsupported envelope version ${String(envelope.version)}`);
  }
  return envelope as Envelope;
}

export function decrypt(serialized: string, apiKey: KeyObject, associatedData: string): Buffer {
  const envelope = parseEnvelope(serialized);
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      deriveKey(apiKey, Buffer.from(envelope.salt, 'base64')),
      Buffer.from(envelope.iv, 'base64'),
    );
    decipher.setAAD(Buffer.from(associatedData));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
  } catch {
    throw new DecryptionError('Entry was encrypted with a different App Store Connect API key');
  }
}
