// A8-P3b：统一轮次执行器·Node 宿主（文件 IO / API 调用 / 门禁重试 / 断点续跑 / 数据聚合）
// 真实 API 调用需环境变量 + 授权（P3d）；mock provider 用于冒烟与 CI。
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
function assertV10GeneratedRuntimeIdentity(runtimeRoot) {
  runtimeRoot = path.resolve(runtimeRoot);
  const manifestPath = path.join(runtimeRoot, 'V10-RUNTIME-MANIFEST.json');
  const generated = path.basename(runtimeRoot) === 'runtime-generated' ||
    fs.existsSync(path.join(runtimeRoot, '.v10-runtime-generated')) || fs.existsSync(manifestPath);
  if (!generated) return { checked: false };
  const fail = message => { const e = new Error('[v10-runtime-identity] ' + message); e.code = 'ERR_V10_RUNTIME_IDENTITY'; throw e; };
  if (!fs.existsSync(manifestPath)) fail('generated runtime 缺少 V10-RUNTIME-MANIFEST.json');
  let doc;
  try { doc = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (e) { fail('runtime manifest 不可解析: ' + e.message); }
  // The small per-entrypoint bootstrap authenticates the policy module before
  // executing it. Dependency, nonce, source and mirror policy have one owner.
  const helper = path.join(runtimeRoot, 'executor', 'runtime-identity.js');
  const expected = doc && doc.runtime_identity && doc.runtime_identity['executor/runtime-identity.js'];
  if (!/^[a-f0-9]{64}$/.test(String(expected || '')) || !fs.existsSync(helper) ||
      crypto.createHash('sha256').update(fs.readFileSync(helper)).digest('hex') !== expected) {
    fail('runtime executable identity 漂移: executor/runtime-identity.js bootstrap');
  }
  return require('./runtime-identity.js').assertGeneratedRuntimeIdentity(runtimeRoot);
}
assertV10GeneratedRuntimeIdentity(path.resolve(__dirname, '..'));
const core = require('./core.js');
const api = require('./api-provider.js');
const codexCli = require('./codex-cli.js');
const validator = require('./validator.js');
const SW = require('./semantic-workflow.js');
const TESTP = require('./semantic-production-profile-v9.js');
const SCA = require('./sc-semantic-authority.js');

// TEST active runtime is deliberately self-contained. It may use the immutable/CAS store substrate,
// but it never queries production router/cutover lifecycle state or any historical calibration harness.
function semanticStoreModule() {
  return require('./semantic-production-store.js');
}
function resolveActiveSemanticAuthority(opts) {
  if (opts && opts.testSemanticAuthority) return validateTestSemanticAuthority(opts.testSemanticAuthority);
  // The TEST authority is the local frozen V9 global-semantic attestation only. Production lifecycle
  // authorization belongs to promotion/cutover control-plane tooling and must never be a semantic input.
  return validateTestSemanticAuthority(TESTP.buildAttestation());
}

// Node 宿主 seam：共享 provider 只认 codexRunner 回调；CLI 进程细节集中在 codex-cli adapter。
function codexPromptFromMessages(messages, system) {
  const parts = [];
  if (system) parts.push('[system]\n' + String(system));
  for (const m of messages || []) {
    parts.push('[' + String(m.role || 'user') + ']\n' + String(m.content || ''));
  }
  return parts.join('\n\n');
}

async function defaultCodexRunner(cfg, messages, opts) {
  return codexCli.runCompletion(cfg, codexPromptFromMessages(messages, opts && opts.system));
}

function requestCompletionNode(cfg, messages, opts) {
  opts = opts || {};
  if (cfg && cfg.provider === 'codex-cli') {
    const runner = opts.codexRunner || defaultCodexRunner;
    return api.requestCompletion(cfg, messages, Object.assign({}, opts, { codexRunner: runner }));
  }
  return api.requestCompletion(cfg, messages, opts);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// TEST runtime preserves off/shadow compatibility for regression, but this TEST artifact hard-wires active.
// Any direct-host active call must carry the exact TEST attestation; there is no production fallback.
const SEMANTIC_FIRST_MODES = new Set(['off', 'shadow', 'active']);
function validateTestSemanticAuthority(authority) {
  try { return TESTP.validateAttestation(authority); }
  catch (e) {
    const err = new Error('[executor] TEST semantic attestation invalid: ' + (e && e.message ? e.message : String(e)));
    err.code = 'ERR_TEST_SEMANTIC_AUTHORITY_INVALID';
    throw err;
  }
}
function semanticFirstMode(opts) {
  const mode = String((opts && opts.semanticFirstMode) || (opts && opts.cfg && opts.cfg.__semanticFirstMode) || 'off');
  if (!SEMANTIC_FIRST_MODES.has(mode)) {
    const e = new Error('[executor] semanticFirstMode 仅允许 off/shadow/active');
    e.code = 'ERR_SEMANTIC_FIRST_MODE';
    throw e;
  }
  if (mode === 'active') resolveActiveSemanticAuthority(opts);
  return mode;
}
function resolveActiveExecutionValidation(opts, legacyValue) {
  // Relaxed validation is a mock transport seam, never an active real-runtime
  // capability. Preserve historical off/shadow defaults rather than blanket-deny
  // legacy execution, and keep explicit mock validation available to unit tests.
  if (semanticFirstMode(opts) === 'active' && (!opts.cfg || opts.cfg.provider !== 'mock')) {
    if (opts.realValidate === false) {
      const error = new Error('[executor] active non-mock execution cannot disable representation/authority validation');
      error.code = 'ERR_REAL_VALIDATION_REQUIRED';
      throw error;
    }
    return true;
  }
  return legacyValue;
}
function semanticShadowRoot(workDir) {
  return path.join(workDir, '.semantic-first-v1');
}
function safeSemanticId(value) {
  const s = String(value || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120);
  if (!s) throw new Error('[executor] semantic sidecar id 为空');
  return s;
}
function fsyncAppendLine(file, doc) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, JSON.stringify(doc) + '\n', null, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
function atomicImmutableWrite(file, content) {
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file);
    if (!existing.equals(bytes)) throw new Error('[executor] semantic immutable object collision: ' + file);
    return;
  }
  const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx');
    fs.writeSync(fd, bytes);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    try {
      fs.renameSync(tmp, file);
    } catch (e) {
      if (!fs.existsSync(file) || !fs.readFileSync(file).equals(bytes)) throw e;
      try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    }
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    throw e;
  }
}
function createSemanticSidecarStore(workDir) {
  const root = semanticShadowRoot(workDir);
  const sessionId = safeSemanticId(path.basename(workDir));
  function appendObject({ sessionId: sid, kind, content, metadata }) {
    const actualSession = safeSemanticId(sid || sessionId);
    const actualKind = safeSemanticId(kind);
    const text = String(content);
    const bodySha = crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
    const identitySha = crypto.createHash('sha256')
      .update(Buffer.from(JSON.stringify(metadata || {}) + '\0' + text, 'utf8')).digest('hex');
    const objectId = actualKind + '-' + identitySha.slice(0, 24);
    const folderName = actualKind === 'request' ? 'requests' : (actualKind === 'raw' ? 'raw' : (actualKind === 'issue' ? 'issues' : actualKind));
    const dir = path.join(root, folderName);
    const ext = actualKind === 'request' || actualKind === 'issue' ? '.json' : '.txt';
    const bodyPath = path.join(dir, objectId + ext);
    const metaPath = path.join(dir, objectId + '.meta.json');
    const ref = {
      objectId,
      kind: actualKind,
      sha256: bodySha,
      path: path.relative(workDir, bodyPath).split('\\').join('/'),
      metadataPath: path.relative(workDir, metaPath).split('\\').join('/')
    };
    atomicImmutableWrite(bodyPath, text);
    atomicImmutableWrite(metaPath, JSON.stringify({ ref, metadata: metadata || {} }, null, 2));
    fsyncAppendLine(path.join(root, 'events.jsonl'), {
      at: new Date().toISOString(),
      type: 'object-persisted',
      sessionId: actualSession,
      kind: actualKind,
      objectId,
      sha256: bodySha
    });
    return ref;
  }
  return { root, sessionId, appendObject };
}
function semanticSafeConfigRef(cfg) {
  const safe = {
    provider: cfg && cfg.provider || null,
    baseUrl: cfg && cfg.baseUrl || null,
    model: cfg && cfg.model || null,
    maxTokens: cfg && cfg.maxTokens || null,
    temperature: cfg && cfg.temperature !== undefined ? cfg.temperature : null
  };
  return {
    sha256: crypto.createHash('sha256').update(Buffer.from(JSON.stringify(safe), 'utf8')).digest('hex'),
    provider: safe.provider,
    model: safe.model,
    maxTokens: safe.maxTokens,
    temperature: safe.temperature
  };
}
function semanticExecutionClass(configLike) {
  return String(configLike && configLike.provider || '') === 'mock' ? 'mock' : 'non-mock';
}
function executionClassError(label, recorded, requested) {
  const e = new Error('[executor] ' + String(label || 'semantic authority') +
    ' execution class mismatch: recorded=' + String(recorded || 'unknown') +
    ' requested=' + String(requested || 'unknown'));
  e.code = 'ERR_TEST_EXECUTION_CLASS_MISMATCH';
  e.recordedExecutionClass = recorded || null;
  e.requestedExecutionClass = requested || null;
  return e;
}
function stableStructuralJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableStructuralJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ':' + stableStructuralJson(value[key])).join(',') + '}';
  }
  const scalar = JSON.stringify(value);
  return scalar === undefined ? String(value) : scalar;
}
function structuralJsonEqual(a, b) {
  return stableStructuralJson(a) === stableStructuralJson(b);
}
function receiptExecutionClass(requestConfigRef, rawConfigRef, label) {
  const requestRef = requestConfigRef && typeof requestConfigRef === 'object' ? requestConfigRef : null;
  const rawRef = rawConfigRef && typeof rawConfigRef === 'object' ? rawConfigRef : null;
  if (requestRef && rawRef && !structuralJsonEqual(requestRef, rawRef)) {
    throw executionClassError(String(label || 'request/raw') + ' configRef', 'request/raw-drift', 'exact-match');
  }
  const configRef = requestRef || rawRef;
  if (!configRef || !String(configRef.provider || '')) return null;
  return semanticExecutionClass(configRef);
}
function assertExecutionClassForResume(immutableClass, recordedClass, cfg, label) {
  const requested = semanticExecutionClass(cfg);
  const immutable = immutableClass || null;
  const recorded = recordedClass || null;
  if (immutable && recorded && immutable !== recorded) {
    throw executionClassError(String(label || 'semantic authority') + ' provenance/immutable', recorded, immutable);
  }
  const proven = immutable || recorded;
  // Legacy/unclassified TEST state may continue only in the explicit mock lane.
  // A non-mock active run must never promote unknown historical bytes into real authority.
  if (!proven) {
    if (requested === 'mock') return 'mock';
    throw executionClassError(label, null, requested);
  }
  if (proven !== requested) throw executionClassError(label, proven, requested);
  return proven;
}

function proveGlobalDirectExecutionContext(workDir, prepared, opts, label, allowMockFixture) {
  opts = opts || {};
  const priorActive = prepared && prepared.active;
  if (!priorActive || !priorActive.binding) {
    const e = new Error('[executor] ' + String(label || 'direct semantic helper') +
      ' requires a prepared TEST authority context');
    e.code = 'ERR_TEST_SEMANTIC_RECOVERY_REQUIRED';
    throw e;
  }
  // SC source-level host tests intentionally use a minimal global fixture rather than a
  // full TEST global authority. Preserve that historical seam only for explicit mock class:
  // an unclassified fixture can never authorize non-mock execution, and global reopen itself
  // never receives this compatibility path.
  if (!priorActive.attestation) {
    if (allowMockFixture !== true || !priorActive.store || !prepared.current || !prepared.current.semanticRef) {
      const e = new Error('[executor] ' + String(label || 'direct semantic helper') +
        ' requires immutable global authority proof');
      e.code = 'ERR_TEST_SEMANTIC_RECOVERY_REQUIRED';
      throw e;
    }
    const executionClass = assertExecutionClassForResume(null, null, opts.cfg,
      label || 'direct semantic helper fixture');
    return { active: priorActive, current: prepared.current, storeRecovery: null,
      immutableReceipt: null, executionClass, mockFixture: true };
  }
  // Direct helpers are public seams: caller-owned prepared fields are hints, never authority.
  // Rebuild the execution closure from this call's cfg/transport, then prove the canonical
  // current from immutable ancestry before any new model call or authority publication.
  const active = createTestActiveWorkflow(workDir, Object.assign({}, opts, {
    semanticFirstMode: 'active',
    semanticContextText: priorActive.binding.contextText || null,
    testSemanticAuthority: priorActive.attestation
  }));
  let storeRecovery;
  try { storeRecovery = active.store.recoverInterruptedState(active.sessionId); }
  catch (e) {
    const err = new Error('[executor] ' + String(label || 'direct semantic helper') +
      ' store recovery failed: ' + e.message);
    err.code = 'ERR_TEST_SEMANTIC_RECOVERY_REQUIRED';
    err.cause = e;
    throw err;
  }
  const current = storeRecovery.current;
  let immutableReceipt;
  try { immutableReceipt = recoverTestPublicationFromStore(workDir, active, current, storeRecovery); }
  catch (e) {
    const err = new Error('[executor] ' + String(label || 'direct semantic helper') +
      ' immutable-chain proof failed: ' + e.message);
    err.code = 'ERR_TEST_SEMANTIC_RECOVERY_REQUIRED';
    err.cause = e;
    throw err;
  }
  const diskProvenance = readTestProvenance(workDir);
  const executionClass = assertExecutionClassForResume(
    immutableReceipt.executionClass,
    diskProvenance && diskProvenance.executionClass,
    opts.cfg,
    label || 'direct semantic helper');
  return { active, current, storeRecovery, immutableReceipt, executionClass };
}

function semanticSourceBinding(workDir, opts) {
  const sourcePath = path.join(workDir, '.tmp-debate.txt');
  const sourceText = fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath, 'utf8') : '';
  const sourceSha256 = sourceText
    ? crypto.createHash('sha256').update(Buffer.from(sourceText, 'utf8')).digest('hex')
    : null;
  const contextValue = opts && opts.semanticContextText != null
    ? opts.semanticContextText
    : (opts && opts.cfg && opts.cfg.__semanticContextText != null ? opts.cfg.__semanticContextText : '');
  const contextText = String(contextValue || '');
  return {
    sourcePath: sourceText ? '.tmp-debate.txt' : null,
    sourceText,
    sourceSha256,
    contextText,
    contextSha256: contextText
      ? crypto.createHash('sha256').update(Buffer.from(contextText, 'utf8')).digest('hex')
      : null
  };
}
const TEST_SC_SESSION_ID = 'test-sc-current';

function scGlobalBinding(testPrepared) {
  if (!testPrepared || !testPrepared.active || !testPrepared.current || !testPrepared.current.semanticRef) {
    throw new Error('[executor] V10 SC authority requires verified global semantic current');
  }
  const semanticObj = testPrepared.active.store.readObject(testPrepared.current.semanticRef);
  const globalSemantic = String(semanticObj.content || '');
  if (!globalSemantic) throw new Error('[executor] V10 SC authority global semantic bytes are empty');
  const identity = {
    revision: testPrepared.current.revision,
    objectId: testPrepared.current.semanticRef.objectId,
    sha256: testPrepared.current.semanticRef.sha256
  };
  return {
    globalSemantic,
    identity,
    contextSha256: SCA.sha256Text(JSON.stringify(identity) + '\u0000' + globalSemantic)
  };
}

function buildScCurrentView(current, authority, globalBinding) {
  return {
    revision: current.revision,
    sourceSha256: current.sourceSha256,
    contextSha256: current.contextSha256,
    semanticObjectId: current.semanticRef && current.semanticRef.objectId || null,
    projectionObjectId: current.projectionRef && current.projectionRef.objectId || null,
    globalSemanticRevision: globalBinding.identity.revision,
    globalSemanticObjectId: globalBinding.identity.objectId,
    authority
  };
}

const TEST_SC_PROVENANCE_FILE = 'sc-semantic-provenance.json';
function scProvenancePath(workDir) { return path.join(workDir, TEST_SC_PROVENANCE_FILE); }
function scBindingIdentityFromProvenance(workDir, p) {
  if (!p || p.schema !== 'judge-sc-semantic-provenance-v1' || p.sessionId !== TEST_SC_SESSION_ID || p.profileId !== SCA.PROFILE_ID || p.profileBundleSha256 !== SCA.profileBundleSha256() || p.scope !== 'SC_ONLY_NOT_FINAL_VERDICT' || !Number.isInteger(Number(p.revision)) || Number(p.revision) < 1 || String(p.sourceSha256 || '').length !== 64 || !p.globalSemantic || !Number.isInteger(Number(p.globalSemantic.revision)) || !String(p.globalSemantic.objectId || '') || !p.authority || !p.authority.semanticRef || !p.authority.projectionRef || !String(p.authority.semanticRef.objectId || '') || !String(p.authority.projectionRef.objectId || '')) throw consumerAuthorityError('SC provenance identity incomplete');
  const current = semanticStoreModule().createProductionSemanticStore(workDir).readCurrent(TEST_SC_SESSION_ID);
  if (Number(current.revision) !== Number(p.revision) || String(current.sourceSha256 || '') !== String(p.sourceSha256 || '') || !current.semanticRef || !current.projectionRef || String(current.semanticRef.objectId || '') !== String(p.authority.semanticRef.objectId || '') || String(current.projectionRef.objectId || '') !== String(p.authority.projectionRef.objectId || '')) throw consumerAuthorityError('SC provenance identity is stale against current store head');
  return { revision:Number(p.revision), sourceSha256:String(p.sourceSha256 || ''), semanticObjectId:String(p.authority.semanticRef.objectId || ''), projectionObjectId:String(p.authority.projectionRef.objectId || ''), globalSemanticRevision:Number(p.globalSemantic.revision), globalSemanticObjectId:String(p.globalSemantic.objectId || '') };
}
function writeScProvenance(workDir, doc) {
  const file = scProvenancePath(workDir);
  const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx');
    fs.writeFileSync(fd, JSON.stringify(doc, null, 2), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    throw e;
  }
  return doc;
}
function readScProvenance(workDir) {
  const file = scProvenancePath(workDir);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    const err = new Error('[executor] V10 SC provenance invalid JSON: ' + e.message);
    err.code = 'ERR_TEST_SC_PROVENANCE_INVALID';
    throw err;
  }
}
function scSystemForRole(role) {
  const map = {
    'sc-inventory-discover': SCA.INVENTORY_SYSTEM,
    'sc-inventory-review': SCA.INVENTORY_REVIEW_SYSTEM,
    'sc-analyze': SCA.ANALYZE_SYSTEM,
    'sc-review': SCA.REVIEW_SYSTEM,
    'sc-project': SCA.PROJECT_SYSTEM,
    'sc-fidelity': SCA.FIDELITY_SYSTEM
  };
  return map[String(role || '')] || null;
}

function validateScRequestReceipt(store, rawRef, expectedRole, current, globalBinding, sourceText, opts) {
  opts = opts || {};
  const raw = store.readObject(rawRef);
  const rm = raw.metadata || {};
  const expectedSystem = scSystemForRole(expectedRole);
  if (!expectedSystem) throw new Error('SC request receipt unknown role: ' + expectedRole);
  if (rm.role !== expectedRole || !rm.requestRef || !rm.requestId ||
      rm.completion_status !== 'verified_complete' ||
      rm.sourceSha256 !== current.sourceSha256 ||
      rm.contextSha256 !== current.contextSha256) {
    throw new Error('SC raw request receipt identity/completion mismatch for ' + expectedRole);
  }

  const requestObj = store.readObject(rm.requestRef);
  let request;
  try { request = JSON.parse(requestObj.content); }
  catch (e) { throw new Error('SC request receipt JSON invalid for ' + expectedRole + ': ' + e.message); }
  const qm = requestObj.metadata || {};
  if (!request || request.requestId !== rm.requestId || request.role !== expectedRole ||
      request.system !== expectedSystem ||
      !Array.isArray(request.messages) || request.messages.length !== 1 ||
      !request.messages[0] || request.messages[0].role !== 'user') {
    throw new Error('SC request identity/system mismatch for ' + expectedRole);
  }
  const executionClass = receiptExecutionClass(request.configRef || null, rm.configRef || null,
    'SC ' + expectedRole + ' request');
  if (qm.configRef && !structuralJsonEqual(qm.configRef, request.configRef || null)) {
    throw new Error('SC request metadata configRef mismatch for ' + expectedRole);
  }
  if (qm.role !== expectedRole ||
      qm.sourceSha256 !== current.sourceSha256 ||
      qm.contextSha256 !== current.contextSha256 ||
      Number(qm.globalSemanticRevision) !== Number(globalBinding.identity.revision) ||
      String(qm.globalSemanticObjectId || '') !== String(globalBinding.identity.objectId || '') ||
      qm.profileId !== SCA.PROFILE_ID ||
      qm.profileBundleSha256 !== SCA.profileBundleSha256()) {
    throw new Error('SC request metadata source/global/profile binding mismatch for ' + expectedRole);
  }

  const expectedIssueRef = opts.issueRef || null;
  const requestIssueRef = qm.reopenIssueRef || null;
  const rawIssueRef = rm.reopenIssueRef || null;
  if (expectedIssueRef) {
    if (!sameRef(requestIssueRef, expectedIssueRef) || !sameRef(rawIssueRef, expectedIssueRef)) {
      throw new Error('SC reopen request receipt issueRef mismatch for ' + expectedRole);
    }
  } else if (requestIssueRef || rawIssueRef) {
    throw new Error('SC non-reopen request unexpectedly carries reopenIssueRef for ' + expectedRole);
  }

  const content = String(request.messages[0].content || '');
  if (!content.includes(String(sourceText || '')) ||
      !content.includes(String(globalBinding.globalSemantic || ''))) {
    throw new Error('SC request does not consume bound source/global semantic for ' + expectedRole);
  }
  for (const fragment of opts.requiredFragments || []) {
    if (fragment && !content.includes(String(fragment))) {
      throw new Error('SC request missing bound input fragment for ' + expectedRole);
    }
  }
  return { raw, requestRef: rm.requestRef, request, content, executionClass };
}

function loadScFrozenInventory(store, semanticMeta, current, globalBinding, sourceText) {
  const sm = semanticMeta || {};
  if (!sm.inventoryRef) throw new Error('SC semantic object missing frozen inventory ref');
  const frozenObj = store.readObject(sm.inventoryRef);
  const fim = frozenObj.metadata || {};
  if (fim.state !== 'sc-inventory-frozen' || !fim.inventoryARef || !fim.inventoryBRef || !fim.rawRef ||
      fim.sourceSha256 !== current.sourceSha256 || fim.contextSha256 !== current.contextSha256 ||
      fim.profileId !== SCA.PROFILE_ID || fim.profileBundleSha256 !== SCA.profileBundleSha256() ||
      Number(fim.globalSemanticRevision) !== globalBinding.identity.revision ||
      String(fim.globalSemanticObjectId || '') !== globalBinding.identity.objectId) {
    throw new Error('SC frozen reviewed inventory metadata binding mismatch');
  }
  const frozenReceipt = validateScRequestReceipt(store, fim.rawRef, 'sc-inventory-review', current, globalBinding, sourceText);
  const readStage = (ref, pass, state, rawRole) => {
    const obj = store.readObject(ref);
    const meta = obj.metadata || {};
    if (meta.state !== state || meta.pass !== pass || !meta.rawRef ||
        meta.sourceSha256 !== current.sourceSha256 || meta.contextSha256 !== current.contextSha256 ||
        meta.profileId !== SCA.PROFILE_ID || meta.profileBundleSha256 !== SCA.profileBundleSha256() ||
        Number(meta.globalSemanticRevision) !== globalBinding.identity.revision ||
        String(meta.globalSemanticObjectId || '') !== globalBinding.identity.objectId) {
      throw new Error('SC inventory stage metadata binding mismatch: ' + pass);
    }
    const receipt = validateScRequestReceipt(store, meta.rawRef, rawRole, current, globalBinding, sourceText);
    return { ref, doc: SCA.parseInventory(obj.content, sourceText, pass), executionClass: receipt.executionClass };
  };
  const discovery = readStage(fim.inventoryARef, 'discovery', 'sc-inventory-discovery', 'sc-inventory-discover');
  const reviewed = readStage(fim.inventoryBRef, 'reviewed', 'sc-inventory-review', 'sc-inventory-review');
  const inventory = SCA.parseInventory(frozenObj.content, sourceText, 'reviewed');
  if (!structuralJsonEqual(inventory, reviewed.doc)) {
    throw new Error('SC frozen inventory bytes differ from reviewed inventory stage');
  }
  const executionClasses = new Set([
    frozenReceipt.executionClass, discovery.executionClass, reviewed.executionClass
  ].filter(Boolean));
  if (executionClasses.size > 1) {
    throw executionClassError('SC frozen inventory chain', Array.from(executionClasses).join(','), 'single-class');
  }
  return {
    inventoryA: discovery.doc,
    inventoryB: reviewed.doc,
    inventory,
    executionClass: executionClasses.size === 1 ? Array.from(executionClasses)[0] : null,
    refs: { inventoryRef: sm.inventoryRef, inventoryARef: discovery.ref, inventoryBRef: reviewed.ref }
  };
}

function validateScCurrentChain(workDir, store, current, globalBinding, sourceText, commitRef) {
  if (!current || !current.semanticRef || !current.projectionRef || !current.commitId || !commitRef) {
    throw new Error('SC current/commit receipt incomplete');
  }
  const semanticObj = store.readObject(current.semanticRef);
  const sm = semanticObj.metadata || {};
  if (sm.state !== 'reviewed' || !sm.parentSemanticRef || !sm.reviewRef ||
      sm.sourceSha256 !== current.sourceSha256 || sm.contextSha256 !== current.contextSha256 ||
      sm.profileId !== SCA.PROFILE_ID || sm.profileBundleSha256 !== SCA.profileBundleSha256() ||
      Number(sm.globalSemanticRevision) !== globalBinding.identity.revision ||
      String(sm.globalSemanticObjectId || '') !== globalBinding.identity.objectId ||
      String(sm.globalSemanticSha256 || '') !== globalBinding.identity.sha256) {
    throw new Error('SC semantic object does not prove reviewed source/global binding');
  }
  const inventoryChain = loadScFrozenInventory(store, sm, current, globalBinding, sourceText);
  const parentObj = store.readObject(sm.parentSemanticRef);
  if (!sameRef((parentObj.metadata || {}).inventoryRef, inventoryChain.refs.inventoryRef)) {
    throw new Error('SC candidate semantic does not bind frozen inventory');
  }
  const parentAuthority = SCA.parseSemanticAuthority(parentObj.content);
  SCA.assertAuthorityInventoryCoverage(parentAuthority, inventoryChain.inventory);
  const reviewObj = store.readObject(sm.reviewRef);
  const rm = reviewObj.metadata || {};
  if (!rm.rawRef || !sameRef(rm.reviewedSemanticRef, sm.parentSemanticRef) ||
      !sameRef(rm.inventoryRef, inventoryChain.refs.inventoryRef) ||
      rm.sourceSha256 !== current.sourceSha256 || rm.contextSha256 !== current.contextSha256) {
    throw new Error('SC review receipt does not bind parent/source/context');
  }
  const reviewReceipt = validateScRequestReceipt(store, rm.rawRef, 'sc-review', current, globalBinding, sourceText, {
    issueRef: sm.issueRef || null,
    requiredFragments: [JSON.stringify(inventoryChain.inventory, null, 2), JSON.stringify(parentAuthority, null, 2)]
  });
  const rawReview = reviewReceipt.raw;
  const parsedReview = SCA.parseReview(rawReview.content, sourceText, parentAuthority, inventoryChain.inventory);
  const persistedReview = JSON.parse(reviewObj.content);
  if (!structuralJsonEqual(parsedReview, persistedReview) ||
      !['maintain', 'revise'].includes(parsedReview.decision) || !parsedReview.authority) {
    throw new Error('SC normalized review differs from immutable raw output or did not approve authority');
  }
  const authority = SCA.parseAuthority(semanticObj.content, sourceText);
  SCA.assertAuthorityInventoryCoverage(authority, inventoryChain.inventory);
  if (!structuralJsonEqual(SCA.semanticProjectionSnapshot(authority),
      SCA.semanticProjectionSnapshot(parsedReview.authority))) {
    throw new Error('SC current authority semantic identity differs from approved review authority');
  }
  const projectionObj = store.readObject(current.projectionRef);
  const pm = projectionObj.metadata || {};
  if (!sameRef(pm.semanticRef, current.semanticRef) || !sameRef(pm.inventoryRef, inventoryChain.refs.inventoryRef) ||
      pm.sourceSha256 !== current.sourceSha256 || pm.contextSha256 !== current.contextSha256 ||
      pm.standardProjection !== true || !pm.rawRef ||
      String(projectionObj.content) !== JSON.stringify(authority, null, 2)) {
    throw new Error('SC standard projection is not byte-bound to current authority');
  }
  const projectionReceipt = validateScRequestReceipt(store, pm.rawRef, 'sc-project', current, globalBinding, sourceText, {
    issueRef: sm.issueRef || null,
    requiredFragments: [JSON.stringify(inventoryChain.inventory, null, 2), JSON.stringify(parsedReview.authority, null, 2)]
  });
  const rawProjection = projectionReceipt.raw;
  const projectedFromRaw = SCA.parseAuthority(SCA.materializeProjectionEvidence(rawProjection.content, sourceText), sourceText);
  if (!structuralJsonEqual(projectedFromRaw, authority)) {
    throw new Error('SC projected authority differs from immutable sc-project raw output');
  }
  let fidelityRef = null;
  let fidelity = null;
  let fidelityExecutionClass = null;
  for (const ref of store.listObjects(TEST_SC_SESSION_ID).filter(x => x && x.kind === 'fidelity')) {
    try {
      const obj = store.readObject(ref);
      const fm = obj.metadata || {};
      if (!sameRef(fm.semanticRef, current.semanticRef) || !sameRef(fm.projectionRef, current.projectionRef) ||
          !sameRef(fm.inventoryRef, inventoryChain.refs.inventoryRef) ||
          fm.sourceSha256 !== current.sourceSha256 || fm.contextSha256 !== current.contextSha256 || !fm.rawRef) continue;
      const fidelityReceipt = validateScRequestReceipt(store, fm.rawRef, 'sc-fidelity', current, globalBinding, sourceText, {
        issueRef: sm.issueRef || null,
        requiredFragments: [JSON.stringify(inventoryChain.inventory, null, 2), JSON.stringify(authority, null, 2)]
      });
      const raw = fidelityReceipt.raw;
      const parsed = SCA.parseFidelity(raw.content, sourceText);
      const persisted = JSON.parse(obj.content);
      if (parsed.decision !== 'approve' || !structuralJsonEqual(parsed, persisted)) continue;
      fidelityRef = ref;
      fidelity = parsed;
      fidelityExecutionClass = fidelityReceipt.executionClass;
      break;
    } catch (_) {}
  }
  if (!fidelityRef || !fidelity) throw new Error('SC current lacks self-proving approved fidelity receipt');
  const executionClasses = new Set([
    inventoryChain.executionClass, reviewReceipt.executionClass,
    projectionReceipt.executionClass, fidelityExecutionClass
  ].filter(Boolean));
  if (executionClasses.size > 1) {
    throw executionClassError('SC current immutable authority chain', Array.from(executionClasses).join(','), 'single-class');
  }
  const executionClass = executionClasses.size === 1 ? Array.from(executionClasses)[0] : null;
  const commitObj = store.readObject(commitRef);
  const commitDoc = JSON.parse(commitObj.content);
  if (commitDoc.commitId !== current.commitId || commitDoc.revision !== current.revision ||
      !sameRef(commitDoc.semanticRef, current.semanticRef) || !sameRef(commitDoc.projectionRef, current.projectionRef) ||
      commitDoc.sourceSha256 !== current.sourceSha256 || commitDoc.contextSha256 !== current.contextSha256) {
    throw new Error('SC commit receipt does not match current');
  }
  return { authority, inventory: inventoryChain.inventory, executionClass, refs: { semanticRef: current.semanticRef, projectionRef: current.projectionRef,
    reviewRef: sm.reviewRef, fidelityRef, commitRef, parentSemanticRef: sm.parentSemanticRef,
    inventoryRef: inventoryChain.refs.inventoryRef, inventoryARef: inventoryChain.refs.inventoryARef,
    inventoryBRef: inventoryChain.refs.inventoryBRef, issueRef: sm.issueRef || null } };
}

function findScCommittedRevision(store, revision, semanticRef) {
  const matches = [];
  for (const ref of store.listObjects(TEST_SC_SESSION_ID).filter(x => x && x.kind === 'commit')) {
    try {
      const obj = store.readObject(ref);
      const doc = JSON.parse(obj.content);
      if (Number(doc.revision) !== Number(revision) || !sameRef(doc.semanticRef, semanticRef)) continue;
      matches.push({ commitRef: ref, current: doc });
    } catch (_) {}
  }
  if (matches.length !== 1) {
    throw new Error('SC ancestry requires exactly one committed parent revision ' + revision +
      ' for semantic=' + String(semanticRef && semanticRef.objectId || 'missing') + '; found=' + matches.length);
  }
  return matches[0];
}

function validateScCurrentAncestry(workDir, store, current, globalBinding, sourceText, commitRef) {
  const head = validateScCurrentChain(workDir, store, current, globalBinding, sourceText, commitRef);
  let lineageExecutionClass = head.executionClass || null;
  let cursor = current;
  while (true) {
    const semanticObj = store.readObject(cursor.semanticRef);
    const sm = semanticObj.metadata || {};
    if (cursor.lastCommitKind === 'v10-sc-authority') {
      const rootParent = store.readObject(sm.parentSemanticRef);
      if (!rootParent || !rootParent.metadata || rootParent.metadata.state !== 'candidate') {
        throw new Error('SC authority root does not terminate at a candidate semantic');
      }
      break;
    }
    if (cursor.lastCommitKind !== 'v10-sc-reopen') {
      throw new Error('SC ancestry has unknown commit kind at revision ' + cursor.revision + ': ' +
        String(cursor.lastCommitKind || 'missing'));
    }
    if (Number(cursor.revision) <= 1 || !sm.parentSemanticRef) {
      throw new Error('SC reopen ancestry missing committed parent at revision ' + cursor.revision);
    }
    const previous = findScCommittedRevision(store, Number(cursor.revision) - 1, sm.parentSemanticRef);
    if (previous.current.sourceSha256 !== current.sourceSha256 ||
        previous.current.contextSha256 !== current.contextSha256) {
      throw new Error('SC reopen ancestry source/context drift at revision ' + previous.current.revision);
    }
    const previousChain = validateScCurrentChain(workDir, store, previous.current, globalBinding, sourceText, previous.commitRef);
    if (lineageExecutionClass && previousChain.executionClass && lineageExecutionClass !== previousChain.executionClass) {
      throw executionClassError('SC reopen ancestry', previousChain.executionClass, lineageExecutionClass);
    }
    lineageExecutionClass = lineageExecutionClass || previousChain.executionClass || null;
    cursor = previous.current;
  }
  return Object.assign({}, head, { executionClass: lineageExecutionClass });
}
function scStageBaseIdentity(current) {
  current = current || {};
  const hasCompressedSemantic = Object.prototype.hasOwnProperty.call(current, 'semanticObjectId');
  const hasCompressedProjection = Object.prototype.hasOwnProperty.call(current, 'projectionObjectId');
  return {
    revision: Number(current.revision || 0),
    semanticObjectId: hasCompressedSemantic
      ? (current.semanticObjectId || null)
      : (current.semanticRef && current.semanticRef.objectId || null),
    projectionObjectId: hasCompressedProjection
      ? (current.projectionObjectId || null)
      : (current.projectionRef && current.projectionRef.objectId || null),
    sourceSha256: current.sourceSha256 || null,
    contextSha256: current.contextSha256 || null,
    lastCommitKind: current.lastCommitKind || null,
    commitId: current.commitId || null
  };
}
function sameScStageBaseIdentity(a, b) {
  return structuralJsonEqual(scStageBaseIdentity(a), scStageBaseIdentity(b));
}
function appendScReviewedStage(store, current, globalBinding, sourceSha256, generated, captured, executionClass) {
  const common = {
    sourceSha256,
    contextSha256: globalBinding.contextSha256,
    profileId: SCA.PROFILE_ID,
    profileBundleSha256: SCA.profileBundleSha256(),
    globalSemanticRevision: globalBinding.identity.revision,
    globalSemanticObjectId: globalBinding.identity.objectId
  };
  const inventoryARef = store.appendObject({
    sessionId: TEST_SC_SESSION_ID,
    kind: 'semantic',
    content: JSON.stringify(generated.inventoryA, null, 2),
    metadata: Object.assign({
      state: 'sc-inventory-discovery', pass: 'discovery',
      rawRef: captured['sc-inventory-discover'] && captured['sc-inventory-discover'].rawRef || null
    }, common)
  });
  const inventoryBRef = store.appendObject({
    sessionId: TEST_SC_SESSION_ID,
    kind: 'semantic',
    content: JSON.stringify(generated.inventoryB, null, 2),
    metadata: Object.assign({
      state: 'sc-inventory-review', pass: 'reviewed',
      rawRef: captured['sc-inventory-review'] && captured['sc-inventory-review'].rawRef || null
    }, common)
  });
  const inventoryRef = store.appendObject({
    sessionId: TEST_SC_SESSION_ID,
    kind: 'semantic',
    content: JSON.stringify(generated.inventory, null, 2),
    metadata: Object.assign({
      state: 'sc-inventory-frozen',
      inventoryARef,
      inventoryBRef,
      rawRef: captured['sc-inventory-review'] && captured['sc-inventory-review'].rawRef || null
    }, common)
  });
  const candidateRef = store.appendObject({
    sessionId: TEST_SC_SESSION_ID,
    kind: 'semantic',
    content: JSON.stringify(generated.candidate, null, 2),
    metadata: Object.assign({
      state: 'candidate',
      rawRef: captured['sc-analyze'] && captured['sc-analyze'].rawRef || null,
      inventoryRef,
      globalSemanticSha256: globalBinding.identity.sha256
    }, common)
  });
  const reviewRef = store.appendObject({
    sessionId: TEST_SC_SESSION_ID,
    kind: 'review',
    content: JSON.stringify(generated.review, null, 2),
    metadata: {
      rawRef: captured['sc-review'] && captured['sc-review'].rawRef || null,
      reviewedSemanticRef: candidateRef,
      inventoryRef,
      sourceSha256,
      contextSha256: globalBinding.contextSha256
    }
  });
  const stagedSemanticRef = store.appendObject({
    sessionId: TEST_SC_SESSION_ID,
    kind: 'semantic',
    content: JSON.stringify(generated.authority, null, 2),
    metadata: Object.assign({
      state: 'sc-reviewed-stage',
      parentSemanticRef: candidateRef,
      reviewRef,
      inventoryRef,
      globalSemanticSha256: globalBinding.identity.sha256
    }, common)
  });
  const manifestDoc = {
    schema: 'judge-sc-reviewed-stage-v1',
    baseCurrent: scStageBaseIdentity(current),
    refs: { inventoryARef, inventoryBRef, inventoryRef, candidateRef, reviewRef, stagedSemanticRef }
  };
  const manifestRef = store.appendObject({
    sessionId: TEST_SC_SESSION_ID,
    kind: 'semantic',
    content: JSON.stringify(manifestDoc, null, 2),
    metadata: Object.assign({
      state: 'sc-reviewed-stage-manifest',
      baseCurrent: manifestDoc.baseCurrent,
      executionClass: executionClass || null
    }, common)
  });
  return {
    status: 'reviewed',
    staged: true,
    manifestRef,
    refs: manifestDoc.refs,
    inventoryA: generated.inventoryA,
    inventoryB: generated.inventoryB,
    inventory: generated.inventory,
    candidate: generated.candidate,
    review: generated.review,
    reviewRaw: generated.reviewRaw,
    authority: generated.authority,
    executionClass: executionClass || null,
    baseCurrent: manifestDoc.baseCurrent
  };
}

function validateScReviewedStage(store, manifestRef, current, globalBinding, sourceText, sourceSha256, cfg) {
  const manifestObj = store.readObject(manifestRef);
  const mm = manifestObj.metadata || {};
  if (mm.state !== 'sc-reviewed-stage-manifest' ||
      mm.sourceSha256 !== sourceSha256 ||
      mm.contextSha256 !== globalBinding.contextSha256 ||
      mm.profileId !== SCA.PROFILE_ID ||
      mm.profileBundleSha256 !== SCA.profileBundleSha256() ||
      Number(mm.globalSemanticRevision) !== Number(globalBinding.identity.revision) ||
      String(mm.globalSemanticObjectId || '') !== String(globalBinding.identity.objectId || '')) {
    throw new Error('SC reviewed stage manifest source/global/profile binding mismatch');
  }
  let doc;
  try { doc = JSON.parse(manifestObj.content); }
  catch (e) { throw new Error('SC reviewed stage manifest JSON invalid: ' + e.message); }
  if (!doc || doc.schema !== 'judge-sc-reviewed-stage-v1' || !doc.refs ||
      !sameScStageBaseIdentity(doc.baseCurrent, current) ||
      !structuralJsonEqual(mm.baseCurrent || null, doc.baseCurrent || null)) {
    throw new Error('SC reviewed stage manifest base-current identity mismatch');
  }
  const refs = doc.refs;
  for (const key of ['inventoryARef','inventoryBRef','inventoryRef','candidateRef','reviewRef','stagedSemanticRef']) {
    if (!refs[key] || !refs[key].objectId) throw new Error('SC reviewed stage manifest missing ref: ' + key);
  }

  const stageCurrent = {
    sourceSha256,
    contextSha256: globalBinding.contextSha256
  };
  const stagedSemanticObj = store.readObject(refs.stagedSemanticRef);
  const sm = stagedSemanticObj.metadata || {};
  if (sm.state !== 'sc-reviewed-stage' ||
      !sameRef(sm.parentSemanticRef, refs.candidateRef) ||
      !sameRef(sm.reviewRef, refs.reviewRef) ||
      !sameRef(sm.inventoryRef, refs.inventoryRef) ||
      sm.sourceSha256 !== sourceSha256 ||
      sm.contextSha256 !== globalBinding.contextSha256 ||
      sm.profileId !== SCA.PROFILE_ID ||
      sm.profileBundleSha256 !== SCA.profileBundleSha256() ||
      Number(sm.globalSemanticRevision) !== Number(globalBinding.identity.revision) ||
      String(sm.globalSemanticObjectId || '') !== String(globalBinding.identity.objectId || '') ||
      String(sm.globalSemanticSha256 || '') !== String(globalBinding.identity.sha256 || '')) {
    throw new Error('SC staged reviewed semantic metadata binding mismatch');
  }

  const inventoryChain = loadScFrozenInventory(store, sm, stageCurrent, globalBinding, sourceText);
  if (!sameRef(inventoryChain.refs.inventoryARef, refs.inventoryARef) ||
      !sameRef(inventoryChain.refs.inventoryBRef, refs.inventoryBRef) ||
      !sameRef(inventoryChain.refs.inventoryRef, refs.inventoryRef)) {
    throw new Error('SC staged inventory refs mismatch manifest');
  }

  const candidateObj = store.readObject(refs.candidateRef);
  const cm = candidateObj.metadata || {};
  if (cm.state !== 'candidate' || !cm.rawRef || !sameRef(cm.inventoryRef, refs.inventoryRef) ||
      cm.sourceSha256 !== sourceSha256 || cm.contextSha256 !== globalBinding.contextSha256 ||
      cm.profileId !== SCA.PROFILE_ID ||
      Number(cm.globalSemanticRevision) !== Number(globalBinding.identity.revision) ||
      String(cm.globalSemanticObjectId || '') !== String(globalBinding.identity.objectId || '') ||
      String(cm.globalSemanticSha256 || '') !== String(globalBinding.identity.sha256 || '')) {
    throw new Error('SC staged candidate metadata binding mismatch');
  }
  const candidateReceipt = validateScRequestReceipt(store, cm.rawRef, 'sc-analyze', stageCurrent, globalBinding, sourceText, {
    requiredFragments: [JSON.stringify(inventoryChain.inventory, null, 2)]
  });
  const candidate = SCA.parseSemanticAuthority(candidateObj.content);
  SCA.assertAuthorityInventoryCoverage(candidate, inventoryChain.inventory);

  const reviewObj = store.readObject(refs.reviewRef);
  const rm = reviewObj.metadata || {};
  if (!rm.rawRef || !sameRef(rm.reviewedSemanticRef, refs.candidateRef) ||
      !sameRef(rm.inventoryRef, refs.inventoryRef) ||
      rm.sourceSha256 !== sourceSha256 || rm.contextSha256 !== globalBinding.contextSha256) {
    throw new Error('SC staged review metadata binding mismatch');
  }
  const reviewReceipt = validateScRequestReceipt(store, rm.rawRef, 'sc-review', stageCurrent, globalBinding, sourceText, {
    requiredFragments: [JSON.stringify(inventoryChain.inventory, null, 2), JSON.stringify(candidate, null, 2)]
  });
  const parsedReview = SCA.parseReview(reviewReceipt.raw.content, sourceText, candidate, inventoryChain.inventory);
  const persistedReview = JSON.parse(reviewObj.content);
  if (!structuralJsonEqual(parsedReview, persistedReview) ||
      !['maintain','revise'].includes(parsedReview.decision) || !parsedReview.authority) {
    throw new Error('SC staged review differs from immutable raw output or did not approve authority');
  }
  const stagedAuthority = SCA.parseSemanticAuthority(stagedSemanticObj.content);
  SCA.assertAuthorityInventoryCoverage(stagedAuthority, inventoryChain.inventory);
  if (!structuralJsonEqual(SCA.semanticProjectionSnapshot(stagedAuthority),
      SCA.semanticProjectionSnapshot(parsedReview.authority))) {
    throw new Error('SC staged semantic differs from approved review semantic truth');
  }

  const classes = new Set([
    inventoryChain.executionClass,
    candidateReceipt.executionClass,
    reviewReceipt.executionClass
  ].filter(Boolean));
  if (classes.size > 1) throw executionClassError('SC staged reviewed semantic', Array.from(classes).join(','), 'single-class');
  const derivedExecutionClass = classes.size === 1 ? Array.from(classes)[0] : null;
  if (mm.executionClass && derivedExecutionClass && mm.executionClass !== derivedExecutionClass) {
    throw executionClassError('SC staged manifest/receipt', mm.executionClass, derivedExecutionClass);
  }
  const executionClass = assertExecutionClassForResume(
    derivedExecutionClass || mm.executionClass || null,
    mm.executionClass || null,
    cfg,
    'SC staged reviewed semantic');

  return {
    status: 'reviewed',
    staged: true,
    recoveredStage: true,
    manifestRef,
    refs,
    baseCurrent: doc.baseCurrent,
    executionClass,
    inventoryA: inventoryChain.inventoryA,
    inventoryB: inventoryChain.inventoryB,
    inventory: inventoryChain.inventory,
    candidate,
    review: parsedReview,
    reviewRaw: reviewReceipt.raw.content,
    authority: stagedAuthority
  };
}

function findScReviewedStage(store, current, globalBinding, sourceText, sourceSha256, cfg) {
  const matching = [];
  for (const ref of store.listObjects(TEST_SC_SESSION_ID).filter(x => x && x.kind === 'semantic')) {
    let obj;
    try { obj = store.readObject(ref); } catch (_) { continue; }
    const meta = obj.metadata || {};
    if (meta.state !== 'sc-reviewed-stage-manifest') continue;
    if (meta.sourceSha256 !== sourceSha256 ||
        meta.contextSha256 !== globalBinding.contextSha256 ||
        meta.profileId !== SCA.PROFILE_ID ||
        meta.profileBundleSha256 !== SCA.profileBundleSha256() ||
        Number(meta.globalSemanticRevision) !== Number(globalBinding.identity.revision) ||
        String(meta.globalSemanticObjectId || '') !== String(globalBinding.identity.objectId || '')) continue;
    if (!structuralJsonEqual(meta.baseCurrent || null, scStageBaseIdentity(current))) continue;
    matching.push(ref);
  }
  if (!matching.length) return null;
  if (matching.length !== 1) {
    const e = new Error('[executor] multiple SC reviewed semantic stages match the same base/source/global identity');
    e.code = 'ERR_TEST_SC_STAGE_AMBIGUOUS';
    throw e;
  }
  try {
    return validateScReviewedStage(store, matching[0], current, globalBinding, sourceText, sourceSha256, cfg);
  } catch (error) {
    const e = new Error('[executor] SC reviewed semantic stage recovery failed: ' + error.message);
    e.code = 'ERR_TEST_SC_STAGE_RECOVERY_REQUIRED';
    e.cause = error;
    throw e;
  }
}

function buildScProvenance(current, globalBinding, chain) {
  return {
    schema: 'judge-sc-semantic-provenance-v1',
    sessionId: TEST_SC_SESSION_ID,
    profileId: SCA.PROFILE_ID,
    profileBundleSha256: SCA.profileBundleSha256(),
    revision: current.revision,
    sourceSha256: current.sourceSha256,
    contextSha256: current.contextSha256,
    executionClass: chain.executionClass || null,
    globalSemantic: {
      revision: globalBinding.identity.revision,
      objectId: globalBinding.identity.objectId,
      sha256: globalBinding.identity.sha256
    },
    authority: chain.refs,
    scope: 'SC_ONLY_NOT_FINAL_VERDICT'
  };
}
function validateScProvenance(doc, current, globalBinding, chain) {
  const p = doc;
  if (!p || p.schema !== 'judge-sc-semantic-provenance-v1' || p.sessionId !== TEST_SC_SESSION_ID ||
      p.profileId !== SCA.PROFILE_ID || p.profileBundleSha256 !== SCA.profileBundleSha256() ||
      Number(p.revision) !== Number(current.revision) || p.sourceSha256 !== current.sourceSha256 ||
      p.contextSha256 !== current.contextSha256 || p.scope !== 'SC_ONLY_NOT_FINAL_VERDICT' ||
      !p.globalSemantic || Number(p.globalSemantic.revision) !== globalBinding.identity.revision ||
      p.globalSemantic.objectId !== globalBinding.identity.objectId || p.globalSemantic.sha256 !== globalBinding.identity.sha256) {
    throw new Error('SC provenance header/current/global binding mismatch');
  }
  if (p.executionClass && chain.executionClass && p.executionClass !== chain.executionClass) {
    throw executionClassError('SC provenance/immutable authority', p.executionClass, chain.executionClass);
  }
  for (const key of ['semanticRef', 'projectionRef', 'reviewRef', 'fidelityRef', 'commitRef', 'parentSemanticRef', 'inventoryRef', 'inventoryARef', 'inventoryBRef']) {
    if (!sameRef(p.authority && p.authority[key], chain.refs[key])) throw new Error('SC provenance ref mismatch: ' + key);
  }
  const pIssue = p.authority && p.authority.issueRef || null;
  const cIssue = chain.refs.issueRef || null;
  if ((pIssue || cIssue) && !sameRef(pIssue, cIssue)) throw new Error('SC provenance issueRef mismatch');
  return p;
}

async function prepareTestScAuthority(workDir, testPrepared, opts) {
  opts = opts || {};
  const globalDirect = proveGlobalDirectExecutionContext(
    workDir, testPrepared, opts, 'SC global semantic dependency', true);
  const canonicalTestPrepared = { active: globalDirect.active, current: globalDirect.current };
  const sourceText = String(globalDirect.active && globalDirect.active.binding && globalDirect.active.binding.sourceText || '');
  const sourceSha256 = globalDirect.active && globalDirect.active.binding && globalDirect.active.binding.sourceSha256;
  if (!sourceText || !sourceSha256) throw new Error('[executor] V10 SC authority requires exact full source binding');
  const globalBinding = scGlobalBinding(canonicalTestPrepared);
  const store = globalDirect.active.store;
  const recovery = store.recoverInterruptedState(TEST_SC_SESSION_ID);
  let current = recovery.current;
  if (current.revision > 0) {
    if (current.sourceSha256 !== sourceSha256 || current.semanticReviewPending === true || current.projectionState !== 'verified' ||
        !current.semanticRef || !current.projectionRef) {
      const e = new Error('[executor] V10 SC authority current source/state drift requires audit');
      e.code = 'ERR_TEST_SC_AUTHORITY_BINDING_DRIFT';
      throw e;
    }
    // Same global semantic identity may reuse the current SC authority. If global semantic was independently
    // revised, keep the SC history but generate a new SC revision against the new context instead of silently
    // reusing old SC truth or forcing global semantic back to the prior revision.
    if (current.contextSha256 === globalBinding.contextSha256) {
      let chain;
      try { chain = validateScCurrentAncestry(workDir, store, current, globalBinding, sourceText, recovery.commitRef); }
      catch (e) {
        const err = new Error('[executor] V10 SC immutable-chain recovery failed: ' + e.message);
        err.code = 'ERR_TEST_SC_AUTHORITY_RECOVERY_REQUIRED';
        err.cause = e;
        throw err;
      }
      const existingProvenance = readScProvenance(workDir);
      const executionClass = assertExecutionClassForResume(
        chain.executionClass,
        existingProvenance && existingProvenance.executionClass,
        opts.cfg,
        'SC semantic authority');
      chain = Object.assign({}, chain, { executionClass });
      let provenance;
      let recoveredProvenance = false;
      let recoveredFromRevision = null;
      if (existingProvenance) {
        try { provenance = validateScProvenance(existingProvenance, current, globalBinding, chain); }
        catch (e) {
          const strictlyOlderSameLineage = existingProvenance.schema === 'judge-sc-semantic-provenance-v1' &&
            existingProvenance.sessionId === TEST_SC_SESSION_ID && existingProvenance.profileId === SCA.PROFILE_ID &&
            Number.isInteger(existingProvenance.revision) && existingProvenance.revision < current.revision;
          if (!strictlyOlderSameLineage) {
            const err = new Error('[executor] V10 SC provenance/current chain mismatch: ' + e.message);
            err.code = 'ERR_TEST_SC_PROVENANCE_INVALID';
            err.cause = e;
            throw err;
          }
          // Recognizable crash window: CAS/current + immutable chain are newer than the last provenance receipt.
          // Rebuild only after the complete current chain above has independently self-proved.
          recoveredProvenance = true;
          recoveredFromRevision = existingProvenance.revision;
          provenance = buildScProvenance(current, globalBinding, chain);
          writeScProvenance(workDir, provenance);
        }
      } else {
        recoveredProvenance = true;
        recoveredFromRevision = null;
        provenance = buildScProvenance(current, globalBinding, chain);
        writeScProvenance(workDir, provenance);
      }
      const authority = chain.authority;
      const currentView = buildScCurrentView(current, authority, globalBinding);
      return {
        reused: !recoveredProvenance,
        executionClass,
        recovered: recoveredProvenance,
        recoveredFromRevision,
        store,
        current,
        authority,
        inventory: chain.inventory,
        globalBinding,
        currentView,
        refs: chain.refs,
        provenance,
        authorityText: SCA.buildAuthorityBlock(currentView)
      };
    }
  }

  const call = opts.apiStub || requestCompletionNode;
  const captured = {};
  const callModel = async request => {
    const requestId = 'v10-' + request.role + '-' + crypto.createHash('sha256')
      .update(Buffer.from(JSON.stringify(request.messages || []), 'utf8')).digest('hex').slice(0, 12);
    const configRef = semanticSafeConfigRef(opts.cfg);
    const requestRef = store.appendObject({
      sessionId: TEST_SC_SESSION_ID,
      kind: 'request',
      content: JSON.stringify({
        requestId,
        role: request.role,
        system: request.system || null,
        messages: request.messages || [],
        configRef
      }, null, 2),
      metadata: {
        role: request.role,
        sourceSha256,
        contextSha256: globalBinding.contextSha256,
        globalSemanticRevision: globalBinding.identity.revision,
        globalSemanticObjectId: globalBinding.identity.objectId,
        profileId: SCA.PROFILE_ID,
        profileBundleSha256: SCA.profileBundleSha256(),
        configRef
      }
    });
    const callOpts = { system: request.system || undefined, returnEnvelope: true, mockResponder: opts.mockResponder };
    if (opts.codexRunner) callOpts.codexRunner = opts.codexRunner;
    const envelope = normalizeCapturedCompletion(await call(opts.cfg, request.messages, callOpts), opts.cfg);
    if (opts.cfg && opts.cfg.provider !== 'mock' && envelope.completion_status !== 'verified_complete') {
      throw new Error('[executor] V10 SC authority model completion is not verified_complete for ' + request.role);
    }
    const rawRef = store.appendObject({
      sessionId: TEST_SC_SESSION_ID,
      kind: 'raw',
      content: envelope.text,
      metadata: {
        role: request.role,
        requestId,
        requestRef,
        completion_status: envelope.completion_status,
        sourceSha256,
        contextSha256: globalBinding.contextSha256,
        globalSemanticRevision: globalBinding.identity.revision,
        globalSemanticObjectId: globalBinding.identity.objectId,
        configRef
      }
    });
    captured[request.role] = { requestRef, rawRef };
    return envelope;
  };

  let staged = findScReviewedStage(store, current, globalBinding, sourceText, sourceSha256, opts.cfg);
  if (!staged) {
    const reviewedSemantic = await SCA.generateReviewedSemantic({
      sourceText,
      globalSemantic: globalBinding.globalSemantic,
      callModel,
      onStage: opts.onStage,
      issueText: '复核 frozen reviewed inventory 到 SC authority 的逐候选映射、composition、role-state、coverage 与 relation。candidate id 集合不得变化；若独立重扫发现 inventory 外的新 formed chain，必须 inventory_gap fail-close，不得在本轮追加候选。不得使用旧 P2/S8/S17 作为真值，不得裁整场胜负。'
    });
    if (reviewedSemantic.status !== 'reviewed') {
      const e = new Error('[executor] V10 SC semantic review blocked before projection: ' + reviewedSemantic.status);
      e.code = 'ERR_TEST_SC_AUTHORITY_REVIEW_BLOCKED';
      e.generated = reviewedSemantic;
      throw e;
    }
    staged = appendScReviewedStage(
      store, current, globalBinding, sourceSha256, reviewedSemantic, captured, semanticExecutionClass(opts.cfg));
    if (typeof opts.onScSemanticStageCheckpoint === 'function') {
      await Promise.resolve(opts.onScSemanticStageCheckpoint({
        stage: 'sc-reviewed-semantic',
        state: 'durable-stage-requested',
        authorityScope: 'sc',
        baseRevision: current.revision,
        sourceSha256,
        contextSha256: globalBinding.contextSha256,
        manifestRef: staged.manifestRef,
        stagedSemanticRef: staged.refs.stagedSemanticRef
      }));
    }
  } else {
    const rawFor = ref => {
      const obj = store.readObject(ref);
      return obj && obj.metadata && obj.metadata.rawRef || null;
    };
    captured['sc-inventory-discover'] = { rawRef: rawFor(staged.refs.inventoryARef) };
    captured['sc-inventory-review'] = { rawRef: rawFor(staged.refs.inventoryBRef) };
    captured['sc-analyze'] = { rawRef: rawFor(staged.refs.candidateRef) };
    captured['sc-review'] = { rawRef: rawFor(staged.refs.reviewRef) };
    if (typeof opts.onLog === 'function') {
      opts.onLog('[executor] V10 SC reviewed semantic stage 已从 immutable store 自证恢复；跳过 inventory/analyze/review，仅重跑 projection/fidelity');
    }
  }

  if (!sameScStageBaseIdentity(staged.baseCurrent, store.readCurrent(TEST_SC_SESSION_ID))) {
    const e = new Error('[executor] V10 SC reviewed semantic stage base current became stale before projection');
    e.code = 'ERR_TEST_SC_STAGE_STALE';
    throw e;
  }
  const closure = await SCA.projectReviewedAuthority({
    sourceText,
    globalSemantic: globalBinding.globalSemantic,
    inventory: staged.inventory,
    authority: staged.authority,
    review: staged.review,
    reviewRaw: staged.reviewRaw,
    callModel,
    onStage: opts.onStage
  });
  if (closure.status !== 'approved') {
    const e = new Error('[executor] V10 SC authority projection/fidelity blocked: ' + closure.status);
    e.code = 'ERR_TEST_SC_AUTHORITY_REVIEW_BLOCKED';
    e.generated = closure;
    throw e;
  }
  const generated = Object.assign({}, staged, closure);
  const inventoryARef = store.appendObject({
    sessionId: TEST_SC_SESSION_ID,
    kind: 'semantic',
    content: JSON.stringify(generated.inventoryA, null, 2),
    metadata: {
      state: 'sc-inventory-discovery', pass: 'discovery',
      rawRef: captured['sc-inventory-discover'] && captured['sc-inventory-discover'].rawRef || null,
      sourceSha256, contextSha256: globalBinding.contextSha256,
      profileId: SCA.PROFILE_ID, profileBundleSha256: SCA.profileBundleSha256(),
      globalSemanticRevision: globalBinding.identity.revision,
      globalSemanticObjectId: globalBinding.identity.objectId
    }
  });
  const inventoryBRef = store.appendObject({
    sessionId: TEST_SC_SESSION_ID,
    kind: 'semantic',
    content: JSON.stringify(generated.inventoryB, null, 2),
    metadata: {
      state: 'sc-inventory-review', pass: 'reviewed',
      rawRef: captured['sc-inventory-review'] && captured['sc-inventory-review'].rawRef || null,
      sourceSha256, contextSha256: globalBinding.contextSha256,
      profileId: SCA.PROFILE_ID, profileBundleSha256: SCA.profileBundleSha256(),
      globalSemanticRevision: globalBinding.identity.revision,
      globalSemanticObjectId: globalBinding.identity.objectId
    }
  });
  const inventoryRef = store.appendObject({
    sessionId: TEST_SC_SESSION_ID,
    kind: 'semantic',
    content: JSON.stringify(generated.inventory, null, 2),
    metadata: {
      state: 'sc-inventory-frozen', inventoryARef, inventoryBRef,
      rawRef: captured['sc-inventory-review'] && captured['sc-inventory-review'].rawRef || null,
      sourceSha256, contextSha256: globalBinding.contextSha256,
      profileId: SCA.PROFILE_ID, profileBundleSha256: SCA.profileBundleSha256(),
      globalSemanticRevision: globalBinding.identity.revision,
      globalSemanticObjectId: globalBinding.identity.objectId
    }
  });
  const candidateRef = store.appendObject({
    sessionId: TEST_SC_SESSION_ID,
    kind: 'semantic',
    content: JSON.stringify(generated.candidate, null, 2),
    metadata: {
      state: 'candidate',
      rawRef: captured['sc-analyze'] && captured['sc-analyze'].rawRef || null,
      inventoryRef,
      sourceSha256,
      contextSha256: globalBinding.contextSha256,
      profileId: SCA.PROFILE_ID,
      globalSemanticRevision: globalBinding.identity.revision,
      globalSemanticObjectId: globalBinding.identity.objectId,
      globalSemanticSha256: globalBinding.identity.sha256
    }
  });
  const reviewRef = store.appendObject({
    sessionId: TEST_SC_SESSION_ID,
    kind: 'review',
    content: JSON.stringify(generated.review, null, 2),
    metadata: {
      rawRef: captured['sc-review'] && captured['sc-review'].rawRef || null,
      reviewedSemanticRef: candidateRef,
      inventoryRef,
      sourceSha256,
      contextSha256: globalBinding.contextSha256
    }
  });
  const semanticRef = store.appendObject({
    sessionId: TEST_SC_SESSION_ID,
    kind: 'semantic',
    content: JSON.stringify(generated.authority, null, 2),
    metadata: {
      state: 'reviewed',
      parentSemanticRef: candidateRef,
      reviewRef,
      inventoryRef,
      sourceSha256,
      contextSha256: globalBinding.contextSha256,
      profileId: SCA.PROFILE_ID,
      profileBundleSha256: SCA.profileBundleSha256(),
      globalSemanticRevision: globalBinding.identity.revision,
      globalSemanticObjectId: globalBinding.identity.objectId,
      globalSemanticSha256: globalBinding.identity.sha256
    }
  });
  const projectionRef = store.appendObject({
    sessionId: TEST_SC_SESSION_ID,
    kind: 'projection',
    content: generated.projection,
    metadata: {
      semanticRef,
      inventoryRef,
      rawRef: captured['sc-project'] && captured['sc-project'].rawRef || null,
      sourceSha256,
      contextSha256: globalBinding.contextSha256,
      standardProjection: true
    }
  });
  const fidelityRef = store.appendObject({
    sessionId: TEST_SC_SESSION_ID,
    kind: 'fidelity',
    content: JSON.stringify(generated.fidelity, null, 2),
    metadata: {
      rawRef: captured['sc-fidelity'] && captured['sc-fidelity'].rawRef || null,
      semanticRef,
      projectionRef,
      inventoryRef,
      sourceSha256,
      contextSha256: globalBinding.contextSha256
    }
  });
  const expectedCurrent = store.readCurrent(TEST_SC_SESSION_ID);
  const cas = store.compareAndSetCurrent({
    sessionId: TEST_SC_SESSION_ID,
    expectedCurrent,
    nextCurrent: {
      revision: expectedCurrent.revision + 1,
      semanticRef,
      semanticReviewPending: false,
      projectionRef,
      projectionState: 'verified',
      sourceSha256,
      contextSha256: globalBinding.contextSha256,
      lastCommitKind: 'v10-sc-authority'
    }
  });
  if (cas.applied !== true) {
    const e = new Error('[executor] V10 SC authority CAS publication failed/unknown');
    e.code = 'ERR_TEST_SC_AUTHORITY_CAS';
    e.cas = cas;
    throw e;
  }
  current = cas.current;
  let chain;
  try { chain = validateScCurrentAncestry(workDir, store, current, globalBinding, sourceText, cas.commitRef); }
  catch (e) {
    const err = new Error('[executor] freshly published V10 SC authority failed self-proof: ' + e.message);
    err.code = 'ERR_TEST_SC_AUTHORITY_SELF_PROOF';
    err.cause = e;
    throw err;
  }
  const executionClass = assertExecutionClassForResume(chain.executionClass, null, opts.cfg, 'SC semantic authority');
  chain = Object.assign({}, chain, { executionClass });
  const provenance = buildScProvenance(current, globalBinding, chain);
  writeScProvenance(workDir, provenance);
  const authority = chain.authority;
  const currentView = buildScCurrentView(current, authority, globalBinding);
  return {
    reused: false,
    executionClass,
    store,
    current,
    authority,
    inventory: chain.inventory,
    globalBinding,
    currentView,
    refs: Object.assign({ candidateRef }, chain.refs),
    provenance,
    authorityText: SCA.buildAuthorityBlock(currentView)
  };
}

async function publishTestScReopen(workDir, testPrepared, scPrepared, request, opts) {
  opts = opts || {};
  const globalDirect = proveGlobalDirectExecutionContext(
    workDir, testPrepared, opts, 'SC reopen global semantic dependency', true);
  const canonicalTestPrepared = { active: globalDirect.active, current: globalDirect.current };
  const store = globalDirect.active.store;
  let scRecovery;
  try { scRecovery = store.recoverInterruptedState(TEST_SC_SESSION_ID); }
  catch (e) {
    const err = new Error('[executor] SC reopen store recovery failed: ' + e.message);
    err.code = 'ERR_TEST_SC_AUTHORITY_RECOVERY_REQUIRED';
    err.cause = e;
    throw err;
  }
  const current = scRecovery.current;
  if (!request || Number(request.expectedRevision) !== Number(current.revision)) {
    const e = new Error('[executor] SC reopen revision stale: expected=' + String(request && request.expectedRevision) + ' current=' + current.revision);
    e.code = 'ERR_TEST_SC_REOPEN_STALE_REVISION';
    throw e;
  }
  const sourceText = String(globalDirect.active.binding.sourceText || '');
  const sourceSha256 = globalDirect.active.binding.sourceSha256;
  const globalBinding = scGlobalBinding(canonicalTestPrepared);
  if (current.sourceSha256 !== sourceSha256 || current.contextSha256 !== globalBinding.contextSha256) {
    const e = new Error('[executor] SC reopen current is not bound to current source/global semantic');
    e.code = 'ERR_TEST_SC_REOPEN_BINDING_DRIFT';
    throw e;
  }
  let currentChain;
  try {
    currentChain = validateScCurrentAncestry(
      workDir, store, current, globalBinding, sourceText, scRecovery.commitRef);
  } catch (e) {
    const err = new Error('[executor] SC reopen immutable-chain proof failed: ' + e.message);
    err.code = 'ERR_TEST_SC_AUTHORITY_RECOVERY_REQUIRED';
    err.cause = e;
    throw err;
  }
  const diskScProvenance = readScProvenance(workDir);
  assertExecutionClassForResume(
    currentChain.executionClass,
    diskScProvenance && diskScProvenance.executionClass,
    opts.cfg,
    'SC semantic reopen');
  const frozenInventory = { inventory: currentChain.inventory, refs: currentChain.refs };
  const currentAuthority = currentChain.authority;
  const issueRef = store.appendObject({
    sessionId: TEST_SC_SESSION_ID,
    kind: 'issue',
    content: JSON.stringify({
      schema: 'judge-sc-semantic-reopen-v1',
      expectedRevision: current.revision,
      issue: request.issue,
      evidence: request.evidence
    }, null, 2),
    metadata: {
      repairTarget: 'sc_semantic_authority',
      expectedRevision: current.revision,
      semanticRef: current.semanticRef,
      sourceSha256,
      contextSha256: globalBinding.contextSha256
    }
  });
  const captured = {};
  const call = opts.apiStub || requestCompletionNode;
  const callModel = async modelRequest => {
    const requestId = 'v10-sc-reopen-r' + current.revision + '-' + modelRequest.role + '-' + crypto.createHash('sha256')
      .update(Buffer.from(JSON.stringify(modelRequest.messages || []), 'utf8')).digest('hex').slice(0, 12);
    const configRef = semanticSafeConfigRef(opts.cfg);
    const requestRef = store.appendObject({
      sessionId: TEST_SC_SESSION_ID,
      kind: 'request',
      content: JSON.stringify({ requestId, role: modelRequest.role, system: modelRequest.system || null, messages: modelRequest.messages || [], configRef }, null, 2),
      metadata: {
        role: modelRequest.role,
        reopenIssueRef: issueRef,
        sourceSha256,
        contextSha256: globalBinding.contextSha256,
        globalSemanticRevision: globalBinding.identity.revision,
        globalSemanticObjectId: globalBinding.identity.objectId,
        profileId: SCA.PROFILE_ID,
        profileBundleSha256: SCA.profileBundleSha256(),
        configRef
      }
    });
    const callOpts = { system: modelRequest.system || undefined, returnEnvelope: true, mockResponder: opts.mockResponder };
    if (opts.codexRunner) callOpts.codexRunner = opts.codexRunner;
    const envelope = normalizeCapturedCompletion(await call(opts.cfg, modelRequest.messages, callOpts), opts.cfg);
    if (opts.cfg && opts.cfg.provider !== 'mock' && envelope.completion_status !== 'verified_complete') {
      throw new Error('[executor] SC reopen completion is not verified_complete for ' + modelRequest.role);
    }
    const rawRef = store.appendObject({
      sessionId: TEST_SC_SESSION_ID,
      kind: 'raw',
      content: envelope.text,
      metadata: {
        role: modelRequest.role,
        requestId,
        requestRef,
        reopenIssueRef: issueRef,
        completion_status: envelope.completion_status,
        sourceSha256,
        contextSha256: globalBinding.contextSha256,
        configRef
      }
    });
    captured[modelRequest.role] = { requestRef, rawRef };
    return envelope;
  };
  const issueText = 'SC bounded reopen issue: ' + request.issue + '\nSource-grounded hints (unlocated quotes are claims, not evidence):\n' +
    formatReopenEvidenceHints(request.evidence);
  const reviewed = await SCA.reviewExistingAuthority({
    sourceText,
    globalSemantic: globalBinding.globalSemantic,
    authority: currentAuthority,
    inventory: frozenInventory.inventory,
    issueText,
    callModel,
    onStage: opts.onStage
  });
  if (reviewed.status !== 'approved') {
    return { published: false, status: reviewed.status, reviewed, current, issueRef };
  }
  const reviewRef = store.appendObject({
    sessionId: TEST_SC_SESSION_ID,
    kind: 'review',
    content: JSON.stringify(reviewed.review, null, 2),
    metadata: {
      rawRef: captured['sc-review'] && captured['sc-review'].rawRef || null,
      reviewedSemanticRef: current.semanticRef,
      inventoryRef: frozenInventory.refs.inventoryRef,
      issueRef,
      sourceSha256,
      contextSha256: globalBinding.contextSha256
    }
  });
  const semanticRef = store.appendObject({
    sessionId: TEST_SC_SESSION_ID,
    kind: 'semantic',
    content: JSON.stringify(reviewed.authority, null, 2),
    metadata: {
      state: 'reviewed',
      parentSemanticRef: current.semanticRef,
      reviewRef,
      inventoryRef: frozenInventory.refs.inventoryRef,
      issueRef,
      sourceSha256,
      contextSha256: globalBinding.contextSha256,
      profileId: SCA.PROFILE_ID,
      profileBundleSha256: SCA.profileBundleSha256(),
      globalSemanticRevision: globalBinding.identity.revision,
      globalSemanticObjectId: globalBinding.identity.objectId,
      globalSemanticSha256: globalBinding.identity.sha256
    }
  });
  const projectionRef = store.appendObject({
    sessionId: TEST_SC_SESSION_ID,
    kind: 'projection',
    content: reviewed.projection,
    metadata: {
      semanticRef,
      inventoryRef: frozenInventory.refs.inventoryRef,
      rawRef: captured['sc-project'] && captured['sc-project'].rawRef || null,
      sourceSha256,
      contextSha256: globalBinding.contextSha256,
      standardProjection: true,
      issueRef
    }
  });
  const fidelityRef = store.appendObject({
    sessionId: TEST_SC_SESSION_ID,
    kind: 'fidelity',
    content: JSON.stringify(reviewed.fidelity, null, 2),
    metadata: {
      rawRef: captured['sc-fidelity'] && captured['sc-fidelity'].rawRef || null,
      semanticRef,
      projectionRef,
      inventoryRef: frozenInventory.refs.inventoryRef,
      issueRef,
      sourceSha256,
      contextSha256: globalBinding.contextSha256
    }
  });
  const cas = store.compareAndSetCurrent({
    sessionId: TEST_SC_SESSION_ID,
    expectedCurrent: current,
    nextCurrent: {
      revision: current.revision + 1,
      semanticRef,
      semanticReviewPending: false,
      projectionRef,
      projectionState: 'verified',
      sourceSha256,
      contextSha256: globalBinding.contextSha256,
      lastCommitKind: 'v10-sc-reopen'
    }
  });
  if (cas.applied !== true) {
    const e = new Error('[executor] SC reopen CAS publication failed/unknown');
    e.code = 'ERR_TEST_SC_REOPEN_CAS';
    e.cas = cas;
    throw e;
  }
  let chain;
  try { chain = validateScCurrentAncestry(workDir, store, cas.current, globalBinding, sourceText, cas.commitRef); }
  catch (e) {
    const err = new Error('[executor] published SC reopen failed self-proof: ' + e.message);
    err.code = 'ERR_TEST_SC_REOPEN_SELF_PROOF';
    err.cause = e;
    throw err;
  }
  const executionClass = assertExecutionClassForResume(chain.executionClass, null, opts.cfg, 'SC semantic reopen publication');
  chain = Object.assign({}, chain, { executionClass });
  const provenance = buildScProvenance(cas.current, globalBinding, chain);
  writeScProvenance(workDir, provenance);
  const authority = chain.authority;
  const currentView = buildScCurrentView(cas.current, authority, globalBinding);
  return {
    published: true,
    executionClass,
    status: 'approved',
    current: cas.current,
    authority,
    currentView,
    provenance,
    authorityText: SCA.buildAuthorityBlock(currentView),
    refs: chain.refs
  };
}

function buildSemanticConsumerBinding(current) {
  if (!current || current.projectionState !== 'verified' || current.semanticReviewPending === true ||
      !current.semanticRef || !current.projectionRef || !Number.isInteger(current.revision) || current.revision < 1 ||
      !/^[a-f0-9]{64}$/.test(String(current.sourceSha256 || ''))) {
    throw consumerAuthorityError('TEST semantic current 尚未形成 reviewed semantic + verified projection');
  }
  return {
    schema: 'judge-consumer-binding-v1',
    mode: 'semantic-bound',
    revision: current.revision,
    viewRevision: 1,
    semanticRef: current.semanticRef,
    projectionRef: current.projectionRef,
    projectionState: 'verified',
    semanticReviewPending: false,
    sourceSha256: current.sourceSha256,
    contextSha256: current.contextSha256 || null,
    views: {}
  };
}

function testBindingVersionKey(binding) {
  return Number(binding && binding.revision || 0) + '.' + Number(binding && binding.viewRevision || 1) + ':' +
    String(binding && binding.semanticRef && binding.semanticRef.objectId || '') + ':' +
    String(binding && binding.projectionRef && binding.projectionRef.objectId || '');
}

function testSemanticAuthorityBlock(store, current, receipt, binding, attestation) {
  const semantic = store.readObject(current.semanticRef);
  const projection = store.readObject(current.projectionRef);
  const evidence = Array.isArray(receipt && receipt.evidenceBundle) ? receipt.evidenceBundle : [];
  const evidenceLines = evidence.length
    ? evidence.map((e, i) => '- E' + (i + 1) + ' [' + e.stage + '] source lines ' + e.lineStart + '-' + e.lineEnd + ': ' + JSON.stringify(e.quote)).join('\n')
    : '- （review/fidelity receipt 未提供 quote；不得据此跳过完整原文回查）';
  return [
    '---',
    '## SEMANTIC-FIRST ACTIVE AUTHORITY',
    '',
    'route: PRODUCTION_ACTIVE',
    'test_identity: ' + attestation.test_identity,
    'profile_id: ' + attestation.profile_id,
    'prompt_bundle_sha256: ' + attestation.prompt_bundle_sha256,
    'semantic_revision: ' + current.revision,
    'semantic_object_id: ' + current.semanticRef.objectId,
    'projection_object_id: ' + current.projectionRef.objectId,
    'review_receipt_id: ' + String(receipt && receipt.refs && receipt.refs.reviewRef && receipt.refs.reviewRef.objectId || ''),
    'fidelity_receipt_id: ' + String(receipt && receipt.refs && receipt.refs.fidelityRef && receipt.refs.fidelityRef.objectId || ''),
    'source_sha256: ' + current.sourceSha256,
    'context_sha256: ' + String(current.contextSha256 || 'null'),
    'binding_version: ' + testBindingVersionKey(binding),
    '',
    '【Source-grounded evidence bundle】',
    evidenceLines,
    '',
    '【Reviewed Semantic】',
    semantic.content,
    '',
    '【Verified Projection】',
    projection.content,
    '',
    '下游只能消费本 authority/binding 的同版本视图；旧 P2/S8/S17 或未绑定文件不得静默接管。',
    '---'
  ].join('\n');
}

const TEST_PROVENANCE_FILE = 'semantic-first-provenance.json';
function sameRef(a, b) {
  return !!a && !!b && a.objectId === b.objectId && a.kind === b.kind && a.sha256 === b.sha256;
}

function verifyDecisionFormatRepair(store, decisionObj, rawObj, label, role) {
  const meta = decisionObj && decisionObj.metadata || {};
  const rawMeta = rawObj && rawObj.metadata || {};
  const syntax = SW.repairStrictJsonSyntax(rawObj && rawObj.content, label);
  if (syntax.repaired) {
    if (!meta.formatRepair || !structuralJsonEqual(meta.formatRepair, syntax.repair)) {
      throw new Error('global ' + role + ' deterministic format repair summary missing/mismatched');
    }
    if (!meta.formatRepairRef || meta.formatRepairRef.kind !== 'issue') {
      throw new Error('global ' + role + ' deterministic format repair journal ref missing');
    }
    const journalObj = store.readObject(meta.formatRepairRef);
    const journalMeta = journalObj.metadata || {};
    if (journalMeta.repairTarget !== 'format_recovery' ||
        journalMeta.repairSchema !== 'semantic-json-structure-repair-journal-v1' ||
        journalMeta.role !== role ||
        !sameRef(journalMeta.rawRef, meta.rawRef) ||
        !sameRef(journalMeta.requestRef, rawMeta.requestRef) ||
        journalMeta.originalSha256 !== syntax.repair.originalSha256 ||
        journalMeta.repairedSha256 !== syntax.repair.repairedSha256) {
      throw new Error('global ' + role + ' deterministic format repair journal metadata mismatch');
    }
    const expectedJournal = SW.buildJsonRepairJournal(syntax, meta.rawRef, rawMeta.requestRef);
    if (String(journalObj.content) !== JSON.stringify(expectedJournal, null, 2)) {
      throw new Error('global ' + role + ' deterministic format repair journal body mismatch');
    }
  } else if (meta.formatRepair || meta.formatRepairRef) {
    throw new Error('global ' + role + ' format repair receipt claims a repair that cannot be replayed');
  }
  return syntax;
}

function verifiedV5ReviewDecision(store, reviewRef, parentSemanticRef, sourceText) {
  if (!store || !reviewRef || !parentSemanticRef) throw new Error('global V5 review receipt refs missing');
  const reviewObj = store.readObject(reviewRef);
  const rm = reviewObj.metadata || {};
  if (!rm.rawRef || !sameRef(rm.reviewedSemanticRef, parentSemanticRef)) {
    throw new Error('global V5 review receipt does not bind reviewed semantic/raw');
  }
  const parentObj = store.readObject(parentSemanticRef);
  const rawObj = store.readObject(rm.rawRef);
  if ((rawObj.metadata || {}).role !== 'review') throw new Error('global V5 review raw receipt role mismatch');
  verifyDecisionFormatRepair(store, reviewObj, rawObj, 'review decision', 'review');
  const V5 = require('./semantic-review-contract-v5.js');
  const parser = { parseStrictJsonObject: SW.parseStrictJsonObject, parseReviewDecision: SW.parseReviewDecision };
  const persisted = V5.parseV5ReviewDecision(reviewObj.content, sourceText, String(parentObj.content), parser);
  const raw = V5.parseV5ReviewDecision(rawObj.content, sourceText, String(parentObj.content), parser);
  if (!structuralJsonEqual(persisted, raw)) {
    throw new Error('normalized V5 review differs from immutable raw output');
  }
  return persisted;
}

function verifiedFidelityDecision(store, fidelityRef, sourceText) {
  if (!store || !fidelityRef) throw new Error('global fidelity receipt ref missing');
  const fidelityObj = store.readObject(fidelityRef);
  const fm = fidelityObj.metadata || {};
  if (!fm.rawRef) throw new Error('global fidelity receipt lacks rawRef');
  const rawObj = store.readObject(fm.rawRef);
  if ((rawObj.metadata || {}).role !== 'fidelity') throw new Error('global fidelity raw receipt role mismatch');
  verifyDecisionFormatRepair(store, fidelityObj, rawObj, 'fidelity decision', 'fidelity');
  const persisted = SW.parseFidelityDecision(fidelityObj.content, sourceText);
  const raw = SW.parseFidelityDecision(rawObj.content, sourceText);
  if (!structuralJsonEqual(persisted, raw)) {
    throw new Error('normalized fidelity decision differs from immutable raw output');
  }
  return persisted;
}
function verifiedCurrentGlobalReviewDecision(store, current, sourceText) {
  if (!current || !current.semanticRef) throw new Error('global semantic current missing');
  const semanticObj = store.readObject(current.semanticRef);
  const sm = semanticObj.metadata || {};
  if (!sm.reviewRef || !sm.parentSemanticRef) throw new Error('global semantic current lacks V5 review lineage');
  return verifiedV5ReviewDecision(store, sm.reviewRef, sm.parentSemanticRef, sourceText);
}

function checkFiniteNetWinnerAlignment(text, reviewDecision, control) {
  if (control && control.reopenRequested === true) return { passed: true, blocking: [] };
  const direction = String(reviewDecision && reviewDecision.net && reviewDecision.net.review_direction || '');
  const data = require('./contract.js').extractDataMarkers(String(text || ''));
  const actual = String(data['S15.获胜方'] || '');
  if (!actual) return { passed: true, blocking: [] };

  if (direction === 'balanced' || direction === 'unresolved') {
    return {
      passed: false,
      blocking: [{
        rule: 'V10-GLOBAL-NET-UNRESOLVED',
        severity: 'BLOCKING',
        authorityClass: 'consumer_contract',
        message: '当前 reviewed global net=' + direction + ' 未授权 finite winner；R3 不得自行写入 S15.获胜方=' + actual + '。若发现新的 source-grounded 不对称证据，只能提出 semantic reopen request 交由独立 reviewer。'
      }]
    };
  }

  if (direction !== 'affirmative' && direction !== 'negative') {
    return { passed: true, blocking: [] };
  }
  const expected = direction === 'affirmative' ? '正方' : '反方';
  if (actual === expected) return { passed: true, blocking: [] };
  return {
    passed: false,
    blocking: [{
      rule: 'V10-GLOBAL-NET-BINDING',
      severity: 'BLOCKING',
      authorityClass: 'consumer_contract',
      message: 'R3 S15.获胜方=' + actual + ' 与当前 reviewed global net=' + direction + ' 不一致；R3 只能忠实投影 finite net，不能另建胜负真值'
    }]
  };
}
function semanticIdentity(current) {
  return {
    revision: Number(current && current.revision || 0),
    semanticObjectId: current && current.semanticRef && current.semanticRef.objectId || null,
    projectionObjectId: current && current.projectionRef && current.projectionRef.objectId || null,
    sourceSha256: current && current.sourceSha256 || null,
    contextSha256: current && current.contextSha256 || null
  };
}
function assertSemanticIdentityUnchanged(before, after, label) {
  const a = semanticIdentity(before);
  const b = semanticIdentity(after);
  if (!structuralJsonEqual(a, b)) {
    const e = new Error('[executor] ' + String(label || 'presentation') + ' changed semantic authority identity');
    e.code = 'ERR_PRESENTATION_CHANGED_SEMANTIC_IDENTITY';
    e.before = a;
    e.after = b;
    throw e;
  }
  return a;
}
function readTestSemanticCurrent(workDir) {
  const storeModule = semanticStoreModule();
  const root = path.join(path.resolve(workDir), storeModule.ROOT_NAME || '.semantic-first-production-v1');
  // A read probe must stay read-only. The inherited store constructor eagerly creates its root,
  // which previously meant merely asking for current could leave lifecycle-looking residue behind.
  if (!fs.existsSync(root)) {
    return {
      schema: storeModule.CURRENT_SCHEMA,
      revision: 0,
      semanticRef: null,
      semanticReviewPending: true,
      projectionRef: null,
      projectionState: 'none',
      sourceSha256: null,
      contextSha256: null,
      lastCommitKind: null,
      commitId: null
    };
  }
  return storeModule.createProductionSemanticStore(workDir).readCurrent('test-active-current');
}
function buildTestProvenance(active, publication, consumerBinding, previous, presentation, executionClass) {
  const current = publication.current;
  const prior = previous && typeof previous === 'object' ? previous : null;
  return {
    schema: 'judge-semantic-first-provenance-v1',
    route: 'PRODUCTION_ACTIVE',
    testIdentity: active.attestation.test_identity,
    profileId: active.attestation.profile_id,
    promptBundleSha256: active.attestation.prompt_bundle_sha256,
    sourceSha256: current.sourceSha256,
    contextSha256: current.contextSha256 || null,
    executionClass: executionClass || (prior && prior.executionClass) || null,
    authority: {
      revision: current.revision,
      semanticRef: current.semanticRef,
      projectionRef: current.projectionRef,
      reviewRef: publication.refs.reviewRef,
      fidelityRef: publication.refs.fidelityRef,
      commitRef: publication.refs.commitRef || null
    },
    evidenceBundle: Array.isArray(publication.evidenceBundle) ? publication.evidenceBundle : [],
    consumerBinding: consumerBinding,
    reopens: prior && Array.isArray(prior.reopens) ? prior.reopens.slice() : [],
    presentation: Object.assign({ plain: false, readerGuide: false, semanticIdentityPreserved: true },
      prior && prior.presentation || {}, presentation || {})
  };
}
function writeTestProvenance(workDir, doc) {
  const file = path.join(workDir, TEST_PROVENANCE_FILE);
  const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
  let fd = null;
  try {
    fd = fs.openSync(tmp, 'wx');
    fs.writeFileSync(fd, JSON.stringify(doc, null, 2), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, file);
  } catch (e) {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    throw e;
  }
  return doc;
}
function readTestProvenance(workDir) {
  const file = path.join(workDir, TEST_PROVENANCE_FILE);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    const err = new Error('[executor] TEST semantic provenance invalid JSON: ' + e.message);
    err.code = 'ERR_TEST_PROVENANCE_INVALID';
    throw err;
  }
}
function normalizeReopenEvidenceForCompare(list) {
  return (Array.isArray(list) ? list : []).map(e => ({
    quote: String(e && e.quote || ''),
    reason: String(e && e.reason || ''),
    charStart: Number.isInteger(Number(e && e.charStart)) ? Number(e.charStart) : null,
    charEnd: Number.isInteger(Number(e && e.charEnd)) ? Number(e.charEnd) : null,
    lineStart: Number.isInteger(Number(e && e.lineStart)) ? Number(e.lineStart) : null,
    lineEnd: Number.isInteger(Number(e && e.lineEnd)) ? Number(e.lineEnd) : null,
    provenance_error: e && e.provenance_error ? String(e.provenance_error) : null
  }));
}

function validateGlobalReopenHistory(workDir, active, current, reopenRows) {
  const published = (Array.isArray(reopenRows) ? reopenRows : []).filter(x => x && x.status === 'published');
  const expectedPublished = Math.max(0, Number(current && current.revision || 0) - 1);
  if (published.length !== expectedPublished) {
    const e = new Error('[executor] TEST provenance published reopen count does not match semantic revision');
    e.code = 'ERR_TEST_PROVENANCE_REOPEN_MISMATCH';
    throw e;
  }
  if (expectedPublished === 0) return true;

  const store = active && active.store
    ? active.store
    : semanticStoreModule().createProductionSemanticStore(workDir);
  const sourceText = active && active.binding && active.binding.sourceText != null
    ? String(active.binding.sourceText)
    : fs.readFileSync(path.join(workDir, '.tmp-debate.txt'), 'utf8');
  const byRevision = new Map();
  for (const row of published) {
    const revision = Number(row && row.newRevision);
    if (!Number.isInteger(revision) || revision < 2 || byRevision.has(revision)) {
      const e = new Error('[executor] TEST provenance reopen receipt revision index invalid');
      e.code = 'ERR_TEST_PROVENANCE_REOPEN_MISMATCH';
      throw e;
    }
    byRevision.set(revision, row);
  }

  let semanticRef = current.semanticRef;
  for (let revision = Number(current.revision); revision >= 2; revision--) {
    const row = byRevision.get(revision);
    if (!row) {
      const e = new Error('[executor] TEST provenance reopen receipt missing revision ' + revision);
      e.code = 'ERR_TEST_PROVENANCE_REOPEN_MISMATCH';
      throw e;
    }
    const semanticObj = store.readObject(semanticRef);
    const sm = semanticObj.metadata || {};
    const parentRef = sm.parentSemanticRef;
    const reviewRef = sm.reviewRef;
    if (!parentRef || !reviewRef || sm.state !== 'reviewed') {
      const e = new Error('[executor] TEST provenance reopen semantic ancestry invalid at revision ' + revision);
      e.code = 'ERR_TEST_PROVENANCE_REOPEN_MISMATCH';
      throw e;
    }
    if (row.requestedRevision !== revision - 1 || row.oldRevision !== revision - 1 || row.newRevision !== revision) {
      const e = new Error('[executor] TEST provenance reopen receipt revision mismatch at revision ' + revision);
      e.code = 'ERR_TEST_PROVENANCE_REOPEN_MISMATCH';
      throw e;
    }

    let reopened;
    try {
      reopened = validateTestR3ReopenIssue(workDir, active, row.issueRef, revision - 1, parentRef,
        current.sourceSha256, current.contextSha256 || null);
    } catch (reopenError) {
      const e = new Error('[executor] TEST provenance reopen receipt invalid at revision ' + revision + ': ' + reopenError.message);
      e.code = 'ERR_TEST_PROVENANCE_REOPEN_MISMATCH';
      throw e;
    }
    if (String(row.issue || '') !== reopened.issue ||
        !structuralJsonEqual(normalizeReopenEvidenceForCompare(row.evidence),
          normalizeReopenEvidenceForCompare(reopened.evidence))) {
      const e = new Error('[executor] TEST provenance reopen receipt issue/evidence mismatch at revision ' + revision);
      e.code = 'ERR_TEST_PROVENANCE_REOPEN_MISMATCH';
      throw e;
    }

    const reviewObj = store.readObject(reviewRef);
    if (!sameRef(reviewObj.metadata && reviewObj.metadata.issueRef, row.issueRef) ||
        !sameRef(row.reviewRef, reviewRef)) {
      const e = new Error('[executor] TEST provenance reopen review receipt mismatch at revision ' + revision);
      e.code = 'ERR_TEST_PROVENANCE_REOPEN_MISMATCH';
      throw e;
    }

    if (!row.fidelityRef || !row.commitRef) {
      const e = new Error('[executor] TEST provenance reopen fidelity/commit refs missing at revision ' + revision);
      e.code = 'ERR_TEST_PROVENANCE_REOPEN_MISMATCH';
      throw e;
    }
    const fidelityObj = store.readObject(row.fidelityRef);
    const fidelity = verifiedFidelityDecision(store, row.fidelityRef, sourceText);
    const commitObj = store.readObject(row.commitRef);
    const commitDoc = JSON.parse(commitObj.content);
    if (fidelity.decision !== 'approve' ||
        !sameRef(fidelityObj.metadata && fidelityObj.metadata.semanticRef, semanticRef) ||
        !sameRef(fidelityObj.metadata && fidelityObj.metadata.projectionRef, commitDoc.projectionRef) ||
        fidelityObj.metadata.sourceSha256 !== current.sourceSha256 ||
        commitDoc.revision !== revision ||
        !sameRef(commitDoc.semanticRef, semanticRef) ||
        !commitDoc.projectionRef) {
      const e = new Error('[executor] TEST provenance reopen fidelity/commit mismatch at revision ' + revision);
      e.code = 'ERR_TEST_PROVENANCE_REOPEN_MISMATCH';
      throw e;
    }
    semanticRef = parentRef;
  }
  return true;
}

function validateTestProvenance(workDir, active, current, doc) {
  const p = doc || readTestProvenance(workDir);
  if (!p || p.schema !== 'judge-semantic-first-provenance-v1' || p.route !== 'PRODUCTION_ACTIVE' ||
      p.testIdentity !== active.attestation.test_identity || p.profileId !== active.attestation.profile_id ||
      p.promptBundleSha256 !== active.attestation.prompt_bundle_sha256) {
    const e = new Error('[executor] TEST semantic provenance route/profile binding invalid');
    e.code = 'ERR_TEST_PROVENANCE_INVALID';
    throw e;
  }
  const a = p.authority || {};
  if (a.revision !== current.revision || !sameRef(a.semanticRef, current.semanticRef) || !sameRef(a.projectionRef, current.projectionRef) ||
      !a.reviewRef || !a.fidelityRef || !a.commitRef || p.sourceSha256 !== current.sourceSha256 ||
      (p.contextSha256 || null) !== (current.contextSha256 || null)) {
    const e = new Error('[executor] TEST semantic provenance/current mismatch');
    e.code = 'ERR_TEST_PROVENANCE_CURRENT_MISMATCH';
    throw e;
  }
  // Self-proving receipt: dereference immutable review/fidelity/commit objects and prove they bind the final current.
  // Presence of an object-shaped ref is not enough; tampered exports must fail without trusting external state.
  try {
    const receiptStore = semanticStoreModule().createProductionSemanticStore(workDir);
    const semanticObj = receiptStore.readObject(current.semanticRef);
    const projectionObj = receiptStore.readObject(current.projectionRef);
    const reviewObj = receiptStore.readObject(a.reviewRef);
    const fidelityObj = receiptStore.readObject(a.fidelityRef);
    const commitObj = receiptStore.readObject(a.commitRef);
    if (!sameRef(semanticObj.metadata && semanticObj.metadata.reviewRef, a.reviewRef) ||
        semanticObj.metadata.state !== 'reviewed' || semanticObj.metadata.sourceSha256 !== current.sourceSha256 ||
        (semanticObj.metadata.contextSha256 || null) !== (current.contextSha256 || null)) {
      throw new Error('semantic object is not bound to provenance review/current source');
    }
    if (!sameRef(projectionObj.metadata && projectionObj.metadata.semanticRef, current.semanticRef) ||
        projectionObj.metadata.sourceSha256 !== current.sourceSha256 ||
        (projectionObj.metadata.contextSha256 || null) !== (current.contextSha256 || null)) {
      throw new Error('projection object is not bound to final semantic/source');
    }
    const sourceText = fs.readFileSync(path.join(workDir, '.tmp-debate.txt'), 'utf8');
    const reviewDecision = verifiedV5ReviewDecision(receiptStore, a.reviewRef, semanticObj.metadata.parentSemanticRef, sourceText);
    const fidelityDecision = verifiedFidelityDecision(receiptStore, a.fidelityRef, sourceText);
    if (!['maintain', 'revise'].includes(reviewDecision.decision) || fidelityDecision.decision !== 'approve' ||
        !sameRef(fidelityObj.metadata && fidelityObj.metadata.semanticRef, current.semanticRef) ||
        !sameRef(fidelityObj.metadata && fidelityObj.metadata.projectionRef, current.projectionRef) ||
        fidelityObj.metadata.sourceSha256 !== current.sourceSha256) {
      throw new Error('review/fidelity receipt does not approve final current');
    }
    const commitDoc = JSON.parse(commitObj.content);
    if (commitDoc.revision !== current.revision || commitDoc.commitId !== current.commitId ||
        !sameRef(commitDoc.semanticRef, current.semanticRef) || !sameRef(commitDoc.projectionRef, current.projectionRef)) {
      throw new Error('commit receipt does not match final current');
    }
  } catch (receiptError) {
    const e = new Error('[executor] TEST semantic provenance receipt chain invalid: ' + receiptError.message);
    e.code = 'ERR_TEST_PROVENANCE_RECEIPT_MISMATCH';
    throw e;
  }
  const plan = resolveConsumerBinding(workDir, p.consumerBinding || null, [], { provenanceDoc: p });
  if (plan.mode !== 'semantic-bound' || plan.revision !== current.revision ||
      plan.semanticObjectId !== current.semanticRef.objectId || plan.projectionObjectId !== current.projectionRef.objectId ||
      plan.sourceSha256 !== current.sourceSha256) {
    const e = new Error('[executor] TEST semantic provenance consumer binding mismatch');
    e.code = 'ERR_TEST_PROVENANCE_BINDING_MISMATCH';
    throw e;
  }
  const reopenRows = Array.isArray(p.reopens) ? p.reopens : [];
  validateGlobalReopenHistory(workDir, active, current, reopenRows);
  const presentation = p.presentation || {};
  if (presentation.semanticIdentityPreserved !== true) {
    const e = new Error('[executor] TEST semantic provenance presentation identity flag invalid');
    e.code = 'ERR_TEST_PROVENANCE_PRESENTATION_MISMATCH';
    throw e;
  }
  if (presentation.plain === true && !plan.views.reportPlain) {
    const e = new Error('[executor] TEST provenance claims PLAIN without a bound reportPlain view');
    e.code = 'ERR_TEST_PROVENANCE_PRESENTATION_MISMATCH';
    throw e;
  }
  if (presentation.readerGuide === true && (!plan.views.readerGuide || !plan.views.readerGuideHtml)) {
    const e = new Error('[executor] TEST provenance claims readerGuide without bound guide views');
    e.code = 'ERR_TEST_PROVENANCE_PRESENTATION_MISMATCH';
    throw e;
  }
  return p;
}

function updateTestProvenance(workDir, testSemanticAuthority, consumerBinding, presentation) {
  const attestation = validateTestSemanticAuthority(testSemanticAuthority);
  const active = { attestation };
  const current = readTestSemanticCurrent(workDir);
  const p = readTestProvenance(workDir);
  if (!p) {
    const e = new Error('[executor] TEST semantic provenance missing during update');
    e.code = 'ERR_TEST_PROVENANCE_MISSING';
    throw e;
  }
  // Failure-atomic provenance update: validate a detached candidate against the immutable
  // semantic store + current files before replacing the last known-good receipt. An invalid
  // R7/R8/final presentation update must fail closed without corrupting recoverability.
  const candidate = JSON.parse(JSON.stringify(p));
  candidate.consumerBinding = consumerBinding || candidate.consumerBinding;
  candidate.presentation = Object.assign({}, candidate.presentation || {}, presentation || {}, {
    semanticIdentityPreserved: true
  });
  const validated = validateTestProvenance(workDir, active, current, candidate);
  writeTestProvenance(workDir, candidate);
  return validated;
}

function createTestActiveWorkflow(workDir, opts) {
  opts = opts || {};
  const attestation = resolveActiveSemanticAuthority(opts);
  const binding = semanticSourceBinding(workDir, opts);
  if (!binding.sourceText || !binding.sourceSha256) {
    const e = new Error('[executor] TEST active requires exact .tmp-debate.txt source binding');
    e.code = 'ERR_TEST_SEMANTIC_SOURCE_REQUIRED';
    throw e;
  }
  const semanticStore = semanticStoreModule();
  const store = semanticStore.createProductionSemanticStore(workDir);
  const call = opts.apiStub || requestCompletionNode;
  const callOpts = { mockResponder: opts.mockResponder };
  if (opts.codexRunner) callOpts.codexRunner = opts.codexRunner;
  const workflow = SW.createWorkflow({
    callModel: async request => {
      const providerOpts = Object.assign({}, callOpts, {
        system: request.system || undefined,
        returnEnvelope: true
      });
      return normalizeCapturedCompletion(await call(opts.cfg, request.messages, providerOpts), opts.cfg);
    },
    onStage: opts.onStage,
    // Re-read from workDir on every semantic stage so source/context drift cannot be hidden by an early snapshot.
    readSource: async () => {
      const fresh = semanticSourceBinding(workDir, opts);
      return {
        sourceText: fresh.sourceText,
        contextText: fresh.contextText,
        sourceSha256: fresh.sourceSha256,
        contextSha256: fresh.contextSha256
      };
    },
    appendObject: store.appendObject,
    readObject: store.readObject,
    readCurrent: store.readCurrent,
    compareAndSetCurrent: store.compareAndSetCurrent,
    listObjects: store.listObjects
  });
  return {
    attestation,
    profile: attestation.prompt_profile,
    binding,
    store,
    workflow,
    sessionId: 'test-active-current'
  };
}

function testAuthorityRequestReceipt(active, rawRef, expectedRole, expectedRequestId, expectedPrompt) {
  const raw = active.store.readObject(rawRef);
  const meta = raw.metadata || {};
  if (meta.role !== expectedRole || meta.requestId !== expectedRequestId ||
      meta.completion_status !== 'verified_complete' || !meta.requestRef ||
      meta.sourceSha256 !== active.binding.sourceSha256 ||
      (meta.contextSha256 || null) !== (active.binding.contextSha256 || null)) {
    throw new Error('raw receipt does not prove verified ' + expectedRole + ' request/source binding');
  }
  const requestObj = active.store.readObject(meta.requestRef);
  const request = JSON.parse(requestObj.content);
  if (request.role !== expectedRole || request.requestId !== expectedRequestId ||
      request.system !== SW.semanticSystem(expectedRole) || request.sourceRef !== '.tmp-debate.txt' ||
      meta.messagesSha256 !== SW.sha256Text(JSON.stringify(request.messages)) ||
      !Array.isArray(request.messages) || request.messages.length !== 1 ||
      !request.messages[0] || request.messages[0].role !== 'user') {
    throw new Error('request receipt identity mismatch for ' + expectedRole);
  }
  const content = String(request.messages[0].content || '');
  if (!content.startsWith('【原文】\n' + active.binding.sourceText) ||
      !content.includes('【任务】\n' + String(expectedPrompt || ''))) {
    throw new Error('request receipt does not contain exact source-first TEST prompt for ' + expectedRole);
  }
  const executionClass = receiptExecutionClass(request.configRef || null, meta.configRef || null,
    'global ' + expectedRole + ' request');
  return { raw, requestRef: meta.requestRef, request, content, executionClass };
}

function persistTestR3ReopenIssue(active, current, request) {
  const expectedRevision = Number(request && request.expectedRevision);
  const issue = String(request && request.issue || '').trim();
  if (!Number.isInteger(expectedRevision) || expectedRevision !== Number(current && current.revision)) {
    throw new Error('R3 reopen immutable issue revision does not match current');
  }
  if (!issue) throw new Error('R3 reopen immutable issue text is empty');
  const evidence = SW.softAnchorEvidence(active.binding.sourceText, request && request.evidence || [], {
    label: 'R3 immutable reopen evidence',
    required: false
  });
  const doc = {
    schema: 'judge-test-r3-reopen-v1',
    expectedRevision,
    issue,
    evidence
  };
  return active.store.appendObject({
    sessionId: active.sessionId,
    kind: 'issue',
    content: JSON.stringify(doc, null, 2),
    metadata: {
      repairTarget: 'semantic_review',
      trigger: 'R3-bounded-reopen',
      expectedRevision: current.revision,
      semanticRef: current.semanticRef,
      sourceSha256: current.sourceSha256,
      contextSha256: current.contextSha256 || null
    }
  });
}

function validateTestR3ReopenIssue(workDir, active, issueRef, expectedRevision, expectedSemanticRef, expectedSourceSha256, expectedContextSha256) {
  if (!issueRef || issueRef.kind !== 'issue') throw new Error('R3 reopen review lacks immutable issueRef');
  const store = active && active.store ? active.store : semanticStoreModule().createProductionSemanticStore(workDir);
  const obj = store.readObject(issueRef);
  const meta = obj.metadata || {};
  if (meta.repairTarget !== 'semantic_review' || meta.trigger !== 'R3-bounded-reopen' ||
      Number(meta.expectedRevision) !== Number(expectedRevision) || !sameRef(meta.semanticRef, expectedSemanticRef) ||
      meta.sourceSha256 !== expectedSourceSha256 ||
      (meta.contextSha256 || null) !== (expectedContextSha256 || null)) {
    throw new Error('R3 reopen issue metadata does not bind expected revision/semantic/source');
  }
  let doc;
  try { doc = JSON.parse(obj.content); }
  catch (e) { throw new Error('R3 reopen issue JSON invalid: ' + e.message); }
  if (!doc || doc.schema !== 'judge-test-r3-reopen-v1' || Number(doc.expectedRevision) !== Number(expectedRevision) ||
      !String(doc.issue || '').trim()) {
    throw new Error('R3 reopen issue body identity invalid');
  }
  const sourceText = active && active.binding && active.binding.sourceText != null
    ? active.binding.sourceText
    : fs.readFileSync(path.join(workDir, '.tmp-debate.txt'), 'utf8');
  const anchored = SW.softAnchorEvidence(sourceText, doc.evidence || [], {
    label: 'recovered R3 semantic reopen evidence',
    required: false
  });
  const normalizeHint = e => ({
    quote: String(e && e.quote || ''),
    reason: String(e && e.reason || ''),
    provenance_error: e && e.provenance_error ? String(e.provenance_error) : null,
    charStart: Number.isInteger(e && e.charStart) ? e.charStart : null,
    charEnd: Number.isInteger(e && e.charEnd) ? e.charEnd : null,
    lineStart: Number.isInteger(e && e.lineStart) ? e.lineStart : null,
    lineEnd: Number.isInteger(e && e.lineEnd) ? e.lineEnd : null
  });
  if (!structuralJsonEqual(anchored.map(normalizeHint), (doc.evidence || []).map(normalizeHint))) {
    throw new Error('R3 reopen evidence provenance/locator drift');
  }
  const issue = String(doc.issue).trim();
  const issueText = 'R3 bounded semantic reopen issue: ' + issue + '\n' +
    'Source-grounded hints (unlocated quotes are claims, not evidence):\n' + formatReopenEvidenceHints(anchored);
  return { issueRef, expectedRevision: Number(expectedRevision), issue, evidence: anchored, issueText };
}

function recoverTestPublicationFromStore(workDir, active, current, storeRecovery) {
  if (!current || current.revision < 1 || !current.semanticRef || !current.projectionRef || !current.commitId) {
    throw new Error('current is not reconstructable');
  }
  const sourceText = active.binding.sourceText;
  let semanticRef = current.semanticRef;
  let currentReviewRef = null;
  let currentReviewDecision = null;
  const reopenReceipts = [];
  const executionClasses = new Set();
  const recoverReopenPublicationRefs = (revision, semanticRef) => {
    const commits = [];
    for (const ref of active.store.listObjects(active.sessionId).filter(r => r && r.kind === 'commit')) {
      try {
        const obj = active.store.readObject(ref);
        const doc = JSON.parse(obj.content);
        if (Number(doc.revision) !== Number(revision) || !sameRef(doc.semanticRef, semanticRef) || !doc.projectionRef) continue;
        commits.push({ ref, doc });
      } catch (_) {}
    }
    if (commits.length !== 1) {
      throw new Error('reopen recovery requires exactly one committed publication at revision ' + revision + '; found=' + commits.length);
    }
    const commit = commits[0];
    const semanticObj = active.store.readObject(semanticRef);
    const projectionObj = active.store.readObject(commit.doc.projectionRef);
    const pm = projectionObj.metadata || {};
    if (!sameRef(pm.semanticRef, semanticRef) || !pm.rawRef ||
        pm.sourceSha256 !== current.sourceSha256 ||
        (pm.contextSha256 || null) !== (current.contextSha256 || null)) {
      throw new Error('historical reopen projection receipt does not bind semantic/source at revision ' + revision);
    }
    const prefix = 'test-active-r3-reopen-r' + (revision - 1);
    const projectRequest = testAuthorityRequestReceipt(
      active, pm.rawRef, 'project', prefix + '-project', active.profile.project);
    if (projectRequest.executionClass) executionClasses.add(projectRequest.executionClass);
    if (String(projectionObj.content) !== String(projectRequest.raw.content) ||
        !projectRequest.content.includes('【已审语义】\n' + String(semanticObj.content)) ||
        !projectRequest.content.includes('【目标表示合同】\nPRODUCTION_ACTIVE same-version semantic authority after bounded R3 reopen')) {
      throw new Error('historical reopen projection request/raw does not prove committed projection at revision ' + revision);
    }

    let fidelityRef = null;
    for (const ref of active.store.listObjects(active.sessionId).filter(r => r && r.kind === 'fidelity')) {
      try {
        const obj = active.store.readObject(ref);
        const fm = obj.metadata || {};
        if (!sameRef(fm.semanticRef, semanticRef) || !sameRef(fm.projectionRef, commit.doc.projectionRef) || !fm.rawRef ||
            fm.sourceSha256 !== current.sourceSha256 ||
            (fm.contextSha256 || null) !== (current.contextSha256 || null)) continue;
        const decision = verifiedFidelityDecision(active.store, ref, sourceText);
        if (decision.decision !== 'approve') continue;
        const fidelityRequest = testAuthorityRequestReceipt(
          active, fm.rawRef, 'fidelity', prefix + '-fidelity', active.profile.fidelity);
        if (            !fidelityRequest.content.includes('【已审语义】\n' + String(semanticObj.content)) ||
            !fidelityRequest.content.includes('【实际 projection】\n' + String(projectionObj.content))) continue;
        if (fidelityRequest.executionClass) executionClasses.add(fidelityRequest.executionClass);
        fidelityRef = ref;
        break;
      } catch (e) {
        if (e && e.code === 'ERR_TEST_EXECUTION_CLASS_MISMATCH') throw e;
      }
    }
    if (!fidelityRef) throw new Error('reopen recovery lacks self-proving approved fidelity at revision ' + revision);
    return { fidelityRef, commitRef: commit.ref };
  };

  // Prove the complete semantic ancestry back to the one TEST analyze request. A recovered receipt must not
  // be able to relabel an imported/foreign semantic store with the current TEST attestation.
  for (let revision = current.revision; revision >= 1; revision--) {
    const semanticObj = active.store.readObject(semanticRef);
    const sm = semanticObj.metadata || {};
    if (sm.state !== 'reviewed' || !sm.reviewRef || !sm.parentSemanticRef ||
        sm.sourceSha256 !== current.sourceSha256 ||
        (sm.contextSha256 || null) !== (current.contextSha256 || null)) {
      throw new Error('semantic ancestry is not a reviewed TEST chain at revision ' + revision);
    }
    const reviewObj = active.store.readObject(sm.reviewRef);
    const rm = reviewObj.metadata || {};
    if (!sameRef(rm.reviewedSemanticRef, sm.parentSemanticRef) || !rm.rawRef ||
        rm.sourceSha256 !== current.sourceSha256 ||
        (rm.contextSha256 || null) !== (current.contextSha256 || null)) {
      throw new Error('review receipt does not bind semantic parent/source at revision ' + revision);
    }
    const prefix = revision === 1 ? 'test-active-authority' : 'test-active-r3-reopen-r' + (revision - 1);
    const reviewRequest = testAuthorityRequestReceipt(active, rm.rawRef, 'review', prefix + '-review', active.profile.review);
    if (reviewRequest.executionClass) executionClasses.add(reviewRequest.executionClass);
    const reviewDecision = verifiedV5ReviewDecision(active.store, sm.reviewRef, sm.parentSemanticRef, sourceText);
    if (!['maintain', 'revise'].includes(reviewDecision.decision)) {
      throw new Error('review receipt does not approve semantic revision ' + revision);
    }
    const parentObj = active.store.readObject(sm.parentSemanticRef);
    if (!reviewRequest.content.includes('【被审语义】\n' + String(parentObj.content))) {
      throw new Error('review request did not actually consume its bound parent semantic at revision ' + revision);
    }
    if (reviewDecision.decision === 'revise') {
      if (String(semanticObj.content) !== String(reviewDecision.semantic)) throw new Error('revised semantic bytes do not match review decision');
    } else if (String(semanticObj.content) !== String(parentObj.content)) {
      throw new Error('maintained semantic bytes differ from reviewed parent');
    }
    if (revision === current.revision) {
      currentReviewRef = sm.reviewRef;
      currentReviewDecision = reviewDecision;
    }
    if (revision === 1) {
      if (parentObj.metadata && parentObj.metadata.state !== 'candidate') throw new Error('root semantic parent is not analyze candidate');
      if (!parentObj.metadata || !parentObj.metadata.rawRef) throw new Error('root semantic candidate lacks analyze raw receipt');
      const analyzeRequest = testAuthorityRequestReceipt(active, parentObj.metadata.rawRef, 'analyze', 'test-active-analyze', active.profile.analyze);
      if (analyzeRequest.executionClass) executionClasses.add(analyzeRequest.executionClass);
      if (String(parentObj.content) !== String(analyzeRequest.raw.content)) {
        throw new Error('root semantic candidate bytes differ from immutable analyze raw output');
      }
      if (!reviewRequest.content.includes('【具体问题】\n' + active.profile.issueText)) {
        throw new Error('root TEST review does not bind the attested issueText');
      }
    } else {
      if (!parentObj.metadata || parentObj.metadata.state !== 'reviewed') throw new Error('semantic ancestry ended before revision 1');
      const reopen = validateTestR3ReopenIssue(workDir, active, rm.issueRef, revision - 1, sm.parentSemanticRef,
        current.sourceSha256, current.contextSha256 || null);
      if (!reviewRequest.content.includes('【具体问题】\n' + reopen.issueText)) {
        throw new Error('reopen TEST review does not bind immutable bounded-reopen issue');
      }
      const reopenPublicationRefs = recoverReopenPublicationRefs(revision, semanticRef);
      reopenReceipts.push({
        status: 'published',
        requestedRevision: reopen.expectedRevision,
        oldRevision: revision - 1,
        newRevision: revision,
        issue: reopen.issue,
        evidence: reopen.evidence,
        issueRef: reopen.issueRef,
        reviewRef: sm.reviewRef,
        fidelityRef: reopenPublicationRefs.fidelityRef,
        commitRef: reopenPublicationRefs.commitRef
      });
      semanticRef = sm.parentSemanticRef;
    }
  }

  const prefix = current.revision === 1 ? 'test-active-authority' : 'test-active-r3-reopen-r' + (current.revision - 1);
  const finalSemanticObj = active.store.readObject(current.semanticRef);
  const projectionObj = active.store.readObject(current.projectionRef);
  const pm = projectionObj.metadata || {};
  if (!sameRef(pm.semanticRef, current.semanticRef) || !pm.rawRef ||
      pm.sourceSha256 !== current.sourceSha256 ||
      (pm.contextSha256 || null) !== (current.contextSha256 || null)) {
    throw new Error('projection receipt does not bind final semantic/source');
  }
  const projectRequest = testAuthorityRequestReceipt(active, pm.rawRef, 'project', prefix + '-project', active.profile.project);
  if (projectRequest.executionClass) executionClasses.add(projectRequest.executionClass);
  if (String(projectionObj.content) !== String(projectRequest.raw.content) ||
      !projectRequest.content.includes('【已审语义】\n' + String(finalSemanticObj.content))) {
    throw new Error('projection object/request is not byte-bound to the final reviewed semantic and raw output');
  }
  const expectedContract = current.revision === 1
    ? 'PRODUCTION_ACTIVE same-version semantic authority for Judge downstream consumers'
    : 'PRODUCTION_ACTIVE same-version semantic authority after bounded R3 reopen';
  if (!projectRequest.content.includes('【目标表示合同】\n' + expectedContract)) {
    throw new Error('projection request target contract mismatch');
  }

  let fidelityRef = null;
  let fidelityDecision = null;
  for (const ref of active.store.listObjects(active.sessionId).filter(r => r && r.kind === 'fidelity')) {
    try {
      const obj = active.store.readObject(ref);
      const fm = obj.metadata || {};
      if (!sameRef(fm.semanticRef, current.semanticRef) || !sameRef(fm.projectionRef, current.projectionRef) || !fm.rawRef ||
          fm.sourceSha256 !== current.sourceSha256 || (fm.contextSha256 || null) !== (current.contextSha256 || null)) continue;
      const decision = verifiedFidelityDecision(active.store, ref, sourceText);
      if (decision.decision !== 'approve') continue;
      const fidelityRequest = testAuthorityRequestReceipt(active, fm.rawRef, 'fidelity', prefix + '-fidelity', active.profile.fidelity);
      if (fidelityRequest.executionClass) executionClasses.add(fidelityRequest.executionClass);
      if (          !fidelityRequest.content.includes('【已审语义】\n' + String(finalSemanticObj.content)) ||
          !fidelityRequest.content.includes('【实际 projection】\n' + String(projectionObj.content))) continue;
      fidelityRef = ref;
      fidelityDecision = decision;
      break;
    } catch (_) {}
  }
  if (!fidelityRef || !fidelityDecision) throw new Error('no self-proving approved TEST fidelity receipt for final projection');

  const commitRef = storeRecovery && storeRecovery.commitRef;
  if (!commitRef) throw new Error('canonical commit receipt unavailable after store recovery');
  const commitObj = active.store.readObject(commitRef);
  const commitDoc = JSON.parse(commitObj.content);
  if (commitDoc.commitId !== current.commitId || commitDoc.revision !== current.revision ||
      !sameRef(commitDoc.semanticRef, current.semanticRef) || !sameRef(commitDoc.projectionRef, current.projectionRef)) {
    throw new Error('recovered commit receipt does not match current');
  }

  return {
    current,
    refs: {
      semanticRef: current.semanticRef,
      projectionRef: current.projectionRef,
      reviewRef: currentReviewRef,
      fidelityRef,
      commitRef
    },
    evidenceBundle: currentReviewDecision.evidence.map(x => Object.assign({ stage: 'review' }, x))
      .concat(fidelityDecision.evidence.map(x => Object.assign({ stage: 'fidelity' }, x))),
    reopenReceipts: reopenReceipts.sort((a, b) => a.newRevision - b.newRevision),
    executionClass: (() => {
      if (executionClasses.size > 1) throw executionClassError('global immutable authority chain', Array.from(executionClasses).join(','), 'single-class');
      return executionClasses.size === 1 ? Array.from(executionClasses)[0] : null;
    })()
  };
}

async function prepareTestSemanticAuthority(workDir, opts) {
  opts = opts || {};
  if (semanticFirstMode(Object.assign({}, opts, { workDir })) !== 'active') return null;
  if (opts.consumerBinding) throw consumerAuthorityError('TEST active 不接受 caller-supplied competing consumerBinding');
  const active = createTestActiveWorkflow(workDir, opts);
  let storeRecovery;
  try { storeRecovery = active.store.recoverInterruptedState(active.sessionId); }
  catch (e) {
    const err = new Error('[executor] TEST semantic store recovery failed: ' + e.message);
    err.code = 'ERR_TEST_SEMANTIC_RECOVERY_REQUIRED';
    err.cause = e;
    throw err;
  }
  let current = storeRecovery.current;
  if (current.revision > 0) {
    if (current.sourceSha256 !== active.binding.sourceSha256 ||
        (current.contextSha256 || null) !== (active.binding.contextSha256 || null)) {
      const e = new Error('[executor] TEST semantic current source/context binding drift; refuse cross-input reuse');
      e.code = 'ERR_TEST_SEMANTIC_BINDING_DRIFT';
      throw e;
    }
    if (!current.semanticRef || !current.projectionRef || current.semanticReviewPending === true || current.projectionState !== 'verified') {
      const e = new Error('[executor] TEST semantic current exists but is not verified; explicit audit/recovery required');
      e.code = 'ERR_TEST_SEMANTIC_RECOVERY_REQUIRED';
      throw e;
    }
    const existingProvenance = readTestProvenance(workDir);
    if (existingProvenance) {
      try {
        let provenance;
        try {
          provenance = validateTestProvenance(workDir, active, current, existingProvenance);
        } catch (controlRefreshError) {
          // A72/A77：只有 normal run 明确声明当前 control state 已 fresh 解析/校验时，才允许暂时移除
          // 对应旧 view 来证明其余 semantic/projection authority 仍完整。外部/history verifier 不调用本 seam，
          // 因而不能借 refresh capability 给 archive 补签 sourceAnchor / human exemption。
          const refreshCandidate = JSON.parse(JSON.stringify(existingProvenance));
          const views = refreshCandidate.consumerBinding && refreshCandidate.consumerBinding.views || {};
          let refreshed = false;
          if (opts.sourceAnchorFreshResolved === true && views.sourceAnchor) {
            delete views.sourceAnchor;
            refreshed = true;
          }
          if (opts.sourceAnchorExemptionsFreshResolved === true && views.sourceAnchorExemptions) {
            delete views.sourceAnchorExemptions;
            refreshed = true;
          }
          if (!refreshed) throw controlRefreshError;
          refreshCandidate.consumerBinding.viewRevision = (Number(refreshCandidate.consumerBinding.viewRevision) || 1) + 1;
          provenance = validateTestProvenance(workDir, active, current, refreshCandidate);
        }
        const immutableReceipt = recoverTestPublicationFromStore(workDir, active, current, storeRecovery);
        const executionClass = assertExecutionClassForResume(
          immutableReceipt.executionClass, provenance.executionClass, opts.cfg, 'global semantic authority');
        const consumerBinding = provenance.consumerBinding;
        const receipt = {
          current,
          refs: provenance.authority,
          evidenceBundle: provenance.evidenceBundle || [],
          executionClass
        };
        return {
          reused: true,
          executionClass,
          active,
          current,
          consumerBinding,
          publication: receipt,
          provenance,
          authorityText: testSemanticAuthorityBlock(active.store, current, receipt, consumerBinding, active.attestation)
        };
      } catch (e) {
        const a = existingProvenance.authority || {};
        const headerMatches = existingProvenance.schema === 'judge-semantic-first-provenance-v1' &&
          existingProvenance.route === 'PRODUCTION_ACTIVE' &&
          existingProvenance.testIdentity === active.attestation.test_identity &&
          existingProvenance.profileId === active.attestation.profile_id &&
          existingProvenance.promptBundleSha256 === active.attestation.prompt_bundle_sha256;
        if (!headerMatches || !Number.isInteger(a.revision) || a.revision >= current.revision) throw e;
        // A strictly older, correctly routed receipt is a recognizable crash window after a later CAS publication.
      }
    }

    // Missing provenance, or a strictly older same-TEST receipt, may be repaired only by re-proving the immutable
    // request/raw/review/projection/fidelity/commit chain against the exact TEST attestation. No model call is allowed.
    let receipt;
    try { receipt = recoverTestPublicationFromStore(workDir, active, current, storeRecovery); }
    catch (e) {
      const err = new Error('[executor] TEST semantic immutable-chain recovery failed: ' + e.message);
      err.code = 'ERR_TEST_SEMANTIC_RECOVERY_REQUIRED';
      err.cause = e;
      throw err;
    }
    const executionClass = assertExecutionClassForResume(
      receipt.executionClass, existingProvenance && existingProvenance.executionClass, opts.cfg, 'global semantic authority recovery');
    const recoveredFromRevision = existingProvenance && existingProvenance.authority && Number.isInteger(existingProvenance.authority.revision)
      ? existingProvenance.authority.revision
      : null;
    const invalidatedLegacyViews = invalidateAfterSemanticReopen(workDir);
    const consumerBinding = buildSemanticConsumerBinding(current);
    const provenance = buildTestProvenance(active, receipt, consumerBinding, null, {
      plain: false,
      readerGuide: false,
      semanticIdentityPreserved: true
    }, executionClass);
    provenance.reopens = Array.isArray(receipt.reopenReceipts)
      ? receipt.reopenReceipts.map(x => Object.assign({}, x))
      : [];
    provenance.recovery = {
      status: 'immutable-store-reconstructed',
      fromRevision: recoveredFromRevision,
      revision: current.revision,
      terminalRecovered: !!storeRecovery.terminal_recovered,
      commitRecovered: !!storeRecovery.commit_recovered,
      staleLockRecovered: !!storeRecovery.stale_lock_recovered,
      tempFilesRemoved: Number(storeRecovery.temp_files_removed || 0)
    };
    validateTestProvenance(workDir, active, current, provenance);
    writeTestProvenance(workDir, provenance);
    return {
      reused: false,
      recovered: true,
      executionClass,
      recoveredFromRevision,
      active,
      current,
      consumerBinding,
      publication: receipt,
      provenance,
      invalidatedLegacyViews,
      authorityText: testSemanticAuthorityBlock(active.store, current, receipt, consumerBinding, active.attestation)
    };
  }

  // current=0 is not downstream authority, but it may contain a source-bound durable staging chain.
  // Reuse the completed analyze candidate and, when replayable, the exact verified review raw so a browser
  // crash / JSON-punctuation failure does not pay for the same semantic decisions twice.
  let semanticCandidateRef = null;
  let resumeReviewRawRef = null;
  const stagedRefs = active.store.listObjects(active.sessionId) || [];
  const stagedAnalyze = [];
  for (const ref of stagedRefs.filter(r => r && r.kind === 'semantic')) {
    try {
      const obj = active.store.readObject(ref);
      const meta = obj.metadata || {};
      if (meta.state !== 'candidate' || !meta.rawRef ||
          meta.sourceSha256 !== active.binding.sourceSha256 ||
          (meta.contextSha256 || null) !== (active.binding.contextSha256 || null)) continue;
      const receipt = testAuthorityRequestReceipt(active, meta.rawRef, 'analyze', 'test-active-analyze', active.profile.analyze);
      if (String(obj.content) !== String(receipt.raw.content)) continue;
      stagedAnalyze.push({ ref, obj });
    } catch (_) {}
  }
  if (stagedAnalyze.length > 1) {
    // Multiple provenance-valid semantic candidates are a semantic ambiguity, not a reason for
    // deterministic latest/longest selection. Preserve them as evidence and ask the LLM to
    // analyze the same bound source again; the fresh candidate must still pass review/fidelity.
    const ambiguityRef = active.store.appendObject({
      sessionId: active.sessionId,
      kind: 'issue',
      content: JSON.stringify({
        schema: 'judge-precurrent-semantic-ambiguity-v1',
        stage: 'analyze',
        candidateRefs: stagedAnalyze.map(x => x.ref)
      }, null, 2),
      metadata: {
        repairTarget: 'semantic_reanalysis',
        sourceSha256: active.binding.sourceSha256,
        contextSha256: active.binding.contextSha256 || null,
        candidateCount: stagedAnalyze.length
      }
    });
    if (typeof opts.onLog === 'function') {
      opts.onLog('[executor] pre-current analyze 存在多份同源合法候选；不机械择一，保留 ambiguity=' +
        String(ambiguityRef && ambiguityRef.objectId || '') + '，重新交由 LLM 语义分析');
    }
  }
  if (stagedAnalyze.length === 1) {
    semanticCandidateRef = stagedAnalyze[0].ref;
    if (typeof opts.onStage === 'function') {
      await Promise.resolve(opts.onStage({
        stage: 'semantic-analyze', state: 'complete', semanticFirst: true,
        authorityScope: 'global', recovered: true, precurrent: true
      }));
    }
    const candidateText = String(stagedAnalyze[0].obj.content);
    const V5 = require('./semantic-review-contract-v5.js');
    const parser = { parseStrictJsonObject: SW.parseStrictJsonObject, parseReviewDecision: SW.parseReviewDecision };
    const validReviewRaws = [];
    for (const ref of stagedRefs.filter(r => r && r.kind === 'raw')) {
      try {
        const raw = active.store.readObject(ref);
        const meta = raw.metadata || {};
        if (meta.role !== 'review' || meta.requestId !== 'test-active-authority-review') continue;
        const receipt = testAuthorityRequestReceipt(
          active, ref, 'review', 'test-active-authority-review', active.profile.review);
        if (!receipt.content.includes('【被审语义】\n' + candidateText) ||
            !receipt.content.includes('【具体问题】\n' + active.profile.issueText)) continue;
        V5.parseV5ReviewDecision(raw.content, active.binding.sourceText, candidateText, parser);
        validReviewRaws.push(ref);
      } catch (_) {}
    }
    if (validReviewRaws.length > 1) {
      // Two independently valid review outputs may disagree semantically. Do not choose by
      // timestamp/length/object id. Preserve both, then let publishReviewedAuthority perform
      // one fresh LLM review against the same source + candidate.
      const ambiguityRef = active.store.appendObject({
        sessionId: active.sessionId,
        kind: 'issue',
        content: JSON.stringify({
          schema: 'judge-precurrent-semantic-ambiguity-v1',
          stage: 'review',
          reviewRawRefs: validReviewRaws
        }, null, 2),
        metadata: {
          repairTarget: 'semantic_review',
          sourceSha256: active.binding.sourceSha256,
          contextSha256: active.binding.contextSha256 || null,
          reviewRawCount: validReviewRaws.length
        }
      });
      if (typeof opts.onLog === 'function') {
        opts.onLog('[executor] pre-current review 存在多份同源合法结果；不机械择一，保留 ambiguity=' +
          String(ambiguityRef && ambiguityRef.objectId || '') + '，重新交由 LLM 语义复核');
      }
      resumeReviewRawRef = null;
    } else {
      resumeReviewRawRef = validReviewRaws.length === 1 ? validReviewRaws[0] : null;
    }
  }
  if (!semanticCandidateRef) {
    const analyze = await active.workflow.analyze({
      sessionId: active.sessionId,
      sourceRef: '.tmp-debate.txt',
      contextRef: active.binding.contextText ? 'test-context' : null,
      prompt: active.profile.analyze,
      requestId: 'test-active-analyze',
      requireVerifiedCompletion: true,
      configRef: semanticSafeConfigRef(opts.cfg)
    });
    semanticCandidateRef = analyze.refs.semanticCandidateRef;
  }
  const expectedCurrent = active.store.readCurrent(active.sessionId);
  const publication = await active.workflow.publishReviewedAuthority({
    sessionId: active.sessionId,
    semanticRef: semanticCandidateRef,
    sourceRef: '.tmp-debate.txt',
    contextRef: active.binding.contextText ? 'test-context' : null,
    expectedCurrent,
    reviewPrompt: active.profile.review,
    issueText: active.profile.issueText,
    projectPrompt: active.profile.project,
    targetContract: 'PRODUCTION_ACTIVE same-version semantic authority for Judge downstream consumers',
    fidelityPrompt: active.profile.fidelity,
    requestId: 'test-active-authority',
    requireVerifiedCompletion: true,
    configRef: semanticSafeConfigRef(opts.cfg),
    resumeReviewRawRef
  });
  if (publication.status === 'commit_state_unknown' || publication.status === 'stale_result_preserved') {
    const e = new Error('[executor] TEST semantic authority commit/current state is not safely classifiable: ' + publication.status);
    e.code = 'ERR_TEST_SEMANTIC_RECOVERY_REQUIRED';
    e.publication = publication;
    throw e;
  }
  if (publication.status !== 'semantic_authority_published' || !publication.current ||
      !publication.refs.semanticRef || !publication.refs.projectionRef || !publication.refs.reviewRef || !publication.refs.fidelityRef) {
    const e = new Error('[executor] TEST semantic authority publication blocked: ' + publication.status);
    e.code = 'ERR_TEST_SEMANTIC_PUBLICATION_BLOCKED';
    e.publication = publication;
    throw e;
  }
  current = publication.current;
  // Fresh 0→1 TEST authority means every pre-existing downstream projection/presentation file is legacy/unbound.
  // This matters for imported/resumed historical sessions: leaving old P1/P2/P3/report in place would let runRound's
  // exists-first checkpoint skip silently relabel legacy bytes as views of the new semantic revision.
  const invalidatedLegacyViews = invalidateAfterSemanticReopen(workDir);
  const consumerBinding = buildSemanticConsumerBinding(current);
  const executionClass = semanticExecutionClass(opts.cfg);
  const provenance = buildTestProvenance(active, publication, consumerBinding, null, { plain: false, readerGuide: false }, executionClass);
  validateTestProvenance(workDir, active, current, provenance);
  writeTestProvenance(workDir, provenance);
  return {
    reused: false,
    executionClass,
    active,
    current,
    consumerBinding,
    publication,
    provenance,
    invalidatedLegacyViews,
    authorityText: testSemanticAuthorityBlock(active.store, current, publication, consumerBinding, active.attestation)
  };
}

function normalizeCapturedCompletion(value, cfg) {
  if (value && typeof value === 'object' && typeof value.text === 'string') return value;
  return {
    text: String(value == null ? '' : value),
    completion_status: 'unknown',
    completion_evidence: { provider: cfg && cfg.provider || 'injected', finish_reason: null },
    diagnostics: { completion_reason_unavailable: true }
  };
}
function createRoundExchangeCapture(workDir, opts, call, callOpts) {
  if (semanticFirstMode(opts) !== 'shadow') return null;
  let SW;
  try { SW = require('./semantic-workflow.js'); }
  catch (e) {
    const err = new Error('[executor] semantic-first shadow core unavailable: ' + e.message);
    err.code = 'ERR_SEMANTIC_SUBSTRATE_UNAVAILABLE';
    throw err;
  }
  const store = createSemanticSidecarStore(workDir);
  const capture = SW.createExchangeCapture({
    appendObject: store.appendObject,
    callModel: async request => {
      const providerOpts = Object.assign({}, callOpts, {
        system: request.system || undefined,
        returnEnvelope: true
      });
      return normalizeCapturedCompletion(await call(opts.cfg, request.messages, providerOpts), opts.cfg);
    }
  });
  return { store, capture };
}
function persistSemanticGateIssue(workDir, opts, round, attempt, refs, typedIssues) {
  if (semanticFirstMode(opts) !== 'shadow' || !typedIssues || !typedIssues.length) return [];
  const store = createSemanticSidecarStore(workDir);
  return typedIssues.map((issue, index) => store.appendObject({
    sessionId: store.sessionId,
    kind: 'issue',
    content: JSON.stringify(issue, null, 2),
    metadata: {
      round: round.name,
      attempt: attempt + 1,
      index,
      requestRef: refs && refs.requestRef || null,
      rawRef: refs && refs.rawRef || null,
      repairTarget: issue.repairTarget || 'representation',
      semanticInvalid: false
    }
  }));
}

function consumerAuthorityError(message) {
  const e = new Error('[executor] consumer authority: ' + message);
  e.code = 'ERR_CONSUMER_AUTHORITY';
  return e;
}
const PRODUCED_VIEW_REBIND_TOKEN = Symbol('v10-produced-view-rebind');
const TRANSIENT_CONSUMER_BINDING_CAPABILITIES = new WeakMap();
function stableConsumerBindingJson(value) {
  if (Array.isArray(value)) return '[' + value.map(stableConsumerBindingJson).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map(key =>
      JSON.stringify(key) + ':' + stableConsumerBindingJson(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}
function consumerBindingFingerprint(binding) {
  return crypto.createHash('sha256').update(stableConsumerBindingJson(binding || null), 'utf8').digest('hex');
}
function sameConsumerBindingIdentity(a, b) {
  return !!a && !!b && consumerBindingFingerprint(a) === consumerBindingFingerprint(b);
}
function isIssuedTransientConsumerBinding(binding) {
  if (!binding || typeof binding !== 'object') return false;
  const issued = TRANSIENT_CONSUMER_BINDING_CAPABILITIES.get(binding);
  return !!issued && issued === consumerBindingFingerprint(binding);
}
function issueTransientConsumerBinding(binding) {
  if (binding && typeof binding === 'object') {
    TRANSIENT_CONSUMER_BINDING_CAPABILITIES.set(binding, consumerBindingFingerprint(binding));
  }
  return binding;
}
function semanticFirstStateMarker(workDir) {
  // Explicit provenance is lifecycle evidence. The semantic store root is evidence only when it
  // contains substantive residue: createProductionSemanticStore() eagerly creates an empty root,
  // so treating the empty directory itself as authority would let a read-only probe poison a true
  // legacy workDir and incorrectly disable its compatibility lane.
  const explicit = [
    path.join(workDir, TEST_PROVENANCE_FILE),
    path.join(workDir, TEST_SC_PROVENANCE_FILE)
  ].find(p => fs.existsSync(p));
  if (explicit) return explicit;
  const storeRoot = path.join(workDir, '.semantic-first-production-v1');
  if (!fs.existsSync(storeRoot)) return null;
  try {
    const stat = fs.statSync(storeRoot);
    if (!stat.isDirectory()) return storeRoot; // malformed lifecycle residue -> fail closed
    return fs.readdirSync(storeRoot).length > 0 ? storeRoot : null;
  } catch (_) {
    return storeRoot; // unreadable lifecycle residue is not evidence of a clean legacy directory
  }
}
function resolveConsumerBinding(workDir, binding, requiredViews, control) {
  // SIXTH residual-pollution hardening: caller omission is not evidence that a semantic-first
  // workDir is legacy. Store-root/current/provenance residue all fail closed, including partial-loss windows.
  control = control || {};
  const stateMarker = semanticFirstStateMarker(workDir);
  if (!binding && stateMarker) {
    throw consumerAuthorityError('semantic-first authority/provenance state 已存在（' +
      path.relative(workDir, stateMarker).split(path.sep).join('/') +
      '）；consumer 必须显式提供当前 consumerBinding，禁止降级 legacy-unversioned/exists-first');
  }
  const PC = require('../pipeline-controller.js');
  const plan = PC.planConsumerBinding({ binding: binding || null, requiredViews: requiredViews || [] });
  if (!plan.allowed) throw consumerAuthorityError(plan.blockingReason || 'binding rejected');
  if (plan.mode === 'semantic-bound') {
    // A caller-supplied semantic-bound object is never authority by itself. A real lifecycle
    // footprint must already exist in this workDir; otherwise a legacy directory could be
    // wrapped in a forged internally-consistent binding and promoted without any current/provenance.
    if (!stateMarker) {
      throw consumerAuthorityError('semantic-bound consumer 缺少 semantic lifecycle state；binding 不能自举为 authority');
    }
    // Bind every consumer to the canonical current and to a provenance head that names the same
    // current. validateTestProvenance supplies its detached candidate here before atomic receipt
    // replacement; ordinary consumers must use the on-disk head.
    {
      let current;
      try { current = readTestSemanticCurrent(workDir); }
      catch (e) { throw consumerAuthorityError('semantic current 无法验证，禁止消费旧/未绑定视图: ' + e.message); }
      if (!current || !Number.isInteger(current.revision) || current.revision < 1 ||
          current.projectionState !== 'verified' || current.semanticReviewPending === true ||
          !current.semanticRef || !current.projectionRef) {
        throw consumerAuthorityError('semantic-first lifecycle 已进入但 canonical current 尚未形成 verified authority');
      }
      if (plan.revision !== current.revision || !sameRef(plan.semanticRef, current.semanticRef) ||
          !sameRef(plan.projectionRef, current.projectionRef) ||
          plan.sourceSha256 !== current.sourceSha256 ||
          (plan.contextSha256 || null) !== (current.contextSha256 || null)) {
        throw consumerAuthorityError('consumerBinding 与 canonical semantic current revision/object/source identity 不一致');
      }
      let provenance;
      try { provenance = control.provenanceDoc || readTestProvenance(workDir); }
      catch (e) { throw consumerAuthorityError('semantic provenance 无法验证，禁止消费: ' + e.message); }
      if (!provenance) {
        throw consumerAuthorityError('canonical semantic current 已存在但 provenance receipt 缺失；按 crash-window fail closed');
      }
      const pa = provenance.authority || {};
      if (Number(pa.revision) !== current.revision || !sameRef(pa.semanticRef, current.semanticRef) ||
          !sameRef(pa.projectionRef, current.projectionRef) ||
          provenance.sourceSha256 !== current.sourceSha256 ||
          (provenance.contextSha256 || null) !== (current.contextSha256 || null)) {
        throw consumerAuthorityError('semantic provenance head 与 canonical current 不一致');
      }
      // Current semantic identity is necessary but not sufficient to mint a presentation epoch.
      // Ordinary/direct consumers must use the durable consumerBinding named by provenance.
      // The only exception is an exact, unmodified process-local binding issued by the private
      // produced-view publication seam after it re-proved current/provenance/source/sibling views.
      const durableBinding = provenance.consumerBinding || null;
      if (!sameConsumerBindingIdentity(binding, durableBinding) && !isIssuedTransientConsumerBinding(binding)) {
        throw consumerAuthorityError('consumerBinding 未由当前 provenance 登记，也不是 produced-view seam 签发的短生命周期 binding');
      }
    }
    const sourcePath = path.join(workDir, '.tmp-debate.txt');
    if (!fs.existsSync(sourcePath)) throw consumerAuthorityError('semantic-bound 缺少 .tmp-debate.txt，无法验证 source identity');
    const sourceSha = crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex');
    if (sourceSha !== plan.sourceSha256) throw consumerAuthorityError('sourceSha256 与当前 .tmp-debate.txt 不一致');
    const replacingViews = control.producedViewRebindToken === PRODUCED_VIEW_REBIND_TOKEN
      ? new Set(Array.isArray(control.replacingViews) ? control.replacingViews.map(String) : [])
      : null;
    for (const [name, view] of Object.entries(plan.views || {})) {
      const abs = path.resolve(workDir, view.path);
      const root = path.resolve(workDir);
      if (abs !== root && !abs.startsWith(root + path.sep)) throw consumerAuthorityError('consumer view 越出 workDir: ' + name);
      // Only the private produced-view publication seam may temporarily replace the exact named view.
      // Canonical semantic/provenance/source identity above still must match; all sibling views stay hash-bound.
      if (replacingViews && replacingViews.has(name)) continue;
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw consumerAuthorityError('consumer view 文件缺失: ' + name + ' → ' + view.path);
      const got = crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex');
      if (got !== view.sha256) throw consumerAuthorityError('consumer view hash 漂移: ' + name);
    }
  }
  return plan;
}
const TEST_ROUND_BOUND_VIEW = Object.freeze({
  R1: 'P1',
  R2: 'P2',
  'R2.5': 'P2.5',
  R3: 'P3',
  R4: 'structure',
  'R4.5': 'adjudication'
});
function testRoundBoundViewName(round) {
  return round && TEST_ROUND_BOUND_VIEW[round.name] || null;
}
function isTestActiveRoundCheckpointBound(workDir, round, binding, existingText) {
  const viewName = testRoundBoundViewName(round);
  if (!viewName || !binding) return false;
  const plan = resolveConsumerBinding(workDir, binding, []);
  if (plan.mode !== 'semantic-bound') throw consumerAuthorityError('TEST active checkpoint unexpectedly resolved as legacy');
  const view = plan.views && plan.views[viewName];
  if (!view) return false;
  const rel = path.relative(workDir, path.join(workDir, round.outFile)).split('\\').join('/');
  if (String(view.path || '') !== rel) return false;
  const sha = crypto.createHash('sha256').update(Buffer.from(String(existingText || ''), 'utf8')).digest('hex');
  if (sha !== view.sha256) return false;
  if (view.semanticObjectId !== plan.semanticObjectId || view.projectionObjectId !== plan.projectionObjectId) return false;
  if (round.name === 'R3') {
    for (const name of ['finalAdjudication', 'finalAdjudicationReceipt']) {
      const sidecar = plan.views && plan.views[name];
      if (!sidecar) return false;
      const abs = path.resolve(workDir, sidecar.path);
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return false;
      if (crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex') !== sidecar.sha256) return false;
      if (sidecar.semanticObjectId !== plan.semanticObjectId || sidecar.projectionObjectId !== plan.projectionObjectId) return false;
    }
  }
  return true;
}
function consumerViewPath(workDir, plan, viewName, legacyCandidates, required) {
  if (plan && plan.mode === 'semantic-bound') {
    const view = plan.views && plan.views[viewName];
    if (!view) {
      if (required === false) return null;
      throw consumerAuthorityError('semantic-bound 缺少 view: ' + viewName);
    }
    return path.resolve(workDir, view.path);
  }
  const candidates = Array.isArray(legacyCandidates) ? legacyCandidates : [legacyCandidates];
  for (const candidate of candidates.filter(Boolean)) {
    const abs = path.isAbsolute(candidate) ? candidate : path.join(workDir, candidate);
    if (fs.existsSync(abs)) return abs;
  }
  if (required === false) return null;
  return candidates.length ? (path.isAbsolute(candidates[candidates.length - 1]) ? candidates[candidates.length - 1] : path.join(workDir, candidates[candidates.length - 1])) : null;
}
function validationConsumerViewPath(workDir, binding, viewName, legacyCandidates, required) {
  const requiredViews = binding && required !== false ? [viewName] : [];
  const plan = resolveConsumerBinding(workDir, binding || null, requiredViews);
  return consumerViewPath(workDir, plan, viewName, legacyCandidates, required);
}
function validationConsumerViewText(workDir, binding, viewName, legacyCandidates, required) {
  const file = validationConsumerViewPath(workDir, binding, viewName, legacyCandidates, required);
  return file ? readIfExists(file) : '';
}
function consumerBindingFromProducedViews(workDir, binding, updates) {
  if (!binding) return null;
  // Produced-view publication is itself an authority transition. Reuse the exact canonical-current /
  // provenance / source / existing-view validation instead of accepting an internally self-consistent
  // stale binding and rolling it forward to a new viewRevision.
  const replacing = new Set(Object.keys(updates || {}));
  const plan = resolveConsumerBinding(workDir, binding, [], {
    producedViewRebindToken: PRODUCED_VIEW_REBIND_TOKEN,
    replacingViews: Array.from(replacing)
  });
  if (plan.mode !== 'semantic-bound') return binding;
  const sourcePath = path.join(workDir, '.tmp-debate.txt');
  if (!fs.existsSync(sourcePath)) throw consumerAuthorityError('produced-view update 缺少 .tmp-debate.txt');
  const sourceSha = crypto.createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex');
  if (sourceSha !== plan.sourceSha256) throw consumerAuthorityError('produced-view update sourceSha256 漂移');
  // 除本次明确重建的 view 外，旧 binding 中其它 view 仍必须保持字节身份。
  for (const [name, view] of Object.entries(plan.views || {})) {
    if (replacing.has(name)) continue;
    const abs = path.resolve(workDir, view.path);
    if (!fs.existsSync(abs) || crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex') !== view.sha256) {
      throw consumerAuthorityError('produced-view update 发现其它 bound view 漂移: ' + name);
    }
  }
  const next = JSON.parse(JSON.stringify(binding));
  next.viewRevision = (Number(plan.viewRevision) || 1) + 1;
  next.views = Object.assign({}, next.views || {});
  for (const [name, relPath] of Object.entries(updates || {})) {
    const abs = path.resolve(workDir, relPath);
    const root = path.resolve(workDir);
    if (!abs.startsWith(root + path.sep) || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      throw consumerAuthorityError('不能绑定不存在或越界的 produced view: ' + name);
    }
    next.views[name] = {
      path: path.relative(workDir, abs).split('\\').join('/'),
      sha256: crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex'),
      semanticObjectId: plan.semanticObjectId,
      projectionObjectId: plan.projectionObjectId
    };
  }
  return issueTransientConsumerBinding(next);
}
function readIfExists(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
}

// 源锚层 v1（N-1）：读取名册锚 workDir/source-anchor.json；不存在/解析失败 → null（表级锚降级）
function readAnchor(workDir) {
  const p = path.join(workDir, 'source-anchor.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (e) { return null; }
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sourceAnchorExemptionError(message) {
  const e = new Error('[source-anchor exemption] ' + message);
  e.code = 'ERR_SOURCE_ANCHOR_EXEMPTION';
  return e;
}

const LEGACY_SEMANTIC_ADJUDICATION_DIMENSIONS = Object.freeze([
  'S7赢家↔SC完成方',
  '终判↔S8方向',
  '终判↔PhaseIII',
  '终判↔S11类型',
  '比分↔六向度'
]);

function adjudicationConflictExclusions(semanticAuthorityBoundary, extra) {
  const out = new Set(Array.isArray(extra) ? extra : []);
  if (semanticAuthorityBoundary === 'semantic-first-v10') {
    for (const dimension of LEGACY_SEMANTIC_ADJUDICATION_DIMENSIONS) out.add(dimension);
  }
  return Array.from(out);
}

function legacySemanticAdjudicationConflicts(rows) {
  const forbidden = new Set(LEGACY_SEMANTIC_ADJUDICATION_DIMENSIONS);
  return (Array.isArray(rows) ? rows : []).filter(row => row && forbidden.has(row.dimension));
}

function warningsForAdjudication(validationResult, opts) {
  opts = opts || {};
  const semanticRules = opts.semanticAuthorityBoundary === 'semantic-first-v10'
    ? validator.LEGACY_SEMANTIC_DERIVATION_RULES
    : null;
  const rows = (validationResult && (validationResult.warningRecords || validationResult.warnings)) || [];
  return rows
    .map(w => w && typeof w === 'object' ? w : { rule: '', severity: 'WARNING', message: String(w) })
    .filter(w => w && w.rule !== 'V-S8E-WX' && !(semanticRules && semanticRules.has(w.rule)))
    .map(w => w.message);
}

// B1（260828）：人工豁免是独立场次 checkpoint，不混入 source-anchor.json / source-anchor.confirmed。
// 只做生命周期与审计字段验证；具体哪类 A3 可放行由 validator failureKind 白名单决定。
function createFreshControlBindingGuard(workDir) {
  // Run-local capability: hashes originate in the current extractor/verified
  // loader, never in imported metadata or a caller-declared "fresh" boolean.
  const names = { sourceAnchor: 'source-anchor.json', sourceAnchorExemptions: 'source-anchor-exemptions.json' };
  const expected = new Map();
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const fail = name => {
    const error = new Error('[executor] fresh control bytes changed before publication: ' + name);
    error.code = 'ERR_FRESH_CONTROL_IDENTITY';
    throw error;
  };
  function record(name, bytes) {
    if (!Object.prototype.hasOwnProperty.call(names, name)) fail(name);
    expected.set(name, bytes === null ? null : hash(bytes));
  }
  function assertCurrent() {
    for (const [name, value] of expected) {
      const file = path.join(workDir, names[name]);
      const current = fs.existsSync(file) ? hash(fs.readFileSync(file)) : null;
      if (current !== value) fail(name);
    }
  }
  function bind(binding, updates) {
    assertCurrent();
    for (const name of Object.keys(updates)) if (!expected.has(name) || expected.get(name) === null) fail(name);
    const next = consumerBindingFromProducedViews(workDir, binding, updates);
    // Compare the actual bytes captured by the publisher too: a second writer
    // cannot win the check/read interval and get different bytes signed.
    for (const name of Object.keys(updates)) {
      if (!next || !next.views || !next.views[name] || next.views[name].sha256 !== expected.get(name)) fail(name);
    }
    return next;
  }
  return { record, assertCurrent, bind };
}
function loadSourceAnchorExemptions(workDir, anchor, opts) {
  opts = opts || {};
  const file = path.join(workDir, 'source-anchor-exemptions.json');
  if (!fs.existsSync(file)) {
    if (typeof opts.onVerifiedBytes === 'function') opts.onVerifiedBytes(null);
    return [];
  }
  if (opts.force) throw sourceAnchorExemptionError('检测到 --force 与人工豁免 checkpoint 同时存在；请先删除/撤销旧 checkpoint，再重生成 P2');
  const debateFile = path.join(workDir, '.tmp-debate.txt');
  const p2File = path.join(workDir, 'P2.md');
  if (!fs.existsSync(debateFile)) throw sourceAnchorExemptionError('.tmp-debate.txt 缺失，无法验证人工豁免真源');
  if (!anchor || !anchor.extracted || !anchor.rosterHash) throw sourceAnchorExemptionError('当前 source-anchor 无有效 rosterHash，人工豁免不得生效');
  if (!fs.existsSync(p2File)) throw sourceAnchorExemptionError('P2.md 缺失；人工豁免只允许针对已经存在的失败 P2 创建');
  let doc;
  const verifiedBytes = fs.readFileSync(file);
  try { doc = JSON.parse(verifiedBytes.toString('utf-8')); }
  catch (e) { throw sourceAnchorExemptionError('checkpoint JSON 解析失败: ' + e.message); }
  if (!doc || doc.version !== 1) throw sourceAnchorExemptionError('version 必须为 1');
  const transcriptSha = sha256File(debateFile);
  const p2Sha = sha256File(p2File);
  if (doc.transcript_sha256 !== transcriptSha) throw sourceAnchorExemptionError('transcript_sha256 与当前 .tmp-debate.txt 不一致');
  if (doc.roster_hash !== anchor.rosterHash) throw sourceAnchorExemptionError('roster_hash 与当前 source-anchor.json 不一致');
  if (!Array.isArray(doc.entries) || doc.entries.length === 0) throw sourceAnchorExemptionError('entries 必须为非空数组');
  const lineCount = fs.readFileSync(debateFile, 'utf-8').replace(/\r\n/g, '\n').split('\n').length;
  const seenRows = new Set();
  for (let i = 0; i < doc.entries.length; i++) {
    const e = doc.entries[i];
    const at = e && e.at;
    if (!e || e.scope !== 'A3_ROSTER_MATCH') throw sourceAnchorExemptionError('entries[' + i + '].scope 仅允许 A3_ROSTER_MATCH');
    if (e.artifact !== 'P2.md') throw sourceAnchorExemptionError('entries[' + i + '].artifact 仅允许 P2.md');
    if (e.artifact_sha256 !== p2Sha) throw sourceAnchorExemptionError('entries[' + i + '].artifact_sha256 与当前 P2.md 不一致');
    if (!Number.isInteger(e.table_row) || e.table_row < 1) throw sourceAnchorExemptionError('entries[' + i + '].table_row 必须为正整数');
    if (!/^M-(?:ZH|FA)-\d+$/.test(String(e.node_id || ''))) throw sourceAnchorExemptionError('entries[' + i + '].node_id 非法');
    if (typeof e.turn_raw !== 'string' || !e.turn_raw.trim()) throw sourceAnchorExemptionError('entries[' + i + '].turn_raw 不能为空');
    if (e.operator_side !== '正方' && e.operator_side !== '反方') throw sourceAnchorExemptionError('entries[' + i + '].operator_side 非法');
    if (typeof e.by !== 'string' || !e.by.trim()) throw sourceAnchorExemptionError('entries[' + i + '].by 不能为空');
    if (typeof e.reason !== 'string' || !e.reason.trim()) throw sourceAnchorExemptionError('entries[' + i + '].reason 不能为空');
    if (typeof at !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(at) || Number.isNaN(Date.parse(at))) throw sourceAnchorExemptionError('entries[' + i + '].at 必须为有效 ISO-8601 时间');
    if (!Array.isArray(e.evidence_lines) || e.evidence_lines.length === 0 ||
        e.evidence_lines.some(n => !Number.isInteger(n) || n < 1 || n > lineCount))
      throw sourceAnchorExemptionError('entries[' + i + '].evidence_lines 必须为当前辩词范围内的正整数行号');
    if (seenRows.has(e.table_row)) throw sourceAnchorExemptionError('同一 S8.2 table_row 只能有 1 条人工豁免 entry: table_row=' + e.table_row);
    seenRows.add(e.table_row);
  }
  if (typeof opts.onVerifiedBytes === 'function') opts.onVerifiedBytes(verifiedBytes);
  return doc.entries;
}

function assertSourceAnchorExemptionArtifactBinding(round, text, exemptions) {
  if (!round || round.name !== 'R2' || !Array.isArray(exemptions) || exemptions.length === 0) return;
  const currentSha = crypto.createHash('sha256').update(Buffer.from(String(text || ''), 'utf-8')).digest('hex');
  if (exemptions.some(e => !e || e.artifact_sha256 !== currentSha))
    throw sourceAnchorExemptionError('当前 R2/P2 内容 SHA 已变化，旧人工豁免 checkpoint 失效；请重新人工核对后再创建新 checkpoint');
}

// Q3 登记项（260809 R8）：锚加载状态标签——门禁通过/断点跳过日志必须记录"以何配置通过"
function anchorStateLabel(workDir) { return readAnchor(workDir) ? '锚已加载' : '锚未加载'; }

const RETRY_EVENT_LEDGER = '.tmp-retry-events.jsonl';
function appendRetryEvent(workDir, event) {
  if (!workDir || !event || typeof event !== 'object') return;
  const row = Object.assign({
    schema: 'judge-retry-event-v1',
    at: new Date().toISOString()
  }, event);
  try {
    fs.appendFileSync(path.join(workDir, RETRY_EVENT_LEDGER), JSON.stringify(row) + '\n', 'utf8');
  } catch (_) {
    // Debug evidence must never mutate execution semantics.
  }
}

function roundRepairPlan(round, gate) {
  const issues = gate && Array.isArray(gate.typedIssues) ? gate.typedIssues : [];
  if (!issues.length) return { mode: 'round_regenerate', scopes: [], issues: [] };
  if (issues.some(issue => issue && issue.retryable === false)) {
    return { mode: 'fail_closed', scopes: [], issues };
  }
  const local = issues.filter(issue => issue && issue.repairMode === 'bounded_repair' && issue.repairScope);
  if (round && (round.name === 'R5A' || round.name === 'R5B') && local.length === issues.length) {
    const chapters = [...new Set(local.map(issue => String(issue.repairScope).match(/C(?:1[0-2]|[1-9])/)?.[0]).filter(Boolean))];
    if (chapters.length) return { mode: 'r5_bounded', scopes: local.map(x => x.repairScope), chapters, issues };
  }
  return { mode: 'round_regenerate', scopes: local.map(x => x.repairScope).filter(Boolean), issues };
}

function r5ChapterRanges(markdown) {
  const source = String(markdown || '');
  const matches = [...source.matchAll(/^##\s*(C(?:1[0-2]|[1-9]))\b[^\n]*\n?/gm)];
  const out = new Map();
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : source.length;
    out.set(matches[i][1], { start, end, text: source.slice(start, end) });
  }
  return out;
}

function buildR5BoundedRepairPrompt(basePrompt, priorArtifact, plan) {
  const ranges = r5ChapterRanges(priorArtifact);
  const chapters = plan.chapters.map(id => {
    const row = ranges.get(id);
    return { chapter: id, markdown: row ? row.text : '' };
  });
  return String(basePrompt || '') +
    '\n\n---\n## R5 BOUNDED REPRESENTATION REPAIR\n' +
    '上一版完整候选已经冻结。只修下面列出的章节；未列出的章节由 host 保留原字节，不会采用你的任何改写。\n' +
    '只输出严格 JSON：{"chapters":[{"chapter":"C2","markdown":"## C2 ..."}]}。chapters 必须恰好覆盖 requestedChapters，一章一次。\n' +
    '每个 markdown 必须是该章完整 Markdown，从 ## Cn 标题开始，到下一章之前结束。不要输出其它章节、解释或代码围栏。\n' +
    'requestedChapters=' + JSON.stringify(plan.chapters) + '\n' +
    'typedIssues=' + JSON.stringify(plan.issues, null, 2) + '\n' +
    'currentChapters=' + JSON.stringify(chapters, null, 2);
}

function parseR5BoundedRepair(raw, expectedChapters) {
  let text = String(raw || '').trim().replace(/^\x60\x60\x60(?:json)?\s*/i, '').replace(/\x60\x60\x60\s*$/, '');
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  const doc = JSON.parse(text);
  const rows = doc && Array.isArray(doc.chapters) ? doc.chapters : [];
  const ids = rows.map(row => String(row && row.chapter || ''));
  if (ids.length !== expectedChapters.length || new Set(ids).size !== expectedChapters.length ||
      expectedChapters.some(id => !ids.includes(id))) {
    throw new Error('R5 bounded repair chapters must exactly match: ' + expectedChapters.join(','));
  }
  for (const row of rows) {
    if (typeof row.markdown !== 'string' || !row.markdown.trim().startsWith('## ' + row.chapter)) {
      throw new Error('R5 bounded repair invalid chapter markdown: ' + row.chapter);
    }
  }
  return new Map(rows.map(row => [String(row.chapter), String(row.markdown).trimEnd() + '\n\n']));
}

function mergeR5BoundedRepair(priorArtifact, repaired, expectedChapters) {
  const source = String(priorArtifact || '');
  const ranges = r5ChapterRanges(source);
  for (const id of expectedChapters) {
    if (!ranges.has(id)) throw new Error('R5 bounded repair cannot locate frozen chapter: ' + id);
  }
  let out = source;
  const ordered = expectedChapters.map(id => ({ id, ...ranges.get(id) })).sort((a, b) => b.start - a.start);
  for (const row of ordered) out = out.slice(0, row.start) + repaired.get(row.id) + out.slice(row.end);
  const after = r5ChapterRanges(out);
  for (const [id, before] of ranges.entries()) {
    if (expectedChapters.includes(id)) continue;
    const next = after.get(id);
    if (!next || next.text !== before.text) throw new Error('R5 bounded repair modified frozen chapter: ' + id);
  }
  return out;
}

// 源锚层 v1 名册确认机制——交互 y/n/e、文件确认标记（source-anchor.confirmed 含名册哈希）、--skip 开关；
// 类型 A/B 严重异常置顶展示；哈希不一致 → 旧标记失效（防"改名册但标记还在"）
async function confirmRoster(workDir, anchor, opts, onLog) {
  if (!anchor || !anchor.extracted) return true;                 // extracted:false → 无可确认名册，自动跳过
  if (opts.skipRosterConfirm) {
    onLog('[executor] --skip-roster-confirm：跳过名册人工确认（自动化/mock/CI）');
    return true;
  }
  const markFile = path.join(workDir, 'source-anchor.confirmed');
  if (fs.existsSync(markFile)) {
    try {
      const mark = JSON.parse(fs.readFileSync(markFile, 'utf-8'));
      if (mark.rosterHash === anchor.rosterHash) { onLog('[executor] 名册确认标记有效（哈希一致）——跳过暂停'); return true; }
      onLog('[executor] 名册已变更（哈希不一致）——旧确认标记失效，重新等待确认');
    } catch (e) { onLog('[executor] 确认标记解析失败，重新等待确认'); }
  }
  onLog('[source-anchor] 名册抽取完成 ⏸ 等待人工确认（--skip-roster-confirm 可跳过）');
  if (anchor.typeA) onLog('⚠ 严重（类型 A）：具体辩位不齐全 且 具体身份登记不齐全——继续将降级运行且最终报告带免责声明');
  if (anchor.typeB) onLog('⚠ 严重（类型 B）：结构性缺失（缺方/不对称/缺队伍行）——请检查输入；确认继续则同一免责声明');
  onLog('辩题: ' + (anchor.title || '（未识别）') + ' ｜ 完整性: ' + anchor.integrity);
  for (const side of ['正方', '反方']) {
    onLog(side + ' ｜ ' + (side === '正方' ? anchor.proTeam : anchor.conTeam));
    for (const r of anchor.roster.filter(x => x.side === side)) onLog('  ' + r.role + '  ' + (r.name || '（角色标签）'));
  }
  onLog('候选名单 candidates（发言行出现未入册）：' + (anchor.candidates.length ? anchor.candidates.map(c => c.name).join(', ') : '无'));
  onLog('候补/未上场 bench（介绍段有名字无槽位）：' + (anchor.bench.length ? anchor.bench.map(b => b.name).join(', ') : '无'));
  onLog('非辩手发言者（评委/嘉宾/教练）：' + (anchor.other_speakers.length ? anchor.other_speakers.map(o => o.name + '（' + o.category + '）').join(', ') : '无'));
  if (anchor.warnings.length) onLog('警告：' + anchor.warnings.join('；'));
  // 交互模式（TTY）：y 确认继续 / n 终止 / e 编辑后重抽；非 TTY（管道/自动化）→ 等待文件确认标记
  if (process.stdin.isTTY) {
    return await new Promise(resolve => {
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question('y = 确认继续 ｜ n = 终止（修正辩词后重开） ｜ e = 编辑（改名册后重抽）\n> ', ans => {
        rl.close();
        if (ans === 'y') {
          fs.writeFileSync(markFile, JSON.stringify({ by: 'CLI 交互', at: new Date().toISOString(), rosterHash: anchor.rosterHash }, null, 2));
          onLog('[executor] 名册已确认（交互 y）——确认标记落盘，断点续跑将跳过');
          resolve(true);
        } else if (ans === 'n') {
          onLog('[executor] 已终止——修正辩词后重开');
          resolve(false);
        } else if (ans === 'e') {
          onLog('[executor] 已选择编辑——请修改 source-anchor.json 后重新运行');
          resolve(false);
        } else { onLog('[executor] 无效输入，已按终止处理'); resolve(false); }
      });
    });
  }
  throw new Error('[source-anchor] 名册等待人工确认：请核对确认单后创建 ' + markFile + '（含确认人/时间/名册哈希），或使用 --skip-roster-confirm');
}

// A8-ERR-1：读取前端面板导出的 .api-config.json（Node 侧；无文件返回 null）
function loadFileConfig(file) {
  if (!file || !fs.existsSync(file)) return null;
  const j = JSON.parse(fs.readFileSync(file, 'utf-8'));
  return {
    provider: j.provider || undefined,
    baseUrl: j.baseUrl || undefined,
    apiKey: j.apiKey || undefined,
    model: j.model || undefined,
    maxTokens: j.maxTokens || undefined,
    // R7 阶段 2：.api-config.json 可选 plain 字段（生成白话版开关；CLI --plain 优先）
    plain: j.plain !== undefined ? !!j.plain : undefined
  };
}

function validateR3FinalOwnedPreview(workDir, r3Text, pcOverride, validationExtra) {
  const PC = pcOverride || require('../pipeline-controller.js');
  const binding = validationExtra && validationExtra.consumerBinding || null;
  const p1 = validationConsumerViewText(workDir, binding, 'P1', ['P1.md'], true);
  const p2 = validationConsumerViewText(workDir, binding, 'P2', ['P2.md'], true);
  const p25 = validationConsumerViewText(workDir, binding, 'P2.5', ['P2.5.md'], false);
  if (!p1 || !p2) {
    const blocking = [{ rule: 'V10-R3-PREVIEW', severity: 'BLOCKING', message: 'R3 final-preview 缺少 P1/P2，无法验证本轮 S14 source reference' }];
    return { passed: false, errors: blocking.map(x => x.message), blocking };
  }
  let merged = p1 + '\n---\n' + p2;
  if (p25) merged += '\n---\n' + p25;
  merged += '\n---\n' + String(r3Text || '');
  merged = PC.autoFixSMarkers(merged);
  merged = PC.autoFixTables(merged);
  const result = PC.validate(merged, 'R3', {
    final: true,
    p1Data: PC.extractDataMarkers(p1),
    p2Data: PC.extractDataMarkers(p2),
    p25Data: p25 ? PC.extractDataMarkers(p25) : {},
    newContract: PC.detectNewContractFromText(p1),
    semanticAuthorityBoundary: validationExtra && validationExtra.semanticAuthorityBoundary || null
  });
  const rows = (result && (result.blocking || result.errors)) || [];
  // Only preflight errors that are owned by the current R3 artifact. Other final errors may belong
  // to upstream rounds and must not be misreported as R3-repairable model mistakes.
  const blocking = rows.filter(row => row && typeof row === 'object' && row.rule === 'V-S14E');
  return { passed: blocking.length === 0, errors: blocking.map(x => x.message || String(x)), blocking, finalResult: result };
}

function checkR3AdjudicativeAuthority(workDir, text, extra) {
  extra = extra || {};
  if (extra.semanticAuthorityBoundary !== 'semantic-first-v10') {
    return checkFiniteNetWinnerAlignment(text, extra.globalReviewDecision, {
      reopenRequested: !!extra.semanticReopenRequest
    });
  }
  if (extra.semanticReopenRequest) return { passed: true, blocking: [], upstreamReopenRequest: null };
  try {
    const bindings = buildFinalAdjudicationBindings(workDir, extra.consumerBinding || null, extra.scAuthorityCurrentView || null);
    return checkFinalAdjudicationAlignment(text, extra.globalReviewDecision, bindings);
  } catch (e) {
    return {
      passed: false,
      upstreamReopenRequest: null,
      blocking: [{
        rule: 'V10-FINAL-BINDING',
        severity: 'BLOCKING',
        authorityClass: 'consumer_contract',
        message: e.message
      }]
    };
  }
}

// A8-ERR-1：单轮产物真实校验（R1/R2/R2.5/R3 → PC.validate；R4 → JSON+checkStructure；R5 半区 → validateHalf）
// 供正常路径与断点续跑共用——断点只能跳过“真正通过全部校验”的产物
function validateRound(workDir, round, text, onLog, extra) {
  const PC = require('../pipeline-controller.js');
  // 源锚层 v1（N-1）：锚的唯一切入点——每轮门禁共用；缺失 → null → 表级锚降级（显式登记防静默失效）
  const anchor = readAnchor(workDir);
  let v = null;
  if (round.name === 'R5A' || round.name === 'R5B') {
    // semantic-authority fail-closed：R5 正向合同与 full-data 都是正式门禁权威，不得因读取失败退化成弱校验。
    let registry, data;
    try { registry = PC.parseInsertRegistry(resolveSkillPath()); }
    catch (e) { return { passed: false, errors: ['INSERT注册表加载失败: ' + e.message], warnings: [], warningRecords: [] }; }
    const fullData = validationConsumerViewText(workDir, extra && extra.consumerBinding, 'adjudicatedData', ['full-data.md'], true);
    if (!fullData) return { passed: false, errors: ['R5 门禁数据源缺失: adjudicatedData/full-data.md'], warnings: [], warningRecords: [] };
    try { data = PC.extractDataMarkers(fullData); }
    catch (e) { return { passed: false, errors: ['R5 门禁数据源解析失败: ' + e.message], warnings: [], warningRecords: [] }; }
    v = PC.validateHalf(text, round.half, { registry, data });
  }
  else if (round.name === 'R4.5') {
    // 3B：R4.5 校验 = adjudication schema/白名单 + 同源性（ADJ-14）+ 机械复核（合并裁决后 validate/checkStructure/diffConflicts）
    let adj = null;
    try { adj = JSON.parse(text); } catch (e) {
      // 容错：模型可能用 ```json 围栏包裹（与 R4 structure 同一容错路径）
      try { adj = PC.parseStructureJson(text); } catch (e2) {
        v = { passed: false, errors: ['adjudication.json 解析失败: ' + e.message] };
        return { ...v, warnings: [] };   // 260809 R2.3：warnings 透传（六处返回点统一）
      }
    }
    // semantic-authority fail-closed：正式 real R4.5 的机械冲突登记表必须存在且可解析；缺失/损坏不得解释成“无冲突”。
    const regPath = path.join(workDir, '.tmp-conflicts.json');
    if (!fs.existsSync(regPath)) {
      return { passed: false, errors: ['R4.5 机械冲突登记表缺失: .tmp-conflicts.json'], warnings: [], warningRecords: [] };
    }
    let registryConflicts;
    try { registryConflicts = JSON.parse(fs.readFileSync(regPath, 'utf8')); }
    catch (e) { return { passed: false, errors: ['R4.5 机械冲突登记表解析失败: ' + e.message], warnings: [], warningRecords: [] }; }
    if (!Array.isArray(registryConflicts)) {
      return { passed: false, errors: ['R4.5 机械冲突登记表结构非法: 必须为数组'], warnings: [], warningRecords: [] };
    }
    let authorityPlan = null;
    if (extra && extra.consumerBinding) {
      authorityPlan = PC.planAdjudicationAuthority({
        binding: extra.consumerBinding,
        mutationKind: 'projection_repair',
        requiredViews: ['transition', 'structure']
      });
      if (!authorityPlan.allowed) {
        return { passed: false, errors: ['R4.5 consumer binding 失败: ' + authorityPlan.blockingReason], warnings: [], warningRecords: [] };
      }
    }
    const va = PC.validateAdjudication(adj, { registryConflicts, authorityPlan });
    if (!va.passed) {
      v = { passed: false, errors: va.errors.map(e => e.rule + ': ' + e.message) };
      return { ...v, warnings: [] };   // 260809 R2.3
    }
    const checkpointRecheckSnapshot = extra && extra.freshAdjudicationOutput
      ? null
      : snapshotTextFiles(workDir, [
          '.tmp-adjudicated-data.md', '.tmp-adjudicated-structure.json',
          '.tmp-conflicts.json', 'adjudication.json', '.tmp-adjudication.json'
        ]);
    let recheck;
    try {
      recheck = adjudicationRecheck(workDir, adj, registryConflicts, {
        consumerBinding: extra && extra.consumerBinding,
        authorityPlan,
        semanticAuthorityBoundary: extra && extra.semanticAuthorityBoundary || null,
        stampInputBinding: !!(extra && extra.freshAdjudicationOutput)
      });
    } finally {
      // Existing-checkpoint validation is a proof operation, not a publication step. Restore every
      // byte touched by the legacy recheck implementation so resume cannot mutate its own bound inputs.
      if (checkpointRecheckSnapshot) restoreTextFiles(workDir, checkpointRecheckSnapshot);
    }
    if (!recheck.passed) {
      v = { passed: false, errors: recheck.errors };
      return { ...v, warnings: [] };   // 260809 R2.3
    }
    v = { passed: true, errors: [], consumerBinding: recheck.consumerBinding || null };
  }
  else if (round.name === 'R4') {
    // P1：直接走 checkStructure——其内部 parseStructureJson 已容错剥离 [S_START]/```json 围栏；
    // 真非法内容仍 S0 BLOCKING，门禁不弱化。
    const tfPath = validationConsumerViewPath(workDir, extra && extra.consumerBinding, 'transition', ['transition-final.md'], true);
    const cs = PC.checkStructure(path.join(workDir, round.outFile), {
      tfPath,
      semanticAuthorityBoundary: extra && extra.semanticAuthorityBoundary || null
    });
    v = { passed: cs.passed, errors: cs.errors.map(e => ({ message: e.message || e })) };
  } else if (['R1', 'R2', 'R2.5', 'R3'].includes(round.name)) {
    const validationOptions = {
      anchor,
      newContract: !!(extra && extra.newContract),
      sourceAnchorExemptions: (extra && extra.sourceAnchorExemptions) || [],
      semanticAuthorityBoundary: extra && extra.semanticAuthorityBoundary || null
    };
    // C9a/C9b 的 R2 前置门禁需要 P1 的 S7 致命计数；P1 缺失时不伪造数据，
    // 由后续既有最终门禁报告，避免旧场次/断点场景静默改变语义。
    if (round.name === 'R2' || round.name === 'R2.5') {
      const p1 = validationConsumerViewText(workDir, extra && extra.consumerBinding, 'P1', ['P1.md'], false);
      if (p1) validationOptions.p1Data = PC.extractDataMarkers(p1);
    }
    v = PC.validate(text, round.name, validationOptions);
    if (round.name === 'R2' && validationOptions.semanticAuthorityBoundary === 'semantic-first-v10') {
      const projection = SCA.checkR2Projection(text, extra && extra.scAuthorityCurrentView || null);
      if (!projection.ok) {
        const projectionIssues = projection.issues || [];
        v = {
          ...v,
          passed: false,
          blocking: [...(v.blocking || []), ...projectionIssues],
          errors: [...(v.errors || []), ...projectionIssues],
          issues: [...(v.issues || []), ...validator.toTypedIssues(projectionIssues)]
        };
      }
    }
    if (round.name === 'R3' && v.passed) {
      const finalAlignment = checkR3AdjudicativeAuthority(workDir, text, extra);
      if (finalAlignment.upstreamReopenRequest) v.finalUpstreamReopenRequest = finalAlignment.upstreamReopenRequest;
      if (!finalAlignment.passed) {
        v = {
          ...v,
          passed: false,
          blocking: [...(v.blocking || []), ...finalAlignment.blocking],
          errors: [...(v.errors || []), ...finalAlignment.blocking]
        };
      }
    }
    if (round.name === 'R3' && v.passed) {
      const preview = validateR3FinalOwnedPreview(workDir, text, PC, {
        semanticAuthorityBoundary: validationOptions.semanticAuthorityBoundary,
        consumerBinding: extra && extra.consumerBinding || null
      });
      if (!preview.passed) {
        v = {
          ...v,
          passed: false,
          blocking: [...(v.blocking || []), ...preview.blocking],
          errors: [...(v.errors || []), ...preview.blocking]
        };
      }
    }
    // 降级显式登记（N-1：防静默失效——锚不执行≠报错，必须有日志标记）
    if (!anchor && onLog) onLog('[executor] source-anchor.json 未加载——锚 1/锚 2/锚 3 降级跳过');
    // 实测修复：transition-final 的 D1/D2（判决行/比分 vs S15）必须在 R3 门禁内反馈重试，
    // 否则 buildTransitionFinal 抛错会终止整条管道（P3 通过但比分 7:3 vs S15 3:7 的案例）
    if (round.name === 'R3' && v.passed) {
      const vc = PC.checkVerdictConsistency(text, PC.extractDataMarkers(text));
      if (vc.errors.length > 0) v = { passed: false, blocking: vc.errors };
    }
    // 260819 FG：契约↔产物形态必须在生产轮次反馈，避免最终 WARNING 过晚才暴露。
    // R1/R2/R3 只检查本轮负责的表；最终合并校验仍由 validator.validate(final) 检查全套表。
    if (['R1', 'R2', 'R3'].includes(round.name)) {
      const shapeErrors = [];
      validator.checkOutputShape(text, shapeErrors, round.name);
      // 兼容旧场次/旧 fixture：缺表仍由最终 WARNING 报告；已输出表但列数违约才前置阻断。
      const malformedTables = shapeErrors.filter(e => /表头列数=/.test(String(e.message || '')));
      if (malformedTables.length > 0) {
        const blockingShape = malformedTables.map(e => ({
          ...e,
          severity: 'BLOCKING',
          message: e.message + '——生产轮次门禁要求重跑 ' + round.name
        }));
        v = {
          ...v,
          passed: false,
          blocking: [...(v.blocking || []), ...blockingShape]
        };
      }
    }
  }
  if (!v) return { passed: true, errors: [], warnings: [], warningRecords: [], typedIssues: [] };   // 260809 R2.3
  const warningRecords = (v.warnings || []).map(w => w && typeof w === 'object' ? w : { rule: '', severity: 'WARNING', message: String(w) });
  const warningMessages = warningRecords.map(w => w.message);
  if (v.passed) {
    return {
      passed: true,
      errors: [],
      warnings: warningMessages,
      warningRecords,
      typedIssues: v.issues || validator.toTypedIssues(warningRecords),
      consumerBinding: v.consumerBinding || null,
      finalUpstreamReopenRequest: v.finalUpstreamReopenRequest || null
    };
  }
  const arr = v.blocking || v.errors || [];
  const msgs = arr.length ? arr.map(e => (e && typeof e === 'object' ? (e.message || e.reason || JSON.stringify(e)) : String(e))) : (v.reason ? [v.reason] : ['校验失败（无详细错误）']);
  return {
    passed: v.passed,
    errors: msgs,
    warnings: warningMessages,
    warningRecords,
    typedIssues: v.issues || validator.toTypedIssues(arr.concat(warningRecords))
  };   // 260809 R2.3
}

// 冒烟用良好响应器：按 prompt 中的输出范围约束返回门禁可通过的产物（R5 半区含模块文本+表行数）
function goodMockResponder(messages) {
  const prompt = String((messages[messages.length - 1] || {}).content || '');
  const PC = require('../pipeline-controller.js');
  const registry = PC.parseInsertRegistry(resolveSkillPath());
  // SemanticFirst-E2E TEST mock responses: exercise the real analyze/review/project/fidelity orchestration
  // while keeping CI/network-free. Review evidence is always an exact substring of the provided source block.
  const sourceMatch = prompt.match(/【原文】\n([\s\S]*?)(?:\n\n【Context】|\n\n【任务】)/) ||
    prompt.match(/【完整原文(?:｜必须 whole-debate 扫描)?】\n([\s\S]*?)(?:\n\n【当前 reviewed global semantic|\n\n【reviewed global semantic|\n\n【任务】)/);
  const mockSource = sourceMatch ? sourceMatch[1] : '';
  const firstSourceLine = mockSource.split(/\r?\n/).map(x => x.trim()).find(x => x.length >= 2) || mockSource.slice(0, 24);
  const sourceQuote = firstSourceLine ? firstSourceLine.slice(0, Math.min(48, firstSourceLine.length)) : '';
  // V10 SC mock closure mirrors the active discover → independent review → freeze → authority →
  // review → projection → fidelity topology. It intentionally makes no formed Phase III claim and
  // encodes no topic-specific semantic oracle; the purpose is transport/runtime closure only.
  const mockScInventory = pass => ({
    schema: 'judge-sc-candidate-inventory-v1',
    pass,
    sides: { affirmative: [], negative: [] },
    notes: 'mock whole-debate inventory makes no formed-candidate claim'
  });
  const mockScAuthority = () => ({
    schema: 'judge-sc-semantic-authority-v1',
    sides: {
      affirmative: { phase_iii: 'not_formed', candidates: [] },
      negative: { phase_iii: 'not_formed', candidates: [] }
    },
    relation: { type: 'none', dominant_side: 'none', reason: 'mock fixture makes no SC formation claim', evidence: [] },
    notes: 'mock SC authority only; no overall verdict'
  });
  if (prompt.includes('【whole-debate semantic discovery｜未冻结草案】')) {
    return JSON.stringify(mockScInventory('discovery'));
  }
  if (prompt.includes('【未冻结 discovery inventory｜只是一份待审提案】')) {
    return JSON.stringify(mockScInventory('reviewed'));
  }
  if (prompt.includes('【independent review 后已生效的 semantic authority｜语义字段不可改】')) {
    return JSON.stringify(mockScAuthority());
  }
  if (prompt.includes('【冻结 reviewed candidate inventory｜candidate id/数量不可改】') ||
      prompt.includes('独立建立双方 SC semantic authority')) {
    return JSON.stringify(mockScAuthority());
  }
  if ((prompt.includes('【被审 SC authority 候选】') || prompt.includes('【被审 SC semantic authority 候选】')) && prompt.includes('【具体复核问题】')) {
    return JSON.stringify({
      decision: 'maintain',
      inventory_gap: false,
      evidence: sourceQuote ? [{ quote: sourceQuote, reason: 'exact source anchor for SC mock review' }] : [],
      reason: 'mock SC source-grounded review maintains the frozen empty inventory authority',
      authority: null
    });
  }
  if (prompt.includes('【已 review 生效的 SC authority】') || prompt.includes('【已 review 生效并完成标准表示的 SC authority】')) {
    return JSON.stringify({
      decision: 'approve',
      inventory_gap: false,
      reason: 'mock SC fidelity approves source-grounded authority without deciding the match',
      issues: [],
      evidence: sourceQuote ? [{ quote: sourceQuote, reason: 'source identity cross-check' }] : []
    });
  }
  if (prompt.includes('你是独立语义发现器')) {
    return 'Mock TEST semantic candidate：双方主张、攻防、让步与比较关系均需以完整原文为准。';
  }
  if (prompt.includes('maintain|revise|reject|unresolved') && prompt.includes('独立 source-grounded semantic reviewer')) {
    return JSON.stringify({
      decision: 'maintain',
      evidence: sourceQuote ? [{ quote: sourceQuote, reason: 'exact source anchor for production-candidate mock review' }] : [],
      reason: 'mock source-grounded review approved',
      net: {
        candidate_state: 'absent',
        candidate_quote: '',
        candidate_direction: 'none',
        review_direction: 'unresolved',
        basis: 'mock candidate makes no finite winner claim; no forced direction is introduced'
      },
      replacement: {
        mode: 'none', standalone: false, depends_on_prior_semantic: false, authority_quote: '', net_quote: ''
      },
      semantic: ''
    });
  }
  if (prompt.includes('你是语义 authority 的下游 projection builder')) {
    return 'Mock TEST verified projection：仅投影已审语义，不形成第二 truth source。';
  }
  if (prompt.includes('projection fidelity reviewer') && prompt.includes('approve|reject')) {
    return JSON.stringify({
      decision: 'approve',
      reason: 'mock projection preserves reviewed semantic',
      issues: [],
      evidence: sourceQuote ? [{ quote: sourceQuote, reason: 'source identity cross-check' }] : []
    });
  }
  // Web 默认 R8 冒烟：只在 mock provider 经 requestCompletion 的 mockResponder seam 命中；
  // 生产 R8 仍由真实模型 + 机械门 + 独立复核执行，不共享这里的假数据。
  // PLAIN v4 mock contract: mock/CI 也必须经过独立 reviewer，只把 reviewer 响应确定性化；不得绕过 review orchestration。
  if (prompt.includes('checkedIds 必须恰好覆盖 targetIds')) {
    const m = prompt.match(/(?:^|\n)targetIds=(\[[^\n]*\])/);
    const checkedIds = m ? JSON.parse(m[1]) : [];
    return JSON.stringify({ approved: true, checkedIds, issues: [] });
  }
  if (prompt.includes('reader-guide-plain') && prompt.includes('semanticEquivalent') && prompt.includes('zeroBackgroundReadable')) {
    return JSON.stringify({
      approved: true,
      cardChecks: Array.from({ length: 12 }, (_, i) => ({
        sectionId: 'C' + (i + 1),
        semanticEquivalent: true,
        noJudgmentChange: true,
        factsConsistent: true,
        zeroBackgroundReadable: true,
        naturalReadable: true,
        noLocatorDependency: true
      }))
    });
  }
  if (prompt.includes('\n\nreader-guide:\n') && prompt.includes('\n\nguide-input:\n')) {
    const RG = require('../scripts/reader-guide.js');
    return JSON.stringify({
      approved: true,
      cardChecks: RG.SECTION_IDS.map(sectionId => ({ sectionId, noNewJudgment: true, factsConsistent: true, anchorsConsistent: true }))
    });
  }
  if (prompt.includes('\n\nguide-input:\n') && prompt.includes('读者导览助手')) {
    const RG = require('../scripts/reader-guide.js');
    const rawInput = prompt.slice(prompt.lastIndexOf('\n\nguide-input:\n') + '\n\nguide-input:\n'.length);
    const input = JSON.parse(rawInput);
    const snapshotMatch = prompt.match(/"modelSnapshot":(\{[^\n]*?\}),"cards"/);
    const modelSnapshot = snapshotMatch ? JSON.parse(snapshotMatch[1]) : {};
    const cards = (input.sections || []).map(section => {
      const speech = (section.sources || []).filter(source => /^SPEECH:/.test(String(source && source.id || '')));
      const chosen = (section.sectionId === 'C3' || section.sectionId === 'C7') ? speech : speech.slice(0, 1);
      const firstEvidence = section.sources && section.sources[0] ? [section.sources[0].id] : [];
      const evidence = Array.from(new Set(firstEvidence.concat(chosen.map(source => source.id))));
      return {
        sectionId: section.sectionId,
        what: '本章把已有材料按读者容易理解的方式说明。',
        why: '它帮助读者理解本章在整份报告中的作用。',
        conclusion: '本章结论以来源材料为准。',
        evidence,
        anchors: chosen.map(source => ({
          sourceId: source.id,
          speaker: source.anchor && source.anchor.speaker || '',
          stage: source.anchor && source.anchor.stage || '',
          quote: source.anchor && source.anchor.quote || ''
        }))
      };
    });
    return JSON.stringify({
      schemaVersion: RG.SCHEMA_VERSION,
      inputHash: RG.hashGuideInput(input),
      promptVersion: RG.PROMPT_VERSION,
      modelSnapshot,
      cards
    });
  }
  const mockTable = name => '<!--TABLE:名称=Mock表-' + name + ',列=列A|列B|列C-->\n' +
    '| 列A | 列B | 列C |\n|---|---|---|\n| 甲 | 乙 | 丙 |\n| 丁 | 戊 | 己 |\n| 庚 | 辛 | 壬 |\n<!--/TABLE-->';
  const modText = n => {
    const ch = 'C' + n;
    // R8 Web 默认链会把 mock R5 叙事交给正式机械 renderer，因此 C1 也必须满足正式 R5→R6 C1 合同，
    // 不能继续依赖旧 R6b 手写 HTML 掩盖 mock 叙事缺口。
    if (ch === 'C1') {
      return '## C1\n\n<!--XP:这场比赛最终谁赢，依据是什么？-->\n\n' +
        '<!--INSERT_C1_01_POEM-->\n' +
        '风起两端各有声\n潮来一线见分明\n攻防有据方成势\n裁断归于证理中\n\n' +
        '<!--INSERT_C1_02_REASON-->\n' +
        '**反方胜（4:6）**\n\n反方在关键证明链上完成更稳定的回应，因此取得本场优势。\n\n' +
        '<!--INSERT_C1_03_HEXAD-->\n' +
        '<!--TABLE:名称=六向度,列=向度|正方|反方-->\n' +
        '| 向度 | 正方 | 反方 |\n|---|---:|---:|\n' +
        '| 证伪 | 4 | 6 |\n| 证成 | 4 | 6 |\n| 理性 | 4 | 6 |\n| 感性 | 5 | 5 |\n| 场面感 | 5 | 5 |\n| 意义感 | 5 | 5 |\n' +
        '<!--/TABLE-->\n\n' +
        '<!--INSERT_C1_04_JUDGMENT-->\n' +
        '<!--TABLE:名称=判准ABCD,列=判准|说明-->\n' +
        '| 判准 | 说明 |\n|---|---|\n| A | 关键主张是否得到证明 |\n| B | 对方核心攻击是否被处理 |\n| C | 比较关系是否清楚 |\n| D | 结论是否能从前述理由推出 |\n' +
        '<!--/TABLE-->\n';
    }
    const inserts = registry.inserts.filter(r => r.ch === ch && r.consumer === 'R6b' &&
      (r.producer === 'R5' || (ch === 'C8' && r.producer === 'R2.5')));
    let out = '## ' + ch + '\n\n<!--XP:' + ch + ' 的设问？-->\n\n';
    for (const ins of inserts) {
      if (ins.condition) continue; // mock 默认 S4=否 → C4 条件项豁免
      out += '<!--INSERT_' + ins.name + '-->\n';
      if (ins.type === 'table' || ins.type === 'table+prose' || ins.name.includes('TABLE')) out += mockTable(ins.name) + '\n\n';
      else out += '内容'.repeat(40) + '\n\n';
    }
    if (ch === 'C7') {
      out += '<!--DATA: C7.微消化.正方.实例表行数=0 -->\n' +
        '<!--DATA: C7.微消化.反方.实例表行数=0 -->\n' +
        '<!--DATA: C7.微消化.总有效数=0 -->\n' +
        '<!--DATA: C7.SC总览.正方.有效微消化=0 -->\n' +
        '<!--DATA: C7.SC总览.反方.有效微消化=0 -->\n';
    }
    return out;
  };
  if (prompt.includes('C1 到 C7')) {
    return [1, 2, 3, 4, 5, 6, 7].map(modText).join('\n\n');
  }
  if (prompt.includes('C8 到 C12')) {
    return [8, 9, 10, 11, 12].map(modText).join('\n\n');
  }
  // C-R generic mock/CI R3：必须走与真实 semantic-bound R3 相同的 final contract。
  // 这里只固定 synthetic transport fixture 的展示结果，不作为任何真实辩论的语义/胜负 oracle。
  if (prompt.includes('## V10 C-R FINAL ADJUDICATIVE RECONCILIATION（R3 final authority）')) {
    const bindHead = '### Exact final bindings（逐字段原样回填）\n';
    const bindTail = '\n\n### Bounded rich SC direct consumer view';
    const bindStart = prompt.indexOf(bindHead);
    const bindEnd = bindStart >= 0 ? prompt.indexOf(bindTail, bindStart + bindHead.length) : -1;
    if (bindStart < 0 || bindEnd < 0) throw new Error('mock C-R R3 missing exact final bindings');
    const bindings = JSON.parse(prompt.slice(bindStart + bindHead.length, bindEnd).trim());
    const C = require('./contract.js');
    const rawUnit = {
      unit_id: 'U-MOCK-TRANSPORT',
      source_refs: ['MOCK:SYNTHETIC-SOURCE'],
      target_ref: 'MOCK:MOTION-CONSEQUENCE',
      causal_dependency: 'synthetic transport fixture dependency',
      local_clash: { status: 'maintain', owner_ref: 'MOCK:LOCAL-OWNER', reason: 'synthetic local truth retained for contract transport' },
      motion_consequence: { status: 'maintain', reason: 'synthetic motion consequence used only to exercise final reconciliation transport' },
      independence_basis: null,
      projection_views: ['S7', 'S9', 'S11', 'S15']
    };
    const unit = C.dedupeAdjudicativeUnits([rawUnit])[0];
    const doc = {
      schema: 'judge-final-adjudication-v1',
      revision: 1,
      bindings,
      global_baseline: {
        review_direction: 'unresolved',
        disposition: 'revise',
        reason: 'synthetic mock baseline is unresolved; transport fixture supplies no real semantic oracle'
      },
      adjudicative_units: [unit],
      upstream_reopen: { required: false, target_owner: null, target_ref: null, reason: '' },
      final: {
        criterion: 'synthetic mock motion-level consequence after dependency reconciliation',
        winner: '反方',
        score: { affirmative: 4, negative: 6 },
        reason_unit_refs: ['U-MOCK-TRANSPORT'],
        reason: 'synthetic mock final exists only to exercise the C-R transport and binding contract'
      }
    };
    return '<!--DATA: S15.获胜方=反方 -->\n' +
      '<!--DATA: S15.正方得分=4 -->\n' +
      '<!--DATA: S15.反方得分=6 -->\n' +
      '<!--FINAL_ADJUDICATION\n' + JSON.stringify(doc) + '\n-->';
  }

  // R4：mock 也返回最小可解析 structure，使默认 Web R8 能消费真实同形依赖；
  // realValidate=false 下不把这个占位结构送入正式结构语义门。
  if (prompt.includes('产出 `structure.json`') && prompt.includes('结构归约')) {
    return JSON.stringify({
      meta: { schema_version: 'v2', s11_original_type: '1b' },
      layers: [{ id: 'N1', label: '结构性交锋', side: '反方', nodes: [], opponent_nodes: [] }],
      mechanisms: []
    }, null, 2);
  }
  // R4.5：mock 最小合法裁决表（空 conflicts/authoritative，audit 自洽）
  if (prompt.includes('信息统筹轮')) {
    return JSON.stringify({
      schema_version: '0.1.0',
      meta: {
        round: 'R4.5',
        output_dir: 'mock',
        generated_at: new Date().toISOString(),
        source_conflicts_file: '.tmp-conflicts.json',
        source_warnings_file: '.tmp-validate-warnings.json',
        tendency: ''
      },
      conflicts: [],
      authoritative: {},
      structure_meta_override: null,
      audit: {
        merged_validate: { passed: true, blocking: 0 },
        post_diff_conflicts: 0,
        structure_check: { passed: true },
        recheck_notes: []
      }
    }, null, 2);
  }
  // R6b：返回满足 D3/D4/D5 + REG-RESIDUAL/TBL-EMPTY 的静态合法报告（R5 prompt 也含 “R6b” 字样，须最后判断）
  if (prompt.includes('R6b')) {
    const mods = [];
    for (let i = 1; i <= 12; i++) {
      let body = '<h2 class="st">C' + i + ' mock</h2><p class="in">mock 内容</p>';
      if (i === 1) {
        body = '<h2 class="st">C1 胜负判决</h2>' +
          '<div class="po">万物静观皆自得，千心一动始成春。</div>' +
          '<p class="wn">反方胜（4:6）</p>' +
          '<table><tr><td>向度</td><td>正方</td><td>反方</td></tr><tr><td>证伪</td><td>4</td><td>6</td></tr></table>' +
          '<table><tr><td>判准</td><td>说明</td></tr><tr><td>A</td><td>类型</td></tr></table>';
      }
      if (i === 3) body = '<h2 class="st">C3 主线全景图</h2><p class="in">mock 内容</p><span class="tg t1b">1b型</span>';
      mods.push('<div class="sk c-module c' + i + '" id="c' + i + '">' + body + '</div>');
    }
    return '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>mock 报告</title><style>body{}</style></head><body>' + mods.join('') + '</body></html>';
  }
  const fallback = '<!-- mock-good 产物 · ' + prompt.slice(0, 40) + ' -->';
  const scBinding = prompt.match(/<!--SC_AUTHORITY_BINDING\s+revision=\d+\s+affirmative=(?:formed|not_formed|uncertain)\s+negative=(?:formed|not_formed|uncertain)\s+relation=(?:none|single_side|parallel_independent|higher_order_cover|apparent_double_actual_single|mutual_partial|other_evidenced_relation)\s+dominant=(?:affirmative|negative|none|both|uncertain)\s*-->/);
  return scBinding ? fallback + '\n' + scBinding[0] : fallback;
}

// 单轮执行：断点（产物已存在且门禁通过 → 跳过）→ API → 落盘 → 门禁 → 重试（最多 3 次 + 指数退避）
async function runRound(opts) {
  opts = Object.assign({}, opts, { realValidate: resolveActiveExecutionValidation(opts, opts.realValidate) });
  const { workDir, round, cfg, mockResponder, onLog, force, newContract } = opts;
  const sfMode = semanticFirstMode(opts);
  const outFile = path.join(workDir, round.outFile);
  const promptFile = path.join(workDir, round.promptFile);
  // A8-ERR-1：断点判定 = 文件存在 + executor 门禁 + 真实 provider 下 PC 校验重验（防跳过未真正通过的产物）。
  // PRODUCTION_ACTIVE additionally requires an already-bound exact same-version view. A merely usable orphan file
  // must never be adopted by exists-first checkpoint logic and relabelled as the current semantic revision.
  const existing = readIfExists(outFile);
  const activeCheckpointBound = sfMode !== 'active' ||
    isTestActiveRoundCheckpointBound(workDir, round, opts.consumerBinding || null, existing);
  if (sfMode === 'active' && !force && existing && core.isArtifactUsable(round.name, existing) && !activeCheckpointBound) {
    onLog('[executor] PRODUCTION_ACTIVE 忽略未绑定/非同版本 checkpoint ' + round.name + '；必须在当前 authority 下重新生成，禁止 exists-first 收编');
  }
  if (!force && existing && activeCheckpointBound && core.isArtifactUsable(round.name, existing)) {
    assertSourceAnchorExemptionArtifactBinding(round, existing, opts.sourceAnchorExemptions);
    const existingValidation = opts.realValidate
      ? validateRound(workDir, round, existing, onLog, {
          newContract,
          sourceAnchorExemptions: opts.sourceAnchorExemptions,
          consumerBinding: opts.consumerBinding || null,
          semanticAuthorityBoundary: sfMode === 'active' ? 'semantic-first-v10' : null,
          globalReviewDecision: opts.globalReviewDecision || null,
          scAuthorityCurrentView: opts.scAuthorityCurrentView || null,
          freshAdjudicationOutput: false
        })
      : { passed: true, warningRecords: [] };
    if (existingValidation.passed) {
      const wxCount = (existingValidation.warningRecords || []).filter(w => w.rule === 'V-S8E-WX').length;
      if (wxCount) onLog('[executor] ' + round.name + ' audit-only V-S8E-WX ' + wxCount + ' 条（断点验证通过；不进入 R4.5 语义 warning 通道）');
      onLog('[executor] 断点命中 ' + round.name + ' → 跳过（产物门禁通过，' + anchorStateLabel(workDir) + '）');   // 260809 R8：锚状态
      return { round: round.name, skipped: true, ok: true };
    }
    if (round.name === 'R2' && Array.isArray(opts.sourceAnchorExemptions) && opts.sourceAnchorExemptions.length > 0) {
      throw sourceAnchorExemptionError('当前 P2 在应用人工豁免后仍有其他 BLOCKING；为保护人工签字绑定的原产物，拒绝调用模型覆盖 P2。请先处理其他 BLOCKING，或删除 checkpoint 后重新生成 R2');
    }
  }
  if (!fs.existsSync(promptFile)) {
    return { round: round.name, ok: false, errors: ['prompt 文件缺失: ' + round.promptFile + '（先运行 prompt 生成阶段）'] };
  }
  const promptText = fs.readFileSync(promptFile, 'utf-8');
  let lastGate = null;
  let semanticReopenRequest = null;
  let scSemanticReopenRequest = null;
  for (let attempt = 0; attempt <= core.MAX_RETRIES; attempt++) {
    semanticReopenRequest = null;
    scSemanticReopenRequest = null;
    let repairPlan = attempt > 0 ? roundRepairPlan(round, lastGate) : { mode: 'initial', scopes: [], issues: [] };
    if (repairPlan.mode === 'fail_closed') {
      appendRetryEvent(workDir, { round: round.name, stage: 'repair', event: 'fail_closed', attempt: attempt + 1, typedIssues: repairPlan.issues || [] });
      break;
    }
    appendRetryEvent(workDir, { round: round.name, stage: 'generation', event: 'attempt_start', attempt: attempt + 1, retryIndex: attempt, repairMode: repairPlan.mode, repairScopes: repairPlan.scopes || [] });
    onLog('[executor] ' + round.name + ' 开始调用 API（等待响应…）attempt=' + (attempt + 1) + (repairPlan.mode === 'r5_bounded' ? ' · bounded-repair' : ''));
    if (attempt > 0) {
      const d = core.retryDelayMs(attempt);
      onLog('[executor] ' + round.name + ' 重试 ' + attempt + '/' + core.MAX_RETRIES + ' · 退避 ' + d + 'ms');
      await sleep(d);
    }
    // A8-ERR-1：重试携带格式校验反馈（结构性提升模型遵守率，避免原样重发碰运气）
    let authorityBoundPrompt = promptText;
    const authorityFooter = '\n\n## V10 CURRENT AUTHORITY PRECEDENCE\n当前已验证 semantic authority（R2 同时包含 SC semantic authority）是本轮语义真源。前文 round prompt 中任何 legacy Phase/类型/固定拓扑/长度/字段一致性规则只能约束表示或提供诊断，不能反向改写 current authority；如有 source-grounded 实质异议，只能走对应 reopen request，不得静默改判。语义真源优先级不改变本轮输出合同：仍必须严格遵守紧邻前文的 round output schema、必出字段与文件格式。';
    if (sfMode === 'active') {
      const authorityText = String(opts.activeSemanticAuthorityText || '');
      if (!authorityText.includes('SEMANTIC-FIRST ACTIVE AUTHORITY') || !authorityText.includes('route: PRODUCTION_ACTIVE')) {
        const e = new Error('[executor] TEST active round missing verified TEST semantic authority');
        e.code = 'ERR_TEST_SEMANTIC_AUTHORITY_MISSING';
        throw e;
      }
      authorityBoundPrompt = authorityText + '\n\n' + promptText + authorityFooter;
      if (round.name === 'R2') {
        const scAuthorityText = String(opts.activeScAuthorityText || '');
        if (!scAuthorityText.includes('SC SEMANTIC AUTHORITY') || !scAuthorityText.includes('scope: SC_ONLY_NOT_FINAL_VERDICT')) {
          const e = new Error('[executor] V10 R2 missing verified SC semantic authority');
          e.code = 'ERR_TEST_SC_AUTHORITY_MISSING';
          throw e;
        }
        authorityBoundPrompt = authorityText + '\n\n' + scAuthorityText + '\n\n' + promptText + authorityFooter;
      }
    }
    let usePrompt = (attempt > 0 && lastGate && lastGate.errors.length)
      ? authorityBoundPrompt + '\n\n---\n## 上次输出未通过机械格式校验，必须严格修正后完整重新输出（只输出修正后的完整产物）\n' +
        lastGate.errors.map(e => '- ' + e).join('\n') + '\n'
      : authorityBoundPrompt;
    let priorArtifact = null;
    if (repairPlan.mode === 'r5_bounded') {
      priorArtifact = readIfExists(outFile);
      if (priorArtifact) {
        usePrompt = buildR5BoundedRepairPrompt(authorityBoundPrompt, priorArtifact, repairPlan);
        appendRetryEvent(workDir, { round: round.name, stage: 'repair', event: 'bounded_plan', attempt: attempt + 1, repairMode: repairPlan.mode, repairScopes: repairPlan.scopes, chapters: repairPlan.chapters });
      } else {
        repairPlan = { mode: 'round_regenerate', scopes: [], issues: repairPlan.issues || [] };
      }
    }
    let text;
    let semanticRefs = null;
    try {
      // 批 1（260812）：apiStub seam——测试可注入（签名同 api.requestCompletion）；缺省走真实提供者
      const call = opts.apiStub || requestCompletionNode;
      const callOpts = { mockResponder };
      if (opts.codexRunner) callOpts.codexRunner = opts.codexRunner;
      if (sfMode === 'shadow') {
        const binding = semanticSourceBinding(workDir, opts);
        const exchange = createRoundExchangeCapture(workDir, Object.assign({}, opts, { cfg }), call, callOpts);
        const sourceRef = binding.sourceText ? exchange.store.appendObject({
          sessionId: exchange.store.sessionId,
          kind: 'source',
          content: binding.sourceText,
          metadata: { sourcePath: binding.sourcePath, sourceSha256: binding.sourceSha256 }
        }) : null;
        const contextRef = binding.contextText ? exchange.store.appendObject({
          sessionId: exchange.store.sessionId,
          kind: 'context',
          content: binding.contextText,
          metadata: { contextSha256: binding.contextSha256 }
        }) : null;
        const captured = await exchange.capture.capture({
          sessionId: exchange.store.sessionId,
          requestId: round.name + '-attempt-' + (attempt + 1) + '-' +
            crypto.createHash('sha256').update(Buffer.from(usePrompt, 'utf8')).digest('hex').slice(0, 12),
          role: 'legacy-round-shadow',
          system: api.FORMAT_SYSTEM || null,
          messages: [{ role: 'user', content: usePrompt }],
          configRef: semanticSafeConfigRef(cfg),
          sourceRef,
          sourceSha256: binding.sourceSha256,
          contextRef,
          contextSha256: binding.contextSha256
        });
        text = captured.result.text;
        semanticRefs = { sourceRef, contextRef, requestRef: captured.requestRef, rawRef: captured.rawRef };
        onLog('[executor] ' + round.name + ' semantic-first shadow：source/context + request/raw 已先于归一化持久化');
      } else {
        text = await call(cfg, [{ role: 'user', content: usePrompt }], callOpts);
      }
      if (repairPlan.mode === 'r5_bounded') {
        const repaired = parseR5BoundedRepair(text, repairPlan.chapters);
        text = mergeR5BoundedRepair(priorArtifact, repaired, repairPlan.chapters);
        appendRetryEvent(workDir, { round: round.name, stage: 'repair', event: 'bounded_merge', attempt: attempt + 1, repairMode: repairPlan.mode, chapters: repairPlan.chapters });
      }
    } catch (e) {
      // 批 1（260812）：传输层异常（③收紧 流截断/断连/流异常族）纳入轮次重试循环——
      // 不再穿透循环导致管道退出；确定性错误（length 截断/HTTP/配置）仍直接抛（重试无意义）
      const msg = e && e.message ? String(e.message) : String(e);
      if (repairPlan.mode === 'r5_bounded' && attempt < core.MAX_RETRIES) {
        const scopedIssues = (repairPlan.issues || []).map(issue => Object.assign({}, issue, {
          message: String(issue && issue.message || '') + ' | bounded repair response error: ' + msg.slice(0, 600)
        }));
        lastGate = { ok: false, errors: ['R5 bounded repair response invalid: ' + msg], warnings: [], typedIssues: scopedIssues };
        appendRetryEvent(workDir, { round: round.name, stage: 'repair', event: 'bounded_response_failure', attempt: attempt + 1, repairMode: repairPlan.mode, chapters: repairPlan.chapters, message: msg.slice(0, 1600) });
        continue;
      }
      // 可重试 = 传输/断连/截断类（③收紧、流异常、缓冲超限、fetch 断连实况）。
      // 注意：不匹配「网络请求失败」宽词——2h 超时 AbortError 会被包装为
      // 「网络请求失败: This operation was aborted」，宽匹配将导致 4×2h 灾难性重试；
      // 真断连经 api-provider 包装后 message 仍保留 fetch failed/terminated/ECONNRESET 等实况词条
      const retryable = /未收到 finish_reason|fetch failed|ECONNRESET|terminated|other side closed|socket hang up|流中错误帧|流式响应无 body|缓冲超限/.test(msg);
      if (retryable && attempt < core.MAX_RETRIES) {
        lastGate = null;                       // 不把传输错误注入模型重试 prompt（非模型可修正项）
        appendRetryEvent(workDir, { round: round.name, stage: 'transport', event: 'retryable_failure', attempt: attempt + 1, failureClass: 'transport_transient', owner: 'provider_transport', repairMode: 'request_replay', repairScope: 'request', retryable: true, message: msg.slice(0, 1600) });
        onLog('[executor] ' + round.name + ' API 传输异常（纳入重试 attempt=' + (attempt + 1) + '）: ' + msg);
        continue;                              // 回到循环头 → 退避 sleep → 下一 attempt
      }
      throw e;                                 // 非可重试 / 预算耗尽：保持原失败语义（禁止部分产物已由 api-provider 保证）
    }
    let duplicateReopenGateError = null;
    if (sfMode === 'active' && round.name === 'R2') {
      const scReopen = SCA.extractReopenRequest(text, readIfExists(path.join(workDir, '.tmp-debate.txt')));
      text = scReopen.text;
      scSemanticReopenRequest = scReopen.request;
      if (scSemanticReopenRequest) {
        onLog('[executor] R2 检测到 bounded SC semantic reopen request；正文已剥离 marker，等待独立 SC review/fidelity');
      } else {
        const beforeBinding = text;
        text = SCA.injectCanonicalBinding(text, opts.scAuthorityCurrentView || null);
        appendRetryEvent(workDir, {
          round: round.name,
          stage: 'host_control',
          event: 'canonicalized',
          attempt: attempt + 1,
          failureClass: 'host_control',
          owner: 'host',
          repairMode: 'deterministic',
          repairScope: 'SC_AUTHORITY_BINDING',
          retryable: false,
          changed: text !== beforeBinding
        });
      }
      duplicateReopenGateError = duplicateReopenProjectionGate('sc', scSemanticReopenRequest, opts.seenScReopenRequests);
    }
    if (sfMode === 'active' && round.name === 'R3') {
      const reopen = extractSemanticReopenRequest(text, readIfExists(path.join(workDir, '.tmp-debate.txt')));
      text = reopen.text;
      semanticReopenRequest = reopen.request;
      if (semanticReopenRequest) onLog('[executor] R3 检测到 bounded semantic reopen request；仅登记控制元数据，正文已剥离 marker');
      duplicateReopenGateError = duplicateReopenProjectionGate('global', semanticReopenRequest, opts.seenGlobalReopenRequests);
    }
    // A8-ERR-1：PC 延迟 require——必须在主模块（pipeline-controller）导出之后加载，避免循环依赖拿到空导出
    const PC = require('../pipeline-controller.js');
    // S 标记机械归一化（漏写 [S_START] 时补齐，与 autoFixTables 同级）
    text = PC.autoFixSMarkers(text);
    // T2：V1 无损归一化回写（“半完成 · 解释尾巴”→规范枚举值），留日志；不可归一化仍由 V1 BLOCKING
    const fixed = PC.autoFixDataValues(text, {
      semanticAuthorityBoundary: sfMode === 'active' ? 'semantic-first-v10' : null
    });
    if (fixed.fixes.length) {
      onLog('[executor] DATA 值归一化回写 ' + fixed.fixes.length + ' 处: ' +
        fixed.fixes.map(f => f.key + ':' + f.from + '→' + f.to).join('; '));
    }
    text = fixed.text;
    fs.writeFileSync(outFile, text, 'utf-8');
    assertSourceAnchorExemptionArtifactBinding(round, text, opts.sourceAnchorExemptions);
    // 3B：attempt 留档（防“失败 attempt 全文被后续重试覆盖”的历史缺口）
    try { fs.writeFileSync(outFile + '.attempt' + (attempt + 1), text, 'utf-8'); } catch (e) {}
    // 实测修复（2026-08-05）：先 PC.validate（A1-A4/D1-D2 等完整清单），再 assessArtifact，
    // 两类错误合并成一条重试反馈——避免 assessArtifact 短路导致模型看不到 A1 缺失清单。
    const gateErrors = [];
    if (duplicateReopenGateError) gateErrors.push(duplicateReopenGateError);
    let vr = null;                                    // 260809 R2：提至 if 外（原 const 块级作用域 → lastGate.ok 分支 ReferenceError）
    if (opts.realValidate) {
      vr = validateRound(workDir, round, text, onLog, {
        newContract,
        sourceAnchorExemptions: opts.sourceAnchorExemptions,
        consumerBinding: opts.consumerBinding || null,
        semanticAuthorityBoundary: sfMode === 'active' ? 'semantic-first-v10' : null,
        globalReviewDecision: opts.globalReviewDecision || null,
        semanticReopenRequest: semanticReopenRequest || null,
        scAuthorityCurrentView: opts.scAuthorityCurrentView || null,
        freshAdjudicationOutput: round.name === 'R4.5'
      });
      if (!vr.passed) gateErrors.push('PC.validate: ' + vr.errors.join('; '));
    }
    const aa = core.assessArtifact(round.name, text);
    if (!aa.ok) gateErrors.push(aa.errors.join('; '));
    const typedGateIssues = [];
    if (vr && Array.isArray(vr.typedIssues)) typedGateIssues.push(...vr.typedIssues.filter(x => x && x.severity === 'BLOCKING'));
    if (!aa.ok) {
      typedGateIssues.push(...validator.toTypedIssues((aa.errors || []).map(message => ({
        rule: 'ARTIFACT',
        severity: 'BLOCKING',
        message
      }))));
    }
    lastGate = gateErrors.length
      ? { ok: false, errors: gateErrors, warnings: [], typedIssues: typedGateIssues }
      : { ok: true, errors: [], warnings: [], typedIssues: [] };
    if (!lastGate.ok && sfMode === 'shadow') {
      lastGate.issueRefs = persistSemanticGateIssue(workDir, opts, round, attempt, semanticRefs, lastGate.typedIssues.length
        ? lastGate.typedIssues
        : validator.toTypedIssues(lastGate.errors.map(message => ({ rule: 'GATE', severity: 'BLOCKING', message }))));
    }
    if (lastGate.ok) {
      onLog('[executor] ' + round.name + ' ✓ 落盘 ' + round.outFile + ' (' + Buffer.byteLength(text, 'utf-8') + 'B)（' + anchorStateLabel(workDir) + '）');
      // R9.2（260809）：锚 3 旁证 warn 落盘（V-S8E-W3；R3 final 后由 buildTransitionFinal 覆盖属预期）
      if (opts.realValidate && vr && vr.warnings && vr.warnings.length) {
        try {
          const semanticWarnings = warningsForAdjudication(vr, {
            semanticAuthorityBoundary: sfMode === 'active' ? 'semantic-first-v10' : null
          });
          if (semanticWarnings.length) {
            fs.writeFileSync(path.join(workDir, '.tmp-validate-warnings.json'), JSON.stringify(semanticWarnings, null, 2), 'utf-8');
            onLog('[executor] ' + round.name + ' warnings ' + semanticWarnings.length + ' 条 → .tmp-validate-warnings.json');
          }
          const auditOnly = (vr.warningRecords || []).filter(w => w.rule === 'V-S8E-WX');
          if (auditOnly.length) onLog('[executor] ' + round.name + ' audit-only V-S8E-WX ' + auditOnly.length + ' 条（不进入 R4.5 语义 warning 通道）');
        } catch (e) { /* 落盘失败不阻断 */ }
      }
      appendRetryEvent(workDir, { round: round.name, stage: 'validation', event: 'accepted', attempt: attempt + 1, retryIndex: attempt, bytes: Buffer.byteLength(text, 'utf-8') });
      return { round: round.name, ok: true, attempt, bytes: Buffer.byteLength(text, 'utf-8'), semanticFirstMode: sfMode, semanticRefs, semanticReopenRequest, scSemanticReopenRequest, finalUpstreamReopenRequest: vr && vr.finalUpstreamReopenRequest || null, consumerBinding: vr && vr.consumerBinding || opts.consumerBinding || null };
    }
    appendRetryEvent(workDir, { round: round.name, stage: 'validation', event: 'gate_failure', attempt: attempt + 1, retryIndex: attempt, typedIssues: lastGate.typedIssues || [], errors: (lastGate.errors || []).slice(0, 20) });
    onLog('[executor] ' + round.name + ' 门禁失败: ' + lastGate.errors.join('; '));
  }
  appendRetryEvent(workDir, { round: round.name, stage: 'validation', event: 'budget_exhausted', attempt: core.MAX_RETRIES + 1, retryIndex: core.MAX_RETRIES, typedIssues: lastGate && lastGate.typedIssues || [], errors: lastGate ? (lastGate.errors || []).slice(0, 20) : ['未知失败'] });
  return { round: round.name, ok: false, errors: lastGate ? lastGate.errors : ['未知失败'], attempt: core.MAX_RETRIES, semanticFirstMode: sfMode, typedIssues: lastGate && lastGate.typedIssues || [], issueRefs: lastGate && lastGate.issueRefs || [], scSemanticReopenRequest };
}

// R4 后数据聚合：P1+P2+P2.5+P3 → full-data.md（R5 唯一输入）
function buildFullData(workDir, onLog, opts) {
  opts = opts || {};
  const specs = [
    ['P1', 'P1.md'], ['P2', 'P2.md'], ['P2.5', 'P2.5.md'], ['P3', 'P3.md']
  ];
  const plan = resolveConsumerBinding(workDir, opts.consumerBinding || null,
    opts.consumerBinding ? specs.map(x => x[0]) : []);
  const parts = [];
  for (const [viewName, legacyName] of specs) {
    const p = consumerViewPath(workDir, plan, viewName, [legacyName], true);
    if (!p || !fs.existsSync(p)) {
      throw new Error('[executor] 数据聚合失败: 缺少 ' + legacyName + '——禁止生成不完整 full-data（全量运行保障）。请修复对应轮次后重跑。');
    }
    parts.push('<!-- SECTION:' + legacyName.replace(/\.md$/, '').toUpperCase() + '_START -->\n' + fs.readFileSync(p, 'utf-8') + '\n<!-- SECTION:' + legacyName.replace(/\.md$/, '').toUpperCase() + '_END -->');
  }
  const full = parts.join('\n---\n');
  fs.writeFileSync(path.join(workDir, 'full-data.md'), full, 'utf-8');
  onLog('[executor] 数据聚合 → full-data.md (' + full.length + '字；consumer=' + plan.mode + ')');
}

// A8-ERR-1 R3 修复：R3 调用前重建 .tmp-R3-prompt.md——注入 P1/P2/P2.5 + 从 P1/P2 提取的唯一辩词引用块
// （对应旧机制技能步骤 3：主线程 grep '> "..."' 提取引用 + R3 Agent 读取前置数据；executor 单次调用需全部内联）
function buildFinalAdjudicationBindings(workDir, consumerBinding, scCurrentView) {
  const plan = resolveConsumerBinding(workDir, consumerBinding, ['P1', 'P2']);
  if (plan.mode !== 'semantic-bound') throw consumerAuthorityError('C-R final adjudication requires semantic-bound current');
  const sc = scCurrentView || {};
  if (!Number.isInteger(Number(sc.revision)) || Number(sc.revision) < 1 ||
      !String(sc.semanticObjectId || '') || !String(sc.projectionObjectId || '') ||
      String(sc.sourceSha256 || '') !== String(plan.sourceSha256 || '') ||
      Number(sc.globalSemanticRevision) !== Number(plan.revision) ||
      String(sc.globalSemanticObjectId || '') !== String(plan.semanticObjectId || '')) {
    throw consumerAuthorityError('C-R SC current view does not match current global semantic/source authority');
  }
  const p1 = plan.views.P1;
  const p2 = plan.views.P2;
  const p25 = plan.views['P2.5'] || null;
  return {
    source_sha256: plan.sourceSha256,
    global_semantic: {
      revision: plan.revision,
      object_id: plan.semanticObjectId,
      sha256: String(plan.semanticRef && plan.semanticRef.sha256 || '')
    },
    sc_semantic: {
      revision: Number(sc.revision),
      object_id: String(sc.semanticObjectId),
      projection_object_id: String(sc.projectionObjectId),
      source_sha256: String(sc.sourceSha256),
      global_semantic_revision: Number(sc.globalSemanticRevision)
    },
    upstream: {
      P1_sha256: p1.sha256,
      P2_sha256: p2.sha256,
      P25_sha256: p25 ? p25.sha256 : null
    }
  };
}

function checkFinalAdjudicationAlignment(text, reviewDecision, expectedBindings) {
  const C = require('./contract.js');
  const blocking = [];
  const parsed = C.extractFinalAdjudicationControl(String(text || ''));
  if (!parsed.passed) {
    for (const e of parsed.errors || []) blocking.push({
      rule: 'V10-FINAL-ADJUDICATION', severity: 'BLOCKING', authorityClass: 'consumer_contract', message: e.message
    });
    return { passed: false, blocking, doc: null, upstreamReopenRequest: null };
  }
  const doc = C.canonicalizeFinalAdjudication(parsed.doc);
  const validation = C.validateFinalAdjudication(doc, expectedBindings);
  for (const e of validation.errors || []) blocking.push({
    rule: 'V10-' + e.rule, severity: 'BLOCKING', authorityClass: 'consumer_contract', message: e.message
  });

  const reviewedDirection = String(reviewDecision && reviewDecision.net && reviewDecision.net.review_direction || '');
  const declaredBaseline = String(doc && doc.global_baseline && doc.global_baseline.review_direction || '');
  if (reviewedDirection && declaredBaseline !== reviewedDirection) {
    blocking.push({
      rule: 'V10-FINAL-GLOBAL-BASELINE', severity: 'BLOCKING', authorityClass: 'consumer_contract',
      message: 'final adjudication baseline=' + declaredBaseline + ' does not match reviewed global baseline=' + reviewedDirection
    });
  }

  const data = C.extractDataMarkers(String(text || ''));
  const final = doc.final || {};
  const winner = String(data['S15.获胜方'] || '');
  const pro = data['S15.正方得分'];
  const con = data['S15.反方得分'];
  if (!winner || winner !== String(final.winner || '') ||
      !Number.isFinite(Number(pro)) || !Number.isFinite(Number(con)) ||
      Number(pro) !== Number(final.score && final.score.affirmative) ||
      Number(con) !== Number(final.score && final.score.negative)) {
    blocking.push({
      rule: 'V10-FINAL-S15', severity: 'BLOCKING', authorityClass: 'consumer_contract',
      message: 'S15 winner/score must exactly match judge-final-adjudication-v1 final result'
    });
  }
  return {
    passed: blocking.length === 0,
    blocking,
    doc,
    upstreamReopenRequest: doc && doc.upstream_reopen && doc.upstream_reopen.required === true
      ? JSON.parse(JSON.stringify(doc.upstream_reopen)) : null
  };
}

function ensureFinalAdjudicationAuthority(workDir, p3Text, consumerBinding, scCurrentView, reviewDecision) {
  const C = require('./contract.js');
  const bindings = buildFinalAdjudicationBindings(workDir, consumerBinding, scCurrentView);
  const aligned = checkFinalAdjudicationAlignment(p3Text, reviewDecision, bindings);
  if (!aligned.passed) {
    const e = new Error('[executor] C-R final adjudication alignment failed: ' +
      aligned.blocking.map(x => x.rule + ': ' + x.message).join('; '));
    e.code = 'ERR_FINAL_ADJUDICATION_ALIGNMENT';
    e.blocking = aligned.blocking;
    throw e;
  }
  if (aligned.upstreamReopenRequest) {
    return { published: false, upstreamReopenRequest: aligned.upstreamReopenRequest, bindings, doc: aligned.doc, receipt: null };
  }
  const doc = C.canonicalizeFinalAdjudication(aligned.doc);
  const receipt = C.buildFinalAdjudicationReceipt(doc, p3Text);
  const receiptCheck = C.validateFinalAdjudicationReceipt(receipt, doc, p3Text, bindings);
  if (!receiptCheck.passed) {
    const e = new Error('[executor] C-R final receipt self-check failed: ' +
      receiptCheck.errors.map(x => x.rule + ': ' + x.message).join('; '));
    e.code = 'ERR_FINAL_ADJUDICATION_RECEIPT';
    throw e;
  }
  const finalPath = path.join(workDir, 'final-adjudication.json');
  const receiptPath = path.join(workDir, 'final-adjudication-receipt.json');
  const finalText = JSON.stringify(doc, null, 2) + '\n';
  const receiptText = JSON.stringify(receipt, null, 2) + '\n';
  if (fs.existsSync(finalPath) || fs.existsSync(receiptPath)) {
    if (!fs.existsSync(finalPath) || !fs.existsSync(receiptPath)) {
      const e = new Error('[executor] C-R final sidecar pair incomplete');
      e.code = 'ERR_FINAL_ADJUDICATION_SIDECAR_INCOMPLETE';
      throw e;
    }
    const existingDoc = JSON.parse(fs.readFileSync(finalPath, 'utf8'));
    const existingReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    const check = C.validateFinalAdjudicationReceipt(existingReceipt, existingDoc, p3Text, bindings);
    if (!check.passed || C.stableContractJson(existingDoc) !== C.stableContractJson(doc)) {
      const e = new Error('[executor] stale final adjudication sidecar detected');
      e.code = 'ERR_FINAL_ADJUDICATION_STALE';
      throw e;
    }
    return { published: true, reused: true, bindings, doc: existingDoc, receipt: existingReceipt, finalRevision: check.final_revision };
  }
  fs.writeFileSync(finalPath, finalText, 'utf8');
  fs.writeFileSync(receiptPath, receiptText, 'utf8');
  return { published: true, reused: false, bindings, doc, receipt, finalRevision: receipt.final_revision };
}

function verifyFinalAdjudicationAuthority(workDir, p3Text, consumerBinding, scCurrentView) {
  const C = require('./contract.js');
  const finalPath = path.join(workDir, 'final-adjudication.json');
  const receiptPath = path.join(workDir, 'final-adjudication-receipt.json');
  if (!fs.existsSync(finalPath) || !fs.existsSync(receiptPath)) {
    throw consumerAuthorityError('C-R final authority sidecar missing');
  }
  const doc = JSON.parse(fs.readFileSync(finalPath, 'utf8'));
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  const bindings = buildFinalAdjudicationBindings(workDir, consumerBinding, scCurrentView);
  const check = C.validateFinalAdjudicationReceipt(receipt, doc, p3Text, bindings);
  if (!check.passed) throw consumerAuthorityError('C-R final receipt invalid: ' + check.errors.map(x => x.rule).join(','));
  return { doc, receipt, bindings, finalRevision: check.final_revision };
}

function buildR3Prompt(workDir, onLog, opts) {
  opts = opts || {};
  // semanticRef/projectionRef 是 authority refs，不是普通 generated view。
  // Production active 已由 runRound 的 SEMANTIC-FIRST ACTIVE AUTHORITY wrapper 注入全文权威；
  // generic I2 caller 若不用该 wrapper，仍须显式提供 bound views.semantic，不能静默降级。
  const required = opts.consumerBinding ? ['P1', 'P2', 'P2.5'] : [];
  const plan = resolveConsumerBinding(workDir, opts.consumerBinding || null, required);
  const p1Path = consumerViewPath(workDir, plan, 'P1', ['P1.md'], true);
  const p2Path = consumerViewPath(workDir, plan, 'P2', ['P2.md'], true);
  const p25Path = consumerViewPath(workDir, plan, 'P2.5', ['P2.5.md'], false);
  let semanticText = '';
  let semanticAuthorityMode = '';
  if (plan.mode === 'semantic-bound') {
    const activeAuthority = String(opts.activeSemanticAuthorityText || '');
    if (activeAuthority.includes('SEMANTIC-FIRST ACTIVE AUTHORITY')) {
      semanticAuthorityMode = 'active-wrapper';
    } else {
      const semanticPath = consumerViewPath(workDir, plan, 'semantic', [], true);
      semanticText = readIfExists(semanticPath);
      if (!semanticText) throw consumerAuthorityError('semantic-bound R3 缺少可读 semantic authority');
      semanticAuthorityMode = 'bound-view';
    }
  }
  const p1 = readIfExists(p1Path);
  const p2 = readIfExists(p2Path);
  const p25 = p25Path ? readIfExists(p25Path) : '';
  let finalReconciliationText = '';
  if (plan.mode === 'semantic-bound') {
    const scView = SCA.buildAdjudicativeConsumerView(opts.scAuthorityCurrentView || {});
    const finalBindings = buildFinalAdjudicationBindings(workDir, opts.consumerBinding, opts.scAuthorityCurrentView || null);
    finalReconciliationText = '\n\n---\n\n## V10 C-R FINAL ADJUDICATIVE RECONCILIATION（R3 final authority）\n' +
      '- Global Semantic 是 reviewed baseline，不是 terminal winner oracle；final 可以 source-grounded maintain 或 revise，但必须准确声明 baseline。\n' +
      '- SC view 只拥有 SC truth，scope 始终为 SC_ONLY_NOT_FINAL_VERDICT；formed SC 不自动加分/判胜。\n' +
      '- local clash truth 与 motion-level consequence 分层；若 S7 local truth 本身错误，必须 upstream_reopen，不得在 final 静默改写。\n' +
      '- S7/S9/S11/S15 若来自同一 causal dependency，只算一个 dependency；不得按 view 数、unit 数、抽象层级计票。\n' +
      '- mutual_partial / higher_order_cover / value / 更抽象层级均不自动决定胜负。\n' +
      '\n### Exact final bindings（逐字段原样回填）\n' + JSON.stringify(finalBindings, null, 2) +
      '\n\n### Bounded rich SC direct consumer view\n' + JSON.stringify(scView, null, 2) +
      '\n\n### Required non-DATA control block\n' +
      '正文 S15 与以下 final 必须一致；只输出一个控制块：\n<!--FINAL_ADJUDICATION\n' +
      '{"schema":"judge-final-adjudication-v1","revision":1,"bindings":<Exact final bindings>,"global_baseline":{"review_direction":"affirmative|negative|balanced|unresolved","disposition":"maintain|revise","reason":"source-grounded reason"},"adjudicative_units":[{"unit_id":"U-...","source_refs":["M/CP/SC refs"],"target_ref":"motion-level target","causal_dependency":"same causal dependency","local_clash":{"status":"maintain|reopen_required","owner_ref":"S7/owner ref","reason":"local truth status"},"motion_consequence":{"status":"...","reason":"motion-level consequence"},"independence_basis":null,"projection_views":["S7","S9","S11","S15"]}],"upstream_reopen":{"required":false,"target_owner":null,"target_ref":null,"reason":""},"final":{"criterion":"motion-level consequence after dependency reconciliation","winner":"正方|反方|平|未决","score":{"affirmative":0,"negative":0},"reason_unit_refs":["U-..."],"reason":"source-grounded final reason"}}\n-->\n' +
      '不要自行计算 dependency_id；host 会对 unit 做 deterministic identity + canonical dedup。同 dependency 的多个 projection view 应语义上视为同一依赖，不得当作多票。';
  }
  const base = readIfExists(path.join(workDir, '.tmp-R3-prompt.md'));
  if (!base || !p1 || !p2) throw new Error('[executor] R3 prompt 重建缺少 base/P1/P2');
  const quotes = [...new Set((p1 + '\n' + p2).split('\n').filter(l => /^\s*>\s*"/.test(l)).map(l => l.trim()))];
  const quotesText = quotes.length ? quotes.join('\n') : '（P1/P2 中未提取到引用行）';
  fs.writeFileSync(path.join(workDir, '.tmp-speech-quotes.txt'), quotesText + '\n', 'utf-8');
  const enriched = base
    .replace('<!-- SPEECH_QUOTES_PLACEHOLDER: 辩词引用块由管道编排器从 P1/P2 中 grep 提取后追加 -->', quotesText)
    + '\n\n---\n\n## 前置数据（R3 必读 · 全部来自本场产物）\n\n### P1（R1 产出）\n' + p1
    + '\n\n### P2（R2 产出）\n' + p2
    + (p25 ? '\n\n### P2.5（R2.5 产出）\n' + p25 : '')
    + (plan.mode === 'semantic-bound'
      ? '\n\n---\n\n## I2 same-version 语义绑定（R3 必读）\n\n### 当前已审语义\n' +
        (semanticAuthorityMode === 'active-wrapper'
          ? '本轮当前 reviewed semantic + verified projection 已由上游 SEMANTIC-FIRST ACTIVE AUTHORITY wrapper 精确注入；此处不复制第二份可漂移文本。'
          : semanticText) +
        '\n\n### 完整原文（可直接回查；grep 引用仅作 locator，不是语义全集）\n' + readIfExists(path.join(workDir, '.tmp-debate.txt')) +
        '\n\n绑定版本：' + plan.versionKey +
        '\n\n### Bounded semantic reopen（可选；同一 authority revision 下完全相同的控制请求只处理一次）\n' +
        '你不得私自改写当前 authority。只有发现一个具体、source-grounded 的 semantic 缺陷时，才可在正文末尾附加以下控制块；没有具体缺陷就不要输出。evidence 只是可选 provenance locator：有可定位原文时 quote 应尽量逐字复制；若异议本身是遗漏/缺失而没有可引用的“缺失文本”，evidence 可为空。转写/换行有表示瑕疵时只标为待核线索，不会自行证明或否定语义，独立 reviewer 仍须回到完整原文复核：\n' +
        '<!--SEMANTIC_REOPEN_REQUEST\n' +
        '{"expectedRevision":' + plan.revision + ',"issue":"具体语义缺陷","evidence":[{"quote":"尽量逐字的原文定位片段"}]}\n' +
        '-->\n' +
        '该块只触发独立 reviewer/fidelity 复核；你自己没有 revision/commit 权限。'
      : '') + finalReconciliationText;
  fs.writeFileSync(path.join(workDir, '.tmp-R3-prompt.md'), enriched, 'utf-8');
  assertPromptsWithinContext(workDir, undefined, onLog);  // A8-P7：重建后立即超限预检
  onLog('[executor] R3 prompt 已重建（P1/P2/P2.5 + ' + quotes.length + ' 条唯一引用）');
  return enriched;
}

function formatReopenEvidenceHints(evidence) {
  return (evidence || []).map(e => {
    if (e && e.provenance_error) {
      return '- UNLOCATED HINT: ' + JSON.stringify(String(e.quote || '')) + ' [' + String(e.provenance_error) + ']';
    }
    return '- lines ' + e.lineStart + '-' + e.lineEnd + ': ' + JSON.stringify(e.quote);
  }).join('\n');
}

function semanticReopenRequestFingerprint(scope, request) {
  const evidence = Array.isArray(request && request.evidence) ? request.evidence : [];
  // Duplicate-review control owns only control identity, not semantic similarity.
  // Locator reason/order/line metadata are non-authoritative and must not let the same
  // challenge evade deduplication; exact issue text remains distinct unless byte-equal after trim.
  const quotes = [...new Set(evidence.map(e => String(e && e.quote || '')).filter(Boolean))].sort();
  const canonical = {
    scope: String(scope || ''),
    expectedRevision: Number(request && request.expectedRevision || 0),
    issue: String(request && request.issue || '').trim(),
    evidenceQuotes: quotes
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

function duplicateReopenProjectionGate(scope, request, seen) {
  if (!request || !seen || typeof seen.has !== 'function') return null;
  const fingerprint = semanticReopenRequestFingerprint(scope, request);
  if (!seen.has(fingerprint)) return null;
  const label = scope === 'sc' ? 'R2 SC' : 'R3 global';
  return label + ' reopen request was already independently reviewed for this authority revision; ' +
    'do not repeat the same semantic challenge. Project the current authority faithfully, or raise a genuinely different source-grounded issue.';
}

function collectPersistedReopenFingerprints(store, sessionId, scope) {
  const out = new Set();
  if (!store || typeof store.listObjects !== 'function' || typeof store.readObject !== 'function') return out;
  const refs = store.listObjects(sessionId) || [];
  const completedIssueIds = new Set();

  if (scope === 'sc') {
    // A bare issue object proves only that the control request was durably recorded.
    // Deduplicate only after an independent SC reviewer returned a verified-complete
    // terminal non-publishing decision. A revise path that later fails projection/fidelity
    // remains retryable because the semantic challenge itself was not durably resolved.
    for (const ref of refs) {
      if (!ref || ref.kind !== 'raw') continue;
      try {
        const raw = store.readObject(ref);
        const meta = raw.metadata || {};
        const issueRef = meta.reopenIssueRef || null;
        if (meta.role !== 'sc-review' || meta.completion_status !== 'verified_complete' || !meta.requestRef ||
            !issueRef || !issueRef.objectId) continue;
        const doc = JSON.parse(raw.content);
        if (!doc || !['maintain','reject','unresolved'].includes(String(doc.decision || ''))) continue;
        completedIssueIds.add(issueRef.objectId);
      } catch (_) {}
    }
  } else {
    // Global publishReviewedAuthority persists a normalized review only after the raw
    // response parsed successfully. Reject/unresolved is terminal for the current
    // challenge and may be deduplicated; maintain/revise advances to publication or
    // may still need representation recovery, so issue existence alone must not block retry.
    for (const ref of refs) {
      if (!ref || ref.kind !== 'review') continue;
      try {
        const review = store.readObject(ref);
        const meta = review.metadata || {};
        const issueRef = meta.issueRef || null;
        if (!issueRef || !issueRef.objectId || !meta.rawRef ||
            !['reject','unresolved'].includes(String(meta.decision || ''))) continue;
        const raw = store.readObject(meta.rawRef);
        const rawMeta = raw.metadata || {};
        if (rawMeta.role !== 'review' || rawMeta.completion_status !== 'verified_complete') continue;
        completedIssueIds.add(issueRef.objectId);
      } catch (_) {}
    }
  }

  const expectedSchema = scope === 'sc' ? 'judge-sc-semantic-reopen-v1' : 'judge-test-r3-reopen-v1';
  for (const ref of refs) {
    if (!ref || ref.kind !== 'issue' || !completedIssueIds.has(ref.objectId)) continue;
    try {
      const obj = store.readObject(ref);
      const doc = JSON.parse(obj.content);
      if (!doc || doc.schema !== expectedSchema) continue;
      out.add(semanticReopenRequestFingerprint(scope, doc));
    } catch (_) {}
  }
  return out;
}

function extractSemanticReopenRequest(text, sourceText) {
  const body = String(text || '');
  const re = /<!--SEMANTIC_REOPEN_REQUEST\s*([\s\S]*?)-->/g;
  const matches = [];
  let m;
  while ((m = re.exec(body)) !== null) matches.push({ raw: m[0], json: m[1] });
  if (matches.length > 1) {
    const e = new Error('[executor] R3 semantic reopen request 最多允许一个控制块');
    e.code = 'ERR_TEST_REOPEN_MULTIPLE_REQUESTS';
    throw e;
  }
  if (!matches.length) return { text: body, request: null };
  const doc = SW.parseStrictJsonObject(matches[0].json, 'R3 semantic reopen request');
  const expectedRevision = Number(doc.expectedRevision);
  const issue = String(doc.issue || '').trim();
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) {
    const e = new Error('[executor] R3 semantic reopen expectedRevision 必须为正整数');
    e.code = 'ERR_TEST_REOPEN_REVISION_INVALID';
    throw e;
  }
  if (!issue) {
    const e = new Error('[executor] R3 semantic reopen 必须给出具体 issue');
    e.code = 'ERR_TEST_REOPEN_ISSUE_REQUIRED';
    throw e;
  }
  const evidence = SW.softAnchorEvidence(String(sourceText || ''), doc.evidence || [], {
    label: 'R3 semantic reopen evidence',
    required: false
  });
  return {
    text: body.replace(matches[0].raw, '').trimEnd(),
    request: { expectedRevision, issue, evidence }
  };
}

const TEST_REOPEN_INVALIDATE_FILES = [
  'P1.md', 'P2.md', 'P2.5.md', 'P3.md', 'final-adjudication.json', 'final-adjudication-receipt.json', 'transition-final.md', 'structure.json', 'full-data.md',
  '.tmp-conflicts.json', '.tmp-validate-warnings.json', '.tmp-speech-quotes.txt', '.tmp-r45-input.md', '.tmp-r45-input-binding.json',
  'adjudication.json', '.tmp-adjudication.json', '.tmp-adjudicated-data.md', '.tmp-adjudicated-structure.json',
  '.tmp-r5-half-A.md', '.tmp-r5-half-B.md', '叙事.md', '.tmp-r6a-out.html', 'report.html', 'report-plain.html',
  '.tmp-plain-review.json', '.tmp-plain-refresh-transaction.json', 'reader-guide-input.json', 'reader-guide.json',
  'reader-guide-plain.json', 'reader-guide.html', '.tmp-reader-guide-cache.json', '.tmp-reader-guide-draft.json',
  '.tmp-reader-guide-plain-draft.json'
];
const TEST_DYNAMIC_PROMPT_MARKERS = [
  '<!-- DATA_SOURCE_INJECTED -->',
  '## 前置数据（R3 必读 · 全部来自本场产物）'
];
function captureRoundPromptBaseline(workDir) {
  const snapshot = {};
  const seen = new Set();
  for (const round of core.ROUNDS) {
    const name = round && round.promptFile;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const file = path.join(workDir, name);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
    const text = fs.readFileSync(file, 'utf8');
    const marker = TEST_DYNAMIC_PROMPT_MARKERS.find(m => text.includes(m));
    if (marker) {
      const e = new Error('[executor] TEST active round prompt baseline already contains prior-run dynamic injection: ' + name);
      e.code = 'ERR_TEST_PROMPT_BASELINE_CONTAMINATED';
      throw e;
    }
    snapshot[name] = text;
  }
  return snapshot;
}
function restoreRoundPromptBaseline(workDir, snapshot) {
  const restored = [];
  for (const [name, text] of Object.entries(snapshot || {})) {
    fs.writeFileSync(path.join(workDir, name), text, 'utf8');
    restored.push(name);
  }
  return restored.sort();
}
function invalidateAfterSemanticReopen(workDir) {
  const removed = [];
  const roots = new Set(TEST_REOPEN_INVALIDATE_FILES);
  for (const name of fs.readdirSync(workDir)) {
    for (const round of core.ROUNDS) {
      const base = round && round.outFile;
      if (base && name.indexOf(base + '.attempt') === 0 && /^\.attempt\d+$/.test(name.slice(base.length))) roots.add(name);
    }
    if (/^\.tmp-plain-batch-\d+\.json$/.test(name)) roots.add(name);
  }
  for (const name of roots) {
    const p = path.join(workDir, name);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      fs.rmSync(p, { force: true });
      removed.push(name);
    }
  }
  return removed.sort();
}
function invalidateAfterScReopen(workDir) {
  const PC = require('../pipeline-controller.js');
  const plan = PC.planResumeStart({
    requestedNode: 'R2',
    runModel: { staleRounds: {} },
    settings: { plain: true, readerGuide: true }
  });
  if (!plan || !plan.allowed) {
    const e = new Error('[executor] SC reopen cannot build R2 downstream invalidation plan');
    e.code = 'ERR_TEST_SC_REOPEN_INVALIDATION_PLAN';
    throw e;
  }
  const names = fs.readdirSync(workDir);
  const remove = PC.resumeInvalidationNames(plan, names);
  if (remove.includes('P1.md')) {
    const e = new Error('[executor] SC reopen invalidation escaped R2 boundary into P1');
    e.code = 'ERR_TEST_SC_REOPEN_INVALIDATION_SCOPE';
    throw e;
  }
  const removed = [];
  for (const name of remove) {
    const p = path.join(workDir, name);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      fs.rmSync(p, { force: true });
      removed.push(name);
    }
  }
  return removed.sort();
}

function invalidateBlockedR3Projection(workDir) {
  const PC = require('../pipeline-controller.js');
  const plan = PC.planResumeStart({
    requestedNode: 'R3',
    runModel: { staleRounds: {} },
    settings: { plain: true, readerGuide: true }
  });
  if (!plan || !plan.allowed) {
    const e = new Error('[executor] blocked R3 reopen cannot build downstream invalidation plan');
    e.code = 'ERR_TEST_REOPEN_INVALIDATION_PLAN';
    throw e;
  }
  const names = fs.readdirSync(workDir);
  const remove = PC.resumeInvalidationNames(plan, names);
  for (const protectedName of ['P1.md', 'P2.md', 'P2.5.md']) {
    if (remove.includes(protectedName)) {
      const e = new Error('[executor] blocked R3 reopen invalidation escaped upstream boundary: ' + protectedName);
      e.code = 'ERR_TEST_REOPEN_INVALIDATION_SCOPE';
      throw e;
    }
  }
  const removed = [];
  for (const name of remove) {
    const p = path.join(workDir, name);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      fs.rmSync(p, { force: true });
      removed.push(name);
    }
  }
  return removed.sort();
}
function invalidateAfterFinalUpstreamReopen(workDir, request) {
  const PC = require('../pipeline-controller.js');
  const owner = String(request && request.target_owner || '');
  if (!['R1', 'R2', 'R2.5'].includes(owner)) {
    const e = new Error('[executor] C-R upstream reopen target_owner must be R1/R2/R2.5');
    e.code = 'ERR_FINAL_UPSTREAM_REOPEN_OWNER';
    throw e;
  }
  const plan = PC.planResumeStart({
    requestedNode: owner,
    runModel: { staleRounds: {} },
    settings: { plain: true, readerGuide: true }
  });
  if (!plan || !plan.allowed) {
    const e = new Error('[executor] C-R upstream reopen cannot build resume plan for ' + owner);
    e.code = 'ERR_FINAL_UPSTREAM_REOPEN_PLAN';
    throw e;
  }
  const remove = PC.resumeInvalidationNames(plan, fs.readdirSync(workDir));
  const protectedNames = owner === 'R2' ? ['P1.md'] : owner === 'R2.5' ? ['P1.md', 'P2.md'] : [];
  for (const name of protectedNames) {
    if (remove.includes(name)) throw new Error('[executor] C-R upstream reopen escaped owner boundary into ' + name);
  }
  const removed = [];
  for (const name of remove) {
    const file = path.join(workDir, name);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) {
      fs.rmSync(file, { force: true });
      removed.push(name);
    }
  }
  return { owner, removed: removed.sort() };
}

function pruneConsumerBindingAfterInvalidation(workDir, binding, removedNames) {
  if (!binding) return null;
  const next = JSON.parse(JSON.stringify(binding));
  const removed = new Set((removedNames || []).map(name => String(name).replace(/\\/g, '/')));
  next.views = next.views && typeof next.views === 'object' ? next.views : {};
  let changed = false;
  for (const [name, view] of Object.entries(next.views)) {
    const rel = String(view && view.path || '').replace(/\\/g, '/');
    const abs = rel ? path.join(workDir, rel) : null;
    if (!rel || removed.has(rel) || !abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      delete next.views[name];
      changed = true;
    }
  }
  if (changed) {
    next.viewRevision = (Number(next.viewRevision) || 1) + 1;
    return issueTransientConsumerBinding(next);
  }
  resolveConsumerBinding(workDir, next, []);
  return next;
}

async function publishTestR3Reopen(workDir, prepared, request, opts) {
  opts = opts || {};
  const direct = proveGlobalDirectExecutionContext(workDir, prepared, opts, 'global semantic reopen');
  const active = direct.active;
  const current = direct.current;
  if (request.expectedRevision !== current.revision) {
    const e = new Error('[executor] R3 semantic reopen revision stale: expected=' + request.expectedRevision + ' current=' + current.revision);
    e.code = 'ERR_TEST_REOPEN_STALE_REVISION';
    throw e;
  }
  const reopenIssueRef = persistTestR3ReopenIssue(active, current, request);
  const issueText = 'R3 bounded semantic reopen issue: ' + request.issue + '\n' +
    'Source-grounded hints (unlocated quotes are claims, not evidence):\n' + formatReopenEvidenceHints(request.evidence);
  const publication = await active.workflow.publishReviewedAuthority({
    sessionId: active.sessionId,
    semanticRef: current.semanticRef,
    sourceRef: '.tmp-debate.txt',
    contextRef: active.binding.contextText ? 'test-context' : null,
    expectedCurrent: current,
    reviewPrompt: active.profile.review,
    issueRef: reopenIssueRef,
    issueText,
    projectPrompt: active.profile.project,
    targetContract: 'PRODUCTION_ACTIVE same-version semantic authority after bounded R3 reopen',
    fidelityPrompt: active.profile.fidelity,
    requestId: 'test-active-r3-reopen-r' + current.revision,
    requireVerifiedCompletion: true,
    configRef: semanticSafeConfigRef(opts.cfg)
  });
  publication.refs = Object.assign({}, publication.refs || {}, { reopenIssueRef });
  if (publication.status === 'commit_state_unknown' || publication.status === 'stale_result_preserved') {
    const e = new Error('[executor] R3 semantic reopen commit/current state requires explicit recovery: ' + publication.status);
    e.code = 'ERR_TEST_SEMANTIC_RECOVERY_REQUIRED';
    e.publication = publication;
    throw e;
  }
  if (publication.status !== 'semantic_authority_published') {
    const safelyBlocked = new Set(['semantic_review_rejected', 'semantic_review_unresolved', 'projection_fidelity_rejected']);
    if (!safelyBlocked.has(publication.status)) {
      const e = new Error('[executor] R3 semantic reopen returned unclassified publication state: ' + publication.status);
      e.code = 'ERR_TEST_SEMANTIC_PUBLICATION_BLOCKED';
      e.publication = publication;
      throw e;
    }
    return { published: false, publication, current };
  }
  const consumerBinding = buildSemanticConsumerBinding(publication.current);
  return {
    published: true,
    publication,
    current: publication.current,
    consumerBinding,
    authorityText: testSemanticAuthorityBlock(active.store, publication.current, publication, consumerBinding, active.attestation)
  };
}

// R5 半区拼接：A（C1-C7）+ B（C8-C12）→ 叙事.md
function mergeNarrative(workDir, onLog) {
  const a = readIfExists(path.join(workDir, '.tmp-r5-half-A.md'));
  const b = readIfExists(path.join(workDir, '.tmp-r5-half-B.md'));
  // A8-P7：全量运行保障——任一半区缺失即阻断，禁止部分拼接后继续
  if (!a && !b) {
    throw new Error('[executor] 叙事拼接失败: R5-A 与 R5-B 半区均缺失——禁止跳过叙事继续。');
  }
  if (!a || !b) {
    throw new Error('[executor] 叙事拼接失败: 缺少 ' + (!a ? '.tmp-r5-half-A.md' : '.tmp-r5-half-B.md') + '——禁止部分拼接/降级叙事，请补全 R5 半区产物。');
  }
  const merged = a + (a && b ? '\n\n' : '') + b;
  fs.writeFileSync(path.join(workDir, '叙事.md'), merged, 'utf-8');
  onLog('[executor] 叙事半区拼接 → 叙事.md (' + merged.length + '字)');
  return true;
}

// A8-ERR-1 C8：R3 通过后生成 transition-final.md（P1+P2+P2.5+P3 合并 + 校验），写入 workDir
// realValidate=false（mock 冒烟）：仅生成文件与 TABLE 配对，跳过严格 R3 校验
function buildTransitionFinal(workDir, onLog, realValidate, opts) {
  opts = opts || {};
  const PC = require('../pipeline-controller.js');
  const plan = resolveConsumerBinding(workDir, opts.consumerBinding || null,
    opts.consumerBinding ? ['P1', 'P2', 'P2.5', 'P3'] : []);
  const p1 = readIfExists(consumerViewPath(workDir, plan, 'P1', ['P1.md'], true));
  const p2 = readIfExists(consumerViewPath(workDir, plan, 'P2', ['P2.md'], true));
  const p25Path = consumerViewPath(workDir, plan, 'P2.5', ['P2.5.md'], false);
  const p25 = p25Path ? readIfExists(p25Path) : '';
  const p3 = readIfExists(consumerViewPath(workDir, plan, 'P3', ['P3.md'], true));
  if (!p1 || !p2 || !p3) throw new Error('[executor] transition-final 合并缺少 P1/P2/P3');
  let merged = p1 + '\n---\n' + p2;
  if (p25) merged += '\n---\n' + p25;
  merged += '\n---\n' + p3;
  merged = PC.autoFixSMarkers(merged);
  merged = PC.autoFixTables(merged);
  const pair = PC.validateTablePairing(merged);
  if (!pair.passed) throw new Error('[executor] TABLE 配对失败: ' + pair.errors.join('; '));
  let result = null;
  // 260810 批次3（P1-B）：final validate 前读 P1 探测 newContract（同判定核心）
  const newContractFinal = PC.detectNewContractFromText(p1);
  if (realValidate) {
    // A8-ERR-1：合并文件必须用 final 模式（跨三轮）校验，与 validate-final CLI 对齐——单轮 R3 语义会对全集合误报 F3
    result = PC.validate(merged, 'R3', {
      final: true,
      p1Data: PC.extractDataMarkers(p1),
      p2Data: PC.extractDataMarkers(p2),
      p25Data: p25 ? PC.extractDataMarkers(p25) : {},
      newContract: newContractFinal,
      semanticAuthorityBoundary: opts.semanticAuthorityBoundary || null
    });
    if (!result.passed) throw new Error('[executor] transition-final 校验失败: ' + (result.blocking || []).map(e => e.message).join('; '));
  }
  // Legacy completion→direction derivation is a semantic rule. In semantic-first V10,
  // reviewed authority owns semantic truth, so transition-final must not synthesize it after validation.
  if (opts.semanticAuthorityBoundary !== 'semantic-first-v10') {
    merged = PC.injectDerivedDataLines(merged);
  }
  fs.writeFileSync(path.join(workDir, 'transition-final.md'), merged, 'utf-8');
  // A73：R3 final warnings 是完整 snapshot，不是 exists-first 增量。早先 R1/R2/R2.5 的 warning
  // 不得在本轮 final 无 warning 时残留并进入 R4.5 adjudication prompt。mock/non-realValidate 也明确
  // 表示“本轮没有 formal R3 warnings”，因此同样清除旧文件而不是继承历史字节。
  const finalWarningsPath = path.join(workDir, '.tmp-validate-warnings.json');
  const finalAdjudicationWarnings = realValidate && result
    ? warningsForAdjudication(result, { semanticAuthorityBoundary: opts.semanticAuthorityBoundary || null })
    : [];
  if (finalAdjudicationWarnings.length) {
    fs.writeFileSync(finalWarningsPath, JSON.stringify(finalAdjudicationWarnings, null, 2));
  } else if (fs.existsSync(finalWarningsPath)) {
    fs.rmSync(finalWarningsPath, { force: true });
  }
  if (realValidate && result) {
    // D1/D2：判决行/比分与 S15 DATA 一致性（合同固定 正方:反方）
    const vc = PC.checkVerdictConsistency(merged, PC.extractDataMarkers(merged));
    if (vc.errors.length)
      throw new Error('[executor] transition-final D1/D2 校验失败: ' + vc.errors.map(e => e.message).join('; '));
    // 第4项：diffConflicts 机械矛盾登记表落盘（structure 尚未产出，先跑与 structure 无关的维度）
    try {
      const conflicts = PC.diffConflicts(
        PC.aggregateData(path.join(workDir, 'transition-final.md')),
        null,
        { excluded: adjudicationConflictExclusions(opts.semanticAuthorityBoundary) }
      );
      if (conflicts.length) fs.writeFileSync(path.join(workDir, '.tmp-conflicts.json'), JSON.stringify(conflicts, null, 2));
    } catch (e) {}
  }
  onLog('[executor] transition-final.md 已生成 (' + merged.length + '字)');
  return merged;
}

// A8-ERR-1：真实路径 R6 机械渲染（report.html 由渲染器确定性生成，替代 LLM 超长输出轮）
function renderReport(workDir, consumerOpts) {
  consumerOpts = consumerOpts || {};
  const RR = require('../render-report.js');
  const PC = require('../pipeline-controller.js');
  const plan = resolveConsumerBinding(workDir, consumerOpts.consumerBinding || null,
    consumerOpts.consumerBinding ? ['adjudicatedData', 'adjudicatedStructure', 'narrative', 'adjudication'] : []);
  // legacy-unversioned 保留旧 exists-first；semantic-bound 只消费 manifest 明确绑定的 view。
  const tf = consumerViewPath(workDir, plan, 'adjudicatedData',
    ['.tmp-adjudicated-data.md', 'transition-final.md'], true);
  const narr = consumerViewPath(workDir, plan, 'narrative', ['叙事.md'], true);
  const st = consumerViewPath(workDir, plan, 'adjudicatedStructure',
    ['.tmp-adjudicated-structure.json', 'structure.json'], true);
  const adjPath = consumerViewPath(workDir, plan, 'adjudication', ['adjudication.json'], false);
  let finalAuthority = null;
  if (plan.mode === 'semantic-bound') {
    const finalPlan = resolveConsumerBinding(workDir, consumerOpts.consumerBinding,
      ['P3', 'finalAdjudication', 'finalAdjudicationReceipt']);
    const p3Path = consumerViewPath(workDir, finalPlan, 'P3', ['P3.md'], true);
    finalAuthority = verifyFinalAdjudicationAuthority(
      workDir,
      fs.readFileSync(p3Path, 'utf8'),
      consumerOpts.consumerBinding,
      consumerOpts.scAuthorityCurrentView || scBindingIdentityFromProvenance(workDir, readScProvenance(workDir))
    );
  }
  // A8-P7：禁止降级渲染——structure.json 缺失即阻断（C3 必须按推进层完整渲染）
  if (!fs.existsSync(tf) || !fs.existsSync(narr)) throw new Error('渲染缺少 transition-final.md 或 叙事.md——禁止降级渲染。');
  if (!fs.existsSync(st)) throw new Error('渲染缺少 structure.json——禁止降级渲染 C3（结构归约必须完整）。请先通过 R4 门禁。');
  const normalized = RR.normalizePhase1(fs.readFileSync(tf, 'utf-8'), fs.readFileSync(narr, 'utf-8'));
  const opts = {};
  // 批甲 HN-5：裁决产物只从当前 consumer binding（或 legacy lane）读取。
  opts.adjudication = (() => {
    try { return adjPath ? JSON.parse(fs.readFileSync(adjPath, 'utf8')) : null; }
    catch (e) { return null; }
  })();
  if (plan.mode === 'semantic-bound' && opts.adjudication) {
    assertR45AdjudicationInputBinding(workDir, opts.adjudication, consumerOpts.consumerBinding);
    const forbidden = legacySemanticAdjudicationConflicts(opts.adjudication.conflicts);
    if (forbidden.length) {
      throw consumerAuthorityError('历史/恢复报告绑定的 R4.5 含已退出 authority 的 legacy semantic conflict；必须从 R4.5 重新生成，禁止 presentation-only reissue: ' +
        forbidden.map(x => x.dimension).join('; '));
    }
    if (opts.adjudication.structure_meta_override) {
      throw consumerAuthorityError('历史/恢复报告绑定的 R4.5 含 structure_meta_override；semantic-bound 下必须从 R4.5 重新生成，禁止 presentation-only reissue');
    }
  }
  try { opts.structure = PC.parseStructureJson(fs.readFileSync(st, 'utf-8')); } catch (e) { throw new Error('structure.json 解析失败: ' + e.message); }
  // C1：机械渲染补 G0——effectiveType 必须经 G0 校验，C3 面板不再降级成 0 型
  const g0 = PC.checkEffectiveType(normalized.data || {}, opts.structure, null, {
    semanticAuthorityBoundary: plan.mode === 'semantic-bound' ? 'semantic-first-v10' : null
  });
  if (g0.errors.length) {
    throw new Error('G0 门禁失败: ' + g0.errors.map(e => e.rule + ' ' + e.message).join(' | '));
  }
  opts.effectiveType = g0.effectiveType;
  // A71：source-anchor.json 会直接改变免责声明呈现，因此在 TEST semantic-bound lane 中它也是
  // same-version control view，不能继续以裸 exists-first 文件参与报告重建。正常 run 会在本轮重新
  // 抽取/确认锚点后绑定 sourceAnchor；历史 reissue 只能消费 provenance 已绑定的那份。
  const sourceAnchorLegacyPath = path.join(workDir, 'source-anchor.json');
  let sourceAnchorPath = sourceAnchorLegacyPath;
  if (plan.mode === 'semantic-bound' && fs.existsSync(sourceAnchorLegacyPath)) {
    sourceAnchorPath = consumerViewPath(workDir, plan, 'sourceAnchor', [], true);
  }
  try {
    const sa = JSON.parse(fs.readFileSync(sourceAnchorPath, 'utf-8'));
    if (sa.disclaimer === true) opts.disclaimer = true;
  } catch (e) { /* 无 source-anchor → 不触发免责 */ }
  let html = RR.renderHTML(normalized, opts);
  if (finalAuthority) html = '<!--JUDGE_FINAL_REVISION:' + finalAuthority.finalRevision + '-->\n' + html;
  fs.writeFileSync(path.join(workDir, 'report.html'), html, 'utf-8');
  return html.length;
}

// ---------- R8：独立读者章节导览（不接入管道控制器、不改写 R1—R7 产物） ----------

const READER_GUIDE_SYSTEM = '你是 R8 读者章节导览执行器。只可依据用户消息中的 guide-input 输出严格 JSON；不得补充、推断或改写任何裁决、事实、数字、主体、胜负、评分或 ID。';
const READER_GUIDE_PLAIN_REVIEW_SYSTEM = '你是 R8 章节导览白话层的独立语义复核器。按完整卡片上下文独立检查 semanticEquivalent、noJudgmentChange、factsConsistent、zeroBackgroundReadable、naturalReadable、noLocatorDependency。内部编号可以只是 locator，不要求逐个解释；但忽略编号后仍应能理解事件与判断。任何主体、胜负、事实、数字、因果、否定、限定、责任、程度或结论强度变化都必须拒绝。只输出严格 JSON。';
// R8 只允许生成独立导览派生层。以下 R1—R7 权威输入、裁决结果与白话正文必须全程逐字不变；
// report.html 仅允许在全部 R8 门禁通过后由机械 embedder 增加导览展示，因此不列入此不可变集合。
const R8_IMMUTABLE_FIXED_FILES = [
  'P1.md', 'P2.md', 'P2.5.md', 'P3.md', 'full-data.md',
  '.tmp-adjudicated-data.md', '.tmp-adjudicated-structure.json', 'transition-final.md',
  'structure.json', '叙事.md', 'adjudication.json', 'source-anchor.json',
  'report-plain.html', '.tmp-plain-review.json'
];
function r8ImmutableNames(workDir) {
  const batches = fs.existsSync(workDir)
    ? fs.readdirSync(workDir).filter(name => /^\.tmp-plain-batch-\d+\.json$/.test(name)).sort()
    : [];
  return R8_IMMUTABLE_FIXED_FILES.concat(batches);
}

function readerGuideModelSnapshot(cfg) {
  return {
    provider: String((cfg && cfg.provider) || ''),
    model: String((cfg && cfg.model) || '')
  };
}

function readerGuidePaths(workDir, opts) {
  opts = opts || {};
  const plan = resolveConsumerBinding(workDir, opts.consumerBinding || null,
    opts.consumerBinding ? ['adjudicatedData', 'adjudicatedStructure', 'narrative', 'adjudication'] : []);
  const legacyAdjudicatedData = path.join(workDir, '.tmp-adjudicated-data.md');
  const adjudicatedData = consumerViewPath(workDir, plan, 'adjudicatedData',
    ['.tmp-adjudicated-data.md'], plan.mode === 'semantic-bound');
  const transition = plan.mode === 'semantic-bound'
    ? adjudicatedData
    : (fs.existsSync(legacyAdjudicatedData) ? legacyAdjudicatedData : path.join(workDir, 'transition-final.md'));
  const structure = consumerViewPath(workDir, plan, 'adjudicatedStructure',
    ['.tmp-adjudicated-structure.json', 'structure.json'], true);
  const adjudication = consumerViewPath(workDir, plan, 'adjudication', ['adjudication.json'], false);
  const narrative = consumerViewPath(workDir, plan, 'narrative', ['叙事.md'], true);
  return {
    consumerMode: plan.mode,
    adjudicatedData,
    transition,
    structure,
    adjudication,
    narrative,
    input: path.join(workDir, 'reader-guide-input.json'),
    guide: path.join(workDir, 'reader-guide.json'),
    plain: path.join(workDir, 'reader-guide-plain.json'),
    html: path.join(workDir, 'reader-guide.html'),
    cache: path.join(workDir, '.tmp-reader-guide-cache.json'),
    draft: path.join(workDir, '.tmp-reader-guide-draft.json'),
    plainDraft: path.join(workDir, '.tmp-reader-guide-plain-draft.json')
  };
}

function checkReaderGuideContract(RG, input, guide, snapshot) {
  const check = RG.validateGuide(input, guide);
  const errors = check.errors.slice();
  if (!guide || guide.promptVersion !== RG.PROMPT_VERSION) errors.push('reader-guide promptVersion 不匹配');
  if (!guide || RG.stableJson(guide.modelSnapshot || {}) !== RG.stableJson(snapshot)) errors.push('reader-guide modelSnapshot 不匹配');
  return { ok: errors.length === 0, errors };
}

function buildReaderGuideInputFromWorkDir(workDir, RG, RR, PC, opts) {
  const files = readerGuidePaths(workDir, opts);
  if (!files.adjudicatedData || !fs.existsSync(files.transition) || !fs.existsSync(files.adjudicatedData) || !fs.existsSync(files.structure) || !fs.existsSync(files.narrative)) {
    throw new Error('缺少 R8 所需的裁决数据/transition-final/structure/叙事产物');
  }
  const adjudicatedText = fs.readFileSync(files.adjudicatedData, 'utf-8');
  const normalized = RR.normalizePhase1(
    fs.readFileSync(files.transition, 'utf-8'),
    fs.readFileSync(files.narrative, 'utf-8')
  );
  const structure = PC.parseStructureJson(fs.readFileSync(files.structure, 'utf-8'));
  let adjudication = null;
  if (fs.existsSync(files.adjudication)) {
    try { adjudication = JSON.parse(fs.readFileSync(files.adjudication, 'utf-8')); }
    catch (e) { throw new Error('adjudication.json 解析失败: ' + e.message); }
  }
  return { files, input: RG.buildGuideInput(normalized, structure, adjudication, adjudicatedText) };
}

async function buildPlainReaderGuideArtifact(workDir, cfg, input, guide, onLog, opts) {
  const RG = require('../scripts/reader-guide.js');
  opts = opts || {};
  const files = readerGuidePaths(workDir, { consumerBinding: opts.consumerBinding || null });
  const snapshot = readerGuideModelSnapshot(cfg);
  onLog = typeof onLog === 'function' ? onLog : () => {};

  if (opts.cache !== false && fs.existsSync(files.plain)) {
    try {
      const saved = JSON.parse(fs.readFileSync(files.plain, 'utf8'));
      const savedCheck = RG.validatePlainGuideReview(input, guide, saved);
      if (savedCheck.ok && RG.stableJson(saved.modelSnapshot || {}) === RG.stableJson(snapshot)) {
        onLog('[executor] R8 白话导览快照命中（原 guide / prompt / model / 复核一致）');
        return { artifact: saved, cached: true };
      }
      onLog('[executor] R8 白话导览快照失效，重新生成：' + savedCheck.errors.join('; '));
    } catch (e) {
      onLog('[executor] R8 白话导览快照不可用，重新生成：' + e.message);
    }
  }

  const units = [];
  for (const card of guide.cards || []) {
    for (const field of ['what', 'why', 'conclusion']) {
      units.push({
        id: 'R8P:' + card.sectionId + ':' + field,
        module: card.sectionId,
        blockType: 'reader-guide-' + field,
        text: card[field]
      });
    }
  }
  const PV2 = require('../scripts/plain-comprehension.js');
  annotatePlainComprehensionRequirements(units, PV2.PROFILE_GUIDE);
  const artifactFromTranslation = translated => ({
    schemaVersion: RG.PLAIN_SCHEMA_VERSION,
    sourceGuideHash: RG.hashPlainGuideSource(guide),
    promptVersion: RG.PLAIN_PROMPT_VERSION,
    modelSnapshot: snapshot,
    cards: (guide.cards || []).map(card => ({
      sectionId: card.sectionId,
      what: translated.get('R8P:' + card.sectionId + ':what'),
      why: translated.get('R8P:' + card.sectionId + ':why'),
      conclusion: translated.get('R8P:' + card.sectionId + ':conclusion')
    }))
  });
  const plainDraftKey = crypto.createHash('sha256')
    .update(RG.hashPlainGuideSource(guide) + '\u0000' + RG.PLAIN_PROMPT_VERSION + '\u0000' + RG.stableJson(snapshot))
    .digest('hex');
  const mapFromPlainDraft = draft => {
    if (!draft || draft.v !== 1 || draft.key !== plainDraftKey || !draft.results || typeof draft.results !== 'object') return null;
    const map = new Map();
    for (const unit of units) {
      if (typeof draft.results[unit.id] !== 'string') return null;
      map.set(unit.id, draft.results[unit.id]);
    }
    return map;
  };
  const writePlainDraft = (results, error) => {
    if (opts.cache === false || !(results instanceof Map)) return;
    const payload = {};
    for (const unit of units) if (typeof results.get(unit.id) === 'string') payload[unit.id] = results.get(unit.id);
    fs.writeFileSync(files.plainDraft, JSON.stringify({ v: 1, key: plainDraftKey, results: payload, error: String(error || '').slice(0, 6000) }, null, 2), 'utf8');
    if (typeof opts.onBatchCheckpoint === 'function') {
      try { opts.onBatchCheckpoint({ phase: 'r8-plain-draft', file: path.basename(files.plainDraft), workDir }); }
      catch (e) { onLog('[executor] R8 白话私有 draft checkpoint 状态回调失败（draft 已安全落盘）: ' + (e && e.message || e)); }
    }
  };

  let translated = null;
  let restoredDraft = null;
  let restoredDraftError = '';
  if (opts.cache !== false && fs.existsSync(files.plainDraft)) {
    try {
      const draft = JSON.parse(fs.readFileSync(files.plainDraft, 'utf8'));
      const restored = mapFromPlainDraft(draft);
      if (restored) {
        const restoredCandidate = artifactFromTranslation(restored);
        const restoredCheck = RG.validatePlainGuide(input, guide, restoredCandidate);
        if (restoredCheck.ok) {
          translated = restored;
          onLog('[executor] R8 白话私有 draft 经结构/事实硬门复核后通过，跳过整批重译');
        } else {
          // 跨 Job 恢复不能退回整批重译：保留当前完整候选作为冻结基底，
          // 下一步只把当前机械门精确点名的字段交给 translateUnitsLLM 定点修复。
          restoredDraft = restored;
          restoredDraftError = 'R8 白话导览结构/事实硬门失败: ' + restoredCheck.errors.join('; ');
          onLog('[executor] R8 白话私有 draft 仍未过门，冻结其余字段并从失败字段定点续跑：' + restoredCheck.errors.join('; '));
        }
      }
    } catch (e) {
      onLog('[executor] R8 白话私有 draft 不可用，重新受控生成：' + e.message);
    }
  }

  if (!translated && cfg && cfg.provider === 'mock') {
    translated = new Map(units.map(unit => [unit.id, unit.text + '（白话）']));
  } else if (!translated) {
    const dict = loadPlainDict(workDir);
    translated = await translateUnitsLLM(cfg, units, onLog, dict, {
      cacheDir: null,
      promptVersion: RG.PLAIN_PROMPT_VERSION,
      comprehensionProfile: PV2.PROFILE_GUIDE,
      requestCompletion: opts.requestCompletion,
      codexRunner: opts.codexRunner,
      postValidate: ({ results }) => {
        const candidate = artifactFromTranslation(results);
        const mechanical = RG.validatePlainGuide(input, guide, candidate);
        if (!mechanical.ok) throw new Error('R8 白话导览结构/事实硬门失败: ' + mechanical.errors.join('; '));
      },
      onFailedCandidate: ({ results, error }) => writePlainDraft(results, error),
      initialResults: restoredDraft,
      initialError: restoredDraftError
    });
  }

  let artifact = artifactFromTranslation(translated);
  let mechanical = RG.validatePlainGuide(input, guide, artifact);
  if (!mechanical.ok) throw new Error('R8 白话导览结构/事实硬门失败: ' + mechanical.errors.join('; '));
  writePlainDraft(translated, 'hard-gates-pass-awaiting-independent-review');

  const requestCompletion = opts.requestCompletion || requestCompletionNode;
  let semanticRepairs = 0;
  while (true) {
    let review;
    if (cfg && cfg.provider === 'mock' && !opts.requestCompletion) {
      review = {
        approved: true,
        cardChecks: RG.SECTION_IDS.map(sectionId => ({
          sectionId,
          semanticEquivalent: true,
          noJudgmentChange: true,
          factsConsistent: true,
          zeroBackgroundReadable: true,
          naturalReadable: true,
          noLocatorDependency: true
        }))
      };
    } else {
      const rawReview = await requestCompletion(cfg, [{ role: 'user', content: RG.buildPlainGuideReviewPrompt(guide, artifact) }], {
        system: READER_GUIDE_PLAIN_REVIEW_SYSTEM,
        codexRunner: opts.codexRunner
      });
      review = RG.parseJson(rawReview, '白话导览独立语义复核响应');
    }
    artifact.review = review;
    const finalCheck = RG.validatePlainGuideReview(input, guide, artifact);
    if (finalCheck.ok) return { artifact, cached: false };

    // 语义 reviewer 不能覆盖结构/事实硬门；若此时硬门红，立即 fail-close。
    mechanical = RG.validatePlainGuide(input, guide, artifact);
    if (!mechanical.ok) throw new Error('R8 白话导览独立复核后结构/事实硬门失败: ' + mechanical.errors.join('; '));
    const failedSections = RG.plainGuideReviewFailedSections(review);
    if (!failedSections.length) throw new Error('R8 白话导览独立语义门失败但没有可定位失败卡: ' + finalCheck.errors.join('; '));
    if (semanticRepairs >= core.MAX_RETRIES) {
      throw new Error('R8 白话导览独立语义修复预算耗尽: ' + finalCheck.errors.join('; '));
    }

    // 先把 reviewer 结果持久化进私有 draft，形成下一笔模型调用前的 durability barrier。
    writePlainDraft(translated, 'semantic-review-failed:' + failedSections.join(','));
    if (typeof opts.onBatchCheckpoint === 'function') {
      await Promise.resolve(opts.onBatchCheckpoint({ phase: 'r8-plain-review', state: 'failed', failedSections: failedSections.slice(), workDir }));
    }

    const expectedIds = failedSections.flatMap(sectionId => ['what', 'why', 'conclusion'].map(field => 'R8P:' + sectionId + ':' + field));
    const repairPrompt = RG.buildPlainGuideRepairPrompt(guide, artifact, review, failedSections);
    core.assertWithinContextLimit(repairPrompt, 'R8 plain semantic targeted repair');
    if (semanticRepairs > 0) {
      const d = core.retryDelayMs(semanticRepairs);
      onLog('[executor] R8 白话语义定点修复 ' + semanticRepairs + '/' + core.MAX_RETRIES + ' · 退避 ' + d + 'ms');
      await sleep(d);
    }
    const rawRepair = await requestCompletion(cfg, [{ role: 'user', content: repairPrompt }], {
      system: '你是 R8 白话导览定点语义修复器。只能改失败卡，保持全部事实/主体/胜负/数字/因果/否定/限定/责任/程度与结论强度。内部编号可以只是 locator，不要强迫逐码解释。只输出严格 units JSON。',
      codexRunner: opts.codexRunner
    });
    const incoming = parseTranslateJson(rawRepair, expectedIds);
    const frozen = new Map(translated);
    for (const id of expectedIds) translated.set(id, incoming.get(id));
    for (const unit of units) {
      if (!expectedIds.includes(unit.id) && translated.get(unit.id) !== frozen.get(unit.id)) {
        throw new Error('R8 白话语义定点修复越界改写冻结字段: ' + unit.id);
      }
    }
    artifact = artifactFromTranslation(translated);
    mechanical = RG.validatePlainGuide(input, guide, artifact);
    if (!mechanical.ok) throw new Error('R8 白话语义定点修复破坏结构/事实硬门: ' + mechanical.errors.join('; '));
    writePlainDraft(translated, 'semantic-repair-draft');
    if (typeof opts.onBatchCheckpoint === 'function') {
      await Promise.resolve(opts.onBatchCheckpoint({ phase: 'r8-plain-repair-draft', state: 'draft', failedSections: failedSections.slice(), workDir }));
    }
    semanticRepairs++;
  }
}

// R8-M1 深 module 的内部读取端：把磁盘快照与当前 R6 权威输入交叉验证，
// 调用方只得到已经证明可机械呈现的 guide，不能绕过 review/cache/input/html 任一证据。
function readVerifiedReaderGuideSnapshot(workDir, inputWorkDir, opts) {
  opts = opts || {};
  const RG = require('../scripts/reader-guide.js');
  const RR = require('../render-report.js');
  const PC = require('../pipeline-controller.js');
  const snapshotDir = workDir;
  const sourceDir = inputWorkDir || workDir;
  const files = readerGuidePaths(snapshotDir, { consumerBinding: opts.consumerBinding || null });
  const errors = [];
  let savedInput, guide, plainGuide, cache, html;
  try { savedInput = JSON.parse(fs.readFileSync(files.input, 'utf8')); }
  catch (e) { errors.push('reader-guide-input.json 不可解析: ' + e.message); }
  try { guide = JSON.parse(fs.readFileSync(files.guide, 'utf8')); }
  catch (e) { errors.push('reader-guide.json 不可解析: ' + e.message); }
  try { plainGuide = JSON.parse(fs.readFileSync(files.plain, 'utf8')); }
  catch (e) { errors.push('reader-guide-plain.json 不可解析: ' + e.message); }
  try { cache = JSON.parse(fs.readFileSync(files.cache, 'utf8')); }
  catch (e) { errors.push('.tmp-reader-guide-cache.json 不可解析: ' + e.message); }
  try { html = fs.readFileSync(files.html, 'utf8'); }
  catch (e) { errors.push('reader-guide.html 不可读取: ' + e.message); }
  let rebuilt;
  try { rebuilt = buildReaderGuideInputFromWorkDir(sourceDir, RG, RR, PC, { consumerBinding: opts.consumerBinding || null }).input; }
  catch (e) { errors.push(e.message); }
  if (savedInput && rebuilt && RG.stableJson(savedInput) !== RG.stableJson(rebuilt)) errors.push('保存的 reader-guide-input 与当前 R6 权威输入不一致');
  const input = rebuilt || savedInput;
  const modelSnapshot = guide && guide.modelSnapshot;
  if (input && guide) {
    const guideCheck = checkReaderGuideContract(RG, input, guide, modelSnapshot);
    errors.push(...guideCheck.errors);
  }
  const inputHash = input && RG.hashGuideInput(input);
  if (!cache || cache.inputHash !== inputHash) errors.push('R8 cache inputHash 不匹配');
  if (!cache || cache.key !== RG.cacheKey(input, modelSnapshot || {})) errors.push('R8 cache key 不匹配');
  if (!cache || cache.reviewPromptVersion !== RG.REVIEW_PROMPT_VERSION) errors.push('R8 cache reviewPromptVersion 不匹配');
  if (!cache || RG.stableJson(cache.guide || {}) !== RG.stableJson(guide || {})) errors.push('R8 cache guide 与保存 guide 不一致');
  if (input && guide) {
    const reviewCheck = RG.validateReview(input, guide, cache && cache.review);
    errors.push(...reviewCheck.errors);
    if (plainGuide) {
      const plainCheck = RG.validatePlainGuideReview(input, guide, plainGuide);
      errors.push(...plainCheck.errors);
    }
  }
  if (guide && html !== RR.renderReaderGuide(guide)) errors.push('reader-guide.html 与已验证 guide 的纯渲染结果不一致');
  if (errors.length) throw new Error('[executor] R8 主报告嵌入快照验证失败: ' + errors.join('; '));
  return { input, guide, plainGuide, review: cache.review, inputHash, cacheKey: cache.key };
}

// R8-M1 public seam：只读四件已验证 R8 快照，纯机械写入原文主报告；
// interface 故意没有 cfg/provider/model/requestCompletion/codexRunner，不能触及模型路径。
function embedVerifiedReaderGuide(workDir, opts) {
  opts = opts || {};
  const RR = require('../render-report.js');
  const snapshot = readVerifiedReaderGuideSnapshot(workDir, null, { consumerBinding: opts.consumerBinding || null });
  const plan = resolveConsumerBinding(workDir, opts.consumerBinding || null, opts.consumerBinding ? ['report'] : []);
  const reportPath = consumerViewPath(workDir, plan, 'report', ['report.html'], true);
  if (!reportPath || !fs.existsSync(reportPath)) throw new Error('[executor] R8 主报告嵌入缺少 bound report.html');
  const reportHtml = fs.readFileSync(reportPath, 'utf8');
  const migratedRuntime = RR.migratePlainToggleRuntime(reportHtml);
  const embedded = RR.embedReaderGuideIntoReport(migratedRuntime, snapshot.guide, snapshot.plainGuide);
  fs.writeFileSync(reportPath, embedded, 'utf8');
  return { inputHash: snapshot.inputHash, cacheKey: snapshot.cacheKey, reportPath };
}

// R8 adapter public seam：仅以 workDir 已存在的 R4/R4.5/R6 结构化产物为输入，
// 经生成+独立复核后，才落 reader-guide-input/json/html 三个独立文件。
async function applyReaderGuide(workDir, cfg, onLog, opts) {
  const RG = require('../scripts/reader-guide.js');
  const RR = require('../render-report.js');
  const PC = require('../pipeline-controller.js');
  opts = opts || {};
  onLog = typeof onLog === 'function' ? onLog : () => {};
  const immutableBefore = fingerprintOptionalFiles(workDir, r8ImmutableNames(workDir));
  const presentationSnapshot = snapshotTextFiles(workDir, [
    'report.html', 'reader-guide-input.json', 'reader-guide.json', 'reader-guide-plain.json', 'reader-guide.html'
  ]);
  try {
    const prepared = buildReaderGuideInputFromWorkDir(workDir, RG, RR, PC, { consumerBinding: opts.consumerBinding || null });
    const files = prepared.files;
    const input = prepared.input;
    const snapshot = readerGuideModelSnapshot(cfg);
    const inputHash = RG.hashGuideInput(input);
    const key = RG.cacheKey(input, snapshot);
    let guide = null;
    let review = null;
    let cached = false;

    if (opts.cache !== false && fs.existsSync(files.cache)) {
      try {
        const saved = JSON.parse(fs.readFileSync(files.cache, 'utf-8'));
        if (saved && saved.key === key && saved.inputHash === inputHash &&
            saved.reviewPromptVersion === RG.REVIEW_PROMPT_VERSION) {
          const guideCheck = checkReaderGuideContract(RG, input, saved.guide, snapshot);
          const reviewCheck = RG.validateReview(input, saved.guide, saved.review);
          if (reviewCheck.upstreamIssues && reviewCheck.upstreamIssues.length) {
            fs.writeFileSync(path.join(workDir, '.tmp-reader-guide-review.json'), JSON.stringify({
              inputHash, guide: saved.guide, review: saved.review,
              reviewPromptVersion: RG.REVIEW_PROMPT_VERSION,
              disposition: 'upstream_review',
              reopenNode: reviewCheck.reopenNodes[0] || null,
              reopenNodes: reviewCheck.reopenNodes || []
            }, null, 2), 'utf-8');
            const upstreamError = new Error('R8 缓存中存在未处理的上游语义异议；保留原异议，不重新求批准，不在导览层改判');
            upstreamError.code = 'R8_UPSTREAM_REVIEW';
            upstreamError.review = saved.review;
            throw upstreamError;
          }
          if (guideCheck.ok && reviewCheck.ok) {
            guide = saved.guide;
            review = saved.review;
            cached = true;
            onLog('[executor] R8 章节导览缓存命中（输入/提示/模型/契约一致）');
          } else {
            onLog('[executor] R8 章节导览缓存失效，重新生成：' + guideCheck.errors.concat(reviewCheck.errors).join('; '));
          }
        }
      } catch (e) {
        if (e && e.code === 'R8_UPSTREAM_REVIEW') throw e;
        onLog('[executor] R8 章节导览缓存不可用，重新生成：' + e.message);
      }
    }

    let guideCheck = guide ? checkReaderGuideContract(RG, input, guide, snapshot) : null;

    // 私有 draft 只保存原导览候选，不代表 R8 完成。进程中断或机械门失败后可从候选继续定点修复，避免整卡重生。
    if (!guide && opts.cache !== false && fs.existsSync(files.draft)) {
      try {
        const savedDraft = JSON.parse(fs.readFileSync(files.draft, 'utf-8'));
        if (savedDraft && savedDraft.v === 1 && savedDraft.key === key && savedDraft.inputHash === inputHash && savedDraft.guide) {
          guide = savedDraft.guide;
          guideCheck = checkReaderGuideContract(RG, input, guide, snapshot);
          onLog('[executor] R8 检测到私有导览 draft，继续' + (guideCheck.ok ? '独立复核' : '定点修复') + '，不重生已保存候选');
        }
      } catch (e) {
        onLog('[executor] R8 私有导览 draft 不可用，回到受控生成：' + e.message);
      }
    }

    const requestCompletion = opts.requestCompletion || requestCompletionNode;
    if (!guide || !guideCheck || !guideCheck.ok) {
      let lastGuideError = null;
      for (let attempt = 0; attempt <= core.MAX_RETRIES; attempt++) {
        if (attempt > 0) {
          const d = core.retryDelayMs(attempt);
          onLog('[executor] R8 原导览机械门纠错 ' + attempt + '/' + core.MAX_RETRIES + ' · 退避 ' + d + 'ms');
          await sleep(d);
        }
        try {
          const repairIds = guide && guideCheck && !guideCheck.ok ? RG.guideRepairSectionIds(guideCheck.errors, guide) : [];
          if (guide && repairIds.length) {
            const rawRepair = await requestCompletion(cfg, [{ role: 'user', content: RG.buildGuideRepairPrompt(input, guide, guideCheck.errors, repairIds) }], {
              system: READER_GUIDE_SYSTEM,
              codexRunner: opts.codexRunner
            });
            const parsedRepair = RG.parseJson(rawRepair, '导览定点修复响应');
            const repairCards = parsedRepair && Array.isArray(parsedRepair.cards) ? parsedRepair.cards : [];
            const repairCardIds = repairCards.map(card => card && card.sectionId);
            if (repairCardIds.length !== repairIds.length || new Set(repairCardIds).size !== repairIds.length || repairIds.some(id => !repairCardIds.includes(id))) {
              throw new Error('定点修复响应章节集合必须恰为: ' + repairIds.join(','));
            }
            const nextGuide = JSON.parse(JSON.stringify(guide));
            const byId = new Map(repairCards.map(card => [card.sectionId, card]));
            const frozenBefore = new Map((guide.cards || []).filter(card => !repairIds.includes(card.sectionId)).map(card => [card.sectionId, RG.stableJson(card)]));
            for (let i = 0; i < nextGuide.cards.length; i++) {
              const replacement = byId.get(nextGuide.cards[i].sectionId);
              if (replacement) nextGuide.cards[i] = replacement;
            }
            for (const card of nextGuide.cards || []) {
              if (!repairIds.includes(card.sectionId) && frozenBefore.get(card.sectionId) !== RG.stableJson(card)) {
                throw new Error('定点修复越界修改未点名章节: ' + card.sectionId);
              }
            }
            guide = nextGuide;
          } else {
            let prompt = RG.buildGuidePrompt(input, snapshot);
            if (guideCheck && guideCheck.errors && guideCheck.errors.length) {
              prompt += '\n\n上一版候选未通过机械门；本次必须纠正以下错误，所有原门禁继续生效：\n- ' + guideCheck.errors.join('\n- ');
            }
            const rawGuide = await requestCompletion(cfg, [{ role: 'user', content: prompt }], {
              system: READER_GUIDE_SYSTEM,
              codexRunner: opts.codexRunner
            });
            guide = RG.parseJson(rawGuide, '导览生成响应');
          }
          guideCheck = checkReaderGuideContract(RG, input, guide, snapshot);
          if (opts.cache !== false) {
            fs.writeFileSync(files.draft, JSON.stringify({ v: 1, key, inputHash, guide, errors: guideCheck.errors || [] }, null, 2), 'utf-8');
            if (typeof opts.onBatchCheckpoint === 'function') {
              try { opts.onBatchCheckpoint({ phase: 'r8-guide-draft', file: path.basename(files.draft), workDir }); }
              catch (e) { onLog('[executor] R8 原导览私有 draft checkpoint 状态回调失败（draft 已安全落盘）: ' + (e && e.message || e)); }
            }
          }
          if (guideCheck.ok) { lastGuideError = null; break; }
          lastGuideError = new Error('生成门禁失败: ' + guideCheck.errors.join('; '));
        } catch (e) {
          lastGuideError = e;
        }
        if (attempt === core.MAX_RETRIES) break;
      }
      if (!guideCheck || !guideCheck.ok) {
        throw new Error('生成门禁纠错预算耗尽: ' + (lastGuideError && lastGuideError.message ? lastGuideError.message : '未知错误'));
      }
    }

    // A prior build may have persisted a fully explicit reviewer result as classification_pending
    // solely because its free-text keys were not recognized. Reclassify that exact same
    // inputHash + guide locally before spending another reviewer call. This never guesses a
    // target round: action/targetRound must already be explicit in the saved review.
    const pendingReviewJournalPath = path.join(workDir, '.tmp-reader-guide-review.json');
    if (!review && guide && guideCheck && guideCheck.ok && opts.cache !== false && fs.existsSync(pendingReviewJournalPath)) {
      try {
        const pendingJournal = JSON.parse(fs.readFileSync(pendingReviewJournalPath, 'utf8'));
        if (pendingJournal && pendingJournal.disposition === 'classification_pending' &&
            pendingJournal.classificationPending === true &&
            pendingJournal.reviewPromptVersion === RG.REVIEW_PROMPT_VERSION &&
            pendingJournal.inputHash === inputHash && pendingJournal.review &&
            RG.stableJson(pendingJournal.guide || {}) === RG.stableJson(guide)) {
          const reclassified = RG.validateReview(input, guide, pendingJournal.review);
          if (!reclassified.needsClarification) {
            if (reclassified.upstreamIssues && reclassified.upstreamIssues.length) {
              const promotedJournal = {
                inputHash,
                guide,
                review: pendingJournal.review,
                reviewPromptVersion: RG.REVIEW_PROMPT_VERSION,
                disposition: 'upstream_review',
                classificationPending: false,
                reopenNode: reclassified.reopenNodes[0] || null,
                reopenNodes: reclassified.reopenNodes || []
              };
              fs.writeFileSync(pendingReviewJournalPath, JSON.stringify(promotedJournal, null, 2), 'utf8');
              if (typeof opts.onBatchCheckpoint === 'function') {
                try { await Promise.resolve(opts.onBatchCheckpoint({ phase: 'r8-upstream-review', workDir, reopenNodes: (reclassified.reopenNodes || []).slice() })); }
                catch (checkpointError) { onLog('[executor] R8 旧复核零模型重分类 checkpoint 回调失败（异议已安全落盘）: ' + (checkpointError && checkpointError.message || checkpointError)); }
              }
              onLog('[executor] R8 已将旧 classification_pending review 零模型重分类为 upstream_review：' + (reclassified.reopenNodes || []).join('、'));
              const upstreamError = new Error('R8 已有复核明确要求上游语义回查 ' + (reclassified.reopenNodes || []).join('、') + '；复用既有 review，不重复调用模型');
              upstreamError.code = 'R8_UPSTREAM_REVIEW';
              upstreamError.review = pendingJournal.review;
              upstreamError.reopenNode = reclassified.reopenNodes[0] || null;
              upstreamError.reopenNodes = (reclassified.reopenNodes || []).slice();
              throw upstreamError;
            }
            if (reclassified.ok) {
              review = pendingJournal.review;
              onLog('[executor] R8 已将旧 classification_pending review 零模型重分类为可接受结果，不重复调用模型');
            }
          }
        }
      } catch (e) {
        if (e && e.code === 'R8_UPSTREAM_REVIEW') throw e;
        onLog('[executor] R8 旧 classification_pending review 不可零模型复用：' + (e && e.message || e));
      }
    }

    if (!review) {
      let reviewCheck = null;
      let lastReviewError = null;
      let reviewStopReason = null;
      for (let attempt = 0; attempt <= core.MAX_RETRIES; attempt++) {
        if (attempt > 0) {
          const d = core.retryDelayMs(attempt);
          onLog('[executor] R8 独立复核纠错 ' + attempt + '/' + core.MAX_RETRIES + ' · 退避 ' + d + 'ms');
          await sleep(d);
        }
        let semanticRejected = false;
        try {
          let reviewPrompt = RG.buildReviewPrompt(input, guide);
          if (reviewCheck && reviewCheck.errors && reviewCheck.errors.length) {
            reviewPrompt += reviewCheck.needsClarification
              ? '\n\n上一版复核提出了异议但没有完整说明 note / upstream_review 与责任轮。保留已有实质判断，只补齐分类，不要为了通过而撤销异议：\n- ' + reviewCheck.errors.join('\n- ') + '\n上一版复核：\n' + JSON.stringify(review)
              : '\n\n上一版复核尚不能执行。保留已有实质判断，并处理已指出的问题；不要对未修改候选反复投赞成票：\n- ' + reviewCheck.errors.join('\n- ') + '\n上一版复核：\n' + JSON.stringify(review);
          }
          const rawReview = await requestCompletion(cfg, [{ role: 'user', content: reviewPrompt }], {
            system: READER_GUIDE_SYSTEM,
            codexRunner: opts.codexRunner
          });
          review = RG.parseJson(rawReview, '独立复核响应');
          reviewCheck = RG.validateReview(input, guide, review);
          if (reviewCheck.upstreamIssues && reviewCheck.upstreamIssues.length) {
            fs.writeFileSync(path.join(workDir, '.tmp-reader-guide-review.json'), JSON.stringify({
              inputHash, guide, review,
              reviewPromptVersion: RG.REVIEW_PROMPT_VERSION,
              disposition: 'upstream_review',
              reopenNode: reviewCheck.reopenNodes[0] || null,
              reopenNodes: reviewCheck.reopenNodes || []
            }, null, 2), 'utf-8');
            if (typeof opts.onBatchCheckpoint === 'function') {
              try { await Promise.resolve(opts.onBatchCheckpoint({ phase: 'r8-upstream-review', workDir, reopenNodes: (reviewCheck.reopenNodes || []).slice() })); }
              catch (checkpointError) { onLog('[executor] R8 上游异议 checkpoint 回调失败（异议已安全落盘）: ' + (checkpointError && checkpointError.message || checkpointError)); }
            }
            const upstreamError = new Error('R8 发现上游语义问题，需回查 ' + (reviewCheck.reopenNodes || []).join('、') + '；已保留异议，不在导览层改判');
            upstreamError.code = 'R8_UPSTREAM_REVIEW';
            upstreamError.review = review;
            upstreamError.reopenNodes = (reviewCheck.reopenNodes || []).slice();
            throw upstreamError;
          }
          if (reviewCheck.ok) {
            lastReviewError = null;
            break;
          }
          lastReviewError = new Error('独立复核未通过: ' + reviewCheck.errors.join('; '));
          if (reviewCheck.needsClarification) {
            fs.writeFileSync(path.join(workDir, '.tmp-reader-guide-review.json'), JSON.stringify({
              inputHash, guide, review, reviewPromptVersion: RG.REVIEW_PROMPT_VERSION, disposition: 'classification_pending', classificationPending: true, reopenNode: null, reopenNodes: []
            }, null, 2), 'utf-8');
            if (attempt === core.MAX_RETRIES) reviewStopReason = '异议影响与责任尚未说明';
            continue;
          }
          const failedCards = (review.cardChecks || [])
            .filter(c => c && (c.noNewJudgment !== true || c.factsConsistent !== true || c.anchorsConsistent !== true))
            .map(c => c.sectionId)
            .filter(id => RG.SECTION_IDS.includes(id));
          semanticRejected = review.approved === false || failedCards.length > 0;
          if (semanticRejected) {
            fs.writeFileSync(path.join(workDir, '.tmp-reader-guide-review.json'), JSON.stringify({
              inputHash, guide, review, reviewPromptVersion: RG.REVIEW_PROMPT_VERSION, disposition: 'guide_semantic_repair', reopenNode: 'R8', reopenNodes: ['R8']
            }, null, 2), 'utf-8');
            reviewStopReason = '导览语义复核未通过';
            if (failedCards.length && attempt < core.MAX_RETRIES) {
              const repairPrompt = RG.buildGuideRepairPrompt(
                input,
                guide,
                ['独立语义复核意见：' + JSON.stringify(Object.assign({}, review, {
                  cardChecks: (review.cardChecks || []).filter(c => failedCards.includes(c.sectionId))
                }))],
                failedCards
              );
              core.assertWithinContextLimit(repairPrompt, 'R8 semantic targeted guide repair');
              const rawRepair = await requestCompletion(cfg, [{ role: 'user', content: repairPrompt }], {
                system: READER_GUIDE_SYSTEM,
                codexRunner: opts.codexRunner
              });
              const repair = RG.parseJson(rawRepair, '导览语义定点修复响应');
              const cards = repair && repair.cards;
              if (!Array.isArray(cards) || cards.length !== failedCards.length ||
                  new Set(cards.map(c => c && c.sectionId)).size !== failedCards.length ||
                  cards.some(c => !c || !failedCards.includes(c.sectionId))) {
                throw new Error('导览语义修复必须恰好覆盖失败卡: ' + failedCards.join(','));
              }
              const byId = new Map(cards.map(c => [c.sectionId, c]));
              const frozenBefore = new Map((guide.cards || []).filter(c => !failedCards.includes(c.sectionId)).map(c => [c.sectionId, RG.stableJson(c)]));
              guide = Object.assign({}, guide, { cards: (guide.cards || []).map(c => byId.get(c.sectionId) || c) });
              for (const card of guide.cards || []) {
                if (!failedCards.includes(card.sectionId) && frozenBefore.get(card.sectionId) !== RG.stableJson(card)) {
                  throw new Error('导览语义修复越权改写冻结卡: ' + card.sectionId);
                }
              }
              guideCheck = checkReaderGuideContract(RG, input, guide, snapshot);
              fs.writeFileSync(files.draft, JSON.stringify({ v: 1, key, inputHash, guide, errors: guideCheck.errors || [] }, null, 2), 'utf-8');
              if (!guideCheck.ok) {
                lastReviewError = new Error('导览语义修复后机械门失败: ' + guideCheck.errors.join('; '));
                break;
              }
              continue;
            }
            break;
          }
        } catch (e) {
          if (e && e.code === 'R8_UPSTREAM_REVIEW') throw e;
          lastReviewError = e;
          if (semanticRejected) break;
        }
        if (attempt === core.MAX_RETRIES) break;
      }
      if (!reviewCheck || !reviewCheck.ok) {
        throw new Error((reviewStopReason || '独立复核纠错预算耗尽') + ': ' + (lastReviewError && lastReviewError.message ? lastReviewError.message : '未知错误'));
      }
    }

    const acceptedReview = RG.validateReview(input, guide, review);
    for (const note of acceptedReview.notes || []) {
      onLog('[executor] R8 复核备注（模型判为不阻断）：' + RG.semanticIssueText(note));
    }
    const reviewJournalPath = path.join(workDir, '.tmp-reader-guide-review.json');
    const acceptedJournal = JSON.stringify({
      inputHash, guide, review, reviewPromptVersion: RG.REVIEW_PROMPT_VERSION, reopenNode: null, reopenNodes: [],
      disposition: (acceptedReview.notes || []).length ? 'accepted_with_notes' : 'accepted'
    }, null, 2);
    if (fs.existsSync(reviewJournalPath)) {
      const previousReview = fs.readFileSync(reviewJournalPath, 'utf8');
      if (previousReview !== acceptedJournal) {
        fs.writeFileSync(reviewJournalPath + '.previous-' + Date.now(), previousReview, 'utf8');
      }
    }
    fs.writeFileSync(reviewJournalPath, acceptedJournal, 'utf8');

    // 原导览 + 独立复核一旦通过，先保存私有 checkpoint；若后续白话失败，重跑可复用前两次已验证 LLM 结果。
    // 这里只写 .tmp cache，不写任何公共 reader-guide 产物，也不改 report.html，因此不把半完成 R8 冒充完成态。
    if (!cached) {
      fs.writeFileSync(files.cache, JSON.stringify({ key, inputHash, guide, review, reviewPromptVersion: RG.REVIEW_PROMPT_VERSION }, null, 2), 'utf-8');
      if (fs.existsSync(files.draft)) fs.rmSync(files.draft, { force: true });
      if (typeof opts.onBatchCheckpoint === 'function') {
        try { opts.onBatchCheckpoint({ phase: 'r8-core-cache', file: path.basename(files.cache), workDir }); }
        catch (e) { onLog('[executor] R8 原导览复核 cache checkpoint 状态回调失败（cache 已安全落盘）: ' + (e && e.message || e)); }
      }
    }

    const plainBuilt = await buildPlainReaderGuideArtifact(workDir, cfg, input, guide, onLog, opts);
    const plainGuide = plainBuilt.artifact;
    const html = RR.renderReaderGuide(guide);
    // 公共产物与主报告仍须等原导览、独立复核、白话导览、白话独立复核全部通过后才提交。
    fs.writeFileSync(files.input, JSON.stringify(input, null, 2), 'utf-8');
    fs.writeFileSync(files.guide, JSON.stringify(guide, null, 2), 'utf-8');
    fs.writeFileSync(files.plain, JSON.stringify(plainGuide, null, 2), 'utf-8');
    fs.writeFileSync(files.html, html, 'utf-8');
    const embedded = embedVerifiedReaderGuide(workDir, { consumerBinding: opts.consumerBinding || null });
    const nextConsumerBinding = opts.consumerBinding
      ? consumerBindingFromProducedViews(workDir, opts.consumerBinding, {
          report: path.relative(workDir, embedded.reportPath),
          readerGuideInput: path.relative(workDir, files.input),
          readerGuide: path.relative(workDir, files.guide),
          readerGuidePlain: path.relative(workDir, files.plain),
          readerGuideHtml: path.relative(workDir, files.html)
        })
      : null;
    if (fs.existsSync(files.plainDraft)) fs.rmSync(files.plainDraft, { force: true });
    assertSameFingerprints('R8 不得改写 R1—R7 权威输入/裁决/白话正文', immutableBefore, fingerprintOptionalFiles(workDir, r8ImmutableNames(workDir)));
    onLog('[executor] R8 章节导览完成：reader-guide-input.json + reader-guide.json + reader-guide-plain.json + reader-guide.html + report.html 机械嵌入' + (cached ? '（原导览缓存）' : '') + (plainBuilt.cached ? '（白话缓存）' : ''));
    return { cached, plainCached: plainBuilt.cached, inputHash, cacheKey: key, files: [files.input, files.guide, files.plain, files.html, embedded.reportPath], consumerBinding: nextConsumerBinding };
  } catch (e) {
    try { restoreTextFiles(workDir, presentationSnapshot); }
    catch (restoreError) {
      throw new Error('[executor] R8 章节导览失败且 presentation 回滚失败: ' + (restoreError && restoreError.message ? restoreError.message : String(restoreError)) + '；原错误=' + (e && e.message ? e.message : String(e)));
    }
    try {
      assertSameFingerprints('R8 失败态不得改写 R1—R7 权威输入/裁决/白话正文', immutableBefore, fingerprintOptionalFiles(workDir, r8ImmutableNames(workDir)));
    } catch (immutabilityError) {
      throw new Error('[executor] R8 章节导览失败且检测到上游权威产物漂移: ' + (immutabilityError && immutabilityError.message ? immutabilityError.message : String(immutabilityError)) + '；原错误=' + (e && e.message ? e.message : String(e)));
    }
    const wrapped = new Error('[executor] R8 章节导览失败: ' + (e && e.message ? e.message : String(e)));
    // Preserve semantic upstream-review authority metadata across presentation rollback wrapping.
    // The journal remains the durable source of truth; these fields prevent callers/logs from
    // collapsing a semantic reopen requirement into an ordinary R8 presentation failure.
    if (e && e.code === 'R8_UPSTREAM_REVIEW') {
      wrapped.code = e.code;
      wrapped.reopenNode = e.reopenNode || (Array.isArray(e.reopenNodes) && e.reopenNodes[0]) || null;
      wrapped.reopenNodes = Array.isArray(e.reopenNodes) ? e.reopenNodes.slice() : [];
    }
    throw wrapped;
  }
}

// ---------- R7 阶段 2：白话化（LLM 翻译 + 双版本合并 + 外部门禁） ----------

const TRANSLATE_SYSTEM = '你是辩论裁判报告的 PLAIN 语义白话生成器。你的职责是生成候选 draft，不负责给自己判定“已经足够易懂”。硬性规则：1. 不新增、不删除、不改变任何主体、判断、结论、事实、数据、因果、否定、条件、责任、程度与逻辑；2. 明确数字、比分以及证据定位 ID（N#、M-ID、CP-ID、S# 等）必须原样、原次数保留；辩手名、辩题名、专名、章节标题、证据回引不得被篡改；3. B0/B\'/B\'\'/SC/Phase/Q/Lv/场C 等框架标签属于语义概念，不要求原样或原次数保留，可以结合本场上下文自然解释、复述、改写或省略标签本身，但其所指概念、阶段关系和论证作用不能改变；4. 术语表只是认知提示，不是翻译表或答案键；必须先理解该术语在本场具体指什么，再决定如何自然表达，不得机械强塞“术语（固定释义）”；5. locator 本身不是读者必须学习的知识；如果邻接上下文已经把事件/判断说清，不要求逐个解释；6. 每个 DOM 文本单元仍独立回填，但阅读语义会由后续独立 reviewer 在完整有序上下文中判断；7. 输出必须是合法 JSON：{"units":[{"id":"...","text":"改写后文本"}]}，覆盖全部输入 id，禁止额外文字。';
const TRANSLATE_GUIDE_SYSTEM = '你是辩论裁判报告的 PLAIN 零背景章节导览生成器。保持原导览主体、胜负、事实、数字、因果方向、否定、条件、责任、程度和结论强度不变。术语表只是帮助理解的候选语义，不是标准译文或答案键；必须先结合本场上下文理解，再自然解释。N/M/CP/S 等证据定位 ID 必须原样、原次数保留；B0/B\'/B\'\'/SC/Phase/Q/Lv/场C 等框架标签不要求原样或原次数保留，只要其所指概念、阶段关系和论证作用保持不变。locator 本身不是读者必须学习的知识：同卡上下文已经把事件和判断说清时，不要求逐个解释。输出只负责候选 draft，最终 semanticEquivalent/zeroBackgroundReadable/naturalReadable/noLocatorDependency 由独立 reviewer 判断。只输出覆盖全部输入 id 的合法 JSON。';

// R7 阶段 3：核心字典（内嵌 PLAIN_DICT）＋可选外部扩展字典（--plain-dict，覆盖核心）
function loadPlainDict(workDir, extraPath) {
  // 核心词典随执行器交付，而 workDir 是每场输出目录；不得把二者混为一谈。
  const corePath = path.join(__dirname, '..', 'assets', 'plain-dict.json');
  let dict = {};
  if (fs.existsSync(corePath)) {
    try {
      dict = JSON.parse(fs.readFileSync(corePath, 'utf8'));
    } catch (e) {
      throw new Error('[executor] plain-dict.json 解析失败: ' + e.message);
    }
  }
  if (extraPath) {
    if (!fs.existsSync(extraPath)) throw new Error('[executor] --plain-dict 文件不存在: ' + extraPath);
    // 批 4（260812）：外部扩展字典损坏 → 明确报错（含文件路径；用户配置错误不静默、不遮蔽）
    const extRaw = fs.readFileSync(extraPath, 'utf8');
    let ext;
    try { ext = JSON.parse(extRaw); }
    catch (e) { throw new Error('[executor] 外部白话字典 ' + extraPath + ' 解析失败: ' + e.message + '（检查 --plain-dict 文件格式）'); }
    dict = Object.assign({}, dict, ext);
  }
  return dict;
}

// 翻译响应 → Map<id,text>：容错代码围栏/前后杂文本，校验 id 全覆盖
function parseTranslateJson(raw, ids) {
  let s = String(raw || '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  const j = JSON.parse(s);
  const arr = Array.isArray(j) ? j : (j.units || j.results || []);
  if (!Array.isArray(arr)) throw new Error('翻译响应无 units 数组');
  const m = new Map();
  for (const it of arr) {
    if (it && it.id && typeof it.text === 'string') m.set(String(it.id), it.text);
  }
  const missing = ids.filter(id => !m.has(id));
  if (missing.length) throw new Error('翻译响应缺失 ' + missing.length + ' 个单元（' + missing.slice(0, 5).join(',') + '）');
  return m;
}

// S5：白话批断点缓存（审计 #9）——缓存格式版本常量；批次内容/首次术语要求/字典任一变化即失效
const PLAIN_CACHE_VERSION = 4;
const PLAIN_CACHE_PREFIX = '.tmp-plain-batch-';
const PLAIN_PROMPT_VERSION = 'r7-plain-v4';
const PLAIN_REVIEW_FILE = '.tmp-plain-review.json';
// A4 是冻结的旧无模型刷新合同，永远只认历史 v3/r7-plain-v2，不参与 live 语义权威。
const LEGACY_PLAIN_CACHE_VERSION = 3;
const LEGACY_PLAIN_PROMPT_VERSION = 'r7-plain-v2';
const PLAIN_REFRESH_TRANSACTION = '.tmp-plain-refresh-transaction.json';
const PLAIN_REFRESH_BATCHES = 14;
const PLAIN_REFRESH_OUTPUTS = ['report.html', 'report-plain.html'].concat(
  Array.from({ length: PLAIN_REFRESH_BATCHES }, (_, i) => PLAIN_CACHE_PREFIX + i + '.json')
);
const PLAIN_REFRESH_R6_INPUTS = [
  '.tmp-adjudicated-data.md', '.tmp-adjudicated-structure.json', 'transition-final.md',
  'structure.json', '叙事.md', 'adjudication.json', 'source-anchor.json'
];
const PLAIN_REFRESH_R8_OUTPUTS = ['reader-guide-input.json', 'reader-guide.json', 'reader-guide-plain.json', 'reader-guide.html', '.tmp-reader-guide-cache.json'];

function chunkHashOf(chunk) {
  return crypto.createHash('sha256')
    // Cache identity binds legacy template metadata and live semantic-hint metadata; any prompt-relevant change invalidates the cache.
    .update(chunk.map(it => it.id + '\u0000' + it.text + '\u0000' +
      (it.requiredGlosses || []).map(r => r.term + '\u0000' + r.gloss).join('\u0001') + '\u0000' +
      JSON.stringify(it.comprehensionRequirements || [])).join('\u0002'))
    .digest('hex').slice(0, 16);
}

function dictHashOf(dict) {
  const keys = Object.keys(dict || {}).sort();
  const body = keys.map(k => k + '\u0000' + dict[k]).join('\u0001');
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 16);
}

function annotatePlainComprehensionRequirements(units, profile) {
  const PV2 = require('../scripts/plain-comprehension.js');
  const rows = PV2.requirementsForUnits(units || [], { profile: profile || PV2.PROFILE_BODY });
  const byId = new Map(rows.map(row => [row.unitId, row.requirements || []]));
  for (const u of units || []) u.comprehensionRequirements = byId.get(u.id) || [];
  return rows;
}

function plainComprehensionTerms(item) {
  const out = [];
  for (const req of item && item.comprehensionRequirements || []) {
    if (req && req.term) out.push(req.term);
  }
  return out;
}

function checkPlainComprehensionItems(items, textForItem, profile) {
  const PV2 = require('../scripts/plain-comprehension.js');
  const issues = [];
  for (const item of items || []) {
    const result = PV2.inspectPlainText(item.text, textForItem(item.id), {
      profile: profile || PV2.PROFILE_BODY,
      requiredConcepts: plainComprehensionTerms(item)
    });
    if (!result.ok) issues.push({ id: item.id, issues: result.issues });
  }
  return { ok: issues.length === 0, issues };
}

function plainCacheItems(units) {
  return (units || []).map(u => ({
    id: u.id,
    context: (u.module ? u.module + ' · ' : '') + (u.blockType || 'block'),
    text: u.text,
    requiredGlosses: Array.isArray(u.requiredGlosses) ? u.requiredGlosses : [],
    comprehensionRequirements: Array.isArray(u.comprehensionRequirements) ? u.comprehensionRequirements : []
  }));
}

function splitPlainCacheChunks(units) {
  const items = plainCacheItems(units);
  const chunks = [];
  let cur = [];
  let curChars = 0;
  for (const item of items) {
    if (cur.length >= 40 || (curChars + item.text.length > 6000 && cur.length)) {
      chunks.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(item);
    curChars += item.text.length;
  }
  if (cur.length) chunks.push(cur);
  return chunks;
}

// A4-P1a legacy cache-only compatibility: rebuild the historical first-seen glossary metadata exactly.
// Live v4 does not treat this metadata as semantic approval authority.
function plainCacheInputsFromHtml(html, dict) {
  const PL = require('../scripts/plain-language.js');
  const all = PL.extractUnits(PL.parseHtml(html));
  const translatable = all.filter(u => PL.classifyUnit(u) === 'translate');
  for (const unit of translatable) unit.dictHints = PL.dictHintsForText(unit.text, dict);
  PL.annotateSemanticRequirements(translatable, dict, { legacyFixed: true });
  annotatePlainComprehensionRequirements(translatable, require('../scripts/plain-comprehension.js').PROFILE_BODY);
  return { all, translatable, chunks: splitPlainCacheChunks(translatable) };
}

function assertEqualPlainSignatures(label, actual, expected) {
  if (actual.length !== expected.length) {
    throw new Error('[executor] A4-P1a ' + label + ' 数量不一致: ' + actual.length + ' ≠ ' + expected.length);
  }
  for (let i = 0; i < actual.length; i++) {
    if (!structuralJsonEqual(actual[i], expected[i])) {
      throw new Error('[executor] A4-P1a ' + label + ' 第 ' + i + ' 项不一致');
    }
  }
}

function nonUiUnitSignatures(html) {
  const PL = require('../scripts/plain-language.js');
  return PL.extractUnits(PL.parseHtml(html)).filter(u => !PL.isReportUiUnit(u)).map(u => ({
    text: u.text,
    module: u.module,
    blockType: u.blockType,
    classifyUnit: PL.classifyUnit(u)
  }));
}

function plainItemSignatures(chunks) {
  return (chunks || []).flat().map(item => ({
    text: item.text,
    context: item.context,
    // unitId 只用于定位；跨 UI 偏移的语义签名比较受控释义与 PLAIN-V2 认知义务。
    requiredGlosses: (item.requiredGlosses || []).map(req => ({ term: req.term, gloss: req.gloss })),
    comprehensionRequirements: item.comprehensionRequirements || []
  }));
}

function plainCachePath(workDir, index) {
  return path.join(workDir, PLAIN_CACHE_PREFIX + index + '.json');
}

function assertExactPlainCacheSet(workDir) {
  const names = fs.readdirSync(workDir).filter(name => /^\.tmp-plain-batch-\d+\.json$/.test(name));
  const wanted = new Set(Array.from({ length: PLAIN_REFRESH_BATCHES }, (_, i) => PLAIN_CACHE_PREFIX + i + '.json'));
  const extras = names.filter(name => !wanted.has(name));
  const missing = [...wanted].filter(name => !names.includes(name));
  if (extras.length || missing.length) {
    throw new Error('[executor] A4-P1a 缓存批次必须恰为 0—' + (PLAIN_REFRESH_BATCHES - 1) +
      '；缺失=' + missing.join(',') + '；额外=' + extras.join(','));
  }
}

function readVerifiedPlainCache(workDir, index, chunk, dict) {
  const PL = require('../scripts/plain-language.js');
  const cachePath = plainCachePath(workDir, index);
  let cache;
  try { cache = JSON.parse(fs.readFileSync(cachePath, 'utf8')); }
  catch (e) { throw new Error('[executor] A4-P1a 缓存 ' + index + ' 不可解析: ' + e.message); }
  if (!cache || cache.v !== LEGACY_PLAIN_CACHE_VERSION || cache.promptVersion !== LEGACY_PLAIN_PROMPT_VERSION ||
    cache.chunkHash !== chunkHashOf(chunk) || cache.dictHash !== dictHashOf(dict) ||
    !cache.results || typeof cache.results !== 'object') {
    throw new Error('[executor] A4-P1a 缓存 ' + index + ' 元数据或键不匹配');
  }
  const missing = chunk.filter(item => typeof cache.results[item.id] !== 'string');
  if (missing.length) throw new Error('[executor] A4-P1a 缓存 ' + index + ' 缺少结果: ' + missing.slice(0, 5).map(x => x.id).join(','));
  const legacyTemplate = PL.checkLegacyFixedGlossaryTemplate(chunk, id => cache.results[id]);
  if (!legacyTemplate.ok) throw new Error('[executor] A4-P1a legacy-v3 固定术语模板不一致: ' + legacyTemplate.missing.map(x => x.term + '@' + x.unitId).join(','));
  const comprehension = checkPlainComprehensionItems(chunk, id => cache.results[id], require('../scripts/plain-comprehension.js').PROFILE_BODY);
  if (!comprehension.ok) throw new Error('[executor] A4-P1a 缓存 ' + index + ' PLAIN hard invariant 失败: ' + JSON.stringify(comprehension.issues.slice(0, 5)));
  return cache;
}

function writePlainCache(workDir, index, chunk, dict, results) {
  fs.writeFileSync(plainCachePath(workDir, index), JSON.stringify({
    v: LEGACY_PLAIN_CACHE_VERSION,
    promptVersion: LEGACY_PLAIN_PROMPT_VERSION,
    chunkHash: chunkHashOf(chunk),
    dictHash: dictHashOf(dict),
    results
  }), 'utf8');
}

function fingerprintFiles(workDir, names) {
  const fingerprints = {};
  for (const name of names) {
    const file = path.join(workDir, name);
    if (!fs.existsSync(file)) throw new Error('[executor] A4-P1a 缺少固定产物: ' + name);
    fingerprints[name] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
  return fingerprints;
}

function assertSameFingerprints(label, before, after) {
  if (!structuralJsonEqual(before, after)) throw new Error('[executor] A4-P1a ' + label + ' 指纹漂移');
}

function assertRefreshControls(dualHtml, plainHtml) {
  if (!dualHtml.includes('id="plainBtn"') || !dualHtml.includes('aria-keyshortcuts="Alt+T"') ||
    !dualHtml.includes('plain-toggle-host') || dualHtml.includes('Alt+P')) {
    throw new Error('[executor] A4-P1a 正式双版本 A1 Alt+T 控件契约失败');
  }
  if (/id="plainBtn"|Alt\+P|Alt\+T/.test(plainHtml)) {
    throw new Error('[executor] A4-P1a 纯白话版不得含原文/白话切换控件');
  }
}

function refreshTransactionPath(workDir) {
  return path.join(workDir, PLAIN_REFRESH_TRANSACTION);
}

function validateRefreshTransaction(workDir, tx) {
  if (!tx || tx.v !== 1 || !['prepared', 'committing', 'recovered', 'committed'].includes(tx.state) ||
    typeof tx.backupDir !== 'string' || !Array.isArray(tx.files) || !tx.files.length ||
    tx.files.some(name => !PLAIN_REFRESH_OUTPUTS.includes(name))) {
    throw new Error('[executor] A4-P1a 事务日志格式或目标不合法');
  }
  const backupDir = path.resolve(tx.backupDir);
  if (!fs.existsSync(backupDir)) throw new Error('[executor] A4-P1a 事务备份不存在: ' + backupDir);
  for (const name of tx.files) {
    if (!fs.existsSync(path.join(backupDir, name))) throw new Error('[executor] A4-P1a 事务备份缺少: ' + name);
  }
  return backupDir;
}

function recoverPlainRefreshTransaction(workDir, onLog) {
  const journal = refreshTransactionPath(workDir);
  if (!fs.existsSync(journal)) return false;
  let tx;
  try { tx = JSON.parse(fs.readFileSync(journal, 'utf8')); }
  catch (e) { throw new Error('[executor] A4-P1a 事务日志不可解析: ' + e.message); }
  // committed/recovered 都是完整状态点：即使进程恰在删备份后中断，也只需清日志，
  // 绝不能因不再需要的备份缺失把成功提交或完成回滚误判为无法恢复。
  if (tx && tx.v === 1 && ['committed', 'recovered'].includes(tx.state) && typeof tx.backupDir === 'string' &&
    Array.isArray(tx.files) && tx.files.length && tx.files.every(name => PLAIN_REFRESH_OUTPUTS.includes(name))) {
    onLog('[executor] A4-P1a 检测到已完成事务残留，清理日志');
    if (tx.ownedBackup === true && fs.existsSync(tx.backupDir)) fs.rmSync(tx.backupDir, { recursive: true, force: true });
    fs.unlinkSync(journal);
    return true;
  }
  const backupDir = validateRefreshTransaction(workDir, tx);
  if (tx.state !== 'committed') {
    for (const name of tx.files) fs.copyFileSync(path.join(backupDir, name), path.join(workDir, name));
    onLog('[executor] A4-P1a 检测到未完成事务，已由精确备份恢复 ' + tx.files.length + ' 项');
  }
  writeRefreshTransaction(workDir, tx, 'recovered');
  if (tx.ownedBackup === true) fs.rmSync(backupDir, { recursive: true, force: true });
  fs.unlinkSync(journal);
  return true;
}

function makeRefreshTransaction(workDir, files) {
  const backupDir = fs.mkdtempSync(path.join(workDir, '.tmp-plain-refresh-recovery-'));
  for (const name of files) fs.copyFileSync(path.join(workDir, name), path.join(backupDir, name));
  const tx = { v: 1, state: 'prepared', backupDir, files, ownedBackup: true };
  fs.writeFileSync(refreshTransactionPath(workDir), JSON.stringify(tx), 'utf8');
  return tx;
}

function writeRefreshTransaction(workDir, tx, state) {
  tx.state = state;
  fs.writeFileSync(refreshTransactionPath(workDir), JSON.stringify(tx), 'utf8');
}

function finishRefreshTransaction(workDir, tx) {
  writeRefreshTransaction(workDir, tx, 'committed');
  // committed 残留可接受备份已删；但在清理失败时必须保留 journal 供下次重试，
  // 不能吞掉失败后遗失唯一定位信息。
  fs.rmSync(tx.backupDir, { recursive: true, force: true });
  fs.unlinkSync(refreshTransactionPath(workDir));
}

function copyRefreshInputs(workDir, stageDir) {
  for (const name of PLAIN_REFRESH_R6_INPUTS) {
    const source = path.join(workDir, name);
    if (!fs.existsSync(source)) throw new Error('[executor] A4-P1a 缺少 R6 权威输入: ' + name);
    fs.copyFileSync(source, path.join(stageDir, name));
  }
}

// A4-P1a public seam：只在严格证明“旧缓存输入与现役 R6 基底仅 UI 不同”后，
// 才迁移 v2 缓存并重跑既有 R7 门禁。接口没有 provider/model/requestCompletion，
// 任何意外抵达模型路径都会被内部保险丝记录后硬阻断。
async function refreshPlainArtifacts(workDir, opts) {
  opts = opts || {};
  const stateMarker = semanticFirstStateMarker(workDir);
  if (stateMarker) {
    throw consumerAuthorityError('legacy A4 refresh 不接受 semantic-first workDir（marker=' +
      path.relative(workDir, stateMarker).split(path.sep).join('/') +
      '）；必须走当前 semantic-bound presentation/reissue path');
  }
  const onLog = typeof opts.onLog === 'function' ? opts.onLog : () => {};
  const onModelRequest = typeof opts.onModelRequest === 'function' ? opts.onModelRequest : () => {};
  const recovered = recoverPlainRefreshTransaction(workDir, onLog);
  const reportPath = path.join(workDir, 'report.html');
  if (!fs.existsSync(reportPath)) throw new Error('[executor] A4-P1a 缺少旧 report.html');
  const r8Before = fingerprintFiles(workDir, PLAIN_REFRESH_R8_OUTPUTS);
  const dict = loadPlainDict(workDir);
  const RR = require('../render-report.js');
  const legacyHtml = fs.readFileSync(reportPath, 'utf8');
  // R8-M1：旧生产报告可能已经嵌入导览；R7 缓存与语义等价只针对无导览基底。
  // 严格成对/唯一剥离由 renderer seam 负责，异常标记直接阻断，不做模糊 DOM 容错。
  const legacyBase = RR.stripEmbeddedReaderGuide(legacyHtml).html;
  const legacy = plainCacheInputsFromHtml(legacyBase, dict);
  assertExactPlainCacheSet(workDir);
  if (legacy.chunks.length !== PLAIN_REFRESH_BATCHES) {
    throw new Error('[executor] A4-P1a 旧报告应为 ' + PLAIN_REFRESH_BATCHES + ' 批，实际 ' + legacy.chunks.length + ' 批');
  }
  const legacyCaches = legacy.chunks.map((chunk, index) => readVerifiedPlainCache(workDir, index, chunk, dict));
  const stageDir = fs.mkdtempSync(path.join(path.dirname(path.resolve(workDir)), '.tmp-plain-refresh-stage-'));
  try {
    copyRefreshInputs(workDir, stageDir);
    renderReport(stageDir);
    const freshBase = fs.readFileSync(path.join(stageDir, 'report.html'), 'utf8');
    assertEqualPlainSignatures('非 UI 单元', nonUiUnitSignatures(legacyBase), nonUiUnitSignatures(freshBase));
    const fresh = plainCacheInputsFromHtml(freshBase, dict);
    if (fresh.chunks.length !== PLAIN_REFRESH_BATCHES) {
      throw new Error('[executor] A4-P1a 新 R6 基底应为 ' + PLAIN_REFRESH_BATCHES + ' 批，实际 ' + fresh.chunks.length + ' 批');
    }
    assertEqualPlainSignatures('可译单元 text/context/requiredGlosses', plainItemSignatures(legacy.chunks), plainItemSignatures(fresh.chunks));
    for (let index = 0; index < PLAIN_REFRESH_BATCHES; index++) {
      const oldChunk = legacy.chunks[index];
      const newChunk = fresh.chunks[index];
      if (oldChunk.length !== newChunk.length) throw new Error('[executor] A4-P1a 第 ' + index + ' 批单元数量不一致');
      const results = {};
      for (let i = 0; i < oldChunk.length; i++) results[newChunk[i].id] = legacyCaches[index].results[oldChunk[i].id];
      const legacyTemplate = require('../scripts/plain-language.js').checkLegacyFixedGlossaryTemplate(newChunk, id => results[id]);
      if (!legacyTemplate.ok) throw new Error('[executor] A4-P1a 第 ' + index + ' 批重键后 legacy-v3 固定术语模板不一致');
      writePlainCache(stageDir, index, newChunk, dict, results);
    }
    let modelCalls = 0;
    const modelFuse = async () => {
      modelCalls++;
      try { onModelRequest(); } finally { throw new Error('[executor] A4-P1a cache-only 保险丝：禁止模型请求'); }
    };
    await applyPlain(stageDir, { provider: 'cache-only' }, onLog, null, { cache: true, legacyV3: true, requestCompletion: modelFuse });
    if (modelCalls) throw new Error('[executor] A4-P1a cache-only 保险丝被触发');
    const stageReport = fs.readFileSync(path.join(stageDir, 'report.html'), 'utf8');
    const stagePlain = fs.readFileSync(path.join(stageDir, 'report-plain.html'), 'utf8');
    const PL = require('../scripts/plain-language.js');
    const PC = require('../pipeline-controller.js');
    const compare = PL.compareVersions(freshBase, stagePlain);
    if (!compare.ok) throw new Error('[executor] A4-P1a 暂存双版本比较失败');
    const legacyTemplate = PL.checkLegacyFixedGlossaryReport(freshBase, stagePlain, dict);
    if (!legacyTemplate.ok) throw new Error('[executor] A4-P1a 暂存 legacy-v3 固定术语模板一致性失败');
    const dataSource = fs.existsSync(path.join(stageDir, '.tmp-adjudicated-data.md')) ? path.join(stageDir, '.tmp-adjudicated-data.md') : path.join(stageDir, 'transition-final.md');
    const data = PC.extractDataMarkers(fs.readFileSync(dataSource, 'utf8'));
    for (const file of ['report.html', 'report-plain.html']) {
      const check = PC.checkHtml(path.join(stageDir, file), { stage: 'final', skillPath: resolveSkillPath(), dataSource });
      if (check.blocking && check.blocking.length) throw new Error('[executor] A4-P1a 暂存 ' + file + ' HTML 合同失败: ' + check.blocking.map(x => x.message).join('; '));
    }
    const verdict = PC.checkVerdictConsistency(stagePlain, data);
    if (!verdict.passed) throw new Error('[executor] A4-P1a 暂存判决一致性失败: ' + verdict.errors.map(x => x.message).join('; '));
    assertRefreshControls(stageReport, stagePlain);
    assertSameFingerprints('R8 暂存前', r8Before, fingerprintFiles(workDir, PLAIN_REFRESH_R8_OUTPUTS));

    // R8-M1：只在 R7 暂存门禁全部通过后，才用原场次四件已验证快照对暂存 R6 输入重建证明。
    // readVerifiedReaderGuideSnapshot 会同时核对 input/guide/cache review/key/独立 HTML；不调用模型、不改快照。
    const r8Snapshot = readVerifiedReaderGuideSnapshot(workDir, stageDir);
    const embeddedStageReport = RR.embedReaderGuideIntoReport(stageReport, r8Snapshot.guide, r8Snapshot.plainGuide);
    const plainGuideState = RR.stripEmbeddedReaderGuide(stagePlain);
    if (plainGuideState.embedded) throw new Error('[executor] A4-P1a 纯白话页不得嵌入 R8 导览');
    fs.writeFileSync(path.join(stageDir, 'report.html'), embeddedStageReport, 'utf8');
    const embeddedCheck = PC.checkHtml(path.join(stageDir, 'report.html'), { stage: 'final', skillPath: resolveSkillPath(), dataSource });
    if (embeddedCheck.blocking && embeddedCheck.blocking.length) {
      throw new Error('[executor] A4-P1a 暂存 R8 嵌入后 HTML 合同失败: ' + embeddedCheck.blocking.map(x => x.message).join('; '));
    }

    const tx = makeRefreshTransaction(workDir, PLAIN_REFRESH_OUTPUTS);
    const nextFiles = [];
    try {
      for (const name of PLAIN_REFRESH_OUTPUTS) {
        const staged = path.join(stageDir, name);
        if (!fs.existsSync(staged)) throw new Error('[executor] A4-P1a 暂存缺少提交产物: ' + name);
        const next = path.join(workDir, '.' + name + '.refresh-next');
        fs.copyFileSync(staged, next);
        nextFiles.push({ name, next });
      }
      writeRefreshTransaction(workDir, tx, 'committing');
      for (const item of nextFiles) fs.renameSync(item.next, path.join(workDir, item.name));
      assertSameFingerprints('R8 提交后', r8Before, fingerprintFiles(workDir, PLAIN_REFRESH_R8_OUTPUTS));
      finishRefreshTransaction(workDir, tx);
    } catch (e) {
      for (const item of nextFiles) if (fs.existsSync(item.next)) fs.rmSync(item.next, { force: true });
      recoverPlainRefreshTransaction(workDir, onLog);
      throw e;
    }
    onLog('[executor] A4-P1a 无模型生产报告刷新完成：14 批缓存已重键，A1 Alt+T 已同步');
    return { cacheOnly: true, recovered, batches: PLAIN_REFRESH_BATCHES };
  } finally {
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

// ---------- PLAIN-V2：生产白话层窄重生成 seam ----------
// 只允许从现役 R6 权威产物机械重建 report，再重跑 R7 白话与 R8 白话导览；
// 不重算 R1—R6，不允许借“更白话”改变原 guide。所有会被改写的文件先精确备份，
// 中途失败或门禁失败必须恢复；进程意外中断留下 journal 时，下次调用先恢复。
const PLAIN_V2_REGEN_JOURNAL = '.tmp-plain-v2-regenerate-transaction.json';
const PLAIN_V2_REGEN_CHECKPOINT_PREFIX = '.tmp-plain-v2-regenerate-checkpoints-';
const PLAIN_V2_REGEN_FIXED_TARGETS = [
  'report.html', 'report-plain.html',
  'reader-guide-input.json', 'reader-guide.json', 'reader-guide-plain.json', 'reader-guide.html', '.tmp-reader-guide-cache.json', '.tmp-reader-guide-draft.json', '.tmp-reader-guide-plain-draft.json'
];
const PLAIN_V2_IMMUTABLE_FILES = [
  'P1.md', 'P2.md', 'P2.5.md', 'P3.md', 'full-data.md',
  '.tmp-adjudicated-data.md', '.tmp-adjudicated-structure.json', 'transition-final.md',
  'structure.json', '叙事.md', 'adjudication.json', 'source-anchor.json'
];

function plainV2CacheNames(workDir) {
  return fs.readdirSync(workDir).filter(name => /^\.tmp-plain-batch-\d+\.json$/.test(name)).sort();
}

function plainV2MutableNames(workDir) {
  // 生产事务只管理可发布派生产物；已逐批过门的正文 cache 与 R1—R6 轮次产物同属断点，禁止回滚。
  return PLAIN_V2_REGEN_FIXED_TARGETS.slice().sort();
}

function plainV2CheckpointCandidateNames(workDir) {
  const out = [];
  const proofFile = path.join(workDir, PLAIN_REVIEW_FILE);
  let proofHash = '';
  try {
    const bytes = fs.readFileSync(proofFile);
    const proof = JSON.parse(bytes.toString('utf8'));
    if (proof && proof.state === 'approved') proofHash = crypto.createHash('sha256').update(bytes).digest('hex');
  } catch (e) { proofHash = ''; }
  if (!proofHash) return out;
  for (const name of plainV2CacheNames(workDir)) {
    try {
      const cc = JSON.parse(fs.readFileSync(path.join(workDir, name), 'utf8'));
      if (cc && cc.v === PLAIN_CACHE_VERSION && cc.promptVersion === PLAIN_PROMPT_VERSION &&
          cc.approved === true && cc.reviewProofHash === proofHash) out.push(name);
    } catch (e) { /* 损坏缓存仍由 translateUnitsLLM 按 miss 处理 */ }
  }
  return out;
}

function fingerprintOptionalFiles(workDir, names) {
  const out = {};
  for (const name of names) {
    const file = path.join(workDir, name);
    if (!fs.existsSync(file)) continue;
    if (!fs.statSync(file).isFile()) throw new Error('[executor] PLAIN-V2 不可变输入不是普通文件: ' + name);
    out[name] = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }
  return out;
}

// Presentation-only stages may create/replace user-visible files, but a failed stage must not leave
// unbound bytes behind. Private draft/cache checkpoints are intentionally excluded: they may survive a
// failure for bounded recovery, while public presentation outputs are restored exactly to entry state.
function snapshotTextFiles(workDir, names) {
  const root = path.resolve(workDir);
  const out = {};
  for (const name of names || []) {
    const file = path.resolve(workDir, name);
    const rel = path.relative(root, file);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('[executor] presentation snapshot path escaped workDir: ' + name);
    if (fs.existsSync(file)) {
      if (!fs.statSync(file).isFile()) throw new Error('[executor] presentation snapshot target is not a file: ' + name);
      out[name] = { existed: true, text: fs.readFileSync(file, 'utf8') };
    } else {
      out[name] = { existed: false, text: null };
    }
  }
  return out;
}
function restoreTextFiles(workDir, snapshot) {
  const root = path.resolve(workDir);
  for (const [name, row] of Object.entries(snapshot || {})) {
    const file = path.resolve(workDir, name);
    const rel = path.relative(root, file);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('[executor] presentation restore path escaped workDir: ' + name);
    if (row && row.existed) {
      fs.writeFileSync(file, String(row.text == null ? '' : row.text), 'utf8');
    } else if (fs.existsSync(file)) {
      if (!fs.statSync(file).isFile()) throw new Error('[executor] presentation restore target is not a file: ' + name);
      fs.rmSync(file, { force: true });
    }
  }
}

function plainV2JournalPath(workDir) {
  return path.join(workDir, PLAIN_V2_REGEN_JOURNAL);
}

function validatePlainV2Transaction(workDir, tx) {
  if (!tx || ![1, 2].includes(tx.v) || !['prepared', 'running', 'committed', 'recovered'].includes(tx.state) ||
    typeof tx.backupDir !== 'string' || !Array.isArray(tx.originalFiles)) {
    throw new Error('[executor] PLAIN-V2 重生成事务日志格式不合法');
  }
  const backupDir = path.resolve(workDir, tx.backupDir);
  const rel = path.relative(path.resolve(workDir), backupDir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !path.basename(backupDir).startsWith('.tmp-plain-v2-regenerate-backup-')) {
    throw new Error('[executor] PLAIN-V2 重生成事务备份目录越界');
  }
  if (!fs.existsSync(backupDir) || !fs.statSync(backupDir).isDirectory()) {
    throw new Error('[executor] PLAIN-V2 重生成事务备份不存在: ' + tx.backupDir);
  }
  for (const name of tx.originalFiles) {
    if (!PLAIN_V2_REGEN_FIXED_TARGETS.includes(name) && !/^\.tmp-plain-batch-\d+\.json$/.test(name)) {
      throw new Error('[executor] PLAIN-V2 重生成事务含非法目标: ' + name);
    }
    if (!fs.existsSync(path.join(backupDir, name))) {
      throw new Error('[executor] PLAIN-V2 重生成事务备份缺少: ' + name);
    }
  }
  return backupDir;
}

function writePlainV2Transaction(workDir, tx, state) {
  tx.state = state;
  fs.writeFileSync(plainV2JournalPath(workDir), JSON.stringify(tx), 'utf8');
}

function cleanupLegacyPlainV2CheckpointDir(workDir, tx) {
  const name = String(tx && tx.checkpointDir || '');
  if (!name) return;
  if (path.basename(name) !== name || !name.startsWith(PLAIN_V2_REGEN_CHECKPOINT_PREFIX)) {
    throw new Error('[executor] PLAIN-V2 legacy checkpoint 目录越界');
  }
  const dir = path.resolve(workDir, name);
  const rel = path.relative(path.resolve(workDir), dir);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('[executor] PLAIN-V2 legacy checkpoint 目录越界');
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function beginPlainV2RegenerationTransaction(workDir) {
  const originalFiles = plainV2MutableNames(workDir).filter(name => fs.existsSync(path.join(workDir, name)));
  const backupDir = fs.mkdtempSync(path.join(workDir, '.tmp-plain-v2-regenerate-backup-'));
  for (const name of originalFiles) fs.copyFileSync(path.join(workDir, name), path.join(backupDir, name));
  const tx = { v: 2, state: 'prepared', backupDir: path.basename(backupDir), originalFiles };
  fs.writeFileSync(plainV2JournalPath(workDir), JSON.stringify(tx), 'utf8');
  return tx;
}

function removePlainV2MutableFiles(workDir) {
  for (const name of PLAIN_V2_REGEN_FIXED_TARGETS) {
    const file = path.join(workDir, name);
    if (fs.existsSync(file) && fs.statSync(file).isFile()) fs.rmSync(file, { force: true });
  }
}

function recoverPlainV2RegenerationTransaction(workDir, onLog) {
  const journal = plainV2JournalPath(workDir);
  if (!fs.existsSync(journal)) return false;
  let tx;
  try { tx = JSON.parse(fs.readFileSync(journal, 'utf8')); }
  catch (e) { throw new Error('[executor] PLAIN-V2 重生成事务日志不可解析: ' + e.message); }
  if (tx && [1, 2].includes(tx.v) && ['committed', 'recovered'].includes(tx.state) && typeof tx.backupDir === 'string') {
    const backupDir = path.resolve(workDir, tx.backupDir);
    if (fs.existsSync(backupDir)) fs.rmSync(backupDir, { recursive: true, force: true });
    cleanupLegacyPlainV2CheckpointDir(workDir, tx);
    fs.rmSync(journal, { force: true });
    if (onLog) onLog('[executor] PLAIN-V2 清理已完成事务残留');
    return true;
  }
  const backupDir = validatePlainV2Transaction(workDir, tx);
  removePlainV2MutableFiles(workDir);
  // 兼容旧 v1/v2 journal：历史 backup 可能含 batch cache，但恢复时只还原发布产物，绝不以旧 cache 覆盖当前断点。
  for (const name of tx.originalFiles) {
    if (PLAIN_V2_REGEN_FIXED_TARGETS.includes(name)) fs.copyFileSync(path.join(backupDir, name), path.join(workDir, name));
  }
  writePlainV2Transaction(workDir, tx, 'recovered');
  fs.rmSync(backupDir, { recursive: true, force: true });
  cleanupLegacyPlainV2CheckpointDir(workDir, tx);
  fs.rmSync(journal, { force: true });
  if (onLog) onLog('[executor] PLAIN-V2 检测到未完成生产重生成事务，已精确恢复');
  return true;
}

function preparePlainV2RegenerationResume(workDir, onLog) {
  const journal = plainV2JournalPath(workDir);
  const checkpointNames = plainV2CheckpointCandidateNames(workDir);
  if (!fs.existsSync(journal)) {
    return { tx: null, recovered: false, resumed: checkpointNames.length > 0, resumedPlainBatches: checkpointNames.length };
  }
  let tx;
  try { tx = JSON.parse(fs.readFileSync(journal, 'utf8')); }
  catch (e) { throw new Error('[executor] PLAIN-V2 重生成事务日志不可解析: ' + e.message); }
  if (tx && [1, 2].includes(tx.v) && ['committed', 'recovered'].includes(tx.state)) {
    recoverPlainV2RegenerationTransaction(workDir, onLog);
    return { tx: null, recovered: true, resumed: checkpointNames.length > 0, resumedPlainBatches: checkpointNames.length };
  }
  const backupDir = validatePlainV2Transaction(workDir, tx);
  // 半成品发布产物不能作为 resume 输入；但已过门 batch cache 原地保留，稍后由现有 cache gate 逐批重新验真。
  removePlainV2MutableFiles(workDir);
  for (const name of tx.originalFiles) {
    if (PLAIN_V2_REGEN_FIXED_TARGETS.includes(name)) fs.copyFileSync(path.join(backupDir, name), path.join(workDir, name));
  }
  writePlainV2Transaction(workDir, tx, 'prepared');
  if (onLog) onLog('[executor] PLAIN-V2 检测到宿主中断：已恢复原生产发布快照并保留 ' + checkpointNames.length + ' 个原地正文 checkpoint 候选，后续逐批重新验真');
  return { tx, recovered: true, resumed: checkpointNames.length > 0, resumedPlainBatches: checkpointNames.length };
}

function finishPlainV2RegenerationTransaction(workDir, tx) {
  const backupDir = validatePlainV2Transaction(workDir, tx);
  writePlainV2Transaction(workDir, tx, 'committed');
  fs.rmSync(backupDir, { recursive: true, force: true });
  cleanupLegacyPlainV2CheckpointDir(workDir, tx);
  fs.rmSync(plainV2JournalPath(workDir), { force: true });
}

function validateExistingReaderGuideForPlainV2(workDir, cfg) {
  const RG = require('../scripts/reader-guide.js');
  const RR = require('../render-report.js');
  const PC = require('../pipeline-controller.js');
  const prepared = buildReaderGuideInputFromWorkDir(workDir, RG, RR, PC);
  const files = prepared.files;
  if (!fs.existsSync(files.guide) || !fs.existsSync(files.cache)) {
    throw new Error('[executor] PLAIN-V2 生产重生成要求已有经复核的原 reader-guide 与 cache；禁止顺带重生成原导览');
  }
  const guide = JSON.parse(fs.readFileSync(files.guide, 'utf8'));
  const cache = JSON.parse(fs.readFileSync(files.cache, 'utf8'));
  const snapshot = guide.modelSnapshot || {};
  const guideCheck = checkReaderGuideContract(RG, prepared.input, guide, snapshot);
  const reviewCheck = RG.validateReview(prepared.input, guide, cache.review);
  const inputHash = RG.hashGuideInput(prepared.input);
  if (!guideCheck.ok || !reviewCheck.ok || cache.inputHash !== inputHash ||
    cache.key !== RG.cacheKey(prepared.input, snapshot) || RG.stableJson(cache.guide || {}) !== RG.stableJson(guide)) {
    throw new Error('[executor] PLAIN-V2 原 reader-guide 证明链无效：' + guideCheck.errors.concat(reviewCheck.errors).join('; '));
  }
  const requested = cfg || {};
  if (String(requested.provider || '') !== String(snapshot.provider || '') || String(requested.model || '') !== String(snapshot.model || '')) {
    throw new Error('[executor] PLAIN-V2 provider/model 必须沿用已复核原 guide 的 modelSnapshot（' +
      String(snapshot.provider || '') + '/' + String(snapshot.model || '') + '）');
  }
  return { RG, guide, stableGuide: RG.stableJson(guide), snapshot };
}

async function regeneratePlainV2Artifacts(workDir, cfg, onLog, opts) {
  opts = opts || {};
  onLog = typeof onLog === 'function' ? onLog : () => {};
  if (!fs.existsSync(workDir) || !fs.statSync(workDir).isDirectory()) {
    throw new Error('[executor] PLAIN-V2 production workDir 不存在');
  }
  const stateMarker = semanticFirstStateMarker(workDir);
  if (stateMarker) {
    throw consumerAuthorityError('legacy PLAIN-V2 regenerate 不接受 semantic-first workDir（marker=' +
      path.relative(workDir, stateMarker).split(path.sep).join('/') +
      '）；不得在未绑定 current consumer authority 前开启 presentation transaction');
  }
  const startNode = String(opts.startNode || 'auto');
  if (!['auto', 'r7-body', 'r8-guide'].includes(startNode)) {
    throw new Error('[executor] PLAIN-V2 startNode 非法: ' + startNode);
  }
  const resumeStart = preparePlainV2RegenerationResume(workDir, onLog);
  const recovered = resumeStart.recovered;
  const proof = validateExistingReaderGuideForPlainV2(workDir, cfg);
  if (String(cfg && cfg.provider || '') !== 'codex-cli' && opts.allowNonCodex !== true) {
    throw new Error('[executor] PLAIN-V2 生产窄入口默认只允许 codex-cli；其它 provider 必须由显式受控调用开放');
  }
  const immutableBefore = fingerprintOptionalFiles(workDir, PLAIN_V2_IMMUTABLE_FILES);
  const tx = resumeStart.tx || beginPlainV2RegenerationTransaction(workDir);
  try {
    writePlainV2Transaction(workDir, tx, 'running');
    // 从 R6 权威输入重新机械渲染，主动抛弃当前 report 中旧 PLAIN/R8/UI 状态。
    renderReport(workDir);
    // Judge 原生断点语义：不主动删除 `.tmp-plain-batch-*`。translateUnitsLLM 会对每批
    // v/prompt/chunk/dict + 首次术语 + PLAIN-V2 门重新验真；无效缓存自然 miss，只有缺失批才重跑。
    const checkpointCandidates = plainV2CheckpointCandidateNames(workDir).length;
    if (checkpointCandidates) onLog('[executor] PLAIN-V2 发现 ' + checkpointCandidates + ' 个原地正文 checkpoint 候选，逐批重新验真');

    await applyPlain(workDir, cfg, onLog, opts.extraDictPath || null, {
      cache: true,
      cacheDir: workDir,
      onBatchCheckpoint: opts.onBatchCheckpoint,
      requireCacheHit: startNode === 'r8-guide',
      requestCompletion: opts.requestCompletion,
      codexRunner: opts.codexRunner
    });

    const guideResult = await applyReaderGuide(workDir, cfg, onLog, {
      cache: true,
      requestCompletion: opts.requestCompletion,
      codexRunner: opts.codexRunner
    });

    const immutableAfter = fingerprintOptionalFiles(workDir, PLAIN_V2_IMMUTABLE_FILES);
    assertSameFingerprints('PLAIN-V2 R1—R6 不可变输入', immutableBefore, immutableAfter);
    const newGuide = JSON.parse(fs.readFileSync(path.join(workDir, 'reader-guide.json'), 'utf8'));
    if (proof.RG.stableJson(newGuide) !== proof.stableGuide) {
      throw new Error('[executor] PLAIN-V2 禁止修改原 reader-guide；本轮只允许更新白话派生层');
    }
    const plainGuide = JSON.parse(fs.readFileSync(path.join(workDir, 'reader-guide-plain.json'), 'utf8'));
    if (plainGuide.promptVersion !== proof.RG.PLAIN_PROMPT_VERSION) {
      throw new Error('[executor] PLAIN-V2 reader-guide-plain promptVersion 未升级');
    }
    const report = fs.readFileSync(path.join(workDir, 'report.html'), 'utf8');
    const pure = fs.readFileSync(path.join(workDir, 'report-plain.html'), 'utf8');
    if ((report.match(/<!--R8_REPORT_GUIDE_START:C\d{1,2}-->/g) || []).length !== 12) {
      throw new Error('[executor] PLAIN-V2 主报告未完整嵌入 C1—C12 导览');
    }
    if (pure.includes('R8_REPORT_GUIDE_START')) {
      throw new Error('[executor] PLAIN-V2 纯白话报告不得嵌入章节导览');
    }
    const cacheNames = plainV2CacheNames(workDir);
    if (!cacheNames.length) throw new Error('[executor] PLAIN 未生成任何 v4 白话批缓存');
    finishPlainV2RegenerationTransaction(workDir, tx);
    onLog('[executor] PLAIN-V2 生产全文重生成完成：R6 零漂移；R7 全量白话 + R8 白话导览已通过新旧双门');
    return {
      ok: true,
      recovered,
      resumed: !!resumeStart.resumed,
      resumedPlainBatches: resumeStart.resumedPlainBatches || 0,
      provider: proof.snapshot.provider,
      model: proof.snapshot.model,
      plainBatches: cacheNames.length,
      guideCached: !!(guideResult && guideResult.cached),
      plainGuideCached: !!(guideResult && guideResult.plainCached),
      files: ['report.html', 'report-plain.html', 'reader-guide-plain.json']
    };
  } catch (error) {
    try { recoverPlainV2RegenerationTransaction(workDir, onLog); }
    catch (rollbackError) {
      throw new Error('[executor] PLAIN-V2 重生成失败且回滚失败：原错误=' + (error && error.message || error) +
        '；回滚错误=' + (rollbackError && rollbackError.message || rollbackError));
    }
    throw error;
  }
}

function r8RepairIdsFromError(message, chunk) {
  const text = String(message || '');
  if (!text.includes('R8 白话导览结构/事实硬门失败')) return [];
  const wanted = new Set();
  const add = (sectionId, fields) => {
    for (const field of fields) {
      const id = 'R8P:' + sectionId + ':' + field;
      if ((chunk || []).some(item => item.id === id)) wanted.add(id);
    }
  };
  const sectionRe = /(C(?:1[0-2]|[1-9])) PLAIN-V2 零背景可理解性门失败:\s*([\s\S]*?)(?=;\s*C(?:1[0-2]|[1-9]) PLAIN-V2 零背景可理解性门失败:|;\s*reader-guide-plain 事实门:|$)/g;
  let match;
  while ((match = sectionRe.exec(text))) {
    const fields = [...match[2].matchAll(/"field":"(what|why|conclusion)"/g)].map(m => m[1]);
    if (fields.length) add(match[1], [...new Set(fields)]);
    else add(match[1], ['what', 'why', 'conclusion']);
  }
  const factRe = /reader-guide-plain 事实门:\s*(C(?:1[0-2]|[1-9]))(?:\s+(what|why|conclusion))?\b[^;]*/g;
  while ((match = factRe.exec(text))) add(match[1], match[2] ? [match[2]] : ['what', 'why', 'conclusion']);
  return (chunk || []).map(item => item.id).filter(id => wanted.has(id));
}

function bodyRepairIdsFromError(message, chunk) {
  const text = String(message || '');
  const wanted = new Set();
  if (text.includes('PLAIN hard invariant 失败')) {
    for (const match of text.matchAll(/"id":"([^"]+)"/g)) wanted.add(match[1]);
  }
  return (chunk || []).map(item => item.id).filter(id => wanted.has(id));
}

function plainRetryRequestFingerprint(cfg, system, prompt) {
  return crypto.createHash('sha256').update(JSON.stringify({
    provider: cfg && cfg.provider || '',
    baseUrl: cfg && cfg.baseUrl || '',
    model: cfg && cfg.model || '',
    system: String(system || ''),
    prompt: String(prompt || '')
  })).digest('hex');
}

function plainComprehensionRetryGuidance(errMsg) {
  const text = String(errMsg || '');
  const rules = [];
  if (text.includes('protected-token-drift')) {
    rules.push('对 protected-token-drift：只修复明确数字、比分以及 N/M/CP/S 等证据定位 ID 的新增、删除、改号或重复；B0/B\'/B\'\'/SC/Phase/Q/Lv/场C 等语义概念标签不属于机械 exact-count 范围，不要为了通过机械门强行保留或删除它们。');
  }
  if (text.includes('\"empty\"') || /白话文本为空/.test(text)) {
    rules.push('对 empty：不得返回空文本；恢复原单元已经表达的事实与判断，并用自然语言重述，不能新增原文没有的结论。');
  }
  return rules.length ? '\n' + rules.join('\n') : '';
}

// 批量 LLM 翻译：按 40 单元/6000 字符分批，沿用 core 重试退避，回填按 id；
// dict 提供术语表上下文（unit.dictHints 优先；未标注时按 dict 即时计算）；
// opts = { cacheDir, requestCompletion, codexRunner }（S5：cacheDir 非空时按批落盘/命中缓存；
// requestCompletion 缺省 Node 宿主 provider seam，测试可注入桩——仅真实 LLM 路径生效，mock 不适用）
async function translateUnitsLLM(cfg, units, onLog, dict, opts) {
  const out = new Map();
  const rc = (opts && opts.requestCompletion) || requestCompletionNode;
  const cacheDir = opts && opts.cacheDir ? opts.cacheDir : null;
  const legacyV3 = !!(opts && opts.legacyV3);
  const cacheVersion = legacyV3 ? LEGACY_PLAIN_CACHE_VERSION : PLAIN_CACHE_VERSION;
  const promptVersion = (opts && opts.promptVersion) || (legacyV3 ? LEGACY_PLAIN_PROMPT_VERSION : PLAIN_PROMPT_VERSION);
  const PV2 = require('../scripts/plain-comprehension.js');
  const comprehensionProfile = (opts && opts.comprehensionProfile) || PV2.PROFILE_BODY;
  annotatePlainComprehensionRequirements(units, comprehensionProfile);
  const MAX_UNITS = 40;
  const MAX_CHARS = 6000;
  const chunks = [];
  let cur = [];
  let curChars = 0;
  for (const u of units) {
    const item = {
      id: u.id,
      context: (u.module ? u.module + ' · ' : '') + (u.blockType || 'block'),
      text: u.text,
      // Historical first-seen fixed-gloss metadata is excluded from live v4 model input.
      requiredGlosses: legacyV3 && Array.isArray(u.requiredGlosses) ? u.requiredGlosses : [],
      comprehensionRequirements: Array.isArray(u.comprehensionRequirements) ? u.comprehensionRequirements : []
    };
    if (cur.length >= MAX_UNITS || (curChars + item.text.length > MAX_CHARS && cur.length)) {
      chunks.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(item);
    curChars += item.text.length;
  }
  if (cur.length) chunks.push(cur);
  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    // S5 断点缓存：批开始前检查命中（v/prompt/chunk/dict 全匹配且语义复核通过才复用；
    // 损坏/缺 id/缺首现解释 → 忽略重译，容错不阻断）
    if (cacheDir) {
      let cached = null;
      let cachedMeta = null;
      try {
        const cachePath = path.join(cacheDir, PLAIN_CACHE_PREFIX + ci + '.json');
        if (fs.existsSync(cachePath)) {
          const cc = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
          if (cc && cc.v === cacheVersion && cc.promptVersion === promptVersion && cc.chunkHash === chunkHashOf(chunk) && cc.dictHash === dictHashOf(dict) &&
              (!opts || !opts.requireCacheHit || legacyV3 || cc.approved === true)) {
            cached = cc.results;
            cachedMeta = cc;
          }
        }
      } catch (e) { cached = null; }
      if (cached) {
        const hit = chunk.every(it => typeof cached[it.id] === 'string');
        const PL = require('../scripts/plain-language.js');
        const legacyTemplateOk = !legacyV3 || (hit && PL.checkLegacyFixedGlossaryTemplate(chunk, id => cached[id]).ok);
        const hard = hit ? checkPlainComprehensionItems(chunk, id => cached[id], comprehensionProfile) : { ok: false };
        if (hit && legacyTemplateOk && hard.ok) {
          for (const it of chunk) out.set(it.id, cached[it.id]);
          onLog('[executor] 白话批缓存命中 ' + (ci + 1) + '/' + chunks.length + '（' + chunk.length + ' 单元；' +
            (legacyV3 ? 'legacy-v3' : (cachedMeta && cachedMeta.approved === true ? 'approved' : 'draft')) + '）');
          if (opts && typeof opts.onBatchCheckpoint === 'function') {
            await Promise.resolve(opts.onBatchCheckpoint({ phase: legacyV3 ? 'legacy' : 'draft', index: ci, total: chunks.length, cached: true, approved: !!(cachedMeta && cachedMeta.approved), cacheDir }));
          }
          continue;
        }
      }
    }
    if (opts && opts.requireCacheHit) {
      throw new Error('[executor] 指定 resume node 要求前置 R7 checkpoint 完整，但白话批 ' + (ci + 1) + '/' + chunks.length + ' cache miss；禁止静默回退调用正文模型');
    }
    const gloss = [];
    const seen = new Set();
    for (const u of chunk) {
      let hints = u.dictHints;
      if (!hints && dict) {
        const PL = require('../scripts/plain-language.js');
        hints = PL.dictHintsForText(u.text, dict);
      }
      for (const h of hints || []) {
        if (!seen.has(h.term)) { seen.add(h.term); gloss.push(h.term + ' → ' + h.gloss); }
      }
    }
    const comprehensionLines = chunk.flatMap(u => (u.comprehensionRequirements || []).map(req =>
      '- ' + u.id + ': ' + (req.term ? req.term + ' → ' + (req.explanation || '') : (req.markers || []).join('/') + ' → ' + req.mode)));
    const prompt = PV2.buildPromptContract({ profile: comprehensionProfile }) +
      '\n\n输入单元（JSON）：\n' + JSON.stringify({ units: chunk }, null, 2) +
      (legacyV3 && gloss.length ? '\n\nlegacy-v3 术语模板来源（仅历史兼容）：\n- ' + gloss.join('\n- ') : '') +
      (legacyV3 && chunk.some(u => u.requiredGlosses.length) ? '\n\nlegacy-v3 首现固定模板元数据：\n' + chunk.flatMap(u => u.requiredGlosses.map(r => '- ' + u.id + ': ' + r.term + ' → ' + r.gloss)).join('\n') : '') +
      (!legacyV3 && comprehensionLines.length ? '\n\nPLAIN 语义理解提示（只提供概念可能含义，不是翻译表或答案键；先结合本场上下文理解，不要求复现词典措辞）：\n' + comprehensionLines.join('\n') : '') +
      '\n\n请按规则对每个单元做白话改写，输出覆盖全部 id 的 JSON。';
    let parsed = null;
    let lastErr = null;
    let retryFeedback = '';
    // R8 整卡失败后的定点修复状态：保留上一版完整候选，只重写机械门点名字段。
    let repairBase = null;
    let repairIds = [];
    let lastRequestFingerprint = null;
    let lastRetryDeterministic = false;
    // 跨 Job draft 恢复：如果调用方已经持有一份完整失败候选，首笔模型请求就必须进入
    // 定点修复，不能先重译整批。其它字段在 repairBase 中冻结并由执行器机械合并。
    if (comprehensionProfile === PV2.PROFILE_GUIDE && opts && opts.initialResults instanceof Map && opts.initialError) {
      const complete = chunk.every(item => typeof opts.initialResults.get(item.id) === 'string');
      const initialRepairIds = complete ? r8RepairIdsFromError(String(opts.initialError), chunk) : [];
      if (initialRepairIds.length) {
        repairBase = new Map(opts.initialResults);
        repairIds = initialRepairIds;
        retryFeedback = '\n\n这是从私有 draft 恢复的定点续跑。当前机械门诊断必须逐项消除；未点名字段已经冻结，禁止重写。\n' + String(opts.initialError).slice(0, 6000);
        onLog('[executor] R8 白话 draft 断点续跑：冻结其它字段，只修 ' + repairIds.join(','));
      }
    }
    for (let attempt = 0; attempt <= core.MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const d = core.retryDelayMs(attempt);
        appendRetryEvent(cacheDir, { round: comprehensionProfile === PV2.PROFILE_GUIDE ? 'R8' : 'R7', stage: 'plain_batch', event: 'retry', batch: ci + 1, attempt: attempt + 1, retryIndex: attempt, repairMode: repairBase && repairIds.length ? 'bounded_repair' : 'batch_regenerate', repairScopes: repairIds.slice() });
        onLog('[executor] 白话翻译批 ' + (ci + 1) + '/' + chunks.length + ' 重试 ' + attempt + '/' + core.MAX_RETRIES + ' · 退避 ' + d + 'ms');
        await sleep(d);
      }
      try {
        let callPrompt = prompt + retryFeedback;
        let expectedIds = chunk.map(it => it.id);
        if (repairBase && repairIds.length) {
          const repairUnits = repairIds.map(id => {
            const source = chunk.find(item => item.id === id);
            return {
              id,
              context: source.context,
              originalText: source.text,
              text: repairBase.get(id),
              requiredGlosses: legacyV3 ? (source.requiredGlosses || []) : [],
              comprehensionRequirements: source.comprehensionRequirements || []
            };
          });
          expectedIds = repairIds.slice();
          const repairLabel = comprehensionProfile === PV2.PROFILE_GUIDE ? 'R8 定点修复模式' : 'R7 BODY 定点修复模式';
          const sourceLabel = comprehensionProfile === PV2.PROFILE_GUIDE ? '原导览' : '原正文';
          callPrompt = PV2.buildPromptContract({ profile: comprehensionProfile }) +
            '\n\n' + repairLabel + '：下面只列出上一版完整候选中仍未通过机械门的单元/字段。' +
            '\n`originalText` 是不可改变语义的' + sourceLabel + '，`text` 是上一版待修白话。只修这些 id；未列出的内容已经冻结，执行器会机械保留，不会采用你对它们的任何改写。' +
            '\n输出必须且只能是 {"units":[{"id":"...","text":"..."}]}，并覆盖下面全部 ' + repairUnits.length + ' 个 id，禁止返回 cards/review/说明文字。' +
            '\n\n待修字段（JSON）：\n' + JSON.stringify({ units: repairUnits }, null, 2) + retryFeedback;
        }
        const systemPrompt = comprehensionProfile === PV2.PROFILE_GUIDE ? TRANSLATE_GUIDE_SYSTEM : TRANSLATE_SYSTEM;
        const requestFingerprint = plainRetryRequestFingerprint(cfg, systemPrompt, callPrompt);
        if (lastRetryDeterministic && lastRequestFingerprint === requestFingerprint) {
          const stalled = new Error('PLAIN-V2 修复停滞：上一轮机械诊断与待修候选没有产生任何新请求内容；已阻止再次发送相同请求。最近机械诊断：' + String(lastErr && lastErr.message || '').slice(0, 1600));
          stalled.code = 'ERR_PLAIN_RETRY_STALLED';
          throw stalled;
        }
        lastRequestFingerprint = requestFingerprint;
        const raw = await rc(cfg, [{ role: 'user', content: callPrompt }], {
          system: systemPrompt,
          codexRunner: opts && opts.codexRunner
        });
        const incoming = parseTranslateJson(raw, expectedIds);
        if (repairBase && repairIds.length) {
          parsed = new Map(repairBase);
          for (const id of repairIds) parsed.set(id, incoming.get(id));
        } else {
          parsed = incoming;
        }
        const PL = require('../scripts/plain-language.js');
        if (legacyV3) {
          const legacyTemplate = PL.checkLegacyFixedGlossaryTemplate(chunk, id => parsed.get(id));
          if (!legacyTemplate.ok) throw new Error('legacy-v3 固定术语模板不一致: ' + legacyTemplate.missing.map(x => x.term + '@' + x.unitId).join(','));
        }
        const hard = checkPlainComprehensionItems(chunk, id => parsed.get(id), comprehensionProfile);
        if (!hard.ok) throw new Error('PLAIN hard invariant 失败: ' + JSON.stringify(hard.issues.slice(0, 8)));
        if (opts && typeof opts.postValidate === 'function') {
          await opts.postValidate({ results: parsed, chunk, index: ci, total: chunks.length });
        }
        break;
      } catch (e) {
        if (e && (e.name === 'AbortError' || /abort|已中止/i.test(String(e.message || '')))) throw e;
        // parse 成功不等于门禁成功。R8 整卡门失败时先保留已解析候选，下一轮只修被点名字段；
        // 其它错误仍按普通重试处理。最后一次失败后 parsed 必须清空，绝不把未过门候选落盘。
        const failedCandidate = parsed instanceof Map ? new Map(parsed) : null;
        lastErr = e;
        const errMsg = String(e && e.message || '');
        // P0（260901）：旧 UI 只看得到“第 N 批重试”，看不到触发重试的实际原因，
        // 导致真实 R7/R8 门禁问题事后无法从日志复原。只记录有界错误摘要，不记录原始模型响应。
        appendRetryEvent(cacheDir, { round: comprehensionProfile === PV2.PROFILE_GUIDE ? 'R8' : 'R7', stage: 'plain_batch', event: 'attempt_failure', batch: ci + 1, attempt: attempt + 1, failureClass: 'plain_validation', repairMode: repairBase && repairIds.length ? 'bounded_repair' : 'batch_regenerate', repairScopes: repairIds.slice(), message: errMsg.slice(0, 1200) });
        onLog('[executor] 白话翻译批 ' + (ci + 1) + '/' + chunks.length + ' attempt ' + (attempt + 1) + ' 失败: ' + errMsg.slice(0, 1200));
        if (e && e.code === 'ERR_PLAIN_RETRY_STALLED') throw e;
        if (failedCandidate && comprehensionProfile === PV2.PROFILE_GUIDE &&
          errMsg.includes('R8 白话导览结构/事实硬门失败')) {
          const nextRepairIds = r8RepairIdsFromError(errMsg, chunk);
          if (nextRepairIds.length) {
            repairBase = failedCandidate;
            repairIds = nextRepairIds;
          }
          if (opts && typeof opts.onFailedCandidate === 'function') {
            try { opts.onFailedCandidate({ results: failedCandidate, error: errMsg, repairIds: nextRepairIds, chunk, index: ci, total: chunks.length }); }
            catch (checkpointError) { onLog('[executor] R8 白话私有 draft checkpoint 失败（不改变原门禁结果）: ' + (checkpointError && checkpointError.message || checkpointError)); }
          }
        } else if (!legacyV3 && failedCandidate && comprehensionProfile === PV2.PROFILE_BODY &&
          errMsg.includes('PLAIN hard invariant 失败')) {
          const nextRepairIds = bodyRepairIdsFromError(errMsg, chunk);
          if (nextRepairIds.length) {
            repairBase = failedCandidate;
            repairIds = nextRepairIds;
          }
        }
        parsed = null;
        // Retry feedback is limited to machine-provable hard invariants and output shape.
        // Readability / concept explanation defects are handled by the independent semantic reviewer.
        const shapeError = errMsg.includes('翻译响应缺失') || errMsg.includes('翻译响应无 units 数组') ||
          /Unexpected token|Expected property name|JSON.*(?:parse|position)|position\s+\d+/i.test(errMsg);
        lastRetryDeterministic = errMsg.includes('protected-token-drift') || errMsg.includes('PLAIN hard invariant 失败') ||
          (legacyV3 && errMsg.includes('legacy-v3 固定术语模板不一致')) ||
          errMsg.includes('R8 白话导览结构/事实硬门失败') || shapeError;
        const scopedCount = repairBase && repairIds.length ? repairIds.length : chunk.length;
        const scopedLabel = repairBase && repairIds.length ? '当前待修范围的全部 ' + scopedCount + ' 个 id' : '本批全部 ' + scopedCount + ' 个输入 id';
        retryFeedback = legacyV3 && errMsg.includes('legacy-v3 固定术语模板不一致')
          ? '\n\n这是 legacy-v3 历史兼容重放：上一次响应不符合旧固定术语模板。仅为保持历史模板一致性修正；这不是 live v4 的语义判据。'
          : (shapeError
              ? '\n\n上一次响应没有遵守输出结构。你必须输出且只输出 {"units":[{"id":"...","text":"..."}]} 这一种 JSON 结构。必须恰好包含' + scopedLabel + '，每个 id 恰好一次且逐字保留；不得返回 cards、guide、review、说明文字或 Markdown。' +
                (repairBase && repairIds.length
                  ? '当前为定点修复，只能返回当前待修范围，不能夹带未点名字段。'
                  : '即使只需要修正被点名的少数章节，也不得只返回修改项，必须重发本批全部 ' + chunk.length + ' 个 units。') +
                '结构错误：' + errMsg.slice(0, 1200)
              : (errMsg.includes('R8 白话导览结构/事实硬门失败')
                ? '\n\n上一次响应通过了字段级格式检查，但没有通过 R8 白话导览结构/事实硬门。以下诊断必须逐项消除；不得删减原导览信息、不得新增任何事实/胜负/主体/数字，也不得用新的内部术语替代旧术语。' +
                  plainComprehensionRetryGuidance(errMsg) +
                  (/含来源外事实 token:\s*(?:胜出|胜利|获胜|胜方|获胜方)/.test(errMsg)
                    ? '\n对胜负词事实漂移：白话不得创造或同义改写任何胜负词。被事实门点名的“胜出/胜利/获胜/胜方/获胜方”等词如果原字段没有，就必须删除；需要表达胜负时只能逐字沿用原导览该字段已有的胜负原词，禁止同义替换。'
                    : '') +
                  (repairIds.length
                    ? '\n本轮已进入定点修复：只输出待修字段的 ' + repairIds.length + ' 个 id；其它字段由执行器冻结并机械保留，禁止重写。'
                    : '\n无论只修改几个章节，都必须继续使用原 {"units":[...]} 结构并完整重发本批全部 ' + chunk.length + ' 个 id。') +
                  '\n请根据具体章节和字段修正后重发 JSON：\n' + errMsg.slice(0, 6000)
                : (errMsg.includes('PLAIN hard invariant 失败')
                  ? '\n\n上一次响应没有通过 PLAIN 机械硬不变量检查。只修复机器明确指出的空输出或受保护 token 漂移；不要用固定词典措辞来“过可读性门”。术语解释是否充分由后续独立 semantic reviewer 判断。' +
                    plainComprehensionRetryGuidance(errMsg) +
                    (repairIds.length
                      ? '\n本轮已进入 BODY 定点机械修复：只输出待修的 ' + repairIds.length + ' 个 id；其它单元由执行器冻结并机械保留。'
                      : '') +
                    '\n机械诊断：\n' + errMsg.slice(0, 6000)
                  : (errMsg.includes('protected-token-drift')
                    ? '\n\n上一次响应改变了受保护数字/编号。' + plainComprehensionRetryGuidance(errMsg) + '\n请修正后重发 JSON。'
                    : ''))));
      }
    }
    if (!parsed) throw new Error('[executor] 白话翻译批 ' + (ci + 1) + '/' + chunks.length + ' 失败: ' + (lastErr ? lastErr.message : '未知错误'));
    for (const it of chunk) out.set(it.id, parsed.get(it.id));
    // S5：仅在 parseTranslateJson 成功（含 id 全覆盖校验）后落盘——复用 executor 断点"产物已通过才跳过"语义
    if (cacheDir) {
      try {
        fs.mkdirSync(cacheDir, { recursive: true });
        const results = {};
        for (const it of chunk) results[it.id] = parsed.get(it.id);
        const cachePayload = { v: cacheVersion, promptVersion, chunkHash: chunkHashOf(chunk), dictHash: dictHashOf(dict), results };
        if (!legacyV3) cachePayload.approved = false;
        fs.writeFileSync(path.join(cacheDir, PLAIN_CACHE_PREFIX + ci + '.json'), JSON.stringify(cachePayload), 'utf8');
      } catch (e) { /* 缓存写失败不阻断翻译 */ }
    }
    if (opts && typeof opts.onBatchCheckpoint === 'function') {
      await Promise.resolve(opts.onBatchCheckpoint({ phase: legacyV3 ? 'legacy' : 'draft', index: ci, total: chunks.length, cached: false, approved: legacyV3, cacheDir }));
    }
    onLog('[executor] 白话翻译批 ' + (ci + 1) + '/' + chunks.length + ' 完成（' + chunk.length + ' 单元）');
  }
  return out;
}

function plainReviewPath(cacheDir) {
  return path.join(cacheDir, PLAIN_REVIEW_FILE);
}

function sha256Text(value) {
  return crypto.createHash('sha256').update(String(value == null ? '' : value)).digest('hex');
}

function plainReviewBinding(cfg, units, results, dict) {
  const PV2 = require('../scripts/plain-comprehension.js');
  const ordered = (units || []).map(unit => ({ id: unit.id, text: unit.text }));
  const candidate = (units || []).map(unit => ({ id: unit.id, text: results.get(unit.id) }));
  return {
    sourceHash: sha256Text(JSON.stringify(ordered)),
    candidateHash: sha256Text(JSON.stringify(candidate)),
    dictHash: dictHashOf(dict),
    generatorPromptVersion: PLAIN_PROMPT_VERSION,
    generatorPromptHash: sha256Text(TRANSLATE_SYSTEM + '\n' + PV2.buildPromptContract({ profile: PV2.PROFILE_BODY })),
    reviewPromptVersion: PV2.READABILITY_REVIEW_PROMPT_VERSION,
    modelSnapshot: {
      provider: String(cfg && cfg.provider || ''),
      model: String(cfg && cfg.model || ''),
      baseUrl: String(cfg && cfg.baseUrl || '')
    }
  };
}

function parsePlainReviewJson(raw) {
  let text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) text = text.slice(start, end + 1);
  return JSON.parse(text);
}

function writePlainReviewProof(cacheDir, proof) {
  if (!cacheDir) return null;
  fs.mkdirSync(cacheDir, { recursive: true });
  const file = plainReviewPath(cacheDir);
  const next = file + '.next';
  const bytes = JSON.stringify(proof, null, 2) + '\n';
  fs.writeFileSync(next, bytes, 'utf8');
  fs.renameSync(next, file);
  return { file, sha256: sha256Text(bytes) };
}

function livePlainCacheFiles(cacheDir) {
  if (!cacheDir || !fs.existsSync(cacheDir)) return [];
  return fs.readdirSync(cacheDir)
    .filter(name => /^\.tmp-plain-batch-\d+\.json$/.test(name))
    .sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
}

function rewriteLivePlainCaches(cacheDir, results, approved, reviewProofHash) {
  if (!cacheDir) return 0;
  let changed = 0;
  for (const name of livePlainCacheFiles(cacheDir)) {
    const file = path.join(cacheDir, name);
    let cache;
    try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); }
    catch (e) { continue; }
    if (!cache || cache.v !== PLAIN_CACHE_VERSION || cache.promptVersion !== PLAIN_PROMPT_VERSION || !cache.results) continue;
    let touched = false;
    for (const id of Object.keys(cache.results)) {
      if (results.has(id) && cache.results[id] !== results.get(id)) {
        cache.results[id] = results.get(id);
        touched = true;
      }
    }
    if (cache.approved !== approved) { cache.approved = approved; touched = true; }
    if (approved) {
      if (cache.reviewProofHash !== reviewProofHash) { cache.reviewProofHash = reviewProofHash; touched = true; }
    } else if ('reviewProofHash' in cache) {
      delete cache.reviewProofHash;
      touched = true;
    }
    if (touched) {
      fs.writeFileSync(file, JSON.stringify(cache), 'utf8');
      changed++;
    }
  }
  return changed;
}

function verifyApprovedPlainReviewProof(cacheDir, cfg, units, results, dict) {
  const PV2 = require('../scripts/plain-comprehension.js');
  if (!cacheDir) return { ok: false, error: 'approved review proof requires cacheDir' };
  const file = plainReviewPath(cacheDir);
  if (!fs.existsSync(file)) return { ok: false, error: '缺少 ' + PLAIN_REVIEW_FILE };
  let proof;
  let bytes;
  try {
    bytes = fs.readFileSync(file, 'utf8');
    proof = JSON.parse(bytes);
  } catch (e) { return { ok: false, error: 'review proof 不可解析: ' + e.message }; }
  const binding = plainReviewBinding(cfg, units, results, dict);
  for (const key of ['sourceHash','candidateHash','dictHash','generatorPromptVersion','generatorPromptHash','reviewPromptVersion']) {
    if (proof && proof[key] !== binding[key]) return { ok: false, error: 'review proof binding drift: ' + key };
  }
  if (!proof || !structuralJsonEqual(proof.modelSnapshot || {}, binding.modelSnapshot) || proof.state !== 'approved') {
    return { ok: false, error: 'review proof state/modelSnapshot 不匹配' };
  }
  const expectedIds = (units || []).map(unit => unit.id);
  const reviewCheck = PV2.validateReadabilityReview(proof.review, expectedIds);
  if (!reviewCheck.ok) return { ok: false, error: 'review proof coverage/approval 无效: ' + reviewCheck.errors.join('; ') };
  const proofHash = sha256Text(bytes);
  const caches = livePlainCacheFiles(cacheDir);
  if (!caches.length) return { ok: false, error: '没有 live v4 batch cache' };
  for (const name of caches) {
    let cache;
    try { cache = JSON.parse(fs.readFileSync(path.join(cacheDir, name), 'utf8')); }
    catch (e) { return { ok: false, error: name + ' 不可解析' }; }
    if (!cache || cache.v !== PLAIN_CACHE_VERSION || cache.promptVersion !== PLAIN_PROMPT_VERSION ||
        cache.approved !== true || cache.reviewProofHash !== proofHash) {
      return { ok: false, error: name + ' 尚未绑定 approved review proof' };
    }
  }
  return { ok: true, proof, proofHash };
}

async function reviewPlainUnits(cfg, units, initialResults, onLog, dict, opts) {
  opts = opts || {};
  onLog = typeof onLog === 'function' ? onLog : () => {};
  const PV2 = require('../scripts/plain-comprehension.js');
  const rc = opts.requestCompletion || requestCompletionNode;
  const cacheDir = opts.cacheDir || null;
  const results = initialResults instanceof Map ? new Map(initialResults) : new Map(Object.entries(initialResults || {}));
  const allIds = (units || []).map(unit => unit.id);
  const hard = checkPlainComprehensionItems(units, id => results.get(id), PV2.PROFILE_BODY);
  if (!hard.ok) throw new Error('[executor] R7 draft 硬不变量失败: ' + JSON.stringify(hard.issues.slice(0, 12)));

  const existingApproved = verifyApprovedPlainReviewProof(cacheDir, cfg, units, results, dict);
  if (existingApproved.ok) {
    onLog('[executor] R7 approved review proof 命中：跳过正文 reviewer/repair 模型');
    return { results, review: existingApproved.proof.review, proof: existingApproved.proof, changed: false, cachedApproved: true };
  }
  if (opts.requireApprovedProof) {
    throw new Error('[executor] r8-guide Resume 前置 R7 review proof 无效: ' + existingApproved.error);
  }

  let targetIds = allIds.slice();
  let repairCount = 0;
  let hardRepairCount = 0;
  let changed = false;
  const history = [];
  while (true) {
    const reviewPrompt = PV2.buildReadabilityReviewPrompt(units, id => results.get(id), dict, { targetIds });
    core.assertWithinContextLimit(reviewPrompt, 'R7 independent readability review');
    let raw;
    if (cfg && cfg.provider === 'mock' && !opts.requestCompletion) {
      raw = JSON.stringify({ approved: true, checkedIds: targetIds, issues: [] });
    } else {
      raw = await rc(cfg, [{ role: 'user', content: reviewPrompt }], {
        system: '你是 PLAIN 独立语义复核器。你与生成器职责分离，只依据原文、候选白话和有序上下文做 semanticEquivalent / zeroBackgroundReadable / naturalReadable / noLocatorDependency 判断。只输出严格 JSON。',
        codexRunner: opts.codexRunner
      });
    }
    let review;
    try { review = parsePlainReviewJson(raw); }
    catch (e) { throw new Error('[executor] R7 independent review JSON 无效: ' + e.message); }
    const validation = PV2.validateReadabilityReview(review, targetIds);
    const binding = plainReviewBinding(cfg, units, results, dict);
    const reviewRecord = {
      round: history.length + 1,
      targetIds: targetIds.slice(),
      reviewPromptHash: sha256Text(reviewPrompt),
      approved: review.approved === true,
      checkedIds: Array.isArray(review.checkedIds) ? review.checkedIds.slice() : [],
      issues: Array.isArray(review.issues) ? review.issues : [],
      valid: validation.valid === true,
      errors: validation.errors || []
    };
    history.push(reviewRecord);
    const interimProof = {
      v: 1,
      state: validation.ok ? 'review-passed' : (validation.valid ? 'review-failed' : 'invalid'),
      ...binding,
      reviewPromptHash: reviewRecord.reviewPromptHash,
      checkedIds: reviewRecord.checkedIds,
      review,
      history
    };
    writePlainReviewProof(cacheDir, interimProof);
    if (opts && typeof opts.onBatchCheckpoint === 'function') {
      await Promise.resolve(opts.onBatchCheckpoint({ phase: 'review', state: interimProof.state, targetIds: targetIds.slice(), cacheDir }));
    }
    // Durability barrier: review result is on disk (and Web callback, when present, has resolved)
    // before any next repair request can spend another model call.
    if (!validation.valid) {
      throw new Error('[executor] R7 independent review coverage/schema fail-close: ' + validation.errors.join('; '));
    }
    if (validation.ok) {
      const finalReview = { approved: true, checkedIds: allIds.slice(), issues: [] };
      const finalBinding = plainReviewBinding(cfg, units, results, dict);
      const finalProof = {
        v: 1,
        state: 'approved',
        ...finalBinding,
        reviewPromptHash: reviewRecord.reviewPromptHash,
        checkedIds: allIds.slice(),
        review: finalReview,
        history
      };
      const persisted = writePlainReviewProof(cacheDir, finalProof);
      const promoted = rewriteLivePlainCaches(cacheDir, results, true, persisted && persisted.sha256);
      if (opts && typeof opts.onBatchCheckpoint === 'function') {
        await Promise.resolve(opts.onBatchCheckpoint({ phase: 'approved', state: 'approved', approved: true, promotedBatches: promoted, cacheDir }));
      }
      onLog('[executor] R7 independent review APPROVED：checkedIds=' + allIds.length + '；promoted=' + promoted + ' batch');
      return { results, review: finalReview, proof: finalProof, changed, cachedApproved: false };
    }

    const failedIds = PV2.failedReviewIds(review, targetIds);
    if (!failedIds.length) throw new Error('[executor] R7 independent review 未批准但没有可定位失败 ID');
    if (repairCount >= core.MAX_RETRIES) {
      throw new Error('[executor] R7 independent review/repair 预算耗尽，仍失败: ' + failedIds.join(','));
    }
    const repairPrompt = PV2.buildReadabilityRepairPrompt(units, id => results.get(id), review, dict, { targetIds: failedIds });
    core.assertWithinContextLimit(repairPrompt, 'R7 readability targeted repair');
    if (repairCount > 0) {
      const delay = core.retryDelayMs(repairCount);
      onLog('[executor] R7 semantic repair 重试 ' + repairCount + '/' + core.MAX_RETRIES + ' · 退避 ' + delay + 'ms');
      await sleep(delay);
    }
    let repairRaw;
    if (cfg && cfg.provider === 'mock' && !opts.requestCompletion) {
      repairRaw = JSON.stringify({ units: failedIds.map(id => ({ id, text: results.get(id) })) });
    } else {
      repairRaw = await rc(cfg, [{ role: 'user', content: repairPrompt }], {
        system: '你是 PLAIN 定点语义修复器。只能修改指定失败 ID；其余上下文只读。保持事实与所有受保护 token，不要把 locator 写成机器说明书。只输出严格 units JSON。',
        codexRunner: opts.codexRunner
      });
    }
    const incoming = parseTranslateJson(repairRaw, failedIds);
    const before = new Map(results);
    const candidateResults = new Map(results);
    for (const id of failedIds) candidateResults.set(id, incoming.get(id));
    for (const id of allIds) {
      if (!failedIds.includes(id) && candidateResults.get(id) !== before.get(id)) {
        throw new Error('[executor] R7 repair 越权改写已冻结 ID: ' + id);
      }
    }
    const repairedUnits = (units || []).filter(unit => failedIds.includes(unit.id));
    let repairedHard = checkPlainComprehensionItems(repairedUnits, id => candidateResults.get(id), PV2.PROFILE_BODY);
    if (!repairedHard.ok) {
      if (hardRepairCount >= 1) {
        throw new Error('[executor] R7 repair 机械硬门定点纠错预算耗尽: ' + JSON.stringify(repairedHard.issues.slice(0, 8)));
      }
      const hardFailedIds = [];
      for (const item of repairedHard.issues || []) {
        const id = String(item && item.id || '');
        if (failedIds.includes(id) && !hardFailedIds.includes(id)) hardFailedIds.push(id);
      }
      if (!hardFailedIds.length) {
        throw new Error('[executor] R7 repair 硬不变量失败且无法定位 ID: ' + JSON.stringify(repairedHard.issues.slice(0, 8)));
      }
      hardRepairCount++;
      const hardRepairPrompt = PV2.buildReadabilityHardRepairPrompt(
        units,
        id => candidateResults.get(id),
        dict,
        { targetIds: hardFailedIds, mechanicalIssues: repairedHard.issues }
      );
      core.assertWithinContextLimit(hardRepairPrompt, 'R7 readability mechanical hard repair');
      onLog('[executor] R7 repair 机械硬门拒绝：' + hardFailedIds.join(',') + '；执行定点机械纠错 1/1');
      let hardRepairRaw;
      if (cfg && cfg.provider === 'mock' && !opts.requestCompletion) {
        hardRepairRaw = JSON.stringify({ units: hardFailedIds.map(id => ({ id, text: candidateResults.get(id) })) });
      } else {
        hardRepairRaw = await rc(cfg, [{ role: 'user', content: hardRepairPrompt }], {
          system: '你是 PLAIN 机械硬不变量定点纠错器。只能修机器明确指出的 token/数字/ID 次数或内容违规；保持上一轮语义修复，其余上下文只读。只输出严格 units JSON。',
          codexRunner: opts.codexRunner
        });
      }
      const hardIncoming = parseTranslateJson(hardRepairRaw, hardFailedIds);
      for (const id of hardFailedIds) candidateResults.set(id, hardIncoming.get(id));
      repairedHard = checkPlainComprehensionItems(repairedUnits, id => candidateResults.get(id), PV2.PROFILE_BODY);
      if (!repairedHard.ok) {
        throw new Error('[executor] R7 repair 机械硬门定点纠错仍失败: ' + JSON.stringify(repairedHard.issues.slice(0, 8)));
      }
      onLog('[executor] R7 repair 机械硬门定点纠错通过：' + hardFailedIds.join(','));
    }
    for (const id of failedIds) results.set(id, candidateResults.get(id));
    rewriteLivePlainCaches(cacheDir, results, false, null);
    if (opts && typeof opts.onBatchCheckpoint === 'function') {
      await Promise.resolve(opts.onBatchCheckpoint({ phase: 'repair-draft', state: 'draft', targetIds: failedIds.slice(), cacheDir }));
    }
    targetIds = failedIds;
    repairCount++;
    changed = true;
  }
}

function checkPlainComprehensionHtml(origHtml, plainHtml) {
  const PL = require('../scripts/plain-language.js');
  const PV2 = require('../scripts/plain-comprehension.js');
  const origAll = PL.extractUnits(PL.parseHtml(origHtml));
  const plainAll = PL.extractUnits(PL.parseHtml(plainHtml));
  if (origAll.length !== plainAll.length) return { ok: false, issues: [{ id: '*', issues: [{ code: 'unit-count', message: '原文/白话文本单元数量不一致' }] }] };
  const origUnits = origAll.filter(u => PL.classifyUnit(u) === 'translate');
  annotatePlainComprehensionRequirements(origUnits, PV2.PROFILE_BODY);
  const plainById = new Map(plainAll.map(u => [u.id, u.text]));
  return checkPlainComprehensionItems(origUnits, id => plainById.get(id) || '', PV2.PROFILE_BODY);
}

// R7 白话层收口：纯白话版（report-plain.html）+ 双版本合并（report.html）
// 外部门禁：checkHtml(final) + checkVerdictConsistency；合并后复跑 checkHtml。
// opts = { cache }（S5：默认 true → 断点缓存目录 = workDir；false → 全量重译）
async function applyPlain(workDir, cfg, onLog, extraDictPath, opts) {
  opts = opts || {};
  const presentationSnapshot = snapshotTextFiles(workDir, ['report.html', 'report-plain.html']);
  try {
  const PL = require('../scripts/plain-language.js');
  const PC = require('../pipeline-controller.js');
  const RR = require('../render-report.js');
  const plan = resolveConsumerBinding(workDir, opts.consumerBinding || null,
    opts.consumerBinding ? ['report', 'adjudicatedData'] : []);
  const cacheDir = opts.cacheDir
    ? path.resolve(String(opts.cacheDir))
    : (opts.cache !== false ? workDir : null);
  if (cacheDir) fs.mkdirSync(cacheDir, { recursive: true });
  const reportInput = consumerViewPath(workDir, plan, 'report', ['report.html'], true);
  const report = path.join(workDir, 'report.html');
  const html = fs.readFileSync(reportInput, 'utf-8');
  const dataSrc = consumerViewPath(workDir, plan, 'adjudicatedData',
    ['.tmp-adjudicated-data.md', 'transition-final.md'], true);
  const topic = (html.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
  const data = PC.extractDataMarkers(fs.readFileSync(dataSrc, 'utf-8'));
  const dict = loadPlainDict(workDir, extraDictPath);
  onLog('[executor] R7 字典加载：' + Object.keys(dict).length + ' 词条' + (extraDictPath ? '（含外部 --plain-dict）' : '（核心 PLAIN_DICT）'));
  const legacyV3 = !!(opts && opts.legacyV3);
  let reviewUnits = [];
  let draftResults = null;
  const translateDraft = async units => {
    const PV2 = require('../scripts/plain-comprehension.js');
    annotatePlainComprehensionRequirements(units, PV2.PROFILE_BODY);
    reviewUnits = units.map(unit => ({ ...unit, path: Array.isArray(unit.path) ? unit.path.slice() : unit.path }));
    if (cfg.provider === 'mock' && !legacyV3) {
      draftResults = new Map(units.map(unit => [unit.id, unit.text + '（白话）']));
      if (cacheDir) {
        const mockChunks = [];
        let mockCur = [];
        let mockChars = 0;
        for (const unit of units) {
          const item = {
            id: unit.id,
            context: (unit.module ? unit.module + ' · ' : '') + (unit.blockType || 'block'),
            text: unit.text,
            requiredGlosses: [],
            comprehensionRequirements: Array.isArray(unit.comprehensionRequirements) ? unit.comprehensionRequirements : []
          };
          if (mockCur.length >= 40 || (mockChars + item.text.length > 6000 && mockCur.length)) {
            mockChunks.push(mockCur);
            mockCur = [];
            mockChars = 0;
          }
          mockCur.push(item);
          mockChars += item.text.length;
        }
        if (mockCur.length) mockChunks.push(mockCur);
        for (let ci = 0; ci < mockChunks.length; ci++) {
          const chunk = mockChunks[ci];
          const results = {};
          for (const item of chunk) results[item.id] = draftResults.get(item.id);
          fs.writeFileSync(path.join(cacheDir, PLAIN_CACHE_PREFIX + ci + '.json'), JSON.stringify({
            v: PLAIN_CACHE_VERSION,
            promptVersion: PLAIN_PROMPT_VERSION,
            chunkHash: chunkHashOf(chunk),
            dictHash: dictHashOf(dict),
            results,
            approved: false
          }), 'utf8');
          if (opts && typeof opts.onBatchCheckpoint === 'function') {
            await Promise.resolve(opts.onBatchCheckpoint({ phase: 'draft', index: ci, total: mockChunks.length, cached: false, approved: false, cacheDir }));
          }
        }
      }
      return draftResults;
    }
    draftResults = await translateUnitsLLM(cfg, units, onLog, dict, {
      cacheDir,
      legacyV3,
      comprehensionProfile: PV2.PROFILE_BODY,
      onBatchCheckpoint: opts && opts.onBatchCheckpoint,
      requireCacheHit: !!(opts && opts.requireCacheHit),
      requestCompletion: opts && opts.requestCompletion,
      codexRunner: opts && opts.codexRunner
    });
    return draftResults;
  };
  let res = await PL.processReportAsync(html, {
    strictIdentity: false,
    context: { topic },
    dict,
    legacyFixedGlossary: legacyV3,
    translateUnits: translateDraft
  });

  if (legacyV3) {
    // A4 compatibility lane only: retain the historical exact first-gloss contract for no-model refresh.
    const legacyTemplate = PL.checkLegacyFixedGlossaryReport(html, res.html, dict);
    if (!legacyTemplate.ok) {
      throw new Error('[executor] legacy-v3 历史固定术语模板一致性失败：' +
        legacyTemplate.missing.map(x => x.term + '@' + x.unitId).join(','));
    }
  } else {
    if (!(draftResults instanceof Map) || !reviewUnits.length) throw new Error('[executor] R7 未获得可复核的完整 draft 单元序列');
    const reviewed = await reviewPlainUnits(cfg, reviewUnits, draftResults, onLog, dict, {
      cacheDir,
      requestCompletion: opts && opts.requestCompletion,
      codexRunner: opts && opts.codexRunner,
      onBatchCheckpoint: opts && opts.onBatchCheckpoint,
      requireApprovedProof: !!(opts && opts.requireCacheHit)
    });
    draftResults = reviewed.results;
    if (reviewed.changed) {
      // Repair output scope is targeted, but final DOM is rebuilt mechanically from the original
      // document so all non-target units stay byte-identical to the last approved draft.
      res = await PL.processReportAsync(html, {
        strictIdentity: false,
        context: { topic },
        dict,
        legacyFixedGlossary: legacyV3,
        translateUnits: async units => {
          const expected = units.map(unit => unit.id);
          const missing = expected.filter(id => !draftResults.has(id));
          if (missing.length) throw new Error('[executor] R7 repair 合并后缺失 ID: ' + missing.slice(0, 5).join(','));
          return draftResults;
        }
      });
    }
  }

  // Final mechanical safety remains fail-close. Semantic readability is already represented by
  // the independent review proof above, never by text-node regex heuristics.
  const comprehension = checkPlainComprehensionHtml(html, res.html);
  if (!comprehension.ok) {
    throw new Error('[executor] PLAIN 白话产物硬不变量失败：' + JSON.stringify(comprehension.issues.slice(0, 12)));
  }
  const plainFile = path.join(workDir, 'report-plain.html');
  // 源锚层 v1（E-2）：免责横幅 fixed 保护双保险——白话产物必须逐字保留 DISCLAIMER_TEXT，缺失 → BLOCKING
  if (readAnchor(workDir) && readAnchor(workDir).disclaimer === true) {
    const HC4 = require('../scripts/html-contract.js');
    if (!res.html.includes(HC4.DISCLAIMER_TEXT))
      throw new Error('[executor] 白话产物 BLOCKING：免责横幅（DISCLAIMER_TEXT）被改写/删除——fixed 单元保护失效');
  }
  fs.writeFileSync(plainFile, res.html, 'utf-8');
  const hv = PC.checkHtml(plainFile, { stage: 'final', skillPath: resolveSkillPath(), dataSource: dataSrc });
  if (hv.blocking && hv.blocking.length)
    throw new Error('[executor] 白话版 checkHtml 失败: ' + hv.blocking.map(b => b.message).join('; '));
  const vc = PC.checkVerdictConsistency(res.html, data);
  if (!vc.passed)
    throw new Error('[executor] 白话版判决一致性校验失败: ' + vc.errors.map(e => e.message).join('; '));
  const drift = PL.checkPlainContract(res.html);
  if (drift.warnings.length) onLog('[executor] R7 结构契约漂移告警（白话版）: ' + drift.warnings.join('; '));
  const merged = PL.mergePlainIntoOriginal(html, res.html);
  const final = RR.injectPlainToggle(merged);
  fs.writeFileSync(report, final, 'utf-8');
  const hv2 = PC.checkHtml(report, { stage: 'final', skillPath: resolveSkillPath(), dataSource: dataSrc });
  if (hv2.blocking && hv2.blocking.length)
    throw new Error('[executor] 双版本 report.html 校验失败: ' + hv2.blocking.map(b => b.message).join('; '));
  const drift2 = PL.checkPlainContract(final);
  if (drift2.warnings.length) onLog('[executor] R7 结构契约漂移告警（双版本）: ' + drift2.warnings.join('; '));
  // Same-version registration is part of the presentation transaction. If another bound view drifted,
  // produced-view registration fails here while the entry snapshot is still available for rollback.
  const nextConsumerBinding = opts.consumerBinding
    ? consumerBindingFromProducedViews(workDir, opts.consumerBinding, {
        report: 'report.html',
        reportPlain: 'report-plain.html'
      })
    : null;
  onLog('[executor] R7 白话层完成：report.html（双版本）+ report-plain.html（纯白话，' +
    res.units.length + ' 单元 / ' + res.stats.translatable + ' 可译 / 覆盖率 ' + res.stats.coverage.coveragePct + '%）');
  return { consumerBinding: nextConsumerBinding, report: 'report.html', reportPlain: 'report-plain.html' };
  } catch (e) {
    try { restoreTextFiles(workDir, presentationSnapshot); }
    catch (restoreError) {
      throw new Error('[executor] R7 白话层失败且 presentation 回滚失败: ' + (restoreError && restoreError.message ? restoreError.message : String(restoreError)) + '；原错误=' + (e && e.message ? e.message : String(e)));
    }
    throw e;
  }
}

// 历史记录“重新出报告”专用窄 seam：只消费已经正式批准的 PLAIN-V4 产物，
// 纯机械重建双版本 report.html。接口故意不暴露 requestCompletion/codexRunner；任何 cache/proof
// 缺失或漂移直接 fail-close，绝不回退调用模型，也不改 report-plain/cache/proof。
async function rebuildApprovedPlainReport(workDir, cfg, extraDictPath, opts) {
  opts = opts || {};
  const PL = require('../scripts/plain-language.js');
  const PV2 = require('../scripts/plain-comprehension.js');
  const PC = require('../pipeline-controller.js');
  const RR = require('../render-report.js');
  const plan = resolveConsumerBinding(workDir, opts.consumerBinding || null,
    opts.consumerBinding ? ['report', 'reportPlain', 'adjudicatedData'] : []);
  const reportPath = consumerViewPath(workDir, plan, 'report', ['report.html'], true);
  const plainPath = consumerViewPath(workDir, plan, 'reportPlain', ['report-plain.html'], true);
  if (!fs.existsSync(reportPath)) throw new Error('[executor] 历史 PLAIN 重建缺少 R6 基础 report.html');
  if (!fs.existsSync(plainPath)) throw new Error('[executor] 历史 PLAIN 重建缺少正式 report-plain.html');

  const baseHtml = fs.readFileSync(reportPath, 'utf8');
  const formalPlain = fs.readFileSync(plainPath, 'utf8');
  const dataSrc = consumerViewPath(workDir, plan, 'adjudicatedData',
    ['.tmp-adjudicated-data.md', 'transition-final.md'], true);
  if (!fs.existsSync(dataSrc)) throw new Error('[executor] 历史 PLAIN 重建缺少正式裁决数据源');
  const data = PC.extractDataMarkers(fs.readFileSync(dataSrc, 'utf8'));
  const dict = loadPlainDict(workDir, extraDictPath || null);
  const topic = (baseHtml.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
  let reviewUnits = [];
  let cacheResults = null;
  let fuseCalls = 0;
  const noModelFuse = async () => {
    fuseCalls++;
    throw new Error('[executor] 历史 PLAIN 重建 0-API 保险丝触发：禁止模型请求');
  };

  const replay = await PL.processReportAsync(baseHtml, {
    strictIdentity: false,
    context: { topic },
    dict,
    translateUnits: async units => {
      annotatePlainComprehensionRequirements(units, PV2.PROFILE_BODY);
      reviewUnits = units.map(unit => ({ ...unit, path: Array.isArray(unit.path) ? unit.path.slice() : unit.path }));
      cacheResults = await translateUnitsLLM(cfg, units, () => {}, dict, {
        cacheDir: workDir,
        legacyV3: false,
        comprehensionProfile: PV2.PROFILE_BODY,
        requireCacheHit: true,
        requestCompletion: noModelFuse
      });
      return cacheResults;
    }
  });
  if (fuseCalls) throw new Error('[executor] 历史 PLAIN 重建违反 0-API 合同');
  if (!(cacheResults instanceof Map) || !reviewUnits.length) throw new Error('[executor] 历史 PLAIN 重建未取得完整 approved cache');
  if (replay.html !== formalPlain) {
    throw new Error('[executor] 历史 PLAIN 重建阻断：正式 report-plain.html 与 approved cache 机械重放不一致');
  }

  await reviewPlainUnits(cfg, reviewUnits, cacheResults, () => {}, dict, {
    cacheDir: workDir,
    requestCompletion: noModelFuse,
    requireApprovedProof: true
  });
  if (fuseCalls) throw new Error('[executor] 历史 PLAIN 重建违反 0-API 合同');

  const compare = PL.compareVersions(baseHtml, formalPlain);
  if (!compare.ok) throw new Error('[executor] 历史 PLAIN 重建双版本结构/白名单校验失败');
  const comprehension = checkPlainComprehensionHtml(baseHtml, formalPlain);
  if (!comprehension.ok) throw new Error('[executor] 历史 PLAIN 重建硬不变量失败: ' + JSON.stringify(comprehension.issues.slice(0, 12)));
  const hv = PC.checkHtml(plainPath, { stage: 'final', skillPath: resolveSkillPath(), dataSource: dataSrc });
  if (hv.blocking && hv.blocking.length) throw new Error('[executor] 历史 PLAIN 正式 report-plain.html 合同失败: ' + hv.blocking.map(x => x.message).join('; '));
  const vc = PC.checkVerdictConsistency(formalPlain, data);
  if (!vc.passed) throw new Error('[executor] 历史 PLAIN 判决一致性失败: ' + vc.errors.map(x => x.message).join('; '));

  const merged = PL.mergePlainIntoOriginal(baseHtml, formalPlain);
  const finalHtml = RR.injectPlainToggle(merged);
  fs.writeFileSync(reportPath, finalHtml, 'utf8');
  try {
    const hv2 = PC.checkHtml(reportPath, { stage: 'final', skillPath: resolveSkillPath(), dataSource: dataSrc });
    if (hv2.blocking && hv2.blocking.length) throw new Error(hv2.blocking.map(x => x.message).join('; '));
  } catch (e) {
    fs.writeFileSync(reportPath, baseHtml, 'utf8');
    throw new Error('[executor] 历史 PLAIN 双版本主报告合同失败: ' + (e && e.message ? e.message : e));
  }
  let nextConsumerBinding = null;
  try {
    nextConsumerBinding = opts.consumerBinding
      ? consumerBindingFromProducedViews(workDir, opts.consumerBinding, { report: path.relative(workDir, reportPath) })
      : null;
  } catch (e) {
    fs.writeFileSync(reportPath, baseHtml, 'utf8');
    throw new Error('[executor] 历史 PLAIN same-version binding 登记失败: ' + (e && e.message ? e.message : e));
  }
  return { reportPath, plainPath, consumerBinding: nextConsumerBinding };
}

// P6：数据契约注入——每一轮声称要读的数据源必须内联进 prompt（幂等标记防断点续跑重复追加）
const DATA_SOURCE_MARK = '<!-- DATA_SOURCE_INJECTED -->';
const R25_CP_WHITELIST_MARK = '<!-- R2.5_CP_WHITELIST_INJECTED -->';
const R5A_STRUCTURE_SOURCE_MARK = '<!-- R5A_STRUCTURE_SOURCE_INJECTED -->';
const R5A_POEM_GUIDANCE_MARK = '<!-- R5A_C1_POEM_GUIDANCE_INJECTED -->';

function resolveSkillPath() {
  const candidates = [
    path.join(__dirname, '..', 'Skill-Judge.md'),
    path.join(process.cwd(), 'Skill-Judge.md')
  ];
  return candidates.find(p => fs.existsSync(p)) || candidates[0];
}

function injectDataSource(workDir, promptFile, sectionTitle, sourceFile, onLog, opts) {
  opts = opts || {};
  const p = path.join(workDir, promptFile);
  // A8-P7：全量运行保障——prompt 或数据源缺失即阻断，禁止无数据运行
  if (!fs.existsSync(p)) throw new Error('[executor] 数据注入失败: prompt 文件缺失 ' + promptFile + '——禁止无数据运行。');
  if (!fs.existsSync(sourceFile)) throw new Error('[executor] 数据注入失败: 数据源缺失 ' + sourceFile + '（注入 ' + promptFile + '）——禁止裁剪/降级，请补全后重跑。');
  let text = fs.readFileSync(p, 'utf-8');
  const dataSha = crypto.createHash('sha256').update(fs.readFileSync(sourceFile)).digest('hex');
  const bindingMark = opts.bindingVersionKey
    ? '<!-- DATA_SOURCE_BINDING:' + String(opts.bindingVersionKey) + ':' + dataSha + ' -->'
    : null;
  if (bindingMark && text.includes(bindingMark)) {
    onLog('[executor] ' + promptFile + ' 已注入同版本数据源（幂等跳过）');
    return true;
  }
  if (!bindingMark && text.includes(DATA_SOURCE_MARK)) {
    onLog('[executor] ' + promptFile + ' 已注入数据源（幂等跳过）');
    return true;
  }
  // semantic-bound 不得因旧 DATA_SOURCE_MARK 存在而继续消费 stale 内联数据；
  // 绑定版本变化时只移除本函数追加的末尾数据段，再以新 hash/version 重建。
  if (bindingMark && text.includes(DATA_SOURCE_MARK)) {
    const idx = text.lastIndexOf(DATA_SOURCE_MARK);
    const segStart = text.lastIndexOf('\n\n---\n\n## ', idx);
    if (segStart < 0) throw consumerAuthorityError(promptFile + ' 存在无法安全定位的旧数据注入段');
    text = text.slice(0, segStart);
  }
  const data = fs.readFileSync(sourceFile, 'utf-8');
  text += '\n\n---\n\n## ' + sectionTitle + '\n\n' + DATA_SOURCE_MARK +
    (bindingMark ? '\n' + bindingMark : '') + '\n\n' + data + '\n';
  fs.writeFileSync(p, text, 'utf-8');
  assertPromptsWithinContext(workDir, undefined, onLog);  // A8-P7：注入后立即超限预检
  onLog('[executor] ' + promptFile + ' 已注入 ' + sourceFile + ' (' + data.length + '字' + (bindingMark ? '；same-version' : '') + ')');
  return true;
}

// A8-P7：上下文超限预检——逐 prompt 文件估算 tokens，超过上限即抛错停止（禁止裁剪/降级）
function assertPromptsWithinContext(workDir, limitTokens, onLog) {
  const limit = parseInt(limitTokens, 10) > 0 ? parseInt(limitTokens, 10)
    : (parseInt(process.env.EXECUTOR_CONTEXT_LIMIT_TOKENS, 10) > 0 ? parseInt(process.env.EXECUTOR_CONTEXT_LIMIT_TOKENS, 10) : core.DEFAULT_CONTEXT_LIMIT_TOKENS);
  for (const round of core.ROUNDS) {
    const p = path.join(workDir, round.promptFile);
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, 'utf-8');
    core.assertWithinContextLimit(text, round.promptFile, limit);
  }
  if (onLog) onLog('[executor] 上下文预检通过（limit=' + limit + ' tokens · 全量注入）');
}

function buildR25Prompt(workDir, onLog) {
  const PC = require('../pipeline-controller.js');
  // 260811 批甲 D：P1 全文注入 → S5 切片（消除模板污染源；S5 段实测 DATA 标记=0，纯正文）
  const p = path.join(workDir, '.tmp-R2.5-prompt.md');
  if (!fs.existsSync(p)) throw new Error('[executor] 数据注入失败: prompt 文件缺失 .tmp-R2.5-prompt.md——禁止无数据运行。');
  let text = fs.readFileSync(p, 'utf-8');
  if (text.includes(DATA_SOURCE_MARK) && text.includes(R25_CP_WHITELIST_MARK)) {
    onLog('[executor] .tmp-R2.5-prompt.md 已注入 S5 切片及 CP 白名单（幂等跳过）');
    return;
  }
  const p1 = readIfExists(path.join(workDir, 'P1.md'));
  const additions = [];
  if (!text.includes(DATA_SOURCE_MARK)) {
    const s5 = PC.sectionOfStep(p1, 5) || '（S5 段缺失）';
    additions.push('## 前置数据 P1 S5 段（R2.5 必读 · 因向/果向象限）\n\n' + DATA_SOURCE_MARK + '\n\n' + s5);
    onLog('[executor] R2.5 prompt 已注入 P1 S5 切片 (' + s5.length + '字)');
  }
  if (!text.includes(R25_CP_WHITELIST_MARK)) {
    const data = PC.extractDataMarkers(p1 || '');
    const cpIds = String(data['S7.CP入选列表'] || '')
      .split(/[|,，]/)
      .map(id => id.trim())
      .filter(id => /^CP-\d+$/.test(id));
    const whitelist = cpIds.length ? cpIds.join('|') : '（无可用 CP-ID 白名单）';
    additions.push('## R2.5 合法 CP-ID 白名单（P1 S7 回引 · 仅可使用下列 ID）\n\n' +
      R25_CP_WHITELIST_MARK + '\n\n' + whitelist +
      '\n\n**硬约束**：C8 的每个回引必须逐字取自上述白名单；白名单为空时禁止臆造任何 CP-ID。');
    onLog('[executor] R2.5 prompt 已注入 P1 S7 CP 白名单 (' + (cpIds.length ? cpIds.join('|') : '空') + ')');
  }
  if (additions.length) fs.writeFileSync(p, text + '\n\n---\n\n' + additions.join('\n\n---\n\n') + '\n', 'utf-8');
}

// 260813 P1批 B2（S2）：R2 prompt 注入 P1 五段（S2+S3+S4+S5+S7）——P6 原则（R2 prompt 声明读取集：
// S2.SC容量预判/S2.预判SC方向/S3交锋注册/S4.包着打联动/S5 因向果向/S7 SC过程角色+穿透度）
// 五段必须一次拼接为同一注入块后追加（单 DATA_SOURCE_MARK 早退语义——分次 append 会丢失后续段）；
// 缺失段镜像 buildR25Prompt「（Sx 段缺失）」兜底模式；注入节标题带「追迹判定以辩词原文为准」定位语
function buildR2Prompt(workDir, onLog) {
  const PC = require('../pipeline-controller.js');
  const p = path.join(workDir, '.tmp-R2-prompt.md');
  if (!fs.existsSync(p)) throw new Error('[executor] 数据注入失败: prompt 文件缺失 .tmp-R2-prompt.md——禁止无数据运行。');
  let text = fs.readFileSync(p, 'utf-8');
  if (text.includes(DATA_SOURCE_MARK)) {
    onLog('[executor] .tmp-R2-prompt.md 已注入 P1 五段（幂等跳过）');
    return;
  }
  const p1 = readIfExists(path.join(workDir, 'P1.md'));
  const sectionNums = [2, 3, 4, 5, 7];
  const block = sectionNums.map(n => {
    const s = PC.sectionOfStep(p1, n);
    return '### P1 S' + n + ' 段（R2 必读）\n\n' + (s || '（S' + n + ' 段缺失）') + '\n';
  }).join('\n');
  text += '\n\n---\n\n## 前置数据 P1 五段（R2 必读 · 追迹判定以辩词原文为准）\n\n' + DATA_SOURCE_MARK + '\n\n' + block + '\n';
  fs.writeFileSync(p, text, 'utf-8');
  assertPromptsWithinContext(workDir, undefined, onLog);  // A8-P7：注入后立即超限预检
  onLog('[executor] R2 prompt 已注入 P1 五段切片 (' + block.length + '字)');
}

function buildR4Prompt(workDir, onLog, opts) {
  opts = opts || {};
  const plan = resolveConsumerBinding(workDir, opts.consumerBinding || null,
    opts.consumerBinding ? ['P2', 'transition'] : []);
  const p2Path = consumerViewPath(workDir, plan, 'P2', ['P2.md'], true);
  injectDataSource(workDir, '.tmp-R4-prompt.md', '前置数据 P2（R4 必读 · S8 Phase + S17.1/S17.2 节点表）', p2Path, onLog,
    plan.mode === 'semantic-bound' ? { bindingVersionKey: plan.versionKey } : null);
  // T1：注入 R3 终判的 S11.类型 权威值——R4 的 meta.s11_original_type 必须照抄，禁止自行推断（根治 G0-1 重试）
  const p = path.join(workDir, '.tmp-R4-prompt.md');
  if (!fs.existsSync(p)) return;
  let text = fs.readFileSync(p, 'utf-8');
  const MARK = '<!-- S11_AUTHORITY_INJECTED -->';
  if (text.includes(MARK)) {
    const idx = text.indexOf(MARK);
    const segStart = text.lastIndexOf('\n\n---\n\n## ⛔ 主线类型权威值', idx);
    text = segStart >= 0 ? text.slice(0, segStart) : text.slice(0, idx);
  }
  const tf = readIfExists(consumerViewPath(workDir, plan, 'transition', ['transition-final.md'], true));
  const m = tf.match(/<!--DATA:\s*S11\.类型=([^ \n]+)\s*-->/);
  const authority = m ? '<!--DATA: S11.类型=' + m[1] + ' -->' : '（transition-final 中未找到 S11.类型）';
  const typeTitle = plan.mode === 'semantic-bound'
    ? '## ⛔ 同版本 projection 类型值（R4 只做忠实结构化，不拥有 semantic revision 权限）'
    : '## ⛔ 主线类型权威值（R3 终判 · R4 必须照抄）';
  text += '\n\n---\n\n' + typeTitle + '\n\n' + MARK + '\n\n' + authority +
    (plan.mode === 'semantic-bound' ? '\n\n绑定版本：' + plan.versionKey : '') +
    '\n\n**要求**：`meta.s11_original_type` 必须逐字等于上述值；禁止自行推断或使用其它来源；若只是表示不一致，只修 projection，不得机械重判源语义。' +
    (plan.mode === 'semantic-bound'
      ? '\n**semantic-bound 额外硬约束**：`meta.type_override` 必须为 `null`。层数、首层/中层/尾层标签及 relation 拓扑只能描述当前语义的 projection，不得据此把 S11.类型改成 2b/2c/0；若旧结构启发式与当前语义不一致，保留当前语义并忠实结构化。'
      : '') + '\n';
  fs.writeFileSync(p, text, 'utf-8');
  onLog('[executor] R4 prompt 已注入 S11.类型权威值');
}

function enrichR5Prompts(workDir, onLog, opts) {
  opts = opts || {};
  const plan = resolveConsumerBinding(workDir, opts.consumerBinding || null,
    opts.consumerBinding ? ['adjudicatedData', 'adjudicatedStructure'] : []);
  const dataSource = plan.mode === 'semantic-bound'
    ? consumerViewPath(workDir, plan, 'adjudicatedData', [], true)
    : path.join(workDir, 'full-data.md');
  const dataTitle = plan.mode === 'semantic-bound'
    ? '同版本 adjudicated DATA projection（R5 唯一数据源；不拥有 semantic revision 权限）'
    : '完整过渡文件 full-data.md（R5 唯一数据源）';
  const injectOpts = plan.mode === 'semantic-bound' ? { bindingVersionKey: plan.versionKey } : null;
  injectDataSource(workDir, '.tmp-R5-A-prompt.md', dataTitle, dataSource, onLog, injectOpts);
  injectDataSource(workDir, '.tmp-R5-B-prompt.md', dataTitle, dataSource, onLog, injectOpts);
  const r5aPath = path.join(workDir, '.tmp-R5-A-prompt.md');
  const structurePath = plan.mode === 'semantic-bound'
    ? consumerViewPath(workDir, plan, 'adjudicatedStructure', [], true)
    : path.join(workDir, 'structure.json');
  if (!fs.existsSync(structurePath)) {
    throw new Error('[executor] R5-A prompt 注入失败: structure.json 缺失——C3 禁止降级或从 full-data 猜测。');
  }
  let r5a = fs.readFileSync(r5aPath, 'utf-8');
  if (plan.mode === 'semantic-bound' && r5a.includes(R5A_STRUCTURE_SOURCE_MARK)) {
    const idx = r5a.indexOf(R5A_STRUCTURE_SOURCE_MARK);
    const segStart = r5a.lastIndexOf('\n\n---\n\n## ', idx);
    const nextSeg = r5a.indexOf('\n\n---\n\n', idx + R5A_STRUCTURE_SOURCE_MARK.length);
    if (segStart < 0) throw consumerAuthorityError('R5-A 旧 structure 注入段无法安全定位');
    r5a = r5a.slice(0, segStart) + (nextSeg >= 0 ? r5a.slice(nextSeg) : '');
  }
  const additions = [];
  if (!r5a.includes(R5A_STRUCTURE_SOURCE_MARK)) {
    const structure = fs.readFileSync(structurePath, 'utf-8');
    additions.push('## 前置数据 ' + (plan.mode === 'semantic-bound' ? 'same-version adjudicated structure' : 'structure.json') +
      '（R5-A C3 必读 · 仅以此绑定视图为结构归约源）\n\n' +
      R5A_STRUCTURE_SOURCE_MARK + (plan.mode === 'semantic-bound' ? '\n\n绑定版本：' + plan.versionKey : '') +
      '\n\n```json\n' + structure + '\n```');
  }
  if (!r5a.includes(R5A_POEM_GUIDANCE_MARK)) {
    additions.push('## R5-A C1_01_POEM 局部格式硬约束（输出前必查）\n\n' +
      R5A_POEM_GUIDANCE_MARK + '\n\n' +
      '- C1_01_POEM 必须输出四句直接可见的纯 Markdown/纯文本诗句，每句单独一行。\n' +
      '- “居中”只表示四句分别独立成行；禁止用任何 HTML/CSS/SVG 标签或属性，尤其禁止 `<p align>`、`<div>`、`<span>`、`<br>`。\n' +
      '- 禁止代码围栏；`<!--INSERT_C1_01_POEM-->` 必须原样保留，诗句直接写在其后。');
  }
  if (additions.length) {
    r5a += '\n\n---\n\n' + additions.join('\n\n---\n\n') + '\n';
    fs.writeFileSync(r5aPath, r5a, 'utf-8');
    assertPromptsWithinContext(workDir, undefined, onLog);
    onLog('[executor] R5-A prompt 已注入 structure.json 与 C1 纯 Markdown 约束');
  }
}

const R45_INPUT_BINDING_SCHEMA = 'judge-r45-input-binding-v1';
const R45_INPUT_BINDING_FILE = '.tmp-r45-input-binding.json';
function currentR45InputBinding(workDir, binding) {
  if (!binding) return null;
  const plan = resolveConsumerBinding(workDir, binding, ['transition', 'structure']);
  if (plan.mode !== 'semantic-bound') return null;
  const transitionPath = consumerViewPath(workDir, plan, 'transition', [], true);
  const structurePath = consumerViewPath(workDir, plan, 'structure', [], true);
  const inputPath = path.join(workDir, '.tmp-r45-input.md');
  if (!fs.existsSync(inputPath) || !fs.statSync(inputPath).isFile()) {
    throw consumerAuthorityError('R4.5 input lineage 缺少 .tmp-r45-input.md');
  }
  return {
    schema: R45_INPUT_BINDING_SCHEMA,
    semantic_revision: plan.revision,
    parent_view_revision: plan.viewRevision,
    semantic_object_id: plan.semanticObjectId,
    projection_object_id: plan.projectionObjectId,
    transition_sha256: sha256File(transitionPath),
    structure_sha256: sha256File(structurePath),
    r45_input_sha256: sha256File(inputPath)
  };
}
function writeR45InputBinding(workDir, binding) {
  const doc = currentR45InputBinding(workDir, binding);
  if (!doc) return null;
  fs.writeFileSync(path.join(workDir, R45_INPUT_BINDING_FILE), JSON.stringify(doc, null, 2) + '\n', 'utf8');
  return doc;
}
function readR45InputBinding(workDir) {
  const file = path.join(workDir, R45_INPUT_BINDING_FILE);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw consumerAuthorityError('semantic-bound R4.5 缺少机械 input lineage sidecar: ' + R45_INPUT_BINDING_FILE);
  }
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { throw consumerAuthorityError('R4.5 input lineage sidecar 不可解析: ' + e.message); }
  if (!doc || doc.schema !== R45_INPUT_BINDING_SCHEMA) {
    throw consumerAuthorityError('R4.5 input lineage sidecar schema 非法');
  }
  return doc;
}
function assertR45BindingEqual(actual, expected, currentViewRevision, label) {
  const keys = ['schema','semantic_revision','semantic_object_id','projection_object_id','transition_sha256','structure_sha256','r45_input_sha256'];
  for (const key of keys) {
    if (String(actual && actual[key] == null ? '' : actual[key]) !== String(expected && expected[key] == null ? '' : expected[key])) {
      throw consumerAuthorityError((label || 'R4.5 input lineage') + ' mismatch: ' + key);
    }
  }
  const parentRevision = Number(actual && actual.parent_view_revision);
  if (!Number.isInteger(parentRevision) || parentRevision < 1 || parentRevision > Number(currentViewRevision || 0)) {
    throw consumerAuthorityError((label || 'R4.5 input lineage') + ' parent_view_revision 非法/晚于当前 view revision');
  }
  return true;
}
function stampR45AdjudicationInputBinding(workDir, adj, binding, stampOpts) {
  if (!binding) return adj;
  stampOpts = stampOpts || {};
  const expectedNow = currentR45InputBinding(workDir, binding);
  if (!expectedNow) return adj;
  const sidecar = readR45InputBinding(workDir);
  // Fresh formal R4.5 stamps before its output becomes a bound view. The zero-model mock path registers
  // the raw output first, so only that explicit test seam may be exactly one viewRevision ahead.
  assertR45BindingEqual(sidecar, expectedNow, expectedNow.parent_view_revision, 'fresh R4.5 parent lineage');
  const expectedDelta = stampOpts.outputAlreadyRegistered === true ? 1 : 0;
  if (Number(sidecar.parent_view_revision) + expectedDelta !== Number(expectedNow.parent_view_revision)) {
    throw consumerAuthorityError('fresh R4.5 parent view revision drifted between prompt build and recheck');
  }
  adj.meta = Object.assign({}, adj.meta || {}, { semantic_input_binding: sidecar });
  return adj;
}
function assertR45AdjudicationInputBinding(workDir, adj, binding) {
  if (!binding) return true;
  const expectedNow = currentR45InputBinding(workDir, binding);
  if (!expectedNow) return true;
  const sidecar = readR45InputBinding(workDir);
  const actual = adj && adj.meta && adj.meta.semantic_input_binding;
  if (!actual || actual.schema !== R45_INPUT_BINDING_SCHEMA) {
    throw consumerAuthorityError('semantic-bound adjudication 缺少 R4.5 parent input lineage；旧/历史 artifact 必须从 R4.5 重新生成');
  }
  assertR45BindingEqual(sidecar, expectedNow, expectedNow.parent_view_revision, 'R4.5 lineage sidecar/current');
  assertR45BindingEqual(actual, expectedNow, expectedNow.parent_view_revision, 'adjudication/current R4.5 lineage');
  if (!structuralJsonEqual(actual, sidecar)) {
    throw consumerAuthorityError('adjudication R4.5 lineage 与机械 sidecar 不一致');
  }
  return true;
}

// 3B：R4.5 输入汇总表（全量 DATA + structure 摘要 + 冲突 + 警告 + 倾向）
function buildAdjudicationInput(workDir, onLog, strictAuthority, opts) {
  opts = opts || {};
  const PC = require('../pipeline-controller.js');
  const plan = resolveConsumerBinding(workDir, opts.consumerBinding || null,
    opts.consumerBinding ? ['transition', 'structure'] : []);
  const tfPath = consumerViewPath(workDir, plan, 'transition', ['transition-final.md'], true);
  const stPath = consumerViewPath(workDir, plan, 'structure', ['structure.json'], true);
  const tf = readIfExists(tfPath);
  const st = readIfExists(stPath);
  // formal real 才把 structure/conflicts 作为 canonical authority；mock/CI 仅验证编排接线，不把占位结构冒充正式语义源。
  const stObj = (() => { try { return PC.parseStructureJson(st); } catch (e) { return null; } })();
  const conflictExclusions = adjudicationConflictExclusions(opts.semanticAuthorityBoundary);
  let conflicts;
  if (strictAuthority) {
    if (!stObj) throw new Error('[executor] R4.5 输入构建失败: structure.json 缺失或解析失败——禁止把结构权威降级为空冲突');
    try {
      const rebuilt = PC.diffConflicts(
        { values: PC.extractDataMarkers(tf) },
        stObj,
        { excluded: conflictExclusions }
      );
      conflicts = JSON.stringify(rebuilt, null, 2);
      fs.writeFileSync(path.join(workDir, '.tmp-conflicts.json'), conflicts, 'utf-8');
    } catch (e) {
      throw new Error('[executor] R4.5 机械冲突登记构建失败——禁止沿用旧登记表或假定无冲突: ' + e.message);
    }
  } else {
    if (stObj) {
      try {
        const rebuilt = PC.diffConflicts(
          { values: PC.extractDataMarkers(tf) },
          stObj,
          { excluded: conflictExclusions }
        );
        conflicts = JSON.stringify(rebuilt, null, 2);
      } catch (e) { conflicts = '[]'; }
    } else conflicts = '[]';
    fs.writeFileSync(path.join(workDir, '.tmp-conflicts.json'), conflicts, 'utf-8');
  }
  const warnings = readIfExists(path.join(workDir, '.tmp-validate-warnings.json'));
  let summary = '# R4.5 输入汇总表\n\n## 1) 全量 DATA（transition-final）\n';
  const data = PC.extractDataMarkers(tf);
  for (const [k, v] of Object.entries(data)) summary += '- `' + k + '=' + v + '`\n';
  summary += '\n## 2) structure 摘要\n';
  if (stObj) {
    summary += '- layers=' + (stObj.layers || []).length +
      ' nodes=' + (stObj.layers || []).reduce((a, l) => a + (l.nodes || []).length, 0) + '\n';
    summary += '- meta=' + JSON.stringify(stObj.meta || {}) + '\n';
  } else {
    summary += '- structure 解析失败或缺失\n';
  }
  summary += '\n## 3) 机械冲突登记（.tmp-conflicts.json）\n' + (conflicts === '[]' ? '（无）' : conflicts) + '\n';
  summary += '\n## 4) 机械警告登记（.tmp-validate-warnings.json）\n' + (warnings || '（无）') + '\n';
  summary += '\n## 5) 评委倾向（只读）\n（以管道参数为准，未提供则中立）\n';
  if (plan.mode === 'semantic-bound') {
    summary += '\n## 6) same-version binding\n- version=' + plan.versionKey +
      '\n- semantic=' + plan.semanticObjectId + '\n- projection=' + plan.projectionObjectId + '\n';
  }
  fs.writeFileSync(path.join(workDir, '.tmp-r45-input.md'), summary, 'utf-8');
  if (plan.mode === 'semantic-bound') writeR45InputBinding(workDir, opts.consumerBinding);
  onLog('[executor] R4.5 输入汇总表 → .tmp-r45-input.md (' + summary.length + '字；consumer=' + plan.mode + ')');
}

// 3B：机械复核（合并裁决后 validate/checkStructure/diffConflicts；残留冲突 = 阻断）
function adjudicationRecheck(workDir, adj, registryConflicts, opts) {
  opts = opts || {};
  const PC = require('../pipeline-controller.js');
  const bindingPlan = resolveConsumerBinding(workDir, opts.consumerBinding || null,
    opts.consumerBinding ? ['transition', 'structure'] : []);
  const authorityPlan = opts.authorityPlan || (opts.consumerBinding
    ? PC.planAdjudicationAuthority({ binding: opts.consumerBinding, mutationKind: 'projection_repair', requiredViews: ['transition', 'structure'] })
    : null);
  if (authorityPlan && !authorityPlan.allowed) return { passed: false, errors: ['R4.5 authority 失败: ' + authorityPlan.blockingReason] };
  if (bindingPlan.mode === 'semantic-bound' && !opts.stampInputBinding) {
    try { assertR45AdjudicationInputBinding(workDir, adj, opts.consumerBinding); }
    catch (e) { return { passed: false, errors: [e.message] }; }
  }
  const tfPath = consumerViewPath(workDir, bindingPlan, 'transition', ['transition-final.md'], true);
  const stPath = consumerViewPath(workDir, bindingPlan, 'structure', ['structure.json'], true);
  if (!fs.existsSync(tfPath) || !fs.existsSync(stPath))
    return { passed: false, errors: ['复核缺少 transition-final.md 或 structure.json'] };
  if (opts.semanticAuthorityBoundary === 'semantic-first-v10') {
    const forbidden = legacySemanticAdjudicationConflicts(adj && adj.conflicts);
    if (forbidden.length) {
      return {
        passed: false,
        errors: ['R4.5 semantic-first projection repair 含已退出 authority 的 legacy semantic conflict: ' +
          forbidden.map(x => x.dimension).join('; ')]
      };
    }
  }
  const merged = PC.mergeAdjudicationData(fs.readFileSync(tfPath, 'utf-8'), adj, authorityPlan ? { authorityPlan } : undefined);
  const mergedTfPath = path.join(workDir, '.tmp-adjudicated-data.md');
  fs.writeFileSync(mergedTfPath, merged, 'utf-8');
  // 批 4（260812）：structure.json 容错解析（与 R4 门禁 checkStructure 同链）——
  // R4 产物可含 ```json 围栏（门禁容错通过），裸 JSON.parse 同族崩溃；失败 → 结构化 recheck 失败（门禁重试）
  const stParsed = parseAdjArtifact(fs.readFileSync(stPath, 'utf-8'));
  if (!stParsed.ok) {
    return { passed: false, errors: ['复核 structure.json 解析失败: ' + stParsed.error] };
  }
  const mergedSt = PC.mergeStructureOverride(stParsed.obj, adj, authorityPlan ? { authorityPlan } : undefined);
  const mergedStPath = path.join(workDir, '.tmp-adjudicated-structure.json');
  fs.writeFileSync(mergedStPath, JSON.stringify(mergedSt, null, 2), 'utf-8');
  // 批甲 F5：excluded 由「登记表 ∩ adjudicated」推导（ADJ-14 已保证 adj.conflicts ⊆ 登记表，双保险）
  const regDims = new Set((registryConflicts || []).map(r => r.dimension));
  const adjDims = (adj.conflicts || []).filter(c => c.adjudicated && regDims.has(c.dimension)).map(c => c.dimension);
  const adjInfo = (adj.conflicts || []).filter(c => c.adjudicated).map(c => ({ dimension: c.dimension, adjudicated: c.adjudicated, pair: c.pair }));
  const v = PC.validate(merged, 'R3', {
    final: true,
    adjudicatedDims: adjDims,
    adjudicatedDimsInfo: adjInfo,
    semanticAuthorityBoundary: opts.semanticAuthorityBoundary || null
  });
  if (!v.passed)
    return { passed: false, errors: ['复核 validate 失败: ' + v.blocking.map(e => e.message).join('; ')] };
  const cs = PC.checkStructure(mergedStPath, {
    tfPath: mergedTfPath,
    semanticAuthorityBoundary: opts.semanticAuthorityBoundary || null
  });
  if (!cs.passed)
    return { passed: false, errors: ['复核 structure 失败: ' + cs.errors.filter(e => e.severity === 'BLOCKING').map(e => e.message).join('; ')] };
  const conflicts = PC.diffConflicts(PC.aggregateData(mergedTfPath), mergedSt, {
    excluded: adjudicationConflictExclusions(opts.semanticAuthorityBoundary, adjDims)
  });
  if (conflicts.length > 0)
    return { passed: false, errors: ['复核后仍存在 ' + conflicts.length + ' 条冲突: ' + conflicts.map(c => c.dimension).join('; ')] };
  adj.audit = Object.assign({}, adj.audit, {
    merged_validate: { passed: true, blocking: 0 },
    post_diff_conflicts: 0,
    structure_check: { passed: true }
  });
  if (bindingPlan.mode === 'semantic-bound' && opts.stampInputBinding) {
    try { stampR45AdjudicationInputBinding(workDir, adj, opts.consumerBinding); }
    catch (e) { return { passed: false, errors: [e.message] }; }
  }
  // 批甲 R7e：已裁决维度状态持久化（try/catch 缺省保护——F1 后文件恒存在，本分支仅防御损坏）
  try {
    const cfPath = path.join(workDir, '.tmp-conflicts.json');
    if (fs.existsSync(cfPath)) {
      const cf = JSON.parse(fs.readFileSync(cfPath, 'utf-8'));
      const dims = new Set((adj.conflicts || []).filter(c => c.adjudicated).map(c => c.dimension));
      let changed = false;
      for (const item of cf) if (dims.has(item.dimension) && item.status !== '已裁决') { item.status = '已裁决'; changed = true; }
      if (changed) fs.writeFileSync(cfPath, JSON.stringify(cf, null, 2));
    }
  } catch (e) {}
  fs.writeFileSync(path.join(workDir, 'adjudication.json'), JSON.stringify(adj, null, 2), 'utf-8');
  fs.writeFileSync(path.join(workDir, '.tmp-adjudication.json'), JSON.stringify(adj, null, 2), 'utf-8');
  return {
    passed: true,
    errors: [],
    consumerBinding: opts.consumerBinding
      ? consumerBindingFromProducedViews(workDir, opts.consumerBinding, {
          adjudicatedData: '.tmp-adjudicated-data.md',
          adjudicatedStructure: '.tmp-adjudicated-structure.json',
          adjudication: 'adjudication.json'
        })
      : null
  };
}

const ADJUDICATION_INJECT_MARK = '<!-- ADJUDICATION_INJECTED -->';
// 批 4（260812）：R4.5/结构 JSON 产物解析器——门禁/消费同链（单一事实源）
// 与 validateRound R4.5 分支（JSON.parse → parseStructureJson 兜底）语义一致；
// parseStructureJson 的 normalizeStructureIds 为键白名单驱动（m_ids/m_id/from_m/to_m/citation_basis/evidence），
// 对 adjudication 的 conflicts/authoritative/meta/audit 逐字节零改写（260812 两路审计探针实证）。
// 返回 { ok:true, obj } 或 { ok:false, error }（不 throw，调用方决定处置）
function parseAdjArtifact(text) {
  const PC = require('../pipeline-controller.js');   // 延迟 require（防循环依赖，与 validateRound 同款）
  try { return { ok: true, obj: JSON.parse(text) }; }
  catch (e) {
    try { return { ok: true, obj: PC.parseStructureJson(text) }; }
    catch (e2) { return { ok: false, error: 'JSON 解析失败: ' + e.message }; }
  }
}
// 3B：把裁决表权威值幂等注入 R5-A/R5-B prompt（R4.5 通过后调用；重跑时先删旧段）
function injectAdjudication(workDir, onLog, strictAuthority = true, opts) {
  opts = opts || {};
  const plan = resolveConsumerBinding(workDir, opts.consumerBinding || null,
    opts.consumerBinding ? ['adjudication'] : []);
  const adjPath = consumerViewPath(workDir, plan, 'adjudication', ['adjudication.json'], true);
  if (!fs.existsSync(adjPath)) {
    if (strictAuthority) throw new Error('[executor] adjudication.json 缺失——R4.5 已通过后禁止按“无裁决”继续');
    onLog('[executor] adjudication.json 缺失——mock/CI 裁决注入降级跳过（非正式语义路径）');
    return;
  }
  const parsed = parseAdjArtifact(fs.readFileSync(adjPath, 'utf-8'));
  if (!parsed.ok) {
    if (strictAuthority) throw new Error('[executor] adjudication.json 解析失败——canonical 裁决权威损坏，禁止进入 R5: ' + parsed.error);
    onLog('[executor] adjudication.json 解析失败——mock/CI 裁决注入降级跳过（非正式语义路径）: ' + parsed.error);
    return;
  }
  const adj = parsed.obj;
  if (plan.mode === 'semantic-bound') {
    assertR45AdjudicationInputBinding(workDir, adj, opts.consumerBinding);
    const forbidden = legacySemanticAdjudicationConflicts(adj && adj.conflicts);
    if (forbidden.length) {
      const message = '[executor] semantic-bound adjudication 含 legacy semantic conflict，禁止注入 R5: ' +
        forbidden.map(x => x.dimension).join('; ');
      if (strictAuthority) throw consumerAuthorityError(message);
      onLog(message);
      return;
    }
  }
  const auth = Object.entries(adj.authoritative || {})
    .map(([k, val]) => '<!--DATA: ' + k + '=' + val + ' -->').join('\n');
  const conflictsText = (adj.conflicts || [])
    .map(c => '- ' + c.conflict_id + ' ' + c.dimension + ' → ' + c.adjudicated + '（' + c.confidence + '）').join('\n') || '（无）';
  const adjTitle = plan.mode === 'semantic-bound'
    ? '## ⛔ 同版本 projection 裁决视图（R4.5 · 只修表示，不拥有 semantic revision 权限）'
    : '## ⛔ 裁决表权威值（R4.5 · 字段冲突时以本段为准）';
  const block = '\n\n---\n\n' + adjTitle + '\n\n' + ADJUDICATION_INJECT_MARK +
    (plan.mode === 'semantic-bound' ? '\n\n绑定版本：' + plan.versionKey : '') + '\n\n' +
    (auth ? '**authoritative DATA（projection overlay）：**\n' + auth + '\n\n' : '**authoritative：无**\n\n') +
    '**裁决记录：**\n' + conflictsText + '\n';
  for (const pf of ['.tmp-R5-A-prompt.md', '.tmp-R5-B-prompt.md']) {
    const p = path.join(workDir, pf);
    if (!fs.existsSync(p)) continue;
    let text = fs.readFileSync(p, 'utf-8');
    const idx = text.indexOf(ADJUDICATION_INJECT_MARK);
    if (idx >= 0) {
      const segStart = text.lastIndexOf('\n\n---\n\n## ', idx);
      text = segStart >= 0 ? text.slice(0, segStart) : text.slice(0, idx);
    }
    text += block;
    fs.writeFileSync(p, text, 'utf-8');
    onLog('[executor] ' + pf + ' 已注入裁决视图（consumer=' + plan.mode + '）');
  }
}

// 全管道执行：R1 → R2 ∥ R2.5 → R3 → R4 → [聚合] → R5A ∥ R5B → [拼接] → R6a → R6b
async function runPipeline(opts) {
  const workDir = opts.workDir;
  const sfMode = semanticFirstMode(opts);
  if (sfMode === 'active' && !opts.testSemanticAuthority) opts.testSemanticAuthority = resolveActiveSemanticAuthority(opts);
  // 保持 Web builder 现有 host patch 锚不漂移：shadow 运行态通过当前 run 私有 cfg 副本携带，
  // provider 不消费这些 __semantic* 字段；default-off 时仍逐字使用原 cfg 引用。
  const cfg = sfMode === 'shadow'
    ? Object.assign({}, opts.cfg || {}, {
        __semanticFirstMode: 'shadow',
        __semanticContextText: opts.semanticContextText != null ? String(opts.semanticContextText) : ''
      })
    : opts.cfg;
  const onLog = opts.onLog || (() => {});
  const realValidate = resolveActiveExecutionValidation(opts, opts.realValidate !== false && cfg.provider !== 'mock');   // mock 仅链路冒烟，跳过真实校验
  if (sfMode === 'active' && opts.consumerBinding) {
    throw consumerAuthorityError('TEST active 禁止 caller-supplied consumerBinding；必须由本次 TEST authority publication/reuse 生成');
  }
  let consumerBinding = opts.consumerBinding || null;
  let activeSemanticAuthorityText = null;
  let activeGlobalReviewDecision = null;
  let activeScAuthorityText = null;
  let testPrepared = null;
  let scPrepared = null;
  if (consumerBinding) resolveConsumerBinding(workDir, consumerBinding, []); // off/shadow compatibility lane only
  let sourceAnchorExemptions = [];
  const freshControlGuard = createFreshControlBindingGuard(workDir);
  let sourceAnchorExemptionsFreshResolved = false;
  // A76：direct PRODUCTION_ACTIVE Node/CLI 也会在 host 内 fresh 抽取并确认 source-anchor，不能依赖 Web-only flag。
  // 该 capability 仅由当前 run 的 host-local extraction/confirmation 链产生，不属于可导入 metadata。
  let hostSourceAnchorFreshResolved = false;
  // 源锚层 v1（E-3）：启动阶段统一挂载名册抽取（resume/new-dir 两路径均经此处）——
  // .tmp-debate.txt 缺失 → 显式降级登记不崩溃（mock/非标准入口）；存在 → 抽取 + 确认暂停
  const debatePath = path.join(workDir, '.tmp-debate.txt');
  if (fs.existsSync(debatePath)) {
    // 260813 P1批 B4（S4-5）：空辩词/过短辩词预检——trim 后 <20 字直接 BLOCKING 早失败（浪费轮次守卫）
    const debateText = fs.readFileSync(debatePath, 'utf-8');
    if (debateText.trim().length < 20) {
      onLog('[executor] 辩词过短（trim 后 ' + debateText.trim().length + ' 字 < 20）——空/占位辩词禁止进入管道');
      return { ok: false, results: [{ round: 'SOURCE-ANCHOR', ok: false, errors: ['辩词过短（trim 后 <20 字）——空/占位辩词禁止进入管道'] }] };
    }
    const PC = require('../pipeline-controller.js');
    // B1（260809）：合并旧锚人工 aliases，防重抽覆盖人工编辑
    const old = readAnchor(workDir);
    const anchor = PC.mergeRosterAliases(PC.extractSourceAnchor(debateText), old);
    fs.writeFileSync(path.join(workDir, 'source-anchor.json'), JSON.stringify(anchor, null, 2), 'utf-8');
    try {
      sourceAnchorExemptions = loadSourceAnchorExemptions(workDir, anchor, {
        force: !!opts.force,
        onVerifiedBytes: bytes => freshControlGuard.record('sourceAnchorExemptions', bytes)
      });
      // A77：存在时只有完整 load/真源/P2/roster 校验通过才算 fresh-resolved；不存在则明确代表本轮已撤销。
      sourceAnchorExemptionsFreshResolved = true;
      if (sourceAnchorExemptions.length) onLog('[executor] source-anchor 人工豁免 checkpoint 预检通过：' + sourceAnchorExemptions.length + ' 条');
    } catch (e) {
      onLog('[executor] ' + e.message);
      return { ok: false, results: [{ round: 'SOURCE-ANCHOR-EXEMPTION', ok: false, errors: [e.message] }] };
    }
    // H-1：mock/CI 属自动化语义——自动跳过名册确认（等效 --skip-roster-confirm），防无交互 stdin 挂起
    const autoSkip = cfg.provider === 'mock' || opts.skipRosterConfirm === true;
    const confirmed = autoSkip ? true : await confirmRoster(workDir, anchor, opts, onLog);
    if (!confirmed) {
      return { ok: false, results: [{ round: 'SOURCE-ANCHOR', ok: false, errors: ['名册确认未通过（终止/编辑）'] }] };
    }
    // A74：Type A/B 严重名册异常在“本轮确认继续/本地授权 skip”之后必须机械落位免责声明。
    // disclaimer 不能由 archive bytes 自称；它只由当前 fresh extractor 的 typeA/typeB + 本轮确认结果派生，
    // 随后 A71 会把这份 source-anchor.json 锁进 same-version control binding。
    const disclaimerRequired = !!(anchor.typeA || anchor.typeB);
    if (anchor.disclaimer !== disclaimerRequired) {
      anchor.disclaimer = disclaimerRequired;
      fs.writeFileSync(path.join(workDir, 'source-anchor.json'), JSON.stringify(anchor, null, 2), 'utf-8');
    }
    if (disclaimerRequired) onLog('[executor] 严重名册异常已确认继续——source-anchor disclaimer=true，将要求最终报告免责声明');
    freshControlGuard.record('sourceAnchor', JSON.stringify(anchor, null, 2));
    freshControlGuard.assertCurrent();
    hostSourceAnchorFreshResolved = true;
  } else {
    if (fs.existsSync(path.join(workDir, 'source-anchor-exemptions.json'))) {
      const msg = '[source-anchor exemption] .tmp-debate.txt 缺失但存在人工豁免 checkpoint——拒绝降级运行';
      onLog('[executor] ' + msg);
      return { ok: false, results: [{ round: 'SOURCE-ANCHOR-EXEMPTION', ok: false, errors: [msg] }] };
    }
    onLog('[executor] .tmp-debate.txt 缺失——锚 1/2/3 降级（mock 或非标准入口）');
  }
  assertPromptsWithinContext(workDir, undefined, onLog);  // A8-P7：启动前全量预检
  // Freeze the pristine, already-context/depth-injected prompt set before any round dynamically appends
  // P1/P2/version-bound data. A semantic revision must restart from this baseline, never from enriched prompts
  // written by the previous revision.
  let semanticRoundPromptBaseline = null;
  if (sfMode === 'active') {
    const sourceAnchorRefreshAuthorized = opts.sourceAnchorFreshResolved === true || hostSourceAnchorFreshResolved;
    testPrepared = await prepareTestSemanticAuthority(workDir, Object.assign({}, opts, {
      cfg,
      semanticFirstMode: 'active',
      sourceAnchorFreshResolved: sourceAnchorRefreshAuthorized,
      sourceAnchorExemptionsFreshResolved
    }));
    consumerBinding = testPrepared.consumerBinding;
    activeSemanticAuthorityText = testPrepared.authorityText;
    activeGlobalReviewDecision = verifiedCurrentGlobalReviewDecision(testPrepared.active.store, testPrepared.current, testPrepared.active.binding.sourceText);
    scPrepared = await prepareTestScAuthority(workDir, testPrepared, Object.assign({}, opts, {
      cfg,
      onStage: opts.onStage
    }));
    activeScAuthorityText = scPrepared.authorityText;
    if (!scPrepared.reused && typeof opts.onScSemanticEpochCheckpoint === 'function') {
      await Promise.resolve(opts.onScSemanticEpochCheckpoint({
        workDir,
        reason: scPrepared.recovered ? 'recovered-sc-publication' : 'initial-sc-publication',
        oldRevision: scPrepared.recoveredFromRevision || 0,
        newRevision: scPrepared.current.revision,
        globalSemanticRevision: testPrepared.current.revision,
        sourceSha256: scPrepared.current.sourceSha256
      }));
    }
    onLog('[executor] V10 SC semantic authority：whole-debate review + fidelity + independent CAS 已绑定 R2/S8 consumer seam' + (scPrepared.reused ? '（resume）' : '（fresh）'));
    // A115: a same-version reused/non-force session may legitimately retain prompts enriched by its completed
    // presentation epoch. Those bytes are not a new pristine baseline, but they also must not block control-view
    // rebinding/revocation when no round is recomputed. Fresh or force runs still require a clean baseline now.
    // For reused/non-force, keep a clean baseline if one is available; otherwise defer fail-close until a round
    // that could need semantic reopen is actually recomputed. No semantic CAS is allowed without that baseline.
    if (!testPrepared.reused || opts.force) {
      semanticRoundPromptBaseline = captureRoundPromptBaseline(workDir);
    } else {
      try {
        semanticRoundPromptBaseline = captureRoundPromptBaseline(workDir);
      } catch (baselineError) {
        if (!baselineError || baselineError.code !== 'ERR_TEST_PROMPT_BASELINE_CONTAMINATED') throw baselineError;
        semanticRoundPromptBaseline = null;
        onLog('[executor] PRODUCTION_ACTIVE reused/non-force：保留 prior-run enriched prompts；仅同版本 control-view 路径可继续，任何 R3 重算/reopen 将在 CAS 前 fail-close');
      }
    }
    // A71/A72：source-anchor.json 是本轮重新抽取/确认后的 control input，会改变锚校验与免责声明呈现。
    // 只有 normal run 携带 fresh-resolved capability 时才能刷新该 control view；历史 reissue 不经过这里，
    // 因而绝不能把 archive 中的任意 source-anchor bytes 现场升级成可信 authority。
    if (sourceAnchorRefreshAuthorized) {
      freshControlGuard.assertCurrent();
      const sourceAnchorFile = path.join(workDir, 'source-anchor.json');
      if (fs.existsSync(sourceAnchorFile)) {
        let sourceAnchorAlreadyBound = false;
        try {
          resolveConsumerBinding(workDir, consumerBinding, ['sourceAnchor']);
          sourceAnchorAlreadyBound = true;
        } catch (_) { sourceAnchorAlreadyBound = false; }
        if (!sourceAnchorAlreadyBound) {
          consumerBinding = freshControlGuard.bind(consumerBinding, { sourceAnchor: 'source-anchor.json' });
        }
      } else if (consumerBinding && consumerBinding.views && consumerBinding.views.sourceAnchor) {
        consumerBinding = pruneConsumerBindingAfterInvalidation(workDir, consumerBinding, ['source-anchor.json']);
      }
      // 即使 fresh state = absent，也要把旧 sourceAnchor binding 的撤销 durable 到 provenance；
      // unchanged binding 则只是幂等重验/重写，不改变 semantic identity。
      const sourceAnchorProvenance = updateTestProvenance(workDir, opts.testSemanticAuthority, consumerBinding, {
        semanticIdentityPreserved: true
      });
      testPrepared.consumerBinding = consumerBinding;
      testPrepared.provenance = sourceAnchorProvenance;
      activeSemanticAuthorityText = testSemanticAuthorityBlock(testPrepared.active.store, testPrepared.current,
        testPrepared.publication, consumerBinding, testPrepared.active.attestation);
      testPrepared.authorityText = activeSemanticAuthorityText;
      onLog('[executor] PRODUCTION_ACTIVE source-anchor fresh state 已同步 same-version control view');
    }
    // A77：人工豁免是 human authority control view。只有上方 loadSourceAnchorExemptions 已完整校验通过
    // 的当前文件才可被 same-version binding；显式删除文件则撤销旧 binding。archive verifier 没有本 refresh seam。
    if (sourceAnchorExemptionsFreshResolved) {
      freshControlGuard.assertCurrent();
      const exemptionFile = path.join(workDir, 'source-anchor-exemptions.json');
      if (sourceAnchorExemptions.length > 0 && fs.existsSync(exemptionFile)) {
        let exemptionAlreadyBound = false;
        try {
          resolveConsumerBinding(workDir, consumerBinding, ['sourceAnchorExemptions']);
          exemptionAlreadyBound = true;
        } catch (_) { exemptionAlreadyBound = false; }
        if (!exemptionAlreadyBound) {
          consumerBinding = freshControlGuard.bind(consumerBinding,
            { sourceAnchorExemptions: 'source-anchor-exemptions.json' });
        }
      } else if (consumerBinding && consumerBinding.views && consumerBinding.views.sourceAnchorExemptions) {
        consumerBinding = pruneConsumerBindingAfterInvalidation(workDir, consumerBinding, ['source-anchor-exemptions.json']);
      }
      const exemptionProvenance = updateTestProvenance(workDir, opts.testSemanticAuthority, consumerBinding, {
        semanticIdentityPreserved: true
      });
      testPrepared.consumerBinding = consumerBinding;
      testPrepared.provenance = exemptionProvenance;
      activeSemanticAuthorityText = testSemanticAuthorityBlock(testPrepared.active.store, testPrepared.current,
        testPrepared.publication, consumerBinding, testPrepared.active.attestation);
      testPrepared.authorityText = activeSemanticAuthorityText;
      onLog('[executor] PRODUCTION_ACTIVE source-anchor exemption fresh state 已同步 same-version control view');
    }
    const activePlan = resolveConsumerBinding(workDir, consumerBinding, []);
    if (activePlan.mode !== 'semantic-bound') throw consumerAuthorityError('TEST active consumer lane unexpectedly resolved as legacy');
    if (testPrepared.reused && opts.force) {
      // Full force rerun under an unchanged semantic current starts a new presentation epoch.
      // Do not overwrite already-bound views one-by-one while durable provenance still names their old hashes:
      // a crash in that window would turn an otherwise valid same-revision session into unrecoverable provenance drift.
      const invalidatedForceViews = invalidateAfterSemanticReopen(workDir);
      consumerBinding = pruneConsumerBindingAfterInvalidation(workDir, consumerBinding, invalidatedForceViews);
      const forcePlan = resolveConsumerBinding(workDir, consumerBinding, []);
      const forceProvenance = updateTestProvenance(workDir, opts.testSemanticAuthority, consumerBinding, {
        plain: !!(forcePlan.views && forcePlan.views.reportPlain),
        readerGuide: !!(forcePlan.views && forcePlan.views.readerGuide && forcePlan.views.readerGuideHtml),
        semanticIdentityPreserved: true
      });
      testPrepared.consumerBinding = consumerBinding;
      testPrepared.provenance = forceProvenance;
      activeSemanticAuthorityText = testSemanticAuthorityBlock(testPrepared.active.store, testPrepared.current,
        testPrepared.publication, consumerBinding, testPrepared.active.attestation);
      testPrepared.authorityText = activeSemanticAuthorityText;
      if (typeof opts.onSemanticEpochCheckpoint === 'function') {
        await Promise.resolve(opts.onSemanticEpochCheckpoint({
          workDir,
          reason: 'active-force-rerun',
          oldRevision: testPrepared.current.revision,
          newRevision: testPrepared.current.revision,
          invalidated: invalidatedForceViews.slice(),
          semanticIdentity: semanticIdentity(testPrepared.current)
        }));
      }
      onLog('[executor] PRODUCTION_ACTIVE force rerun 已建立新的 presentation epoch；semantic revision 保持 ' +
        testPrepared.current.revision + '，失效旧 downstream view ' + invalidatedForceViews.length + ' 个');
    }
    if (!testPrepared.reused) {
      // Every fresh 0→1 TEST authority publication starts a durability epoch before any downstream paid request,
      // even when there were zero legacy projection files to invalidate. Otherwise a crash after authority publication
      // but before R1 can lose the new current/provenance from Web persistence and silently re-run semantic authority.
      // Node/disk callers already have durable files; Web supplies the callback to atomically replace BASE + retire old FINAL/R*.
      const invalidatedFreshViews = Array.isArray(testPrepared.invalidatedLegacyViews)
        ? testPrepared.invalidatedLegacyViews.slice()
        : [];
      const recoveredEpoch = testPrepared.recovered === true;
      if (typeof opts.onSemanticEpochCheckpoint === 'function') {
        await Promise.resolve(opts.onSemanticEpochCheckpoint({
          workDir,
          reason: recoveredEpoch ? 'recovered-active-publication' : 'initial-active-publication',
          oldRevision: recoveredEpoch && Number.isInteger(testPrepared.recoveredFromRevision)
            ? testPrepared.recoveredFromRevision
            : 0,
          newRevision: testPrepared.current.revision,
          invalidated: invalidatedFreshViews,
          semanticIdentity: semanticIdentity(testPrepared.current)
        }));
      }
      onLog('[executor] PRODUCTION_ACTIVE ' + (recoveredEpoch ? 'recovered' : 'fresh') + ' authority 已完成 semantic epoch barrier；旧 legacy projection 失效 ' + invalidatedFreshViews.length + ' 个');
    }
    onLog('[executor] semantic-first PRODUCTION_ACTIVE：review + fidelity + ONE-CAS authority 已绑定 downstream consumer lane' + (testPrepared.reused ? '（resume）' : '（fresh）'));
  }
  const results = [];
  const failFast = r => {
    results.push(r);
    if (!r.ok && !r.skipped) return true;
    return false;
  };
  // 260810 批次3（P1-B）：resume 场景 P1.md 已存在即探测新/旧合同（R2/final 判据分级用）；
  // fresh 场景 R1 通过后重算（见循环内 ③）
  const PC = require('../pipeline-controller.js');
  let newContract = PC.detectNewContractFromText(readIfExists(path.join(workDir, 'P1.md')));
  // Reopen loop control is request-identity based, not count based. Different source-grounded issues at the
  // same revision remain independently reviewable; an exact duplicate request against the same authority revision
  // is blocked before another model call. Persisted immutable issue objects reconstruct this set across resume.
  const seenGlobalReopenRequests = sfMode === 'active'
    ? collectPersistedReopenFingerprints(testPrepared.active.store, testPrepared.active.sessionId, 'global')
    : new Set();
  const seenScReopenRequests = sfMode === 'active' && scPrepared
    ? collectPersistedReopenFingerprints(scPrepared.store, TEST_SC_SESSION_ID, 'sc')
    : new Set();
  const seenFinalUpstreamReopenRequests = new Set();
  for (let roundIndex = 0; roundIndex < core.ROUNDS.length; roundIndex++) {
    const round = core.ROUNDS[roundIndex];
    if ((round.name === 'R6a' || round.name === 'R6b') && realValidate) {
      // 真实路径：R6a/R6b 由渲染器机械生成 report.html（确定性、可复现、无 LLM 超长输出风险）
      try {
        const bytes = renderReport(workDir, { consumerBinding, scAuthorityCurrentView: scPrepared && scPrepared.currentView || null });
        const PC = require('../pipeline-controller.js');
        if (consumerBinding) consumerBinding = consumerBindingFromProducedViews(workDir, consumerBinding, { report: 'report.html' });
        const reportPlan = resolveConsumerBinding(workDir, consumerBinding,
          consumerBinding ? ['report', 'adjudicatedData'] : []);
        const reportPath = consumerViewPath(workDir, reportPlan, 'report', ['report.html'], true);
        const reportData = consumerViewPath(workDir, reportPlan, 'adjudicatedData',
          ['.tmp-adjudicated-data.md', 'transition-final.md'], true);
        // 源锚层 v1（J-1）：final checkHtml 传 disclaimer（读自 source-anchor.json）——免责横幅缺失 → BLOCKING
        const sa1 = readAnchor(workDir);
        const hv = PC.checkHtml(reportPath, {
          stage: 'final',
          skillPath: resolveSkillPath(),
          dataSource: reportData,
          disclaimer: !!(sa1 && sa1.disclaimer === true)
        });
        if (hv.blocking && hv.blocking.length > 0)
          throw new Error('[executor] report.html 校验失败: ' + hv.blocking.map(b => b.message).join('; '));
        onLog('[executor] report.html 校验通过（blocking=0, warnings=' + (hv.warnings || []).length + '）');
        onLog('[executor] R6a/R6b 机械渲染 → report.html (' + bytes + 'B)');
        // P0（260901）：R6 机械渲染与 R7 白话层是两个独立阶段。
        // report.html 已通过 final gate 后必须立即把 R6a/R6b 记为成功；
        // 后续白话失败不得倒灌成“R6a 机械渲染失败”。
        results.push({ round: 'R6a', ok: true, mechanical: true });
        results.push({ round: 'R6b', ok: true, mechanical: true });
        if (typeof opts.onRound === 'function') { try { opts.onRound({ round: 'R6a', ok: true, skipped: false, mechanical: true }); } catch (e) {} }
        if (typeof opts.onRound === 'function') { try { opts.onRound({ round: 'R6b', ok: true, skipped: false, mechanical: true }); } catch (e) {} }
      } catch (e) {
        const r6Failure = { round: 'R6a', ok: false, errors: ['机械渲染失败: ' + e.message] };
        results.push(r6Failure);
        if (typeof opts.onRound === 'function') { try { opts.onRound({ round: 'R6a', ok: false, skipped: false, mechanical: true, errors: r6Failure.errors }); } catch (e2) {} }
        break;
      }
      if (opts.plain) {
        const semanticBeforePlain = sfMode === 'active'
          ? testPrepared.active.store.readCurrent(testPrepared.active.sessionId)
          : null;
        onLog('[executor] R7 白话层开始');
        if (typeof opts.onStage === 'function') { try { opts.onStage({ stage: 'R7', state: 'active', postprocess: true }); } catch (e) {} }
        try {
          if (opts.plainReplayOnly) {
            // approved replay is safe in both legacy and semantic-bound lanes because the deep helper itself
            // requires the exact bound report/reportPlain/adjudicatedData views, approved cache/proof, a 0-API
            // request fuse, contract revalidation, rollback on failure, and same-version produced-view registration.
            const replayResult = await rebuildApprovedPlainReport(workDir, cfg, opts.plainDict, { consumerBinding });
            if (consumerBinding) consumerBinding = replayResult.consumerBinding;
            onLog('[executor] R7 approved cache/proof 机械重放完成（0 API · same-version proof）');
          } else {
            const plainResult = await applyPlain(workDir, cfg, onLog, opts.plainDict, {
              cache: !opts.force,
              onBatchCheckpoint: opts.onBatchCheckpoint,
              requestCompletion: opts.requestCompletion,
              codexRunner: opts.codexRunner,
              consumerBinding
            });
            if (consumerBinding) consumerBinding = plainResult.consumerBinding;
          }
          if (sfMode === 'active') {
            assertSemanticIdentityUnchanged(semanticBeforePlain,
              testPrepared.active.store.readCurrent(testPrepared.active.sessionId), 'R7 PLAIN');
          }
          const r7Done = { round: 'R7', ok: true, postprocess: true };
          results.push(r7Done);
          if (typeof opts.onRound === 'function') { try { opts.onRound(r7Done); } catch (e2) {} }
        } catch (e) {
          const r7Failure = { round: 'R7', ok: false, postprocess: true, errors: ['白话层失败: ' + e.message] };
          results.push(r7Failure);
          if (typeof opts.onRound === 'function') { try { opts.onRound(r7Failure); } catch (e2) {} }
        }
      }
      break;
    }
    if (sfMode === 'active' && round.name === 'R3' && !semanticRoundPromptBaseline &&
        !fs.existsSync(path.join(workDir, round.outFile))) {
      const e = new Error('[executor] PRODUCTION_ACTIVE reused session cannot recompute R3 without a pristine round-prompt baseline');
      e.code = 'ERR_TEST_PROMPT_BASELINE_REQUIRED_FOR_REOPEN';
      throw e;
    }
    const r = await runRound({
      workDir, round, cfg, mockResponder: opts.mockResponder, onLog,
      force: opts.force, realValidate, newContract, sourceAnchorExemptions,
      apiStub: opts.apiStub,
      codexRunner: opts.codexRunner, consumerBinding,
      semanticFirstMode: sfMode,
      testSemanticAuthority: opts.testSemanticAuthority,
      activeSemanticAuthorityText,
      globalReviewDecision: activeGlobalReviewDecision,
      activeScAuthorityText,
      scAuthorityCurrentView: scPrepared && scPrepared.currentView || null,
      seenGlobalReopenRequests,
      seenScReopenRequests
    });
    // R3 with a semantic reopen request is not yet a cleared round result. Defer onRound/durability
    // until the independent reopen decision resolves: published reopen discards this old-revision P3;
    // blocked reopen emits an explicit R3 failure. Persisting "R3 done" here could resurrect uncleared P3 after a crash.
    const deferR2RoundEvent = sfMode === 'active' && round.name === 'R2' && !!r.scSemanticReopenRequest;
    const deferR3RoundEvent = sfMode === 'active' && round.name === 'R3' && !!(r.semanticReopenRequest || r.finalUpstreamReopenRequest);
    if (!deferR2RoundEvent && !deferR3RoundEvent && typeof opts.onRound === 'function') { try { opts.onRound(r); } catch (e) {} }
    // 260810 批次3（P1-B）：R1 通过后重算 newContract（fresh 场景 P1.md 此刻才产出）——供后续轮次使用
    if (round.name === 'R1' && r.ok) {
      newContract = PC.detectNewContractFromText(readIfExists(path.join(workDir, 'P1.md')));
    }
    if (failFast(r)) break;
    if (sfMode === 'active' && round.name === 'R2' && r.scSemanticReopenRequest) {
      const scRequestFingerprint = semanticReopenRequestFingerprint('sc', r.scSemanticReopenRequest);
      seenScReopenRequests.add(scRequestFingerprint);
      const oldScRevision = scPrepared.current.revision;
      const scReopenResult = await publishTestScReopen(workDir, testPrepared, scPrepared, r.scSemanticReopenRequest,
        Object.assign({}, opts, { cfg, onStage: opts.onStage }));
      const removed = invalidateAfterScReopen(workDir);
      consumerBinding = pruneConsumerBindingAfterInvalidation(workDir, consumerBinding, removed);
      const globalPlanAfterSc = resolveConsumerBinding(workDir, consumerBinding, []);
      updateTestProvenance(workDir, opts.testSemanticAuthority, consumerBinding, {
        plain: !!(globalPlanAfterSc.views && globalPlanAfterSc.views.reportPlain),
        readerGuide: !!(globalPlanAfterSc.views && globalPlanAfterSc.views.readerGuide && globalPlanAfterSc.views.readerGuideHtml),
        semanticIdentityPreserved: true
      });
      if (results[results.length - 1] === r) results.pop();
      if (scReopenResult.published) {
        scPrepared.current = scReopenResult.current;
        scPrepared.authority = scReopenResult.authority;
        scPrepared.currentView = scReopenResult.currentView;
        scPrepared.authorityText = scReopenResult.authorityText;
        activeScAuthorityText = scReopenResult.authorityText;
        if (typeof opts.onScSemanticEpochCheckpoint === 'function') {
          await Promise.resolve(opts.onScSemanticEpochCheckpoint({
            workDir,
            reason: 'r2-sc-reopen',
            oldRevision: oldScRevision,
            newRevision: scReopenResult.current.revision,
            invalidated: removed.slice(),
            globalSemanticRevision: testPrepared.current.revision,
            sourceSha256: scReopenResult.current.sourceSha256
          }));
        }
        results.push({ round: 'SC-SEMANTIC-REOPEN', ok: true, oldRevision: oldScRevision,
          newRevision: scReopenResult.current.revision, invalidated: removed });
        onLog('[executor] R2 SC reopen 已由独立 SC review/fidelity + CAS 发布 revision ' + oldScRevision + '→' +
          scReopenResult.current.revision + '；P1/global semantic 保持，R2→下游失效并从 R2 重跑');
        roundIndex = 0;
        continue;
      }
      const blockedMessage = 'R2 SC semantic reopen 未获独立 publication 批准；旧 SC authority 保持，提出异议的 P2 未获 clearance，已失效 R2→R8';
      r.ok = false;
      r.errors = [blockedMessage];
      r.scSemanticReopenBlocked = true;
      results.push(r);
      results.push({ round: 'SC-SEMANTIC-REOPEN', ok: false, currentRevision: oldScRevision,
        invalidated: removed, status: scReopenResult.status, errors: [blockedMessage] });
      if (typeof opts.onRound === 'function') { try { opts.onRound(r); } catch (_) {} }
      onLog('[executor] ' + blockedMessage);
      break;
    }
    if (sfMode === 'active' && round.name === 'R3' && r.finalUpstreamReopenRequest) {
      const request = r.finalUpstreamReopenRequest;
      if (!semanticRoundPromptBaseline) {
        const e = new Error('[executor] C-R upstream reopen requires pristine round-prompt baseline');
        e.code = 'ERR_FINAL_UPSTREAM_REOPEN_BASELINE';
        throw e;
      }
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify({
        target_owner: request.target_owner,
        target_ref: request.target_ref,
        reason: request.reason,
        global_revision: testPrepared.current.revision,
        sc_revision: scPrepared.current.revision
      }), 'utf8').digest('hex');
      if (seenFinalUpstreamReopenRequests.has(fingerprint)) {
        const message = 'C-R upstream reopen repeated after its declared owner was already rerun; unresolved local-truth dispute requires explicit inspection';
        r.ok = false;
        r.errors = [message];
        if (typeof opts.onRound === 'function') { try { opts.onRound(r); } catch (_) {} }
        onLog('[executor] ' + message);
        break;
      }
      seenFinalUpstreamReopenRequests.add(fingerprint);
      const reopened = invalidateAfterFinalUpstreamReopen(workDir, request);
      consumerBinding = pruneConsumerBindingAfterInvalidation(workDir, consumerBinding, reopened.removed);
      const reopenedPlan = resolveConsumerBinding(workDir, consumerBinding, []);
      const reopenedProvenance = updateTestProvenance(workDir, opts.testSemanticAuthority, consumerBinding, {
        plain: !!(reopenedPlan.views && reopenedPlan.views.reportPlain),
        readerGuide: !!(reopenedPlan.views && reopenedPlan.views.readerGuide && reopenedPlan.views.readerGuideHtml),
        semanticIdentityPreserved: true
      });
      testPrepared.consumerBinding = consumerBinding;
      testPrepared.provenance = reopenedProvenance;
      activeSemanticAuthorityText = testSemanticAuthorityBlock(testPrepared.active.store, testPrepared.current,
        testPrepared.publication, consumerBinding, testPrepared.active.attestation);
      testPrepared.authorityText = activeSemanticAuthorityText;
      const restoredPrompts = restoreRoundPromptBaseline(workDir, semanticRoundPromptBaseline);
      if (results[results.length - 1] === r) results.pop();
      const markerResult = {
        round: 'FINAL-UPSTREAM-REOPEN', ok: true, targetOwner: reopened.owner,
        targetRef: request.target_ref, reason: request.reason,
        invalidated: reopened.removed, restoredPrompts
      };
      results.push(markerResult);
      if (typeof opts.onRound === 'function') { try { opts.onRound(markerResult); } catch (_) {} }
      onLog('[executor] C-R final 拒绝静默改写 local clash；已回开 owner=' + reopened.owner +
        '，失效 downstream ' + reopened.removed.length + ' 个并重跑');
      newContract = PC.detectNewContractFromText(readIfExists(path.join(workDir, 'P1.md')));
      const targetIndex = core.ROUNDS.findIndex(x => x.name === reopened.owner);
      roundIndex = targetIndex - 1;
      continue;
    }
    if (r.consumerBinding) consumerBinding = r.consumerBinding;
    if (sfMode === 'active' && round.name === 'R3' && r.semanticReopenRequest) {
      const globalRequestFingerprint = semanticReopenRequestFingerprint('global', r.semanticReopenRequest);
      seenGlobalReopenRequests.add(globalRequestFingerprint);
      if (!semanticRoundPromptBaseline) {
        const e = new Error('[executor] PRODUCTION_ACTIVE semantic reopen refused before CAS: pristine round-prompt baseline unavailable');
        e.code = 'ERR_TEST_PROMPT_BASELINE_REQUIRED_FOR_REOPEN';
        throw e;
      }
      const beforeCurrent = testPrepared.active.store.readCurrent(testPrepared.active.sessionId);
      const reopenResult = await publishTestR3Reopen(workDir, testPrepared, r.semanticReopenRequest,
        Object.assign({}, opts, { cfg }));
      let provenance = readTestProvenance(workDir) || testPrepared.provenance;
      if (reopenResult.published) {
        const oldRevision = beforeCurrent.revision;
        consumerBinding = reopenResult.consumerBinding;
        // BBG1-007 promoted source: a semantic reopen changes semantic/projection identity, but does not invalidate
        // host-fresh control inputs from this same live run. Rebind only controls that were freshly resolved by
        // the host; never inherit archive-declared control bytes or relax the downstream sourceAnchor requirement.
        freshControlGuard.assertCurrent();
        if ((opts.sourceAnchorFreshResolved === true || hostSourceAnchorFreshResolved) &&
            fs.existsSync(path.join(workDir, 'source-anchor.json'))) {
          consumerBinding = freshControlGuard.bind(consumerBinding, { sourceAnchor: 'source-anchor.json' });
        }
        if (sourceAnchorExemptionsFreshResolved && sourceAnchorExemptions.length > 0 &&
            fs.existsSync(path.join(workDir, 'source-anchor-exemptions.json'))) {
          consumerBinding = freshControlGuard.bind(consumerBinding,
            { sourceAnchorExemptions: 'source-anchor-exemptions.json' });
        }
        // Rebinding changes viewRevision/versionKey, so the authority wrapper must be regenerated from the
        // rebound consumer binding before any new-revision downstream request is emitted.
        activeSemanticAuthorityText = testSemanticAuthorityBlock(testPrepared.active.store, reopenResult.current,
          reopenResult.publication, consumerBinding, testPrepared.active.attestation);
        // Crash-safe ordering is intentional: after CAS publishes the new semantic current, invalidate every
        // old downstream view before writing a provenance receipt that validates the new revision. If the
        // process dies before provenance replacement, the previous receipt mismatches current and resume
        // fails closed; it can never observe new-current + new-provenance + old-projection as a valid state.
        const removed = invalidateAfterSemanticReopen(workDir);
        const restoredPrompts = restoreRoundPromptBaseline(workDir, semanticRoundPromptBaseline);
        const nextProvenance = buildTestProvenance(testPrepared.active, reopenResult.publication, consumerBinding, provenance, {
          plain: false,
          readerGuide: false,
          semanticIdentityPreserved: true
        });
        nextProvenance.reopens.push({
          status: 'published',
          requestedRevision: r.semanticReopenRequest.expectedRevision,
          oldRevision,
          newRevision: reopenResult.current.revision,
          issue: r.semanticReopenRequest.issue,
          evidence: r.semanticReopenRequest.evidence,
          issueRef: reopenResult.publication.refs.reopenIssueRef,
          reviewRef: reopenResult.publication.refs.reviewRef,
          fidelityRef: reopenResult.publication.refs.fidelityRef,
          commitRef: reopenResult.publication.refs.commitRef || null
        });
        validateTestProvenance(workDir, testPrepared.active, reopenResult.current, nextProvenance);
        writeTestProvenance(workDir, nextProvenance);
        provenance = nextProvenance;
        testPrepared.current = reopenResult.current;
        activeGlobalReviewDecision = verifiedCurrentGlobalReviewDecision(testPrepared.active.store, reopenResult.current, testPrepared.active.binding.sourceText);
        testPrepared.consumerBinding = consumerBinding;
        testPrepared.publication = reopenResult.publication;
        testPrepared.provenance = provenance;
        // Global semantic revision changed: the previous SC authority is no longer bound to the current global
        // understanding. Re-run the independent whole-debate SC audit against the new global semantic before R1.
        scPrepared = await prepareTestScAuthority(workDir, testPrepared, Object.assign({}, opts, {
          cfg,
          onStage: opts.onStage
        }));
        activeScAuthorityText = scPrepared.authorityText;
        if (typeof opts.onScSemanticEpochCheckpoint === 'function') {
          await Promise.resolve(opts.onScSemanticEpochCheckpoint({
            workDir,
            reason: 'global-semantic-rebind',
            newRevision: scPrepared.current.revision,
            globalSemanticRevision: reopenResult.current.revision,
            sourceSha256: scPrepared.current.sourceSha256
          }));
        }
        // PRODUCTION_ACTIVE crash-safety barrier：新 semantic current 已发布后，旧 projection 不能只在内存里删除。
        // Web 必须在下一笔 paid request 前原子开启新 persistence epoch（新 BASE + 退役全部旧 FINAL/R*）。
        // 否则崩溃恢复可能把旧 P1/P2/P3 从较晚 round checkpoint 复活，再被错误重贴到新 revision。
        if (typeof opts.onSemanticEpochCheckpoint === 'function') {
          await Promise.resolve(opts.onSemanticEpochCheckpoint({
            workDir,
            reason: 'r3-reopen',
            oldRevision,
            newRevision: reopenResult.current.revision,
            invalidated: removed.slice(),
            restoredPrompts: restoredPrompts.slice(),
            semanticIdentity: semanticIdentity(reopenResult.current)
          }));
        }
        // New semantic revision = new in-memory run epoch. Old R1-R3 outcomes must not pollute
        // final status/gate history for the rerun. Keep only the reopen audit marker, then record new R1+.
        results.length = 0;
        onLog('[executor] R3 semantic reopen 已经独立 review/fidelity + ONE-CAS 发布 revision ' + oldRevision + '→' + reopenResult.current.revision +
          '；旧 projection 已失效、' + restoredPrompts.length + ' 个 round prompt 已恢复 pristine baseline，并完成 reopen durability barrier 后从 R1 重跑');
        results.push({ round: 'SEMANTIC-REOPEN', ok: true, oldRevision, newRevision: reopenResult.current.revision, invalidated: removed, restoredPrompts });
        newContract = false;
        roundIndex = -1;
        continue;
      }
      // A reopen request means this P3 explicitly questioned the current authority. If independent
      // review/fidelity does not publish a replacement, that P3 is not cleared to represent the old
      // authority either. Invalidate R3→R8, preserve already-bound R1/R2/R2.5, record the blocked audit,
      // then fail closed so the next recovery must regenerate R3 under the unchanged current.
      const blockedRemoved = invalidateBlockedR3Projection(workDir);
      consumerBinding = pruneConsumerBindingAfterInvalidation(workDir, consumerBinding, blockedRemoved);
      const blockedPlan = resolveConsumerBinding(workDir, consumerBinding, []);
      const blockedProvenance = JSON.parse(JSON.stringify(provenance));
      blockedProvenance.consumerBinding = consumerBinding;
      blockedProvenance.presentation = Object.assign({}, blockedProvenance.presentation || {}, {
        plain: !!(blockedPlan.views && blockedPlan.views.reportPlain),
        readerGuide: !!(blockedPlan.views && blockedPlan.views.readerGuide && blockedPlan.views.readerGuideHtml),
        semanticIdentityPreserved: true
      });
      blockedProvenance.reopens = Array.isArray(blockedProvenance.reopens) ? blockedProvenance.reopens : [];
      blockedProvenance.reopens.push({
        status: 'blocked',
        requestedRevision: r.semanticReopenRequest.expectedRevision,
        currentRevision: beforeCurrent.revision,
        issue: r.semanticReopenRequest.issue,
        evidence: r.semanticReopenRequest.evidence,
        publicationStatus: reopenResult.publication && reopenResult.publication.status || 'unknown',
        issueRef: reopenResult.publication && reopenResult.publication.refs && reopenResult.publication.refs.reopenIssueRef || null,
        invalidated: blockedRemoved
      });
      validateTestProvenance(workDir, testPrepared.active, beforeCurrent, blockedProvenance);
      writeTestProvenance(workDir, blockedProvenance);
      provenance = blockedProvenance;
      testPrepared.consumerBinding = consumerBinding;
      testPrepared.provenance = provenance;
      const blockedMessage = 'R3 semantic reopen 未获独立 publication 批准；该 P3 未获 authority clearance，已失效 R3→R8 并要求从 R3 恢复';
      r.ok = false;
      r.errors = [blockedMessage];
      r.semanticReopenBlocked = true;
      if (typeof opts.onRound === 'function') {
        try { opts.onRound({ round: 'R3', ok: false, skipped: false, errors: r.errors, semanticReopenBlocked: true }); } catch (e) {}
      }
      results.push({ round: 'SEMANTIC-REOPEN', ok: false, currentRevision: beforeCurrent.revision, invalidated: blockedRemoved, errors: [blockedMessage] });
      onLog('[executor] ' + blockedMessage);
      break;
    }
    if (consumerBinding && r.ok && !r.skipped && round.outFile && fs.existsSync(path.join(workDir, round.outFile))) {
      const viewName = testRoundBoundViewName(round);
      if (viewName) consumerBinding = consumerBindingFromProducedViews(workDir, consumerBinding, { [viewName]: round.outFile });
    }
    if (round.name === 'R1') { buildR2Prompt(workDir, onLog); buildR25Prompt(workDir, onLog); }   // P6：R2/R2.5 读 P1
    if (round.name === 'R2.5') buildR3Prompt(workDir, onLog, { consumerBinding, activeSemanticAuthorityText, scAuthorityCurrentView: scPrepared && scPrepared.currentView || null });
    if (round.name === 'R3') {
      if (sfMode === 'active') {
        const p3Plan = resolveConsumerBinding(workDir, consumerBinding, ['P3']);
        const p3Path = consumerViewPath(workDir, p3Plan, 'P3', ['P3.md'], true);
        const p3Text = fs.readFileSync(p3Path, 'utf8');
        const finalAuthority = ensureFinalAdjudicationAuthority(
          workDir,
          p3Text,
          consumerBinding,
          scPrepared && scPrepared.currentView || null,
          activeGlobalReviewDecision
        );
        if (!finalAuthority.published) throw consumerAuthorityError('C-R final authority not publishable before upstream reopen');
        consumerBinding = consumerBindingFromProducedViews(workDir, consumerBinding, {
          finalAdjudication: 'final-adjudication.json',
          finalAdjudicationReceipt: 'final-adjudication-receipt.json'
        });
        const finalPlan = resolveConsumerBinding(workDir, consumerBinding, ['P3', 'finalAdjudication', 'finalAdjudicationReceipt']);
        const finalProvenance = updateTestProvenance(workDir, opts.testSemanticAuthority, consumerBinding, {
          plain: !!(finalPlan.views && finalPlan.views.reportPlain),
          readerGuide: !!(finalPlan.views && finalPlan.views.readerGuide && finalPlan.views.readerGuideHtml),
          semanticIdentityPreserved: true,
          finalRevision: finalAuthority.finalRevision
        });
        testPrepared.consumerBinding = consumerBinding;
        testPrepared.provenance = finalProvenance;
        activeSemanticAuthorityText = testSemanticAuthorityBlock(testPrepared.active.store, testPrepared.current,
          testPrepared.publication, consumerBinding, testPrepared.active.attestation);
        testPrepared.authorityText = activeSemanticAuthorityText;
        onLog('[executor] C-R final authority 已发布并绑定 final_revision=' + finalAuthority.finalRevision);
      }
      buildTransitionFinal(workDir, onLog, realValidate, {
        consumerBinding,
        semanticAuthorityBoundary: sfMode === 'active' ? 'semantic-first-v10' : null
      });       // A8-ERR-1 C8：渲染必需输入
      if (consumerBinding) consumerBinding = consumerBindingFromProducedViews(workDir, consumerBinding, { transition: 'transition-final.md' });
      buildR4Prompt(workDir, onLog, { consumerBinding });                            // P6：R4 读 P2
    }
    if (round.name === 'R4') {
      buildFullData(workDir, onLog, { consumerBinding });
      if (consumerBinding) consumerBinding = consumerBindingFromProducedViews(workDir, consumerBinding, { fullData: 'full-data.md' });
      if (!consumerBinding) enrichR5Prompts(workDir, onLog);     // legacy：维持旧时序；semantic-bound 等 R4.5 后直接注入 adjudicated views
      // 3B：R4 重跑 → 旧 R4.5 产物失效；随后构建 R4.5 输入并注入 prompt
      if (!r.skipped) {
        for (const f of ['adjudication.json', '.tmp-adjudication.json', '.tmp-adjudicated-data.md', '.tmp-adjudicated-structure.json']) {
          const fp = path.join(workDir, f);
          if (fs.existsSync(fp)) { try { fs.unlinkSync(fp); } catch (e) {} }
        }
      }
      const preserveBoundR45Parent = !!(r.skipped && consumerBinding && consumerBinding.views && consumerBinding.views.adjudication);
      if (preserveBoundR45Parent) {
        // Targeted downstream resume (e.g. R5+) preserves R4/R4.5 as one presentation epoch.
        // Never rewrite the parent input/sidecar merely because the loop passed a skipped R4;
        // the existing R4.5 checkpoint must later prove its original parent lineage byte-for-byte.
        onLog('[executor] R4 skipped + R4.5 already bound：保留既有 R4.5 parent lineage，不重写 input/sidecar');
      } else {
        buildAdjudicationInput(workDir, onLog, realValidate, {
          consumerBinding,
          semanticAuthorityBoundary: sfMode === 'active' ? 'semantic-first-v10' : null
        });
        const r45Plan = resolveConsumerBinding(workDir, consumerBinding, []);
        injectDataSource(workDir, '.tmp-R4.5-prompt.md', 'R4.5 输入汇总表（唯一数据源）', path.join(workDir, '.tmp-r45-input.md'), onLog,
          r45Plan.mode === 'semantic-bound' ? { bindingVersionKey: r45Plan.versionKey } : null);
      }
    }
    if (round.name === 'R4.5' && r.ok) {
      // T7：mock 不跑正式机械复核；仍需物化与正式链同形的“裁决后视图”，
      // 供默认 Web R8 冒烟消费。这里只做既有 adjudication 的确定性 merge，不把 mock 升格为正式语义校验。
      if (!realValidate) {
        if (r.skipped && consumerBinding) {
          const skippedPlan = resolveConsumerBinding(workDir, consumerBinding,
            ['transition', 'structure', 'adjudication', 'adjudicatedData', 'adjudicatedStructure']);
          const skippedAdjPath = consumerViewPath(workDir, skippedPlan, 'adjudication', ['adjudication.json'], true);
          const skippedParsed = parseAdjArtifact(fs.readFileSync(skippedAdjPath, 'utf-8'));
          if (!skippedParsed.ok) throw consumerAuthorityError('skipped R4.5 adjudication 解析失败: ' + skippedParsed.error);
          assertR45AdjudicationInputBinding(workDir, skippedParsed.obj, consumerBinding);
          const skippedForbidden = legacySemanticAdjudicationConflicts(skippedParsed.obj && skippedParsed.obj.conflicts);
          if (skippedForbidden.length) {
            throw consumerAuthorityError('skipped mock semantic-bound adjudication 含 legacy semantic conflict: ' +
              skippedForbidden.map(x => x.dimension).join('; '));
          }
          onLog('[executor] R4.5 skipped：仅验证既有 parent lineage / bound adjudicated views，不重写 checkpoint');
        } else {
        const adj = path.join(workDir, 'adjudication.json');
        const tmpAdj = path.join(workDir, '.tmp-adjudication.json');
        if (fs.existsSync(adj) && !fs.existsSync(tmpAdj)) fs.copyFileSync(adj, tmpAdj);
        if (fs.existsSync(adj)) {
          const parsed = parseAdjArtifact(fs.readFileSync(adj, 'utf-8'));
          if (parsed.ok) {
            const mockBindingPlan = resolveConsumerBinding(workDir, consumerBinding,
              consumerBinding ? ['transition', 'structure', 'adjudication'] : []);
            const mockAuthorityPlan = consumerBinding
              ? PC.planAdjudicationAuthority({ binding: consumerBinding, mutationKind: 'projection_repair', requiredViews: ['transition', 'structure', 'adjudication'] })
              : null;
            if (mockAuthorityPlan && !mockAuthorityPlan.allowed) throw consumerAuthorityError(mockAuthorityPlan.blockingReason);
            if (mockBindingPlan.mode === 'semantic-bound') {
              const forbidden = legacySemanticAdjudicationConflicts(parsed.obj && parsed.obj.conflicts);
              if (forbidden.length) {
                throw consumerAuthorityError('mock semantic-bound adjudication 含 legacy semantic conflict: ' +
                  forbidden.map(x => x.dimension).join('; '));
              }
              stampR45AdjudicationInputBinding(workDir, parsed.obj, consumerBinding, { outputAlreadyRegistered: true });
              fs.writeFileSync(adj, JSON.stringify(parsed.obj, null, 2), 'utf8');
              fs.writeFileSync(tmpAdj, JSON.stringify(parsed.obj, null, 2), 'utf8');
            }
            const tfPath = consumerViewPath(workDir, mockBindingPlan, 'transition', ['transition-final.md'], true);
            const stPath = consumerViewPath(workDir, mockBindingPlan, 'structure', ['structure.json'], true);
            if (fs.existsSync(tfPath)) {
              let mergedMockData = PC.mergeAdjudicationData(fs.readFileSync(tfPath, 'utf-8'), parsed.obj,
                mockAuthorityPlan ? { authorityPlan: mockAuthorityPlan } : undefined);
              // R8 的读者锚点必须来自“关键CP逐回合轨迹”。正式路径由真实 R3/R4.5 数据提供；
              // mock 若没有该表，只为浏览器完整冒烟追加固定测试锚点，不进入真实 Judge 语义。
              if (!/<!--DATA:\s*S11\.类型=/.test(mergedMockData)) {
                mergedMockData += '\n<!--DATA: S11.类型=1b -->\n';
              }
              if (!mergedMockData.includes('**关键CP逐回合轨迹**')) {
                mergedMockData += '\n\n**关键CP逐回合轨迹**\n\n' +
                  '| CP-ID | 回合 | 发言方 | 动作 | 该点临时状态 | 辩词引用 |\n' +
                  '|---|---|---|---|---|---|\n' +
                  '| CP-3 | 1 | 反二 | 攻击 | 被削弱 | “mock 反方攻击引文” |\n' +
                  '| CP-3 | 2 | 正三 | 回应 | 被击穿 | “mock 正方回应引文” |\n' +
                  '| CP-6 | 1 | 反三 | 攻击 | 被削弱 | “mock 第二攻击引文” |\n' +
                  '| CP-6 | 2 | 正四 | 回应 | 被击穿 | “mock 第二回应引文” |\n';
              }
              fs.writeFileSync(path.join(workDir, '.tmp-adjudicated-data.md'), mergedMockData, 'utf-8');
            }
            if (fs.existsSync(stPath)) {
              try {
                const stObj = PC.parseStructureJson(fs.readFileSync(stPath, 'utf-8'));
                fs.writeFileSync(path.join(workDir, '.tmp-adjudicated-structure.json'),
                  JSON.stringify(PC.mergeStructureOverride(stObj, parsed.obj,
                    mockAuthorityPlan ? { authorityPlan: mockAuthorityPlan } : undefined), null, 2), 'utf-8');
              } catch (e) { onLog('[executor] mock 裁决后 structure 视图物化跳过: ' + e.message); }
            }
          }
        }
        }
      }
      if (consumerBinding && !r.skipped && fs.existsSync(path.join(workDir, '.tmp-adjudicated-data.md')) &&
          fs.existsSync(path.join(workDir, '.tmp-adjudicated-structure.json')) &&
          fs.existsSync(path.join(workDir, 'adjudication.json'))) {
        consumerBinding = consumerBindingFromProducedViews(workDir, consumerBinding, {
          adjudicatedData: '.tmp-adjudicated-data.md',
          adjudicatedStructure: '.tmp-adjudicated-structure.json',
          adjudication: 'adjudication.json'
        });
      }
      if (consumerBinding) enrichR5Prompts(workDir, onLog, { consumerBinding });
      injectAdjudication(workDir, onLog, realValidate, {
        consumerBinding,
        semanticAuthorityBoundary: sfMode === 'active' ? 'semantic-first-v10' : null
      });
    }
    if (round.name === 'R5B') {
      mergeNarrative(workDir, onLog);
      if (consumerBinding) consumerBinding = consumerBindingFromProducedViews(workDir, consumerBinding, { narrative: '叙事.md' });
      const PC = require('../pipeline-controller.js');
      const narrPlan = resolveConsumerBinding(workDir, consumerBinding,
        consumerBinding ? ['adjudicatedData', 'narrative'] : []);
      const narrativePath = consumerViewPath(workDir, narrPlan, 'narrative', ['叙事.md'], true);
      const narrativeData = consumerViewPath(workDir, narrPlan, 'adjudicatedData',
        ['.tmp-adjudicated-data.md', 'transition-final.md'], true);
      const nv = PC.checkNarrative(narrativePath, {
        skillPath: resolveSkillPath(),
        dataSource: narrativeData
      });
      if (!nv.passed) {
        results.push({ round: 'R5-FINAL', ok: false, errors: [nv.message] });
        break;
      }
      onLog('[executor] 叙事.md 最终校验通过（12 模块 + C7 计数）');
      continue;
    }
  }
  // mock 路径：R6a/R6b 走 runRound 占位产物，但 severe source-anchor 的 fixed disclaimer 仍必须
  // 机械兑现。A114：先把 canonical fixed banner 写入最终 mock report bytes，再注册 consumerBinding；
  // 禁止通过放宽 final checkHtml(disclaimer=true) 来让 mock 绕过正式 H2-DISCLAIMER gate。
  if (!realValidate && fs.existsSync(path.join(workDir, 'report.html'))) {
    const PC = require('../pipeline-controller.js');
    const mockReportFile = path.join(workDir, 'report.html');
    const sa2 = readAnchor(workDir);
    if (sa2 && sa2.disclaimer === true) {
      const HC = require('../scripts/html-contract.js');
      let mockHtml = fs.readFileSync(mockReportFile, 'utf8');
      if (!mockHtml.includes(HC.DISCLAIMER_TEXT)) {
        mockHtml = mockHtml.replace(/<body([^>]*)>/i, function (openBody) {
          return openBody + '<div class="disclaimer-banner" data-fixed-text="1">⚠️ ' + HC.DISCLAIMER_TEXT + '</div>';
        });
        if (!mockHtml.includes(HC.DISCLAIMER_TEXT)) {
          throw new Error('[executor] mock report disclaimer 注入失败：缺少可写 body/canonical DISCLAIMER_TEXT');
        }
        fs.writeFileSync(mockReportFile, mockHtml, 'utf8');
        onLog('[executor] mock report severe-anchor canonical disclaimer 已机械注入');
      }
    }
    if (consumerBinding) consumerBinding = consumerBindingFromProducedViews(workDir, consumerBinding, { report: 'report.html' });
    const mockReportPlan = resolveConsumerBinding(workDir, consumerBinding,
      consumerBinding ? ['report', 'adjudicatedData'] : []);
    const mockReportPath = consumerViewPath(workDir, mockReportPlan, 'report', ['report.html'], true);
    const mockDataPath = consumerViewPath(workDir, mockReportPlan, 'adjudicatedData',
      ['.tmp-adjudicated-data.md', 'transition-final.md'], true);
    const hv = PC.checkHtml(mockReportPath, {
      stage: 'final',
      skillPath: resolveSkillPath(),
      dataSource: mockDataPath,
      disclaimer: !!(sa2 && sa2.disclaimer === true)
    });
    if (hv.blocking && hv.blocking.length > 0)
      results.push({ round: 'R6-FINAL', ok: false, errors: hv.blocking.map(b => b.message) });
    else
      onLog('[executor] report.html 校验通过（blocking=0, warnings=' + (hv.warnings || []).length + '）');
  }
  // R7 阶段 2：白话层接线仅属 mock 链路（真实路径已在 R6a 机械渲染内 L920 执行，防双跑）；
  // 失败即终止语义（缺陷 G，260812）：任一失败轮次存在时不执行收口步骤——
  // 否则 applyPlain 读不存在的 report.html → ENOENT throw 遮蔽真实失败（CLI 只见 [pipeline run] ENOENT）
  if (opts.plain && !realValidate) {
    if (results.every(r => r.ok)) {
      const semanticBeforeMockPlain = sfMode === 'active'
        ? testPrepared.active.store.readCurrent(testPrepared.active.sessionId)
        : null;
      if (opts.plainReplayOnly) {
        const replayResult = await rebuildApprovedPlainReport(workDir, cfg, opts.plainDict, { consumerBinding });
        if (consumerBinding) consumerBinding = replayResult.consumerBinding;
        onLog('[executor] R7 approved cache/proof 机械重放完成（mock/0 API · same-version proof）');
      } else {
        const plainResult = await applyPlain(workDir, cfg, onLog, opts.plainDict, {
          cache: !opts.force,
          onBatchCheckpoint: opts.onBatchCheckpoint,
          requestCompletion: opts.requestCompletion,
          codexRunner: opts.codexRunner,
          consumerBinding
        });
        if (consumerBinding) consumerBinding = plainResult.consumerBinding;
      }
      if (sfMode === 'active') {
        assertSemanticIdentityUnchanged(semanticBeforeMockPlain,
          testPrepared.active.store.readCurrent(testPrepared.active.sessionId), 'R7 PLAIN mock');
      }
      results.push({ round: 'R6-PLAIN', ok: true, mock: true });
    } else {
      onLog('[executor] R6-PLAIN 跳过：管道存在失败轮次（失败即终止，不执行白话层收口，保留真实错误）');
    }
  }
  let semanticProvenance = null;
  if (sfMode === 'active' && testPrepared) {
    const finalBindingPlan = resolveConsumerBinding(workDir, consumerBinding, []);
    semanticProvenance = updateTestProvenance(workDir, opts.testSemanticAuthority, consumerBinding, {
      plain: !!(finalBindingPlan.views && finalBindingPlan.views.reportPlain),
      readerGuide: !!(finalBindingPlan.views && finalBindingPlan.views.readerGuide && finalBindingPlan.views.readerGuideHtml),
      semanticIdentityPreserved: true
    });
  }
  return { ok: results.every(r => r.ok), results, consumerBinding, semanticFirstMode: sfMode, semanticProvenance };
}

function readerGuideContractIdentity() {
  const RG = require('../scripts/reader-guide.js');
  return {
    schemaVersion: RG.SCHEMA_VERSION,
    promptVersion: RG.PROMPT_VERSION,
    reviewPromptVersion: RG.REVIEW_PROMPT_VERSION,
    plainSchemaVersion: RG.PLAIN_SCHEMA_VERSION,
    plainPromptVersion: RG.PLAIN_PROMPT_VERSION
  };
}

module.exports = { stableStructuralJson, structuralJsonEqual, roundRepairPlan, r5ChapterRanges, buildR5BoundedRepairPrompt, parseR5BoundedRepair, mergeR5BoundedRepair, runRound, runPipeline, resolveActiveSemanticAuthority, buildFullData, buildR3Prompt, buildR25Prompt, buildR2Prompt, buildR4Prompt, enrichR5Prompts, injectDataSource, assertPromptsWithinContext, resolveSkillPath, mergeNarrative, buildTransitionFinal, renderReport, loadFileConfig, validateRound, validateR3FinalOwnedPreview, goodMockResponder, sleep, adjudicationRecheck, buildAdjudicationInput, translateUnitsLLM, reviewPlainUnits, applyPlain, rebuildApprovedPlainReport, refreshPlainArtifacts, regeneratePlainV2Artifacts, applyReaderGuide, embedVerifiedReaderGuide, loadPlainDict, injectAdjudication, parseAdjArtifact, loadSourceAnchorExemptions, warningsForAdjudication, adjudicationConflictExclusions, legacySemanticAdjudicationConflicts, writeR45InputBinding, stampR45AdjudicationInputBinding, assertR45AdjudicationInputBinding, assertSourceAnchorExemptionArtifactBinding, verifiedV5ReviewDecision, verifiedCurrentGlobalReviewDecision, checkFiniteNetWinnerAlignment, buildFinalAdjudicationBindings, checkFinalAdjudicationAlignment, ensureFinalAdjudicationAuthority, verifyFinalAdjudicationAuthority, semanticFirstMode, semanticShadowRoot, createSemanticSidecarStore, createTestActiveWorkflow, prepareTestSemanticAuthority, buildSemanticConsumerBinding, testSemanticAuthorityBlock, buildTestProvenance, validateTestProvenance, updateTestProvenance, readTestProvenance, writeTestProvenance, semanticIdentity, assertSemanticIdentityUnchanged, readTestSemanticCurrent, semanticReopenRequestFingerprint, duplicateReopenProjectionGate, collectPersistedReopenFingerprints, validateGlobalReopenHistory, extractSemanticReopenRequest, publishTestR3Reopen, invalidateAfterSemanticReopen, invalidateBlockedR3Projection, pruneConsumerBindingAfterInvalidation, captureRoundPromptBaseline, restoreRoundPromptBaseline, resolveConsumerBinding, consumerViewPath, validationConsumerViewPath, validationConsumerViewText, consumerBindingFromProducedViews, readerGuidePaths, buildReaderGuideInputFromWorkDir, prepareTestScAuthority, publishTestScReopen, validateScRequestReceipt, validateScCurrentChain, buildScProvenance, validateScProvenance, readScProvenance, writeScProvenance, invalidateAfterScReopen, scGlobalBinding, buildScCurrentView, readerGuideContractIdentity };
