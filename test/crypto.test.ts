import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';
import forge from 'node-forge';
import { DecryptionError, decrypt, encrypt, parseEnvelope } from '../src/lib/crypto/envelope.ts';
import {
  certificateMatchesKey,
  createCsr,
  createPkcs12,
  describeCertificate,
  generateSigningKey,
  privateKeyFromPem,
  privateKeyToPem,
} from '../src/lib/crypto/identity.ts';
import { createApiKey, issueCertificate } from './helpers.ts';

describe('envelope', () => {
  const apiKey = createApiKey();
  const secret = Buffer.from('-----BEGIN PRIVATE KEY-----\nsecret\n-----END PRIVATE KEY-----\n');

  it('round-trips with the same API key', () => {
    const sealed = encrypt(secret, apiKey.key, apiKey.keyId, 'CERT1');
    assert.deepEqual(decrypt(sealed, apiKey.key, 'CERT1'), secret);
  });

  it('derives the same key from a re-encoded copy of the API key', () => {
    const sealed = encrypt(secret, apiKey.key, apiKey.keyId, 'CERT1');
    const reparsed = privateKeyFromPem(apiKey.key.export({ type: 'sec1', format: 'pem' }));
    assert.deepEqual(decrypt(sealed, reparsed, 'CERT1'), secret);
  });

  it('does not leak the plaintext and records only non-secret metadata', () => {
    const sealed = encrypt(secret, apiKey.key, apiKey.keyId, 'CERT1');
    assert.ok(!sealed.includes('secret'));
    const envelope = parseEnvelope(sealed);
    assert.equal(envelope.keyId, apiKey.keyId);
    assert.equal(envelope.cipher, 'AES-256-GCM');
  });

  it('uses a fresh salt and IV for every encryption', () => {
    const a = parseEnvelope(encrypt(secret, apiKey.key, apiKey.keyId, 'CERT1'));
    const b = parseEnvelope(encrypt(secret, apiKey.key, apiKey.keyId, 'CERT1'));
    assert.notEqual(a.salt, b.salt);
    assert.notEqual(a.iv, b.iv);
  });

  it('rejects a different API key', () => {
    const sealed = encrypt(secret, apiKey.key, apiKey.keyId, 'CERT1');
    assert.throws(() => decrypt(sealed, createApiKey().key, 'CERT1'), DecryptionError);
  });

  it('rejects an entry moved to another name', () => {
    const sealed = encrypt(secret, apiKey.key, apiKey.keyId, 'CERT1');
    assert.throws(() => decrypt(sealed, apiKey.key, 'CERT2'), DecryptionError);
  });

  it('rejects tampered ciphertext and garbage', () => {
    const envelope = parseEnvelope(encrypt(secret, apiKey.key, apiKey.keyId, 'CERT1'));
    const bytes = Buffer.from(envelope.ciphertext, 'base64');
    bytes[0]! ^= 1;
    const tampered = JSON.stringify({ ...envelope, ciphertext: bytes.toString('base64') });
    assert.throws(() => decrypt(tampered, apiKey.key, 'CERT1'), DecryptionError);
    assert.throws(() => decrypt('not json', apiKey.key, 'CERT1'), DecryptionError);
    assert.throws(() => decrypt('{"version":2}', apiKey.key, 'CERT1'), DecryptionError);
  });
});

describe('identity', () => {
  it('creates a valid RSA 2048 CSR', async () => {
    const key = await generateSigningKey();
    const csr = forge.pki.certificationRequestFromPem(createCsr(key));
    assert.ok(csr.verify());
    assert.equal((csr.publicKey as forge.pki.rsa.PublicKey).n.bitLength(), 2048);
  });

  it('matches issued certificates with their key only', async () => {
    const key = await generateSigningKey();
    const other = await generateSigningKey();
    const der = issueCertificate(createCsr(key), new Date(Date.now() + 86_400_000));
    assert.ok(certificateMatchesKey(der, key));
    assert.ok(!certificateMatchesKey(der, other));
    assert.ok(!certificateMatchesKey(Buffer.from('garbage'), key));
  });

  it('describes certificates the way security(1) reports them', async () => {
    const key = await generateSigningKey();
    const expires = new Date('2030-01-01T00:00:00Z');
    const info = describeCertificate(issueCertificate(createCsr(key), expires));
    assert.match(info.sha1, /^[0-9A-F]{40}$/);
    assert.equal(info.commonName, 'Apple Development: Created via API (TEAM123456)');
    assert.equal(info.issuerCommonName, 'Apple Worldwide Developer Relations Certification Authority');
    assert.equal(info.issuerOrganizationalUnit, 'G3');
    assert.equal(info.validTo.getTime(), expires.getTime());
  });

  it('round-trips keys through PEM', async () => {
    const key = await generateSigningKey();
    const restored = privateKeyFromPem(privateKeyToPem(key));
    assert.deepEqual(restored.export({ format: 'jwk' }), key.export({ format: 'jwk' }));
  });

  it('bundles a 3DES PKCS#12 that contains the identity', async () => {
    const key = await generateSigningKey();
    const der = issueCertificate(createCsr(key), new Date(Date.now() + 86_400_000));
    const { data, passphrase } = createPkcs12(der, key, 'Apple Development: Test');
    assert.ok(passphrase.length >= 24);

    const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(data.toString('binary')), passphrase);
    const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag! })[forge.pki.oids.pkcs8ShroudedKeyBag!] ?? [];
    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag! })[forge.pki.oids.certBag!] ?? [];
    assert.equal(keyBags.length, 1);
    assert.equal(certBags.length, 1);
    assert.equal(certBags[0]!.attributes.friendlyName?.[0], 'Apple Development: Test');
    const restoredKey = privateKeyFromPem(forge.pki.privateKeyToPem(keyBags[0]!.key!));
    assert.ok(certificateMatchesKey(der, restoredKey));
    assert.throws(() => forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(data.toString('binary')), 'wrong'));
  });

  it('refuses non-RSA keys in createPkcs12', () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    assert.throws(() => createPkcs12(Buffer.alloc(0), privateKey, 'x'));
  });
});
