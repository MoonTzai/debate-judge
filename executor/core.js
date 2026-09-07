// A8-P3a：统一轮次执行器·纯逻辑层（无 fs/path/网络；Node 与浏览器共享）
// 职责：轮次清单 / 质量门禁（占位残留+篇幅+表行数）/ 重试退避 / 模块切片。
'use strict';

// 轮次清单（与 pipeline-controller runAll 同序；R5 拆 A/B 半区）
// parallelGroup：同组轮次可并行启动（并行调度环境预留·半完成注记）；null=等待前组全部完成
const ROUNDS = [
  { name: 'R1', num: '1', hasSpeech: true,  promptFile: '.tmp-R1-prompt.md',     outFile: 'P1.md', parallelGroup: null },
  { name: 'R2', num: '2', hasSpeech: true,  promptFile: '.tmp-R2-prompt.md',     outFile: 'P2.md', parallelGroup: 1 },
  { name: 'R2.5', num: '2.5', hasSpeech: false, promptFile: '.tmp-R2.5-prompt.md', outFile: 'P2.5.md', parallelGroup: null },
  { name: 'R3', num: '3', hasSpeech: false, promptFile: '.tmp-R3-prompt.md',     outFile: 'P3.md', parallelGroup: null },
  { name: 'R4', num: '4', hasSpeech: false, promptFile: '.tmp-R4-prompt.md',     outFile: 'structure.json', parallelGroup: 2 },
  { name: 'R4.5', num: '4.5', hasSpeech: false, promptFile: '.tmp-R4.5-prompt.md', outFile: 'adjudication.json', parallelGroup: null },
  { name: 'R5A', num: '5', hasSpeech: false, promptFile: '.tmp-R5-A-prompt.md',  outFile: '.tmp-r5-half-A.md', half: 'A', parallelGroup: 3 },
  { name: 'R5B', num: '5', hasSpeech: false, promptFile: '.tmp-R5-B-prompt.md',  outFile: '.tmp-r5-half-B.md', half: 'B', parallelGroup: 3 },
  { name: 'R6a', num: '6a', hasSpeech: false, promptFile: '.tmp-R6a-prompt.md',  outFile: '.tmp-r6a-out.html', parallelGroup: 3 },
  { name: 'R6b', num: '6b', hasSpeech: false, promptFile: '.tmp-R6b-prompt.md',  outFile: 'report.html', parallelGroup: null }
];

