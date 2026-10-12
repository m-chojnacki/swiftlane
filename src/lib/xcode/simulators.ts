import { SwiftlaneError } from '../errors.ts';
import { run } from '../exec.ts';
import type { Platform } from './project.ts';

interface SimctlDevice {
  udid: string;
  name: string;
  isAvailable?: boolean;
}

export interface SimctlList {
  devices: Record<string, SimctlDevice[]>;
}

const RUNTIME_PREFIX: Record<Exclude<Platform, 'macOS'>, string> = {
  iOS: 'iOS',
  tvOS: 'tvOS',
  watchOS: 'watchOS',
  visionOS: 'xrOS',
};

const DEVICE_PREFIX: Record<Exclude<Platform, 'macOS'>, RegExp> = {
  iOS: /^iPhone/,
  tvOS: /^Apple TV/,
  watchOS: /^Apple Watch/,
  visionOS: /^Apple Vision/,
};

function runtimeVersion(identifier: string): number[] {
  return (/-(\d+(?:-\d+)*)$/.exec(identifier)?.[1] ?? '0').split('-').map(Number);
}

function compareVersions(a: number[], b: number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    const diff = (a[index] ?? 0) - (b[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Newest runtime first; within it the last listed device, which simctl orders oldest to newest model. */
export function pickSimulator(list: SimctlList, platform: Exclude<Platform, 'macOS'>): SimctlDevice & { runtime: string } {
  const prefix = `com.apple.CoreSimulator.SimRuntime.${RUNTIME_PREFIX[platform]}-`;
  const runtimes = Object.keys(list.devices)
    .filter((runtime) => runtime.startsWith(prefix))
    .sort((a, b) => compareVersions(runtimeVersion(b), runtimeVersion(a)));
  for (const runtime of runtimes) {
    const devices = (list.devices[runtime] ?? []).filter(
      (device) => device.isAvailable !== false && DEVICE_PREFIX[platform].test(device.name),
    );
    const device = devices.at(-1);
    if (device) return { ...device, runtime };
  }
  throw new SwiftlaneError(`No available ${platform} simulator found`, {
    hint: 'Install a simulator runtime in Xcode → Settings → Components, or pass -d / --destination',
  });
}

export async function simulatorDestination(platform: Platform): Promise<string> {
  if (platform === 'macOS') return 'platform=macOS';
  const { stdout } = await run('xcrun', ['simctl', 'list', 'devices', 'available', '--json']);
  const device = pickSimulator(JSON.parse(stdout) as SimctlList, platform);
  return `platform=${platform} Simulator,id=${device.udid}`;
}
