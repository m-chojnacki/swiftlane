import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { removeBuildDirectory } from '../src/commands/clean.ts';

describe('clean', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'swiftlane-clean-'));
  after(() => rmSync(root, { recursive: true, force: true }));

  it('removes the build directory with everything inside', () => {
    mkdirSync(path.join(root, 'build', 'DerivedData'), { recursive: true });
    writeFileSync(path.join(root, 'build', 'DerivedData', 'info.plist'), '');
    assert.equal(removeBuildDirectory('build', root), true);
    assert.equal(existsSync(path.join(root, 'build')), false);
    assert.equal(existsSync(root), true);
  });

  it('reports when there is nothing to remove', () => {
    assert.equal(removeBuildDirectory('missing', root), false);
  });

  it('refuses directories containing the working directory or home', () => {
    assert.throws(() => removeBuildDirectory('.', root), /Refusing/);
    assert.throws(() => removeBuildDirectory('..', root), /Refusing/);
    assert.throws(() => removeBuildDirectory(os.homedir(), root), /Refusing/);
    assert.equal(existsSync(root), true);
  });

  it('accepts names starting with two dots', () => {
    mkdirSync(path.join(root, '..build'));
    assert.equal(removeBuildDirectory('..build', root), true);
  });
});
