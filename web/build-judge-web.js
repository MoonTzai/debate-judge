// ============================================================
// build-judge-web.js — Judge 网页版单文件构建器（W1）
// 输入（只读）：根目录 install-skill.js 的 BLOCKS 单一事实源派生浏览器 runtime 闭包；
//   Skill-Judge.md 作为唯一规则种子固定内嵌。
// 输入（只读）：web/src/{engine,tendency,history-governance,flight-recorder,flight-export,ui}.js、web/src/app.css
// 输出：web/judge.html（单文件交付）+ 可选 web/dist/judge-bundle.js（Node 测试用）
// Judge 根内核只读：本脚本不修改主版本。
// ============================================================
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const CORE = ROOT;
const WEB = __dirname;
const { BLOCKS } = require(path.join(CORE, 'install-skill.js')); 

// ------------------------------------------------------------
// 1) 浏览器 runtime 闭包：唯一资产源 = install-skill.js BLOCKS
// ------------------------------------------------------------
// 排除项只包含浏览器运行时不应承担的离线/安装职责；新增 BLOCK 默认进入 web，
// 由 web-contract 的 in-memory load smoke 判断是否真的属于 runtime，而不是手工维护第五份清单。
const WEB_RUNTIME_EXCLUDE = new Set(['EXECUTOR_BROWSER', 'INSTALLER', 'KEY_EXTRACT']);
const RUNTIME_BLOCKS = BLOCKS.filter(b => !WEB_RUNTIME_EXCLUDE.has(b.name));
const blockEntry = b => [
  '/' + b.file,
  path.join(CORE, ...b.file.split('/'))
];

const MODULES = RUNTIME_BLOCKS
  .filter(b => b.lang === 'javascript')
  .map(blockEntry)
  .concat([
    ['/web/engine.js', path.join(WEB, 'src', 'engine.js')],
    ['/web/tendency.js', path.join(WEB, 'src', 'tendency.js')],
    ['/web/judge-context.js', path.join(WEB, 'src', 'judge-context.js')],
    ['/web/history-governance.js', path.join(WEB, 'src', 'history-governance.js')],
    ['/web/flight-recorder.js', path.join(WEB, 'src', 'flight-recorder.js')],
    ['/web/flight-export.js', path.join(WEB, 'src', 'flight-export.js')],
    ['/web/judge-host-io.js', path.join(WEB, 'src', 'judge-host-io.js')],
    ['/web/report-host.js', path.join(WEB, 'src', 'report-host.js')],
    ['/web/ui.js', path.join(WEB, 'src', 'ui.js')]
  ]);

// ------------------------------------------------------------
// 2) 静态种子文件（BLOCKS 非 JS + canonical Skill；内嵌到虚拟 FS）
// ------------------------------------------------------------
const STATIC_FILES = [
  ['/Skill-Judge.md', path.join(CORE, 'Skill-Judge.md')]
].concat(RUNTIME_BLOCKS.filter(b => b.lang !== 'javascript').map(blockEntry));

