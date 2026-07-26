import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { deriveReleaseProvenance } from './provenance.mjs';
import {
  argumentValue,
  composeArguments,
  deployDirectory,
  failureMessage,
  hasArgument,
  integrationComposeArguments,
  rootComposeArguments,
  rootComposeFileNames,
  run,
} from './ops.mjs';

const releaseBundleCommands = new Set([
  'build',
  'commit',
  'create',
  'publish',
  'pull',
  'push',
  'run',
  'scale',
  'up',
  'watch',
]);
const directBuildCommands = new Set(['build', 'up']);
const operationalCommands = new Set([
  'attach',
  'cp',
  'down',
  'events',
  'exec',
  'export',
  'images',
  'kill',
  'logs',
  'ls',
  'pause',
  'port',
  'ps',
  'restart',
  'rm',
  'start',
  'stats',
  'stop',
  'top',
  'unpause',
  'version',
  'wait',
]);

export function classifyComposeCommand(arguments_) {
  const command = arguments_[0];
  if (typeof command !== 'string' || command.startsWith('-')) {
    throw new Error(
      'Production Compose requires the subcommand as its first argument',
    );
  }
  if (releaseBundleCommands.has(command)) {
    return 'release-bundle';
  }
  if (command === 'config') {
    return 'provenance';
  }
  if (operationalCommands.has(command)) {
    return 'operational';
  }
  throw new Error(`Unsupported production Docker Compose command: ${command}`);
}

export function composeCommandNeedsReleaseProvenance(arguments_) {
  return classifyComposeCommand(arguments_) !== 'operational';
}

export function composeCommandRequiresReleaseBundle(arguments_) {
  return classifyComposeCommand(arguments_) === 'release-bundle';
}

export function assertProductionComposeCommand(arguments_, rootComposeFile) {
  const classification = classifyComposeCommand(arguments_);
  if (
    classification === 'release-bundle' &&
    (rootComposeFile !== undefined || !directBuildCommands.has(arguments_[0]))
  ) {
    throw new Error(
      'Production image selection for this Compose command requires build-release.mjs and apply-release.mjs',
    );
  }
  return classification;
}

export function runCompose() {
  const integration = hasArgument('--integration');
  const rootComposeFile = argumentValue('--root-file');
  if (integration && rootComposeFile !== undefined) {
    throw new Error('Integration cannot use a root Compose file');
  }
  if (
    rootComposeFile !== undefined &&
    !rootComposeFileNames.includes(rootComposeFile)
  ) {
    throw new Error('Root Compose file is not allowed');
  }
  const envFile = resolve(
    argumentValue(
      '--env-file',
      resolve(deployDirectory, integration ? '.env.integration' : '.env'),
    ),
  );
  const forwardedArguments = process.argv
    .slice(2)
    .filter(
      (argument) =>
        argument !== '--integration' &&
        !argument.startsWith('--env-file=') &&
        !argument.startsWith('--root-file='),
    );
  if (forwardedArguments.length === 0) {
    throw new Error('Compose requires at least one Docker Compose argument');
  }
  const productionCommand = integration
    ? undefined
    : assertProductionComposeCommand(forwardedArguments, rootComposeFile);
  let arguments_;
  if (integration) {
    arguments_ = integrationComposeArguments(envFile, ...forwardedArguments);
  } else if (rootComposeFile !== undefined) {
    arguments_ = rootComposeArguments(
      envFile,
      rootComposeFile,
      ...forwardedArguments,
    );
  } else {
    arguments_ = composeArguments(envFile, ...forwardedArguments);
  }
  const composeProvenance =
    !integration && productionCommand !== 'operational'
      ? deriveReleaseProvenance()
      : undefined;
  run('docker', arguments_, {
    composeProvenance,
    label: 'Docker Compose',
    stdio: 'inherit',
  });
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    runCompose();
  } catch (error) {
    process.stderr.write(`Compose failed (${failureMessage(error)})\n`);
    process.exitCode = 1;
  }
}
