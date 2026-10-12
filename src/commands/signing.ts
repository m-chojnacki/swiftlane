import { Command } from 'commander';
import { AppStoreConnectClient } from '../lib/asc/client.ts';
import { type ApiKeyOptions, loadApiKey } from '../lib/asc/key.ts';
import { SwiftlaneError } from '../lib/errors.ts';
import { CertificateStore, STORE_REF } from '../lib/git/store.ts';
import { defaultKeychain, keychainExists, resolveKeychainPath } from '../lib/keychain.ts';
import { log } from '../lib/log.ts';
import { setOutput } from '../lib/output.ts';
import { ensureIdentity, installIdentity, revokeIdentities, type SigningContext } from '../lib/signing.ts';
import { addApiKeyOptions, addGitOptions, type GitOptions } from '../options.ts';

interface SyncOptions extends ApiKeyOptions, GitOptions {
  keychain: string;
  password: string;
}

interface RevokeCommandOptions extends ApiKeyOptions, GitOptions {
  all: boolean;
  dryRun: boolean;
}

function createContext(options: ApiKeyOptions & GitOptions): SigningContext {
  const apiKey = loadApiKey(options);
  return {
    apiKey,
    api: new AppStoreConnectClient(apiKey),
    store: new CertificateStore({ remote: options.origin, token: options.githubToken }),
  };
}

/** The default "swiftlane" keychain falls back to the system default; an explicitly named one must exist. */
async function resolveTargetKeychain(name: string, explicit: boolean): Promise<{ path: string; managed: boolean }> {
  const keychainPath = resolveKeychainPath(name);
  if (keychainExists(keychainPath)) return { path: keychainPath, managed: true };
  if (explicit) {
    throw new SwiftlaneError(`Keychain "${name}" does not exist`, { hint: `Create it first with: swiftlane keychain init -k ${name}` });
  }
  const fallback = await defaultKeychain();
  if (!fallback) throw new SwiftlaneError('No "swiftlane" keychain and no default keychain found', { hint: 'Run swiftlane keychain init' });
  log.info(`Keychain "${name}" not found, using the default keychain ${fallback}`);
  return { path: fallback, managed: false };
}

async function sync(options: SyncOptions, command: Command): Promise<void> {
  const context = createContext(options);
  const keychain = await resolveTargetKeychain(options.keychain, command.getOptionValueSource('keychain') !== 'default');
  const identity = await ensureIdentity(context);
  const info = await installIdentity(identity, { keychainPath: keychain.path, password: options.password, strict: keychain.managed });
  setOutput('certificate-id', identity.certificate.id);
  setOutput('identity', info.sha1);
}

async function drop(options: GitOptions): Promise<void> {
  const store = new CertificateStore({ remote: options.origin, token: options.githubToken });
  log.step(`Dropping ${STORE_REF} from ${await store.describe()}`);
  if (await store.drop()) {
    log.success(`${STORE_REF} deleted`);
    log.hint('The certificates still exist in App Store Connect, `swiftlane signing revoke --all` revokes them');
  } else {
    log.success(`${STORE_REF} does not exist, nothing to do`);
  }
}

async function revoke(options: RevokeCommandOptions): Promise<void> {
  const { revoked } = await revokeIdentities(createContext(options), { all: options.all, dryRun: options.dryRun });
  if (!options.dryRun && revoked.length > 0) log.success(`Revoked ${revoked.length} certificate(s)`);
}

export function signingCommand(): Command {
  const command = new Command('signing').description('development signing identities backed by the App Store Connect API');

  addGitOptions(
    addApiKeyOptions(
      command
        .command('sync')
        .description(`make sure a valid development identity is in the keychain, creating it if needed and storing its key in ${STORE_REF}`)
        .option(
          '-k, --keychain <name>',
          'keychain to import into, falls back to the default keychain when "swiftlane" does not exist',
          'swiftlane',
        )
        .option('-p, --password <password>', 'keychain password', ''),
    ),
  ).action(sync);

  addGitOptions(command.command('drop').description(`delete ${STORE_REF} from the remote (certificates are not revoked)`)).action(drop);

  addGitOptions(
    addApiKeyOptions(
      command
        .command('revoke')
        .description(`revoke the certificates whose keys this API key stored, and remove those keys from ${STORE_REF}`)
        .option('-a, --all', 'also revoke API-created development certificates without a stored key', false)
        .option('-n, --dry-run', 'only print what would be revoked', false),
    ),
  ).action(revoke);

  return command;
}
