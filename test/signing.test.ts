import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { ApiKey } from '../src/lib/asc/key.ts';
import { decrypt, encrypt } from '../src/lib/crypto/envelope.ts';
import { certificateMatchesKey, createCsr, generateSigningKey, privateKeyFromPem } from '../src/lib/crypto/identity.ts';
import { CertificateStore, STORE_REF } from '../src/lib/git/store.ts';
import { classifyEntries, ensureIdentity, revokeIdentities, type SigningContext } from '../src/lib/signing.ts';
import { createApiKey, createGitFixture, FakeApi, type GitFixture } from './helpers.ts';

describe('signing workflow', () => {
  let fixture: GitFixture;
  let api: FakeApi;
  let apiKey: ApiKey;
  let run = 0;

  before(() => {
    fixture = createGitFixture();
  });
  after(() => fixture.cleanup());
  beforeEach(() => {
    api = new FakeApi();
    apiKey = createApiKey();
    try {
      fixture.git(fixture.bare, 'update-ref', '-d', STORE_REF);
    } catch {
      // ref did not exist
    }
  });

  /** Every call simulates a separate CI job with a fresh checkout. */
  function context(overrides: Partial<SigningContext> = {}): SigningContext {
    return { apiKey, api, store: new CertificateStore({ cwd: fixture.checkout(`job-${++run}`) }), ...overrides };
  }

  async function storedEntries(): Promise<Map<string, string>> {
    return (await new CertificateStore({ cwd: fixture.checkout(`inspect-${++run}`) }).read()).entries;
  }

  it('creates a certificate and stores its encrypted key when the ref is empty', async () => {
    const identity = await ensureIdentity(context());
    assert.deepEqual(api.created, [identity.certificate.id]);
    assert.ok(certificateMatchesKey(identity.certificate.content, identity.key));

    const entries = await storedEntries();
    assert.deepEqual([...entries.keys()], [identity.certificate.id]);
    const stored = privateKeyFromPem(decrypt(entries.get(identity.certificate.id)!, apiKey.key, identity.certificate.id));
    assert.ok(certificateMatchesKey(identity.certificate.content, stored));
  });

  it('reuses the stored certificate on the next run without writing', async () => {
    const first = await ensureIdentity(context());
    const commit = fixture.git(fixture.bare, 'rev-parse', STORE_REF);
    const second = await ensureIdentity(context());
    assert.equal(second.certificate.id, first.certificate.id);
    assert.deepEqual(api.created, [first.certificate.id]);
    assert.equal(fixture.git(fixture.bare, 'rev-parse', STORE_REF), commit);
  });

  it('works with a read-only remote while the certificate is valid', async () => {
    await ensureIdentity(context());
    const cwd = fixture.checkout(`readonly-${++run}`);
    fixture.git(cwd, 'remote', 'set-url', '--push', 'origin', `${fixture.root}/missing.git`);
    const identity = await ensureIdentity(context({ store: new CertificateStore({ cwd }) }));
    assert.equal(api.created.length, 1);
    assert.ok(identity);
  });

  it('revokes and replaces an expired certificate', async () => {
    const old = await ensureIdentity(context());
    api.certificates.get(old.certificate.id)!.expirationDate = new Date(Date.now() - 1000);

    const fresh = await ensureIdentity(context());
    assert.notEqual(fresh.certificate.id, old.certificate.id);
    assert.deepEqual(api.revoked, [old.certificate.id]);
    assert.deepEqual([...(await storedEntries()).keys()], [fresh.certificate.id]);
  });

  it('keeps keys of other API keys and removes stale keys of its own', async () => {
    const otherKey = createApiKey('OTHERKEY99');
    const otherTeam = await ensureIdentity(context({ apiKey: otherKey, api: new FakeApi() }));

    const mine = await ensureIdentity(context());
    // The certificate disappears from the portal, e.g. revoked by hand.
    api.certificates.delete(mine.certificate.id);

    const replacement = await ensureIdentity(context());
    const keys = [...(await storedEntries()).keys()].sort();
    assert.deepEqual(keys, [otherTeam.certificate.id, replacement.certificate.id].sort());
  });

  it('cleans up expired keys when a valid one exists, without creating anything', async () => {
    const valid = await ensureIdentity(context());
    const expiredKey = await generateSigningKey();
    const expired = await api.createCertificate(createCsr(expiredKey), 'DEVELOPMENT');
    expired.expirationDate = new Date(Date.now() - 1000);
    await context().store.update((entries) =>
      entries.set(
        expired.id,
        encrypt(Buffer.from(expiredKey.export({ type: 'pkcs8', format: 'pem' }).toString()), apiKey.key, apiKey.keyId, expired.id),
      ),
    );
    const createdBefore = api.created.length;

    const identity = await ensureIdentity(context());
    assert.equal(identity.certificate.id, valid.certificate.id);
    assert.equal(api.created.length, createdBefore);
    assert.deepEqual(api.revoked, [expired.id]);
    assert.deepEqual([...(await storedEntries()).keys()], [valid.certificate.id]);
  });

  it('refuses to create a certificate without write access', async () => {
    const cwd = fixture.checkout(`no-write-${++run}`);
    fixture.git(cwd, 'remote', 'set-url', '--push', 'origin', `${fixture.root}/missing.git`);
    await assert.rejects(ensureIdentity(context({ store: new CertificateStore({ cwd }) })), /No write access/);
    assert.deepEqual(api.created, []);
  });

  it('revokes the new certificate when its key cannot be stored', async () => {
    const store = new CertificateStore({ cwd: fixture.checkout(`push-fails-${++run}`) });
    const failing = Object.assign(Object.create(store) as CertificateStore, {
      read: () => store.read(),
      describe: () => store.describe(),
      assertWritable: () => store.assertWritable(),
      update: async () => {
        throw new Error('push rejected');
      },
    });
    await assert.rejects(ensureIdentity(context({ store: failing })), /push rejected/);
    assert.equal(api.created.length, 1);
    assert.deepEqual(api.revoked, api.created);
    assert.equal(api.certificates.size, 0);
  });

  it('revoke removes only its own certificates and keys', async () => {
    const otherApi = new FakeApi();
    const otherKey = createApiKey('OTHERKEY99');
    const other = await ensureIdentity(context({ apiKey: otherKey, api: otherApi }));
    const mine = await ensureIdentity(context());

    const dry = await revokeIdentities(context(), { dryRun: true });
    assert.deepEqual(dry.revoked, []);
    assert.deepEqual(api.revoked, []);

    const result = await revokeIdentities(context(), {});
    assert.deepEqual(result.revoked, [mine.certificate.id]);
    assert.equal(result.remaining, 1);
    assert.deepEqual([...(await storedEntries()).keys()], [other.certificate.id]);

    await revokeIdentities(context({ apiKey: otherKey, api: otherApi }), {});
    assert.equal(fixture.git(fixture.bare, 'for-each-ref', STORE_REF), '', 'ref is deleted once empty');
  });

  it('revoke --all also revokes API-created certificates without keys', async () => {
    await ensureIdentity(context());
    const orphan = await api.createCertificate(createCsr(await generateSigningKey()), 'DEVELOPMENT');
    const manual = await api.createCertificate(createCsr(await generateSigningKey()), 'DEVELOPMENT');
    manual.name = 'Apple Development: Jane Doe (ABCDE12345)';
    manual.displayName = 'Jane Doe';

    const result = await revokeIdentities(context(), { all: true });
    assert.ok(result.revoked.includes(orphan.id));
    assert.ok(!result.revoked.includes(manual.id), 'certificates made by people are never touched');
    assert.deepEqual([...api.certificates.keys()], [manual.id]);
  });
});

