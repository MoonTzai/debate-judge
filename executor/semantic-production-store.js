'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const CURRENT_SCHEMA = 'judge-production-semantic-current-v1';
const ROOT_NAME = '.semantic-first-production-v1';

function storeError(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}
function sha256Buffer(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function sha256Text(text) { return sha256Buffer(Buffer.from(String(text), 'utf8')); }
function canonicalJson(value) { return JSON.stringify(value, null, 2) + '\n'; }
function safeId(value, label) {
  const s = String(value || '');
  if (!s || !/^[A-Za-z0-9._-]+$/.test(s)) throw storeError('PROD_SEMANTIC_UNSAFE_ID', (label || 'id') + ' is unsafe: ' + s);
  return s;
}
function fsyncFile(file) {
  const fd = fs.openSync(file, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function defaultCurrent() {
  return {
    schema: CURRENT_SCHEMA,
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

function createProductionSemanticStore(workDir, options) {
  options = options || {};
  const root = path.join(path.resolve(workDir), ROOT_NAME);
  fs.mkdirSync(root, { recursive: true });

  function sessionDir(sessionId) { return path.join(root, safeId(sessionId, 'sessionId')); }
  function currentPath(sessionId) { return path.join(sessionDir(sessionId), 'current.json'); }
  function currentLockPath(sessionId) { return path.join(sessionDir(sessionId), 'current.json.lock'); }
  function eventsPath(sessionId) { return path.join(sessionDir(sessionId), 'events.jsonl'); }

  function tempFiles(sessionId) {
    const dir = sessionDir(sessionId);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter(n => n.startsWith('current.json.tmp-')).map(n => path.join(dir, n)).sort();
  }

  function assertNoLock(sessionId) {
    if (fs.existsSync(currentLockPath(sessionId))) {
      throw storeError('PROD_SEMANTIC_STALE_LOCK_AUDIT_REQUIRED', 'production semantic current lock exists; audit required');
    }
  }

  function appendEvent(sessionId, event) {
    const p = eventsPath(sessionId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.appendFileSync(p, JSON.stringify(Object.assign({ at: new Date().toISOString() }, event)) + '\n', 'utf8');
    fsyncFile(p);
  }

  function atomicCreate(file, bytes) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) {
      const existing = fs.readFileSync(file);
      if (!existing.equals(bytes)) throw storeError('PROD_SEMANTIC_IMMUTABLE_COLLISION', 'immutable object collision: ' + file);
      return false;
    }
    const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
    const fd = fs.openSync(tmp, 'wx');
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try {
      fs.renameSync(tmp, file);
      fsyncFile(file);
    } catch (e) {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      throw e;
    }
    return true;
  }

  function appendObject(input) {
    input = input || {};
    const sessionId = safeId(input.sessionId, 'sessionId');
    const kind = safeId(input.kind, 'kind');
    const allowedKinds = new Set(['source', 'context', 'request', 'raw', 'semantic', 'review', 'fidelity', 'projection', 'issue', 'commit']);
    if (!allowedKinds.has(kind)) throw storeError('PROD_SEMANTIC_KIND_INVALID', 'unsupported production semantic object kind: ' + kind);
    const text = String(input.content);
    const metadata = input.metadata || {};
    const bodySha = sha256Text(text);
    const identitySha = sha256Text(kind + '\0' + JSON.stringify(metadata) + '\0' + text);
    const objectId = kind + '-' + identitySha.slice(0, 24);
    const dir = path.join(sessionDir(sessionId), 'objects');
    const bodyPath = path.join(dir, objectId + '.txt');
    const metaPath = path.join(dir, objectId + '.meta.json');
    const ref = {
      objectId,
      kind,
      sha256: bodySha,
      path: path.relative(root, bodyPath).split('\\').join('/'),
      metadataPath: path.relative(root, metaPath).split('\\').join('/')
    };
    const createdBody = atomicCreate(bodyPath, Buffer.from(text, 'utf8'));
    const createdMeta = atomicCreate(metaPath, Buffer.from(canonicalJson({ ref, metadata }), 'utf8'));
    if (createdBody || createdMeta) appendEvent(sessionId, { type: 'object-persisted', kind, objectId, sha256: bodySha });
    return ref;
  }

  function resolveRefPath(ref, key) {
    const rel = String(ref && ref[key] || '').replace(/\\/g, '/');
    if (!rel || rel.startsWith('/') || /^[A-Za-z]:\//.test(rel) || rel.split('/').includes('..')) {
      throw storeError('PROD_SEMANTIC_REF_INVALID', 'invalid production semantic ref path');
    }
    const absolute = path.resolve(root, rel);
    if (!absolute.startsWith(root + path.sep)) throw storeError('PROD_SEMANTIC_REF_INVALID', 'production semantic ref escapes root');
    return absolute;
  }

  function readObject(ref) {
    if (!ref || !ref.objectId || !ref.kind || !/^[a-f0-9]{64}$/.test(String(ref.sha256 || ''))) {
      throw storeError('PROD_SEMANTIC_REF_INVALID', 'invalid production semantic ref');
    }
    const file = resolveRefPath(ref, 'path');
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw storeError('PROD_SEMANTIC_OBJECT_MISSING', 'production semantic object missing: ' + ref.objectId);
    }
    const bytes = fs.readFileSync(file);
    if (sha256Buffer(bytes) !== ref.sha256) {
      throw storeError('PROD_SEMANTIC_OBJECT_DRIFT', 'production semantic object hash mismatch: ' + ref.objectId);
    }
    let metadata = {};
    if (ref.metadataPath) {
      const mp = resolveRefPath(ref, 'metadataPath');
      if (!fs.existsSync(mp)) throw storeError('PROD_SEMANTIC_METADATA_MISSING', 'production semantic metadata missing: ' + ref.objectId);
      let doc;
      try { doc = JSON.parse(fs.readFileSync(mp, 'utf8')); }
      catch (e) { throw storeError('PROD_SEMANTIC_METADATA_CORRUPT', 'production semantic metadata invalid: ' + e.message); }
      if (!doc.ref || doc.ref.objectId !== ref.objectId || doc.ref.sha256 !== ref.sha256) {
        throw storeError('PROD_SEMANTIC_METADATA_CORRUPT', 'production semantic metadata identity mismatch: ' + ref.objectId);
      }
      metadata = doc.metadata || {};
    }
    return { content: bytes.toString('utf8'), metadata };
  }

  function validateCurrent(current) {
    if (!current || typeof current !== 'object' || current.schema !== CURRENT_SCHEMA) {
      throw storeError('PROD_SEMANTIC_HEAD_UNAVAILABLE', 'production semantic current schema invalid');
    }
    if (!Number.isInteger(current.revision) || current.revision < 0) {
      throw storeError('PROD_SEMANTIC_HEAD_UNAVAILABLE', 'production semantic current revision invalid');
    }
    if (!['none', 'stale', 'verified'].includes(current.projectionState)) {
      throw storeError('PROD_SEMANTIC_HEAD_UNAVAILABLE', 'production semantic projectionState invalid');
    }
    if (current.sourceSha256 != null && !/^[a-f0-9]{64}$/.test(String(current.sourceSha256))) {
      throw storeError('PROD_SEMANTIC_HEAD_UNAVAILABLE', 'production semantic sourceSha256 invalid');
    }
    if (current.contextSha256 != null && !/^[a-f0-9]{64}$/.test(String(current.contextSha256))) {
      throw storeError('PROD_SEMANTIC_HEAD_UNAVAILABLE', 'production semantic contextSha256 invalid');
    }
    if (current.semanticRef) readObject(current.semanticRef);
    if (current.projectionRef) readObject(current.projectionRef);
    if (current.projectionState === 'verified' &&
        (!current.semanticRef || !current.projectionRef || current.semanticReviewPending === true)) {
      throw storeError('PROD_SEMANTIC_HEAD_UNAVAILABLE', 'verified production current requires reviewed semantic and projection');
    }
    return current;
  }

  function readCurrentUnlocked(sessionId) {
    safeId(sessionId, 'sessionId');
    const p = currentPath(sessionId);
    if (!fs.existsSync(p)) return defaultCurrent();
    let bytes;
    try { bytes = fs.readFileSync(p); }
    catch (e) { throw storeError('PROD_SEMANTIC_HEAD_UNAVAILABLE', 'cannot read production semantic current: ' + e.message); }
    let current;
    try { current = JSON.parse(bytes.toString('utf8')); }
    catch (e) { throw storeError('PROD_SEMANTIC_HEAD_UNAVAILABLE', 'production semantic current JSON invalid: ' + e.message); }
    validateCurrent(current);
    if (!bytes.equals(Buffer.from(canonicalJson(current), 'utf8'))) {
      throw storeError('PROD_SEMANTIC_HEAD_NONCANONICAL', 'production semantic current bytes are not canonical');
    }
    return current;
  }

  function readCurrent(sessionId) {
    assertNoLock(sessionId);
    if (tempFiles(sessionId).length) {
      throw storeError('PROD_SEMANTIC_RECOVERY_REQUIRED', 'production semantic current temp residue requires explicit recovery');
    }
    return readCurrentUnlocked(sessionId);
  }

  function currentIdentity(current) {
    current = current || defaultCurrent();
    return JSON.stringify({
      schema: current.schema || null,
      revision: Number(current.revision || 0),
      semanticObjectId: current.semanticRef && current.semanticRef.objectId || null,
      projectionObjectId: current.projectionRef && current.projectionRef.objectId || null,
      semanticReviewPending: current.semanticReviewPending === true,
      projectionState: current.projectionState || null,
      sourceSha256: current.sourceSha256 || null,
      contextSha256: current.contextSha256 || null,
      commitId: current.commitId || null
    });
  }

  function atomicReplaceCurrent(sessionId, current) {
    validateCurrent(current);
    const p = currentPath(sessionId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = p + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
    const fd = fs.openSync(tmp, 'wx');
    try { fs.writeFileSync(fd, canonicalJson(current), 'utf8'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    try {
      if (typeof options.beforeCurrentReplace === 'function') {
        options.beforeCurrentReplace({ sessionId, tmp, current });
      }
      fs.renameSync(tmp, p);
      fsyncFile(p);
      if (typeof options.afterCurrentReplace === 'function') {
        options.afterCurrentReplace({ sessionId, current });
      }
    } catch (e) {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      throw e;
    }
  }

  function acquireCurrentLock(sessionId, expectedCurrent) {
    assertNoLock(sessionId);
    const lp = currentLockPath(sessionId);
    fs.mkdirSync(path.dirname(lp), { recursive: true });
    let fd = null;
    try {
      fd = fs.openSync(lp, 'wx');
      fs.writeFileSync(fd, canonicalJson({
        schema: 'judge-production-semantic-current-lock-v1',
        pid: process.pid,
        at: new Date().toISOString(),
        expected_revision: Number(expectedCurrent && expectedCurrent.revision || 0)
      }), 'utf8');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = null;
    } catch (e) {
      if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
      if (e && e.code === 'EEXIST') {
        throw storeError('PROD_SEMANTIC_STALE_LOCK_AUDIT_REQUIRED', 'production semantic current lock already exists');
      }
      throw e;
    }
    return lp;
  }

  function compareAndSetCurrent(input) {
    input = input || {};
    const sessionId = safeId(input.sessionId, 'sessionId');
    assertNoLock(sessionId);
    if (tempFiles(sessionId).length) {
      throw storeError('PROD_SEMANTIC_RECOVERY_REQUIRED', 'production semantic current temp residue requires explicit recovery');
    }
    const lock = acquireCurrentLock(sessionId, input.expectedCurrent);
    try {
      const actual = readCurrentUnlocked(sessionId);
      if (currentIdentity(actual) !== currentIdentity(input.expectedCurrent)) {
        return { applied: false, current: actual, commitRef: null };
      }

      const proposed = input.nextCurrent || {};
      if (Number(proposed.revision) !== Number(actual.revision) + 1) {
        throw storeError('PROD_SEMANTIC_CAS_REVISION_INVALID', 'next revision must equal current revision + 1');
      }
      const commitId = 'commit-' + crypto.randomBytes(12).toString('hex');
      const next = {
        schema: CURRENT_SCHEMA,
        revision: proposed.revision,
        semanticRef: proposed.semanticRef || null,
        semanticReviewPending: proposed.semanticReviewPending === true,
        projectionRef: proposed.projectionRef || null,
        projectionState: proposed.projectionState || 'none',
        sourceSha256: proposed.sourceSha256 || null,
        contextSha256: proposed.contextSha256 || null,
        lastCommitKind: proposed.lastCommitKind || null,
        commitId
      };
      validateCurrent(next);

      try {
        atomicReplaceCurrent(sessionId, next);
      } catch (e) {
        let now = null;
        try { now = readCurrentUnlocked(sessionId); } catch (_) {}
        return {
          applied: null,
          current: now,
          commitRef: null,
          error: e.message,
          error_code: e.code || null
        };
      }

      appendEvent(sessionId, {
        type: 'commit-terminal',
        commitId,
        revision: next.revision,
        semanticObjectId: next.semanticRef && next.semanticRef.objectId || null,
        projectionObjectId: next.projectionRef && next.projectionRef.objectId || null
      });
      const commitRef = appendObject({
        sessionId,
        kind: 'commit',
        content: canonicalJson(next),
        metadata: { commitId, revision: next.revision }
      });
      return { applied: true, current: next, commitRef };
    } finally {
      if (fs.existsSync(lock)) fs.unlinkSync(lock);
    }
  }

  function readEvents(sessionId) {
    const p = eventsPath(sessionId);
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf8').split(/\r?\n/).filter(Boolean).map((line, index) => {
      try { return JSON.parse(line); }
      catch (_) { throw storeError('PROD_SEMANTIC_EVENT_LOG_CORRUPT', 'invalid event log line ' + (index + 1)); }
    });
  }

  function listObjects(sessionId) {
    const dir = path.join(sessionDir(sessionId), 'objects');
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.meta.json')).sort()) {
      const p = path.join(dir, name);
      try {
        const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (doc && doc.ref) out.push(Object.assign({ persistenceState: 'complete' }, doc.ref));
      } catch (e) {
        out.push({
          objectId: name.slice(0, -'.meta.json'.length),
          kind: 'unknown',
          persistenceState: 'metadata_invalid',
          diagnostic: e.message
        });
      }
    }
    return out;
  }

  function recoverInterruptedState(sessionId) {
    sessionId = safeId(sessionId, 'sessionId');
    assertNoLock(sessionId);
    const temps = tempFiles(sessionId);
    for (const file of temps) {
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }

    const current = readCurrentUnlocked(sessionId);
    let recovered = false;
    let commitRef = null;
    if (current.commitId) {
      const terminal = readEvents(sessionId).some(e =>
        (e.type === 'commit-terminal' || e.type === 'commit-terminal-recovered') &&
        e.commitId === current.commitId
      );
      if (!terminal) {
        appendEvent(sessionId, {
          type: 'commit-terminal-recovered',
          commitId: current.commitId,
          revision: current.revision,
          semanticObjectId: current.semanticRef && current.semanticRef.objectId || null,
          projectionObjectId: current.projectionRef && current.projectionRef.objectId || null
        });
        commitRef = appendObject({
          sessionId,
          kind: 'commit',
          content: canonicalJson(current),
          metadata: { commitId: current.commitId, revision: current.revision, recovered: true }
        });
        recovered = true;
      }
    }
    return {
      ok: true,
      recovered,
      current,
      commitRef,
      temp_files_removed: temps.length
    };
  }

  return {
    root,
    appendObject,
    readObject,
    readCurrent,
    compareAndSetCurrent,
    listObjects,
    recoverInterruptedState,
    appendEvent,
    currentPath,
    currentLockPath,
    eventsPath
  };
}


module.exports = { createProductionSemanticStore, CURRENT_SCHEMA, ROOT_NAME };