// ------------------------------------------------------------
// 3) 浏览器运行时前奏（shims + 虚拟 FS + 模块装载器）
// ------------------------------------------------------------
const RUNTIME_PRELUDE = `(function () {
'use strict';

/* ---------- TextEncoder 兜底 / 字节长度 ---------- */
var TextEncoderImpl = (typeof TextEncoder !== 'undefined') ? TextEncoder : null;
function byteLen(s) {
  s = String(s);
  if (TextEncoderImpl) return new TextEncoderImpl().encode(s).length;
  return s.length;
}

/* ---------- console 采集环（UI 日志用；保留原生行为） ---------- */
var CONSOLE_RING = [];
var MAX_RING = 2000;
function pushRing(level, args) {
  try {
    var text = Array.prototype.map.call(args, function (a) {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack || (a.name + ': ' + a.message);
      try { return JSON.stringify(a); } catch (e) { return String(a); }
    }).join(' ');
    CONSOLE_RING.push({ t: Date.now(), level: level, text: text });
    if (CONSOLE_RING.length > MAX_RING) CONSOLE_RING.shift();
  } catch (e) {}
}
var NATIVE_CONSOLE = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };
['log', 'warn', 'error'].forEach(function (lv) {
  console[lv] = function () {
    pushRing(lv, Array.prototype.slice.call(arguments));
    NATIVE_CONSOLE[lv].apply(null, arguments);
  };
});

/* ---------- sha256（crypto shim；名册哈希/白话缓存哈希） ---------- */
var SHA256_K = [
  0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
  0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
  0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
  0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
  0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
  0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
  0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
  0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
];
function sha256Hex(str) {
  var msg = unescape(encodeURIComponent(String(str)));
  var len = msg.length;
  var bitLen = len * 8;
  var padding = len % 64 < 56 ? 56 - (len % 64) : 120 - (len % 64);
  var bytes = [];
  for (var i = 0; i < len; i++) bytes.push(msg.charCodeAt(i) & 0xff);
  bytes.push(0x80);
  for (var j = 0; j < padding - 1; j++) bytes.push(0);
  for (var b = 7; b >= 0; b--) bytes.push((Math.floor(bitLen / Math.pow(2, 8 * b)) & 0xff));
  var words = [];
  for (var w = 0; w < bytes.length; w += 4) {
    words.push((bytes[w] << 24) | (bytes[w + 1] << 16) | (bytes[w + 2] << 8) | bytes[w + 3]);
  }
  var h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a,
      h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
  var rr = function (x, n) { return (x >>> n) | (x << (32 - n)); };
  for (var blk = 0; blk < words.length; blk += 16) {
    var w16 = words.slice(blk, blk + 16);
    for (var t = 16; t < 64; t++) {
      var s0 = rr(w16[t - 15], 7) ^ rr(w16[t - 15], 18) ^ (w16[t - 15] >>> 3);
      var s1 = rr(w16[t - 2], 17) ^ rr(w16[t - 2], 19) ^ (w16[t - 2] >>> 10);
      w16[t] = (w16[t - 16] + s0 + w16[t - 7] + s1) | 0;
    }
    var a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, h = h7;
    for (var u = 0; u < 64; u++) {
      var S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
      var ch = (e & f) ^ (~e & g);
      var temp1 = (h + S1 + ch + SHA256_K[u] + w16[u]) | 0;
      var S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
      var maj = (a & b) ^ (a & c) ^ (b & c);
      var temp2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + temp1) | 0;
      d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }
    h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + h) | 0;
  }
  var hex = function (x) { return ('00000000' + (x >>> 0).toString(16)).slice(-8); };
  return hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4) + hex(h5) + hex(h6) + hex(h7);
}

/* ---------- POSIX 路径工具（虚拟 FS 统一 '/'） ---------- */
function posixNorm(p) {
  var s = String(p).replace(/\\\\/g, '/');
  var isAbs = s.charAt(0) === '/';
  var parts = [];
  s.split('/').forEach(function (seg) {
    if (seg === '' || seg === '.') return;
    if (seg === '..') { if (parts.length && parts[parts.length - 1] !== '..') parts.pop(); else if (!isAbs) parts.push('..'); return; }
    parts.push(seg);
  });
  var out = parts.join('/');
  if (isAbs) out = '/' + out;
  return out === '' ? (isAbs ? '/' : '.') : out;
}
function posixJoin() {
  var parts = [];
  for (var i = 0; i < arguments.length; i++) {
    var a = arguments[i];
    if (a == null) continue;
    var s = String(a);
    if (s === '') continue;
    parts.push(s);
  }
  return posixNorm(parts.join('/'));
}
function posixDirname(p) {
  var n = posixNorm(p);
  var idx = n.lastIndexOf('/');
  if (idx < 0) return '.';
  if (idx === 0) return '/';
  return n.slice(0, idx);
}
function posixBasename(p, ext) {
  var n = posixNorm(p);
  var idx = n.lastIndexOf('/');
  var base = idx >= 0 ? n.slice(idx + 1) : n;
  if (ext && base.slice(-ext.length) === ext) base = base.slice(0, -ext.length);
  return base;
}
function posixExtname(p) {
  var base = posixBasename(p);
  var idx = base.lastIndexOf('.');
  return idx > 0 ? base.slice(idx) : '';
}
function posixResolve() {
  var base = posixNorm(processShim.cwd());
  for (var i = 0; i < arguments.length; i++) {
    var a = String(arguments[i]);
    base = a.charAt(0) === '/' ? posixNorm(a) : posixNorm(base + '/' + a);
  }
  return base;
}
function posixRelative(from, to) {
  var f = posixNorm(from).split('/').filter(Boolean);
  var t = posixNorm(to).split('/').filter(Boolean);
  var i = 0;
  while (i < f.length && i < t.length && f[i] === t[i]) i++;
  var up = [];
  for (var j = i; j < f.length; j++) up.push('..');
  return up.concat(t.slice(i)).join('/') || '.';
}

/* ---------- POSIX path 模块（require('path') 返回此对象） ---------- */
var PATH_SHIM = {
  sep: '/',
  join: posixJoin,
  dirname: posixDirname,
  basename: posixBasename,
  extname: posixExtname,
  resolve: posixResolve,
  relative: posixRelative,
  normalize: posixNorm
};

/* ---------- 虚拟文件系统（Map<路径,字符串>；目录由前缀推导+dirs 集合） ---------- */
function createVfs() {
  var files = new Map();
  var dirs = new Set();
  function ensureDir(p) {
    var n = posixNorm(p);
    var segs = n.split('/').filter(Boolean);
    var acc = '';
    dirs.add('/');
    for (var i = 0; i < segs.length; i++) { acc += '/' + segs[i]; dirs.add(acc); }
  }
  function errNoEnt(p) { var e = new Error('ENOENT: no such file or directory: ' + p); e.code = 'ENOENT'; return e; }
  var vfs = {
    seed: function (obj) {
      for (var k in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
        ensureDir(posixDirname(k));
        files.set(posixNorm(k), String(obj[k]));
      }
    },
    readFileSync: function (p) {
      var n = posixNorm(p);
      if (!files.has(n)) throw errNoEnt(p);
      return files.get(n);
    },
    writeFileSync: function (p, data) {
      var n = posixNorm(p);
      ensureDir(posixDirname(n));
      files.set(n, String(data));
    },
    existsSync: function (p) {
      var n = posixNorm(p);
      return files.has(n) || dirs.has(n);
    },
    mkdirSync: function (p) { ensureDir(posixNorm(p)); },
    readdirSync: function (p, opts) {
      var n = posixNorm(p);
      if (!dirs.has(n)) throw errNoEnt(p);
      var prefix = n === '/' ? '/' : n + '/';
      var names = new Set();
      files.forEach(function (_, k) {
        if (k.slice(0, prefix.length) === prefix) {
          var rest = k.slice(prefix.length);
          var idx = rest.indexOf('/');
          names.add(idx >= 0 ? rest.slice(0, idx) : rest);
        }
      });
      dirs.forEach(function (d) {
        if (d !== n && d.slice(0, prefix.length) === prefix) {
          var rest = d.slice(prefix.length);
          var idx = rest.indexOf('/');
          names.add(idx >= 0 ? rest.slice(0, idx) : rest);
        }
      });
      var list = Array.from(names);
      if (opts && opts.withFileTypes) {
        return list.map(function (name) {
          var full = prefix + name;
          return {
            name: name,
            isDirectory: function () { return dirs.has(full); },
            isFile: function () { return files.has(full); }
          };
        });
      }
      return list;
    },
    statSync: function (p) {
      var n = posixNorm(p);
      if (files.has(n)) {
        var sz = byteLen(files.get(n));
        return { size: sz, isDirectory: function () { return false; }, isFile: function () { return true; } };
      }
      if (dirs.has(n)) return { size: 0, isDirectory: function () { return true; }, isFile: function () { return false; } };
      throw errNoEnt(p);
    },
    copyFileSync: function (a, b) { vfs.writeFileSync(b, vfs.readFileSync(a)); },
    unlinkSync: function (p) { files.delete(posixNorm(p)); },
    renameSync: function (a, b) { vfs.writeFileSync(b, vfs.readFileSync(a)); vfs.unlinkSync(a); },
    rmSync: function (p, opts) {
      var n = posixNorm(p), force = !!(opts && opts.force), recursive = !!(opts && opts.recursive);
      if (files.has(n)) { files.delete(n); return; }
      var prefix = n === '/' ? '/' : n + '/';
      var childFiles = [], childDirs = [];
      files.forEach(function (_, k) { if (k.slice(0, prefix.length) === prefix) childFiles.push(k); });
      dirs.forEach(function (d) { if (d !== n && d.slice(0, prefix.length) === prefix) childDirs.push(d); });
      if (dirs.has(n) || childFiles.length || childDirs.length) {
        if (!recursive && (childFiles.length || childDirs.length)) throw new Error('ENOTEMPTY: directory not empty, rm ' + p);
        childFiles.forEach(function (k) { files.delete(k); });
        childDirs.sort(function (a, b) { return b.length - a.length; }).forEach(function (d) { dirs.delete(d); });
        dirs.delete(n);
        return;
      }
      if (!force) throw errNoEnt(p);
    },
    rmdirSync: function (p, opts) { return vfs.rmSync(p, { recursive: !!(opts && opts.recursive), force: false }); },
    /* —— 引擎扩展（会话持久化/恢复） —— */
    snapshot: function (prefix) {
      var out = {};
      files.forEach(function (v, k) {
        if (!prefix || k.slice(0, prefix.length) === prefix) out[k] = v;
      });
      return out;
    },
    restore: function (obj) {
      for (var k in obj) {
        if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
        ensureDir(posixDirname(k));
        files.set(posixNorm(k), String(obj[k]));
      }
    },
    removeTree: function (prefix) {
      var n = posixNorm(prefix);
      var victim = [];
      files.forEach(function (_, k) { if (k.slice(0, n.length) === n) victim.push(k); });
      victim.forEach(function (k) { files.delete(k); });
    },
    __files: files,
    __dirs: dirs
  };
  return vfs;
}

/* ---------- 内建 shims ---------- */
var cryptoShim = {  createHash: function (algo) {
    if (algo !== 'sha256') throw new Error('[judge-web] 浏览器仅支持 sha256（' + algo + ' 为 CLI 基线工具专用）');
    return {
      _data: '',
      update: function (d) { this._data += String(d); return this; },
      digest: function () { return sha256Hex(this._data); }
    };
  }
};

var processShim = {
  env: {},
  argv: ['browser'],
  platform: 'linux',
  execPath: 'browser',
  cwd: function () { return '/'; },
  stdin: { isTTY: false },
  exit: function (code) {
    var e = new Error('process.exit(' + code + ')');
    e.processExitCode = code;
    e.isProcessExit = true;
    throw e;
  }
};
var process = processShim;

var Buffer = { byteLength: function (s) { return byteLen(String(s)); } };

var vmShim = { Script: function (src) { this._src = src; } };
vmShim.Script.prototype.runInThisContext = function () { return (0, eval)(this._src); };
vmShim.Script.prototype.runInNewContext = function (ctx) {
  var fn = new Function('with(this){ return (function(){ return eval(' + JSON.stringify(this._src) + '); }).call(this); }');
  return fn.call(ctx || {});
};

var childProcessShim = { execFileSync: function () { throw new Error('[judge-web] child_process 不可用（self-check 为开发资产）'); } };
var readlineShim = { createInterface: function () { throw new Error('[judge-web] readline 不可用（交互由网页 UI 接管）'); } };
var osShim = { tmpdir: function () { return '/tmp'; }, homedir: function () { return '/home'; } };

/* ---------- 虚拟 FS 与种子 ---------- */
var VFS = createVfs();
VFS.seed(SEED_FILES);

/* ---------- 内建模块表（require('fs') 等 → shim；须在 VFS 创建后） ---------- */
var BUILTINS = {
  fs: VFS,
  path: PATH_SHIM,
  crypto: cryptoShim,
  process: processShim,
  vm: vmShim,
  child_process: childProcessShim,
  readline: readlineShim,
  os: osShim
};

/* ---------- 模块注册表 ---------- */
var MODULE_FACTORIES = {};
var MODULE_PATH_MAP = {};
var LOADED_MODULES = {};
var CIRCULAR_GUARD = {};

function loadModule(id) {
  // 支持两种键：打包 id（如 _web_engine_js）与虚拟路径（如 /web/engine.js）
  if (!MODULE_FACTORIES[id] && MODULE_PATH_MAP[id]) id = MODULE_PATH_MAP[id];
  if (!MODULE_FACTORIES[id] && MODULE_PATH_MAP[posixNorm(id)]) id = MODULE_PATH_MAP[posixNorm(id)];
  if (LOADED_MODULES[id]) return LOADED_MODULES[id].exports;
  var reg = MODULE_FACTORIES[id];
  if (!reg) throw new Error('[judge-web] 未打包模块: ' + id);
  if (CIRCULAR_GUARD[id]) return LOADED_MODULES[id].exports;
  CIRCULAR_GUARD[id] = true;
  var rec = { exports: {}, file: reg.file };
  LOADED_MODULES[id] = rec;
  var requireFrom = function (fromFile, spec) {
    if (Object.prototype.hasOwnProperty.call(BUILTINS, spec)) return BUILTINS[spec];
    var resolved;
    if (spec.charAt(0) === '/' || spec.charAt(0) === '.') {
      resolved = posixNorm(spec.charAt(0) === '/' ? spec : posixJoin(posixDirname(fromFile), spec));
    } else {
      // 相对无后缀 spec（如 '../pipeline-controller.js' 已带后缀；兼容无后缀）
      resolved = posixNorm(spec.charAt(0) === '/' ? spec : posixJoin(posixDirname(fromFile), spec));
    }
    var target = MODULE_PATH_MAP[resolved];
    if (target === undefined) {
      // 允许带 .js 后缀映射差异
      target = MODULE_PATH_MAP[resolved + '.js'];
    }
    if (target === undefined && /\.json$/i.test(resolved) && VFS.existsSync(resolved)) {
      // W-T13：Node require(JSON) 浏览器等价层。JSON 属 STATIC_FILES/VFS，不注册为 JS 模块工厂；
      // reader-guide.js → reader-guide.schema.json 是当前真实转移依赖。
      return JSON.parse(VFS.readFileSync(resolved, 'utf-8'));
    }
    if (target === undefined) {
      throw new Error('[judge-web] 模块未打包: ' + spec + ' (from ' + fromFile + ', resolved ' + resolved + ')');
    }
    return loadModule(target);
  };
  reg.fn(rec, rec.exports, function (spec) { return requireFrom(reg.file, spec); }, posixDirname(reg.file), reg.file);
  delete CIRCULAR_GUARD[id];
  return rec.exports;
}

/* ---------- 对外 API ---------- */
var BUNDLE = {
  vfs: VFS,
  processShim: processShim,
  cryptoShim: cryptoShim,
  sha256Hex: sha256Hex,
  logs: CONSOLE_RING,
  byteLen: byteLen,
  loadModule: loadModule,
  modules: {
    pipelineController: function () { return loadModule('/pipeline-controller.js'); },
    renderReport: function () { return loadModule('/render-report.js'); },
    hostNode: function () { return loadModule('/executor/host-node.js'); },
    apiProvider: function () { return loadModule('/executor/api-provider.js'); },
    core: function () { return loadModule('/executor/core.js'); },
    tendency: function () { return loadModule('/web/tendency.js'); },
    judgeContext: function () { return loadModule('/web/judge-context.js'); },
    engine: function () { return loadModule('/web/engine.js'); },
    historyGovernance: function () { return loadModule('/web/history-governance.js'); },
    flightRecorder: function () { return loadModule('/web/flight-recorder.js'); },
    flightExport: function () { return loadModule('/web/flight-export.js'); },
    judgeHostIO: function () { return loadModule('/web/judge-host-io.js'); },
    reportHost: function () { return loadModule('/web/report-host.js'); },
    ui: function () { return loadModule('/web/ui.js'); }
  }
};
var GLOBAL_ROOT = (typeof window !== 'undefined') ? window : globalThis;
GLOBAL_ROOT.JUDGE_BUNDLE = BUNDLE;
GLOBAL_ROOT.JUDGE_WEB_GLOBALS = {
  __shims: { vfs: VFS, processShim: processShim, cryptoShim: cryptoShim }
};
// tendency 惰性挂载（模块工厂在 prelude 之后注册，不能在此处立即 require）
Object.defineProperty(GLOBAL_ROOT.JUDGE_WEB_GLOBALS, 'tendency', {
  configurable: true,
  get: function () { return BUNDLE.modules.tendency(); }
});
`;

