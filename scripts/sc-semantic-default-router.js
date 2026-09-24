#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const activation = require('./sc-semantic-activation.js');

const BROADER_RELATIVE = path.join(
  'Upload',
  '辩词资料库-第三方学术语料',
  'local-test-cases',
  'S4B-broader-v2'
);
const STATE_NAME = 'S4B-Repaired-Default-Switch-State.private.json';
const LOCK_NAME = 'S4B-Repaired-Default-Switch-State.private.lock';

const STATE_SCHEMA = 's4b-default-router-state-v1';
const PROOF_SCHEMA = 's4b-default-router-rollback-proof-v1';
const EXPECTED_FROZEN_PROFILE_ID = 'p4-v1-v2-frozen-20260908';
const EXPECTED_FROZEN_BUNDLE_SHA256 = '9351d850eb2b3c04c1785b391c6abdb08a01b3198cf154e8758cc8d10eb3c956';
const EXPECTED_REPAIRED_PROFILE_ID = 'P4-candidate-targeted-role-calibration-finite-net-20260909';
const EXPECTED_REPAIRED_BUNDLE_SHA256 = '5dfaea66118861f82c77ed1f473a2fae14de1fb70b1f181ccf94c256e24b377f';
const EXPECTED_PRE_SWITCH_STATE_SHA256 = 'aa2cf14d49129e7b4a372d6a9da384925126cb9738f5169b6b37a43467cf14e4';

function routerError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function sha256Buffer(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sha256File(file) {
  return sha256Buffer(fs.readFileSync(file));
}

function resolveInside(root, relative, label) {
  const base = path.resolve(root || process.cwd());
  const absolute = path.resolve(base, relative);
  if (absolute !== base && !absolute.startsWith(base + path.sep)) {
    throw routerError('S4B_ROUTER_PATH_ESCAPE', (label || 'path') + ' escaped workspace');
  }
  return absolute;
}

function statePath(root) {
  return resolveInside(root, path.join(BROADER_RELATIVE, STATE_NAME), 'default router state');
}

function lockPath(root) {
  return resolveInside(root, path.join(BROADER_RELATIVE, LOCK_NAME), 'default router lock');
}

function assertRegularFile(file, code, label) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (_) {
    throw routerError(code, (label || 'file') + ' is missing');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw routerError(code, (label || 'file') + ' must be a regular non-link file');
  }
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw routerError('S4B_ROUTER_STATE_DRIFT', label + ' must be an object');
  }
  const actual = Object.keys(value).sort();
  const wanted = expected.slice().sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw routerError('S4B_ROUTER_STATE_DRIFT', label + ' keys drifted');
  }
}

function currentActivation(root) {
  const current = activation.status(root);
  if (
    !current ||
    current.activation_state !== 'ACTIVE_EXPLICIT_ONLY_NONDEFAULT' ||
    current.activation_active !== true ||
    !/^[a-f0-9]{64}$/.test(String(current.state_sha256 || '')) ||
    current.profile_id !== EXPECTED_REPAIRED_PROFILE_ID ||
    current.prompt_bundle_sha256 !== EXPECTED_REPAIRED_BUNDLE_SHA256 ||
    current.default_profile_key !== 'frozen' ||
    current.default_profile_id !== EXPECTED_FROZEN_PROFILE_ID ||
    current.default_profile_sha256 !== EXPECTED_FROZEN_BUNDLE_SHA256 ||
    current.default_switch !== false ||
    current.production_profile_mutation !== false ||
    current.production_cutover !== false ||
    current.paid_call !== false ||
    current.s4b !== 'HOLD'
  ) {
    throw routerError('S4B_ROUTER_ACTIVATION_DRIFT', 'explicit activation source-of-truth is not in the exact nondefault state');
  }
  return current;
}