describe('classifyEntries', () => {
  it('sorts usable identities by expiration', async () => {
    const api = new FakeApi();
    const apiKey = createApiKey();
    const entries = new Map<string, string>();
    const ids: string[] = [];
    for (const days of [30, 300, 100]) {
      api.validity = days * 86_400_000;
      const key = await generateSigningKey();
      const certificate = await api.createCertificate(createCsr(key), 'DEVELOPMENT');
      entries.set(
        certificate.id,
        encrypt(Buffer.from(key.export({ type: 'pkcs8', format: 'pem' }).toString()), apiKey.key, apiKey.keyId, certificate.id),
      );
      ids.push(certificate.id);
    }
    const result = classifyEntries(entries, await api.listCertificates(), apiKey, new Date());
    assert.deepEqual(
      result.usable.map((identity) => identity.certificate.id),
      [ids[1], ids[2], ids[0]],
    );
  });

  it('treats a key that does not match its certificate as stale', async () => {
    const api = new FakeApi();
    const apiKey = createApiKey();
    const certificate = await api.createCertificate(createCsr(await generateSigningKey()), 'DEVELOPMENT');
    const wrongKey = await generateSigningKey();
    const entries = new Map([
      [
        certificate.id,
        encrypt(Buffer.from(wrongKey.export({ type: 'pkcs8', format: 'pem' }).toString()), apiKey.key, apiKey.keyId, certificate.id),
      ],
    ]);
    const result = classifyEntries(entries, await api.listCertificates(), apiKey, new Date());
    assert.deepEqual(result.stale, [certificate.id]);
  });
});
