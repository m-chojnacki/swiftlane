import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { buildSettingValues, replaceBuildSetting } from '../src/commands/version.ts';
import { exportOptions, resolveArchive } from '../src/lib/xcode/export.ts';
import { toPlist } from '../src/lib/xcode/plist.ts';
import {
  appSettings,
  parseJsonOutput,
  pickScheme,
  platformFromSettings,
  resolveProject,
  type XcodeProject,
} from '../src/lib/xcode/project.ts';
import { pickSimulator } from '../src/lib/xcode/simulators.ts';
import { extractErrors, xcodebuild } from '../src/lib/xcode/xcodebuild.ts';

describe('project discovery', () => {
  let directory: string;
  before(() => {
    directory = mkdtempSync(path.join(os.tmpdir(), 'swiftlane-xcode-test-'));
  });
  after(() => rmSync(directory, { recursive: true, force: true }));

  it('prefers the workspace over the project', () => {
    mkdirSync(path.join(directory, 'App.xcodeproj'));
    assert.equal(resolveProject(undefined, directory).kind, 'project');
    mkdirSync(path.join(directory, 'App.xcworkspace'));
    assert.deepEqual(resolveProject(undefined, directory), {
      kind: 'workspace',
      path: path.join(directory, 'App.xcworkspace'),
      name: 'App',
    });
  });

  it('refuses to guess between several workspaces', () => {
    mkdirSync(path.join(directory, 'Other.xcworkspace'));
    assert.throws(() => resolveProject(undefined, directory), /multiple \.xcworkspace/);
    assert.equal(resolveProject('App.xcodeproj', directory).kind, 'project');
    assert.throws(() => resolveProject('Missing.xcodeproj', directory), /does not exist/);
    assert.throws(() => resolveProject('App.txt', directory), /neither/);
  });

  it('finds the archive in the build directory', () => {
    const build = path.join(directory, 'build');
    assert.throws(() => resolveArchive(undefined, build), /No \.xcarchive/);
    mkdirSync(path.join(build, 'App.xcarchive'), { recursive: true });
    assert.equal(resolveArchive(undefined, build), path.join(build, 'App.xcarchive'));
    mkdirSync(path.join(build, 'Other.xcarchive'));
    assert.throws(() => resolveArchive(undefined, build), /multiple archives/);
  });
});

describe('schemes and platforms', () => {
  const project: XcodeProject = { kind: 'workspace', path: '/x/App.xcworkspace', name: 'App' };

  it('picks the only scheme or the one named after the project', () => {
    assert.equal(pickScheme(['Only'], project), 'Only');
    assert.equal(pickScheme(['AppTests', 'App', 'Widget'], project), 'App');
    assert.throws(() => pickScheme(['A', 'B'], project), /Cannot infer the scheme.*A, B/);
    assert.throws(() => pickScheme([], project), /No shared schemes/);
  });

  it('parses xcodebuild JSON preceded by warnings', () => {
    const output = 'Command line invocation:\nwarning: something\n{\n  "workspace" : { "schemes" : ["App"] }\n}\n';
    assert.deepEqual(parseJsonOutput(output), { workspace: { schemes: ['App'] } });
  });

  it('maps SDKs to destination platforms using the app target', () => {
    const targets = [
      { target: 'Kit', buildSettings: { PRODUCT_TYPE: 'com.apple.product-type.framework', PLATFORM_NAME: 'macosx' } },
      { target: 'App', buildSettings: { PRODUCT_TYPE: 'com.apple.product-type.application', PLATFORM_NAME: 'iphoneos' } },
    ];
    assert.equal(platformFromSettings(appSettings(targets)), 'iOS');
    assert.equal(platformFromSettings({ SDKROOT: '/Applications/Xcode.app/.../MacOSX15.0.sdk' }), 'macOS');
    assert.equal(platformFromSettings({ PLATFORM_NAME: 'xros' }), 'visionOS');
    assert.equal(platformFromSettings({ PLATFORM_NAME: 'appletvos' }), 'tvOS');
    assert.equal(platformFromSettings({}), undefined);
  });

  it('picks the newest runtime and the newest iPhone in it', () => {
    const list = {
      devices: {
        'com.apple.CoreSimulator.SimRuntime.iOS-17-5': [{ udid: 'old', name: 'iPhone 15', isAvailable: true }],
        'com.apple.CoreSimulator.SimRuntime.iOS-18-2': [
          { udid: 'ipad', name: 'iPad Pro', isAvailable: true },
          { udid: 'a', name: 'iPhone 16', isAvailable: true },
          { udid: 'b', name: 'iPhone 16 Pro', isAvailable: true },
        ],
        'com.apple.CoreSimulator.SimRuntime.iOS-18-10': [{ udid: 'broken', name: 'iPhone 16', isAvailable: false }],
        'com.apple.CoreSimulator.SimRuntime.tvOS-18-0': [{ udid: 'tv', name: 'Apple TV', isAvailable: true }],
      },
    };
    assert.equal(pickSimulator(list, 'iOS').udid, 'b');
    assert.equal(pickSimulator(list, 'tvOS').udid, 'tv');
    assert.throws(() => pickSimulator(list, 'watchOS'), /No available watchOS simulator/);
  });
});

describe('xcodebuild output', () => {
  it('extracts unique errors from the raw log', () => {
    const rawLog = [
      'CompileSwift normal arm64',
      '/src/A.swift:3:5: error: cannot find foo in scope',
      '/src/A.swift:3:5: error: cannot find foo in scope',
      'error: No signing certificate "iOS Development" found',
      'warning: deprecated',
      '** ARCHIVE FAILED **',
    ].join('\n');
    assert.deepEqual(extractErrors(rawLog), [
      '/src/A.swift:3:5: error: cannot find foo in scope',
      'error: No signing certificate "iOS Development" found',
      '** ARCHIVE FAILED **',
    ]);
  });
});

