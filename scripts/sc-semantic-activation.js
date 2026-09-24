#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const BROADER_RELATIVE = path.join(
  'Upload',
  '辩词资料库-第三方学术语料',
  'local-test-cases',
  'S4B-broader-v2'
);
const ACCEPTANCE_NAME = 'S4B-AB-Retest-Candidate-Acceptance.private.json';
const STATE_NAME = 'S4B-AB-Retest-Repaired-Activation-State.private.json';
const LOCK_NAME = 'S4B-AB-Retest-Repaired-Activation-State.private.lock';

const EXPECTED_ACCEPTANCE_SHA256 = '9877c99dad3035fcb02ee03996937d6ba2bbaf1cdbe1b83c4c36dec88cdfe1c9';
const EXPECTED_PILOT_SHA256 = 'ac9d39c40dca2eee97466f9758281798bd0c6197959fae352e94ab516f043d86';
const EXPECTED_REPAIRED_PROFILE_ID = 'P4-candidate-targeted-role-calibration-finite-net-20260909';
const EXPECTED_REPAIRED_BUNDLE_SHA256 = '5dfaea66118861f82c77ed1f473a2fae14de1fb70b1f181ccf94c256e24b377f';
const EXPECTED_FROZEN_PROFILE_ID = 'p4-v1-v2-frozen-20260908';
const EXPECTED_FROZEN_BUNDLE_SHA256 = '9351d850eb2b3c04c1785b391c6abdb08a01b3198cf154e8758cc8d10eb3c956';

function activationError(code, message) {
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
    throw activationError('S4B_ACTIVATION_PATH_ESCAPE', (label || 'path') + ' escaped workspace');
  }
  return absolute;
}

function assertRegularFile(file, code, label) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (_) {
    throw activationError(code, (label || 'file') + ' is missing');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw activationError(code, (label || 'file') + ' must be a regular non-link file');
  }
}

function acceptancePath(root) {
  return resolveInside(root, path.join(BROADER_RELATIVE, ACCEPTANCE_NAME), 'acceptance receipt');
}

function statePath(root) {
  return resolveInside(root, path.join(BROADER_RELATIVE, STATE_NAME), 'activation state');
}

function lockPath(root) {
  return resolveInside(root, path.join(BROADER_RELATIVE, LOCK_NAME), 'activation lock');
}

function pilotPath(root) {
  return resolveInside(root, path.join('scripts', 'sc-semantic-pilot.js'), 'S4B pilot source');
}

function parseJsonFile(file, code, label) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw activationError(code, (label || 'JSON') + ' is invalid JSON: ' + error.message);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw activationError(code, (label || 'JSON') + ' must be an object');
  }
  return parsed;
}

function loadAcceptance(root) {
  const file = acceptancePath(root);
  assertRegularFile(file, 'S4B_ACTIVATION_ACCEPTANCE_DRIFT', 'candidate acceptance receipt');
  const actualSha = sha256File(file);
  if (actualSha !== EXPECTED_ACCEPTANCE_SHA256) {
    throw activationError(
      'S4B_ACTIVATION_ACCEPTANCE_DRIFT',
      'candidate acceptance receipt SHA drift: expected=' + EXPECTED_ACCEPTANCE_SHA256 + ' actual=' + actualSha
    );
  }
  const doc = parseJsonFile(file, 'S4B_ACTIVATION_ACCEPTANCE_DRIFT', 'candidate acceptance receipt');
  const candidate = doc.candidate || {};
  const decision = doc.decision || {};
  const boundaries = doc.boundaries || {};
  if (
    doc.schema !== 's4b-ab-retest-candidate-acceptance-v1' ||
    candidate.profile_id !== EXPECTED_REPAIRED_PROFILE_ID ||
    candidate.prompt_bundle_sha256 !== EXPECTED_REPAIRED_BUNDLE_SHA256 ||
    candidate.pilot_source_path !== 'scripts/sc-semantic-pilot.js' ||
    candidate.pilot_source_sha256 !== EXPECTED_PILOT_SHA256 ||
    decision.candidate_acceptance !== 'ACCEPT' ||
    decision.accepted_state !== 'ACCEPTED_NONLIVE_ELIGIBLE_FOR_ACTIVATION_REVIEW' ||
    boundaries.activation_performed !== false ||
    boundaries.default_switch_performed !== false ||
    boundaries.production_profile_mutation_performed !== false ||
    boundaries.production_cutover_performed !== false ||
    boundaries.s4b_pass_declared !== false
  ) {
    throw activationError('S4B_ACTIVATION_ACCEPTANCE_DRIFT', 'candidate acceptance receipt content mismatch');
  }
  return { file, doc, sha256: actualSha };
}