// ------------------------------------------------------------
// 4) 打包源补丁（仅作用于 web bundle；根目录 Judge 主版本零改动）
//    补丁 P1：api-provider openai-compatible 分支支持 cfg.extraBody 合并进请求体
//    （思考模式 thinking/reasoning_effort 等前端附加参数通道）
//    锚点必须精确匹配；根目录 Judge 主版本漂移 → 构建失败（防静默失配）。
// ------------------------------------------------------------
const API_PROVIDER_PATCH = {
  anchor:
`      return await requestCompletionStream(cfg.baseUrl, cfg.apiKey, {
        model: cfg.model,
        messages: [{ role: 'system', content: system }].concat(msgs),
        temperature: cfg.temperature !== undefined ? cfg.temperature : 0.3,
        max_tokens: cfg.maxTokens || DEFAULT_MAX_TOKENS   // 批 5（260812 P0-3）：补发 max_tokens（此前配置死旋钮）
      }, { timeoutMs: cfg.timeoutMs, signal: opts.signal });`,
  replacement:
`      var extraBody = (typeof cfg.extraBody === 'object' && cfg.extraBody && !Array.isArray(cfg.extraBody)) ? cfg.extraBody : {};
      // [judge-web P1] 厂商请求形状仅在 Web adapter 层转换；根 Judge/api-provider 不感知供应商 preset。
      var requestBody = Object.assign({
        model: cfg.model,
        messages: [{ role: 'system', content: system }].concat(msgs)
      }, extraBody);
      if (!cfg.omitTemperature) requestBody.temperature = cfg.temperature !== undefined ? cfg.temperature : 0.3;
      if (!cfg.omitMaxTokens) requestBody.max_tokens = cfg.maxTokens || DEFAULT_MAX_TOKENS;
      return await requestCompletionStream(cfg.baseUrl, cfg.apiKey, requestBody, { timeoutMs: cfg.timeoutMs, signal: opts.signal });`
};