function frozenProfile() {
  return {
    profile_key: 'frozen',
    profile_id: EXPECTED_FROZEN_PROFILE_ID,
    prompt_bundle_sha256: EXPECTED_FROZEN_BUNDLE_SHA256
  };
}

function repairedProfile() {
  return {
    profile_key: 'repaired',
    profile_id: EXPECTED_REPAIRED_PROFILE_ID,
    prompt_bundle_sha256: EXPECTED_REPAIRED_BUNDLE_SHA256
  };
}

function rollbackProof(activationStateSha256) {
  return {
    schema: PROOF_SCHEMA,
    status: 'PROVEN',
    proof_kind: 'DETERMINISTIC_TRANSITION_ROUNDTRIP',
    verified_transition: 'frozen->repaired->frozen',
    activation_state_sha256: activationStateSha256,
    rollback_target: frozenProfile()
  };
}

function preparedDocument(current) {
  return {
    schema: STATE_SCHEMA,
    revision: 1,
    activation_state_sha256: current.state_sha256,
    default_profile: frozenProfile(),
    rollback_proof: rollbackProof(current.state_sha256),
    transition: {
      last_action: 'PREPARE_ROLLBACK_PROOF',
      default_switch_active: false,
      rollback_performed: false
    },
    boundaries: {
      production_profile_mutation: false,
      production_cutover: false,
      paid_call: false,
      s4b_pass: false
    },
    s4b: 'HOLD'
  };
}

function nextDocument(doc, action) {
  if (action !== 'SWITCH_DEFAULT_TO_REPAIRED' && action !== 'ROLLBACK_TO_FROZEN') {
    throw routerError('S4B_ROUTER_INVALID_TRANSITION', 'unknown router transition');
  }
  return {
    schema: STATE_SCHEMA,
    revision: doc.revision + 1,
    activation_state_sha256: doc.activation_state_sha256,
    default_profile: action === 'SWITCH_DEFAULT_TO_REPAIRED' ? repairedProfile() : frozenProfile(),
    rollback_proof: {
      ...doc.rollback_proof,
      rollback_target: { ...doc.rollback_proof.rollback_target }
    },
    transition: {
      last_action: action,
      default_switch_active: action === 'SWITCH_DEFAULT_TO_REPAIRED',
      rollback_performed: action === 'ROLLBACK_TO_FROZEN'
    },
    boundaries: {
      production_profile_mutation: false,
      production_cutover: false,
      paid_call: false,
      s4b_pass: false
    },
    s4b: 'HOLD'
  };
}

function validateProfile(profile, label) {
  assertExactKeys(profile, ['profile_key', 'profile_id', 'prompt_bundle_sha256'], label);
  if (profile.profile_key === 'frozen') {
    if (
      profile.profile_id !== EXPECTED_FROZEN_PROFILE_ID ||
      profile.prompt_bundle_sha256 !== EXPECTED_FROZEN_BUNDLE_SHA256
    ) {
      throw routerError('S4B_ROUTER_STATE_DRIFT', label + ' frozen identity drifted');
    }
    return;
  }
  if (profile.profile_key === 'repaired') {
    if (
      profile.profile_id !== EXPECTED_REPAIRED_PROFILE_ID ||
      profile.prompt_bundle_sha256 !== EXPECTED_REPAIRED_BUNDLE_SHA256
    ) {
      throw routerError('S4B_ROUTER_STATE_DRIFT', label + ' repaired identity drifted');
    }
    return;
  }
  throw routerError('S4B_ROUTER_STATE_DRIFT', label + ' profile key is invalid');
}

