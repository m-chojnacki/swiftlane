import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { dropKeychain } from '../src/commands/keychain.ts';
import { createCsr, describeCertificate, generateSigningKey } from '../src/lib/crypto/identity.ts';
import { type RunResult, setRunner } from '../src/lib/exec.ts';
import {
  addToSearchList,
  assertCustomKeychain,
  codesigningIdentities,
  removeFromSearchList,
  resolveKeychainPath,
} from '../src/lib/keychain.ts';
import { installIdentity } from '../src/lib/signing.ts';
import { FakeApi, fakeWwdrPem } from './helpers.ts';

const keychains = path.join(os.homedir(), 'Library', 'Keychains');

/** Records `security` invocations instead of running them, so no real keychain is ever touched. */
function fakeSecurity(responder: (args: string[]) => Partial<RunResult> = () => ({})) {
  const calls: string[][] = [];
  setRunner(async (command, args) => {
    assert.equal(command, '/usr/bin/security', `unexpected command ${command}`);
    calls.push(args);
    return { code: 0, stdout: '', stderr: '', ...responder(args) };
  });
  return calls;
}

afterEach(() => setRunner(undefined));

describe('keychain paths', () => {
  it('resolves names into ~/Library/Keychains', () => {
    assert.equal(resolveKeychainPath('swiftlane-test-nonexistent'), path.join(keychains, 'swiftlane-test-nonexistent.keychain-db'));
    assert.equal(
      resolveKeychainPath('swiftlane-test-nonexistent.keychain'),
      path.join(keychains, 'swiftlane-test-nonexistent.keychain-db'),
    );
    assert.equal(resolveKeychainPath('/tmp/ci/build.keychain-db'), '/tmp/ci/build.keychain-db');
  });

  it('refuses system keychains', () => {
    for (const name of [
      'login',
      'login.keychain-db',
      'System',
      'iCloud',
      '/Library/Keychains/System.keychain',
      path.join(keychains, 'login.keychain-db'),
    ]) {
      assert.throws(() => assertCustomKeychain(name), /Refusing to manage system keychain/, name);
    }
    assert.doesNotThrow(() => assertCustomKeychain('swiftlane'));
  });
});

describe('search list', () => {
  const list = `    "${keychains}/login.keychain-db"\n    "/Library/Keychains/System.keychain"\n`;

  it('prepends the keychain and keeps the rest', async () => {
    const calls = fakeSecurity((args) => (args.includes('-s') ? {} : { stdout: list }));
    await addToSearchList(`${keychains}/swiftlane.keychain-db`);
    assert.deepEqual(calls.at(-1), [
      'list-keychains',
      '-d',
      'user',
      '-s',
      `${keychains}/swiftlane.keychain-db`,
      `${keychains}/login.keychain-db`,
      '/Library/Keychains/System.keychain',
    ]);
  });

  it('does not duplicate an existing entry and restores login if missing', async () => {
    const calls = fakeSecurity((args) => (args.includes('-s') ? {} : { stdout: `    "${keychains}/swiftlane.keychain-db"\n` }));
    await addToSearchList(`${keychains}/swiftlane.keychain-db`);
    assert.deepEqual(calls.at(-1)!.slice(4), [`${keychains}/swiftlane.keychain-db`, `${keychains}/login.keychain-db`]);
  });

  it('removes only the given keychain', async () => {
    const calls = fakeSecurity((args) => (args.includes('-s') ? {} : { stdout: `    "${keychains}/swiftlane.keychain-db"\n${list}` }));
    assert.equal(await removeFromSearchList(`${keychains}/swiftlane.keychain`), true);
    assert.deepEqual(calls.at(-1)!.slice(4), [`${keychains}/login.keychain-db`, '/Library/Keychains/System.keychain']);
  });
});

