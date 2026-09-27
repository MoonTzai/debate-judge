'use strict';
// Runtime identity owns byte provenance, never semantic interpretation.
// Entrypoints authenticate this module's bytes before loading it in a generated tree.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Reviewed runtime closure: Node execution, report/PLAIN/R8, and optional lifecycle
// identity reading. Installer/build/acceptance/test tools are intentionally separate.
const EXECUTABLE_FILES = Object.freeze([
  'pipeline-controller.js', 'render-report.js', 'render-tables.js',
  'assets/charts-constants.js',
  'executor/runtime-identity.js', 'executor/core.js',
  'executor/wayfinder-runtime.js', 'executor/semantic-workflow.js',
  'executor/semantic-review-contract-v5.js', 'executor/semantic-production-profile-v9.js',
  'executor/sc-semantic-authority.js', 'executor/semantic-production-store.js',
  'executor/host-node.js', 'executor/codex-cli.js', 'executor/contract.js',
  'executor/validator.js', 'executor/api-provider.js',
  'scripts/plain-language.js', 'scripts/plain-comprehension.js', 'scripts/reader-guide.js',
  'scripts/judge-run-settings.js', 'scripts/html-contract.js',
  'scripts/sc-semantic-production-cutover.js'
]);
const INPUT_FILES = Object.freeze([
  'assets/report.css', 'assets/skeleton.html', 'assets/plain-dict.json',
  'schemas/criteria.schema.json', 'schemas/index.schema.json',
  'schemas/model-snapshot.schema.json', 'schemas/presentation.schema.json',
  'schemas/tendency.schema.json', 'schemas/input-contract.json',
  'schemas/adjudication.schema.json', 'schemas/reader-guide.schema.json'
]);
const PRODUCT_SOURCE_FILES = Object.freeze([...EXECUTABLE_FILES, ...INPUT_FILES,
  'Skill-Judge.md', 'web/src/engine.js', 'web/src/report-host.js', 'web/src/ui.js']);
const productSources = new Set(PRODUCT_SOURCE_FILES);
const TOOL_FILES = Object.freeze(['install-skill.js', 'scripts/build-v10-runtime.js', 'scripts/run-v10-real-e2e.js']);
const HASH_RE = /^[a-f0-9]{64}$/;

