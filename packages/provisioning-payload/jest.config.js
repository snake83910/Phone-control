/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testRegex: '.*\.spec\.ts$',
  transform: { '^.+\.ts$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }] },
  collectCoverageFrom: ['src/**/*.ts'],
  testEnvironment: 'node',
  testTimeout: 60000,
};
