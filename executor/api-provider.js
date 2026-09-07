// A8-P3b：API 提供者抽象层（Node / Browser 共享；无 fs/path）
// 支持 provider：
//   auto                —— 自动探测（默认）：EXECUTOR_PROVIDER 显式 > ANTHROPIC_* > OPENAI_* > 报错（不静默 mock）
//   mock                —— 本地冒烟（宿主可注入 mockResponder，默认返回占位）
//   openai-compatible   —— OpenAI 兼容 /chat/completions（fetch）
//   anthropic-compatible —— Anthropic 兼容 /v1/messages（DeepSeek 端点；读 ANTHROPIC_BASE_URL/ANTHROPIC_AUTH_TOKEN/ANTHROPIC_MODEL）
//   claude-task         —— 当前管道经 Claude Task 工具执行的宿主回调（需宿主注入 taskRunner）
//   codex-cli            —— Node 宿主注入的本机 Codex CLI runner（共享层不直接依赖 child_process）
'use strict';

// A8-P7：最大输出上限（以 DeepSeek V4 Flash/Pro 为基准：API 最大输出 384K tokens）
// 默认 384000 = 模型能力上限，彻底消除输出截断；仍可用 ANTHROPIC_MAX_TOKENS / EXECUTOR_MAX_TOKENS / OPENAI_MAX_TOKENS / .api-config.json 覆盖（按需调低以控成本）。
const DEFAULT_MAX_TOKENS = 384000;
// 单请求超时：长输入（full-data 全量注入）+ 长输出（最高 384K tokens 的理论时长）放宽到 2 小时，避免误杀导致重试/妥协
const DEFAULT_TIMEOUT_MS = 7200000;

// A8-ERR-1：配置文件合并（前端面板导出的 .api-config.json；fileCfg 字段显式覆盖 env，provider 未显式时按 fileCfg → env → auto）
function resolveConfig(env, fileCfg) {
  env = env || {};
  fileCfg = fileCfg || null;
  // 优先级：显式 env provider（非 auto）> fileCfg.provider > env auto > 缺省 auto
  const envProvider = env.EXECUTOR_PROVIDER || env.JUDGE_PROVIDER || 'auto';
  let provider = envProvider !== 'auto' ? envProvider : ((fileCfg && fileCfg.provider) || 'auto');
  // auto：按可用凭据探测（ANTHROPIC 兼容端点优先，其次 OpenAI 兼容端点）；无凭据 → 抛错，不静默降级
  if (provider === 'auto') {
    if (env.ANTHROPIC_BASE_URL && env.ANTHROPIC_AUTH_TOKEN && env.ANTHROPIC_MODEL) {
      provider = 'anthropic-compatible';
    } else if (env.OPENAI_BASE_URL && env.OPENAI_API_KEY && env.OPENAI_MODEL) {
      provider = 'openai-compatible';
    } else {
      provider = 'unavailable';
    }
  }
  if (provider === 'unavailable') {
    return { provider: 'unavailable', error: '未探测到可用 API 凭据（ANTHROPIC_* 或 OPENAI_*）；请配置环境变量或显式 --provider' };
  }
  if (provider === 'anthropic-compatible') {
    return {
      provider,
      baseUrl: (fileCfg && fileCfg.baseUrl) || env.ANTHROPIC_BASE_URL || '',
      apiKey: (fileCfg && fileCfg.apiKey) || env.ANTHROPIC_AUTH_TOKEN || '',
      model: (fileCfg && fileCfg.model) || env.ANTHROPIC_MODEL || '',
      timeoutMs: parseInt(env.EXECUTOR_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10),
      maxTokens: parseInt((fileCfg && fileCfg.maxTokens) || env.ANTHROPIC_MAX_TOKENS || String(DEFAULT_MAX_TOKENS), 10),
      temperature: parseFloat((fileCfg && fileCfg.temperature) || env.EXECUTOR_TEMPERATURE || '0.3')
    };
  }
  if (provider === 'codex-cli') {
    return {
      provider,
      codexPath: (fileCfg && fileCfg.codexPath) || env.CODEX_CLI_PATH || env.CODEX_PATH || '',
      cwd: (fileCfg && fileCfg.cwd) || env.CODEX_CWD || '',
      model: (fileCfg && fileCfg.model) || env.CODEX_MODEL || env.EXECUTOR_MODEL || '',
      timeoutMs: parseInt((fileCfg && fileCfg.timeoutMs) || env.EXECUTOR_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10),
      maxOutputBytes: parseInt((fileCfg && fileCfg.maxOutputBytes) || env.CODEX_MAX_OUTPUT_BYTES || String(64 * 1024 * 1024), 10),
      sandbox: 'read-only',
      ephemeral: true,
      skipGitRepoCheck: true
    };
  }
  return {
    provider,
    baseUrl: (fileCfg && fileCfg.baseUrl) || env.EXECUTOR_BASE_URL || env.OPENAI_BASE_URL || '',
    apiKey: (fileCfg && fileCfg.apiKey) || env.EXECUTOR_API_KEY || env.OPENAI_API_KEY || '',
    model: (fileCfg && fileCfg.model) || env.EXECUTOR_MODEL || env.OPENAI_MODEL || 'gpt-5',
    timeoutMs: parseInt(env.EXECUTOR_TIMEOUT_MS || String(DEFAULT_TIMEOUT_MS), 10),
    maxTokens: (fileCfg && fileCfg.maxTokens) || parseInt(env.EXECUTOR_MAX_TOKENS || env.OPENAI_MAX_TOKENS || env.ANTHROPIC_MAX_TOKENS || String(DEFAULT_MAX_TOKENS), 10),
    temperature: parseFloat((fileCfg && fileCfg.temperature) || env.EXECUTOR_TEMPERATURE || '0.3')
  };
}