function validateStateDocument(doc, current) {
  assertExactKeys(
    doc,
    ['schema', 'revision', 'activation_state_sha256', 'default_profile', 'rollback_proof', 'transition', 'boundaries', 's4b'],
    'router state'
  );
  if (
    doc.schema !== STATE_SCHEMA ||
    !Number.isSafeInteger(doc.revision) ||
    doc.revision < 1 ||
    doc.activation_state_sha256 !== current.state_sha256 ||
    doc.s4b !== 'HOLD'
  ) {
    throw routerError('S4B_ROUTER_STATE_DRIFT', 'router state header drifted');
  }

  validateProfile(doc.default_profile, 'default profile');

  assertExactKeys(
    doc.rollback_proof,
    ['schema', 'status', 'proof_kind', 'verified_transition', 'activation_state_sha256', 'rollback_target'],
    'rollback proof'
  );
  if (
    doc.rollback_proof.schema !== PROOF_SCHEMA ||
    doc.rollback_proof.status !== 'PROVEN' ||
    doc.rollback_proof.proof_kind !== 'DETERMINISTIC_TRANSITION_ROUNDTRIP' ||
    doc.rollback_proof.verified_transition !== 'frozen->repaired->frozen' ||
    doc.rollback_proof.activation_state_sha256 !== current.state_sha256
  ) {
    throw routerError('S4B_ROUTER_STATE_DRIFT', 'rollback proof drifted');
  }
  validateProfile(doc.rollback_proof.rollback_target, 'rollback target');
  if (doc.rollback_proof.rollback_target.profile_key !== 'frozen') {
    throw routerError('S4B_ROUTER_STATE_DRIFT', 'rollback target must remain frozen');
  }

  assertExactKeys(
    doc.transition,
    ['last_action', 'default_switch_active', 'rollback_performed'],
    'transition'
  );
  if (
    typeof doc.transition.default_switch_active !== 'boolean' ||
    typeof doc.transition.rollback_performed !== 'boolean'
  ) {
    throw routerError('S4B_ROUTER_STATE_DRIFT', 'transition booleans drifted');
  }

  if (doc.transition.last_action === 'PREPARE_ROLLBACK_PROOF') {
    if (
      doc.revision !== 1 ||
      doc.default_profile.profile_key !== 'frozen' ||
      doc.transition.default_switch_active !== false ||
      doc.transition.rollback_performed !== false
    ) {
      throw routerError('S4B_ROUTER_STATE_DRIFT', 'prepared state is inconsistent');
    }
  } else if (doc.transition.last_action === 'SWITCH_DEFAULT_TO_REPAIRED') {
    if (
      doc.default_profile.profile_key !== 'repaired' ||
      doc.transition.default_switch_active !== true ||
      doc.transition.rollback_performed !== false
    ) {
      throw routerError('S4B_ROUTER_STATE_DRIFT', 'repaired default state is inconsistent');
    }
  } else if (doc.transition.last_action === 'ROLLBACK_TO_FROZEN') {
    if (
      doc.default_profile.profile_key !== 'frozen' ||
      doc.transition.default_switch_active !== false ||
      doc.transition.rollback_performed !== true
    ) {
      throw routerError('S4B_ROUTER_STATE_DRIFT', 'rollback state is inconsistent');
    }
  } else {
    throw routerError('S4B_ROUTER_STATE_DRIFT', 'transition action drifted');
  }

  assertExactKeys(
    doc.boundaries,
    ['production_profile_mutation', 'production_cutover', 'paid_call', 's4b_pass'],
    'boundaries'
  );
  if (
    doc.boundaries.production_profile_mutation !== false ||
    doc.boundaries.production_cutover !== false ||
    doc.boundaries.paid_call !== false ||
    doc.boundaries.s4b_pass !== false
  ) {
    throw routerError('S4B_ROUTER_STATE_DRIFT', 'router crossed a forbidden boundary');
  }

  return doc;
}

function canonicalStateText(doc, current) {
  validateStateDocument(doc, current);
  return JSON.stringify(doc, null, 2) + '\n';
}

