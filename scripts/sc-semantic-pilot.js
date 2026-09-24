#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createWorkflow, createExchangeCapture } = require('../executor/semantic-workflow.js');

function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}
function sha256Text(text) { return sha256Buffer(Buffer.from(String(text), 'utf8')); }
function safeId(v) {
  const s = String(v || '');
  if (!/^[A-Za-z0-9._-]+$/.test(s)) throw new Error('unsafe session/object id: ' + s);
  return s;
}
function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }
function fsyncFile(file) {
  // Windows requires a write-capable file handle for FlushFileBuffers/fsync.
  // The file has already been fully written and renamed; r+ does not mutate bytes,
  // it only gives fsyncSync a handle Windows permits for durable flush.
  const fd = fs.openSync(file, 'r+');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function atomicCreate(file, bytes) {
  mkdirp(path.dirname(file));
  const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
  const fd = fs.openSync(tmp, 'wx');
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  if (fs.existsSync(file)) {
    fs.rmSync(tmp, { force: true });
    throw new Error('immutable object already exists: ' + file);
  }
  fs.renameSync(tmp, file);
  fsyncFile(file);
}
function writeAtomicReplace(file, text, opts) {
  opts = opts || {};
  mkdirp(path.dirname(file));
  const tmp = file + '.tmp-' + process.pid + '-' + crypto.randomBytes(6).toString('hex');
  const fd = fs.openSync(tmp, 'wx');
  try {
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  if (opts.beforeReplace) opts.beforeReplace(tmp);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch (_) {}
    throw e;
  }
  fsyncFile(file);
  if (opts.afterReplace) opts.afterReplace(file);
}

function canonicalCurrentIdentity(c) {
  c = c || {};
  return JSON.stringify({
    revision: Number(c.revision || 0),
    semanticObjectId: c.semanticRef && c.semanticRef.objectId || null,
    projectionObjectId: c.projectionRef && c.projectionRef.objectId || null,
    sourceSha256: c.sourceSha256 || null,
    contextSha256: c.contextSha256 || null
  });
}

function createFileStorage(outputRoot, options) {
  options = options || {};
  const root = path.resolve(outputRoot);
  mkdirp(root);

  function sessionDir(sessionId) { return path.join(root, safeId(sessionId)); }
  function kindDir(sessionId, kind) { return path.join(sessionDir(sessionId), safeId(kind)); }
  function currentPath(sessionId) { return path.join(sessionDir(sessionId), 'current.json'); }
  function eventsPath(sessionId) { return path.join(sessionDir(sessionId), 'events.jsonl'); }

  function appendEvent(sessionId, event) {
    const p = eventsPath(sessionId);
    mkdirp(path.dirname(p));
    const line = JSON.stringify(Object.assign({ at: new Date().toISOString() }, event)) + '\n';
    const fd = fs.openSync(p, 'a');
    try { fs.writeSync(fd, line, null, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }

  function appendObject({ sessionId, kind, content, metadata }) {
    sessionId = safeId(sessionId);
    kind = safeId(kind);
    const text = String(content);
    const digest = sha256Text(text);
    const identityDigest = sha256Text(JSON.stringify(metadata || {}) + '\0' + text);
    const objectId = kind + '-' + identityDigest.slice(0, 24);
    const folderKind = ({ request: 'requests', review: 'reviews', fidelity: 'reviews', projection: 'projections', issue: 'issues', commit: 'commits' })[kind] || kind;
    const dir = kindDir(sessionId, folderKind);
    const ext = ['semantic', 'review', 'fidelity', 'projection', 'issue'].includes(kind) ? '.md' : '.txt';
    const file = path.join(dir, objectId + ext);
    const meta = path.join(dir, objectId + '.meta.json');
    const ref = {
      objectId,
      kind,
      sha256: digest,
      path: path.relative(root, file).split('\\').join('/'),
      metadataPath: path.relative(root, meta).split('\\').join('/')
    };
    const metaBytes = Buffer.from(JSON.stringify({ ref, metadata: metadata || {} }, null, 2), 'utf8');
    if (fs.existsSync(file)) {
      const existing = fs.readFileSync(file);
      if (sha256Buffer(existing) !== digest) throw new Error('object id collision: ' + objectId);
      // Crash recovery: the immutable content may have been durably renamed before
      // its sidecar metadata was created. Recreate only the missing sidecar; never
      // rewrite the already matching content object.
      if (!fs.existsSync(meta)) {
        atomicCreate(meta, metaBytes);
        appendEvent(sessionId, { type: 'object-metadata-recovered', kind, objectId, sha256: digest });
      } else {
        const stored = JSON.parse(fs.readFileSync(meta, 'utf8'));
        if (!stored.ref || stored.ref.objectId !== objectId || stored.ref.sha256 !== digest) {
          throw new Error('object metadata mismatch: ' + objectId);
        }
      }
      return ref;
    }
    atomicCreate(file, Buffer.from(text, 'utf8'));
    atomicCreate(meta, metaBytes);
    appendEvent(sessionId, { type: 'object-persisted', kind, objectId, sha256: digest });
    return ref;
  }

  function readObject(ref) {
    if (!ref || !ref.path || !ref.sha256) throw new Error('invalid ref');
    const file = path.resolve(root, ref.path);
    if (!file.startsWith(root + path.sep)) throw new Error('ref escapes storage root');
    const buf = fs.readFileSync(file);
    const got = sha256Buffer(buf);
    if (got !== ref.sha256) throw new Error('object hash mismatch: ' + ref.objectId);
    let metadata = {};
    if (ref.metadataPath) {
      const mp = path.resolve(root, ref.metadataPath);
      if (fs.existsSync(mp)) metadata = JSON.parse(fs.readFileSync(mp, 'utf8')).metadata || {};
    }
    return { content: buf.toString('utf8'), metadata };
  }

  function readCurrent(sessionId) {
    const p = currentPath(sessionId);
    if (!fs.existsSync(p)) {
      return {
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
    let c;
    try { c = JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch (e) {
      const err = new Error('head_unavailable: current.json invalid JSON: ' + e.message);
      err.code = 'HEAD_UNAVAILABLE';
      throw err;
    }
    for (const k of ['semanticRef', 'projectionRef']) {
      if (c[k]) readObject(c[k]);
    }
    return c;
  }

  function compareAndSetCurrent({ sessionId, expectedCurrent, nextCurrent }) {
    sessionId = safeId(sessionId);
    let actual;
    try { actual = readCurrent(sessionId); }
    catch (e) { return { applied: null, current: null, commitRef: null, error: e.message }; }
    if (canonicalCurrentIdentity(actual) !== canonicalCurrentIdentity(expectedCurrent)) {
      return { applied: false, current: actual, commitRef: null };
    }
    const commitId = 'commit-' + crypto.randomBytes(12).toString('hex');
    const next = Object.assign({}, nextCurrent, { commitId });
    const p = currentPath(sessionId);
    try {
      if (options.crashStage === 'before-current-replace') {
        writeAtomicReplace(p, JSON.stringify(next, null, 2), { beforeReplace: () => process.exit(85) });
      } else if (options.crashStage === 'after-current-replace') {
        writeAtomicReplace(p, JSON.stringify(next, null, 2), { afterReplace: () => process.exit(86) });
      } else {
        writeAtomicReplace(p, JSON.stringify(next, null, 2));
      }
    } catch (e) {
      return { applied: null, current: (() => { try { return readCurrent(sessionId); } catch (_) { return null; } })(), commitRef: null, error: e.message };
    }
    appendEvent(sessionId, {
      type: 'commit-terminal',
      commitId,
      revision: next.revision,
      semanticObjectId: next.semanticRef && next.semanticRef.objectId || null,
      projectionObjectId: next.projectionRef && next.projectionRef.objectId || null
    });
    const commitRef = appendObject({ sessionId, kind: 'commit', content: JSON.stringify(next), metadata: { commitId } });
    return { applied: true, current: next, commitRef };
  }

  function listObjects(sessionId) {
    const dir = sessionDir(sessionId);
    if (!fs.existsSync(dir)) return [];
    const out = [];
    for (const folder of fs.readdirSync(dir, { withFileTypes: true }).filter(x => x.isDirectory())) {
      const folderPath = path.join(dir, folder.name);
      const names = fs.readdirSync(folderPath);
      const metaNames = new Set(names.filter(name => name.endsWith('.meta.json')));
      for (const name of metaNames) {
        try {
          const doc = JSON.parse(fs.readFileSync(path.join(folderPath, name), 'utf8'));
          if (doc.ref) out.push(Object.assign({ persistenceState: 'complete' }, doc.ref));
        } catch (e) {
          out.push({
            objectId: name.slice(0, -'.meta.json'.length),
            kind: 'unknown',
            sha256: null,
            path: path.relative(root, path.join(folderPath, name)).split('\\').join('/'),
            persistenceState: 'metadata_invalid',
            diagnostic: e.message
          });
        }
      }
      for (const name of names) {
        if (name.endsWith('.meta.json') || name.endsWith('.tmp')) continue;
        const bodyPath = path.join(folderPath, name);
        if (!fs.statSync(bodyPath).isFile()) continue;
        const base = name.replace(/\.(txt|md|json)$/i, '');
        if (metaNames.has(base + '.meta.json')) continue;
        const buf = fs.readFileSync(bodyPath);
        out.push({
          objectId: base,
          kind: base.includes('-') ? base.slice(0, base.indexOf('-')) : folder.name,
          sha256: sha256Buffer(buf),
          path: path.relative(root, bodyPath).split('\\').join('/'),
          metadataPath: null,
          persistenceState: 'metadata_missing',
          diagnostic: 'immutable body exists without sidecar metadata'
        });
      }
    }
    return out;
  }

  function recoverTerminal(sessionId) {
    const current = readCurrent(sessionId);
    if (!current.commitId) return { recovered: false, reason: 'no commitId', current };
    const ep = eventsPath(sessionId);
    const events = fs.existsSync(ep)
      ? fs.readFileSync(ep, 'utf8').split(/\r?\n/).filter(Boolean).map(x => { try { return JSON.parse(x); } catch (_) { return null; } }).filter(Boolean)
      : [];
    if (events.some(e => e.type === 'commit-terminal' && e.commitId === current.commitId)) {
      return { recovered: false, reason: 'terminal already present', current };
    }
    appendEvent(sessionId, { type: 'commit-terminal-recovered', commitId: current.commitId, revision: current.revision });
    return { recovered: true, current };
  }

  return { appendObject, readObject, readCurrent, compareAndSetCurrent, listObjects, recoverTerminal, appendEvent, root };
}

function parseArgs(argv) {
  const out = {};
  const allowed = new Set([
    'mode', 'variant', 'case-manifest', 'api-config', 'budget', 'output-root',
    'resume', 'resume-action', 'issue', 'baseline-scope',
    'internal-crash-stage'
  ]);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error('unknown positional argument: ' + a);
    if (a === '--help') { out.help = true; continue; }
    const key = a.slice(2);
    if (!allowed.has(key)) throw new Error('unknown argument: ' + a);
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error('missing value for ' + a);
    out[key] = argv[++i];
  }
  return out;
}

function help() {
  return [
    'sc-semantic-pilot v2 S3 isolated prototype',
    '',
    'fixture:',
    '  node scripts/sc-semantic-pilot.js --mode fixture --variant semantic-first --case-manifest <path> --output-root <dir>',
    'live:',
    '  node scripts/sc-semantic-pilot.js --mode live --variant legacy|semantic-first --case-manifest <path> --api-config <path> --budget <path> --output-root <dir>',
    'targeted calibration (fixed protocol; no caller overrides):',
    '  node scripts/sc-semantic-pilot.js --mode targeted-calibration',
    '  node scripts/sc-semantic-pilot.js --mode targeted-calibration-broader-v2-h2h3',
    'resume:',
    '  node scripts/sc-semantic-pilot.js --resume <session-dir> --resume-action projection|render|review|unfinished [--issue <path>]',
    '',
    'fixture defaults variant=semantic-first. live requires explicit variant, api-config and budget.',
    'This S3 implementation does not auto-discover credentials and never starts live calls without explicit live configuration.'
  ].join('\n');
}

function loadJson(file) { return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); }

async function runFixture(args) {
  const manifest = loadJson(args['case-manifest']);
  const responsesPath = path.resolve(path.dirname(path.resolve(args['case-manifest'])), 'responses.json');
  const responses = loadJson(responsesPath);
  const outputRoot = path.resolve(args['output-root']);
  const storage = createFileStorage(outputRoot, { crashStage: args['internal-crash-stage'] || null });
  const calls = [];

  for (const c of manifest.cases || []) {
    const queue = Object.assign({}, responses[c.case_id] || {});
    const counters = {};
    const callModel = async req => {
      calls.push({ case_id: c.case_id, requestId: req.requestId, role: req.role, system: req.system, messages: req.messages });
      const arr = Array.isArray(queue[req.role]) ? queue[req.role] : [];
      const idx = counters[req.role] || 0;
      counters[req.role] = idx + 1;
      if (!arr[idx]) throw new Error('fixture response missing: ' + c.case_id + '/' + req.role + '#' + idx);
      return arr[idx];
    };
    const readSource = async () => {
      let sourceText;
      let contextText = '';
      if (c.source_case_id) {
        const caseDoc = loadJson(c.source_path);
        const entry = caseDoc.cases && caseDoc.cases[c.source_case_id];
        if (!entry || typeof entry.source_text !== 'string') throw new Error('fixture source_case_id missing: ' + c.source_case_id);
        sourceText = entry.source_text;
        contextText = typeof entry.context_text === 'string' ? entry.context_text : '';
      } else {
        sourceText = fs.readFileSync(path.resolve(c.source_path), 'utf8');
        contextText = c.context_path ? fs.readFileSync(path.resolve(c.context_path), 'utf8') : '';
      }
      const sourceSha256 = sha256Text(sourceText);
      const contextSha256 = contextText ? sha256Text(contextText) : null;
      if (/^[a-f0-9]{64}$/.test(String(c.source_sha256 || '')) && c.source_sha256 !== sourceSha256) {
        throw new Error('fixture source_sha256 mismatch for ' + c.case_id + ': expected=' + c.source_sha256 + ' actual=' + sourceSha256);
      }
      return { sourceText, contextText, sourceSha256, contextSha256 };
    };
    const workflow = createWorkflow(Object.assign({ callModel, readSource }, storage));
    const sessionId = safeId(c.case_id + '-' + (args.variant || 'semantic-first'));
    const a = await workflow.analyze({ sessionId, sourceRef: c.source_path, prompt: c.analyze_prompt || '分析原文', configRef: 'fixture' });
    const rv = await workflow.review({
      sessionId,
      semanticRef: a.refs.semanticCandidateRef,
      sourceRef: c.source_path,
      prompt: c.review_prompt || '实质复核',
      issueText: 'fixture substantive review',
      semanticAction: 'revise',
      expectedCurrent: await storage.readCurrent(sessionId),
      configRef: 'fixture'
    });
    if (rv.status !== 'semantic_revised') throw new Error('fixture revision did not activate: ' + rv.status);
    const pr = await workflow.project({
      sessionId,
      semanticRef: rv.refs.semanticRef,
      sourceRef: c.source_path,
      targetContract: c.target_contract || 'plain presentation',
      runFidelity: true,
      fidelityApproved: true,
      configRef: 'fixture'
    });
    const semanticObj = storage.readObject(rv.refs.semanticRef);
    const sessionDir = path.join(outputRoot, sessionId);
    fs.writeFileSync(path.join(sessionDir, 'analysis.md'), semanticObj.content, 'utf8');
    const projectionObj = storage.readObject(pr.refs.projectionRef);
    fs.writeFileSync(path.join(sessionDir, 'presentation.md'), projectionObj.content, 'utf8');
    storage.appendEvent(sessionId, { type: 'fixture-finished', callCount: calls.filter(x => x.case_id === c.case_id).length });
  }
  fs.writeFileSync(path.join(outputRoot, 'requests.json'), JSON.stringify(calls, null, 2), 'utf8');
  return { ok: true, cases: (manifest.cases || []).length, calls: calls.length, outputRoot };
}

const P4_PROTOCOL_V1 = 'P4-v1-20260908';
const P4_PROTOCOL_V2 = 'P4-v2-nonthinking-20260908';
const P4_FROZEN_PROMPT_PROFILE_ID = 'p4-v1-v2-frozen-20260908';
const P4_FROZEN_PROMPT_BUNDLE_SHA256 = '9351d850eb2b3c04c1785b391c6abdb08a01b3198cf154e8758cc8d10eb3c956';
const P4_CANDIDATE_PROFILE_ID = 'P4-candidate-targeted-role-calibration-20260908';
const P4_CANDIDATE_PROMPT_BUNDLE_SHA256 = '0e17b69538671be7a23ec4d28ffff65b042af5e274ff701e2453aacc73bd1274';
const P4_REPAIRED_CANDIDATE_PROFILE_ID = 'P4-candidate-targeted-role-calibration-finite-net-20260909';
const P4_REPAIRED_CANDIDATE_PROMPT_BUNDLE_SHA256 = '5dfaea66118861f82c77ed1f473a2fae14de1fb70b1f181ccf94c256e24b377f';

const TARGETED_PROTOCOL_ID = 'S4B-targeted-calibration-eval-v1-20260908';
const TARGETED_SPEC_RELATIVE = 'Upload/Judge恢复与重规划-260906/语义优先执行/结果/S4B-Candidate-Eval/S4B-targeted-calibration-eval-v1.NONLIVE.json';
const TARGETED_SPEC_SHA256 = '90054ee59f7267918a01e94cafb5d03c2c499d6b300e38d3b3013c27804318aa';
const TARGETED_REFERENCE_RECEIPT_RELATIVE = 'Upload/Judge恢复与重规划-260906/语义优先执行/结果/S4B-Candidate-Eval/Holdout-Advertising-Independent-Reference-Receipt.json';
const TARGETED_OUTPUT_RELATIVE = 'Upload/Judge恢复与重规划-260906/语义优先执行/结果/S4B-Candidate-Eval/live-targeted-calibration-v1';
const TARGETED_BUDGET_RELATIVE = 'Upload/Judge恢复与重规划-260906/语义优先执行/结果/S4B-Candidate-Eval/budget-targeted-calibration-v1.json';
const TARGETED_VARIANT = 'targeted-calibration';
const TARGETED_EXPECTED_ORDER = Object.freeze([
  's4b-regression-entrepreneurship:frozen:analyze',
  's4b-regression-entrepreneurship:frozen:review',
  's4b-regression-entrepreneurship:candidate:analyze',
  's4b-regression-entrepreneurship:candidate:review',
  's4b-holdout-advertising:candidate:analyze',
  's4b-holdout-advertising:candidate:review',
  's4b-holdout-advertising:frozen:analyze',
  's4b-holdout-advertising:frozen:review'
]);
const TARGETED_CONFIG = Object.freeze({
  provider: 'openai-compatible',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
  maxTokens: 16000,
  temperature: 0.3,
  thinking: 'disabled'
});

const BROADER_V2_PROTOCOL_ID = 'S4B-targeted-calibration-broader-v2-h2h3-20260909';
const BROADER_V2_ROOT_RELATIVE = 'Upload/辩词资料库-第三方学术语料/local-test-cases/S4B-broader-v2';
const BROADER_V2_MODE = 'broader-v2-h2h3';
const BROADER_V2_CLI_MODE = 'targeted-calibration-broader-v2-h2h3';
const BROADER_V2_VARIANT = 'targeted-calibration-broader-v2-h2h3';
const BROADER_V2_OUTPUT_RELATIVE = BROADER_V2_ROOT_RELATIVE + '/live-blind-ab-h2h3-v1';
const BROADER_V2_BUDGET_RELATIVE = BROADER_V2_ROOT_RELATIVE + '/budget-blind-ab-h2h3-v1.private.json';
const BROADER_V2_CONTROL = Object.freeze({
  roster: Object.freeze({ name: 'H2H3-roster-result-blinding-repair.private.json', sha256: '2a8932b4b90d1e6196a2d9646d8836f527a0f7b7b91b5f8cc49f7ec63ae2eade' }),
  sourceFreeze: Object.freeze({ name: 'H2H3-source-freeze-result-blinding-repair.private.json', sha256: '671912debfe9243fd59318708253a23e9c447d657334945911ccfa9b45a72832' }),
  resultBlinding: Object.freeze({ name: 'H2H3-result-blinding-verification.private.json', sha256: 'f60ef2c49e8ae48f01d1dc5a00e25708b79c5b97984d53aa4cd455a06345ff27' }),
  referenceFreeze: Object.freeze({ name: 'H2H3-Independent-Semantic-Reference-Freeze.private.json', sha256: '0b282a2d2e8f4adb9c0c9c021e0ea79c8d1a573fc09658f4fa3044254e640736' })
});
const BROADER_V2_CASES = Object.freeze([
  Object.freeze({
    roster_slot: 'H2',
    case_id: 's4b-expansion-h2-local-mainstage-2023',
    source_name: 's4b-expansion-h2-local-mainstage-2023.result-blinded.source.txt',
    source_sha256: '80b9d8783e08035fa07ee18161abfbed1d4c84a13154841129d504cfd2a30be4',
    source_bytes: 86732,
    reference_name: 'H2-Independent-Semantic-Reference.private.json',
    reference_sha256: 'f8f4ad497f127d91e825c4e266919c8eb48952bc5ab29831ec7b7ceabd6b6bc1',
    receipt_name: 'H2-Independent-Semantic-Reference-Receipt.private.json',
    receipt_sha256: 'cbf4ae305bc628b28ff3cc5981f5fde60255934b6f87bf068d8617ed1e7e56a4'
  }),
  Object.freeze({
    roster_slot: 'H3',
    case_id: 's4b-expansion-h3-local-2023-worldcup-tourism',
    source_name: 's4b-expansion-h3-local-2023-worldcup-tourism.result-blinded.source.txt',
    source_sha256: 'f99a726d0a9f58bb0638d0affa2630da52ea1a42d5f862b3f041949078631c7a',
    source_bytes: 56792,
    reference_name: 'H3-Independent-Semantic-Reference.private.json',
    reference_sha256: '54710f332b8f3cc0847d97239226306c8053d98b13befbc16d82c2cf5c178e86',
    receipt_name: 'H3-Independent-Semantic-Reference-Receipt.private.json',
    receipt_sha256: '5861016b2a432e2ee24d74f66ae41746390ba376e2032c9554a4e1290effed50'
  })
]);
const BROADER_V2_EXPECTED_ORDER = Object.freeze([
  's4b-expansion-h2-local-mainstage-2023:frozen:analyze',
  's4b-expansion-h2-local-mainstage-2023:frozen:review',
  's4b-expansion-h2-local-mainstage-2023:candidate:analyze',
  's4b-expansion-h2-local-mainstage-2023:candidate:review',
  's4b-expansion-h3-local-2023-worldcup-tourism:candidate:analyze',
  's4b-expansion-h3-local-2023-worldcup-tourism:candidate:review',
  's4b-expansion-h3-local-2023-worldcup-tourism:frozen:analyze',
  's4b-expansion-h3-local-2023-worldcup-tourism:frozen:review'
]);

const P4_ANALYZE_PROMPT = [
  '完整阅读原文，识别双方实际承接了哪些对方材料、怎样改变其论证作用、局部效力与剩余压力。',
  '区分结构性交锋与普通反驳/重复；不要按关键词、Phase、图边、字段或数量计算成立。',
  '对重要判断给出可回原文核查的具体位置与简短理由；不确定时说明具体歧义。'
].join('\n');
const P4_REVIEW_PROMPT = [
  '对被审分析做实质复核：检查是否遗漏重要材料承接、误读对方原主张、把普通反驳/重复夸成结构性交锋，或把局部作用扩大成完全化解。',
  '请依据完整原文输出一份可独立阅读的复核后完整分析；没有需要改义的地方也要完整重述确认后的分析，而不是只写“同意”。'
].join('\n');
const P4_REVIEW_ISSUE_TEXT = 'P4 substantive review: check omissions, misread source claims, ordinary-rebuttal overcount, and local-effect overclaim.';

const P4_CANDIDATE_ANALYZE_PROMPT = [
  '完整阅读原文，识别双方实际承接了哪些对方材料、这些材料在回应前后分别承担什么论证作用、回应产生了多少局部效力，以及仍剩下什么压力。',
  '特别检查四类容易漏掉的材料角色变化：①承认对方前提或局部价值，但否认它足以推出对方总论，并把它降为需要主体、条件、机会成本等限制的局部利益；②同一事实从“直接价值判据”改作“诊断底层机制的证据”，或反向变化；③一方击中对方攻击的强版本后，对方把机制收窄、改写或推进，需同时记录前者的局部成功和后者的剩余压力；④范围、定义或评价单位发生变化时，先回查该方更早立场，区分从始至终的框架、后续显性收束、合法澄清、范围适配争议与真正的新主张，不得仅因后文范围更窄就直接定性为“偷换”。',
  '区分结构性交锋与普通反驳、类比加强或重复；不要按关键词、Phase、图边、字段或数量计算成立，也不要因为出现“承认”“但是”“结果”“范围”等词就机械生成事件。',
  '对“偷换、承认、否认、化解、完全回应、迫使、转向”等强作用判断，必须给出可回原文核查的前后位置，并说明为什么强度足够；证据只支持局部变化时就写局部变化，存在连续框架或转写歧义时写“范围适配争议/框架收束/未决”，不要升级成确定指控。',
  '对重要判断给出可回原文核查的具体位置与简短理由；不确定时说明具体歧义。'
].join('\n');
const P4_CANDIDATE_REVIEW_PROMPT = [
  '对被审分析做实质复核：检查是否遗漏重要材料承接、误读对方原主张、把普通反驳/重复夸成结构性交锋，或把局部作用扩大成完全化解。',
  '必须专项复核：①是否漏掉“承认前提/局部价值，但否认其结论充分性并降为条件性局部利益”的作用变化；②是否漏掉“事实或结果从直接判据改作底层机制证据”等论证用途变化；③是否只写了对方后续收窄后的剩余压力，却漏写前一方击中强版本所取得的局部成功；④是否把从早期就存在的行为评价框架、后续显性收束或范围适配争议过强定性为突然“偷换/缩题”。',
  '凡使用“偷换、承认、否认、完全化解、迫使、转向”等强作用词，复核其前后原文与强度；若证据只支持局部、连续框架或未决争议，应降级表述而不是维持更强标签。',
  '请依据完整原文输出一份可独立阅读的复核后完整分析；没有需要改义的地方也要完整重述确认后的分析，而不是只写“同意”。'
].join('\n');
const P4_CANDIDATE_REVIEW_ISSUE_TEXT = 'P4 targeted substantive review: check omissions and source misreads, especially accepted-premise/denied-sufficiency role changes, evidence-use changes, local counter-success before a narrowed reply, ordinary-rebuttal overcount, local-effect overclaim, and scope-change overclaim.';
const P4_REPAIRED_CANDIDATE_REVIEW_PROMPT = [
  P4_CANDIDATE_REVIEW_PROMPT,
  '最终综合必须把“局部成立”与“决定胜负的净比较”分开：先明确哪些局部点成立、哪些压力仍残留，再比较哪些具体 causal / mechanism evidence 在净比较中权重更高；只要 outcome-determinative evidence 已出现实质不对称，就必须给出有限净方向，并明确 edge magnitude 为 slight / slight-to-moderate / moderate 之一，不要求宣称所有争议已经解决。',
  '不得因为双方都有局部得分、存在 abstract framework plurality、定义不同或仍有未决争议就自动悬置 verdict；只有 outcome-determinative evidence 真正对称，或存在不可约且决定胜负的 underdetermination 时，才允许 genuine suspension。即使给出净方向，也必须保留败方已经成立的局部成功与 remaining pressure。',
  '若争议停留在定义/框架层，不能把“双方定义不同”本身作为终点；继续比较各自后续 causal chain、机制解释、隐含预设、风险识别与 downstream choice 的承载力，并说明为何某些机制在最终净比较中权重更高。'
].join('\n');
const P4_REPAIRED_CANDIDATE_REVIEW_ISSUE_TEXT = P4_CANDIDATE_REVIEW_ISSUE_TEXT + ' Final synthesis must preserve local wins/residual pressure while enforcing finite net weighting, anti-suspension, explicit decisive mechanism comparison, and slight/slight-to-moderate/moderate edge strength whenever outcome-determinative evidence is asymmetric; genuine suspension is allowed only for determinative symmetry or irreducible underdetermination.';

function p4PromptBundleSha256(profile) {
  profile = profile || {};
  return sha256Text(String(profile.analyze || '') + '\0' + String(profile.review || '') + '\0' + String(profile.issueText || ''));
}

function checkedP4PromptProfile(profile, expectedSha256, code) {
  const actualSha256 = p4PromptBundleSha256(profile);
  if (actualSha256 !== expectedSha256) {
    throw p4Error(code, 'prompt profile byte drift: expected=' + expectedSha256 + ' actual=' + actualSha256);
  }
  return Object.freeze(profile);
}

function frozenP4PromptProfile() {
  return checkedP4PromptProfile({
    profile_id: P4_FROZEN_PROMPT_PROFILE_ID,
    analyze: P4_ANALYZE_PROMPT,
    review: P4_REVIEW_PROMPT,
    issueText: P4_REVIEW_ISSUE_TEXT,
    registered_live: true
  }, P4_FROZEN_PROMPT_BUNDLE_SHA256, 'P4_PROMPT_PROFILE_DRIFT');
}

function candidateP4PromptProfile() {
  return checkedP4PromptProfile({
    profile_id: P4_CANDIDATE_PROFILE_ID,
    analyze: P4_CANDIDATE_ANALYZE_PROMPT,
    review: P4_CANDIDATE_REVIEW_PROMPT,
    issueText: P4_CANDIDATE_REVIEW_ISSUE_TEXT,
    registered_live: false
  }, P4_CANDIDATE_PROMPT_BUNDLE_SHA256, 'P4_CANDIDATE_PROMPT_DRIFT');
}

function repairedCandidateP4PromptProfile() {
  return checkedP4PromptProfile({
    profile_id: P4_REPAIRED_CANDIDATE_PROFILE_ID,
    analyze: P4_CANDIDATE_ANALYZE_PROMPT,
    review: P4_REPAIRED_CANDIDATE_REVIEW_PROMPT,
    issueText: P4_REPAIRED_CANDIDATE_REVIEW_ISSUE_TEXT,
    registered_live: false
  }, P4_REPAIRED_CANDIDATE_PROMPT_BUNDLE_SHA256, 'P4_REPAIRED_CANDIDATE_PROMPT_DRIFT');
}

function p4ProtocolSpec(protocol) {
  const prompt = { promptProfileId: P4_FROZEN_PROMPT_PROFILE_ID, promptBundleSha256: P4_FROZEN_PROMPT_BUNDLE_SHA256 };
  if (protocol === P4_PROTOCOL_V1) return Object.assign({ protocol, thinking: null, maxTokens: 16000, temperature: 0.3, label: 'P4 v1' }, prompt);
  if (protocol === P4_PROTOCOL_V2) return Object.assign({ protocol, thinking: 'disabled', maxTokens: 16000, temperature: 0.3, label: 'P4 v2 non-thinking' }, prompt);
  throw p4Error('P4_PROTOCOL_MISMATCH', 'unsupported protocol_version: ' + protocol);
}

function assertP4PromptProfile(protocol, profile) {
  const spec = p4ProtocolSpec(protocol);
  const actual = profile || frozenP4PromptProfile();
  const actualSha256 = p4PromptBundleSha256(actual);
  if (actual.profile_id !== spec.promptProfileId || actualSha256 !== spec.promptBundleSha256) {
    throw p4Error('P4_PROMPT_PROFILE_DRIFT',
      'protocol=' + protocol + ' prompt identity drift: expected=' + spec.promptProfileId + '/' + spec.promptBundleSha256 +
      ' actual=' + String(actual.profile_id || '') + '/' + actualSha256);
  }
  return Object.freeze({
    profile_id: actual.profile_id,
    sha256: actualSha256,
    analyze: actual.analyze,
    review: actual.review,
    issueText: actual.issueText
  });
}

function fixedWorkspacePath(root, relative, label) {
  const base = path.resolve(root || process.cwd());
  const absolute = path.resolve(base, String(relative || ''));
  if (absolute !== base && !absolute.startsWith(base + path.sep)) {
    throw p4Error('P4_TARGET_PATH_ESCAPE', (label || 'fixed path') + ' escaped workspace');
  }
  return absolute;
}

function loadTargetedCalibrationSpec(root) {
  root = path.resolve(root || process.cwd());
  const specPath = fixedWorkspacePath(root, TARGETED_SPEC_RELATIVE, 'targeted machine spec');
  if (!fs.existsSync(specPath)) throw p4Error('P4_TARGET_SPEC_MISSING', 'targeted machine spec missing');
  const bytes = fs.readFileSync(specPath);
  const actualSha256 = sha256Buffer(bytes);
  if (actualSha256 !== TARGETED_SPEC_SHA256) {
    throw p4Error('P4_TARGET_SPEC_DRIFT', 'targeted machine spec SHA drift: expected=' + TARGETED_SPEC_SHA256 + ' actual=' + actualSha256);
  }
  let spec;
  try { spec = JSON.parse(bytes.toString('utf8')); }
  catch (e) { throw p4Error('P4_TARGET_SPEC_INVALID', 'targeted machine spec invalid JSON: ' + e.message); }

  if (!spec || spec.schema !== 's4b-targeted-calibration-eval-nonlive-v1' ||
      spec.protocol_id !== TARGETED_PROTOCOL_ID || spec.executable !== false ||
      spec.paid_authorized !== false || spec.production_cutover_authorized !== false) {
    throw p4Error('P4_TARGET_SPEC_INVALID', 'targeted machine spec top-level identity mismatch');
  }
  if (!spec.profiles || !spec.profiles.frozen || !spec.profiles.candidate ||
      spec.profiles.frozen.profile_id !== P4_FROZEN_PROMPT_PROFILE_ID ||
      spec.profiles.frozen.prompt_bundle_sha256 !== P4_FROZEN_PROMPT_BUNDLE_SHA256 ||
      spec.profiles.candidate.profile_id !== P4_CANDIDATE_PROFILE_ID ||
      spec.profiles.candidate.prompt_bundle_sha256 !== P4_CANDIDATE_PROMPT_BUNDLE_SHA256 ||
      spec.profiles.candidate.registered_live !== false) {
    throw p4Error('P4_TARGET_SPEC_INVALID', 'targeted profile identity mismatch');
  }
  const cfg = spec.config || {};
  if (cfg.provider !== TARGETED_CONFIG.provider ||
      cfg.base_url !== TARGETED_CONFIG.baseUrl ||
      cfg.model !== TARGETED_CONFIG.model ||
      cfg.thinking !== TARGETED_CONFIG.thinking ||
      Number(cfg.max_tokens) !== TARGETED_CONFIG.maxTokens ||
      Number(cfg.temperature) !== TARGETED_CONFIG.temperature ||
      cfg.context !== null) {
    throw p4Error('P4_TARGET_SPEC_INVALID', 'targeted config identity mismatch');
  }
  if (!Array.isArray(spec.order) || JSON.stringify(spec.order) !== JSON.stringify(TARGETED_EXPECTED_ORDER)) {
    throw p4Error('P4_TARGET_SPEC_INVALID', 'targeted 8-slot order mismatch');
  }
  const draft = spec.budget_draft || {};
  if (Number(draft.planned_logical_calls) !== 8 || Number(draft.max_logical_calls) !== 8 ||
      Number(draft.semantic_retries) !== 0 || Number(draft.max_transport_attempts) !== 16 ||
      Number(draft.max_tokens_per_call) !== 16000 || draft.deadline_utc !== null) {
    throw p4Error('P4_TARGET_SPEC_INVALID', 'targeted budget draft mismatch');
  }
  if (!Array.isArray(spec.cases) || spec.cases.length !== 2) {
    throw p4Error('P4_TARGET_SPEC_INVALID', 'targeted protocol requires exactly two fixed cases');
  }
  const expectedCases = [
    {
      case_id: 's4b-regression-entrepreneurship',
      role: 'regression',
      source_path: 'Upload/测试用辩词/在校大学生创业利（弊）大于弊（利）-世新大学-辩词.txt',
      source_sha256: '8ed8aba8096c22112df90fa002a9a0510bb89739775b2f70389e1b2d3689f576',
      reference_path: 'Upload/Judge恢复与重规划-260906/语义优先执行/结果/S1/终稿.md',
      reference_sha256: '25999f9ff1db19bb74ac4da078816ad4941d8bbadf127bf3e4f6c47b7d93bb0a',
      holdout: false
    },
    {
      case_id: 's4b-holdout-advertising',
      role: 'fresh-holdout',
      source_path: 'Upload/测试用辩词/廣告是否有利於大眾消費.txt',
      source_sha256: 'f38caeb168c1c9c420cb0a6a685419d8d8ea974ff713c8d1ba95734255dba1fa',
      holdout: true
    }
  ];
  for (let i = 0; i < expectedCases.length; i++) {
    const actual = spec.cases[i] || {};
    const expected = expectedCases[i];
    for (const key of ['case_id', 'role', 'source_path', 'source_sha256', 'holdout']) {
      if (actual[key] !== expected[key]) throw p4Error('P4_TARGET_SPEC_INVALID', 'targeted case identity mismatch: ' + expected.case_id + '/' + key);
    }
    if (expected.reference_path) {
      if (actual.reference_path !== expected.reference_path || actual.reference_sha256 !== expected.reference_sha256) {
        throw p4Error('P4_TARGET_SPEC_INVALID', 'targeted regression reference identity mismatch');
      }
    } else if (actual.reference_status !== 'required-before-live-or-explicit-comparative-only-downgrade') {
      throw p4Error('P4_TARGET_SPEC_INVALID', 'targeted holdout reference gate declaration mismatch');
    }
    const sourcePath = fixedWorkspacePath(root, actual.source_path, 'targeted source');
    if (!fs.existsSync(sourcePath) || sha256Buffer(fs.readFileSync(sourcePath)) !== expected.source_sha256) {
      throw p4Error('P4_TARGET_SOURCE_DRIFT', 'targeted source SHA drift: ' + expected.case_id);
    }
  }
  const regressionRef = fixedWorkspacePath(root, expectedCases[0].reference_path, 'targeted regression reference');
  if (!fs.existsSync(regressionRef) || sha256Buffer(fs.readFileSync(regressionRef)) !== expectedCases[0].reference_sha256) {
    throw p4Error('P4_TARGET_REFERENCE_DRIFT', 'targeted regression reference SHA drift');
  }
  return { root, specPath, spec, specSha256: actualSha256 };
}

function targetedReferenceGate(root, loaded) {
  const receiptPath = fixedWorkspacePath(root, TARGETED_REFERENCE_RECEIPT_RELATIVE, 'targeted holdout reference receipt');
  if (!fs.existsSync(receiptPath)) {
    return { ready: false, status: 'reference_required', receiptPath, receiptSha256: null, referencePath: null, referenceSha256: null };
  }
  const receiptBytes = fs.readFileSync(receiptPath);
  let receipt;
  try { receipt = JSON.parse(receiptBytes.toString('utf8')); }
  catch (e) { throw p4Error('P4_TARGET_REFERENCE_RECEIPT_INVALID', 'holdout reference receipt invalid JSON: ' + e.message); }
  const holdout = loaded.spec.cases[1];
  if (!receipt || receipt.schema !== 's4b-holdout-reference-receipt-v1' ||
      receipt.protocol_id !== TARGETED_PROTOCOL_ID ||
      receipt.source_path !== holdout.source_path ||
      receipt.source_sha256 !== holdout.source_sha256 ||
      receipt.reference_status !== 'INDEPENDENT_PRE_RUN_REFERENCE' ||
      receipt.saw_candidate_output !== false ||
      receipt.saw_frozen_output !== false ||
      receipt.saw_targeted_candidate_prompt !== false) {
    throw p4Error('P4_TARGET_REFERENCE_RECEIPT_INVALID', 'holdout independent reference receipt identity/isolation mismatch');
  }
  if (typeof receipt.reference_path !== 'string' || !receipt.reference_path ||
      !/^[a-f0-9]{64}$/.test(String(receipt.reference_sha256 || ''))) {
    throw p4Error('P4_TARGET_REFERENCE_RECEIPT_INVALID', 'holdout reference path/SHA missing');
  }
  const referencePath = fixedWorkspacePath(root, receipt.reference_path, 'targeted holdout reference');
  if (!fs.existsSync(referencePath)) throw p4Error('P4_TARGET_REFERENCE_MISSING', 'holdout reference file missing');
  const referenceSha256 = sha256Buffer(fs.readFileSync(referencePath));
  if (referenceSha256 !== receipt.reference_sha256) {
    throw p4Error('P4_TARGET_REFERENCE_DRIFT', 'holdout reference SHA drift: expected=' + receipt.reference_sha256 + ' actual=' + referenceSha256);
  }
  return {
    ready: true,
    status: 'ready',
    receiptPath,
    receiptSha256: sha256Buffer(receiptBytes),
    referencePath,
    referenceSha256
  };
}

function targetedProfileIdentityMetadata(loaded) {
  return {
    protocol_id: TARGETED_PROTOCOL_ID,
    spec_sha256: loaded.specSha256,
    profiles: {
      frozen: { profile_id: P4_FROZEN_PROMPT_PROFILE_ID, prompt_bundle_sha256: P4_FROZEN_PROMPT_BUNDLE_SHA256 },
      candidate: { profile_id: P4_CANDIDATE_PROFILE_ID, prompt_bundle_sha256: P4_CANDIDATE_PROMPT_BUNDLE_SHA256 }
    },
    cases: loaded.spec.cases.map(c => ({ case_id: c.case_id, source_sha256: c.source_sha256 })),
    order: TARGETED_EXPECTED_ORDER.slice()
  };
}

function targetedProfileSetSha256() {
  return sha256Text(JSON.stringify({
    frozen: [P4_FROZEN_PROMPT_PROFILE_ID, P4_FROZEN_PROMPT_BUNDLE_SHA256],
    candidate: [P4_CANDIDATE_PROFILE_ID, P4_CANDIDATE_PROMPT_BUNDLE_SHA256]
  }));
}

function targetedCalibrationPreflight(options) {
  options = options || {};
  const loaded = loadTargetedCalibrationSpec(options.root || process.cwd());
  const frozen = frozenP4PromptProfile();
  const candidate = candidateP4PromptProfile();
  if (frozen.registered_live !== true || candidate.registered_live !== false) {
    throw p4Error('P4_TARGET_PROFILE_REGISTRATION_INVALID', 'targeted frozen/candidate registration boundary drifted');
  }
  const reference = targetedReferenceGate(loaded.root, loaded);
  return {
    ok: true,
    protocol: TARGETED_PROTOCOL_ID,
    spec_sha256: loaded.specSha256,
    ready: reference.ready,
    status: reference.status,
    reference_receipt_sha256: reference.receiptSha256,
    reference_sha256: reference.referenceSha256,
    planned_logical_calls: 8,
    max_logical_calls: 8,
    max_transport_attempts: 16,
    semantic_retries: 0,
    loaded,
    reference
  };
}

function validateTargetedExecutionBudget(budget, loaded) {
  if (!budget || budget.protocol_version !== TARGETED_PROTOCOL_ID ||
      JSON.stringify(budget.allowed_variants) !== JSON.stringify([TARGETED_VARIANT]) ||
      Number(budget.max_model_calls) !== 8 ||
      Number(budget.max_transport_attempts) !== 16 ||
      Number(budget.max_tokens_per_call) !== 16000 ||
      Number(budget.semantic_retries) !== 0 ||
      budget.spec_sha256 !== TARGETED_SPEC_SHA256) {
    throw p4Error('P4_TARGET_BUDGET_INVALID', 'targeted execution budget identity/caps mismatch');
  }
  if (!budget.profiles ||
      budget.profiles.frozen !== P4_FROZEN_PROMPT_BUNDLE_SHA256 ||
      budget.profiles.candidate !== P4_CANDIDATE_PROMPT_BUNDLE_SHA256 ||
      !budget.sources ||
      budget.sources['s4b-regression-entrepreneurship'] !== loaded.spec.cases[0].source_sha256 ||
      budget.sources['s4b-holdout-advertising'] !== loaded.spec.cases[1].source_sha256) {
    throw p4Error('P4_TARGET_BUDGET_INVALID', 'targeted budget profile/source identity mismatch');
  }
  validateP4Budget(budget, TARGETED_VARIANT, 'R1_R2');
  return budget;
}

function parseTargetedSlot(value) {
  const parts = String(value || '').split(':');
  if (parts.length !== 3 || !['frozen', 'candidate'].includes(parts[1]) || !['analyze', 'review'].includes(parts[2])) {
    throw p4Error('P4_TARGET_SLOT_INVALID', 'invalid targeted slot: ' + value);
  }
  return { case_id: parts[0], profile_key: parts[1], role: parts[2] };
}

function createTargetedBudgetedRequestCompletion(guard, baseRequestCompletion, slots) {
  const budgeted = createBudgetedRequestCompletion(guard, baseRequestCompletion, { variant: TARGETED_VARIANT });
  const expectedSlots = (slots || TARGETED_EXPECTED_ORDER).map(parseTargetedSlot);
  return async function(cfg, messages, opts) {
    opts = opts || {};
    const state = guard.snapshot();
    const expected = expectedSlots[state.model_calls];
    if (!expected) throw p4Error('P4_TARGET_SLOT_EXHAUSTED', 'no ninth targeted logical call is permitted');
    const meta = opts.__p4Meta || {};
    const role = String(meta.role || '').replace(/^targeted-(?:frozen|candidate)-/, '');
    if (meta.case_id !== expected.case_id || meta.profile_key !== expected.profile_key || role !== expected.role) {
      throw p4Error('P4_TARGET_SLOT_MISMATCH',
        'targeted slot #' + (state.model_calls + 1) + ' expected=' +
        [expected.case_id, expected.profile_key, expected.role].join(':') + ' actual=' +
        [meta.case_id || '', meta.profile_key || '', role].join(':'));
    }
    return await budgeted(cfg, messages, opts);
  };
}

function p4Error(code, message) {
  const e = new Error('[P4] ' + message);
  e.code = code;
  return e;
}

function safeConfigRef(cfg) {
  const ref = {
    provider: String(cfg && cfg.provider || ''),
    baseUrl: String(cfg && cfg.baseUrl || '').replace(/\/+$/, ''),
    model: String(cfg && cfg.model || ''),
    maxTokens: Number(cfg && cfg.maxTokens || 0),
    temperature: Number(cfg && cfg.temperature != null ? cfg.temperature : 0.3)
  };
  // Backward-compatible identity: P4-v1 had no explicit thinking field, so absent stays byte-identical.
  if (cfg && cfg.thinking != null) ref.thinking = String(cfg.thinking);
  return Object.assign(ref, { sha256: sha256Text(JSON.stringify(ref)) });
}

function readLiveCase(caseDoc) {
  const sourcePath = path.resolve(caseDoc.source_path);
  if (!fs.existsSync(sourcePath)) throw p4Error('P4_SOURCE_MISSING', 'source missing: ' + caseDoc.source_path);
  const sourceBytes = fs.readFileSync(sourcePath);
  const sourceSha256 = sha256Buffer(sourceBytes);
  if (!/^[a-f0-9]{64}$/.test(String(caseDoc.source_sha256 || '')) || caseDoc.source_sha256 !== sourceSha256) {
    throw p4Error('P4_SOURCE_SHA_MISMATCH', caseDoc.case_id + ' source sha mismatch: expected=' + caseDoc.source_sha256 + ' actual=' + sourceSha256);
  }
  let contextText = '';
  let contextSha256 = null;
  if (caseDoc.context_path) {
    const contextPath = path.resolve(caseDoc.context_path);
    const contextBytes = fs.readFileSync(contextPath);
    contextText = contextBytes.toString('utf8');
    contextSha256 = sha256Buffer(contextBytes);
  }
  return {
    sourcePath,
    sourceText: sourceBytes.toString('utf8'),
    sourceSha256,
    contextText,
    contextSha256
  };
}

function validateP4Budget(budget, variant, baselineScope) {
  if (!budget || typeof budget !== 'object') throw p4Error('P4_BUDGET_INVALID', 'budget must be a JSON object');
  if (!Array.isArray(budget.allowed_variants) || !budget.allowed_variants.includes(variant)) {
    throw p4Error('P4_BUDGET_VARIANT', 'variant not allowed by budget: ' + variant);
  }
  if (variant === 'legacy' && budget.legacy_scope !== baselineScope) {
    throw p4Error('P4_BUDGET_SCOPE', 'legacy scope mismatch: budget=' + budget.legacy_scope + ' requested=' + baselineScope);
  }
  for (const key of ['max_model_calls', 'max_transport_attempts', 'max_tokens_per_call']) {
    if (!Number.isInteger(budget[key]) || budget[key] <= 0) throw p4Error('P4_BUDGET_INVALID', key + ' must be a positive integer');
  }
  const deadline = Date.parse(String(budget.deadline_utc || ''));
  if (!Number.isFinite(deadline)) throw p4Error('P4_BUDGET_INVALID', 'deadline_utc must be valid ISO time');
  return deadline;
}

function createBudgetGuard(options) {
  options = options || {};
  const outputRoot = path.resolve(options.outputRoot);
  mkdirp(outputRoot);
  const budgetPath = path.resolve(options.budgetPath);
  const budgetBytes = fs.readFileSync(budgetPath);
  const budget = JSON.parse(budgetBytes.toString('utf8'));
  if (options.protocol && budget.protocol_version !== options.protocol) {
    throw p4Error('P4_BUDGET_PROTOCOL', 'budget protocol mismatch: budget=' + budget.protocol_version + ' manifest=' + options.protocol);
  }
  const deadlineMs = validateP4Budget(budget, options.variant, options.baselineScope);
  const promptBundleSha256 = options.promptBundleSha256 == null ? null : String(options.promptBundleSha256);
  const promptProfileId = options.promptProfileId == null ? null : String(options.promptProfileId);
  const identityMetadata = options.identityMetadata == null ? null : JSON.parse(JSON.stringify(options.identityMetadata));
  const identityMetadataSha256 = identityMetadata == null ? null : sha256Text(JSON.stringify(identityMetadata));
  if (promptBundleSha256 && !/^[a-f0-9]{64}$/.test(promptBundleSha256)) {
    throw p4Error('P4_PROMPT_IDENTITY_INVALID', 'promptBundleSha256 must be lowercase SHA-256');
  }
  const cfgRef = safeConfigRef(options.cfg || {});
  if (cfgRef.maxTokens <= 0 || cfgRef.maxTokens > budget.max_tokens_per_call) {
    throw p4Error('P4_MAX_TOKENS', 'configured maxTokens=' + cfgRef.maxTokens + ' exceeds budget max_tokens_per_call=' + budget.max_tokens_per_call);
  }
  const budgetSha256 = sha256Buffer(budgetBytes);
  const stateFile = path.join(outputRoot, '.p4-budget-state.json');
  const eventFile = path.join(outputRoot, 'p4-budget-events.jsonl');
  let state = null;
  if (fs.existsSync(stateFile)) {
    state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (state.budget_sha256 !== budgetSha256) throw p4Error('P4_BUDGET_STATE_MISMATCH', 'existing budget state belongs to a different budget file');
    if (state.config_sha256 !== cfgRef.sha256) throw p4Error('P4_CONFIG_STATE_MISMATCH', 'existing budget state belongs to a different provider/model/config');
    if (promptBundleSha256) {
      if (!state.prompt_bundle_sha256) throw p4Error('P4_PROMPT_STATE_MISSING', 'existing budget state predates frozen prompt identity; refuse paid resume under an unbound protocol state');
      if (state.prompt_bundle_sha256 !== promptBundleSha256) throw p4Error('P4_PROMPT_STATE_MISMATCH', 'existing budget state belongs to a different prompt bundle');
      if (promptProfileId && state.prompt_profile_id !== promptProfileId) throw p4Error('P4_PROMPT_STATE_MISMATCH', 'existing budget state belongs to a different prompt profile');
    }
    if (identityMetadataSha256) {
      if (!state.identity_metadata_sha256) throw p4Error('P4_IDENTITY_STATE_MISSING', 'existing budget state predates protocol identity metadata');
      if (state.identity_metadata_sha256 !== identityMetadataSha256) throw p4Error('P4_IDENTITY_STATE_MISMATCH', 'existing budget state belongs to a different protocol identity');
    }
  } else {
    state = {
      version: promptBundleSha256 ? 2 : 1,
      budget_sha256: budgetSha256,
      config_sha256: cfgRef.sha256,
      config: cfgRef,
      prompt_profile_id: promptProfileId,
      prompt_bundle_sha256: promptBundleSha256,
      identity_metadata: identityMetadata,
      identity_metadata_sha256: identityMetadataSha256,
      model_calls: 0,
      transport_attempts: 0,
      calls_by_role: {},
      variants_seen: [],
      started_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      status: 'running'
    };
    writeAtomicReplace(stateFile, JSON.stringify(state, null, 2) + '\n');
  }
  if (!state.variants_seen.includes(options.variant)) {
    state.variants_seen.push(options.variant);
    state.updated_at = new Date().toISOString();
    writeAtomicReplace(stateFile, JSON.stringify(state, null, 2) + '\n');
  }

  const nowMs = typeof options.nowMs === 'function' ? options.nowMs : () => Date.now();
  const persist = () => writeAtomicReplace(stateFile, JSON.stringify(state, null, 2) + '\n');
  const appendEvent = event => {
    const line = JSON.stringify(Object.assign({ at: new Date().toISOString() }, event)) + '\n';
    const fd = fs.openSync(eventFile, 'a');
    try { fs.writeSync(fd, line, null, 'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  };
  const checkDeadline = () => {
    if (nowMs() >= deadlineMs) throw p4Error('P4_DEADLINE', 'deadline reached; no new paid request may start');
  };

  return {
    budget,
    stateFile,
    eventFile,
    beforeLogicalCall(meta) {
      checkDeadline();
      if (state.model_calls >= budget.max_model_calls) throw p4Error('P4_MODEL_BUDGET_EXHAUSTED', 'max_model_calls exhausted before request');
      state.model_calls += 1;
      const role = String(meta && meta.role || 'unknown');
      state.calls_by_role[role] = (state.calls_by_role[role] || 0) + 1;
      state.updated_at = new Date().toISOString();
      persist();
      appendEvent({ type: 'logical-call-registered-before-send', seq: state.model_calls, role, case_id: meta && meta.case_id || null, profile_key: meta && meta.profile_key || null, variant: meta && meta.variant || options.variant });
      return state.model_calls;
    },
    beforeTransport(meta) {
      checkDeadline();
      if (state.transport_attempts >= budget.max_transport_attempts) throw p4Error('P4_TRANSPORT_BUDGET_EXHAUSTED', 'max_transport_attempts exhausted before transport');
      state.transport_attempts += 1;
      state.updated_at = new Date().toISOString();
      persist();
      appendEvent({ type: 'transport-registered-before-send', seq: state.transport_attempts, case_id: meta && meta.case_id || null, variant: meta && meta.variant || options.variant });
      return state.transport_attempts;
    },
    finish(status) {
      state.status = status || 'finished';
      state.updated_at = new Date().toISOString();
      persist();
      appendEvent({ type: 'budget-state-finished', status: state.status, model_calls: state.model_calls, transport_attempts: state.transport_attempts });
    },
    snapshot() { return JSON.parse(JSON.stringify(state)); }
  };
}

function installTransportBudget(guard, meta) {
  const originalFetch = global.fetch;
  if (typeof originalFetch !== 'function') throw p4Error('P4_FETCH_UNAVAILABLE', 'global fetch is unavailable');
  global.fetch = async function(...args) {
    const resolvedMeta = typeof meta === 'function' ? meta() : (meta || {});
    guard.beforeTransport(resolvedMeta);
    return originalFetch.apply(this, args);
  };
  return () => { global.fetch = originalFetch; };
}

function createBudgetedRequestCompletion(guard, baseRequestCompletion, metaBase) {
  return async function(cfg, messages, opts) {
    opts = opts || {};
    const meta = Object.assign({}, metaBase || {}, opts.__p4Meta || {});
    guard.beforeLogicalCall(meta);
    const cleanOpts = Object.assign({}, opts);
    delete cleanOpts.__p4Meta;
    return await baseRequestCompletion(cfg, messages, cleanOpts);
  };
}

async function withP4LegacyNoRetry(core, fn) {
  const original = core && core.MAX_RETRIES;
  if (!Number.isInteger(original) || original < 0) {
    throw p4Error('P4_RETRY_POLICY_INVALID', 'legacy core.MAX_RETRIES is not a non-negative integer');
  }
  core.MAX_RETRIES = 0;
  if (core.MAX_RETRIES !== 0) {
    throw p4Error('P4_RETRY_POLICY_INVALID', 'legacy core.MAX_RETRIES could not be forced to zero');
  }
  try {
    return await fn();
  } finally {
    core.MAX_RETRIES = original;
  }
}

function legacyGateFailureError(res, activeRound) {
  const rows = Array.isArray(res && res.results) ? res.results : [];
  const failed = rows.find(r => r && r.ok === false && !r.skipped) || rows.find(r => r && r.ok === false) || null;
  const round = String(failed && failed.round || activeRound || 'legacy-pipeline');
  const errors = Array.isArray(failed && failed.errors) ? failed.errors.map(String) : [];
  const e = new Error('[executor] ' + round + ' first-attempt gate failure under P4 no-retry policy' +
    (errors.length ? ': ' + errors.slice(0, 8).join('; ') : ''));
  e.code = 'LEGACY_GATE_FAILURE';
  return e;
}

function identifyLegacyRound(workDir, messages) {
  const userText = (messages || []).filter(m => m && m.role === 'user').map(m => String(m.content || '')).join('\n');
  const promptFiles = fs.readdirSync(workDir).filter(name => /^\.tmp-R[^/]*-prompt\.md$/i.test(name));
  const matches = [];
  for (const name of promptFiles) {
    const prompt = fs.readFileSync(path.join(workDir, name), 'utf8');
    if (userText === prompt || userText.startsWith(prompt + '\n')) matches.push(name);
  }
  if (matches.length !== 1) throw p4Error('P4_PROMPT_IDENTITY', 'legacy prompt identity must be unique before paid send; matches=' + matches.join(','));
  const name = matches[0];
  const map = { '.tmp-R1-prompt.md': 'R1', '.tmp-R2-prompt.md': 'R2', '.tmp-R2.5-prompt.md': 'R2.5', '.tmp-R3-prompt.md': 'R3' };
  return map[name] || name.replace(/^\.tmp-|-prompt\.md$/g, '');
}

function p4WorkDir(outputRoot, caseId) {
  // Deterministic per frozen protocol/case so a roster-confirmation stop can resume the exact same workDir.
  const slug = safeId(caseId).replace(/[._]/g, '-').replace(/-+/g, '-').slice(0, 24);
  return path.join(path.resolve(outputRoot), 'legacy-work', 'judge-260908.000000-' + slug);
}

function rosterHashForAnchor(anchor) {
  const roster = Array.isArray(anchor.roster) ? anchor.roster : [];
  return require('crypto').createHash('sha256')
    .update(JSON.stringify({
      proTeam: anchor.proTeam || '',
      conTeam: anchor.conTeam || '',
      roster: roster.map(r => ({
        name: r.name,
        side: r.side,
        role: r.role,
        slot: r.slot !== false,
        aliases: Array.isArray(r.aliases) ? r.aliases : []
      }))
    }))
    .digest('hex').slice(0, 16);
}

function applyManualRosterOverride(caseDoc, source, workDir, freshAnchor) {
  if (freshAnchor && freshAnchor.extracted) {
    return { anchor: freshAnchor, manualPath: path.join(workDir, 'source-anchor.manual.json'), manualUsed: false };
  }
  const manualPath = path.join(workDir, 'source-anchor.manual.json');
  if (!fs.existsSync(manualPath)) return { anchor: freshAnchor, manualPath, manualUsed: false };
  let doc;
  try { doc = JSON.parse(fs.readFileSync(manualPath, 'utf8')); }
  catch (e) { throw p4Error('P4_MANUAL_ROSTER_INVALID', 'manual roster JSON invalid: ' + e.message); }
  if (!doc || doc.schema !== 'p4-source-anchor-manual-v1') throw p4Error('P4_MANUAL_ROSTER_INVALID', 'manual roster schema mismatch');
  if (doc.case_id !== caseDoc.case_id) throw p4Error('P4_MANUAL_ROSTER_INVALID', 'manual roster case_id mismatch');
  if (doc.source_sha256 !== source.sourceSha256) throw p4Error('P4_MANUAL_ROSTER_INVALID', 'manual roster source_sha256 mismatch');
  if (!Array.isArray(doc.roster) || doc.roster.length < 2) throw p4Error('P4_MANUAL_ROSTER_INVALID', 'manual roster must contain at least two debaters');
  const seen = new Set();
  const roster = doc.roster.map((r, i) => {
    const name = String(r && r.name || '').trim();
    const side = String(r && r.side || '').trim();
    const role = String(r && r.role || '').trim();
    const aliases = Array.isArray(r && r.aliases) ? [...new Set(r.aliases.map(x => String(x || '').trim()).filter(Boolean))] : [];
    if (!name || !['正方', '反方'].includes(side) || !role) throw p4Error('P4_MANUAL_ROSTER_INVALID', 'manual roster row ' + i + ' is incomplete');
    if (!source.sourceText.includes(name)) throw p4Error('P4_MANUAL_ROSTER_INVALID', 'manual roster name not found verbatim in source: ' + name);
    const key = name + '\u0000' + side + '\u0000' + role;
    if (seen.has(key)) throw p4Error('P4_MANUAL_ROSTER_INVALID', 'duplicate manual roster row: ' + name + '/' + side + '/' + role);
    seen.add(key);
    return { name, side, role, slot: r.slot !== false, aliases };
  });
  if (!roster.some(r => r.side === '正方') || !roster.some(r => r.side === '反方')) {
    throw p4Error('P4_MANUAL_ROSTER_INVALID', 'manual roster must include both sides');
  }
  const anchor = Object.assign({}, freshAnchor || {}, {
    extracted: true,
    hasNames: true,
    title: String(doc.title || (freshAnchor && freshAnchor.title) || '').trim(),
    proTeam: String(doc.proTeam || (freshAnchor && freshAnchor.proTeam) || '').trim(),
    conTeam: String(doc.conTeam || (freshAnchor && freshAnchor.conTeam) || '').trim(),
    roster,
    bench: Array.isArray(doc.bench) ? doc.bench : [],
    candidates: [],
    other_speakers: Array.isArray(doc.other_speakers) ? doc.other_speakers : [],
    integrity: 'full',
    integrity_detail: 'P4 manual roster override bound to case_id + source SHA-256',
    typeA: false,
    typeB: false,
    disclaimer: false,
    warnings: [...(Array.isArray(freshAnchor && freshAnchor.warnings) ? freshAnchor.warnings : []),
      'P4 manual roster override applied because fresh source-anchor extraction was missing']
  });
  anchor.rosterHash = rosterHashForAnchor(anchor);
  return { anchor, manualPath, manualUsed: true };
}

function materializeLegacyAnchor(caseDoc, source, workDir, PC) {
  const anchorPath = path.join(workDir, 'source-anchor.json');
  let oldAnchor = null;
  if (fs.existsSync(anchorPath)) {
    try { oldAnchor = JSON.parse(fs.readFileSync(anchorPath, 'utf8')); } catch (_) {}
  }
  const fresh = PC.mergeRosterAliases(PC.extractSourceAnchor(source.sourceText), oldAnchor);
  const applied = applyManualRosterOverride(caseDoc, source, workDir, fresh);
  writeAtomicReplace(anchorPath, JSON.stringify(applied.anchor, null, 2) + '\n');
  return { anchor: applied.anchor, anchorPath, manualPath: applied.manualPath, manualUsed: applied.manualUsed };
}

function prepareLegacyRoster(caseDoc, outputRoot) {
  const source = readLiveCase(caseDoc);
  const PC = require('../pipeline-controller.js');
  const workDir = p4WorkDir(outputRoot, caseDoc.case_id);
  PC.runAll(source.sourcePath, { tendency: '', auto: false, force: false, outputDir: workDir });
  const materialized = materializeLegacyAnchor(caseDoc, source, workDir, PC);
  const anchor = materialized.anchor;
  const anchorPath = materialized.anchorPath;
  const markPath = path.join(workDir, 'source-anchor.confirmed');
  let mark = null;
  if (fs.existsSync(markPath)) {
    try { mark = JSON.parse(fs.readFileSync(markPath, 'utf8')); } catch (_) {}
  }
  const confirmed = !!(anchor.extracted && anchor.rosterHash && mark && mark.rosterHash === anchor.rosterHash);
  return {
    case_id: caseDoc.case_id,
    split: caseDoc.split,
    work_dir: path.relative(process.cwd(), workDir).split('\\').join('/'),
    source_anchor_path: path.relative(process.cwd(), anchorPath).split('\\').join('/'),
    manual_override_path: path.relative(process.cwd(), materialized.manualPath).split('\\').join('/'),
    manual_override_used: materialized.manualUsed,
    confirmation_path: path.relative(process.cwd(), markPath).split('\\').join('/'),
    extracted: !!anchor.extracted,
    confirmed,
    roster_hash: anchor.rosterHash || null,
    title: anchor.title || null,
    integrity: anchor.integrity || null,
    typeA: !!anchor.typeA,
    typeB: !!anchor.typeB,
    proTeam: anchor.proTeam || null,
    conTeam: anchor.conTeam || null,
    roster: Array.isArray(anchor.roster) ? anchor.roster : [],
    candidates: Array.isArray(anchor.candidates) ? anchor.candidates : [],
    bench: Array.isArray(anchor.bench) ? anchor.bench : [],
    other_speakers: Array.isArray(anchor.other_speakers) ? anchor.other_speakers : [],
    warnings: Array.isArray(anchor.warnings) ? anchor.warnings : []
  };
}

function preflightLegacyRosters(cases, outputRoot, protocol) {
  const rows = cases.map(c => prepareLegacyRoster(c, outputRoot));
  const doc = {
    protocol: protocol || P4_PROTOCOL_V1,
    generated_at: new Date().toISOString(),
    all_confirmed: rows.every(row => row.confirmed),
    cases: rows
  };
  writeAtomicReplace(path.join(outputRoot, 'p4-roster-preflight.json'), JSON.stringify(doc, null, 2) + '\n');
  if (!doc.all_confirmed) {
    const e = p4Error('P4_ROSTER_CONFIRMATION_REQUIRED',
      'legacy source-anchor confirmation required before any paid request; inspect p4-roster-preflight.json and the listed source-anchor.json files');
    e.roster_preflight = doc;
    throw e;
  }
  return doc;
}

function caseOutcomePaths(sessionDir) {
  return {
    success: path.join(sessionDir, 'live-summary.json'),
    failure: path.join(sessionDir, 'live-failure.json')
  };
}

function loadRecordedCaseOutcome(sessionDir, caseDoc, variant, sourceSha256) {
  const paths = caseOutcomePaths(sessionDir);
  const hasSuccess = fs.existsSync(paths.success);
  const hasFailure = fs.existsSync(paths.failure);
  if (hasSuccess && hasFailure) {
    throw p4Error('P4_CASE_OUTCOME_CONFLICT', caseDoc.case_id + ' has both success and failure terminal receipts');
  }
  const file = hasSuccess ? paths.success : (hasFailure ? paths.failure : null);
  if (!file) return null;
  let doc;
  try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { throw p4Error('P4_CASE_OUTCOME_INVALID', caseDoc.case_id + ' terminal receipt is invalid JSON: ' + e.message); }
  if (!doc || doc.case_id !== caseDoc.case_id || doc.variant !== variant || doc.source_sha256 !== sourceSha256) {
    throw p4Error('P4_CASE_OUTCOME_MISMATCH', caseDoc.case_id + ' terminal receipt does not match case/variant/source');
  }
  if (hasFailure && !(doc.terminal === true && doc.denominator_failure === true && doc.ok === false)) {
    throw p4Error('P4_CASE_OUTCOME_INVALID', caseDoc.case_id + ' failure receipt is not an explicit denominator terminal');
  }
  return Object.assign({}, doc, { resumed_from_terminal_outcome: true });
}

function classifySpentCaseFailure(err) {
  const code = String(err && err.code || '');
  const message = String(err && err.message || err || '');
  if (/finish_reason=length|max_tokens 上限被截断|stop_reason=max_tokens/i.test(message)) return 'max_tokens_truncated';
  if (code === 'LEGACY_GATE_FAILURE') return 'legacy_gate_failure';
  if (code === 'MODEL_PARTIAL_RESPONSE') return 'model_partial_response';
  if (code === 'NO_MODEL_TEXT' || code === 'EMPTY_COMPLETION') return 'empty_or_missing_completion';
  if (/abort|timeout|timed out|network|fetch|socket|ECONN|ENOTFOUND|gateway/i.test(message)) return 'provider_or_transport_failure';
  return 'post_send_failure';
}

function shouldRecordSpentCaseFailure(err, before, after) {
  const code = String(err && err.code || '');
  if (code.startsWith('P4_')) return false;
  return Number(after && after.model_calls || 0) > Number(before && before.model_calls || 0);
}

function recordSpentCaseFailure(options) {
  const caseDoc = options.caseDoc;
  const source = options.source;
  const variant = options.variant;
  const sessionDir = options.sessionDir;
  const before = options.before;
  const after = options.after;
  const err = options.error;
  const logicalCalls = Number(after.model_calls || 0) - Number(before.model_calls || 0);
  const transportAttempts = Number(after.transport_attempts || 0) - Number(before.transport_attempts || 0);
  if (logicalCalls <= 0) {
    throw p4Error('P4_FAILURE_WITHOUT_SPEND', caseDoc.case_id + ' cannot be recorded as denominator failure because no logical call was spent');
  }
  const code = String(err && err.code || 'ERROR');
  if (code.startsWith('P4_')) throw err;
  const receipt = {
    case_id: caseDoc.case_id,
    split: caseDoc.split,
    variant,
    baseline_scope: 'R1_R2',
    source_path: caseDoc.source_path,
    source_sha256: source.sourceSha256,
    context_sha256: source.contextSha256,
    reference_path: caseDoc.reference_path || null,
    work_dir: options.workDir ? path.relative(process.cwd(), options.workDir).split('\\').join('/') : null,
    failure_stage: options.failureStage || null,
    ok: false,
    terminal: true,
    denominator_failure: true,
    failure_class: classifySpentCaseFailure(err),
    error_code: code,
    error_message: String(err && err.message || err || '').slice(0, 2000),
    raw_ref: err && err.rawRef || null,
    logical_model_calls: logicalCalls,
    transport_attempts: transportAttempts,
    planned_stop_reached: false,
    finished_at: new Date().toISOString()
  };
  writeAtomicReplace(caseOutcomePaths(sessionDir).failure, JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}

async function runLiveSemanticCase(caseDoc, ctx) {
  const source = readLiveCase(caseDoc);
  const variant = ctx.variant || 'semantic-first';
  const sessionSuffix = ctx.sessionSuffix || 'semantic-first';
  const rolePrefix = ctx.rolePrefix || 'semantic';
  const storageRoot = path.join(ctx.outputRoot, 'semantic-evidence');
  const storage = createFileStorage(storageRoot);
  const sessionId = safeId(caseDoc.case_id + '-' + sessionSuffix);
  const sessionDir = path.join(storageRoot, sessionId);
  const recorded = loadRecordedCaseOutcome(sessionDir, caseDoc, variant, source.sourceSha256);
  if (recorded) return recorded;

  const before = ctx.guard.snapshot();
  let failureStage = 'analyze';
  const callModel = async req => ctx.requestCompletion(ctx.cfg, req.messages, {
    system: req.system,
    returnEnvelope: true,
    __p4Meta: {
      role: rolePrefix + '-' + req.role,
      case_id: caseDoc.case_id,
      profile_key: ctx.profileKey || null,
      variant
    }
  });
  const readSource = async () => ({
    sourceText: source.sourceText,
    contextText: source.contextText,
    sourceSha256: source.sourceSha256,
    contextSha256: source.contextSha256
  });
  const workflow = createWorkflow(Object.assign({ callModel, readSource }, storage));
  const cfgRef = safeConfigRef(ctx.cfg);

  try {
    const analyzed = await workflow.analyze({
      sessionId,
      sourceRef: caseDoc.source_path,
      contextRef: caseDoc.context_path || null,
      prompt: ctx.promptProfile.analyze,
      configRef: cfgRef,
      requestId: caseDoc.case_id + '-analyze'
    });
    failureStage = 'review';
    const reviewed = await workflow.review({
      sessionId,
      semanticRef: analyzed.refs.semanticCandidateRef,
      sourceRef: caseDoc.source_path,
      contextRef: caseDoc.context_path || null,
      prompt: ctx.promptProfile.review,
      issueText: ctx.promptProfile.issueText,
      semanticAction: 'revise',
      expectedCurrent: await storage.readCurrent(sessionId),
      revisionReason: ctx.revisionReason || 'P4 paired substantive review',
      configRef: cfgRef,
      requestId: caseDoc.case_id + '-review'
    });
    if (reviewed.status !== 'semantic_revised') throw p4Error('P4_SEMANTIC_NOT_ACTIVATED', caseDoc.case_id + ' review status=' + reviewed.status);
    const semanticObj = storage.readObject(reviewed.refs.semanticRef);
    fs.writeFileSync(path.join(sessionDir, 'analysis.md'), semanticObj.content, 'utf8');
    const after = ctx.guard.snapshot();
    const summary = {
      case_id: caseDoc.case_id,
      split: caseDoc.split,
      variant,
      profile_id: ctx.promptProfile.profile_id || null,
      prompt_bundle_sha256: ctx.promptProfile.sha256 || p4PromptBundleSha256(ctx.promptProfile),
      baseline_scope: 'R1_R2',
      source_path: caseDoc.source_path,
      source_sha256: source.sourceSha256,
      context_sha256: source.contextSha256,
      reference_path: caseDoc.reference_path || null,
      ok: true,
      semantic_ref: reviewed.refs.semanticRef,
      logical_model_calls: after.model_calls - before.model_calls,
      transport_attempts: after.transport_attempts - before.transport_attempts,
      finished_at: new Date().toISOString()
    };
    writeAtomicReplace(caseOutcomePaths(sessionDir).success, JSON.stringify(summary, null, 2) + '\n');
    storage.appendEvent(sessionId, { type: 'p4-live-finished', variant, profileKey: ctx.profileKey || null, logicalModelCalls: summary.logical_model_calls, transportAttempts: summary.transport_attempts });
    return summary;
  } catch (e) {
    const after = ctx.guard.snapshot();
    if (!shouldRecordSpentCaseFailure(e, before, after)) throw e;
    const failure = recordSpentCaseFailure({
      caseDoc,
      source,
      variant,
      sessionDir,
      before,
      after,
      error: e,
      failureStage
    });
    storage.appendEvent(sessionId, {
      type: 'p4-live-terminal-failure',
      variant,
      profileKey: ctx.profileKey || null,
      failureClass: failure.failure_class,
      failureStage: failure.failure_stage,
      logicalModelCalls: failure.logical_model_calls,
      transportAttempts: failure.transport_attempts
    });
    return failure;
  }
}

async function runLiveLegacyCase(caseDoc, ctx) {
  const source = readLiveCase(caseDoc);
  const evidenceRoot = path.join(ctx.outputRoot, 'legacy-evidence');
  const storage = createFileStorage(evidenceRoot);
  const sessionId = safeId(caseDoc.case_id + '-legacy');
  const sessionDir = path.join(evidenceRoot, sessionId);
  const recorded = loadRecordedCaseOutcome(sessionDir, caseDoc, 'legacy', source.sourceSha256);
  if (recorded) return recorded;

  const PC = require('../pipeline-controller.js');
  const host = require('../executor/host-node.js');
  const core = require('../executor/core.js');
  const api = require('../executor/api-provider.js');
  const workDir = p4WorkDir(ctx.outputRoot, caseDoc.case_id);
  PC.runAll(source.sourcePath, { tendency: '', auto: false, force: false, outputDir: workDir });
  // Re-materialize the same source-bound manual roster override used by preflight before host confirmation.
  materializeLegacyAnchor(caseDoc, source, workDir, PC);

  const capture = createExchangeCapture({
    appendObject: storage.appendObject,
    callModel: async req => ctx.requestCompletion(ctx.cfg, req.messages, {
      system: req.system,
      returnEnvelope: true,
      __p4Meta: { role: 'legacy-' + req.role, case_id: caseDoc.case_id, variant: 'legacy' }
    })
  });
  const originalRequestCompletion = api.requestCompletion;
  const originalRounds = core.ROUNDS.slice();
  let requestSeq = 0;
  let activeRound = 'legacy-pipeline';
  const before = ctx.guard.snapshot();
  try {
    api.requestCompletion = async function(callCfg, messages, opts) {
      const round = identifyLegacyRound(workDir, messages);
      activeRound = round;
      if (!['R1', 'R2'].includes(round)) throw p4Error('P4_PLANNED_STOP_BREACH', 'legacy attempted out-of-scope paid round: ' + round);
      const got = await capture.capture({
        sessionId,
        requestId: round + '-attempt-' + (++requestSeq),
        role: round,
        system: opts && opts.system || api.FORMAT_SYSTEM,
        messages,
        configRef: safeConfigRef(callCfg),
        sourceRef: caseDoc.source_path,
        contextRef: caseDoc.context_path || null,
        sourceSha256: source.sourceSha256,
        contextSha256: source.contextSha256
      });
      return got.result.text;
    };
    core.ROUNDS.splice(0, core.ROUNDS.length, ...originalRounds.filter(r => r.name === 'R1' || r.name === 'R2'));
    const res = await withP4LegacyNoRetry(core, () => host.runPipeline({
      workDir,
      cfg: ctx.cfg,
      onLog: line => storage.appendEvent(sessionId, { type: 'legacy-log', message: String(line) }),
      force: false,
      plain: false,
      semanticFirstMode: 'off',
      skipRosterConfirm: false
    }));
    const after = ctx.guard.snapshot();
    if (!res.ok) {
      const failureError = legacyGateFailureError(res, activeRound);
      const failure = recordSpentCaseFailure({
        caseDoc,
        source,
        variant: 'legacy',
        sessionDir,
        before,
        after,
        error: failureError,
        workDir,
        failureStage: activeRound
      });
      storage.appendEvent(sessionId, {
        type: 'p4-live-terminal-failure',
        variant: 'legacy',
        failureClass: failure.failure_class,
        failureStage: failure.failure_stage,
        logicalModelCalls: failure.logical_model_calls,
        transportAttempts: failure.transport_attempts
      });
      return failure;
    }
    const summary = {
      case_id: caseDoc.case_id,
      split: caseDoc.split,
      variant: 'legacy',
      baseline_scope: 'R1_R2',
      source_path: caseDoc.source_path,
      source_sha256: source.sourceSha256,
      context_sha256: source.contextSha256,
      reference_path: caseDoc.reference_path || null,
      work_dir: path.relative(process.cwd(), workDir).split('\\').join('/'),
      ok: !!res.ok,
      results: (res.results || []).map(r => ({ round: r.round, ok: !!r.ok, skipped: !!r.skipped, errors: r.errors || [] })),
      planned_stop_reached: !!res.ok && (res.results || []).some(r => r.round === 'R2' && r.ok),
      logical_model_calls: after.model_calls - before.model_calls,
      transport_attempts: after.transport_attempts - before.transport_attempts,
      finished_at: new Date().toISOString()
    };
    writeAtomicReplace(caseOutcomePaths(sessionDir).success, JSON.stringify(summary, null, 2) + '\n');
    storage.appendEvent(sessionId, { type: 'p4-live-finished', variant: 'legacy', logicalModelCalls: summary.logical_model_calls, transportAttempts: summary.transport_attempts, plannedStopReached: summary.planned_stop_reached });
    return summary;
  } catch (e) {
    const after = ctx.guard.snapshot();
    if (!shouldRecordSpentCaseFailure(e, before, after)) throw e;
    const failure = recordSpentCaseFailure({
      caseDoc,
      source,
      variant: 'legacy',
      sessionDir,
      before,
      after,
      error: e,
      workDir,
      failureStage: activeRound
    });
    storage.appendEvent(sessionId, {
      type: 'p4-live-terminal-failure',
      variant: 'legacy',
      failureClass: failure.failure_class,
      failureStage: failure.failure_stage,
      logicalModelCalls: failure.logical_model_calls,
      transportAttempts: failure.transport_attempts
    });
    return failure;
  } finally {
    api.requestCompletion = originalRequestCompletion;
    core.ROUNDS.splice(0, core.ROUNDS.length, ...originalRounds);
  }
}

async function runLive(args, deps) {
  deps = deps || {};
  const manifest = loadJson(args['case-manifest']);
  const protocolSpec = p4ProtocolSpec(manifest.protocol_version);
  const promptProfile = assertP4PromptProfile(protocolSpec.protocol);
  const cases = manifest.cases || [];
  if (cases.length !== 2 || cases[0].split !== 'development' || cases[1].split !== 'holdout') {
    throw p4Error('P4_SPLIT_MISMATCH', protocolSpec.label + ' requires exactly development then holdout whole-debate cases');
  }
  const baselineScope = args['baseline-scope'] || 'R1_R2';
  if (baselineScope !== 'R1_R2') throw p4Error('P4_SCOPE_MISMATCH', protocolSpec.label + ' supports baseline_scope=R1_R2 only');
  const outputRoot = path.resolve(args['output-root']);
  mkdirp(outputRoot);

  // Legacy must surface both real source-anchor rosters before the first paid request.
  // This is deliberately before API config/key/budget activation: pending human confirmation spends zero calls/transports.
  if (args.variant === 'legacy') preflightLegacyRosters(cases, outputRoot, protocolSpec.protocol);

  const fileCfg = loadJson(args['api-config']);
  if (fileCfg.apiKey) throw p4Error('P4_SECRET_FILE', 'api-config must not persist apiKey; provide credential through environment/authorized adapter');
  const apiProvider = deps.apiProvider || require('../executor/api-provider.js');
  const cfg = apiProvider.resolveConfig(process.env, fileCfg);
  if (cfg.provider !== 'openai-compatible' || String(cfg.baseUrl || '').replace(/\/+$/, '') !== 'https://api.deepseek.com' || cfg.model !== 'deepseek-v4-flash') {
    throw p4Error('P4_CONFIG_MISMATCH', protocolSpec.label + ' requires DeepSeek official openai-compatible / https://api.deepseek.com / deepseek-v4-flash');
  }
  if (Number(cfg.maxTokens) !== protocolSpec.maxTokens || Number(cfg.temperature) !== protocolSpec.temperature) {
    throw p4Error('P4_CONFIG_MISMATCH', protocolSpec.label + ' requires maxTokens=' + protocolSpec.maxTokens + ' and temperature=' + protocolSpec.temperature);
  }
  if (protocolSpec.thinking === null && cfg.thinking != null) {
    throw p4Error('P4_CONFIG_MISMATCH', 'P4 v1 freezes provider-default thinking behavior and must not set explicit thinking');
  }
  if (protocolSpec.thinking !== null && cfg.thinking !== protocolSpec.thinking) {
    throw p4Error('P4_CONFIG_MISMATCH', protocolSpec.label + ' requires explicit thinking=' + protocolSpec.thinking);
  }
  if (!cfg.apiKey) throw p4Error('P4_KEY_MISSING', 'DeepSeek API key is not available through environment/authorized adapter; zero requests sent');
  const guard = createBudgetGuard({
    outputRoot,
    budgetPath: args.budget,
    variant: args.variant,
    baselineScope,
    cfg,
    protocol: protocolSpec.protocol,
    promptProfileId: promptProfile.profile_id,
    promptBundleSha256: promptProfile.sha256
  });
  const baseRequest = deps.requestCompletion || apiProvider.requestCompletion;
  const requestCompletion = createBudgetedRequestCompletion(guard, baseRequest, { variant: args.variant });
  const restoreFetch = deps.skipTransportHook ? () => {} : installTransportBudget(guard, { variant: args.variant });
  const summaries = [];
  try {
    for (const c of cases) {
      summaries.push(args.variant === 'semantic-first'
        ? await runLiveSemanticCase(c, { outputRoot, guard, requestCompletion, cfg, promptProfile })
        : await runLiveLegacyCase(c, { outputRoot, guard, requestCompletion, cfg }));
    }
    const allCasesOk = summaries.every(item => item && item.ok === true);
    guard.finish(allCasesOk ? 'finished' : 'finished-with-case-failures');
  } catch (e) {
    guard.finish('failed:' + String(e.code || 'ERROR'));
    throw e;
  } finally {
    restoreFetch();
  }
  const allCasesOk = summaries.every(item => item && item.ok === true);
  const result = {
    ok: true,
    protocol: manifest.protocol_version,
    prompt_profile_id: promptProfile.profile_id,
    prompt_bundle_sha256: promptProfile.sha256,
    variant: args.variant,
    baseline_scope: baselineScope,
    all_cases_ok: allCasesOk,
    case_failures: summaries.filter(item => item && item.ok === false).map(item => ({
      case_id: item.case_id,
      failure_class: item.failure_class || 'case_result_not_ok',
      failure_stage: item.failure_stage || null,
      error_code: item.error_code || null
    })),
    cases: summaries,
    budget: guard.snapshot(),
    outputRoot
  };
  writeAtomicReplace(path.join(outputRoot, 'p4-' + args.variant + '-summary.json'), JSON.stringify(result, null, 2) + '\n');
  return result;
}

function targetedPromptProfile(profileKey) {
  const source = profileKey === 'frozen' ? frozenP4PromptProfile()
    : (profileKey === 'candidate' ? candidateP4PromptProfile() : null);
  if (!source) throw p4Error('P4_TARGET_PROFILE_INVALID', 'unsupported targeted profile: ' + profileKey);
  return Object.freeze({
    profile_id: source.profile_id,
    sha256: p4PromptBundleSha256(source),
    analyze: source.analyze,
    review: source.review,
    issueText: source.issueText,
    registered_live: source.registered_live
  });
}

function targetedCaseDoc(loaded, reference, caseId) {
  const source = loaded.spec.cases.find(c => c.case_id === caseId);
  if (!source) throw p4Error('P4_TARGET_CASE_INVALID', 'targeted case missing from frozen spec: ' + caseId);
  let referencePath = source.reference_path || null;
  if (source.holdout === true) {
    if (!reference || !reference.ready || !reference.referencePath) {
      throw p4Error('P4_TARGET_REFERENCE_REQUIRED', 'fresh holdout independent reference is required before live execution');
    }
    referencePath = path.relative(loaded.root, reference.referencePath).split('\\').join('/');
  }
  return {
    case_id: source.case_id,
    split: source.role === 'regression' ? 'regression' : 'holdout',
    source_path: source.source_path,
    source_sha256: source.source_sha256,
    context_path: null,
    reference_path: referencePath
  };
}

function targetedFinalText(outputRoot, result) {
  if (!result || result.ok !== true || !result.semantic_ref || !result.semantic_ref.path) {
    throw p4Error('P4_TARGET_BLIND_PACKAGE_INVALID', 'cannot package a non-success targeted semantic result');
  }
  const storageRoot = path.resolve(outputRoot, 'semantic-evidence');
  const file = path.resolve(storageRoot, result.semantic_ref.path);
  if (!file.startsWith(storageRoot + path.sep) || !fs.existsSync(file)) {
    throw p4Error('P4_TARGET_BLIND_PACKAGE_INVALID', 'targeted semantic final path escaped/missing');
  }
  const bytes = fs.readFileSync(file);
  if (sha256Buffer(bytes) !== result.semantic_ref.sha256) {
    throw p4Error('P4_TARGET_BLIND_PACKAGE_INVALID', 'targeted semantic final SHA drift');
  }
  return bytes.toString('utf8');
}

function packageTargetedBlindCase(outputRoot, caseDoc, pair) {
  const firstKey = caseDoc.case_id === 's4b-regression-entrepreneurship' ? 'frozen' : 'candidate';
  const secondKey = firstKey === 'frozen' ? 'candidate' : 'frozen';
  const first = pair[firstKey];
  const second = pair[secondKey];
  if (!first || !second || first.ok !== true || second.ok !== true) return null;
  const dir = path.join(outputRoot, 'blind-evaluation', safeId(caseDoc.case_id));
  mkdirp(dir);
  const outputA = targetedFinalText(outputRoot, first);
  const outputB = targetedFinalText(outputRoot, second);
  writeAtomicReplace(path.join(dir, 'Output-A.md'), outputA);
  writeAtomicReplace(path.join(dir, 'Output-B.md'), outputB);
  const evaluatorPackage = {
    schema: 's4b-targeted-blind-evaluator-package-v1',
    protocol_id: TARGETED_PROTOCOL_ID,
    case_id: caseDoc.case_id,
    split: caseDoc.split,
    source_path: caseDoc.source_path,
    source_sha256: caseDoc.source_sha256,
    reference_path: caseDoc.reference_path || null,
    outputs: [
      { label: 'A', path: 'Output-A.md', sha256: sha256Text(outputA) },
      { label: 'B', path: 'Output-B.md', sha256: sha256Text(outputB) }
    ]
  };
  const mapping = {
    schema: 's4b-targeted-blind-mapping-v1',
    protocol_id: TARGETED_PROTOCOL_ID,
    case_id: caseDoc.case_id,
    reveal_only_after_case_verdict: true,
    mapping: {
      A: {
        profile_key: firstKey,
        profile_id: first.profile_id,
        prompt_bundle_sha256: first.prompt_bundle_sha256
      },
      B: {
        profile_key: secondKey,
        profile_id: second.profile_id,
        prompt_bundle_sha256: second.prompt_bundle_sha256
      }
    }
  };
  writeAtomicReplace(path.join(dir, 'evaluator-package.json'), JSON.stringify(evaluatorPackage, null, 2) + '\n');
  writeAtomicReplace(path.join(dir, 'mapping.json'), JSON.stringify(mapping, null, 2) + '\n');
  return {
    case_id: caseDoc.case_id,
    evaluator_package: path.relative(outputRoot, path.join(dir, 'evaluator-package.json')).split('\\').join('/'),
    mapping: path.relative(outputRoot, path.join(dir, 'mapping.json')).split('\\').join('/')
  };
}


function broaderV2FixedFile(root, name, expectedSha256, expectedBytes, label) {
  const file = fixedWorkspacePath(root, BROADER_V2_ROOT_RELATIVE + '/' + name, label);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) {
    throw p4Error('P4_BROADER_V2_FILE_INVALID', label + ' missing/non-regular');
  }
  const bytes = fs.readFileSync(file);
  const actualSha256 = sha256Buffer(bytes);
  if (actualSha256 !== expectedSha256) {
    throw p4Error('P4_BROADER_V2_SHA_DRIFT', label + ' SHA drift: expected=' + expectedSha256 + ' actual=' + actualSha256);
  }
  if (expectedBytes != null && bytes.length !== expectedBytes) {
    throw p4Error('P4_BROADER_V2_BYTES_DRIFT', label + ' byte length drift: expected=' + expectedBytes + ' actual=' + bytes.length);
  }
  return { file, bytes, sha256: actualSha256 };
}

function loadBroaderV2H2H3Spec(root) {
  root = path.resolve(root || process.cwd());
  const control = {};
  for (const [key, row] of Object.entries(BROADER_V2_CONTROL)) {
    control[key] = broaderV2FixedFile(root, row.name, row.sha256, null, 'broader-v2 ' + key);
  }
  const roster = JSON.parse(control.roster.bytes.toString('utf8'));
  const sourceFreeze = JSON.parse(control.sourceFreeze.bytes.toString('utf8'));
  const resultBlinding = JSON.parse(control.resultBlinding.bytes.toString('utf8'));
  const referenceFreeze = JSON.parse(control.referenceFreeze.bytes.toString('utf8'));

  if (!roster || roster.status !== 'PASS_REPAIRED_ACTIVE_ROSTER' ||
      !Array.isArray(roster.active_cases) || roster.active_cases.length !== BROADER_V2_CASES.length ||
      !roster.reserves || roster.reserves.active !== false) {
    throw p4Error('P4_BROADER_V2_ROSTER_INVALID', 'broader-v2 repaired roster status/active/reserve boundary mismatch');
  }
  if (!sourceFreeze || sourceFreeze.status !== 'PASS_REPAIRED_SOURCE_FREEZE' ||
      !Array.isArray(sourceFreeze.active_cases) || sourceFreeze.active_cases.length !== BROADER_V2_CASES.length ||
      !sourceFreeze.reserves || sourceFreeze.reserves.active !== false) {
    throw p4Error('P4_BROADER_V2_SOURCE_FREEZE_INVALID', 'broader-v2 source freeze status/active/reserve boundary mismatch');
  }
  if (!resultBlinding || resultBlinding.status !== 'PASS') {
    throw p4Error('P4_BROADER_V2_BLINDING_INVALID', 'broader-v2 result-blinding verification is not PASS');
  }
  if (!referenceFreeze || referenceFreeze.status !== 'PASS_FROZEN' ||
      !referenceFreeze.cases || !referenceFreeze.reserves || referenceFreeze.reserves.active !== false) {
    throw p4Error('P4_BROADER_V2_REFERENCE_FREEZE_INVALID', 'broader-v2 reference freeze status/reserve boundary mismatch');
  }

  const cases = BROADER_V2_CASES.map((expected, index) => {
    const rosterRow = roster.active_cases[index] || {};
    const sourceRow = sourceFreeze.active_cases[index] || {};
    const refRow = referenceFreeze.cases[expected.roster_slot] || {};
    const exact = row => row.roster_slot === expected.roster_slot &&
      row.local_case_id === expected.case_id &&
      row.source_file === expected.source_name &&
      row.source_sha256 === expected.source_sha256 &&
      Number(row.source_bytes) === expected.source_bytes;
    if (!exact(rosterRow) || !exact(sourceRow)) {
      throw p4Error('P4_BROADER_V2_SCOPE_INVALID', 'broader-v2 active scope mismatch at slot ' + expected.roster_slot);
    }
    if (refRow.local_case_id !== expected.case_id ||
        refRow.source_file !== expected.source_name ||
        refRow.source_sha256 !== expected.source_sha256 ||
        Number(refRow.source_bytes) !== expected.source_bytes ||
        refRow.reference_file !== expected.reference_name ||
        refRow.reference_sha256 !== expected.reference_sha256 ||
        refRow.receipt_file !== expected.receipt_name ||
        refRow.receipt_sha256 !== expected.receipt_sha256) {
      throw p4Error('P4_BROADER_V2_REFERENCE_INVALID', 'broader-v2 reference identity mismatch at slot ' + expected.roster_slot);
    }
    const source = broaderV2FixedFile(root, expected.source_name, expected.source_sha256, expected.source_bytes, expected.roster_slot + ' result-blinded source');
    const reference = broaderV2FixedFile(root, expected.reference_name, expected.reference_sha256, null, expected.roster_slot + ' independent semantic reference');
    const receipt = broaderV2FixedFile(root, expected.receipt_name, expected.receipt_sha256, null, expected.roster_slot + ' independent reference receipt');
    return Object.freeze({
      roster_slot: expected.roster_slot,
      case_id: expected.case_id,
      source_path: source.file,
      source_name: expected.source_name,
      source_sha256: expected.source_sha256,
      source_bytes: expected.source_bytes,
      reference_path: reference.file,
      reference_name: expected.reference_name,
      reference_sha256: expected.reference_sha256,
      receipt_path: receipt.file,
      receipt_name: expected.receipt_name,
      receipt_sha256: expected.receipt_sha256
    });
  });

  const activeIds = cases.map(c => c.case_id);
  if (activeIds.length !== 2 || new Set(activeIds).size !== 2 ||
      activeIds[0] !== BROADER_V2_CASES[0].case_id || activeIds[1] !== BROADER_V2_CASES[1].case_id) {
    throw p4Error('P4_BROADER_V2_SCOPE_INVALID', 'broader-v2 execution set must be exactly H2/H3');
  }

  return { root, control, roster, sourceFreeze, resultBlinding, referenceFreeze, cases };
}

function broaderV2H2H3Preflight(options) {
  options = options || {};
  const loaded = loadBroaderV2H2H3Spec(options.root || process.cwd());
  const left = frozenP4PromptProfile();
  const right = candidateP4PromptProfile();
  if (left.registered_live !== true || right.registered_live !== false) {
    throw p4Error('P4_BROADER_V2_PROFILE_REGISTRATION_INVALID', 'broader-v2 internal profile registration boundary drifted');
  }
  return {
    ok: true,
    protocol: BROADER_V2_PROTOCOL_ID,
    ready: true,
    status: 'ready',
    planned_logical_calls: 8,
    max_logical_calls: 8,
    max_transport_attempts: 16,
    semantic_retries: 0,
    active_roster: loaded.cases.map(c => ({ roster_slot: c.roster_slot, case_id: c.case_id })),
    reserve_active: false,
    loaded
  };
}

function validateBroaderV2H2H3Budget(budget, loaded) {
  if (!budget || budget.protocol_version !== BROADER_V2_PROTOCOL_ID ||
      JSON.stringify(budget.allowed_variants) !== JSON.stringify([BROADER_V2_VARIANT]) ||
      Number(budget.max_model_calls) !== 8 ||
      Number(budget.max_transport_attempts) !== 16 ||
      Number(budget.max_tokens_per_call) !== 16000 ||
      Number(budget.semantic_retries) !== 0) {
    throw p4Error('P4_BROADER_V2_BUDGET_INVALID', 'broader-v2 execution budget caps/protocol mismatch');
  }
  if (!budget.profiles ||
      budget.profiles.frozen !== P4_FROZEN_PROMPT_BUNDLE_SHA256 ||
      budget.profiles.candidate !== P4_CANDIDATE_PROMPT_BUNDLE_SHA256 ||
      !budget.sources ||
      loaded.cases.some(c => budget.sources[c.case_id] !== c.source_sha256)) {
    throw p4Error('P4_BROADER_V2_BUDGET_INVALID', 'broader-v2 execution budget identity/source mismatch');
  }
  validateP4Budget(budget, BROADER_V2_VARIANT, 'R1_R2');
  return budget;
}

function broaderV2CaseDoc(loaded, caseId) {
  const row = loaded.cases.find(c => c.case_id === caseId);
  if (!row) throw p4Error('P4_BROADER_V2_CASE_INVALID', 'broader-v2 case is outside the exact H2/H3 execution set');
  return {
    roster_slot: row.roster_slot,
    case_id: row.case_id,
    split: 'broader-v2',
    source_path: row.source_path.toString(),
    source_file: row.source_name,
    source_sha256: row.source_sha256,
    context_path: null,
    reference_path: row.reference_path.toString(),
    reference_file: row.reference_name,
    reference_sha256: row.reference_sha256
  };
}

function packageBroaderV2BlindCase(outputRoot, caseDoc, pair) {
  const firstKey = caseDoc.roster_slot === 'H2' ? 'frozen' : 'candidate';
  const secondKey = firstKey === 'frozen' ? 'candidate' : 'frozen';
  const first = pair[firstKey];
  const second = pair[secondKey];
  if (!first || !second || first.ok !== true || second.ok !== true) return null;

  const blindDir = path.join(outputRoot, 'blind-evaluation', safeId(caseDoc.case_id));
  const privateDir = path.join(outputRoot, 'private-mapping');
  mkdirp(blindDir);
  mkdirp(privateDir);
  const outputA = targetedFinalText(outputRoot, first);
  const outputB = targetedFinalText(outputRoot, second);
  const outputAPath = path.join(blindDir, 'Output-A.md');
  const outputBPath = path.join(blindDir, 'Output-B.md');
  writeAtomicReplace(outputAPath, outputA);
  writeAtomicReplace(outputBPath, outputB);

  const evaluatorPackage = {
    schema: 's4b-broader-v2-h2h3-blind-evaluator-package-v1',
    protocol_id: BROADER_V2_PROTOCOL_ID,
    roster_slot: caseDoc.roster_slot,
    case_id: caseDoc.case_id,
    source_file: caseDoc.source_file,
    source_sha256: caseDoc.source_sha256,
    reference_file: caseDoc.reference_file,
    reference_sha256: caseDoc.reference_sha256,
    outputs: [
      { label: 'A', path: 'Output-A.md', sha256: sha256Text(outputA) },
      { label: 'B', path: 'Output-B.md', sha256: sha256Text(outputB) }
    ]
  };
  const mapping = {
    schema: 's4b-broader-v2-h2h3-blind-mapping-private-v1',
    protocol_id: BROADER_V2_PROTOCOL_ID,
    roster_slot: caseDoc.roster_slot,
    case_id: caseDoc.case_id,
    reveal_only_after_case_verdict: true,
    mapping: {
      A: { profile_key: firstKey, profile_id: first.profile_id, prompt_bundle_sha256: first.prompt_bundle_sha256 },
      B: { profile_key: secondKey, profile_id: second.profile_id, prompt_bundle_sha256: second.prompt_bundle_sha256 }
    }
  };
  const evaluatorPath = path.join(blindDir, 'evaluator-package.json');
  writeAtomicReplace(evaluatorPath, JSON.stringify(evaluatorPackage, null, 2) + '\n');
  writeAtomicReplace(path.join(privateDir, safeId(caseDoc.case_id) + '.mapping.private.json'), JSON.stringify(mapping, null, 2) + '\n');
  return {
    roster_slot: caseDoc.roster_slot,
    case_id: caseDoc.case_id,
    evaluator_package: path.relative(outputRoot, evaluatorPath).split('\\').join('/'),
    outputs: evaluatorPackage.outputs.map(row => ({
      label: row.label,
      path: path.relative(outputRoot, path.join(blindDir, row.path)).split('\\').join('/'),
      sha256: row.sha256
    }))
  };
}

async function runBroaderV2H2H3Calibration(options, deps) {
  options = options || {};
  deps = deps || {};
  const root = path.resolve(options.root || process.cwd());
  const preflight = broaderV2H2H3Preflight({ root });
  const loaded = preflight.loaded;
  const budgetPath = fixedWorkspacePath(root, BROADER_V2_BUDGET_RELATIVE, 'broader-v2 H2/H3 execution budget');
  if (!fs.existsSync(budgetPath)) throw p4Error('P4_BROADER_V2_BUDGET_MISSING', 'broader-v2 H2/H3 execution budget is missing');
  const budget = loadJson(budgetPath);
  validateBroaderV2H2H3Budget(budget, loaded);

  const apiProvider = deps.apiProvider || require('../executor/api-provider.js');
  const cfg = apiProvider.resolveConfig(deps.env || process.env, Object.assign({}, TARGETED_CONFIG));
  if (cfg.provider !== TARGETED_CONFIG.provider ||
      String(cfg.baseUrl || '').replace(/\/+$/, '') !== TARGETED_CONFIG.baseUrl ||
      cfg.model !== TARGETED_CONFIG.model ||
      Number(cfg.maxTokens) !== TARGETED_CONFIG.maxTokens ||
      Number(cfg.temperature) !== TARGETED_CONFIG.temperature ||
      cfg.thinking !== TARGETED_CONFIG.thinking) {
    throw p4Error('P4_BROADER_V2_CONFIG_MISMATCH', 'broader-v2 H2/H3 requires the frozen targeted execution config');
  }
  if (!cfg.apiKey) throw p4Error('P4_BROADER_V2_KEY_MISSING', 'execution credential is unavailable; zero requests sent');

  const outputRoot = fixedWorkspacePath(root, BROADER_V2_OUTPUT_RELATIVE, 'broader-v2 H2/H3 output root');
  mkdirp(outputRoot);
  const identityMetadata = {
    protocol_id: BROADER_V2_PROTOCOL_ID,
    profiles: {
      frozen: { profile_id: P4_FROZEN_PROMPT_PROFILE_ID, prompt_bundle_sha256: P4_FROZEN_PROMPT_BUNDLE_SHA256 },
      candidate: { profile_id: P4_CANDIDATE_PROFILE_ID, prompt_bundle_sha256: P4_CANDIDATE_PROMPT_BUNDLE_SHA256 }
    },
    cases: loaded.cases.map(c => ({
      roster_slot: c.roster_slot,
      case_id: c.case_id,
      source_sha256: c.source_sha256,
      reference_sha256: c.reference_sha256,
      receipt_sha256: c.receipt_sha256
    })),
    controls: Object.fromEntries(Object.entries(BROADER_V2_CONTROL).map(([key, row]) => [key, row.sha256])),
    order: BROADER_V2_EXPECTED_ORDER.slice(),
    reserve_active: false
  };
  const guard = createBudgetGuard({
    outputRoot,
    budgetPath,
    variant: BROADER_V2_VARIANT,
    baselineScope: 'R1_R2',
    cfg,
    protocol: BROADER_V2_PROTOCOL_ID,
    promptProfileId: 's4b-targeted-profile-set-v1',
    promptBundleSha256: targetedProfileSetSha256(),
    identityMetadata
  });
  const baseRequest = deps.requestCompletion || apiProvider.requestCompletion;
  const requestCompletion = createTargetedBudgetedRequestCompletion(guard, baseRequest, BROADER_V2_EXPECTED_ORDER);
  const dynamicTransportMeta = () => {
    const state = guard.snapshot();
    const index = Math.max(0, Math.min(BROADER_V2_EXPECTED_ORDER.length - 1, state.model_calls - 1));
    const slot = parseTargetedSlot(BROADER_V2_EXPECTED_ORDER[index]);
    return { variant: BROADER_V2_VARIANT, case_id: slot.case_id, profile_key: slot.profile_key, role: 'targeted-' + slot.profile_key + '-' + slot.role };
  };
  const restoreFetch = deps.skipTransportHook ? () => {} : installTransportBudget(guard, dynamicTransportMeta);
  const groups = [
    { case_id: BROADER_V2_CASES[0].case_id, profile_key: 'frozen' },
    { case_id: BROADER_V2_CASES[0].case_id, profile_key: 'candidate' },
    { case_id: BROADER_V2_CASES[1].case_id, profile_key: 'candidate' },
    { case_id: BROADER_V2_CASES[1].case_id, profile_key: 'frozen' }
  ];
  const results = [];
  const pairs = {};
  try {
    for (const group of groups) {
      const caseDoc = broaderV2CaseDoc(loaded, group.case_id);
      const profile = targetedPromptProfile(group.profile_key);
      const item = await runLiveSemanticCase(caseDoc, {
        outputRoot,
        guard,
        requestCompletion,
        cfg,
        promptProfile: profile,
        variant: 'targeted-' + group.profile_key,
        sessionSuffix: 'targeted-' + group.profile_key,
        rolePrefix: 'targeted-' + group.profile_key,
        profileKey: group.profile_key,
        revisionReason: 'S4B broader-v2 H2/H3 targeted calibration substantive review'
      });
      results.push(Object.assign({ profile_key: group.profile_key }, item));
      pairs[group.case_id] = pairs[group.case_id] || {};
      pairs[group.case_id][group.profile_key] = item;
    }
    const allCasesOk = results.every(item => item && item.ok === true);
    guard.finish(allCasesOk ? 'finished' : 'finished-with-case-failures');
  } catch (e) {
    guard.finish('failed:' + String(e.code || 'ERROR'));
    throw e;
  } finally {
    restoreFetch();
  }

  const blindPackages = loaded.cases.map(row => {
    const caseDoc = broaderV2CaseDoc(loaded, row.case_id);
    return packageBroaderV2BlindCase(outputRoot, caseDoc, pairs[row.case_id] || {});
  }).filter(Boolean);
  const allCasesOk = results.every(item => item && item.ok === true);
  const privateSummary = {
    ok: true,
    schema: 's4b-broader-v2-h2h3-live-summary-private-v1',
    protocol: BROADER_V2_PROTOCOL_ID,
    identity_metadata: identityMetadata,
    profile_set_sha256: targetedProfileSetSha256(),
    exact_order: BROADER_V2_EXPECTED_ORDER.slice(),
    results,
    blind_packages: blindPackages,
    budget: guard.snapshot(),
    all_cases_ok: allCasesOk,
    reserve_active: false,
    production_cutover: false,
    s4b: 'HOLD'
  };
  writeAtomicReplace(path.join(outputRoot, 's4b-broader-v2-h2h3-summary.private.json'), JSON.stringify(privateSummary, null, 2) + '\n');

  const safeReceipt = {
    ok: true,
    schema: 's4b-broader-v2-h2h3-generation-safe-v1',
    status: allCasesOk && blindPackages.length === 2 ? 'completed' : 'incomplete',
    active_roster: loaded.cases.map(c => ({ roster_slot: c.roster_slot, case_id: c.case_id })),
    reserve_active: false,
    blind_packages: blindPackages,
    logical_call_count: guard.snapshot().model_calls,
    expected_action_invocations: 1,
    production_cutover: false,
    s4b: 'HOLD'
  };
  writeAtomicReplace(path.join(outputRoot, 's4b-broader-v2-h2h3-generation.safe.json'), JSON.stringify(safeReceipt, null, 2) + '\n');
  return safeReceipt;
}

async function runTargetedCalibration(options, deps) {
  options = options || {};
  deps = deps || {};
  const root = path.resolve(options.root || process.cwd());
  const preflight = targetedCalibrationPreflight({ root });
  if (!preflight.ready) {
    throw p4Error('P4_TARGET_REFERENCE_REQUIRED', 'fresh holdout independent reference receipt is required; zero requests sent');
  }
  const loaded = preflight.loaded;
  const budgetPath = fixedWorkspacePath(root, TARGETED_BUDGET_RELATIVE, 'targeted execution budget');
  if (!fs.existsSync(budgetPath)) throw p4Error('P4_TARGET_BUDGET_MISSING', 'targeted execution budget is missing');
  const budget = loadJson(budgetPath);
  validateTargetedExecutionBudget(budget, loaded);

  const apiProvider = deps.apiProvider || require('../executor/api-provider.js');
  const cfg = apiProvider.resolveConfig(deps.env || process.env, Object.assign({}, TARGETED_CONFIG));
  if (cfg.provider !== TARGETED_CONFIG.provider ||
      String(cfg.baseUrl || '').replace(/\/+$/, '') !== TARGETED_CONFIG.baseUrl ||
      cfg.model !== TARGETED_CONFIG.model ||
      Number(cfg.maxTokens) !== TARGETED_CONFIG.maxTokens ||
      Number(cfg.temperature) !== TARGETED_CONFIG.temperature ||
      cfg.thinking !== TARGETED_CONFIG.thinking) {
    throw p4Error('P4_TARGET_CONFIG_MISMATCH', 'targeted calibration requires exact DeepSeek official non-thinking config');
  }
  if (!cfg.apiKey) throw p4Error('P4_TARGET_KEY_MISSING', 'DeepSeek API key is unavailable; zero requests sent');

  const outputRoot = fixedWorkspacePath(root, TARGETED_OUTPUT_RELATIVE, 'targeted output root');
  mkdirp(outputRoot);
  const identityMetadata = targetedProfileIdentityMetadata(loaded);
  identityMetadata.reference_receipt_sha256 = preflight.reference_receipt_sha256;
  identityMetadata.reference_sha256 = preflight.reference_sha256;
  const guard = createBudgetGuard({
    outputRoot,
    budgetPath,
    variant: TARGETED_VARIANT,
    baselineScope: 'R1_R2',
    cfg,
    protocol: TARGETED_PROTOCOL_ID,
    promptProfileId: 's4b-targeted-profile-set-v1',
    promptBundleSha256: targetedProfileSetSha256(),
    identityMetadata
  });
  const baseRequest = deps.requestCompletion || apiProvider.requestCompletion;
  const requestCompletion = createTargetedBudgetedRequestCompletion(guard, baseRequest, TARGETED_EXPECTED_ORDER);
  const dynamicTransportMeta = () => {
    const state = guard.snapshot();
    const index = Math.max(0, Math.min(TARGETED_EXPECTED_ORDER.length - 1, state.model_calls - 1));
    const slot = parseTargetedSlot(TARGETED_EXPECTED_ORDER[index]);
    return {
      variant: TARGETED_VARIANT,
      case_id: slot.case_id,
      profile_key: slot.profile_key,
      role: 'targeted-' + slot.profile_key + '-' + slot.role
    };
  };
  const restoreFetch = deps.skipTransportHook ? () => {} : installTransportBudget(guard, dynamicTransportMeta);
  const groups = [
    { case_id: 's4b-regression-entrepreneurship', profile_key: 'frozen' },
    { case_id: 's4b-regression-entrepreneurship', profile_key: 'candidate' },
    { case_id: 's4b-holdout-advertising', profile_key: 'candidate' },
    { case_id: 's4b-holdout-advertising', profile_key: 'frozen' }
  ];
  const results = [];
  const pairs = {};
  try {
    for (const group of groups) {
      const caseDoc = targetedCaseDoc(loaded, preflight.reference, group.case_id);
      const profile = targetedPromptProfile(group.profile_key);
      const item = await runLiveSemanticCase(caseDoc, {
        outputRoot,
        guard,
        requestCompletion,
        cfg,
        promptProfile: profile,
        variant: 'targeted-' + group.profile_key,
        sessionSuffix: 'targeted-' + group.profile_key,
        rolePrefix: 'targeted-' + group.profile_key,
        profileKey: group.profile_key,
        revisionReason: 'S4B targeted calibration substantive review'
      });
      results.push(Object.assign({ profile_key: group.profile_key }, item));
      pairs[group.case_id] = pairs[group.case_id] || {};
      pairs[group.case_id][group.profile_key] = item;
    }
    const allCasesOk = results.every(item => item && item.ok === true);
    guard.finish(allCasesOk ? 'finished' : 'finished-with-case-failures');
  } catch (e) {
    guard.finish('failed:' + String(e.code || 'ERROR'));
    throw e;
  } finally {
    restoreFetch();
  }

  const blindPackages = [];
  for (const caseId of ['s4b-regression-entrepreneurship', 's4b-holdout-advertising']) {
    const caseDoc = targetedCaseDoc(loaded, preflight.reference, caseId);
    const packaged = packageTargetedBlindCase(outputRoot, caseDoc, pairs[caseId] || {});
    if (packaged) blindPackages.push(packaged);
  }
  const allCasesOk = results.every(item => item && item.ok === true);
  const summary = {
    ok: true,
    protocol: TARGETED_PROTOCOL_ID,
    spec_sha256: TARGETED_SPEC_SHA256,
    profile_set_sha256: targetedProfileSetSha256(),
    profiles: identityMetadata.profiles,
    reference_receipt_sha256: preflight.reference_receipt_sha256,
    reference_sha256: preflight.reference_sha256,
    variant: TARGETED_VARIANT,
    all_cases_ok: allCasesOk,
    planned_logical_calls: 8,
    semantic_retries: 0,
    max_transport_attempts: 16,
    exact_order: TARGETED_EXPECTED_ORDER.slice(),
    results,
    blind_packages: blindPackages,
    budget: guard.snapshot(),
    outputRoot
  };
  writeAtomicReplace(path.join(outputRoot, 's4b-targeted-calibration-summary.json'), JSON.stringify(summary, null, 2) + '\n');
  return summary;
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error('ERROR ' + e.message); process.exit(2); }
  if (args.help) { console.log(help()); return; }

  if (args.resume) {
    if (!args['resume-action']) throw new Error('--resume requires --resume-action');
    const resumeActions = new Set(['projection', 'render', 'review', 'unfinished']);
    if (!resumeActions.has(args['resume-action'])) throw new Error('unsupported --resume-action: ' + args['resume-action']);
    if (args['resume-action'] === 'review' && !args.issue) throw new Error('review resume requires --issue');
    if (args['resume-action'] !== 'review' && args.issue) throw new Error('--issue is only valid with review resume');
    const sessionDir = path.resolve(args.resume);
    const sessionId = path.basename(sessionDir);
    const storage = createFileStorage(path.dirname(sessionDir));
    const rec = storage.recoverTerminal(sessionId);
    const objects = storage.listObjects(sessionId);
    console.log(JSON.stringify({
      ok: true,
      action: args['resume-action'],
      recovery: rec,
      inspection: { current: rec.current, objects }
    }, null, 2));
    return;
  }

  const mode = args.mode || 'fixture';
  if (!['fixture', 'live', 'targeted-calibration', BROADER_V2_CLI_MODE].includes(mode)) throw new Error('unknown --mode: ' + mode);

  if (mode === 'targeted-calibration') {
    const extras = Object.keys(args).filter(key => key !== 'mode');
    if (extras.length) throw new Error('targeted-calibration accepts no caller overrides: ' + extras.join(','));
    const r = await runTargetedCalibration({ root: process.cwd() });
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (mode === BROADER_V2_CLI_MODE) {
    const extras = Object.keys(args).filter(key => key !== 'mode');
    if (extras.length) throw new Error(BROADER_V2_CLI_MODE + ' accepts no caller overrides: ' + extras.join(','));
    const r = await runBroaderV2H2H3Calibration({ root: process.cwd() });
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (!args['case-manifest'] || !args['output-root']) throw new Error('--case-manifest and --output-root are required');

  if (mode === 'fixture') {
    const variant = args.variant || 'semantic-first';
    if (variant !== 'semantic-first') throw new Error('fixture S3 currently supports semantic-first only');
    args.variant = variant;
    const r = await runFixture(args);
    console.log(JSON.stringify(r, null, 2));
    return;
  }

  if (!args.variant || !['legacy', 'semantic-first'].includes(args.variant)) throw new Error('live requires --variant legacy|semantic-first');
  if (!args['api-config'] || !args.budget) throw new Error('live requires explicit --api-config and --budget; no automatic provider/credential discovery');
  const r = await runLive(args);
  console.log(JSON.stringify(r, null, 2));
}

if (require.main === module) {
  main().catch(e => { console.error('ERROR ' + (e.code ? '[' + e.code + '] ' : '') + e.message); process.exit(1); });
}

module.exports = {
  createFileStorage, runFixture, runLive, runTargetedCalibration, parseArgs, help, sha256Text,
  createBudgetGuard, installTransportBudget, createBudgetedRequestCompletion, createTargetedBudgetedRequestCompletion,
  targetedCalibrationPreflight, loadTargetedCalibrationSpec, targetedReferenceGate,
  validateTargetedExecutionBudget, targetedProfileSetSha256, packageTargetedBlindCase,
  withP4LegacyNoRetry, legacyGateFailureError,
  identifyLegacyRound, safeConfigRef, readLiveCase, validateP4Budget,
  p4WorkDir, prepareLegacyRoster, preflightLegacyRosters,
  loadRecordedCaseOutcome, shouldRecordSpentCaseFailure, recordSpentCaseFailure,
  p4ProtocolSpec, assertP4PromptProfile, p4PromptBundleSha256,
  frozenP4PromptProfile, candidateP4PromptProfile, repairedCandidateP4PromptProfile,
  P4_PROTOCOL_V1, P4_PROTOCOL_V2,
  P4_FROZEN_PROMPT_PROFILE_ID, P4_FROZEN_PROMPT_BUNDLE_SHA256,
  P4_CANDIDATE_PROFILE_ID, P4_CANDIDATE_PROMPT_BUNDLE_SHA256,
  P4_REPAIRED_CANDIDATE_PROFILE_ID, P4_REPAIRED_CANDIDATE_PROMPT_BUNDLE_SHA256,
  TARGETED_PROTOCOL_ID, TARGETED_SPEC_RELATIVE, TARGETED_SPEC_SHA256,
  TARGETED_REFERENCE_RECEIPT_RELATIVE, TARGETED_OUTPUT_RELATIVE, TARGETED_BUDGET_RELATIVE,
  TARGETED_VARIANT, TARGETED_EXPECTED_ORDER, TARGETED_CONFIG,
  loadBroaderV2H2H3Spec, broaderV2H2H3Preflight, validateBroaderV2H2H3Budget,
  runBroaderV2H2H3Calibration, packageBroaderV2BlindCase,
  BROADER_V2_PROTOCOL_ID, BROADER_V2_ROOT_RELATIVE, BROADER_V2_MODE, BROADER_V2_CLI_MODE,
  BROADER_V2_VARIANT, BROADER_V2_OUTPUT_RELATIVE, BROADER_V2_BUDGET_RELATIVE,
  BROADER_V2_CONTROL, BROADER_V2_CASES, BROADER_V2_EXPECTED_ORDER
};