// Web Flight Recorder：仅浏览器 bundle 生效的观测 sidecar；observer 返回值永不进入请求路径。
const API_PROVIDER_FR0 = {
  anchor:
`const SSE_BUFFER_LIMIT = 16 * 1024 * 1024;
async function requestCompletionStream(baseUrl, apiKey, body, opts) {
  opts = opts || {};
  const attempt = async (signal) => {
    const res = await fetch(baseUrl.replace(/\\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify(Object.assign({ stream: true }, body)),
      signal
    });
    if (!res.ok) throw new Error('[executor] API ' + res.status + ' ' + (await res.text()).slice(0, 300));`,
  replacement:
`const SSE_BUFFER_LIMIT = 16 * 1024 * 1024;
let WEB_FLIGHT_ATTEMPT_SEQ = 0;
function webFlightCall(method) {
  try {
    const root = (typeof window !== 'undefined') ? window : globalThis;
    const obs = root && root.JUDGE_WEB_FLIGHT_OBSERVER;
    if (!obs || typeof obs[method] !== 'function') return;
    obs[method].apply(obs, Array.prototype.slice.call(arguments, 1));
  } catch (e) {}
}
async function requestCompletionStream(baseUrl, apiKey, body, opts) {
  opts = opts || {};
  const attempt = async (signal) => {
    const endpoint = baseUrl.replace(/\\/+$/, '') + '/chat/completions';
    const requestBodyText = JSON.stringify(Object.assign({ stream: true }, body));
    const attemptToken = 'wfr-a-' + Date.now().toString(36) + '-' + (++WEB_FLIGHT_ATTEMPT_SEQ).toString(36);
    webFlightCall('beginAttempt', attemptToken, { endpoint: endpoint, model: body && body.model ? body.model : '' }, requestBodyText);
    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
        body: requestBodyText,
        signal
      });
    } catch (e) {
      webFlightCall('failAttempt', attemptToken, { status: 'error', done: false, error: e && e.message ? e.message : String(e) });
      throw e;
    }
    if (!res.ok) {
      let errorBodyText = '';
      try { errorBodyText = await res.text(); }
      catch (e) {
        webFlightCall('failAttempt', attemptToken, { httpStatus: res.status, status: 'error', done: false, error: e && e.message ? e.message : String(e) });
        throw e;
      }
      webFlightCall('httpErrorBody', attemptToken, res.status, errorBodyText);
      webFlightCall('failAttempt', attemptToken, { httpStatus: res.status, status: 'error', done: false, error: '[executor] API ' + res.status });
      throw new Error('[executor] API ' + res.status + ' ' + errorBodyText.slice(0, 300));
    }`
};