function readStateUnlocked(root, current) {
  const file = statePath(root);
  if (!fs.existsSync(file)) return null;
  assertRegularFile(file, 'S4B_ROUTER_STATE_DRIFT', 'default router state');
  const bytes = fs.readFileSync(file);
  let doc;
  try {
    doc = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw routerError('S4B_ROUTER_STATE_DRIFT', 'default router state JSON is invalid: ' + error.message);
  }
  const canonical = Buffer.from(canonicalStateText(doc, current), 'utf8');
  if (!bytes.equals(canonical)) {
    throw routerError('S4B_ROUTER_STATE_DRIFT', 'default router state bytes are not canonical');
  }
  return {
    file,
    doc,
    sha256: sha256Buffer(bytes)
  };
}

function assertNoLock(root) {
  const lock = lockPath(root);
  if (fs.existsSync(lock)) {
    throw routerError('S4B_ROUTER_IN_PROGRESS', 'default router lock exists; transition is in progress or requires stale-lock audit');
  }
}

function shape(root, current, stored) {
  const profile = stored ? stored.doc.default_profile : frozenProfile();
  return {
    ok: true,
    action: 's4b-default-router-status',
    activation_state: current.activation_state,
    activation_state_sha256: current.state_sha256,
    state_present: Boolean(stored),
    state_path: path.relative(root, statePath(root)).split(path.sep).join('/'),
    state_sha256: stored ? stored.sha256 : null,
    revision: stored ? stored.doc.revision : 0,
    default_profile_key: profile.profile_key,
    default_profile_id: profile.profile_id,
    default_profile_sha256: profile.prompt_bundle_sha256,
    repaired_profile_id: EXPECTED_REPAIRED_PROFILE_ID,
    repaired_prompt_bundle_sha256: EXPECTED_REPAIRED_BUNDLE_SHA256,
    rollback_ready: Boolean(stored && stored.doc.rollback_proof.status === 'PROVEN'),
    rollback_performed: Boolean(stored && stored.doc.transition.rollback_performed),
    default_switch: profile.profile_key === 'repaired',
    production_profile_mutation: false,
    production_cutover: false,
    paid_call: false,
    s4b: 'HOLD'
  };
}

function status(root) {
  root = path.resolve(root || process.cwd());
  const current = currentActivation(root);
  assertNoLock(root);
  return shape(root, current, readStateUnlocked(root, current));
}

function validateExpected(expected) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    throw routerError('S4B_ROUTER_INVALID_CAS', 'expected prior state is required');
  }
  const keys = Object.keys(expected).sort();
  const wanted = ['expected_default_profile_key', 'expected_state_sha256'].sort();
  if (keys.length !== wanted.length || keys.some((key, index) => key !== wanted[index])) {
    throw routerError('S4B_ROUTER_INVALID_CAS', 'expected prior state keys are invalid');
  }
  if (!['frozen', 'repaired'].includes(expected.expected_default_profile_key)) {
    throw routerError('S4B_ROUTER_INVALID_CAS', 'expected default profile key is invalid');
  }
  if (
    expected.expected_state_sha256 !== null &&
    !/^[a-f0-9]{64}$/.test(String(expected.expected_state_sha256 || ''))
  ) {
    throw routerError('S4B_ROUTER_INVALID_CAS', 'expected state SHA must be null or exact SHA-256');
  }
}

function assertCas(stored, expected) {
  validateExpected(expected);
  const actualSha = stored ? stored.sha256 : null;
  const actualKey = stored ? stored.doc.default_profile.profile_key : 'frozen';
  if (
    expected.expected_state_sha256 !== actualSha ||
    expected.expected_default_profile_key !== actualKey
  ) {
    throw routerError(
      'S4B_ROUTER_CAS_MISMATCH',
      'router state changed: expected sha=' + String(expected.expected_state_sha256) +
      ' default=' + expected.expected_default_profile_key +
      ' actual sha=' + String(actualSha) +
      ' default=' + actualKey
    );
  }
}

