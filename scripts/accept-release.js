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

function walkFiles(dir, out = []) {
  for (const ent of fs.readdirSync(dir, {withFileTypes:true})) {
    if (ent.name === '.git') continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) walkFiles(abs, out);
    else if (ent.isFile()) out.push(abs);
  }
  return out;
}

function localDataLeakCheck() {
  const files = walkFiles(repo);
  const forbiddenExt = /\.(?:parquet|docx?|7z|rar)$/i;
  const forbiddenPath = /(?:^|\/)(?:local-data|local-test-data|test-corpora|corpora|datasets?)(?:\/|$)/i;
  const suspicious = [];

  for (const abs of files) {
    const rel = path.relative(repo, abs).replace(/\\/g, '/');
    const stat = fs.statSync(abs);
    if (forbiddenExt.test(rel) || forbiddenPath.test(rel)) {
      suspicious.push(rel + ' [forbidden local-data shape]');
      continue;
    }
    if (/\.json$/i.test(rel) && stat.size > 2 * 1024 * 1024) {
      suspicious.push(rel + ' [large JSON data file]');
      continue;
    }
    if (/\.(?:txt|jsonl|csv|tsv)$/i.test(rel) && stat.size > 4 * 1024 * 1024) {
      suspicious.push(rel + ' [large text/data file]');
      continue;
    }
    if (stat.size > 20 * 1024 * 1024 && rel !== 'web/judge.html') {
      suspicious.push(rel + ' [unexpected large file]');
    }
  }

  if (suspicious.length) {
    console.error('[release-acceptance] FAIL local_test_data_absent');
    for (const item of suspicious) console.error('  ' + item);
    process.exit(1);
  }
  console.log('[release-acceptance] PASS local_test_data_absent');
}

function postconditions() {
  localDataLeakCheck();
  const canonicalSkill = read('Skill-Judge.md');
  const html = read('web/judge.html');
  const runtimeFiles = [
    'Skill-Judge.md',
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
    single_canonical_skill:
      !fs.existsSync(path.join(repo, 'Debate-Judge.md')) &&
      !fs.existsSync(path.join(repo, '.claude', 'skills', 'debate-judge', 'SKILL.md')),
    canonical_mit: canonicalSkill.includes('license: MIT') && !canonicalSkill.includes('license: CC BY-NC-SA 4.0'),
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
  run('sync canonical Skill', ['pipeline-controller.js', 'sync-embed']);
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
