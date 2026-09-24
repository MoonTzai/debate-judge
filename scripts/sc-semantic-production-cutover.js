'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const defaultRouter = require('./sc-semantic-default-router.js');
const defaultPilot = require('./sc-semantic-pilot.js');

const BROADER_RELATIVE = defaultRouter.BROADER_RELATIVE || path.join(
  'Upload',
  '辩词资料库-第三方学术语料',
  'local-test-cases',
  'S4B-broader-v2'
);
const STATE_NAME = 'S4B-Production-Cutover-State.private.json';
const LOCK_NAME = 'S4B-Production-Cutover-State.private.lock';
const STATE_SCHEMA = 's4b-production-cutover-state-v1';

const EXPECTED_ROUTER_STATE_SHA256 = '741096a7071b636c7c0ff73d21480f8288d85d740be84eda170d64874e10be43';
const EXPECTED_ROUTER_REVISION = 2;
const EXPECTED_REPAIRED_PROFILE_ID = 'P4-candidate-targeted-role-calibration-finite-net-20260909';
const EXPECTED_REPAIRED_BUNDLE_SHA256 = '5dfaea66118861f82c77ed1f473a2fae14de1fb70b1f181ccf94c256e24b377f';

function prodError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}
function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function canonicalJson(value) { return JSON.stringify(value, null, 2) + '\n'; }

