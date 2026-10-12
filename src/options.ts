import { type Command, InvalidArgumentError, Option } from 'commander';
import { ENV_ISSUER_ID, ENV_KEY_IDENTIFIER, ENV_PRIVATE_KEY } from './lib/asc/key.ts';
import { PRETTIFIERS, type Prettifier } from './lib/xcode/xcodebuild.ts';

export function parseInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new InvalidArgumentError('Expected a non-negative integer.');
  return parsed;
}

export function collect(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}

export interface GitOptions {
  githubToken?: string;
  origin?: string;
}

export interface ProjectOptions {
  workspace?: string;
  scheme?: string;
  configuration?: string;
  build: string;
  prettifier: Prettifier;
}

export function addApiKeyOptions(command: Command): Command {
  return command
    .addOption(
      new Option('--private-key <key>', 'App Store Connect API private key: .p8 contents, base64-encoded .p8 or path to the .p8 file').env(
        ENV_PRIVATE_KEY,
      ),
    )
    .addOption(new Option('--key-identifier <id>', 'App Store Connect API key ID').env(ENV_KEY_IDENTIFIER))
    .addOption(new Option('--issuer-id <id>', 'App Store Connect API issuer ID').env(ENV_ISSUER_ID));
}

export function addGitOptions(command: Command): Command {
  return command
    .addOption(
      new Option('-g, --github-token <token>', 'token used to push the signing keys ref, system git credentials are used when omitted').env(
        'GITHUB_TOKEN',
      ),
    )
    .option('-o, --origin <remote>', 'git remote name or URL storing the signing keys (default: origin)');
}

export function addProjectOptions(command: Command): Command {
  return command
    .option('-w, --workspace <path>', '.xcworkspace or .xcodeproj (default: the only one in the current directory)')
    .option('-s, --scheme <name>', 'scheme to build (default: inferred when unambiguous)')
    .option('-c, --configuration <name>', "build configuration (default: the scheme's setting for the action)")
    .option('-b, --build <directory>', 'directory for build products, DerivedData and logs', 'build')
    .addOption(prettifierOption());
}

export function prettifierOption(): Option {
  return new Option('-p, --prettifier <name>', 'xcodebuild output formatter, auto prefers xcpretty then xcbeautify')
    .choices(PRETTIFIERS)
    .default('auto');
}