function normalizeMessages(messages) {
  return (messages || []).map(m => ({ role: m.role || 'user', content: String(m.content || '') }));
}

// A8-ERR-1：格式遵守强化 system 提示（对齐 Claude 客户端调用方式；格式任务低温度）
const FORMAT_SYSTEM = '你是辩论裁判引擎。你必须严格、逐字遵守用户指令中的所有输出格式要求（S 标记、### 结论 子块、DATA 标记、表格、INSERT 占位、JSON 结构）。每个 S 段必须在 [S_START] 后立即以 "### 结论" 标题开头。输出必须是完整且可机械校验的产物；不得省略、不得解释、不得输出额外内容。';

// ---- B 方案（260812）：SSE 流式解析（OpenAI 兼容端点；零依赖，Node/browser 通用）----
// 流式 = 传输层细节：单次请求，响应分批到达；机械累积 delta → 完整文本。
// 语义与 .json() 非流式一致：返回 choices[0].message.content 全文；finish_reason=length → 截断错误。
// v7 终版（四轮审计并入）：
//   ① 多行 data: 帧按 SSE 规范以 \n 拼接后整体 parse；
//   ② 帧分隔在原始 buffer 上识别（\r\n\r\n|\r\r|\n\n），帧提取后再归一行尾——规避 per-chunk 归一
//     在 \r 落 chunk 尾时制造假帧界、静默丢内容（首轮路1 实证 T4）；
//   ③ 流中断语义：done=true = 干净 EOF；真断连（网络层）由 read() 抛错 → 外层重试/包装；
//     收紧：**EOF 时**且全程无 finish_reason → 视为截断异常（网关实测 3/3 必发 finish_reason 帧，不误伤；
//     符合「截断产物禁止落盘」纪律；判定点在 EOF 而非 [DONE]——⑬ 后 [DONE] 之后的 finish 帧仍被采纳，
//     触发面更精准：仅真截断（网关中途掐断）阻断）；
//   ④ \r\n 与 \r 行尾归一（帧提取后）；
//   ⑤ 缓冲上限 16MB（脏网关/无分隔符时防内存膨胀）——consume 后检查**残留 buffer**（v6：检查在 consume 之前
//     会误杀「含分隔符的合法大帧」，四轮路A A1-2 实证 v5 对照误抛；残留超限=真脏流）。
//     已知边界（登记）：单帧尺寸不设限（>16MB 单帧被 consume 瞬时吞入内存，上限只防残留不防帧）——注释明示不防护；
//   ⑥ 网络失败自动重试 1 次（退避 2s）：仅「非 [executor] 前缀 且 非 AbortError」错误
//      （fetch failed/断连重试；HTTP/截断/无内容/配置错误/自身超时 abort 不重试）；
//   ⑦ 流中 error 帧检测（首轮路3 实证 C6）：j.error → 抛错，防部分文本误判成功
//      （[DONE] 后 error 帧同样抛——四轮路A A3-e 实证，行为差异存档）；
//   ⑧ 数据行剥单空格（slice(5) 后 replace(/^ /,'')，不用 .trim()——防字符串内边界空白损坏，首轮路2）；
//   ⑨ EOF 残帧处理 + decoder flush（循环结束处理剩余 buffer，防末帧/末字符丢失，首轮路1/2）；
//   ⑩ [DONE] 后（streamEnded）不再追加 content（防 post-DONE 帧污染），finish_reason 仍采纳——
//      配合 ⑬ EOF 终止语义后，post-DONE 帧处理完全对称（同/跨 chunk 一致，四轮路A A3-c 实证）；
//   ⑪ timeoutMs 缺省收敛为模块常量 DEFAULT_TIMEOUT_MS；
//   ⑫ 脏帧可观测（v6）：JSON.parse 失败 console.warn 一次后继续（不再静默吞——不可观测变可观测；
//      丢帧仍容忍不阻断，与 ⑥ 重试日志同款思路）；
//   ⑬ EOF 才是流终止点，[DONE] 只是语义标记（v6）：[DONE] 后继续消费至 EOF——
//      「[DONE] 后 EOF 残帧形态误丢整类」消除（四轮路A A3-a2/a3 实证 v5 对照误抛）+ 任意帧序/重复 [DONE] 免疫；
//      ⑩ 守卫保证 content 不污染。已知边界（登记）：若网关 [DONE] 后不关闭连接持续发帧，
//      read() 挂起至超时 abort（AbortError 不重试直接抛；四轮路C 实证）；post-[DONE] content 帧被 ⑩ 拦截
//      text 不增长（⑩/⑤ 双守卫）——网关实测 [DONE] 后立即关闭（元帧后 done），风险极低，注释明示不防护。
const SSE_BUFFER_LIMIT = 16 * 1024 * 1024;
async function requestCompletionStream(baseUrl, apiKey, body, opts) {
  opts = opts || {};
  const attempt = async (signal) => {
    const res = await fetch(baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + apiKey },
      body: JSON.stringify(Object.assign({ stream: true }, body)),
      signal
    });
    if (!res.ok) throw new Error('[executor] API ' + res.status + ' ' + (await res.text()).slice(0, 300));
    if (!res.body || typeof res.body.getReader !== 'function')
      throw new Error('[executor] 流式响应无 body（ReadableStream）——端点不支持 stream 或网关异常');
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let finishReason = null;
    let streamEnded = false;
    const consumeFrames = (b, final) => {
      // ② 帧分隔三种合法形态（\r\n\r\n | \r\r | \n\n）在原始 buffer 上识别
      const sepRe = /\r\n\r\n|\r\r|\n\n/;
      let rest = b;
      let m;
      while ((m = sepRe.exec(rest)) !== null) {
        const frame = rest.slice(0, m.index);
        rest = rest.slice(m.index + m[0].length);
        processFrame(frame);                                    // ⑬ 不再因 streamEnded break——[DONE] 后帧仍处理（⑩ 守卫）
      }
      // ⑨ EOF：final 时剩余残帧按完整帧处理（无结尾 \n\n 的末帧/小流；streamEnded 后残帧仍处理——收 finish_reason）
      if (final && rest) processFrame(rest);
      return rest;
    };
    const processFrame = (frame) => {
      // ④ 帧提取后行尾归一
      const norm = frame.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
      // ① 帧内多行 data: 合并（SSE 规范：连续 data 行以 \n 拼接为单一 payload）
      const dataLines = norm.split('\n').filter(l => l.startsWith('data:'));
      if (!dataLines.length) return;                       // 注释/事件/retry 帧忽略
      const payload = dataLines.map(l => l.slice(5).replace(/^ /, '')).join('\n');   // ⑧ 仅剥单空格
      if (!payload) return;
      if (payload === '[DONE]') { streamEnded = true; return; }
      let j;
      try { j = JSON.parse(payload); } catch (e) { console.warn('[executor] 流式脏帧跳过: ' + e.message); return; }   // ⑫ 可观测
      if (j.error) throw new Error('[executor] 流中错误帧: ' + (j.error.message || JSON.stringify(j.error)).slice(0, 300));   // ⑦
      const choice = j.choices && j.choices[0];
      if (!choice) return;                                     // [DONE] 后元帧（choices:[]）安全跳过
      const delta = choice.delta || {};
      // ⑩ [DONE] 后（streamEnded）不再追加 content（防 post-DONE 帧污染），finish_reason 仍采纳
      if (typeof delta.content === 'string' && !streamEnded) text += delta.content;   // reasoning_content 交错出现时忽略（只取 content）
      if (choice.finish_reason) finishReason = choice.finish_reason;
    };
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;                                       // ⑬ EOF 才是终止点——[DONE] 后继续读流
        buffer += decoder.decode(value, { stream: true });
        buffer = consumeFrames(buffer, false);
        // ⑤ 缓冲上限（v6：consume 后残留超限 = 脏流无分隔符；合法大帧已被 consume 消费，不误杀）
        if (buffer.length > SSE_BUFFER_LIMIT)
          throw new Error('[executor] 流式缓冲超限（' + SSE_BUFFER_LIMIT + 'B）——网关帧异常或无 \\n\\n 分隔，已中止');
      }
      buffer += decoder.decode();                              // ⑨ decoder flush（流尾多字节字符）
      buffer = consumeFrames(buffer, true);                    // ⑨ 残帧处理
    } finally {
      try { reader.releaseLock && reader.releaseLock(); } catch (e) {}
    }
    if (finishReason === 'length')
      throw new Error('[executor] 输出达到 max_tokens 上限被截断（finish_reason=length）——已停止且未落盘。请提高 max_tokens（当前 ' + (body.max_tokens || '网关默认上限') + '）后重试，禁止使用截断产物。');
    // ③ 收紧：done 且全程无 finish_reason → 截断/异常流
    if (!finishReason)
      throw new Error('[executor] 流式响应未收到 finish_reason（流被截断或网关异常）——已停止且未落盘，禁止使用部分产物。');
    if (!text) {
      const err = new Error('[executor] 流式响应无内容（choices 空或全程无 delta.content）');
      err.code = 'EMPTY_COMPLETION';
      throw err;
    }
    return text;
  };
  // ⑥ 网络失败自动重试 1 次（退避 2s）：非 [executor] 前缀 且 非 AbortError；每次尝试独立 AbortController
  const runWithTimeout = async () => {
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), opts.timeoutMs != null ? opts.timeoutMs : DEFAULT_TIMEOUT_MS) : null;   // ⑪
    const externalSignal = opts.signal || null;
    let onExternalAbort = null;
    if (ctrl && externalSignal) {
      onExternalAbort = () => ctrl.abort();
      if (externalSignal.aborted) ctrl.abort();
      else if (typeof externalSignal.addEventListener === 'function') externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
    try { return await attempt(ctrl ? ctrl.signal : externalSignal || undefined); }
    finally {
      if (timer) clearTimeout(timer);
      if (externalSignal && onExternalAbort && typeof externalSignal.removeEventListener === 'function') {
        try { externalSignal.removeEventListener('abort', onExternalAbort); } catch (_) {}
      }
    }
  };
  try {
    return await runWithTimeout();
  } catch (e) {
    const retryableEmpty = !!(e && e.code === 'EMPTY_COMPLETION');
    if (e && e.name === 'AbortError') throw e;                  // 自身超时 abort：不重试（最坏时长不翻倍）
    if (e && e.message && e.message.indexOf('[executor]') === 0 && !retryableEmpty) throw e;
    if (retryableEmpty) {
      console.warn('[executor] 流式响应无内容，1 次后重试: finish_reason=stop 但无 delta.content');
    } else {
      console.warn('[executor] 流式请求网络失败，1 次后重试: ' + e.message);   // 重试可观测性（首轮路1）
    }
    await new Promise(r => setTimeout(r, 2000));
    return await runWithTimeout();
  }
}

