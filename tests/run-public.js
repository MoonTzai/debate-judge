// Public release test runner — privacy/rights-cleared source-integrity subset.
// This is intentionally not the private upstream tests/run-all.js.
'use strict';
const { execFileSync } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let failed = 0;

function runNode(name, args) {
  try {
    const out = execFileSync(process.execPath, args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    console.log('PASS suite: ' + name);
    if (out && out.trim()) console.log(out.trim());
  } catch (e) {
    failed++;
    console.log('FAIL suite: ' + name);
    const stdout = e && e.stdout ? String(e.stdout) : '';
    const stderr = e && e.stderr ? String(e.stderr) : '';
    console.log((stdout + (stderr ? '\n' + stderr : '')).trim() || String(e && e.message || e));
  }
}

runNode('closure-verify', [path.join(ROOT, 'install-skill.js'), '--verify-only']);
runNode('project-self-check', [path.join(ROOT, 'pipeline-controller.js'), 'self-check']);

const syntaxFiles = [
  'web/build-judge-web.js',
  'web/src/engine.js',
  'web/src/flight-export.js',
  'web/src/flight-recorder.js',
  'web/src/history-governance.js',
  'web/src/judge-context.js',
  'web/src/judge-host-io.js',
  'web/src/report-host.js',
  'web/src/tendency.js',
  'web/src/ui.js'
];
for (const rel of syntaxFiles) {
  runNode('syntax:' + rel, ['--check', path.join(ROOT, rel)]);
}

const suites = [
  'single-file-parity.test.js',
  'wayfinder-runtime.test.js',
  'slicing-contract.test.js',
  'rounds-source.test.js',
  'dictionary-consistency.test.js',
  'key-engine.test.js',
  'validator-coverage.test.js',
  'dead-assets.test.js'
];
for (const file of suites) runNode(file.replace(/\.test\.js$/, ''), [path.join(__dirname, file)]);

console.log(failed === 0
  ? '=== PUBLIC TEST SUITE PASS ==='
  : '=== PUBLIC TEST SUITE FAILED: ' + failed + ' ===');
process.exit(failed === 0 ? 0 : 1);
