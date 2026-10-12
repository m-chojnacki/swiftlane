import { createPrivateKey, generateKeyPair, type KeyObject, randomBytes, X509Certificate } from 'node:crypto';
import { promisify } from 'node:util';
import forge from 'node-forge';
import { SwiftlaneError } from '../errors.ts';

const generateKeyPairAsync = promisify(generateKeyPair);

/** Apple only signs CSRs backed by 2048-bit RSA keys. */
export async function generateSigningKey(): Promise<KeyObject> {
  const { privateKey } = await generateKeyPairAsync('rsa', { modulusLength: 2048, publicExponent: 0x10001 });
  return privateKey;
}

export function privateKeyToPem(key: KeyObject): string {
  return key.export({ type: 'pkcs8', format: 'pem' }).toString();
}

export function privateKeyFromPem(pem: string | Buffer): KeyObject {
  return createPrivateKey({ key: pem, format: 'pem' });
}

function toForgeKey(key: KeyObject): forge.pki.rsa.PrivateKey {
  return forge.pki.privateKeyFromPem(key.export({ type: 'pkcs1', format: 'pem' }).toString());
}

/** Apple rewrites the subject when issuing, so it only matters for debugging rejected requests. */
export function createCsr(key: KeyObject, commonName = 'swiftlane'): string {
  const forgeKey = toForgeKey(key);
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = forge.pki.setRsaPublicKey(forgeKey.n, forgeKey.e);
  csr.setSubject([{ name: 'commonName', value: commonName }]);
  csr.sign(forgeKey, forge.md.sha256.create());
  return forge.pki.certificationRequestToPem(csr);
}

export interface CertificateInfo {
  /** Uppercase hex without separators, the format `security find-identity` prints. */
  sha1: string;
  subject: string;
  commonName: string;
  issuer: string;
  issuerCommonName: string;
  issuerOrganizationalUnit: string | undefined;
  validTo: Date;
}

function field(distinguishedName: string, name: string): string | undefined {
  return distinguishedName
    .split('\n')
    .find((line) => line.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}

export function describeCertificate(der: Buffer): CertificateInfo {
  const certificate = new X509Certificate(der);
  return {
    sha1: certificate.fingerprint.replace(/:/g, '').toUpperCase(),
    subject: certificate.subject,
    commonName: field(certificate.subject, 'CN') ?? certificate.subject,
    issuer: certificate.issuer,
    issuerCommonName: field(certificate.issuer, 'CN') ?? certificate.issuer,
    issuerOrganizationalUnit: field(certificate.issuer, 'OU'),
    validTo: new Date(certificate.validTo),
  };
}

export function certificateMatchesKey(der: Buffer, key: KeyObject): boolean {
  try {
    return new X509Certificate(der).checkPrivateKey(key);
  } catch {
    return false;
  }
}

export function certificateToPem(der: Buffer): string {
  return new X509Certificate(der).toString();
}

/**
 * Bundles the identity for `security import`. macOS still chokes on PKCS#12 files using
 * modern PBES2/AES encryption, so this sticks to 3DES + SHA-1 MAC which every version accepts,
 * and always uses a passphrase because empty ones fail MAC verification on some releases.
 */
export function createPkcs12(certificateDer: Buffer, key: KeyObject, friendlyName: string): { data: Buffer; passphrase: string } {
  const passphrase = randomBytes(24).toString('base64url');
  let certificate: forge.pki.Certificate;
  try {
    certificate = forge.pki.certificateFromAsn1(forge.asn1.fromDer(certificateDer.toString('binary')));
  } catch (error) {
    throw new SwiftlaneError(`Could not parse certificate: ${(error as Error).message}`, { cause: error });
  }
  const asn1 = forge.pkcs12.toPkcs12Asn1(toForgeKey(key), [certificate], passphrase, {
    algorithm: '3des',
    friendlyName,
    generateLocalKeyId: true,
  });
  return { data: Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary'), passphrase };
}