describe('keychain drop', () => {
  it('restores the login keychain as default before deleting', async () => {
    const custom = `${keychains}/swiftlane-test-nonexistent.keychain-db`;
    const calls = fakeSecurity((args) => {
      if (args[0] === 'default-keychain' && !args.includes('-s')) return { stdout: `    "${custom}"\n` };
      if (args[0] === 'list-keychains' && !args.includes('-s'))
        return { stdout: `    "${custom}"\n    "${keychains}/login.keychain-db"\n` };
      return {};
    });
    assert.equal(await dropKeychain('swiftlane-test-nonexistent'), true);
    assert.ok(calls.some((args) => args.join(' ') === `default-keychain -d user -s ${keychains}/login.keychain-db`));
    assert.ok(!calls.some((args) => args[0] === 'delete-keychain'), 'the file does not exist, nothing to delete');
  });

  it('never runs anything for system keychains', async () => {
    const calls = fakeSecurity();
    await assert.rejects(dropKeychain('login'), /Refusing/);
    assert.deepEqual(calls, []);
  });
});

describe('installIdentity', () => {
  it('imports a PKCS#12 and grants codesign access', async () => {
    const key = await generateSigningKey();
    const certificate = await new FakeApi().createCertificate(createCsr(key), 'DEVELOPMENT');
    // The intermediate is reported missing and its download fails, which must only warn.
    const calls = fakeSecurity();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    try {
      await installIdentity({ certificate, key }, { keychainPath: '/tmp/test.keychain-db', password: 'secret', strict: true });
    } finally {
      globalThis.fetch = originalFetch;
    }

    const commands = calls.map((args) => args[0]);
    assert.deepEqual(commands.slice(0, 4), ['unlock-keychain', 'find-identity', 'import', 'set-key-partition-list']);
    const importArgs = calls.find((args) => args[0] === 'import')!;
    assert.ok(importArgs.includes('-T') && importArgs.includes('/usr/bin/codesign'));
    assert.equal(importArgs[importArgs.indexOf('-f') + 1], 'pkcs12');
    assert.equal(importArgs[importArgs.indexOf('-k') + 1], '/tmp/test.keychain-db');
    assert.deepEqual(
      calls.find((args) => args[0] === 'set-key-partition-list'),
      ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', 'secret', '/tmp/test.keychain-db'],
    );
  });

  it('skips the import when the identity is already present', async () => {
    const key = await generateSigningKey();
    const certificate = await new FakeApi().createCertificate(createCsr(key), 'DEVELOPMENT');
    const { sha1 } = describeCertificate(certificate.content);
    const calls = fakeSecurity((args) => {
      if (args[0] === 'find-identity')
        return { stdout: `  1) ${sha1} "Apple Development: Created via API (TEAM123456)"\n     1 valid identities found\n` };
      if (args[0] === 'find-certificate') return { stdout: fakeWwdrPem };
      return {};
    });
    await installIdentity({ certificate, key }, { keychainPath: '/tmp/test.keychain-db', password: '', strict: true });
    assert.ok(!calls.some((args) => args[0] === 'import'));
  });

  it('only warns about the password for a keychain swiftlane does not manage', async () => {
    const key = await generateSigningKey();
    const certificate = await new FakeApi().createCertificate(createCsr(key), 'DEVELOPMENT');
    setRunner(async (_command, args) => {
      if (args[0] === 'unlock-keychain' || args[0] === 'set-key-partition-list') return { code: 51, stdout: '', stderr: 'bad password' };
      if (args[0] === 'find-certificate') return { code: 0, stdout: fakeWwdrPem, stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    await installIdentity({ certificate, key }, { keychainPath: '/tmp/login.keychain-db', password: '', strict: false });
    await assert.rejects(
      installIdentity({ certificate, key }, { keychainPath: '/tmp/test.keychain-db', password: '', strict: true }),
      /bad password/,
    );
  });

  it('parses find-identity output', async () => {
    fakeSecurity(() => ({
      stdout:
        '  1) 0123456789ABCDEF0123456789ABCDEF01234567 "Apple Development: A (X)"\n  2) FEDCBA9876543210FEDCBA9876543210FEDCBA98 "Apple Distribution: B (Y)"\n     2 valid identities found\n',
    }));
    assert.deepEqual(
      [...(await codesigningIdentities('/tmp/k'))],
      ['0123456789ABCDEF0123456789ABCDEF01234567', 'FEDCBA9876543210FEDCBA9876543210FEDCBA98'],
    );
  });
});