function identityError(message) {
  const e = new Error('[v10-runtime-identity] ' + message);
  e.code = 'ERR_V10_RUNTIME_IDENTITY';
  return e;
}
function fileSha(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function setSha(map) {
  const canonical = Object.keys(map).sort().map(k => k + '\0' + map[k]).join('\n');
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}
function safeRelative(rel) {
  if (typeof rel !== 'string' || !rel || path.isAbsolute(rel) || rel.includes('\\') ||
      rel.split('/').some(part => !part || part === '.' || part === '..')) {
    throw identityError('manifest contains unsafe relative path: ' + String(rel));
  }
  return rel;
}
function isProductSource(rel) { return productSources.has(rel); }
function hashesFor(root, files) {
  const out = {};
  for (const rel of files) {
    const file = path.join(root, rel);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw identityError('runtime dependency 缺失: ' + rel);
    out[rel] = fileSha(file);
  }
  return out;
}
function captureRuntimeIdentity(root) {
  // Tool hashes are receipts for their own explicit invocation. Merely launching
  // Host/PC does not execute those tools and must not depend on their freshness.
  const out = hashesFor(root, EXECUTABLE_FILES);
  for (const rel of TOOL_FILES) if (fs.existsSync(path.join(root, rel))) out[rel] = fileSha(path.join(root, rel));
  return out;
}
function captureRuntimeInputs(root) { return hashesFor(root, INPUT_FILES); }
function verifyFiles(root, expected, files, label) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) throw identityError(label + ' 缺失');
  for (const rel of files) {
    const hash = String(expected[rel] || '');
    const file = path.join(root, rel);
    if (!HASH_RE.test(hash) || !fs.existsSync(file) || !fs.statSync(file).isFile() || fileSha(file) !== hash) {
      throw identityError(label + ' 漂移: ' + rel);
    }
  }
}
// Source attachment is explicit build provenance, never inferred from a neighboring file.
function captureRuntimeSourceBinding(candidateRoot, runtimeRoot) {
  const local = path.resolve(candidateRoot) === path.dirname(path.resolve(runtimeRoot));
  return local
    ? { schema: 'judge-v10-runtime-source-binding-v1', mode: 'candidate-relative', relative_root: '..' }
    : { schema: 'judge-v10-runtime-source-binding-v1', mode: 'detached' };
}
function canonicalSourceBinding(binding) {
  if (!binding || binding.schema !== 'judge-v10-runtime-source-binding-v1') {
    throw identityError('runtime source binding 缺失或非法；由当前 builder 重新生成身份完整的 runtime');
  }
  if (binding.mode === 'candidate-relative' && binding.relative_root === '..') {
    return { schema: binding.schema, mode: binding.mode, relative_root: '..' };
  }
  if (binding.mode === 'detached' && binding.relative_root === undefined) {
    return { schema: binding.schema, mode: binding.mode };
  }
  throw identityError('runtime source binding mode/root 非法');
}
function assertRuntimeSourceBinding(runtimeRoot, doc) {
  const binding = canonicalSourceBinding(doc.source_binding);
  let marker;
  try { marker = JSON.parse(fs.readFileSync(path.join(runtimeRoot, '.v10-runtime-generated'), 'utf8')); }
  catch (e) { throw identityError('runtime source binding marker 缺失或不可解析: ' + e.message); }
  if (marker.schema !== 'judge-v10-generated-runtime-root-v1' ||
      JSON.stringify(canonicalSourceBinding(marker.source_binding)) !== JSON.stringify(binding)) {
    throw identityError('runtime source binding 与 build marker 不一致');
  }
  return binding;
}
function assertGeneratedRuntimeIdentity(runtimeRoot) {
  runtimeRoot = path.resolve(runtimeRoot);
  const manifestPath = path.join(runtimeRoot, 'V10-RUNTIME-MANIFEST.json');
  const generated = path.basename(runtimeRoot) === 'runtime-generated' ||
    fs.existsSync(path.join(runtimeRoot, '.v10-runtime-generated')) || fs.existsSync(manifestPath);
  if (!generated) return { checked: false };
  if (!fs.existsSync(manifestPath)) throw identityError('generated runtime 缺少 V10-RUNTIME-MANIFEST.json，禁止执行 partial/stale tree');
  let doc;
  try { doc = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (e) { throw identityError('runtime manifest 不可解析: ' + e.message); }
  if (!doc || doc.schema !== 'judge-v10-sc-runtime-manifest-v2') throw identityError('runtime manifest schema 过期或非法；必须由当前 builder 重建');
  if (doc.status === 'RUNTIME_BUILDING') {
    const nonce = typeof process !== 'undefined' && process.env ? String(process.env.V10_RUNTIME_BUILD_NONCE || '') : '';
    if (!doc.build_nonce || nonce !== String(doc.build_nonce)) throw identityError('runtime 仍处于 BUILDING；只有持有本次 builder nonce 的构建子进程可执行');
  } else if (doc.status !== 'RUNTIME_BUILD_PASS') {
    throw identityError('runtime status 非 RUNTIME_BUILD_PASS: ' + String(doc.status || 'missing'));
  }
  verifyFiles(runtimeRoot, doc.runtime_identity, EXECUTABLE_FILES, 'runtime executable identity');
  verifyFiles(runtimeRoot, doc.runtime_inputs, INPUT_FILES, 'runtime input identity');
  if (doc.status === 'RUNTIME_BUILD_PASS') {
    verifyFiles(runtimeRoot, {
      'Skill-Judge.md': doc.generated_skill_sha256,
      'Debate-Judge.md': doc.generated_debate_judge_sha256
    }, ['Skill-Judge.md', 'Debate-Judge.md'], 'runtime generated mirror identity');
  }
  const binding = assertRuntimeSourceBinding(runtimeRoot, doc);
  const source = doc.source_overlays;
  if (!source || typeof source !== 'object' || Array.isArray(source) ||
      !HASH_RE.test(String(doc.source_overlay_set_sha256 || '')) || setSha(source) !== doc.source_overlay_set_sha256) {
    throw identityError('candidate source overlay set identity 漂移');
  }
  for (const [rel, expected] of Object.entries(source)) {
    safeRelative(rel);
    if (!HASH_RE.test(String(expected || ''))) throw identityError('candidate source overlay manifest 非法: ' + rel);
  }
  if (binding.mode === 'candidate-relative') {
    const candidateRoot = path.resolve(runtimeRoot, binding.relative_root);
    // Removing/changing a build-only helper cannot grant or revoke this binding.
    for (const [rel, expected] of Object.entries(source)) {
      if (!isProductSource(rel)) continue;
      const file = path.join(candidateRoot, rel);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile() || fileSha(file) !== expected) {
        throw identityError('candidate source 已前进，runtime 已过期: ' + rel);
      }
    }
    for (const rel of PRODUCT_SOURCE_FILES) {
      const file = path.join(candidateRoot, rel);
      if (fs.existsSync(file) && fs.statSync(file).isFile() && !Object.prototype.hasOwnProperty.call(source, rel)) {
        throw identityError('candidate source overlay freshness binding 缺失: ' + rel);
      }
    }
  }
  return { checked: true, status: doc.status, executableCount: EXECUTABLE_FILES.length, inputCount: INPUT_FILES.length };
}
module.exports = {
  EXECUTABLE_FILES, INPUT_FILES, PRODUCT_SOURCE_FILES,
  isProductSource, captureRuntimeIdentity, captureRuntimeInputs,
  assertGeneratedRuntimeIdentity, captureRuntimeSourceBinding, fileSha, setSha
};
