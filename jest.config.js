export default {
  testEnvironment: 'node',
  transform: {},
  testMatch: ['**/*.test.js', '**/*.tests.js'],
  testPathIgnorePatterns: ['/node_modules/'],
  collectCoverageFrom: ['src/**/*.js', '!src/**/*.test.js', '!src/**/*.tests.js'],
  coveragePathIgnorePatterns: ['/node_modules/'],
};
