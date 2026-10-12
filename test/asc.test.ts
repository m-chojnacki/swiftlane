import assert from 'node:assert/strict';
import { createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { AppStoreConnectApiError, AppStoreConnectClient, type Certificate, createToken, isApiCreated } from '../src/lib/asc/client.ts';
import { loadApiKey, parsePrivateKey, withApiKeyFile } from '../src/lib/asc/key.ts';
import { createApiKey } from './helpers.ts';

describe('parsePrivateKey', () => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const der = privateKey.export({ type: 'pkcs8', format: 'der' });
  const d = privateKey.export({ format: 'jwk' }).d;
  const same = (input: string): void => assert.equal(parsePrivateKey(input).export({ format: 'jwk' }).d, d);

  it('accepts PEM contents, also with escaped newlines', () => {
    same(pem);
    same(pem.replace(/\n/g, '\\n'));
    same(`  ${pem}  `);
  });

  it('accepts base64-encoded .p8 files and raw DER', () => {
    same(Buffer.from(pem).toString('base64'));
    same(der.toString('base64'));
  });

  it('accepts a path to the .p8 file', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'swiftlane-key-test-'));
    try {
      const file = path.join(directory, 'AuthKey_TEST.p8');
      writeFileSync(file, pem);
      same(file);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('rejects garbage and non P-256 keys', () => {
    assert.throws(() => parsePrivateKey('definitely not a key'), /Could not read/);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    assert.throws(() => parsePrivateKey(rsa), /EC P-256/);
  });
});

describe('loadApiKey', () => {
  it('lists every missing option', () => {
    assert.throws(() => loadApiKey({}), /--private-key.*--key-identifier.*--issuer-id/);
  });

  it('writes the key file only for the duration of the callback', async () => {
    const apiKey = createApiKey('ABC123');
    let seen = '';
    await withApiKeyFile(apiKey, async (file) => {
      seen = file.path;
      assert.equal(path.basename(file.path), 'AuthKey_ABC123.p8');
      assert.equal(parsePrivateKey(file.path).export({ format: 'jwk' }).d, apiKey.key.export({ format: 'jwk' }).d);
    });
    assert.throws(() => parsePrivateKey(seen));
  });
});

describe('createToken', () => {
  it('creates an ES256 token App Store Connect accepts', () => {
    const apiKey = createApiKey('KEY1234567');
    const token = createToken(apiKey, 1_000_000);
    const [header, payload, signature] = token.split('.') as [string, string, string];
    assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { alg: 'ES256', kid: 'KEY1234567', typ: 'JWT' });
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString());
    assert.equal(claims.aud, 'appstoreconnect-v1');
    assert.equal(claims.iss, apiKey.issuerId);
    assert.ok(claims.exp - claims.iat <= 20 * 60);
    const signatureBytes = Buffer.from(signature, 'base64url');
    assert.equal(signatureBytes.length, 64, 'JWS uses raw r||s, not DER');
    assert.ok(
      verify(
        'sha256',
        Buffer.from(`${header}.${payload}`),
        { key: createPublicKey(apiKey.key), dsaEncoding: 'ieee-p1363' },
        signatureBytes,
      ),
    );
  });
});

describe('AppStoreConnectClient', () => {
  function resource(id: string, name = 'Apple Development: Created via API (TEAM)') {
    return {
      type: 'certificates',
      id,
      attributes: {
        name,
        displayName: 'Created via API',
        certificateType: 'DEVELOPMENT',
        serialNumber: id,
        expirationDate: '2030-01-01T00:00:00.000+0000',
        certificateContent: 'AQID',
      },
    };
  }

  function mockFetch(handler: (url: string, init: RequestInit) => Response) {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return handler(String(url), init ?? {});
    }) as typeof fetch;
    return { calls, fetchImpl };
  }

  it('follows pagination when listing certificates', async () => {
    const { calls, fetchImpl } = mockFetch((url) =>
      url.includes('cursor=2')
        ? Response.json({ data: [resource('B')] })
        : Response.json({ data: [resource('A')], links: { next: 'https://api.appstoreconnect.apple.com/v1/certificates?cursor=2' } }),
    );
    const certificates = await new AppStoreConnectClient(createApiKey(), fetchImpl).listCertificates('DEVELOPMENT');
    assert.deepEqual(
      certificates.map((certificate) => certificate.id),
      ['A', 'B'],
    );
    assert.match(calls[0]!.url, /filter%5BcertificateType%5D=DEVELOPMENT/);
    assert.match(String((calls[0]!.init.headers as Record<string, string>).Authorization), /^Bearer ey/);
    assert.deepEqual(certificates[0]!.content, Buffer.from([1, 2, 3]));
    assert.equal(certificates[0]!.expirationDate.toISOString(), '2030-01-01T00:00:00.000Z');
  });

  it('sends the CSR without PEM armor', async () => {
    const { calls, fetchImpl } = mockFetch(() => Response.json({ data: resource('NEW') }, { status: 201 }));
    const csr = '-----BEGIN CERTIFICATE REQUEST-----\nMIIB\nAAAA\n-----END CERTIFICATE REQUEST-----\n';
    await new AppStoreConnectClient(createApiKey(), fetchImpl).createCertificate(csr, 'DEVELOPMENT');
    assert.equal(calls[0]!.init.method, 'POST');
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), {
      data: { type: 'certificates', attributes: { csrContent: 'MIIBAAAA', certificateType: 'DEVELOPMENT' } },
    });
  });

  it('turns API errors into readable messages with hints', async () => {
    const { fetchImpl } = mockFetch(() =>
      Response.json(
        { errors: [{ status: '403', title: 'Forbidden', detail: 'The API key in use does not allow this request' }] },
        { status: 403 },
      ),
    );
    const client = new AppStoreConnectClient(createApiKey(), fetchImpl);
    await assert.rejects(client.revokeCertificate('X'), (error: unknown) => {
      assert.ok(error instanceof AppStoreConnectApiError);
      assert.equal(error.status, 403);
      assert.match(error.message, /DELETE \/v1\/certificates\/X failed with HTTP 403: Forbidden: The API key in use/);
      assert.ok(error.hint);
      return true;
    });
  });

  it('recognizes API-created certificates', () => {
    const base: Certificate = {
      id: '1',
      name: '',
      displayName: '',
      certificateType: 'DEVELOPMENT',
      serialNumber: '',
      platform: undefined,
      expirationDate: new Date(),
      content: Buffer.alloc(0),
    };
    assert.ok(isApiCreated({ ...base, name: 'Apple Development: Created via API (ABCDE12345)' }));
    assert.ok(isApiCreated({ ...base, displayName: 'Created via API' }));
    assert.ok(!isApiCreated({ ...base, name: 'Apple Development: Jane Doe (ABCDE12345)', displayName: 'Jane Doe' }));
  });
});