// R5 半区常量表（单一事实源：runAll half 分支 / generate-input-contract chapters 共用）
const R5_HALVES = {
  A: { label: 'A', range: 'C1 到 C7', exclude: 'C8-C12', chapters: ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7'] },
  B: { label: 'B', range: 'C8 到 C12', exclude: 'C1-C7', chapters: ['C8', 'C9', 'C10', 'C11', 'C12'] }
};

// 重试策略（审计补充）：单轮最多 3 次重试 + 指数退避 2s/4s/8s
const MAX_RETRIES = 3;
const BACKOFF_MS = [0, 2000, 4000, 8000];

// A8-P7：上下文上限（以 DeepSeek V4 Flash 为基准：官方 1M 上下文 = 1048576 tokens / 384K 最大输出）
// 默认 1,048,576 tokens；可用环境变量 EXECUTOR_CONTEXT_LIMIT_TOKENS 覆盖（测试/特殊模型）。
const DEFAULT_CONTEXT_LIMIT_TOKENS = 1048576;
// 保守估算：1 字符 ≈ ≤1.5 token（中文约 0.6-1 token/字，英文约 4 字符/token；1.5 为安全上界）
const TOKEN_ESTIMATE_FACTOR = 1.5;

function estimateTokens(text) {
  return Math.ceil(String(text || '').length * TOKEN_ESTIMATE_FACTOR);
}

// 上下文超限硬门禁：超过上限 → 抛错停止（禁止裁剪、禁止降级、禁止继续）
function assertWithinContextLimit(text, label, limitTokens) {
  const limit = parseInt(limitTokens, 10) > 0 ? parseInt(limitTokens, 10) : DEFAULT_CONTEXT_LIMIT_TOKENS;
  const chars = String(text || '').length;
  const est = estimateTokens(text);
  if (est > limit) {
    throw new Error(
      '[ERR_CONTEXT_OVERFLOW] ' + label + ' 估算 ' + est + ' tokens（' + chars + ' 字符）超过上下文上限 ' +
      limit + ' tokens——已停止运行，未调用 API。禁止裁剪数据降级；请提高 EXECUTOR_CONTEXT_LIMIT_TOKENS 或更换更大上下文模型。'
    );
  }
  return est;
}

// 篇幅硬阈值（审计补充）：C1≥100 字 / C3≥80 字 / 其余 C 模块≥50 字
const LENGTH_THRESHOLDS = { C1: 100, C3: 80, DEFAULT: 50 };
// 表行数硬阈值：C6 裁决表 ≥3 数据行；C9 倾向表 ≥3 数据行
const TABLE_MIN_ROWS = { C6: 3, C9: 3 };

function retryDelayMs(attempt) {
  // attempt = 第几次重试（1..MAX_RETRIES）
  return BACKOFF_MS[Math.min(Math.max(1, attempt), BACKOFF_MS.length - 1)] || 0;
}

// 占位残留检测：任何 [块N] 类占位（含全角/半角空白变体）
function hasPlaceholderResidue(text) {
  if (!text) return true;
  return /\[块\s*\d+\]/.test(text);
}

// 代码围栏残留检测（P2：R5 输出禁止 ``` 围栏包裹；R4 不适用——包装 JSON 由 parseStructureJson 容错）
function hasFenceResidue(text) {
  if (!text) return false;
  return /(^|\n)```[^\n]*\n[\s\S]*?\n```/.test(text);
}

// 按 "## C<N>" 边界切出指定模块文本（无匹配 → 空串）
function sliceModule(text, module) {
  if (!text) return '';
  const num = parseInt(String(module).replace(/\D/g, ''), 10);
  if (!(num >= 1 && num <= 12)) return '';
  const re = new RegExp('##\\s*C' + num + '\\b');
  const idx = text.search(re);
  if (idx < 0) return '';
  const rest = text.slice(idx + 4);
  // 下一模块边界：只认更大的模块号（C6 的子标题如 "## C6 裁决表" 不构成边界）
  let next = -1;
  for (let n = num + 1; n <= 12; n++) {
    const m = rest.search(new RegExp('\\n##\\s*C' + n + '\\b'));
    if (m >= 0 && (next < 0 || m < next)) next = m;
  }
  return next >= 0 ? text.slice(idx, idx + 4 + next) : text.slice(idx);
}

// 模块篇幅检查（去空白字符数）
function moduleLengthCheck(text, module) {
  const min = LENGTH_THRESHOLDS[module] || LENGTH_THRESHOLDS.DEFAULT;
  const current = (sliceModule(text, module) || '').replace(/\s/g, '').length;
  return { ok: current >= min, current, min };
}

// Markdown 表格数据行数（排除表头与分隔行；单格行不计）
function tableDataRows(text) {
  if (!text) return 0;
  const lines = text.split(/\r?\n/);
  let rows = 0;
  for (const line of lines) {
    const t = line.trim();
    if (!t.startsWith('|')) continue;
    if (/^\|[\s:|-]+\|$/.test(t)) continue;                     // 分隔行
    const cells = t.split('|').filter((_, i, a) => i > 0 && i < a.length - 1);
    if (cells.length < 2) continue;                              // 通宽/单格行
    rows++;
  }
  return Math.max(0, rows - 1); // 减表头
}

// 单轮产物门禁（R5 半区按模块切片检查；其余轮仅占位残留）
function assessArtifact(roundName, text) {
  const errors = [];
  if (hasPlaceholderResidue(text)) errors.push('占位残留（[块N]）');
  if (String(roundName || '').startsWith('R5') && hasFenceResidue(text)) errors.push('代码围栏残留（```）');
  if (roundName === 'R5A' || roundName === 'R5') {
    for (const m of ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7']) {
      const r = moduleLengthCheck(text, m);
      if (!r.ok) errors.push('篇幅不足 ' + m + '=' + r.current + '<' + r.min);
    }
    const c6 = tableDataRows(sliceModule(text, 'C6'));
    if (c6 < TABLE_MIN_ROWS.C6) errors.push('C6 裁决表数据行不足 ' + c6 + '<' + TABLE_MIN_ROWS.C6);
  }
  if (roundName === 'R5B' || roundName === 'R5') {
    for (const m of ['C8', 'C9', 'C10', 'C11', 'C12']) {
      const r = moduleLengthCheck(text, m);
      if (!r.ok) errors.push('篇幅不足 ' + m + '=' + r.current + '<' + r.min);
    }
    const c9 = tableDataRows(sliceModule(text, 'C9'));
    if (c9 < TABLE_MIN_ROWS.C9) errors.push('C9 倾向表数据行不足 ' + c9 + '<' + TABLE_MIN_ROWS.C9);
  }
  return { ok: errors.length === 0, errors, warnings: [] };
}

// 切片契约维度（260816 小项合并批）：secs/roundKeys/endMap 三清单单一事实源
// 语义区分：ROUNDS = 执行单元（R5A/R5B 拆开）；SECTION_ROUNDS = SECTION 标记键（单 R5）——独立字面量 + SEC 断言锁定
const SECTION_ROUNDS = ['R1', 'R2', 'R2.5', 'R3', 'R4', 'R4.5', 'R5', 'R6a', 'R6b'];
const SECTION_ENDMAP = {
  '1': '## R2 PROMPT', '2': '## R2.5 PROMPT', '2.5': '## R3 PROMPT',
  '3': '## R4 PROMPT', '4': '## R4.5 PROMPT', '4.5': '## R5 PROMPT', '5': '## R6a PROMPT',
  '6a': '## R6b PROMPT', '6b': '## TRANSITION SCHEMA'
};

// 断点判定：产物已存在且门禁通过 → 可跳过
function isArtifactUsable(roundName, text) {
  return text && assessArtifact(roundName, text).ok;
}

module.exports = {
  ROUNDS, R5_HALVES, SECTION_ROUNDS, SECTION_ENDMAP, MAX_RETRIES, BACKOFF_MS, LENGTH_THRESHOLDS, TABLE_MIN_ROWS,
  DEFAULT_CONTEXT_LIMIT_TOKENS, TOKEN_ESTIMATE_FACTOR, estimateTokens, assertWithinContextLimit,
  retryDelayMs, hasPlaceholderResidue, hasFenceResidue, sliceModule, moduleLengthCheck,
  tableDataRows, assessArtifact, isArtifactUsable
};
