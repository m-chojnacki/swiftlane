import { Command } from 'commander';
import {
  addToSearchList,
  assertCustomKeychain,
  createKeychain,
  deleteKeychain,
  isDefaultKeychain,
  keychainExists,
  loginKeychainPath,
  removeFromSearchList,
  resolveKeychainPath,
  setDefaultKeychain,
  setKeyPartitionList,
  setLockTimeout,
  unlockKeychain,
} from '../lib/keychain.ts';
import { log } from '../lib/log.ts';
import { setOutput } from '../lib/output.ts';
import { parseInteger } from '../options.ts';

interface InitOptions {
  keychain: string;
  password: string;
  default: boolean;
  timeout: number;
}

interface DropOptions {
  keychain: string;
}

export async function dropKeychain(name: string): Promise<boolean> {
  assertCustomKeychain(name);
  const keychainPath = resolveKeychainPath(name);
  let changed = false;

  if (await isDefaultKeychain(keychainPath)) {
    log.info(`Restoring login keychain as the default keychain`);
    await setDefaultKeychain(loginKeychainPath());
    changed = true;
  }
  if (await removeFromSearchList(keychainPath)) {
    log.info('Removed from the keychain search list');
    changed = true;
  }
  if (keychainExists(keychainPath)) {
    log.info(`Deleting ${keychainPath}`);
    await deleteKeychain(keychainPath);
    changed = true;
  }
  return changed;
}

async function init(options: InitOptions): Promise<void> {
  assertCustomKeychain(options.keychain);
  log.step(`Initializing keychain "${options.keychain}"`);

  if (keychainExists(resolveKeychainPath(options.keychain))) {
    log.info('Keychain already exists, dropping it first');
    await dropKeychain(options.keychain);
  }

  const keychainPath = resolveKeychainPath(options.keychain);
  log.info(`Creating ${keychainPath}`);
  await createKeychain(keychainPath, options.password);

  log.info(options.timeout > 0 ? `Setting auto-lock timeout to ${options.timeout}s` : 'Disabling auto-lock');
  await setLockTimeout(keychainPath, options.timeout);
  await unlockKeychain(keychainPath, options.password);

  log.info('Allowing codesign to access keys without prompting');
  try {
    await setKeyPartitionList(keychainPath, options.password);
  } catch (error) {
    // Nothing to apply it to yet, `signing sync` sets it again after importing the identity.
    log.debug(`set-key-partition-list on the empty keychain failed: ${(error as Error).message}`);
  }

  log.info('Adding to the user keychain search list');
  await addToSearchList(keychainPath);

  if (options.default) {
    log.info('Making it the default keychain');
    await setDefaultKeychain(keychainPath);
  }

  setOutput('keychain-path', keychainPath);
  log.success(`Keychain ready: ${keychainPath}`);
}

async function drop(options: DropOptions): Promise<void> {
  log.step(`Dropping keychain "${options.keychain}"`);
  if (await dropKeychain(options.keychain)) {
    log.success('Keychain dropped');
  } else {
    log.success('Keychain does not exist, nothing to do');
  }
}

export function keychainCommand(): Command {
  const command = new Command('keychain').description('manage a dedicated keychain for signing identities on CI');

  command
    .command('init')
    .description('create the keychain (recreating it if it exists), unlock it and add it to the search list')
    .option('-k, --keychain <name>', 'keychain name or path, system keychains like "login" are refused', 'swiftlane')
    .option('-p, --password <password>', 'keychain password', '')
    .option('-d, --default', 'also make it the default keychain', false)
    .option('-t, --timeout <seconds>', 'lock the keychain after this many seconds of inactivity, 0 disables locking', parseInteger, 3600)
    .action(init);

  command
    .command('drop')
    .description('remove the keychain from the search list and delete it')
    .option('-k, --keychain <name>', 'keychain name or path, system keychains like "login" are refused', 'swiftlane')
    .option('-p, --password <password>', 'keychain password (accepted for symmetry with init, deleting does not need it)', '')
    .action(drop);

  return command;
}