const API_PROVIDER_P2A = {
  anchor:
`    let buffer = '';
    let text = '';
    let finishReason = null;
    let streamEnded = false;
    const consumeFrames = (b, final) => {`,
  replacement:
`    let buffer = '';
    let text = '';
    let finishReason = null;
    let streamEnded = false;
    let lastUsage = null;
    // [judge-web P2] 进度遥测（仅观测，不改输出语义）：content/思考字数 + 帧数 + 耗时，节流回调
    const progressT0 = Date.now();
    let reasonChars = 0;
    let progressFrames = 0;
    let lastProgressAt = 0;
    const fireProgress = (final) => {
      const now = Date.now();
      if (!final && now - lastProgressAt < 200) return;
      lastProgressAt = now;
      if (typeof opts.onProgress === 'function') {
        try { opts.onProgress({ chars: text.length, reasonChars: reasonChars, frames: progressFrames, elapsedMs: now - progressT0, final: !!final }); } catch (e) {}
      }
    };
    const consumeFrames = (b, final) => {`
};

const API_PROVIDER_P2B = {
  anchor:
`      if (typeof delta.content === 'string' && !streamEnded) text += delta.content;   // reasoning_content 交错出现时忽略（只取 content）
      if (choice.finish_reason) finishReason = choice.finish_reason;`,
  replacement:
`      if (typeof delta.content === 'string' && !streamEnded) text += delta.content;   // reasoning_content 交错出现时忽略（只取 content）
      // [judge-web P2] 思考字数仅观测计数（不并入输出，保持内核「只取 content」语义）
      if (typeof delta.reasoning_content === 'string') reasonChars += delta.reasoning_content.length;
      progressFrames++;
      fireProgress(false);
      if (choice.finish_reason) finishReason = choice.finish_reason;`
};

const API_PROVIDER_FR_USAGE = {
  anchor:
`      const choice = j.choices && j.choices[0];
      if (!choice) return;                                     // [DONE] 后元帧（choices:[]）安全跳过`,
  replacement:
`      if (j.usage) lastUsage = j.usage;                       // [judge-web Flight Recorder] 只读 usage 摘要
      const choice = j.choices && j.choices[0];
      if (!choice) return;                                     // [DONE] 后元帧（choices:[]）安全跳过`
};

const API_PROVIDER_P2C = {
  anchor:
`    if (!text) {
      const err = new Error('[executor] 流式响应无内容（choices 空或全程无 delta.content）');
      err.code = 'EMPTY_COMPLETION';
      throw err;
    }
    return text;`,
  replacement:
`    if (!text) {
      const err = new Error('[executor] 流式响应无内容（choices 空或全程无 delta.content）');
      err.code = 'EMPTY_COMPLETION';
      throw err;
    }
    fireProgress(true);
    return text;`
};

const API_PROVIDER_FR_BODY = {
  anchor:
`    if (!res.body || typeof res.body.getReader !== 'function')
      throw new Error('[executor] 流式响应无 body（ReadableStream）——端点不支持 stream 或网关异常');`,
  replacement:
`    if (!res.body || typeof res.body.getReader !== 'function') {
      webFlightCall('failAttempt', attemptToken, { httpStatus: res.status, status: 'error', done: false, error: 'missing ReadableStream body' });
      throw new Error('[executor] 流式响应无 body（ReadableStream）——端点不支持 stream 或网关异常');
    }`
};

const API_PROVIDER_FR_CHUNK = {
  anchor:
`        const { done, value } = await reader.read();
        if (done) break;                                       // ⑬ EOF 才是终止点——[DONE] 后继续读流
        buffer += decoder.decode(value, { stream: true });`,
  replacement:
`        const { done, value } = await reader.read();
        if (done) break;                                       // ⑬ EOF 才是终止点——[DONE] 后继续读流
        webFlightCall('rawChunk', attemptToken, value);         // 原始字节先旁路复制，再交 decoder/parser
        buffer += decoder.decode(value, { stream: true });`
};

const API_PROVIDER_FR_CATCH = {
  anchor:
`      buffer = consumeFrames(buffer, true);                    // ⑨ 残帧处理
    } finally {
      try { reader.releaseLock && reader.releaseLock(); } catch (e) {}
    }`,
  replacement:
`      buffer = consumeFrames(buffer, true);                    // ⑨ 残帧处理
    } catch (e) {
      webFlightCall('failAttempt', attemptToken, { httpStatus: res.status, status: 'partial', done: streamEnded,
        finishReason: finishReason, usage: lastUsage, contentChars: text.length, reasoningChars: reasonChars,
        error: e && e.message ? e.message : String(e) });
      throw e;
    } finally {
      try { reader.releaseLock && reader.releaseLock(); } catch (e) {}
    }`
};

