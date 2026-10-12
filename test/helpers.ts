import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import forge from 'node-forge';
import type { Certificate, CertificateType } from '../src/lib/asc/client.ts';
import type { ApiKey } from '../src/lib/asc/key.ts';
import type { SigningApi } from '../src/lib/signing.ts';

export function createApiKey(keyId = 'TESTKEY123'): ApiKey {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return {
    keyId,
    issuerId: '00000000-0000-0000-0000-000000000000',
    key: privateKey,
    pem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

const caKeys = (() => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return forge.pki.privateKeyFromPem(privateKey.export({ type: 'pkcs1', format: 'pem' }).toString());
})();

const WWDR_SUBJECT = [
  { name: 'commonName', value: 'Apple Worldwide Developer Relations Certification Authority' },
  { name: 'organizationalUnitName', value: 'G3' },
  { name: 'organizationName', value: 'Apple Inc.' },
  { name: 'countryName', value: 'US' },
];

/** Self-signed stand-in for the WWDR intermediate that issues every fake certificate. */
export const fakeWwdrPem = (() => {
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = forge.pki.setRsaPublicKey(caKeys.n, caKeys.e);
  certificate.serialNumber = '01';
  certificate.validity.notAfter = new Date(Date.now() + 365 * 86_400_000);
  certificate.setSubject(WWDR_SUBJECT);
  certificate.setIssuer(WWDR_SUBJECT);
  certificate.sign(caKeys, forge.md.sha256.create());
  return forge.pki.certificateToPem(certificate);
})();

/** Signs the public key of a CSR the way the developer portal would, with a fake WWDR CA. */
export function issueCertificate(csrPem: string, expiresAt: Date, commonName = 'Apple Development: Created via API (TEAM123456)'): Buffer {
  const csr = forge.pki.certificationRequestFromPem(csrPem);
  if (!csr.verify()) throw new Error('CSR signature is invalid');
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = csr.publicKey!;
  certificate.serialNumber = `01${randomBytes(8).toString('hex')}`;
  certificate.validity.notBefore = new Date(Date.now() - 60_000);
  certificate.validity.notAfter = expiresAt;
  certificate.setSubject([
    { name: 'commonName', value: commonName },
    { name: 'organizationalUnitName', value: 'TEAM123456' },
    { name: 'countryName', value: 'US' },
  ]);
  certificate.setIssuer(WWDR_SUBJECT);
  certificate.sign(caKeys, forge.md.sha256.create());
  return Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(certificate)).getBytes(), 'binary');
}

// Certificate IDs are unique across teams in App Store Connect, so across fakes too.
let certificateCounter = 0;

/** In-memory stand-in for the certificates endpoints of the App Store Connect API. */
export class FakeApi implements SigningApi {
  certificates = new Map<string, Certificate>();
  revoked: string[] = [];
  created: string[] = [];
  validity = 365 * 24 * 60 * 60 * 1000;

  async listCertificates(type?: CertificateType): Promise<Certificate[]> {
    return [...this.certificates.values()].filter((certificate) => !type || certificate.certificateType === type);
  }

  async createCertificate(csrPem: string, certificateType: CertificateType): Promise<Certificate> {
    const id = `CERT${String(++certificateCounter).padStart(6, '0')}`;
    const expirationDate = new Date(Date.now() + this.validity);
    const certificate: Certificate = {
      id,
      name: 'Apple Development: Created via API',
      displayName: 'Created via API',
      certificateType,
      serialNumber: id,
      platform: undefined,
      expirationDate,
      content: issueCertificate(csrPem, expirationDate),
    };
    this.certificates.set(id, certificate);
    this.created.push(id);
    return certificate;
  }

  async revokeCertificate(id: string): Promise<void> {
    this.certificates.delete(id);
    this.revoked.push(id);
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

export interface GitFixture {
  root: string;
  bare: string;
  /** Creates a fresh clone-like repository pointing at the bare remote, as a separate CI job would have. */
  checkout(name: string): string;
  git(cwd: string, ...args: string[]): string;
  cleanup(): void;
}

export function createGitFixture(): GitFixture {
  const root = mkdtempSync(path.join(os.tmpdir(), 'swiftlane-test-'));
  const bare = path.join(root, 'remote.git');
  git(root, 'init', '--bare', '--quiet', bare);
  return {
    root,
    bare,
    checkout(name) {
      const directory = path.join(root, name);
      git(root, 'init', '--quiet', directory);
      git(directory, 'remote', 'add', 'origin', bare);
      return directory;
    },
    git,
    cleanup() {
      rmSync(root, { recursive: true, force: true });
    },
  };
}
