/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  roots: ['<rootDir>/test/integration'],
  testRegex: '.*\\.integration\\.ts$',
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  setupFiles: ['reflect-metadata'],
  testEnvironment: 'node',
  testTimeout: 30_000,
  maxWorkers: 1,
};