function resolveInside(root, relative, label) {
  const base = path.resolve(root || process.cwd());
  const absolute = path.resolve(base, relative);
  if (absolute !== base && !absolute.startsWith(base + path.sep)) {
    throw prodError('S4B_PROD_STATE_PATH_ESCAPE', (label || 'path') + ' escaped workspace');
  }
  return absolute;
}
function fsyncFile(file) {
  const fd = fs.openSync(file, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function normalizeRouterStatus(value) {
  value = value || {};
  return {
    state_sha256: value.state_sha256 || null,
    revision: Number(value.revision || 0),
    default_profile_key: value.default_profile_key || null,
    default_profile_id: value.default_profile_id || null,
    default_profile_sha256: value.default_profile_sha256 || null,
    rollback_ready: value.rollback_ready === true,
    rollback_performed: value.rollback_performed === true,
    default_switch: value.default_switch === true,
    production_profile_mutation: value.production_profile_mutation === true,
    production_cutover: value.production_cutover === true,
    paid_call: value.paid_call === true,
    s4b: value.s4b || null
  };
}
function validateRepairedRouter(routerStatus) {
  const r = normalizeRouterStatus(routerStatus);
  if (
    r.state_sha256 !== EXPECTED_ROUTER_STATE_SHA256 ||
    r.revision !== EXPECTED_ROUTER_REVISION ||
    r.default_profile_key !== 'repaired' ||
    r.default_profile_id !== EXPECTED_REPAIRED_PROFILE_ID ||
    r.default_profile_sha256 !== EXPECTED_REPAIRED_BUNDLE_SHA256 ||
    r.rollback_ready !== true ||
    r.rollback_performed !== false ||
    r.default_switch !== true ||
    r.production_profile_mutation !== false ||
    r.production_cutover !== false ||
    r.paid_call !== false ||
    r.s4b !== 'HOLD'
  ) throw prodError('S4B_PROD_ROUTER_NOT_REPAIRED_EXACT', 'Production active authorization requires the exact repaired Router snapshot');
  return r;
}
function validateStateDocument(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw prodError('S4B_PROD_STATE_CORRUPT', 'Production Cutover state must be an object');
  if (doc.schema !== STATE_SCHEMA) throw prodError('S4B_PROD_STATE_CORRUPT', 'Production Cutover state schema drift');
  if (!Number.isInteger(doc.revision) || doc.revision < 1) throw prodError('S4B_PROD_STATE_CORRUPT', 'Production Cutover state revision invalid');
  if (!['off', 'active'].includes(doc.mode)) throw prodError('S4B_PROD_STATE_CORRUPT', 'Production Cutover state mode must be off|active');
  const b = doc.router_binding;
  if (!b || typeof b !== 'object' || !/^[a-f0-9]{64}$/.test(String(b.state_sha256 || '')) ||
      !Number.isInteger(b.revision) || b.revision < 1 || typeof b.profile_id !== 'string' || !b.profile_id ||
      !/^[a-f0-9]{64}$/.test(String(b.prompt_bundle_sha256 || ''))) {
    throw prodError('S4B_PROD_STATE_CORRUPT', 'Production Cutover state Router binding invalid');
  }
  if (!doc.rollback_target || doc.rollback_target.mode !== 'off') throw prodError('S4B_PROD_STATE_CORRUPT', 'rollback target must be off');
  if (!doc.transition || typeof doc.transition.last_action !== 'string' || !doc.transition.last_action) throw prodError('S4B_PROD_STATE_CORRUPT', 'transition missing');
  if (typeof doc.production_cutover_active !== 'boolean' || typeof doc.rollback_performed !== 'boolean') throw prodError('S4B_PROD_STATE_CORRUPT', 'active/rollback booleans invalid');
  if (doc.mode === 'active' && doc.production_cutover_active !== true) throw prodError('S4B_PROD_STATE_CORRUPT', 'active requires production_cutover_active=true');
  if (doc.mode === 'off' && doc.production_cutover_active !== false) throw prodError('S4B_PROD_STATE_CORRUPT', 'off requires production_cutover_active=false');
  if (doc.paid_call !== false || doc.s4b_pass !== false || doc.s4b !== 'HOLD') throw prodError('S4B_PROD_STATE_BOUNDARY_DRIFT', 'paid/S4B boundary drift');
  return doc;
}

function createController(options) {
  options = options || {};
  const routerAdapter = options.routerAdapter || defaultRouter;
  const promptProfileAdapter = options.promptProfileAdapter || defaultPilot;

  function statePath(root) { return resolveInside(root, path.join(BROADER_RELATIVE, STATE_NAME), 'Production Cutover state'); }
  function lockPath(root) { return resolveInside(root, path.join(BROADER_RELATIVE, LOCK_NAME), 'Production Cutover lock'); }
  function tempFiles(root) {
    const p = statePath(root), dir = path.dirname(p);
    if (!fs.existsSync(dir)) return [];
    const prefix = path.basename(p) + '.tmp-';
    return fs.readdirSync(dir).filter(name => name.startsWith(prefix)).map(name => path.join(dir, name)).sort();
  }
  function assertNoLock(root) {
    if (fs.existsSync(lockPath(root))) throw prodError('S4B_PROD_STATE_STALE_LOCK_AUDIT_REQUIRED', 'Production Cutover lock exists; audit required');
  }
  function assertNoTemp(root) {
    const temps = tempFiles(root);
    if (temps.length) throw prodError('S4B_PROD_STATE_RECOVERY_REQUIRED', 'Production Cutover temp residue requires explicit recovery: ' + temps.map(file => path.basename(file)).join(', '));
  }
  function readStoredUnlocked(root) {
    const p = statePath(root);
    if (!fs.existsSync(p)) return null;
    let bytes, doc;
    try { bytes = fs.readFileSync(p); } catch (e) { throw prodError('S4B_PROD_STATE_CORRUPT', 'state read failed: ' + e.message); }
    try { doc = JSON.parse(bytes.toString('utf8')); } catch (e) { throw prodError('S4B_PROD_STATE_CORRUPT', 'state JSON invalid: ' + e.message); }
    validateStateDocument(doc);
    if (!bytes.equals(Buffer.from(canonicalJson(doc), 'utf8'))) throw prodError('S4B_PROD_STATE_NONCANONICAL', 'Production Cutover state bytes are not canonical');
    return { doc, bytes, sha256: sha256(bytes) };
  }
  function readStored(root) {
    assertNoLock(root); assertNoTemp(root); return readStoredUnlocked(root);
  }
  function currentIdentity(stored) {
    return stored ? { state_sha256: stored.sha256, revision: stored.doc.revision, mode: stored.doc.mode }
      : { state_sha256: null, revision: 0, mode: 'off' };
  }
  function assertExpected(stored, expected) {
    expected = expected || {};
    const actual = currentIdentity(stored);
    const exp = {
      state_sha256: expected.expected_state_sha256 === undefined ? null : expected.expected_state_sha256,
      revision: Number(expected.expected_revision === undefined ? -1 : expected.expected_revision),
      mode: String(expected.expected_mode || '')
    };
    if (exp.state_sha256 !== actual.state_sha256 || exp.revision !== actual.revision || exp.mode !== actual.mode) {
      throw prodError('S4B_PROD_STATE_CAS_MISMATCH', 'Production Cutover state CAS mismatch expected=' + JSON.stringify(exp) + ' actual=' + JSON.stringify(actual));
    }
  }
  function writeAtomic(root, doc) {
    validateStateDocument(doc);
    const p = statePath(root);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
    const fd = fs.openSync(tmp, 'wx');
    try { fs.writeFileSync(fd, canonicalJson(doc), 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try { fs.renameSync(tmp, p); fsyncFile(p); }
    catch (e) { try { fs.rmSync(tmp, { force: true }); } catch (_) {} throw e; }
    return readStoredUnlocked(root);
  }
  function withExclusiveLock(root, action, expected, fn) {
    assertNoLock(root); assertNoTemp(root);
    const lp = lockPath(root);
    fs.mkdirSync(path.dirname(lp), { recursive: true });
    let fd = null;
    try {
      fd = fs.openSync(lp, 'wx');
      fs.writeFileSync(fd, canonicalJson({ schema: 's4b-production-cutover-lock-v1', action, pid: process.pid, at: new Date().toISOString(), expected: expected || null }), 'utf8');
      fs.fsyncSync(fd); fs.closeSync(fd); fd = null;
    } catch (e) {
      if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
      if (e && e.code === 'EEXIST') throw prodError('S4B_PROD_STATE_STALE_LOCK_AUDIT_REQUIRED', 'Production Cutover lock already exists');
      throw e;
    }
    try {
      const stored = readStoredUnlocked(root);
      assertExpected(stored, expected);
      return fn(stored);
    } finally {
      try { fs.rmSync(lp, { force: true }); } catch (_) {}
    }
  }
  function routerStatus(root) {
    if (!routerAdapter || typeof routerAdapter.status !== 'function') throw prodError('S4B_PROD_ROUTER_UNAVAILABLE', 'Router status adapter unavailable');
    return normalizeRouterStatus(routerAdapter.status(path.resolve(root || process.cwd())));
  }
  function assertBindingMatchesRouter(doc, currentRouter) {
    const b = doc.router_binding;
    if (currentRouter.state_sha256 !== b.state_sha256 || currentRouter.revision !== b.revision ||
        currentRouter.default_profile_key !== 'repaired' || currentRouter.default_profile_id !== b.profile_id ||
        currentRouter.default_profile_sha256 !== b.prompt_bundle_sha256 || currentRouter.default_switch !== true ||
        currentRouter.rollback_performed !== false) {
      throw prodError('S4B_PROD_ROUTER_BINDING_DRIFT', 'active Production state no longer matches its exact Router snapshot');
    }
    return validateRepairedRouter(currentRouter);
  }
  function shape(root, stored, activeRouter) {
    if (!stored) return {
      ok: true, state_present: false, state_path: statePath(root), state_sha256: null, revision: 0, mode: 'off',
      active_authorized: false, production_cutover_active: false, rollback_performed: false,
      router_state_sha256: null, router_revision: null, repaired_profile_id: null, repaired_bundle_sha256: null,
      paid_call: false, s4b_pass: false, s4b: 'HOLD'
    };
    return {
      ok: true, state_present: true, state_path: statePath(root), state_sha256: stored.sha256,
      revision: stored.doc.revision, mode: stored.doc.mode,
      active_authorized: stored.doc.mode === 'active' && stored.doc.production_cutover_active === true,
      production_cutover_active: stored.doc.production_cutover_active, rollback_performed: stored.doc.rollback_performed,
      router_state_sha256: stored.doc.router_binding.state_sha256, router_revision: stored.doc.router_binding.revision,
      repaired_profile_id: stored.doc.router_binding.profile_id, repaired_bundle_sha256: stored.doc.router_binding.prompt_bundle_sha256,
      router_current_state_sha256: activeRouter && activeRouter.state_sha256 || null,
      transition_last_action: stored.doc.transition.last_action, paid_call: stored.doc.paid_call,
      s4b_pass: stored.doc.s4b_pass, s4b: stored.doc.s4b
    };
  }
  function status(root) {
    root = path.resolve(root || process.cwd());
    const stored = readStored(root);
    if (!stored) return shape(root, null, null);
    const activeRouter = stored.doc.mode === 'active' ? assertBindingMatchesRouter(stored.doc, routerStatus(root)) : null;
    return shape(root, stored, activeRouter);
  }
  function assertActiveAuthorization(root) {
    root = path.resolve(root || process.cwd());
    const stored = readStored(root);
    if (!stored || stored.doc.mode !== 'active' || stored.doc.production_cutover_active !== true) {
      throw prodError('S4B_PROD_ACTIVE_NOT_AUTHORIZED', 'canonical Production Cutover state does not authorize active mode');
    }
    const currentRouter = assertBindingMatchesRouter(stored.doc, routerStatus(root));
    return { state: stored.doc, state_sha256: stored.sha256, router: currentRouter,
      profile_id: stored.doc.router_binding.profile_id, prompt_bundle_sha256: stored.doc.router_binding.prompt_bundle_sha256 };
  }
  function resolveMode(root, input) {
    const s = status(root);
    if (s.active_authorized) return input && input.shadowRequested === true ? 'shadow' : 'active';
    return input && input.shadowRequested === true ? 'shadow' : 'off';
  }
  function activePromptProfile(root) {
    const auth = assertActiveAuthorization(root);
    if (!promptProfileAdapter || typeof promptProfileAdapter.repairedCandidateP4PromptProfile !== 'function' ||
        typeof promptProfileAdapter.p4PromptBundleSha256 !== 'function') {
      throw prodError('S4B_PROD_PROMPT_PROFILE_UNAVAILABLE', 'repaired prompt profile adapter unavailable');
    }
    const profile = promptProfileAdapter.repairedCandidateP4PromptProfile();
    const bundle = promptProfileAdapter.p4PromptBundleSha256(profile);
    if (profile.profile_id !== auth.profile_id || bundle !== auth.prompt_bundle_sha256) {
      throw prodError('S4B_PROD_PROMPT_PROFILE_DRIFT', 'Router-bound repaired prompt profile bytes drifted');
    }
    return Object.freeze({ profile_id: profile.profile_id, sha256: bundle, analyze: profile.analyze, review: profile.review, issueText: profile.issueText });
  }
  function activate(root, expected) {
    root = path.resolve(root || process.cwd());
    return withExclusiveLock(root, 'ACTIVATE_REPAIRED_PRODUCTION', expected, stored => {
      const currentRouter = validateRepairedRouter(routerStatus(root));
      if (stored && stored.doc.mode === 'active') {
        assertBindingMatchesRouter(stored.doc, currentRouter);
        return shape(root, stored, currentRouter);
      }
      const doc = {
        schema: STATE_SCHEMA, revision: stored ? stored.doc.revision + 1 : 1, mode: 'active',
        router_binding: { state_sha256: currentRouter.state_sha256, revision: currentRouter.revision,
          profile_id: currentRouter.default_profile_id, prompt_bundle_sha256: currentRouter.default_profile_sha256 },
        rollback_target: { mode: 'off', action: 'ROLLBACK_PRODUCTION_TO_OFF_ONLY' },
        transition: { last_action: 'ACTIVATE_REPAIRED_PRODUCTION' },
        production_cutover_active: true, rollback_performed: false, paid_call: false, s4b_pass: false, s4b: 'HOLD'
      };
      return shape(root, writeAtomic(root, doc), currentRouter);
    });
  }
  function rollbackToOff(root, expected) {
    root = path.resolve(root || process.cwd());
    return withExclusiveLock(root, 'ROLLBACK_PRODUCTION_TO_OFF', expected, stored => {
      if (!stored || stored.doc.mode !== 'active') throw prodError('S4B_PROD_ROLLBACK_INVALID_STATE', 'Production rollback requires active state');
      const doc = {
        schema: STATE_SCHEMA, revision: stored.doc.revision + 1, mode: 'off',
        router_binding: { ...stored.doc.router_binding }, rollback_target: { ...stored.doc.rollback_target },
        transition: { last_action: 'ROLLBACK_PRODUCTION_TO_OFF' },
        production_cutover_active: false, rollback_performed: true, paid_call: false, s4b_pass: false, s4b: 'HOLD'
      };
      return shape(root, writeAtomic(root, doc), null);
    });
  }
  function recoverState(root) {
    root = path.resolve(root || process.cwd());
    assertNoLock(root);
    const temps = tempFiles(root);
    for (const file of temps) fs.rmSync(file, { force: true });
    const stored = readStored(root);
    return { ok: true, state_present: !!stored, state_sha256: stored && stored.sha256 || null, temp_files_removed: temps.length };
  }
  return { status, resolveMode, assertActiveAuthorization, activePromptProfile, activate, rollbackToOff, recoverState, statePath, lockPath, STATE_NAME, LOCK_NAME, STATE_SCHEMA };
}

const defaultController = createController();
const status = root => defaultController.status(root);
const resolveMode = (root, input) => defaultController.resolveMode(root, input);
const assertActiveAuthorization = root => defaultController.assertActiveAuthorization(root);
const activePromptProfile = root => defaultController.activePromptProfile(root);
const activate = (root, expected) => defaultController.activate(root, expected);
const rollbackToOff = (root, expected) => defaultController.rollbackToOff(root, expected);
const recoverState = root => defaultController.recoverState(root);
const statePath = root => defaultController.statePath(root);
const lockPath = root => defaultController.lockPath(root);

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0] !== 'status') throw prodError('S4B_PROD_STATE_CLI_USAGE', 'usage: sc-semantic-production-cutover.js status');
  console.log('FB_RESULT:' + JSON.stringify(status(process.cwd())));
}

module.exports = {
  createController, status, resolveMode, assertActiveAuthorization, activePromptProfile, activate, rollbackToOff, recoverState,
  statePath, lockPath, BROADER_RELATIVE, STATE_NAME, LOCK_NAME, STATE_SCHEMA,
  EXPECTED_ROUTER_STATE_SHA256, EXPECTED_ROUTER_REVISION, EXPECTED_REPAIRED_PROFILE_ID, EXPECTED_REPAIRED_BUNDLE_SHA256
};