function loadPilot(root) {
  const file = pilotPath(root);
  assertRegularFile(file, 'S4B_ACTIVATION_PILOT_DRIFT', 'S4B pilot source');
  const actualSha = sha256File(file);
  if (actualSha !== EXPECTED_PILOT_SHA256) {
    throw activationError(
      'S4B_ACTIVATION_PILOT_DRIFT',
      'S4B pilot SHA drift: expected=' + EXPECTED_PILOT_SHA256 + ' actual=' + actualSha
    );
  }

  let pilot;
  try {
    const modulePath = require.resolve(file);
    delete require.cache[modulePath];
    pilot = require(modulePath);
  } catch (error) {
    throw activationError('S4B_ACTIVATION_PILOT_DRIFT', 'S4B pilot cannot be loaded: ' + error.message);
  }

  if (
    !pilot ||
    typeof pilot.frozenP4PromptProfile !== 'function' ||
    typeof pilot.repairedCandidateP4PromptProfile !== 'function' ||
    typeof pilot.p4PromptBundleSha256 !== 'function' ||
    typeof pilot.p4ProtocolSpec !== 'function'
  ) {
    throw activationError('S4B_ACTIVATION_PILOT_DRIFT', 'S4B pilot activation exports are incomplete');
  }

  const frozen = pilot.frozenP4PromptProfile();
  const repaired = pilot.repairedCandidateP4PromptProfile();
  const frozenBundle = pilot.p4PromptBundleSha256(frozen);
  const repairedBundle = pilot.p4PromptBundleSha256(repaired);

  if (
    frozen.profile_id !== EXPECTED_FROZEN_PROFILE_ID ||
    frozenBundle !== EXPECTED_FROZEN_BUNDLE_SHA256 ||
    frozen.registered_live !== true ||
    repaired.profile_id !== EXPECTED_REPAIRED_PROFILE_ID ||
    repairedBundle !== EXPECTED_REPAIRED_BUNDLE_SHA256 ||
    repaired.registered_live !== false
  ) {
    throw activationError('S4B_ACTIVATION_PILOT_DRIFT', 'S4B frozen/repaired profile identity mismatch');
  }

  const v1 = pilot.p4ProtocolSpec(pilot.P4_PROTOCOL_V1);
  const v2 = pilot.p4ProtocolSpec(pilot.P4_PROTOCOL_V2);
  for (const spec of [v1, v2]) {
    if (
      spec.promptProfileId !== EXPECTED_FROZEN_PROFILE_ID ||
      spec.promptBundleSha256 !== EXPECTED_FROZEN_BUNDLE_SHA256
    ) {
      throw activationError('S4B_ACTIVATION_PILOT_DRIFT', 'historical/default P4 protocol identity is no longer frozen-bound');
    }
  }

  return { file, pilot, frozen, repaired, sha256: actualSha };
}

