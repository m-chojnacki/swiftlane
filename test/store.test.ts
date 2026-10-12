import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import { CertificateStore, STORE_REF, toHttpsUrl } from '../src/lib/git/store.ts';
import { createGitFixture, type GitFixture } from './helpers.ts';

function commitWithEntry(cwd: string, name: string, contents: string): string {
  const git = (args: string[], input?: string): string =>
    execFileSync('git', args, {
      cwd,
      input,
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    }).trim();
  const blob = git(['hash-object', '-w', '--stdin'], contents);
  const tree = git(['mktree'], `100644 blob ${blob}\t${name}\n`);
  return git(['commit-tree', '--no-gpg-sign', tree, '-m', 'competitor']);
}

describe('toHttpsUrl', () => {
  it('converts the common remote URL forms', () => {
    assert.equal(toHttpsUrl('git@github.com:owner/repo.git'), 'https://github.com/owner/repo.git');
    assert.equal(toHttpsUrl('ssh://git@github.com/owner/repo.git'), 'https://github.com/owner/repo.git');
    assert.equal(toHttpsUrl('ssh://git@github.com:22/owner/repo.git'), 'https://github.com/owner/repo.git');
    assert.equal(toHttpsUrl('https://user:pass@github.com/owner/repo.git'), 'https://github.com/owner/repo.git');
    assert.equal(toHttpsUrl('/tmp/repo.git'), undefined);
  });
});

describe('CertificateStore', () => {
  let fixture: GitFixture;

  before(() => {
    fixture = createGitFixture();
  });
  after(() => fixture.cleanup());

  it('reads an empty store when the ref does not exist', async () => {
    const store = new CertificateStore({ cwd: fixture.checkout('empty') });
    assert.deepEqual(await store.read(), { commit: null, entries: new Map() });
    assert.equal(await store.describe(), 'origin');
  });

  it('writes parentless commits containing only the entries', async () => {
    const cwd = fixture.checkout('writer');
    const store = new CertificateStore({ cwd });
    await store.update((entries) => entries.set('AAA111', 'first\n'));
    const second = await store.update((entries) => entries.set('BBB222', 'second\n'));

    const remoteHead = fixture.git(fixture.bare, 'rev-parse', STORE_REF);
    assert.equal(second.commit, remoteHead);
    assert.equal(fixture.git(fixture.bare, 'rev-list', '--count', STORE_REF), '1');
    assert.equal(fixture.git(fixture.bare, 'ls-tree', '--name-only', STORE_REF), 'AAA111\nBBB222');

    const reader = new CertificateStore({ cwd: fixture.checkout('reader') });
    const snapshot = await reader.read();
    assert.equal(snapshot.commit, remoteHead);
    assert.deepEqual(
      snapshot.entries,
      new Map([
        ['AAA111', 'first\n'],
        ['BBB222', 'second\n'],
      ]),
    );
  });

  it('leaves the ref alone when the mutation returns undefined', async () => {
    const store = new CertificateStore({ cwd: fixture.checkout('noop') });
    const before = fixture.git(fixture.bare, 'rev-parse', STORE_REF);
    await store.update(() => undefined);
    assert.equal(fixture.git(fixture.bare, 'rev-parse', STORE_REF), before);
  });

  it('re-applies the mutation when another job pushed in between', async () => {
    const competitor = fixture.checkout('competitor');
    const competingCommit = commitWithEntry(competitor, 'FAST', 'fast\n');
    const store = new CertificateStore({ cwd: fixture.checkout('slow') });

    const seen: string[][] = [];
    await store.update((entries) => {
      seen.push([...entries.keys()]);
      if (seen.length === 1) {
        // Another job pushes after this one read the ref but before it pushed.
        execFileSync('git', ['push', '--quiet', '--force', 'origin', `${competingCommit}:${STORE_REF}`], {
          cwd: competitor,
          stdio: 'ignore',
        });
      }
      return entries.set('SLOW', 'slow\n');
    });

    assert.equal(seen.length, 2, 'the mutation runs again on fresh state');
    assert.deepEqual(seen[1], ['FAST']);
    assert.equal(fixture.git(fixture.bare, 'ls-tree', '--name-only', STORE_REF), 'FAST\nSLOW');
  });

  it('checks write access without changing the remote', async () => {
    const store = new CertificateStore({ cwd: fixture.checkout('probe') });
    const before = fixture.git(fixture.bare, 'rev-parse', STORE_REF);
    await store.assertWritable();
    assert.equal(fixture.git(fixture.bare, 'rev-parse', STORE_REF), before);
  });

  it('fails the write check for a remote it cannot push to', async () => {
    const cwd = fixture.checkout('readonly');
    fixture.git(cwd, 'remote', 'set-url', '--push', 'origin', `${fixture.root}/missing.git`);
    await assert.rejects(new CertificateStore({ cwd }).assertWritable(), /No write access/);
  });

  it('deletes the ref when the last entry is removed', async () => {
    const store = new CertificateStore({ cwd: fixture.checkout('cleaner') });
    const snapshot = await store.update(() => new Map());
    assert.equal(snapshot.commit, null);
    assert.equal(fixture.git(fixture.bare, 'for-each-ref', STORE_REF), '');
    assert.equal(await store.drop(), false);
  });

  it('drops the ref', async () => {
    const store = new CertificateStore({ cwd: fixture.checkout('dropper') });
    await store.update((entries) => entries.set('X1', 'x\n'));
    assert.equal(await store.drop(), true);
    assert.equal(fixture.git(fixture.bare, 'for-each-ref', STORE_REF), '');
  });

  it('accepts a remote URL instead of a name', async () => {
    const store = new CertificateStore({ cwd: fixture.checkout('by-url'), remote: fixture.bare });
    await store.update((entries) => entries.set('URL1', 'u\n'));
    assert.equal(fixture.git(fixture.bare, 'ls-tree', '--name-only', STORE_REF), 'URL1');
  });

  it('rejects unknown remotes and missing repositories', async () => {
    await assert.rejects(
      new CertificateStore({ cwd: fixture.checkout('unknown'), remote: 'upstream' }).read(),
      /Unknown git remote "upstream"/,
    );
    await assert.rejects(new CertificateStore({ cwd: fixture.root }).read(), /Not inside a git repository|no remotes/);
  });

  it('refuses entry names that could escape the tree', async () => {
    const store = new CertificateStore({ cwd: fixture.checkout('names') });
    await assert.rejects(
      store.update((entries) => entries.set('../evil', 'x')),
      /Invalid entry name/,
    );
  });
});