const API_PROVIDER_FR_FINISH = {
  anchor:
`    if (finishReason === 'length')
      throw new Error('[executor] 输出达到 max_tokens 上限被截断（finish_reason=length）——已停止且未落盘。请提高 max_tokens（当前 ' + (body.max_tokens || '网关默认上限') + '）后重试，禁止使用截断产物。');
    // ③ 收紧：done 且全程无 finish_reason → 截断/异常流
    if (!finishReason)
      throw new Error('[executor] 流式响应未收到 finish_reason（流被截断或网关异常）——已停止且未落盘，禁止使用部分产物。');
    if (!text) {
      const err = new Error('[executor] 流式响应无内容（choices 空或全程无 delta.content）');
      err.code = 'EMPTY_COMPLETION';
      throw err;
    }
    fireProgress(true);
    return text;`,
  replacement:
`    const flightSummary = function (status, error) {
      return { httpStatus: res.status, status: status, done: streamEnded, finishReason: finishReason, usage: lastUsage,
        contentChars: text.length, reasoningChars: reasonChars, error: error || null };
    };
    if (finishReason === 'length') {
      webFlightCall('failAttempt', attemptToken, flightSummary('partial', 'finish_reason=length'));
      throw new Error('[executor] 输出达到 max_tokens 上限被截断（finish_reason=length）——已停止且未落盘。请提高 max_tokens（当前 ' + (body.max_tokens || body.max_completion_tokens || '网关默认上限') + '）后重试，禁止使用截断产物。');
    }
    // ③ 收紧：done 且全程无 finish_reason → 截断/异常流
    if (!finishReason) {
      webFlightCall('failAttempt', attemptToken, flightSummary('partial', 'missing finish_reason'));
      throw new Error('[executor] 流式响应未收到 finish_reason（流被截断或网关异常）——已停止且未落盘，禁止使用部分产物。');
    }
    if (!text) {
      webFlightCall('failAttempt', attemptToken, flightSummary('partial', 'no delta.content'));
      const err = new Error('[executor] 流式响应无内容（choices 空或全程无 delta.content）');
      err.code = 'EMPTY_COMPLETION';
      throw err;
    }
    fireProgress(true);
    webFlightCall('finishAttempt', attemptToken, flightSummary('complete', null));
    return text;`
};

const API_PROVIDER_P2D = {
  anchor: `requestBody, { timeoutMs: cfg.timeoutMs, signal: opts.signal });`,
  replacement: `requestBody, { timeoutMs: cfg.timeoutMs, onProgress: opts.onProgress, signal: opts.signal });`
};

// ------------------------------------------------------------
// 补丁 P3（260814 W-T10 中止缺陷修复）：外部中止信号（abortSignal）贯通
//   P3-1：requestCompletionStream.runWithTimeout 合并 opts.signal（外部 abort → 内部 ctrl.abort，fetch 中止）
//   P3-2：requestCompletion openai-compatible 分支透传 opts.signal（锚 P2D 应用后文本——P3-2 须排在 P2D 之后）
//   P3-S：runPipeline 将 web apiStub 映射到现役 requestCompletion seam，并向 runRound 透传 apiStub；
//         PLAIN-V2 / reader-guide 当前都已原生消费 requestCompletion，无需继续维持旧 P3-4/P3-5 补丁。
//   P3-7：translateUnitsLLM catch 对 AbortError 原样重抛（免重试耗尽 + aborted 识别失败）
// 锚点必须精确匹配；根目录 Judge 主版本漂移 → 构建失败（防静默失配）。
// ------------------------------------------------------------
const API_PROVIDER_P3_1 = {
  anchor:
`    const timer = ctrl ? setTimeout(() => ctrl.abort(), opts.timeoutMs != null ? opts.timeoutMs : DEFAULT_TIMEOUT_MS) : null;   // ⑪
    try { return await attempt(ctrl ? ctrl.signal : undefined); }`,
  replacement:
`    const timer = ctrl ? setTimeout(() => ctrl.abort(), opts.timeoutMs != null ? opts.timeoutMs : DEFAULT_TIMEOUT_MS) : null;   // ⑪
    // [judge-web P3] 外部中止信号合并（W-T10）：外部 abort → 内部 ctrl.abort（fetch abort；超时守卫共存）
    if (opts.signal) {
      if (opts.signal.aborted) { ctrl && ctrl.abort(); }
      else opts.signal.addEventListener('abort', function () { ctrl && ctrl.abort(); }, { once: true });
    }
    try { return await attempt(ctrl ? ctrl.signal : undefined); }`
};
const API_PROVIDER_P3_2 = {
  anchor: `requestBody, { timeoutMs: cfg.timeoutMs, onProgress: opts.onProgress });`,
  replacement: `requestBody, { timeoutMs: cfg.timeoutMs, onProgress: opts.onProgress, signal: opts.signal });`
};
const HOST_NODE_P3_SEAM = {
  anchor:
`async function runPipeline(opts) {
  const workDir = opts.workDir;`,
  replacement:
`async function runPipeline(opts) {
  // [judge-web P3] 浏览器 API seam：现役 host 已统一让 PLAIN-V2 / reader-guide 消费 requestCompletion；
  // web 仍对外保持 apiStub 接口，因此只在 bundle 内做一次适配，不改 Node/CLI 源码。
  if (opts.apiStub && !opts.requestCompletion) opts = Object.assign({}, opts, { requestCompletion: opts.apiStub });
  const workDir = opts.workDir;`
};
const HOST_NODE_P3_7 = {
  anchor:
`      } catch (e) {
        // parse 成功不等于门禁成功。R8 整卡门失败时先保留已解析候选，下一轮只修被点名字段；`,
  replacement:
`      } catch (e) {
        if (e && (e.name === 'AbortError' || /abort|已中止/i.test(String(e.message || '')))) throw e;
        // parse 成功不等于门禁成功。R8 整卡门失败时先保留已解析候选，下一轮只修被点名字段；`
};
// C1（260815）：onRound 结构化回调。260828 B1 后 runRound 调用已扩展为多行并携带 sourceAnchorExemptions/codexRunner，
// W-T13 以现役调用面重新锚定，同时补回 web apiStub；CLI 源码零改动。
const HOST_NODE_P4_1 = {
  anchor:
`    const r = await runRound({
      workDir, round, cfg, mockResponder: opts.mockResponder, onLog,
      force: opts.force, realValidate, newContract, sourceAnchorExemptions,
      codexRunner: opts.codexRunner
    });`,
  replacement:
`    const r = await runRound({
      workDir, round, cfg, mockResponder: opts.mockResponder, onLog,
      force: opts.force, realValidate, newContract, sourceAnchorExemptions,
      apiStub: opts.apiStub,
      codexRunner: opts.codexRunner
    });
    // [judge-web P4] 结构化 onRound 回调（260815 C1）：事件采集不依赖日志正则（CLI 不传 onRound → 零影响）
    if (typeof opts.onRound === 'function') { try { opts.onRound(r); } catch (e) {} }`
};
const HOST_NODE_P4_2A = {
  anchor:
`        results.push({ round: 'R6a', ok: true, mechanical: true });
        results.push({ round: 'R6b', ok: true, mechanical: true });`,
  replacement:
`        results.push({ round: 'R6a', ok: true, mechanical: true });
        results.push({ round: 'R6b', ok: true, mechanical: true });
        // [judge-web P4] 机械渲染路径结构化回调（真实路径 R6a/R6b 无 runRound，补事件；CLI 零影响）
        if (typeof opts.onRound === 'function') { try { opts.onRound({ round: 'R6a', ok: true, skipped: false, mechanical: true }); } catch (e) {} }
        if (typeof opts.onRound === 'function') { try { opts.onRound({ round: 'R6b', ok: true, skipped: false, mechanical: true }); } catch (e) {} }`
};
const HOST_NODE_P4_2B = {
  anchor:
`      } catch (e) {
        results.push({ round: 'R6a', ok: false, errors: ['机械渲染失败: ' + e.message] });
        break;
      }`,
  replacement:
`      } catch (e) {
        const r6Failure = { round: 'R6a', ok: false, errors: ['机械渲染失败: ' + e.message] };
        results.push(r6Failure);
        if (typeof opts.onRound === 'function') { try { opts.onRound({ round: 'R6a', ok: false, skipped: false, mechanical: true, errors: r6Failure.errors }); } catch (e2) {} }
        break;
      }`
};
const HOST_NODE_P4_R7_START = {
  anchor:
`      if (opts.plain) {
        onLog('[executor] R7 白话层开始');`,
  replacement:
`      if (opts.plain) {
        onLog('[executor] R7 白话层开始');
        if (typeof opts.onStage === 'function') { try { opts.onStage({ stage: 'R7', state: 'active', postprocess: true }); } catch (e) {} }`
};
const HOST_NODE_P4_R7_RESULT = {
  anchor:
`          results.push({ round: 'R7', ok: true, postprocess: true });
        } catch (e) {
          results.push({ round: 'R7', ok: false, postprocess: true, errors: ['白话层失败: ' + e.message] });
        }`,
  replacement:
`          const r7Done = { round: 'R7', ok: true, postprocess: true };
          results.push(r7Done);
          if (typeof opts.onRound === 'function') { try { opts.onRound(r7Done); } catch (e2) {} }
        } catch (e) {
          const r7Failure = { round: 'R7', ok: false, postprocess: true, errors: ['白话层失败: ' + e.message] };
          results.push(r7Failure);
          if (typeof opts.onRound === 'function') { try { opts.onRound(r7Failure); } catch (e2) {} }
        }`
};