function fsyncFile(file) {
  const fd = fs.openSync(file, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeStateAtomic(root, current, doc, expectedCurrentSha) {
  const file = statePath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const text = canonicalStateText(doc, current);
  const temp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
  let committed = false;
  try {
    const fd = fs.openSync(temp, 'wx');
    try {
      fs.writeFileSync(fd, text, 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    const nowSha = fs.existsSync(file) ? sha256File(file) : null;
    if (nowSha !== expectedCurrentSha) {
      throw routerError('S4B_ROUTER_CAS_MISMATCH', 'router state changed before atomic commit');
    }

    fs.renameSync(temp, file);
    committed = true;
    fsyncFile(file);
  } finally {
    if (!committed) {
      try { fs.rmSync(temp, { force: true }); } catch (_) {}
    }
  }
  return readStateUnlocked(root, current);
}

function withExclusiveLock(root, action, expected, operation) {
  root = path.resolve(root || process.cwd());
  validateExpected(expected);
  const lock = lockPath(root);
  fs.mkdirSync(path.dirname(lock), { recursive: true });

  let fd;
  let owned = false;
  try {
    try {
      fd = fs.openSync(lock, 'wx');
      owned = true;
      fs.writeFileSync(fd, JSON.stringify({
        schema: 's4b-default-router-lock-v1',
        action,
        expected_state_sha256: expected.expected_state_sha256,
        expected_default_profile_key: expected.expected_default_profile_key
      }) + '\n', 'utf8');
      fs.fsyncSync(fd);
    } catch (error) {
      throw routerError('S4B_ROUTER_IN_PROGRESS', 'could not acquire default router lock: ' + error.message);
    } finally {
      if (fd !== undefined) {
        fs.closeSync(fd);
        fd = undefined;
      }
    }

    const current = currentActivation(root);
    const stored = readStateUnlocked(root, current);
    assertCas(stored, expected);
    return operation(root, current, stored);
  } finally {
    if (owned) {
      try { fs.rmSync(lock, { force: true }); } catch (_) {}
    }
  }
}

function verifyRollbackRoundTrip(prepared, current) {
  const switched = nextDocument(prepared, 'SWITCH_DEFAULT_TO_REPAIRED');
  validateStateDocument(switched, current);
  const rolled = nextDocument(switched, 'ROLLBACK_TO_FROZEN');
  validateStateDocument(rolled, current);
  if (
    rolled.default_profile.profile_key !== 'frozen' ||
    rolled.default_profile.profile_id !== EXPECTED_FROZEN_PROFILE_ID ||
    rolled.default_profile.prompt_bundle_sha256 !== EXPECTED_FROZEN_BUNDLE_SHA256 ||
    rolled.transition.default_switch_active !== false ||
    rolled.boundaries.production_profile_mutation !== false ||
    rolled.boundaries.production_cutover !== false
  ) {
    throw routerError('S4B_ROUTER_ROLLBACK_PROOF_FAILED', 'deterministic rollback round-trip failed');
  }
}

function prepareRollbackProof(root, expected) {
  return withExclusiveLock(root, 'PREPARE_ROLLBACK_PROOF', expected, (resolvedRoot, current, stored) => {
    if (stored) {
      if (stored.doc.default_profile.profile_key !== 'frozen') {
        throw routerError('S4B_ROUTER_INVALID_TRANSITION', 'cannot prepare rollback proof while repaired is default');
      }
      return {
        ...shape(resolvedRoot, current, stored),
        action: 's4b-default-router-prepare-rollback-proof',
        already_prepared: true
      };
    }

    const doc = preparedDocument(current);
    verifyRollbackRoundTrip(doc, current);
    const written = writeStateAtomic(resolvedRoot, current, doc, null);
    return {
      ...shape(resolvedRoot, current, written),
      action: 's4b-default-router-prepare-rollback-proof',
      already_prepared: false
    };
  });
}

function switchDefault(root, expected) {
  return withExclusiveLock(root, 'SWITCH_DEFAULT_TO_REPAIRED', expected, (resolvedRoot, current, stored) => {
    if (!stored || stored.doc.rollback_proof.status !== 'PROVEN') {
      throw routerError('S4B_ROUTER_ROLLBACK_PROOF_REQUIRED', 'repaired cannot become default before rollback proof is committed');
    }
    if (stored.doc.default_profile.profile_key === 'repaired') {
      return {
        ...shape(resolvedRoot, current, stored),
        action: 's4b-default-router-switch-default',
        already_repaired: true
      };
    }

    const doc = nextDocument(stored.doc, 'SWITCH_DEFAULT_TO_REPAIRED');
    validateStateDocument(doc, current);
    const written = writeStateAtomic(resolvedRoot, current, doc, stored.sha256);
    return {
      ...shape(resolvedRoot, current, written),
      action: 's4b-default-router-switch-default',
      already_repaired: false
    };
  });
}

function rollbackToFrozen(root, expected) {
  return withExclusiveLock(root, 'ROLLBACK_TO_FROZEN', expected, (resolvedRoot, current, stored) => {
    if (!stored) {
      return {
        ...shape(resolvedRoot, current, null),
        action: 's4b-default-router-rollback-to-frozen',
        already_frozen: true
      };
    }
    if (stored.doc.default_profile.profile_key === 'frozen') {
      return {
        ...shape(resolvedRoot, current, stored),
        action: 's4b-default-router-rollback-to-frozen',
        already_frozen: true
      };
    }
    if (stored.doc.rollback_proof.status !== 'PROVEN') {
      throw routerError('S4B_ROUTER_ROLLBACK_PROOF_REQUIRED', 'rollback proof is missing');
    }

    const doc = nextDocument(stored.doc, 'ROLLBACK_TO_FROZEN');
    validateStateDocument(doc, current);
    const written = writeStateAtomic(resolvedRoot, current, doc, stored.sha256);
    return {
      ...shape(resolvedRoot, current, written),
      action: 's4b-default-router-rollback-to-frozen',
      already_frozen: false
    };
  });
}

function prepareRollbackProofFromCurrent(root) {
  const current = status(root);
  return prepareRollbackProof(root, {
    expected_state_sha256: current.state_sha256,
    expected_default_profile_key: current.default_profile_key
  });
}

function switchDefaultFromExpectedPreparedState(root) {
  return switchDefault(root, {
    expected_state_sha256: EXPECTED_PRE_SWITCH_STATE_SHA256,
    expected_default_profile_key: 'frozen'
  });
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['status', 'prepare-rollback-proof', 'switch-default'].includes(args[0])) {
    throw routerError('S4B_ROUTER_CLI_USAGE', 'usage: sc-semantic-default-router.js status|prepare-rollback-proof|switch-default');
  }
  const result = args[0] === 'status'
    ? status(process.cwd())
    : args[0] === 'prepare-rollback-proof'
      ? prepareRollbackProofFromCurrent(process.cwd())
      : switchDefaultFromExpectedPreparedState(process.cwd());
  console.log('FB_RESULT:' + JSON.stringify(result));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error('ERROR [' + String(error.code || 'S4B_ROUTER_ERROR') + '] ' + error.message);
    process.exit(1);
  }
}

module.exports = {
  status,
  prepareRollbackProof,
  switchDefault,
  switchDefaultFromExpectedPreparedState,
  rollbackToFrozen,
  BROADER_RELATIVE,
  STATE_NAME,
  LOCK_NAME,
  STATE_SCHEMA,
  PROOF_SCHEMA,
  EXPECTED_FROZEN_PROFILE_ID,
  EXPECTED_FROZEN_BUNDLE_SHA256,
  EXPECTED_REPAIRED_PROFILE_ID,
  EXPECTED_REPAIRED_BUNDLE_SHA256,
  EXPECTED_PRE_SWITCH_STATE_SHA256
};