async function requestCompletion(cfg, messages, opts) {
  opts = opts || {};
  const msgs = normalizeMessages(messages);
  // R7 阶段 2：翻译等非裁判格式任务可用 opts.system 覆盖默认格式系统提示（缺省不变）
  const system = opts.system || FORMAT_SYSTEM;
  if (!cfg || !cfg.provider) throw new Error('[executor] provider 配置缺失');
  if (cfg.provider === 'mock') {
    if (typeof opts.mockResponder === 'function') return String(opts.mockResponder(msgs));
    return '<!-- mock 响应 · ' + String(msgs[msgs.length - 1].content).slice(0, 80) + ' -->';
  }
  if (cfg.provider === 'unavailable') {
    throw new Error('[executor] ' + (cfg.error || '未探测到可用 API 凭据'));
  }
  if (cfg.provider === 'openai-compatible') {
    if (!cfg.baseUrl || !cfg.apiKey) throw new Error('[executor] openai-compatible 需要 EXECUTOR_BASE_URL 与 EXECUTOR_API_KEY');
    try {
      // B 方案（260812）：SSE 流式（机械解析；协议路径与会话界面一致，规避网关非流式 ~300s 断连）
      // 网络失败自动重试 1 次在 requestCompletionStream 内部（⑥）；HTTP/截断/配置错误不重试
      return await requestCompletionStream(cfg.baseUrl, cfg.apiKey, {
        model: cfg.model,
        messages: [{ role: 'system', content: system }].concat(msgs),
        temperature: cfg.temperature !== undefined ? cfg.temperature : 0.3,
        max_tokens: cfg.maxTokens || DEFAULT_MAX_TOKENS   // 批 5（260812 P0-3）：补发 max_tokens（此前配置死旋钮）
      }, { timeoutMs: cfg.timeoutMs, signal: opts.signal });
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      if (e && e.message && e.message.indexOf('[executor]') === 0) throw e;
      throw new Error('[executor] openai-compatible 网络请求失败: ' + e.message + ' @ ' + cfg.baseUrl);
    }
  }
  if (cfg.provider === 'anthropic-compatible') {
    if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) {
      throw new Error('[executor] anthropic-compatible 需要 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL');
    }
    const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), cfg.timeoutMs) : null;
    try {
      const res = await fetch(cfg.baseUrl.replace(/\/+$/, '') + '/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: cfg.maxTokens || DEFAULT_MAX_TOKENS,
          temperature: cfg.temperature !== undefined ? cfg.temperature : 0.3,
          system,
          messages: msgs
        }),
        signal: ctrl ? ctrl.signal : undefined
      });
      if (!res.ok) throw new Error('[executor] Anthropic API ' + res.status + ' ' + (await res.text()).slice(0, 400));
      const json = await res.json();
      const text = (json.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
      if (!text) throw new Error('[executor] Anthropic 响应无 text 内容');
      // A8-P7：输出截断硬检测——stop_reason=max_tokens 表示输出被上限截断，禁止落盘
      if (json.stop_reason === 'max_tokens') {
        throw new Error('[executor] 输出达到 max_tokens 上限被截断（stop_reason=max_tokens）——已停止且未落盘。请提高 max_tokens（当前 ' + cfg.maxTokens + '）后重试，禁止使用截断产物。');
      }
      return text;
    } catch (e) {
      if (e.message && e.message.indexOf('[executor]') === 0) throw e;
      throw new Error('[executor] anthropic-compatible 网络请求失败: ' + e.message + ' @ ' + cfg.baseUrl);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  if (cfg.provider === 'claude-task') {
    if (typeof opts.taskRunner !== 'function') throw new Error('[executor] claude-task provider 需宿主注入 taskRunner（Claude Task 工具不在通用 fetch 域）');
    return String(await opts.taskRunner(msgs));
  }
  if (cfg.provider === 'codex-cli') {
    if (typeof opts.codexRunner !== 'function') throw new Error('[executor] codex-cli provider 需 Node 宿主注入 runner');
    return String(await opts.codexRunner(cfg, msgs, { system }));
  }
  throw new Error('[executor] 未知 provider: ' + cfg.provider);
}

module.exports = { resolveConfig, requestCompletion };
