// Runs every web test in sequence; exits non-zero if any fails.
// Usage: node tests/web/run.cjs
const { spawnSync } = require('child_process');
const path = require('path');
const tests = ['test_capture.cjs', 'test_display.cjs', 'test_qa.cjs', 'test_outbox.cjs', 'test_safety.cjs', 'test_library.cjs', 'test_offline.cjs', 'test_writers.cjs', 'test_screens.cjs', 'test_generate.cjs'];
let failed = [];
for (const t of tests) {
  console.log(`\n== ${t}`);
  const r = spawnSync(process.execPath, [path.join(__dirname, t)], { stdio: 'inherit', timeout: 300000 });
  if (r.status !== 0) failed.push(t);
}
console.log(failed.length ? `\nFAILED: ${failed.join(', ')}` : `\nall ${tests.length} test files passed`);
process.exit(failed.length ? 1 : 0);
