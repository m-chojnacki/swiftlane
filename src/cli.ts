#!/usr/bin/env node
import { SwiftlaneError } from './lib/errors.ts';
import { isVerbose, log } from './lib/log.ts';
import { createProgram } from './program.ts';

if (process.platform !== 'darwin') {
  log.warn('swiftlane drives Xcode and the macOS keychain, most commands only work on macOS');
}

try {
  await createProgram().parseAsync(process.argv);
} catch (error) {
  if (error instanceof SwiftlaneError) {
    log.error(error.message);
    if (error.hint) log.hint(error.hint);
    if (isVerbose() && error.cause) log.debug(String((error.cause as Error).stack ?? error.cause));
  } else {
    log.error((error as Error)?.stack ?? String(error));
  }
  process.exitCode = 1;
}
