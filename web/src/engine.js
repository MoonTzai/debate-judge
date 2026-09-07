// ============================================================
// engine.js — Judge 网页版编排层（W2 · 无 DOM，适配器注入）
// 职责：
//   1. 会话状态机：新建/续跑（断点）+ 产物虚拟 FS 落位
//   2. prompt 生成 = 复用打包的 PC.runAll（与 CLI 管道逐字节同源）
//   3. 名册确认（源锚层 v1 浏览器化：确认/跳过/编辑三种处置）
//   4. 管道执行 = 复用打包的 host-node.runPipeline（门禁/重试/断点全同源）
//   5. 六向度相对权重 → 倾向文本注入（web/tendency.js）
//   6. 深度档注入（非默认时追加 R5 半区 prompt 块）
//   7. 中止 = fetch 管理器 abort（api-provider 中断语义保证不落盘半成品）
// 注意：本模块不引用 window/document；UI 与持久化经适配器注入。
// ============================================================
'use strict';

// 自适应 wrapper 为单例（幂等守卫），hooks 经共享引用更新——后续 createEngine 可替换回调
var ADAPTIVE_HOOKS = {};

function createEngine(bundle, hooks) {
  hooks = hooks || {};
  ADAPTIVE_HOOKS = hooks;
  var vfs = bundle.vfs;

  function load(name) { return bundle.modules[name](); }

  var PC = load('pipelineController');
  var host = load('hostNode');
  var api = load('apiProvider');
  var tendency = load('tendency');
  var judgeContext = load('judgeContext');
  var core = load('core');   // W-T5：轮次表 ROUNDS + 断点内容级预估 isArtifactUsable（R21-1：现状未加载，不补则 ReferenceError）

  // ---------- 自适应保险（对齐青春版机制 · web 层运行时 seam，不动内核） ----------
  // ① 输出截断（finish_reason=length）→ 自动提高 max_tokens 重试一次（上限 384K，与 api-provider DEFAULT_MAX_TOKENS 一致）
  //    —— 比青春版「截断续写」更严：整轮原子重跑，产物完整无接缝，符合「截断产物禁止落盘」管道纪律
  // ② 思考参数不被端点支持（HTTP 400 + 参数措辞）→ 自动降级为不附加思考参数重试一次
  // ③ 端点拒绝过大 max_tokens（HTTP 400 + token/limit 措辞）→ 减半重试一次（下限 4K）——青春版同款降级
  var API_MAX_TOKENS_CAP = 384000;
  var API_MIN_TOKENS_FLOOR = 4096;
  function installAdaptiveApi() {
    if (api.__judgeWebAdapted) return;
    api.__judgeWebAdapted = true;
    var original = api.requestCompletion;
    api.requestCompletion = async function (cfg, messages, opts) {
      opts = opts || {};
      // 进度遥测透传（P2 补丁消费 opts.onProgress；UI 活性指示用）
      if (ADAPTIVE_HOOKS.onProgress && !opts.onProgress) {
        opts = Object.assign({}, opts, { onProgress: ADAPTIVE_HOOKS.onProgress });
      }
      try {
        return await original(cfg, messages, opts);
      } catch (e) {
        var msg = String(e && e.message || '');
        if (/finish_reason=length|max_tokens 上限|stop_reason=max_tokens/.test(msg)) {
          var cur = Number(cfg && cfg.maxTokens) || API_MAX_TOKENS_CAP;
          var up = Math.min(cur * 2, API_MAX_TOKENS_CAP);
          if (up > cur) {
            cfg.maxTokens = up;
            if (ADAPTIVE_HOOKS.onAdaptive) { try { ADAPTIVE_HOOKS.onAdaptive(up); } catch (err) {} }
            return await original(cfg, messages, opts);
          }
        }
        if (/API 400/.test(msg) && /thinking|reasoning|extra_body|unknown field|invalid parameter/i.test(msg) && cfg.extraBody) {
          var saved = cfg.extraBody;
          cfg.extraBody = null;
          if (ADAPTIVE_HOOKS.onNote) { try { ADAPTIVE_HOOKS.onNote('端点拒绝思考参数（' + msg.slice(0, 120) + '…）——已自动降级为不附加思考参数重试'); } catch (err) {} }
          try { return await original(cfg, messages, opts); }
          catch (e2) { cfg.extraBody = saved; throw e2; }
        }
        if (/API 400/.test(msg) && /token|maximum|limit|context/i.test(msg)) {
          var cur2 = Number(cfg && cfg.maxTokens) || API_MAX_TOKENS_CAP;
          var down = Math.max(Math.floor(cur2 / 2), API_MIN_TOKENS_FLOOR);
          if (down < cur2) {
            cfg.maxTokens = down;
            if (ADAPTIVE_HOOKS.onAdaptive) { try { ADAPTIVE_HOOKS.onAdaptive(down); } catch (err) {} }
            return await original(cfg, messages, opts);
          }
        }
        throw e;
      }
    };
  }
  installAdaptiveApi();

  // ---------- API 配置（openai-compatible 固定；mock 冒烟） ----------
  // 厂商差异只在 Web adapter 层转换请求形状；根 Judge/api-provider 语义保持不变。
  function buildApiCfg(settings) {
    if (settings.provider === 'mock') {
      return api.resolveConfig({ EXECUTOR_PROVIDER: 'mock' }, null);
    }
    var provider = settings.provider || 'custom';
    var model = settings.model || '';
    var fileCfg = {
      provider: 'openai-compatible',
      baseUrl: settings.baseUrl || '',
      apiKey: settings.apiKey || '',
      model: model,
      maxTokens: settings.maxTokens || undefined,
      temperature: settings.temperature !== undefined ? settings.temperature : 0.3
    };
    var cfg = api.resolveConfig({}, fileCfg);
    var extra = buildThinkingExtra(settings) || {};
    // Kimi K3 / OpenAI 5.x Chat Completions 使用 max_completion_tokens；K3 固定 temperature=1.0，官方建议不要显式传。
    if (provider === 'kimi' && /^kimi-k3(?:$|-)/i.test(model)) {
      cfg.omitTemperature = true;
      cfg.omitMaxTokens = true;
      extra.max_completion_tokens = settings.maxTokens || cfg.maxTokens;
    } else if (provider === 'openai' && /^gpt-5(?:\.|-|$)/i.test(model)) {
      cfg.omitTemperature = true;
      cfg.omitMaxTokens = true;
      extra.max_completion_tokens = settings.maxTokens || cfg.maxTokens;
    }
    if (Object.keys(extra).length) cfg.extraBody = extra;
    return cfg;
  }

  // ---------- 外部白话字典（W-T6）：settings.plainDictExt 预合并（核心+外部，与 CLI --plain-dict 同语义） ----------
  // loadPlainDict 的 corePath（workDir/assets/plain-dict.json）在 web 不存在 → 若只传外部字典会丢核心词条，
  // 故在引擎层预合并后写入 VFS 单一文件（外部覆盖核心，Object.assign 同 host-node L496 语义）。
  function plainDictPath(settings, log) {
    if (!settings.plainDictExt || !String(settings.plainDictExt).trim()) return '/assets/plain-dict.json';
    try {
      var core = JSON.parse(vfs.readFileSync('/assets/plain-dict.json', 'utf-8'));
      var ext = JSON.parse(String(settings.plainDictExt));
      var merged = Object.assign({}, core, ext);
      vfs.writeFileSync('/input/plain-dict-ext.json', JSON.stringify(merged));
      log('[judge-web] 外部白话字典已合并：核心 ' + Object.keys(core).length + ' + 外部 ' + Object.keys(ext).length + ' = ' + Object.keys(merged).length + ' 词条');
      return '/input/plain-dict-ext.json';
    } catch (e) {
      log('[judge-web] ⚠ 外部白话字典解析失败，忽略并沿用核心字典: ' + e.message);
      return '/assets/plain-dict.json';
    }
  }

  // ---------- 思考参数 → 请求体附加字段 ----------
  // 厂商协议差异只在此 Web adapter seam 收敛；custom 仍允许用户提供原始 JSON。
  function buildThinkingExtra(settings) {
    var mode = settings.thinking || 'on';
    var provider = settings.provider || 'custom';
    var model = String(settings.model || '');
    if (mode === 'custom') {
      var raw = settings.thinkingJson;
      if (!raw || !String(raw).trim()) return null;
      try {
        var j = JSON.parse(String(raw));
        if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('必须是 JSON 对象');
        return j;
      } catch (e) {
        if (ADAPTIVE_HOOKS.onNote) { try { ADAPTIVE_HOOKS.onNote('思考参数 JSON 无效（' + e.message + '）——本次请求按不附加思考参数执行'); } catch (err) {} }
        return null;
      }
    }
    if (provider === 'kimi' && /^kimi-k3(?:$|-)/i.test(model)) {
      if (mode === 'off' && ADAPTIVE_HOOKS.onNote) {
        try { ADAPTIVE_HOOKS.onNote('Kimi K3 官方 API 始终开启思考，无法关闭；本次按最低 reasoning_effort=low 执行。'); } catch (err2) {}
      }
      return { reasoning_effort: mode === 'off' ? 'low' : 'max' };
    }
    if (provider === 'openai') return { reasoning_effort: mode === 'off' ? 'none' : 'high' };
    if (provider === 'deepseek' || provider === 'glm') return { thinking: { type: mode === 'off' ? 'disabled' : 'enabled' } };
    if (mode === 'off') return null;
    return { thinking: { type: 'enabled' } };
  }
  // ---------- 会话时间戳目录 ----------
  function newSpeechPath() {
    var d = new Date();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return '/input/speech-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) +
      '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '.txt';
  }

  // ---------- 深度块注入（非默认 → 追加到 R5 半区 prompt） ----------
  function appendDepthBlocks(workDir, depth, onLog) {
    var block = tendency.depthBlockText(depth);
    if (!block) return false;
    var files = [workDir + '/.tmp-R5-A-prompt.md', workDir + '/.tmp-R5-B-prompt.md'];
    var applied = 0;
    for (var i = 0; i < files.length; i++) {
      if (!vfs.existsSync(files[i])) continue;
      var txt = vfs.readFileSync(files[i], 'utf-8');
      vfs.writeFileSync(files[i], txt + block);
      applied++;
    }
    if (onLog && applied) onLog('[judge-web] 深度档注入 R5 半区 prompt（' + applied + ' 个文件）');
    return applied > 0;
  }

  // ---------- Judge Persona Context：独立 round projector → VFS prompt overlay ----------
  // 不复用 tendency 全轮注入通道；只允许触达 R4.5/R5，且 R4.5 仍由 projector 按 useMode 收窄为已登记冲突的次级解释。
  function appendJudgeContextBlocks(workDir, rawContext, onLog) {
    var context = judgeContext.normalizeJudgeContext(rawContext);
    if (!context.enabled) return false;
    var targets = [
      { round: 'R4.5', file: workDir + '/.tmp-R4.5-prompt.md' },
      { round: 'R5A', file: workDir + '/.tmp-R5-A-prompt.md' },
      { round: 'R5B', file: workDir + '/.tmp-R5-B-prompt.md' }
    ];
    var applied = [];
    for (var i = 0; i < targets.length; i++) {
      var block = judgeContext.projectJudgeContext(context, targets[i].round);
      if (!block) continue;
      if (!vfs.existsSync(targets[i].file)) throw new Error('[judge-web] Judge Persona Context 目标 prompt 缺失: ' + targets[i].file);
      var text = vfs.readFileSync(targets[i].file, 'utf-8');
      vfs.writeFileSync(targets[i].file, text + block);
      applied.push(targets[i].round);
    }
    if (onLog && applied.length) onLog('[judge-web] Judge Persona Context 已按轮注入：' + applied.join(', '));
    return applied.length > 0;
  }

  // ---------- W-PH：promptHash 失配判定（批次档案 + 追溯） ----------
  // 批次档案：每次 run 终态追加一条（含每轮终态 promptHash + 本批实际生成产物的轮），
  // 落 VFS `.tmp-run-batches.json`（随 rec.files 快照走，单一事实源）；runModel 为 null（R12-1 防御）时仍记录时间线（hashes 缺省 {}）。
  // 返回新批次对象（调用方追加进 runModel.batches 并重算判定——buildRunModel 快照先于本函数，files 侧不含本批）；失败 → null。
  function appendRunBatch(workDir, runModel, events) {
    try {
      var bp = workDir + '/.tmp-run-batches.json';
      var existing = [];
      if (vfs.existsSync(bp)) {
        var parsed = JSON.parse(vfs.readFileSync(bp, 'utf-8'));
        if (parsed && Array.isArray(parsed.batches)) existing = parsed.batches;
      }
      var hashes = {};
      if (runModel && runModel.rounds) {
        for (var i = 0; i < runModel.rounds.length; i++) {
          var rr = runModel.rounds[i];
          hashes[rr.round] = rr.promptHash;
        }
      }
      var generated = [];
      if (events) {
        for (var j = 0; j < events.length; j++) {
          var ev = events[j];
          if (ev && ev.ok && !ev.skipped) generated.push(ev.round);
        }
      }
      var batch = {
        at: new Date().toISOString(),
        derivedStatus: runModel && runModel.summary ? runModel.summary.derivedStatus : 'unknown',
        hashes: hashes,
        generated: generated
      };
      existing.push(batch);
      while (existing.length > 50) existing.shift();   // D5：防御上限，超限丢最旧
      vfs.writeFileSync(bp, JSON.stringify({ schema: 'judge-web-run-batches-v1', batches: existing }));
      return batch;
    } catch (e) { return null; }   // 批次记录失败不阻断主流程（R2）
  }

  // runSession 终态：把新批并入 runModel（快照时序——buildRunModel 快照不含本批）并重算失配判定
  function attachRunBatch(runModel, newBatch) {
    if (!runModel || !newBatch) return;
    runModel.batches = (runModel.batches || []).concat([newBatch]);
    runModel.staleRounds = computeStaleRounds(runModel.rounds, runModel.batches);
    var sc = 0;
    for (var k in runModel.staleRounds) { if (runModel.staleRounds[k]) sc++; }
    runModel.summary.staleCount = sc;
  }

  // 轮级失配判定（纯函数）：某轮主产物生成时的 promptHash ≠ 最新批次同轮 promptHash → stale。
  // 追溯：从最新批次向旧扫描「generated 含该轮」的批次（产物版本）；hashes 缺该轮键/null → 不判定（保守不误报）。
  function computeStaleRounds(rounds, batches) {
    var result = {};
    if (!rounds || !batches || !batches.length) return result;
    var latestIdx = batches.length - 1;
    var latest = batches[latestIdx];
    for (var i = 0; i < rounds.length; i++) {
      var rr = rounds[i];
      if (!rr.artifact || !rr.artifact.exists) continue;   // 无主产物不判定
      var genIdx = -1;
      for (var b = batches.length - 1; b >= 0; b--) {
        var gen = batches[b].generated || [];
        if (gen.indexOf(rr.round) >= 0) { genIdx = b; break; }
      }
      if (genIdx < 0 || genIdx === latestIdx) continue;   // 从未本批生成（防御）/ 最新批生成 → 不失配
      var genHash = batches[genIdx].hashes ? batches[genIdx].hashes[rr.round] : undefined;
      var curHash = latest.hashes ? latest.hashes[rr.round] : undefined;
      if (genHash && curHash && genHash !== curHash) result[rr.round] = true;
    }
    return result;
  }

  // 指定节点续跑 policy 由 pipeline-controller.js 统一提供；Web/HTML/CLI/Skill 不维护第二套依赖图。
  var canonicalResumeNode = PC.canonicalResumeNode;
  var planResumeStart = PC.planResumeStart;
  function resumeInvalidationFiles(workDir, plan) {
    var base = posixOf(workDir).replace(/\/+$/, '');
    var snapshot = vfs.snapshot(base + '/');
    var prefix = base + '/';
    var names = Object.keys(snapshot).map(function (full) { return full.slice(prefix.length); });
    return PC.resumeInvalidationNames(plan, names).map(function (name) { return prefix + name; });
  }
  function applyResumeRewind(workDir, plan) {
    var files = resumeInvalidationFiles(workDir, plan);
    files.forEach(function (p) {
      if (vfs.existsSync(p)) vfs.unlinkSync(p);
    });
    return { removedFiles: files, invalidatedNodes: (plan && plan.invalidatedNodes || []).slice() };
  }

  // ---------- 会话执行 ----------
  // opts: {
  //   speech: string 辩词全文
  //   settings: { provider, baseUrl, apiKey, model, maxTokens, temperature,
  //               plain, readerGuide, skipRosterConfirm, tendencyWeights, judgeContext, depth }
  //   force: bool（重跑覆盖）
  //   resumeDir: string|null（断点续跑目录）
  //   onLog: fn(string)
  //   onRoster: async fn({anchor, workDir, session}) -> {action:'confirm'|'skip'|'abort'|'edit', editedAnchor?}
  //   onRound: fn({round, ok, skipped, errors, attempt, postprocess?})  轮次/后处理结束回调（UI 时间线）
  //   onStage: fn({stage, state, postprocess?})  后处理活动态回调（R7/R8，不改变 core.ROUNDS 权威）
  //   persist: async fn(step, payload)  持久化钩子（UI 存 IndexedDB）
  //   abortSignal: AbortSignal|null（外部中止信号，W-T10：轮间 apiStub 前置检查 + 进行中请求合并 abort）
  // }
  function firstFailedResult(results) {
    var list = Array.isArray(results) ? results : [];
    for (var i = 0; i < list.length; i++) {
      if (list[i] && list[i].ok === false && !list[i].skipped) return list[i];
    }
    return null;
  }

  async function runSession(opts) {
    var log = opts.onLog || function () {};
    var settings = opts.settings || {};
    var resumeStartNode = canonicalResumeNode(opts.resumeStartNode || 'auto');
    var targetedResume = !!opts.resumeDir && resumeStartNode !== 'auto';
    // 定点续跑由 planner 决定失效面；force 全量覆盖与该语义互斥，避免绕过 planner 重跑上游。
    var effectiveForce = targetedResume ? false : !!opts.force;
    var resumePlan = null;
    var resumeEntrySnapshot = null;
    // W-T5（E3）：本 run 的 onRound 事件序列（runSession 级，每次调用开头重置——多场次/续跑不串，R2-3）
    var runEvents = [];
    // W-T10：外部中止信号（单一中止事实源）。abortSignal 存在时构建 apiStub 包装——
    // ① 前置检查：每轮/每次 API 调用前 signal.aborted → 抛 AbortError（轮间/重试间/白话层批间兜底）；
    // ② signal 合并透传：进行中请求经构建期补丁 P3-1（api-provider runWithTimeout 合并 opts.signal）中止。
    // Object.assign({}, o, ...) 保留 runRound 传入的 mockResponder（mock 路径不受影响）。
    var abortSignal = opts.abortSignal || null;
    // W-T1：PLAIN 批缓存已由 host 写入 VFS 后，Web 必须先把对应 checkpoint durable 到 IndexedDB，
    // 才允许下一笔真实 API。barrier 自身永不 reject；失败单独锁进 checkpointFailure，避免 fire-and-forget unhandled rejection。
    var checkpointBarrier = Promise.resolve();
    var checkpointFailure = null;
    // 普通 Judge round durability 与 PLAIN checkpoint 分开排队：观察事件仍同步，IO 只由 paid-request seam 消费。
    var roundDurabilityBarrier = Promise.resolve();
    var roundDurabilityFailure = null;
    function makeAbortError() {
      var ae = new Error('[judge-web] aborted（用户已中止）');
      ae.name = 'AbortError';
      return ae;
    }
    function makeCheckpointError(err) {
      var detail = err && err.message ? String(err.message) : (err ? String(err) : 'persist returned false');
      var ce = new Error('[judge-web] PLAIN checkpoint 持久化失败: ' + detail);
      ce.name = 'CheckpointPersistenceError';
      return ce;
    }
    function makePersistenceError(scope, err) {
      var detail = err && err.message ? String(err.message) : (err ? String(err) : 'persist returned false');
      var pe = new Error('[judge-web] ' + scope + ' 持久化失败: ' + detail);
      pe.name = 'PersistenceError';
      pe.persistenceScope = scope;
      return pe;
    }
    async function persistRequired(step, payload, scope) {
      if (typeof opts.persist !== 'function') return true;
      var ok;
      try { ok = await opts.persist(step, payload); }
      catch (e) { throw makePersistenceError(scope || step, e); }
      if (ok === false) throw makePersistenceError(scope || step, null);
      return true;
    }
    function queueRoundCheckpoint(r) {
      if (typeof opts.persist !== 'function') return;
      roundDurabilityBarrier = roundDurabilityBarrier.then(async function () {
        if (roundDurabilityFailure) return;
        try {
          await persistRequired('round-done', { workDir: workDir, round: r }, 'round checkpoint ' + String(r && r.round || '?'));
        } catch (e) {
          roundDurabilityFailure = e;
        }
      });
    }
    function queueBatchCheckpoint(info) {
      if (typeof opts.persist !== 'function') return;
      checkpointBarrier = checkpointBarrier.then(function () {
        if (checkpointFailure) return;
        var persisted;
        try {
          persisted = opts.persist('plain-batch-checkpoint', {
            workDir: workDir,
            index: info && info.index,
            total: info && info.total,
            cached: !!(info && info.cached),
            cacheDir: info && info.cacheDir,
            phase: info && info.phase,
            file: info && info.file
          });
        } catch (e) {
          checkpointFailure = makeCheckpointError(e);
          return;
        }
        return Promise.resolve(persisted).then(function (ok) {
          if (ok === false) checkpointFailure = makeCheckpointError(null);
        }, function (e) {
          checkpointFailure = makeCheckpointError(e);
        });
      });
    }
    async function durabilityBarrierError() {
      // 所有 paid-request 与 terminal persist 共用同一 durability 汇合点：先等普通轮次，再等 PLAIN/R8 私有 checkpoint。
      // 返回首个已锁定失败而不直接抛出，供异常收口路径仍可尝试写 durable error snapshot。
      await roundDurabilityBarrier;
      await checkpointBarrier;
      return roundDurabilityFailure || checkpointFailure || null;
    }
    async function requireDurability() {
      var de = await durabilityBarrierError();
      if (de) throw de;
    }
    var apiStubWrap = async function (cfg, msgs, o) {
      if (abortSignal && abortSignal.aborted) throw makeAbortError();
      await requireDurability();
      if (abortSignal && abortSignal.aborted) throw makeAbortError();
      var reqOpts = Object.assign({}, o || {});
      if (abortSignal) reqOpts.signal = abortSignal;
      // Web mock 全流程默认也要覆盖独立 R8；runRound 已显式带 mockResponder，R8 调用则由这里补齐。
      // 仅 mock provider 生效，真实 provider 不触及此分支。
      if (cfg && cfg.provider === 'mock' && typeof reqOpts.mockResponder !== 'function') reqOpts.mockResponder = host.goodMockResponder;
      return api.requestCompletion(cfg, msgs, reqOpts);
    };

    // 1) 辩词落位（ASCII 文件名，规避中文路径命令解析问题同款约束）
    var speechPath = newSpeechPath();
    vfs.writeFileSync(speechPath, String(opts.speech || ''));

    // 2) 工作目录：续跑用已有目录；新建走 PC 场次隔离机制（与 CLI 同源）
    var workDir;
    if (opts.resumeDir) {
      workDir = posixOf(opts.resumeDir);
      if (!vfs.existsSync(workDir)) throw new Error('[judge-web] 续跑目录不存在: ' + opts.resumeDir);
      var debate = workDir + '/.tmp-debate.txt';
      if (!vfs.existsSync(debate)) {
        // resume 但无辩词副本：以本次辩词补齐（与 runAll 同语义）
        vfs.copyFileSync(speechPath, debate);
      }
    } else {
      var r = PC.resolveOutputDir(speechPath, null, null);
      workDir = r.dir;
    }
    // 定点续跑失败时需要恢复到“进入本次 runSession 前”的完整内存现场，而不只是恢复被删文件。
    if (targetedResume) resumeEntrySnapshot = vfs.snapshot(workDir + '/');

    // 3) prompt 生成（runAll；与 CLI 同源）
    PC.runAll(speechPath, {
      tendency: tendency.tendencyText(settings.dimWeights || {}, settings.tendencyWeights || {}),
      auto: false,
      force: effectiveForce,
      outputDir: workDir
    });

    // 4) Judge Persona Context 独立按轮注入（严格 normalizer；非法配置 fail closed，绝不 raw fallback）
    appendJudgeContextBlocks(workDir, settings.judgeContext, log);

    // 5) 深度注入
    appendDepthBlocks(workDir, settings.depth, log);

    // 5.5) 定点续跑纯规划：此时本次 prompt 已生成，但尚未 rewind、尚未写新 epoch、尚未进入 paid request。
    if (targetedResume) {
      var resumeProbe = buildRunModel(workDir, { plain: !!settings.plain });
      resumePlan = planResumeStart({ requestedNode: resumeStartNode, runModel: resumeProbe, settings: settings });
      if (!resumePlan.allowed) {
        removeSession(workDir);
        restoreSession(resumeEntrySnapshot || {});
        return { ok: false, semanticOk: null, resumeBlocked: true, error: resumePlan.blockingReason, workDir: workDir, results: [], resumePlan: resumePlan };
      }
      log('[judge-web] 定点续跑计划：请求 ' + resumePlan.requestedNode + ' → 实际起点 ' + resumePlan.effectiveStartNode + '；重算 ' + resumePlan.invalidatedNodes.join('、'));
    }

    // 6) 名册确认（源锚层 v1 浏览器化）
    var anchor = null;
    try { anchor = PC.extractSourceAnchor(vfs.readFileSync(workDir + '/.tmp-debate.txt', 'utf-8')); }
    catch (e) { log('[judge-web] 名册抽取失败（按降级登记继续）: ' + e.message); }
    if (anchor && anchor.extracted) {
      anchor = PC.mergeRosterAliases(anchor, null);
      vfs.writeFileSync(workDir + '/source-anchor.json', JSON.stringify(anchor, null, 2));
      if (!settings.skipRosterConfirm && typeof opts.onRoster === 'function') {
        var decision = await opts.onRoster({ anchor: anchor, workDir: workDir, session: opts });
        if (!decision || decision.action === 'abort') {
          if (targetedResume) { removeSession(workDir); restoreSession(resumeEntrySnapshot || {}); }
          return { ok: false, aborted: true, workDir: workDir, results: [], resumePlan: resumePlan };
        }
        if (decision.action === 'edit') {
          // 编辑名册 JSON → 重抽合并（与 CLI e 处置同语义）+ 重新确认
          try {
            var edited = decision.editedAnchor;
            vfs.writeFileSync(workDir + '/source-anchor.json', JSON.stringify(edited, null, 2));
            var fresh = PC.extractSourceAnchor(vfs.readFileSync(workDir + '/.tmp-debate.txt', 'utf-8'));
            var remerged = PC.mergeRosterAliases(fresh, edited);
            vfs.writeFileSync(workDir + '/source-anchor.json', JSON.stringify(remerged, null, 2));
            vfs.writeFileSync(workDir + '/source-anchor.confirmed', JSON.stringify(
              { by: 'judge-web（编辑重抽）', at: new Date().toISOString(), rosterHash: remerged.rosterHash }, null, 2));
            log('[judge-web] 名册已编辑重抽并确认');
          } catch (e) {
            throw new Error('[judge-web] 名册编辑无效: ' + e.message);
          }
        } else {
          // confirm / skip（skip 与确认等效：写确认标记，断点续跑不再问）
          vfs.writeFileSync(workDir + '/source-anchor.confirmed', JSON.stringify(
            { by: 'judge-web', at: new Date().toISOString(), rosterHash: anchor.rosterHash }, null, 2));
          log('[judge-web] 名册已确认（rosterHash=' + anchor.rosterHash.slice(0, 8) + '…）');
        }
      }
    }

    // 6.5) 受控 rewind：必须在 roster/plan 成功之后、pipeline-start durable BASE 之前完成。
    if (targetedResume) applyResumeRewind(workDir, resumePlan);

    if (typeof opts.persist === 'function') {
      try {
        await persistRequired('pipeline-start', { workDir: workDir, resumePlan: resumePlan }, 'BASE');
      } catch (e) {
        if (targetedResume) { removeSession(workDir); restoreSession(resumeEntrySnapshot || {}); }
        return { ok: false, semanticOk: null, persistenceFailed: true, persistenceError: String(e.message || e), aborted: false, error: String(e.message || e), workDir: workDir, results: [], runModel: null, resumePlan: resumePlan };
      }
    }

    // 7) 管道执行（host-node 同源；skipRosterConfirm=true —— 浏览器确认已在上方完成）
    var cfg = buildApiCfg(settings);
    var mockResponder = settings.provider === 'mock' ? host.goodMockResponder : undefined;
    var onRoundWrap = function (r) {
      if (typeof opts.onRound === 'function') {
        try { opts.onRound(r); } catch (e) {}
      }
      // R7/R8 是后处理投影，不属于 core.ROUNDS，也不能伪装成普通 Judge round checkpoint。
      if (r && r.postprocess) return;
      // C1（260815）：事件源 = 结构化回调（P4 注入）；gate = 非 skipped 且未 ok（runRound 每轮恰一次返回，天然去重）
      // W-T5（E3）：事件采集（同步 push，无异步竞态；每轮 ≤1 次）
      runEvents.push({ t: new Date().toISOString(), round: r.round, ok: !!r.ok, skipped: !!r.skipped, gate: !r.ok && !r.skipped });
      // 持久化仍不阻塞 observer；但下一笔 paid API 与 terminal path 必须等待该独立 durability barrier。
      queueRoundCheckpoint(r);
    };
    var res;
    try {
      res = await host.runPipeline({
        workDir: workDir,
        cfg: cfg,
        mockResponder: mockResponder,
        apiStub: apiStubWrap,
        requestCompletion: apiStubWrap,
        onBatchCheckpoint: function (info) { queueBatchCheckpoint(info); },
        onLog: function (m) { log(m); },   // C1：日志仅人类消费（事件已结构化）
        onRound: onRoundWrap,   // C1：结构化事件（P4 注入回调）
        onStage: function (s) {
          if (typeof opts.onStage === 'function') { try { opts.onStage(s); } catch (e) {} }
        },
        force: effectiveForce,
        plain: !!settings.plain,
        plainReplayOnly: !!(resumePlan && resumePlan.requirePlainCacheHit),
        plainDict: plainDictPath(settings, log),
        skipRosterConfirm: true
      });
      // 最后一批/最后一轮之后可能没有下一笔 API，因此 terminal path 也必须等全部 durability barrier。
      await requireDurability();
    } catch (e) {
      // host 可能在最后一个 round/checkpoint 尚在落盘时先抛出；终态仍需等待这些写入收口。
      var durabilityError = await durabilityBarrierError() || (e && e.name === 'PersistenceError' ? e : null);
      var aborted = !durabilityError && !!e && (e.name === 'AbortError' || /aborted|abort/i.test(String(e.message || '')));
      // W-T5（E5）：中止/异常路径构建 runModel（catch 内 res 未赋值——L277 抛错时保持 undefined，必须 (res && res.results) || []，R7-A1）；
      // 构建外包 try/catch（R12-1：catch 内不得二次抛出——原路径仅带 .catch() 的 persist，异常逃逸语义必须保持）
      var runModel = null;
      try {
        runModel = buildRunModel(workDir, {
          results: (res && res.results) || [],
          events: runEvents,
          derivedStatus: aborted ? 'aborted' : 'failed',
          error: { aborted: aborted, message: String(e.message || e) },
          plain: !!settings.plain
        });
      } catch (e2) { runModel = null; }
      // W-PH：批次档案先写 → persist 快照同帧带出（runModel 可能 null，append 内防御）；新批并入 runModel 重算判定
      attachRunBatch(runModel, appendRunBatch(workDir, runModel, runEvents));
      var terminalPersistenceError = durabilityError;
      if (typeof opts.persist === 'function') {
        try {
          await persistRequired('pipeline-error', { workDir: workDir, error: String(e.message || e), aborted: aborted, runModel: runModel }, 'FINAL/error snapshot');
        } catch (pe) {
          terminalPersistenceError = terminalPersistenceError || pe;
        }
      }
      return {
        ok: false,
        semanticOk: durabilityError ? null : false,
        persistenceFailed: !!terminalPersistenceError,
        persistenceError: terminalPersistenceError ? String(terminalPersistenceError.message || terminalPersistenceError) : null,
        aborted: aborted,
        error: String((durabilityError || e) && (durabilityError || e).message || durabilityError || e),
        workDir: workDir, results: [], runModel: runModel, resumePlan: resumePlan
      };
    }

    // 8) 可选 R8 读者章节导览：只在主裁决完整成功后执行，仍保持独立后处理 seam。
    // UI 默认 readerGuide=true；engine 本身只认显式 true，避免改变 CLI/独立调用方的既有默认。
    var readerGuideApplied = false;
    if (res && res.ok && settings.readerGuide === true) {
      try {
        if (abortSignal && abortSignal.aborted) throw makeAbortError();
        // mock R6b 历史上是轻量手写 HTML；R8 需要正式报告的 plain-toggle runtime。
        // plain=true 时 applyPlain 已完成该迁移；plain=false 时先用现有机械 renderer 生成正式同形报告。
        if (cfg.provider === 'mock' && !settings.plain) {
          host.renderReport(workDir);
          var mockAdjData = workDir + '/.tmp-adjudicated-data.md';
          var mockDisclaimer = false;
          try {
            mockDisclaimer = JSON.parse(vfs.readFileSync(workDir + '/source-anchor.json', 'utf-8')).disclaimer === true;
          } catch (mockSaErr) {}
          var mockHv = PC.checkHtml(workDir + '/report.html', {
            stage: 'final',
            skillPath: '/Skill-Judge.md',
            dataSource: vfs.existsSync(mockAdjData) ? mockAdjData : workDir + '/transition-final.md',
            disclaimer: mockDisclaimer
          });
          if (mockHv.blocking && mockHv.blocking.length) {
            throw new Error('[judge-web] mock R8 前机械报告未通过正式 final gate: ' + mockHv.blocking.map(function (x) { return x.message; }).join('; '));
          }
          log('[judge-web] mock R8 前已机械重建正式同形 report.html，并通过 final gate');
        }
        log('[judge-web] 主裁决完成，开始 R8 章节导览（独立后处理）');
        if (typeof opts.onStage === 'function') { try { opts.onStage({ stage: 'R8', state: 'active', postprocess: true }); } catch (e) {} }
        await host.applyReaderGuide(workDir, cfg, function (m) { log(m); }, {
          cache: !effectiveForce,
          requestCompletion: apiStubWrap,
          onBatchCheckpoint: function (info) { queueBatchCheckpoint(info); }
        });
        readerGuideApplied = true;
        if (typeof opts.onStage === 'function') { try { opts.onStage({ stage: 'R8', state: 'done', postprocess: true }); } catch (e) {} }
      } catch (r8e) {
        if (typeof opts.onStage === 'function') { try { opts.onStage({ stage: 'R8', state: 'fail', postprocess: true, errors: [String(r8e && r8e.message || r8e)] }); } catch (e) {} }
        // R8 也属于 terminal path：即使它在最后一个私有 checkpoint 后、下一笔 API 前失败，
        // 也必须先等该 checkpoint 真正 durable，再写 FINAL/error，避免迟到 #RZZR8 把终态覆盖回 running。
        var r8DurabilityError = await durabilityBarrierError() || (r8e && r8e.name === 'PersistenceError' ? r8e : null);
        var r8Aborted = !r8DurabilityError && !!r8e && (r8e.name === 'AbortError' || /aborted|abort/i.test(String(r8e.message || '')));
        var r8RunModel = null;
        try {
          r8RunModel = buildRunModel(workDir, {
            results: res.results || [],
            events: runEvents,
            derivedStatus: r8Aborted ? 'aborted' : 'failed',
            error: { aborted: r8Aborted, postprocess: 'R8', message: String(r8e.message || r8e) },
            plain: !!settings.plain
          });
        } catch (r8m) { r8RunModel = null; }
        attachRunBatch(r8RunModel, appendRunBatch(workDir, r8RunModel, runEvents));
        var r8PersistenceError = r8DurabilityError;
        if (typeof opts.persist === 'function') {
          try {
            await persistRequired('pipeline-error', {
              workDir: workDir,
              error: String(r8e.message || r8e),
              aborted: r8Aborted,
              postprocess: 'R8',
              semanticOk: true,
              runModel: r8RunModel
            }, 'FINAL/R8 postprocess');
          } catch (r8pe) { r8PersistenceError = r8PersistenceError || r8pe; }
        }
        var baseReport = readReportHtml(workDir);
        var basePlain = vfs.existsSync(workDir + '/report-plain.html') ? vfs.readFileSync(workDir + '/report-plain.html', 'utf-8') : null;
        return {
          ok: false,
          semanticOk: true,
          postprocessFailed: true,
          readerGuideFailed: true,
          readerGuideApplied: false,
          persistenceFailed: !!r8PersistenceError,
          persistenceError: r8PersistenceError ? String(r8PersistenceError.message || r8PersistenceError) : null,
          error: String((r8PersistenceError || r8e) && (r8PersistenceError || r8e).message || r8PersistenceError || r8e),
          aborted: r8Aborted,
          workDir: workDir,
          results: res.results || [],
          reportHtml: baseReport,
          reportPlain: basePlain,
          reportFile: settings.plain && basePlain ? 'report-plain.html' : 'report.html',
          runModel: r8RunModel,
          resumePlan: resumePlan
        };
      }
    }

    // 9) 产物读取——R8 开启时必须在其机械嵌入之后读取，保证返回/持久化的是最终 report。
    var reportHtml = readReportHtml(workDir);   // C4（A9）：同构直读收敛（report-plain 无对应方法保持原样）
    var reportPlain = vfs.existsSync(workDir + '/report-plain.html') ? vfs.readFileSync(workDir + '/report-plain.html', 'utf-8') : null;

    // W-T5（E4）：终态 runModel（正常 + 门禁耗尽失败两路径均经此——engine L313-315 在 !res.ok 时也调 persist('pipeline-done')，R7-A2）；
    // 构建外包 try/catch（R12-1：附加品失败 → null → 钩子不写 rec.run，D1 迁移兜底自然覆盖，不改主流程异常逃逸）
    var runModel = null;
    try {
      runModel = buildRunModel(workDir, {
        results: res.results,
        events: runEvents,
        derivedStatus: res.ok ? 'done' : 'failed',
        plain: !!settings.plain
      });
    } catch (e) { runModel = null; }

    // W-PH：批次档案先写 → persist 快照同帧带出；新批并入 runModel 重算判定
    attachRunBatch(runModel, appendRunBatch(workDir, runModel, runEvents));

    var semanticFailure = res && !res.ok ? firstFailedResult(res.results || []) : null;
    var semanticError = semanticFailure
      ? ((semanticFailure.errors && semanticFailure.errors.length) ? semanticFailure.errors.join('; ') : (semanticFailure.round + ' 失败'))
      : undefined;
    var finalPersistenceError = null;
    if (typeof opts.persist === 'function') {
      try {
        // W-T1/R8：FINAL 必须排在所有 durability checkpoint 之后。最后一笔 R8 私有 checkpoint
        // 后可能没有下一笔 API 来触发 apiStubWrap barrier，因此终态提交本身也走统一 durability 汇合点。
        await requireDurability();
        await persistRequired('pipeline-done', { workDir: workDir, ok: !!res.ok, runModel: runModel }, 'FINAL');
      } catch (pe) {
        finalPersistenceError = pe;
      }
    }
    return {
      ok: !!res.ok && !finalPersistenceError,
      semanticOk: !!res.ok,
      persistenceFailed: !!finalPersistenceError,
      persistenceError: finalPersistenceError ? String(finalPersistenceError.message || finalPersistenceError) : null,
      error: finalPersistenceError ? String(finalPersistenceError.message || finalPersistenceError) : semanticError,
      aborted: false,
      workDir: workDir,
      results: res.results || [],
      reportHtml: reportHtml,
      reportPlain: reportPlain,
      reportFile: settings.plain && reportPlain ? 'report-plain.html' : 'report.html',
      readerGuideApplied: readerGuideApplied,
      resumePlan: resumePlan,
      runModel: runModel   // W-T5：终态 run 模型（F10 双通道：payload 附带 + return 附带）
    };
  }

  function posixOf(p) {
    return String(p).replace(/\\/g, '/');
  }

  // ---------- W-T5：结构化 run 模型（UI 投影层 · 只读） ----------
  // 核心纯函数：零 VFS 依赖，只认 files 字典（vfs.snapshot(workDir+'/') 与 rec.files 同构，§二.3 数据源同构）。
  // 断点内容级预估复用内核同一函数 core.isArtifactUsable（纯函数，同函数同语义；不含 validateRound——投影不可复现，非权威，仅预估）。
  // opts: { results, events, derivedStatus, error, plain }（results 未传 → 降级派生，R16-1）
  function buildRunModelFromFiles(workDir, files, opts) {
    opts = opts || {};
    files = files || {};
    var base = posixOf(workDir).replace(/\/+$/, '');   // R9-1：去尾斜杠防双斜杠键失配
    var results = opts.results || null;
    var byRound = {};
    if (results) {
      for (var i = 0; i < results.length; i++) byRound[results[i].round] = results[i];
    }
    var events = opts.events || [];
    var gateByRound = {};
    for (var j = 0; j < events.length; j++) {
      var ev = events[j];
      if (ev && ev.gate) gateByRound[ev.round] = true;
    }
    var rounds = [];
    for (var k = 0; k < core.ROUNDS.length; k++) {
      var round = core.ROUNDS[k];
      var pk = base + '/' + round.promptFile;
      var okPath = base + '/' + round.outFile;
      // promptHash：终态 prompt 内容 SHA256 前 16 位（含运行期注入，D5）；文件缺失 → null（R3-5 容错）
      var promptHash = null;
      if (files[pk] !== undefined && files[pk] !== null) {
        promptHash = bundle.sha256Hex(String(files[pk])).slice(0, 16);
      }
      // artifact：outFile 产物（存在才哈希）；precheckSkippable = 内容级预估（R2-4 独立字段，不进徽章状态）
      var artifact = { exists: false, sha256: null, bytes: null };
      var precheckSkippable = false;
      if (files[okPath] !== undefined && files[okPath] !== null) {
        var content = String(files[okPath]);
        artifact = { exists: true, sha256: bundle.sha256Hex(content).slice(0, 16), bytes: bundle.byteLen(content) };
        precheckSkippable = core.isArtifactUsable(round.name, content);
      }
      // attemptFiles：.attempt* 留档数（递增探测，连续写——缺失即停，F3）；仅导出字段
      var attemptFiles = 0;
      for (var n = 1; ; n++) {
        if (files[okPath + '.attempt' + n] !== undefined && files[okPath + '.attempt' + n] !== null) attemptFiles = n;
        else break;
      }
      // rounds[].status 双轨派生（R16-1）：results 传入 → 终态 results；未传（迁移/导出）→ 降级（产物可用近似完成）
      var status, attempts = null, errors = [];
      var res = byRound[round.name];
      if (res) {
        status = res.ok && res.skipped ? 'skipped' : res.ok ? 'done' : 'fail';
        if (res.attempt !== undefined && res.attempt !== null) attempts = res.attempt;
        errors = res.errors || [];
      } else if (results) {
        status = 'pending';
      } else {
        status = (artifact.exists && precheckSkippable) ? 'done' : 'pending';
      }
      rounds.push({
        round: round.name,
        promptFile: round.promptFile,
        outFile: round.outFile,
        status: status,
        attempts: attempts,
        attemptFiles: attemptFiles,
        gateHit: !!gateByRound[round.name],   // R11-2：去重口径 bool（events 该轮 gate:true 是否存在），非计数
        errors: errors,
        promptHash: promptHash,
        artifact: artifact,
        precheckSkippable: precheckSkippable
      });
    }
    var summary = {
      done: 0, skipped: 0, fail: 0, pending: 0,
      totalAttempts: 0, totalGateHits: 0,
      derivedStatus: opts.derivedStatus || 'pending',   // 防御保留值（R16-5：persist 时点规则表无可达路径）
      reportReady: false,
      plain: !!opts.plain,
      precheckSkipCount: 0
    };
    var r6b = null;
    for (var m = 0; m < rounds.length; m++) {
      var rr = rounds[m];
      summary[rr.status] = (summary[rr.status] || 0) + 1;
      if (rr.attempts !== null && rr.attempts !== undefined) summary.totalAttempts += rr.attempts;
      if (rr.gateHit) summary.totalGateHits++;
      // R8-A5：仅统计「未完成（pending/fail）且产物可续」的轮数；done/skipped 轮不计数
      if ((rr.status === 'pending' || rr.status === 'fail') && rr.precheckSkippable) summary.precheckSkipCount++;
      if (rr.round === 'R6b') r6b = rr;
    }
    summary.reportReady = !!(r6b && r6b.artifact.exists);   // R13-1：由 R6b 轮 artifact.exists 派生
    // W-PH：批次档案解析（缺失/损坏 → [] 容错）+ 轮级失配判定 + 计数
    var batches = [];
    var bp = base + '/.tmp-run-batches.json';
    if (files[bp] !== undefined && files[bp] !== null) {
      try {
        var parsedB = JSON.parse(String(files[bp]));
        if (parsedB && Array.isArray(parsedB.batches)) batches = parsedB.batches;
      } catch (e) { batches = []; }
    }
    var staleRounds = computeStaleRounds(rounds, batches);
    var staleCount = 0;
    for (var sk in staleRounds) { if (staleRounds[sk]) staleCount++; }
    summary.staleCount = staleCount;
    var model = {
      schema: 'judge-web-run-v1',
      generatedAt: new Date().toISOString(),   // R14-1：全量构建时点
      workDir: base,
      rounds: rounds,
      events: events,
      batches: batches,          // W-PH：批次档案（随 files 快照同构读入）
      staleRounds: staleRounds,  // W-PH：失配轮映射 { R1: true }
      summary: summary
    };
    if (opts.error) model.error = opts.error;   // R16-3：仅 pipeline-error 时点落盘，其余缺省不写
    return model;
  }

  // 运行中/报告页直读路径：VFS 快照字典 → 委托纯函数（E2；R11-1：base 归一——snapshot 精确前缀匹配，尾斜杠 → '//' 前缀失配返回空模型）
  function buildRunModel(workDir, opts) {
    opts = opts || {};
    var base = posixOf(workDir).replace(/\/+$/, '');
    return buildRunModelFromFiles(base, vfs.snapshot(base + '/'), opts);
  }

  // ---------- 会话产物快照（持久化/导出用） ----------
  function snapshotSession(workDir, extraPrefixes) {
    var files = vfs.snapshot(workDir + '/');
    if (extraPrefixes) {
      for (var i = 0; i < extraPrefixes.length; i++) {
        var part = vfs.snapshot(extraPrefixes[i] + '/');
        for (var k in part) files[k] = part[k];
      }
    }
    return files;
  }

  function restoreSession(files) {
    vfs.restore(files);
  }

  function removeSession(workDir) {
    vfs.removeTree(String(workDir).replace(/\\/g, '/'));
  }

  // C4（260815）：vfs 直读收窄——UI 只调方法，不认知 VFS 路径约定（原 ui.js 直读旁路）
  // 契约：缺失 → null；存在即返回内容（可为空串——调用方以 !== null 判定存在性）
  function readReportHtml(workDir) {
    var base = posixOf(workDir);
    return vfs.existsSync(base + '/report.html') ? vfs.readFileSync(base + '/report.html', 'utf-8') : null;
  }
  // 历史记录外围恢复 seam：基础兼容入口，仅机械重渲染 R6 report。
  function rerenderReport(workDir) {
    var base = posixOf(workDir);
    host.renderReport(base);
    return readReportHtml(base);
  }

  // 历史“重新出报告”完整四组合 seam：唯一配置真值是该历史 session 的 settings。
  // 固定顺序 = R6 base → approved PLAIN（可选）→ verified R8（可选）；
  // 不进入 runSession/fetch/API，PLAIN 模型路径由 host 内部 0-API fuse 封死。
  async function rebuildHistoricalReport(workDir, historicalSettings) {
    var base = posixOf(workDir);
    var saved = historicalSettings && typeof historicalSettings === 'object' ? historicalSettings : {};
    try {
      host.renderReport(base);
      if (saved.plain === true) {
        var plainCfg = buildApiCfg(Object.assign({}, saved, { apiKey: '' }));
        var dictPath = plainDictPath(saved, function () {});
        await host.rebuildApprovedPlainReport(base, plainCfg, dictPath);
      }
      if (saved.readerGuide === true) host.embedVerifiedReaderGuide(base);
      var html = readReportHtml(base);
      if (!html) throw new Error('机械链未生成 report.html');
      return { html: html, plainApplied: saved.plain === true, readerGuideApplied: saved.readerGuide === true };
    } catch (e) {
      throw new Error('[judge-web] 无法完整重建历史报告：' + (e && e.message ? e.message : String(e)));
    }
  }
  function readDebateCopy(workDir) {
    var base = posixOf(workDir);
    return vfs.existsSync(base + '/.tmp-debate.txt') ? vfs.readFileSync(base + '/.tmp-debate.txt', 'utf-8') : null;
  }

  return {
    runSession: runSession,
    snapshotSession: snapshotSession,
    restoreSession: restoreSession,
    removeSession: removeSession,
    buildRunModel: buildRunModel,                 // W-T5（E6）
    buildRunModelFromFiles: buildRunModelFromFiles,   // W-T5（E6）
    computeStaleRounds: computeStaleRounds,       // W-PH（纯函数导出，单测直调）
    resumeNodeOrder: PC.resumeNodeOrder,           // Web/UI 节点列表与 CLI/Skill 共用 pipeline-controller 单一事实源
    planResumeStart: planResumeStart,              // 指定节点续跑：共享依赖图 planner，不读写 VFS
    resumeInvalidationFiles: resumeInvalidationFiles,
    applyResumeRewind: applyResumeRewind,
    vfs: vfs,
    buildThinkingExtra: buildThinkingExtra,
    readReportHtml: readReportHtml,               // C4：直读收窄（UI 入口）
    rerenderReport: rerenderReport,               // 历史记录：基础 R6 兼容入口
    rebuildHistoricalReport: rebuildHistoricalReport, // 历史记录：按历史 settings 四组合 0-API 完整机械重建
    readDebateCopy: readDebateCopy                // C4：直读收窄（UI 入口）
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { createEngine };
}