const SOURCE_PATCHES = {
  '/executor/api-provider.js': [
    API_PROVIDER_PATCH,
    API_PROVIDER_FR0,
    API_PROVIDER_P2A,
    API_PROVIDER_FR_USAGE,
    API_PROVIDER_P2B,
    API_PROVIDER_FR_BODY,
    API_PROVIDER_FR_CHUNK,
    API_PROVIDER_FR_CATCH,
    API_PROVIDER_P2C,
    API_PROVIDER_FR_FINISH,
    API_PROVIDER_P2D
  ],
  '/executor/host-node.js': [
    HOST_NODE_P3_SEAM,
    HOST_NODE_P3_7,
    HOST_NODE_P4_1,
    HOST_NODE_P4_2A,  // C1：机械渲染路径回调（真实路径 R6a/R6b 无 runRound）
    HOST_NODE_P4_2B,
    HOST_NODE_P4_R7_START,
    HOST_NODE_P4_R7_RESULT
  ]
};

function applyPatches(vp, src) {
  const patches = SOURCE_PATCHES[vp] || [];
  let out = src;
  for (const p of patches) {
    if (out.indexOf(p.anchor) === -1) {
      throw new Error('[build-judge-web] 补丁锚点缺失（根目录 Judge 主版本已漂移，请复核补丁）: ' + vp);
    }
    out = out.replace(p.anchor, p.replacement);
  }
  return out;
}

// ------------------------------------------------------------
// 5) 组装
// ------------------------------------------------------------
function safeForHtml(src) {
  return String(src).replace(/<\/script/gi, '<\\/script');
}

const APP_CSS_PATH = path.join(WEB, 'src', 'app.css');

function inlineAppCssAssets(css) {
  return String(css);
}

function buildBundle() {
  const parts = [];
  parts.push('/* judge-web bundle v1 · reproducible build */');
  // 种子文件以 JSON 字符串嵌入；</script 需转义（JSON 中 \/ 合法且解析回 /）
  parts.push('var SEED_FILES = ' + JSON.stringify(
    Object.fromEntries(STATIC_FILES.map(([vp, fp]) => [vp, fs.readFileSync(fp, 'utf-8')]))
  ).replace(/<\/script/gi, '<\\/script') + ';');
  parts.push(RUNTIME_PRELUDE);
  parts.push('/* ---------- 模块工厂（打包源） ---------- */');
  const sourceOf = {};
  for (const [vp, fp] of MODULES) {
    const id = vp.replace(/[^A-Za-z0-9]/g, '_');
    const raw = fs.readFileSync(fp, 'utf-8');
    const src = applyPatches(vp, raw);
    sourceOf[vp] = src;
    parts.push('MODULE_FACTORIES[' + JSON.stringify(id) + '] = {');
    parts.push('  file: ' + JSON.stringify(vp) + ',');
    parts.push('  fn: function (module, exports, require, __dirname, __filename) {');
    parts.push(safeForHtml(src));
    parts.push('  }');
    parts.push('};');
    parts.push('MODULE_PATH_MAP[' + JSON.stringify(vp) + '] = ' + JSON.stringify(id) + ';');
  }
  parts.push('})();');
  parts.push('/* bundle 结束 */');
  return { js: parts.join('\n'), sourceOf };
}

