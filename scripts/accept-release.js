'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const repo = path.resolve(__dirname, '..');
const mode = process.argv[2] || '';
if (!['--build', '--test'].includes(mode)) {
  console.error('usage: node scripts/accept-release.js --build|--test');
  process.exit(2);
}

function run(label, args) {
  console.log('[release-acceptance] ' + label);
  const r = cp.spawnSync(process.execPath, args, {
    cwd: repo,
    stdio: 'inherit',
    shell: false,
    env: process.env,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    console.error('[release-acceptance] FAILED: ' + label + ' exit=' + r.status);
    process.exit(r.status || 1);
  }
}

function read(rel) {
  return fs.readFileSync(path.join(repo, ...rel.split('/')), 'utf8');
}

function postconditions() {
  const mirrors = [
    'Skill-Judge.md',
    'Debate-Judge.md',
    '.claude/skills/debate-judge/SKILL.md',
  ].map(read);
  const html = read('web/judge.html');
  const runtimeFiles = [
    'Skill-Judge.md',
    'Debate-Judge.md',
    '.claude/skills/debate-judge/SKILL.md',
    'install-skill.js',
    'pipeline-controller.js',
    'render-report.js',
    'render-tables.js',
    'web/build-judge-web.js',
    'web/src/app.css',
    'web/src/engine.js',
    'web/src/ui.js',
  ];
  for (const dir of ['executor', 'scripts']) {
    for (const ent of fs.readdirSync(path.join(repo, dir), {withFileTypes:true})) {
      if (ent.isFile() && /\.(?:js|mjs|cjs|json|css|md)$/i.test(ent.name)) runtimeFiles.push(dir + '/' + ent.name);
    }
  }
  const runtimeText = runtimeFiles.map(rel => read(rel)).join('\n');
  const checks = {
    mirrors_equal: mirrors.every(v => v === mirrors[0]),
    canonical_mit: mirrors[0].includes('license: MIT') && !mirrors[0].includes('license: CC BY-NC-SA 4.0'),
    generated_mit: html.includes('license: MIT') && !html.includes('license: CC BY-NC-SA 4.0'),
    license_present: fs.existsSync(path.join(repo, 'LICENSE')),
    notices_present: fs.existsSync(path.join(repo, 'THIRD_PARTY_NOTICES.md')),
    artwork_removed:
      !fs.existsSync(path.join(repo, 'web', 'assets', 'sanctum-dark.webp')) &&
      !fs.existsSync(path.join(repo, 'web', 'assets', 'sanctum-light.webp')),
    no_private_absolute_root:
      !runtimeText.includes(['C:', 'Claude', 'Project', 'Debate-Judge'].join('/')) &&
      !runtimeText.includes(['C:', 'Claude', 'Project', 'Debate-Judge'].join('\\\\')),
    no_api_config_instance: !fs.existsSync(path.join(repo, '.api-config.json')),
  };
  for (const [name, ok] of Object.entries(checks)) {
    console.log('[release-acceptance] ' + (ok ? 'PASS ' : 'FAIL ') + name);
  }
  if (!Object.values(checks).every(Boolean)) process.exit(1);
}

if (mode === '--build') {
  run('embed assets', ['scripts/embed-assets.js']);
  run('sync canonical mirrors', ['pipeline-controller.js', 'sync-embed']);
  run('build browser artifact', ['web/build-judge-web.js', '--emit-bundle']);
  postconditions();
  run('generate manifest', ['scripts/generate-manifest.js']);
  console.log('[release-acceptance] BUILD PASS');
} else {
  run('public test suite', ['tests/run-public.js']);
  run('executable secret scan', ['scripts/secret-scan.js', '.']);
  postconditions();
  run('regenerate manifest after tests', ['scripts/generate-manifest.js']);
  console.log('[release-acceptance] TEST PASS');
}
