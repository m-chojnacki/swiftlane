import { rmSync } from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import { log } from '../lib/log.ts';
import { setOutput } from '../lib/output.ts';
import { inferPlatform, projectArgs, resolveProject, resolveScheme } from '../lib/xcode/project.ts';
import { simulatorDestination } from '../lib/xcode/simulators.ts';
import { xcodebuild } from '../lib/xcode/xcodebuild.ts';
import { addProjectOptions, collect, type ProjectOptions } from '../options.ts';

interface TestOptions extends ProjectOptions {
  destination?: string;
  testPlan?: string;
  onlyTesting?: string[];
  skipTesting?: string[];
  resultBundle?: string;
}

async function test(options: TestOptions): Promise<void> {
  log.step('Preparing tests');
  const project = resolveProject(options.workspace);
  const scheme = await resolveScheme(project, options.scheme);
  const destination = options.destination ?? (await simulatorDestination(await inferPlatform(project, scheme, options.configuration)));
  const buildDirectory = path.resolve(options.build);
  const resultBundle = path.resolve(options.resultBundle ?? path.join(buildDirectory, `${project.name}.xcresult`));
  log.info(`Destination: ${destination}`);

  // xcodebuild refuses to overwrite an existing result bundle.
  rmSync(resultBundle, { recursive: true, force: true });

  try {
    await log.group(`Testing ${scheme}`, () =>
      xcodebuild(
        [
          ...projectArgs(project),
          '-scheme',
          scheme,
          ...(options.configuration ? ['-configuration', options.configuration] : []),
          '-destination',
          destination,
          '-derivedDataPath',
          path.join(buildDirectory, 'DerivedData'),
          '-resultBundlePath',
          resultBundle,
          ...(options.testPlan ? ['-testPlan', options.testPlan] : []),
          ...(options.onlyTesting ?? []).map((identifier) => `-only-testing:${identifier}`),
          ...(options.skipTesting ?? []).map((identifier) => `-skip-testing:${identifier}`),
          'test',
        ],
        { prettifier: options.prettifier, logPath: path.join(buildDirectory, 'logs', 'test.log') },
      ),
    );
  } finally {
    setOutput('result-bundle', resultBundle);
    log.info(`Result bundle: ${resultBundle}`);
  }
  log.success('Tests passed');
}

export function testCommand(): Command {
  return addProjectOptions(new Command('test').description('run the test suite on a simulator (no App Store Connect key needed)'))
    .option('-d, --destination <destination>', 'xcodebuild destination (default: newest available simulator for the platform)')
    .option('-r, --result-bundle <path>', 'where to write the .xcresult (default: <build>/<project name>.xcresult)')
    .option('--test-plan <name>', 'test plan to run')
    .option('--only-testing <identifier>', 'run only this test target/class/method, repeatable', collect)
    .option('--skip-testing <identifier>', 'skip this test target/class/method, repeatable', collect)
    .action(test);
}