function buildHtml(bundleJs, appCss, uiJs, sourceOf) {
  const summary = Object.entries(sourceOf).map(([vp, src]) => vp + ' (' + src.length + 'B)').join('\n  ');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Debate-Judge · 网页版</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>⚖️</text></svg>">
<style>
${safeForHtml(appCss)}
</style>
</head>
<body>
<div id="app-root"></div>
<script>
${safeForHtml(bundleJs)}
</script>
<script>
${safeForHtml(uiJs)}
</script>
</body>
</html>
`;
}

// ------------------------------------------------------------
// 5) 校验
// ------------------------------------------------------------
function verifyBundle(js) {
  const checks = [];
  // 语法校验（Node 直接编译）
  try {
    new Function(js);
    checks.push({ name: 'bundle 语法', ok: true });
  } catch (e) {
    checks.push({ name: 'bundle 语法', ok: false, detail: e.message });
  }
  // 模块源文件齐全
  for (const [vp, fp] of MODULES) {
    if (!fs.existsSync(fp)) checks.push({ name: '模块存在 ' + vp, ok: false });
  }
  for (const [vp, fp] of STATIC_FILES) {
    if (!fs.existsSync(fp)) checks.push({ name: '种子存在 ' + vp, ok: false });
  }
  // Wayfinder semantic-core no-patch gate：semantic core只能来自 BLOCKS 单一源码，Web 不得 anchor-patch。
  const semanticCoreIds = new Set();
  for (const b of RUNTIME_BLOCKS.filter(x => x.semantic_core === true)) {
    if (!b.module_id) checks.push({ name: 'semantic-core module_id ' + b.name, ok: false, detail: 'module_id missing' });
    else if (semanticCoreIds.has(b.module_id)) checks.push({ name: 'semantic-core module_id unique ' + b.name, ok: false, detail: b.module_id });
    else semanticCoreIds.add(b.module_id);
    const vp = '/' + b.file;
    if (SOURCE_PATCHES[vp]) checks.push({ name: 'semantic-core no-patch ' + b.name, ok: false, detail: vp + ' is SOURCE_PATCHES target' });
    else checks.push({ name: 'semantic-core no-patch ' + b.name, ok: true });
    if (!MODULES.some(([modulePath]) => modulePath === vp)) checks.push({ name: 'semantic-core bundled ' + b.name, ok: false, detail: vp });
    else checks.push({ name: 'semantic-core bundled ' + b.name, ok: true });
  }
  // 转义有效性：最终产物不得残留裸 </script>
  if (/<\/script/i.test(js)) checks.push({ name: '裸 </script 残留', ok: false });
  return checks;
}

// ------------------------------------------------------------
// 6) main
// ------------------------------------------------------------
function main() {
  const args = process.argv.slice(2);
  const emitBundle = args.includes('--emit-bundle');
  const outBundlePath = path.join(WEB, 'dist', 'judge-bundle.js');
  const outHtmlPath = path.join(WEB, 'judge.html');

  const { js, sourceOf } = buildBundle();
  const appCssSource = fs.readFileSync(APP_CSS_PATH, 'utf-8');
  const appCss = inlineAppCssAssets(appCssSource);
  const uiJs = fs.readFileSync(path.join(WEB, 'src', 'ui.js'), 'utf-8');

  const checks = verifyBundle(js);
  const failed = checks.filter(c => !c.ok);
  console.log('[build-judge-web] 校验:');
  checks.forEach(c => console.log('  ' + (c.ok ? '✓' : '✗') + ' ' + c.name + (c.detail ? ' —— ' + c.detail : '')));
  if (failed.length) {
    console.error('[build-judge-web] 构建失败：' + failed.map(f => f.name).join('; '));
    process.exit(1);
  }

  fs.mkdirSync(path.join(WEB, 'dist'), { recursive: true });
  // W-C2（260815）：dist 恒写——单测/浏览器测试均从 dist 装载，原门控致「无标志构建 → judge.html 新/dist 旧 → 测试跑旧引擎」；
  // --emit-bundle 标志保留兼容解析（恒写后为无操作，外部脚本带标志运行不受影响）
  fs.writeFileSync(outBundlePath, js, 'utf-8');
  console.log('[build-judge-web] bundle → ' + outBundlePath + ' (' + js.length + 'B)' + (emitBundle ? '' : '（恒写；--emit-bundle 已非必需）'));
  // W-C2 + UI2.0：模块、种子与 source CSS 均是一等 freshness 输入。
  const inputSnapshot = MODULES.concat(STATIC_FILES).map(([, fp]) => ({ p: fp, mtimeMs: fs.statSync(fp).mtimeMs }));
  inputSnapshot.push({ p: APP_CSS_PATH, mtimeMs: fs.statSync(APP_CSS_PATH).mtimeMs });
  fs.writeFileSync(path.join(WEB, 'dist', '.inputs.json'), JSON.stringify({ schema: 'judge-web-dist-inputs-v1', builtAt: new Date().toISOString(), files: inputSnapshot }));
  const html = buildHtml(js, appCss, uiJs, sourceOf);
  fs.writeFileSync(outHtmlPath, html, 'utf-8');
  console.log('[build-judge-web] judge.html → ' + outHtmlPath + ' (' + html.length + 'B)');
  console.log('[build-judge-web] 打包模块:');
  console.log('  ' + Object.entries(sourceOf).map(([vp, src]) => vp + ' (' + src.length + 'B)').join('\n  '));
  console.log('[build-judge-web] 完成。');
}

if (require.main === module) main();
module.exports = {
  BLOCKS,
  WEB_RUNTIME_EXCLUDE,
  RUNTIME_BLOCKS,
  MODULES,
  STATIC_FILES,
  buildBundle,
  verifyBundle
};
