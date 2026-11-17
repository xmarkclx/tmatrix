const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { test } = require('node:test');

const consumers = ['vitest', 'vite', 'tinyglobby', 'fdir'];
const implementations = new Set(consumers.map(name =>
  createRequire(require.resolve(name)).resolve('picomatch')));
const hostilePatterns = [
  ['+(*a)', 'a'.repeat(40) + '!'],
  ['+(*)x', 'a'.repeat(40) + '!'],
  ['*(*a)', 'a'.repeat(40) + '!'],
  ['+(*a|*b)', 'a'.repeat(40) + '!'],
  ['+(ab|abab)', 'ab'.repeat(40) + '!'],
  ['+(@(*a))', 'a'.repeat(40) + '!'],
  ['(*a)+', 'a'.repeat(40) + '!'],
  ['(a+)+', 'a'.repeat(40) + '!'],
  [String.raw`(a\+)\+`, 'a'.repeat(40) + '!'],
  [String.raw`(a\+)\*`, 'a'.repeat(40) + '!'],
];

for (const implementation of implementations) {
  test('file matchers finish on repeated extglobs and regex quantifiers', () => {
    const result = spawnSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      const pm = require(process.argv[1]);
      const cases = JSON.parse(process.argv[2]);
      for (const options of [{}, { maxExtglobRecursion: false, regex: true, unescape: true }, { fastpaths: false }]) {
        for (const [pattern, input] of cases) {
          assert.equal(pm(pattern, options)(input), false, pattern);
          assert.equal(pm.makeRe(pattern, options).test(input), false, pattern);
          assert.equal(pm.compileRe(pm.parse(pattern, options)).test(input), false, pattern);
        }
      }
    `, implementation, JSON.stringify(hostilePatterns)], { encoding: 'utf8', timeout: 2000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  });

  test('file matchers preserve test discovery and exclusion globs', () => {
    const pm = require(implementation);
    const cases = [
      ['test/**/*.test.{ts,js}', 'test/unit/runner.test.ts', true],
      ['test/**/*.test.{ts,js}', 'test/runner.test.js', true],
      ['test/**/*.test.{ts,js}', 'src/runner.ts', false],
      ['**/node_modules/**', 'node_modules/pkg/index.js', true],
      ['**/node_modules/**', 'src/index.js', false],
      ['**/*.{js,ts}', 'src/nested/index.ts', true],
      ['!**/node_modules/**', 'src/index.ts', true],
      ['file.@(ts|js)', 'file.ts', true],
      ['file.?(t)s', 'file.ts', true],
      ['src/[a-z]*.ts', 'src/worker.ts', true],
    ];
    for (const [pattern, input, expected] of cases) {
      assert.equal(pm(pattern)(input), expected, `${pattern} against ${input}`);
      assert.equal(pm.makeRe(pattern).test(input), expected);
    }
    assert.equal(pm.scan('test/**/*.test.{ts,js}').isGlob, true);
  });
}