describe('xcodebuild runner', () => {
  let bin: string;
  let originalPath: string | undefined;

  /** Fake tools on PATH, so the piping is exercised without running a real build. */
  function tool(name: string, script: string): void {
    const file = path.join(bin, name);
    writeFileSync(file, `#!/bin/sh\n${script}\n`);
    chmodSync(file, 0o755);
  }

  before(() => {
    bin = mkdtempSync(path.join(os.tmpdir(), 'swiftlane-bin-'));
    originalPath = process.env.PATH;
    process.env.PATH = `${bin}${path.delimiter}${originalPath}`;
    tool('xcpretty', `sed 's/^/pretty: /' > "${bin}/pretty.out"`);
  });
  after(() => {
    process.env.PATH = originalPath;
    rmSync(bin, { recursive: true, force: true });
  });

  it('keeps the raw log and pipes stdout and stderr through the prettifier', async () => {
    tool('xcodebuild', 'echo "building $*"; echo "warning: on stderr" >&2; exit 0');
    const logPath = path.join(bin, 'logs', 'ok.log');
    await xcodebuild(['-scheme', 'App', 'archive'], { prettifier: 'xcpretty', logPath });
    const raw = readFileSync(logPath, 'utf8');
    assert.match(raw, /^\$ xcodebuild -scheme App archive/);
    assert.match(raw, /building -scheme App archive/);
    assert.match(raw, /warning: on stderr/);
    const pretty = readFileSync(path.join(bin, 'pretty.out'), 'utf8');
    assert.match(pretty, /pretty: building -scheme App archive/);
    assert.match(pretty, /pretty: warning: on stderr/);
  });

  it("fails with xcodebuild's exit code even though the prettifier succeeds", async () => {
    tool('xcodebuild', 'echo "/src/A.swift:1:1: error: boom"; echo "** ARCHIVE FAILED **"; exit 65');
    const logPath = path.join(bin, 'logs', 'fail.log');
    await assert.rejects(xcodebuild(['archive'], { prettifier: 'xcpretty', logPath }), /xcodebuild failed with exit code 65/);
  });

  it('masks secrets in the logged command line', async () => {
    tool('xcodebuild', 'exit 0');
    const logPath = path.join(bin, 'logs', 'secret.log');
    await xcodebuild(['-password', 'hunter2'], { prettifier: 'none', logPath, secrets: ['hunter2'] });
    assert.ok(!readFileSync(logPath, 'utf8').includes('hunter2'));
  });

  it('reports a missing prettifier', async () => {
    await assert.rejects(
      xcodebuild([], { prettifier: 'xcbeautify-missing' as 'xcbeautify', logPath: path.join(bin, 'x.log') }),
      /not installed/,
    );
  });
});

describe('export options', () => {
  it('uses automatic signing and uploads symbols for App Store builds', () => {
    assert.deepEqual(exportOptions({ method: 'app-store-connect', destination: 'upload', teamId: 'TEAM' }), {
      method: 'app-store-connect',
      destination: 'upload',
      signingStyle: 'automatic',
      teamID: 'TEAM',
      uploadSymbols: true,
      manageAppVersionAndBuildNumber: false,
    });
    assert.deepEqual(exportOptions({ method: 'release-testing', destination: 'export' }), {
      method: 'release-testing',
      destination: 'export',
      signingStyle: 'automatic',
    });
  });

  it('serializes plists', () => {
    assert.equal(
      toPlist({ method: 'a&b', upload: true, count: 2, list: ['x'] }),
      [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
        '<plist version="1.0">',
        '<dict>',
        '\t<key>method</key>',
        '\t<string>a&amp;b</string>',
        '\t<key>upload</key>',
        '\t<true/>',
        '\t<key>count</key>',
        '\t<integer>2</integer>',
        '\t<key>list</key>',
        '\t<array>',
        '\t\t<string>x</string>',
        '\t</array>',
        '</dict>',
        '</plist>',
        '',
      ].join('\n'),
    );
  });
});

describe('version build settings', () => {
  const pbxproj = [
    '\t\t\t\tCURRENT_PROJECT_VERSION = 7;',
    '\t\t\t\tMARKETING_VERSION = 1.2.0;',
    '\t\t\t\tPRODUCT_NAME = App;',
    '\t\t\t\tCURRENT_PROJECT_VERSION = 7;',
    '\t\t\t\tMARKETING_VERSION = "1.2.0";',
    '\t\t\t\tINFOPLIST_KEY_MARKETING_VERSION_X = 9;',
  ].join('\n');

  it('reads distinct values, quoted or not', () => {
    assert.deepEqual(buildSettingValues(pbxproj, 'MARKETING_VERSION'), ['1.2.0']);
    assert.deepEqual(buildSettingValues(pbxproj, 'CURRENT_PROJECT_VERSION'), ['7']);
    assert.deepEqual(buildSettingValues(pbxproj, 'VERSIONING_SYSTEM'), []);
  });

  it('replaces every configuration and nothing else', () => {
    const updated = replaceBuildSetting(pbxproj, 'MARKETING_VERSION', '2.0.0');
    assert.deepEqual(buildSettingValues(updated, 'MARKETING_VERSION'), ['2.0.0']);
    assert.ok(updated.includes('INFOPLIST_KEY_MARKETING_VERSION_X = 9;'));
    assert.ok(updated.includes('CURRENT_PROJECT_VERSION = 7;'));
    assert.match(replaceBuildSetting(pbxproj, 'MARKETING_VERSION', '2.0 beta'), /MARKETING_VERSION = "2\.0 beta";/);
  });
});
