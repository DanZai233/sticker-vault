// Keep the legacy entry point consistent with the supported builder configuration.
const { spawnSync } = require('node:child_process');
const result = spawnSync(
  process.execPath,
  [
    require.resolve('electron-builder/cli.js'),
    '--dir',
    '--publish',
    'never',
    ...process.argv.slice(2),
  ],
  { stdio: 'inherit' },
);
process.exit(result.status ?? 1);