function expectedStateDocument() {
  return {
    schema: 's4b-repaired-explicit-activation-state-v1',
    date: '2026-09-09',
    activation_state: 'ACTIVE_EXPLICIT_ONLY_NONDEFAULT',
    activation_mode: 'explicit-only',
    candidate: {
      profile_id: EXPECTED_REPAIRED_PROFILE_ID,
      prompt_bundle_sha256: EXPECTED_REPAIRED_BUNDLE_SHA256,
      acceptance_receipt_sha256: EXPECTED_ACCEPTANCE_SHA256,
      pilot_source_sha256: EXPECTED_PILOT_SHA256
    },
    default_profile: {
      profile_key: 'frozen',
      profile_id: EXPECTED_FROZEN_PROFILE_ID,
      prompt_bundle_sha256: EXPECTED_FROZEN_BUNDLE_SHA256
    },
    boundaries: {
      explicit_selection: true,
      default_switch: false,
      production_profile_mutation: false,
      production_cutover: false,
      historical_live_identity_unchanged: true,
      paid_call: false,
      s4b_pass: false
    },
    s4b: 'HOLD'
  };
}

function expectedStateText() {
  return JSON.stringify(expectedStateDocument(), null, 2) + '\n';
}

function readExactStateUnlocked(root) {
  const file = statePath(root);
  if (!fs.existsSync(file)) return null;
  assertRegularFile(file, 'S4B_ACTIVATION_STATE_DRIFT', 'activation state');
  const bytes = fs.readFileSync(file);
  const expected = Buffer.from(expectedStateText(), 'utf8');
  if (!bytes.equals(expected)) {
    throw activationError('S4B_ACTIVATION_STATE_DRIFT', 'activation state bytes do not match the canonical accepted state');
  }
  return {
    file,
    sha256: sha256Buffer(bytes),
    doc: expectedStateDocument()
  };
}

function assertNoActivationLock(root) {
  const lock = lockPath(root);
  if (fs.existsSync(lock)) {
    throw activationError('S4B_ACTIVATION_IN_PROGRESS', 'activation lock already exists; activation is in progress or requires manual stale-lock audit');
  }
}

function preflight(root) {
  const acceptance = loadAcceptance(root);
  const pilot = loadPilot(root);
  return { acceptance, pilot };
}

function status(root) {
  root = path.resolve(root || process.cwd());
  const checked = preflight(root);
  assertNoActivationLock(root);
  const active = readExactStateUnlocked(root);

  return {
    ok: true,
    action: 's4b-repaired-activation-status',
    activation_state: active ? 'ACTIVE_EXPLICIT_ONLY_NONDEFAULT' : 'ELIGIBLE_NOT_ACTIVATED',
    activation_active: Boolean(active),
    already_active: Boolean(active),
    profile_id: EXPECTED_REPAIRED_PROFILE_ID,
    prompt_bundle_sha256: EXPECTED_REPAIRED_BUNDLE_SHA256,
    acceptance_receipt_sha256: checked.acceptance.sha256,
    pilot_source_sha256: checked.pilot.sha256,
    state_path: path.relative(root, statePath(root)).split(path.sep).join('/'),
    state_sha256: active ? active.sha256 : null,
    default_profile_key: 'frozen',
    default_profile_id: EXPECTED_FROZEN_PROFILE_ID,
    default_profile_sha256: EXPECTED_FROZEN_BUNDLE_SHA256,
    explicit_selection: Boolean(active),
    default_switch: false,
    production_profile_mutation: false,
    production_cutover: false,
    paid_call: false,
    s4b: 'HOLD'
  };
}

