'use strict';

// Web 历史记录外围治理纯模块：不访问 DOM / IndexedDB / Judge 管道。
// 只负责保留上限、淘汰候选、逻辑体量估算与 sessionFiles 归属解析。
const DEFAULT_RETENTION_LIMIT = 100;
const MAX_RETENTION_LIMIT = 100;
const MIN_RETENTION_LIMIT = 1;

function normalizeRetentionLimit(v) {
  var n = Number(v);
  if (!isFinite(n)) n = DEFAULT_RETENTION_LIMIT;
  n = Math.round(n);
  if (n < MIN_RETENTION_LIMIT) n = MIN_RETENTION_LIMIT;
  if (n > MAX_RETENTION_LIMIT) n = MAX_RETENTION_LIMIT;
  return n;
}

function selectEvictionVictims(sessions, limit, protectedIds) {
  sessions = Array.isArray(sessions) ? sessions.slice() : [];
  limit = normalizeRetentionLimit(limit);
  protectedIds = protectedIds || {};
  var need = Math.max(0, sessions.length - limit);
  if (!need) return [];
  return sessions
    .filter(function (s) {
      if (!s || !s.id) return false;
      if (s.status === 'running') return false;
      return !protectedIds[s.id];
    })
    .sort(function (a, b) {
      var ta = String(a.updatedAt || a.createdAt || '');
      var tb = String(b.updatedAt || b.createdAt || '');
      var c = ta.localeCompare(tb);
      return c || String(a.id).localeCompare(String(b.id));
    })
    .slice(0, need);
}

function estimateValueBytes(value, seen) {
  if (value == null) return 0;
  var t = typeof value;
  if (t === 'string') return value.length * 2;
  if (t === 'number') return 8;
  if (t === 'boolean') return 4;
  if (t !== 'object') return 0;
  if (value instanceof Uint8Array) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  seen = seen || [];
  if (seen.indexOf(value) >= 0) return 0;
  seen.push(value);
  var n = 0;
  if (Array.isArray(value)) {
    for (var i = 0; i < value.length; i++) n += estimateValueBytes(value[i], seen);
  } else {
    for (var k in value) {
      n += String(k).length * 2;
      n += estimateValueBytes(value[k], seen);
    }
  }
  seen.pop();
  return n;
}

function sessionIdFromFileRecordId(id) {
  var s = String(id || '');
  var m = /^(.*)#(?:BASE|FINAL|R.+)$/.exec(s);
  return m ? m[1] : null;
}

function findOrphanFileRecords(fileRows, sessions) {
  var owners = {};
  (sessions || []).forEach(function (s) { if (s && s.id) owners[s.id] = true; });
  return (fileRows || []).filter(function (r) {
    var owner = r && sessionIdFromFileRecordId(r.id);
    return !!owner && !owners[owner];
  });
}

module.exports = {
  DEFAULT_RETENTION_LIMIT: DEFAULT_RETENTION_LIMIT,
  MAX_RETENTION_LIMIT: MAX_RETENTION_LIMIT,
  MIN_RETENTION_LIMIT: MIN_RETENTION_LIMIT,
  normalizeRetentionLimit: normalizeRetentionLimit,
  selectEvictionVictims: selectEvictionVictims,
  estimateValueBytes: estimateValueBytes,
  sessionIdFromFileRecordId: sessionIdFromFileRecordId,
  findOrphanFileRecords: findOrphanFileRecords
};
