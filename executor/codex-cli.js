'use strict';

// Node-only Codex CLI adapter。
// 共享 api-provider.js 不触碰 child_process；本模块只在 Node 宿主通过 runner seam 使用。
const childProcess = require('child_process');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 7200000;
const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_DIAGNOSTIC_BYTES = 8192;
const WORKER_HEADER = [
  '[Codex worker contract]',
  'You are a downstream text-completion worker.',
  'Use read-only reasoning only. Do not invoke skills, tools, shell commands, file writes, project scripts, or nested pipelines.',
  'Complete only the upstream request below. Return only the final content requested by that request.'
].join('\n');

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function workerPrompt(prompt) {
  return WORKER_HEADER + '\n[BEGIN UPSTREAM REQUEST]\n' + String(prompt == null ? '' : prompt) +
    '\n[END UPSTREAM REQUEST]';
}

function rejectShellMeta(name, value) {
  const text = String(value);
  if (/[\u0000\r\n&|<>^%!]/.test(text)) {
    throw new Error('[executor] codex-cli ' + name + ' 含不允许的命令行字符');
  }
}

// 用于传给 cmd.exe /c 的参数引用；prompt 不经过此函数，而是走 stdin。
function quoteWindowsArg(value) {
  const text = String(value);
  if (!text) return '""';
  if (/^[A-Za-z0-9_./\\:-]+$/.test(text)) return text;
  return '"' + text
    .replace(/(\\*)"/g, '$1$1\\"')
    .replace(/(\\+)$/g, '$1$1') + '"';
}

function normalizeConfig(config) {
  config = config || {};
  const sandbox = config.sandbox || 'read-only';
  if (sandbox !== 'read-only') {
    throw new Error('[executor] codex-cli 只允许 read-only sandbox');
  }
  if (config.ephemeral === false || config.skipGitRepoCheck === false) {
    throw new Error('[executor] codex-cli 必须启用 ephemeral 与 skipGitRepoCheck');
  }
  const codexPath = config.codexPath || (process.platform === 'win32' ? 'codex.cmd' : 'codex');
  if (typeof codexPath !== 'string' || !codexPath.trim()) {
    throw new Error('[executor] codex-cli 路径不能为空');
  }
  const model = config.model == null ? '' : String(config.model);
  const cwd = config.cwd ? String(config.cwd) : undefined;
  return {
    codexPath,
    cwd,
    model,
    timeoutMs: positiveNumber(config.timeoutMs, DEFAULT_TIMEOUT_MS),
    maxOutputBytes: positiveNumber(config.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES),
    sandbox,
    ephemeral: true,
    skipGitRepoCheck: true
  };
}

function buildArgs(config) {
  const args = ['exec', '--ephemeral', '--sandbox', 'read-only', '--skip-git-repo-check', '--json'];
  if (config.model) args.push('--model', config.model);
  // '-' makes the CLI read the worker prompt from stdin rather than argv.
  args.push('-');
  return args;
}

function buildLaunch(config, dependencies) {
  const platform = (dependencies && dependencies.platform) || process.platform;
  const executable = config.codexPath;
  const args = buildArgs(config);
  if (platform !== 'win32') return { file: executable, args, platform };

  const ext = path.extname(executable).toLowerCase();
  if (ext === '.ps1' || (ext && ext !== '.cmd' && ext !== '.bat' && ext !== '.exe')) {
    throw new Error('[executor] codex-cli 不支持该 CLI 路径类型');
  }
  if (ext === '.exe') return { file: executable, args, platform };

  rejectShellMeta('codexPath', executable);
  if (config.model) rejectShellMeta('model', config.model);
  const command = [executable].concat(args).map(quoteWindowsArg).join(' ');
  return {
    file: (dependencies && dependencies.comSpec) || process.env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', command],
    platform
  };
}

function redactDiagnostics(value) {
  let text = String(value == null ? '' : value);
  text = text.replace(/Bearer\s+[^\s"'`]+/gi, 'Bearer <REDACTED>');
  text = text.replace(/sk-[A-Za-z0-9_-]+/g, '<REDACTED>');
  text = text.replace(/(?:[A-Za-z]:[\\/]|~[\\/]|\/)[^\r\n]*auth\.json\b/gi, '<REDACTED_PATH>');
  text = text.replace(/\bauth\.json\b/gi, '<REDACTED_PATH>');
  text = text.replace(/(authorization|api[-_ ]?key|token|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=<REDACTED>');
  return text.slice(0, MAX_DIAGNOSTIC_BYTES);
}

function diagnosticSuffix(stderr) {
  const text = redactDiagnostics(stderr);
  return text ? ' · 诊断=' + text : '';
}

function parseJsonLines(stdout) {
  const events = [];
  const lines = String(stdout).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      events.push(JSON.parse(line));
    } catch (e) {
      throw new Error('[executor] codex-cli stdout JSONL 第 ' + (i + 1) + ' 行无效');
    }
  }
  return events;
}

function killChild(child, platform, dependencies) {
  if (!child) return;
  if (dependencies && typeof dependencies.kill === 'function') {
    try { dependencies.kill(child, platform); } catch (e) { /* 终止失败由原始超时/超限错误报告 */ }
    return;
  }
  try {
    if (typeof child.kill === 'function') child.kill('SIGTERM');
  } catch (e) { /* 终止失败由原始错误报告 */ }
  // cmd.exe 是 .cmd wrapper；/T 确保 wrapper 启动的 Codex 子树一并结束。
  if (platform === 'win32' && child.pid) {
    try {
      childProcess.execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
    } catch (e) { /* 不让清理辅助进程覆盖原始错误 */ }
  }
}

async function runCompletion(config, prompt, dependencies) {
  dependencies = dependencies || {};
  const normalized = normalizeConfig(config);
  const launch = buildLaunch(normalized, dependencies);
  const body = workerPrompt(prompt);
  const spawn = dependencies.spawn || childProcess.spawn;

  return new Promise((resolve, reject) => {
    let child;
    let settled = false;
    let timer = null;
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;

    const clear = () => { if (timer) clearTimeout(timer); timer = null; };
    const fail = error => {
      if (settled) return;
      settled = true;
      clear();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const succeed = value => {
      if (settled) return;
      settled = true;
      clear();
      resolve(value);
    };
    const failWith = message => fail(new Error('[executor] codex-cli ' + message + diagnosticSuffix(stderr)));
    const onStdout = chunk => {
      if (settled) return;
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      stdoutBytes += Buffer.byteLength(text, 'utf8');
      if (stdoutBytes > normalized.maxOutputBytes) {
        killChild(child, launch.platform, dependencies);
        failWith('stdout 输出超限（已停止且未落盘）');
        return;
      }
      stdout += text;
    };
    const onStderr = chunk => {
      if (settled) return;
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      if (Buffer.byteLength(stderr, 'utf8') < MAX_DIAGNOSTIC_BYTES) stderr += text;
    };

    try {
      child = spawn(launch.file, launch.args, {
        cwd: normalized.cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      });
    } catch (e) {
      fail(new Error('[executor] codex-cli 启动失败: ' + redactDiagnostics(e && (e.code || e.message) || 'unknown')));
      return;
    }
    if (!child || !child.stdin || !child.stdout || !child.stderr || typeof child.on !== 'function') {
      fail(new Error('[executor] codex-cli 启动失败: 子进程接口不完整'));
      return;
    }

    child.stdout.on('data', onStdout);
    child.stderr.on('data', onStderr);
    child.on('error', e => {
      fail(new Error('[executor] codex-cli 子进程错误: ' + redactDiagnostics(e && (e.code || e.message) || 'unknown') + diagnosticSuffix(stderr)));
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      if (code !== 0) {
        failWith('退出码 ' + String(code) + (signal ? '（signal=' + String(signal) + '）' : '') + '，已停止且未落盘');
        return;
      }
      let events;
      try {
        events = parseJsonLines(stdout);
      } catch (e) {
        failWith(e.message.replace(/^\[executor\]\s*/, ''));
        return;
      }
      const messages = events.filter(e => e && e.type === 'item.completed' && e.item &&
        e.item.type === 'agent_message' && typeof e.item.text === 'string' && e.item.text.trim());
      if (!messages.length) {
        failWith('缺少最终 agent_message，已停止且未落盘');
        return;
      }
      succeed(messages[messages.length - 1].item.text);
    });

    timer = setTimeout(() => {
      if (settled) return;
      killChild(child, launch.platform, dependencies);
      failWith('请求超时（已终止子进程且未落盘）');
    }, normalized.timeoutMs);

    try {
      child.stdin.write(body, 'utf8');
      child.stdin.end();
    } catch (e) {
      killChild(child, launch.platform, dependencies);
      fail(new Error('[executor] codex-cli stdin 写入失败: ' + redactDiagnostics(e && (e.code || e.message) || 'unknown')));
    }
  });
}

module.exports = { runCompletion };