function fsyncFile(file) {
  const fd = fs.openSync(file, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function activate(root) {
  root = path.resolve(root || process.cwd());
  const checked = preflight(root);
  assertNoActivationLock(root);

  const existing = readExactStateUnlocked(root);
  if (existing) {
    return {
      ...status(root),
      action: 's4b-repaired-activation-activate',
      already_active: true
    };
  }

  const lock = lockPath(root);
  const state = statePath(root);
  fs.mkdirSync(path.dirname(lock), { recursive: true });

  let lockFd;
  let lockOwned = false;
  let temp = null;
  try {
    try {
      lockFd = fs.openSync(lock, 'wx');
      lockOwned = true;
      fs.writeFileSync(lockFd, JSON.stringify({
        schema: 's4b-repaired-activation-lock-v1',
        profile_id: EXPECTED_REPAIRED_PROFILE_ID,
        acceptance_receipt_sha256: checked.acceptance.sha256,
        pilot_source_sha256: checked.pilot.sha256
      }) + '\n', 'utf8');
      fs.fsyncSync(lockFd);
    } catch (error) {
      throw activationError('S4B_ACTIVATION_IN_PROGRESS', 'could not acquire activation lock: ' + error.message);
    } finally {
      if (lockFd !== undefined) {
        fs.closeSync(lockFd);
        lockFd = undefined;
      }
    }

    preflight(root);
    const raced = readExactStateUnlocked(root);
    if (raced) {
      return {
        ...statusAfterUnlockShape(root, raced.sha256),
        action: 's4b-repaired-activation-activate',
        already_active: true
      };
    }

    temp = state + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
    const fd = fs.openSync(temp, 'wx');
    try {
      fs.writeFileSync(fd, expectedStateText(), 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, state);
    temp = null;
    fsyncFile(state);
  } finally {
    if (temp) {
      try { fs.rmSync(temp, { force: true }); } catch (_) {}
    }
    if (lockOwned) {
      try { fs.rmSync(lock, { force: true }); } catch (_) {}
    }
  }

  return {
    ...status(root),
    action: 's4b-repaired-activation-activate',
    already_active: false
  };
}

function statusAfterUnlockShape(root, stateSha256) {
  return {
    ok: true,
    activation_state: 'ACTIVE_EXPLICIT_ONLY_NONDEFAULT',
    activation_active: true,
    already_active: true,
    profile_id: EXPECTED_REPAIRED_PROFILE_ID,
    prompt_bundle_sha256: EXPECTED_REPAIRED_BUNDLE_SHA256,
    acceptance_receipt_sha256: EXPECTED_ACCEPTANCE_SHA256,
    pilot_source_sha256: EXPECTED_PILOT_SHA256,
    state_path: path.relative(root, statePath(root)).split(path.sep).join('/'),
    state_sha256: stateSha256,
    default_profile_key: 'frozen',
    default_profile_id: EXPECTED_FROZEN_PROFILE_ID,
    default_profile_sha256: EXPECTED_FROZEN_BUNDLE_SHA256,
    explicit_selection: true,
    default_switch: false,
    production_profile_mutation: false,
    production_cutover: false,
    paid_call: false,
    s4b: 'HOLD'
  };
}

function resolveExplicitActivatedProfile(root) {
  const current = status(root);
  if (!current.activation_active) {
    throw activationError('S4B_ACTIVATION_NOT_ACTIVE', 'repaired profile is accepted but not explicitly activated');
  }
  const checked = loadPilot(root);
  const repaired = checked.repaired;
  return Object.freeze({
    profile_id: repaired.profile_id,
    analyze: repaired.analyze,
    review: repaired.review,
    issueText: repaired.issueText,
    registered_live: true,
    activation_mode: 'explicit-only',
    activation_state_sha256: current.state_sha256,
    default_switch: false,
    production_profile_mutation: false,
    production_cutover: false
  });
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !['status', 'activate'].includes(args[0])) {
    throw activationError('S4B_ACTIVATION_CLI_USAGE', 'usage: sc-semantic-activation.js status|activate');
  }
  const result = args[0] === 'status' ? status(process.cwd()) : activate(process.cwd());
  console.log('FB_RESULT:' + JSON.stringify(result));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error('ERROR [' + String(error.code || 'S4B_ACTIVATION_ERROR') + '] ' + error.message);
    process.exit(1);
  }
}

module.exports = {
  status,
  activate,
  resolveExplicitActivatedProfile,
  expectedStateDocument,
  expectedStateText,
  EXPECTED_ACCEPTANCE_SHA256,
  EXPECTED_PILOT_SHA256,
  EXPECTED_REPAIRED_PROFILE_ID,
  EXPECTED_REPAIRED_BUNDLE_SHA256,
  EXPECTED_FROZEN_PROFILE_ID,
  EXPECTED_FROZEN_BUNDLE_SHA256
};
