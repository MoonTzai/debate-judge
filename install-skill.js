// Debate-Judge 单文件交付安装器（C10b 闭环）
// 从 Skill-Judge.md 提取全部内嵌块（PIPELINE_CONTROLLER + RENDER_REPORT + RENDER_TABLES + 10 资产/schema，含 input-contract/adjudication），
// 重建核心工作区，并把"轻量壳"安装到 Codex skills 目录，使新会话可通过技能名自动加载。
//
// 用法：
//   node install-skill.js                        # 默认：提取 ./work-omega1-extracted + 安装轻量壳
//   node install-skill.js --skill <路径>          # 指定权威文件（默认脚本同目录 Skill-Judge.md）
//   node install-skill.js --work <目录>           # 指定提取目录
//   node install-skill.js --codex-skills <目录>   # 指定 Codex skills 根目录
//   node install-skill.js --verify-only          # 只校验内嵌完整性与 JS 语法，不落盘
//   node install-skill.js --uninstall            # 卸载轻量壳（删除 skills/debate-judge 目录）
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');

const SCRIPT_DIR = __dirname;

const BLOCKS = [
  { name: 'PIPELINE_CONTROLLER', file: 'pipeline-controller.js', lang: 'javascript' },
  { name: 'RENDER_REPORT', file: 'render-report.js', lang: 'javascript' },
  { name: 'RENDER_TABLES', file: 'render-tables.js', lang: 'javascript' },
  { name: 'CSS', file: 'assets/report.css', lang: 'css' },
  { name: 'SKELETON', file: 'assets/skeleton.html', lang: 'html' },
  { name: 'CHARTS_CONSTANTS', file: 'assets/charts-constants.js', lang: 'javascript' },
  // A8-P4：执行域按 D2 拆分 + 自安装器（闭包条目由 BLOCKS 单一清单派生）
  { name: 'EXECUTOR_CORE', file: 'executor/core.js', lang: 'javascript' },
  // Wayfinder frozen A59 narrow runtime control plane: shared Node/Web, no production authority cutover by itself.
  { name: 'WAYFINDER_RUNTIME', file: 'executor/wayfinder-runtime.js', lang: 'javascript', semantic_core: true, module_id: 'SEMCORE::WAYFINDER_NODE_COMMIT_TYPE_RESOLUTION_ABI_V1' },
  { name: 'EXECUTOR_HOST_NODE', file: 'executor/host-node.js', lang: 'javascript' },
  { name: 'EXECUTOR_CODEX_CLI', file: 'executor/codex-cli.js', lang: 'javascript' },
  { name: 'EXECUTOR_BROWSER', file: 'executor/browser.js', lang: 'javascript' },
  // 卡 6（260815）：产物契约模块（parseInputs 单一契约输入层——PC/RR/前端消费）
  { name: 'EXECUTOR_CONTRACT', file: 'executor/contract.js', lang: 'javascript' },
  // 卡 1（260816）：校验器簇独立模块（validate 单一接口——PC 委托消费）
  { name: 'EXECUTOR_VALIDATOR', file: 'executor/validator.js', lang: 'javascript' },
  { name: 'API_PROVIDER', file: 'executor/api-provider.js', lang: 'javascript' },
  { name: 'INSTALLER', file: 'install-skill.js', lang: 'javascript' },
  { name: 'PLAIN_LANGUAGE', file: 'scripts/plain-language.js', lang: 'javascript' },
  { name: 'PLAIN_COMPREHENSION', file: 'scripts/plain-comprehension.js', lang: 'javascript' },
  { name: 'READER_GUIDE', file: 'scripts/reader-guide.js', lang: 'javascript' },
  { name: 'JUDGE_RUN_SETTINGS', file: 'scripts/judge-run-settings.js', lang: 'javascript' },
  { name: 'PLAIN_DICT', file: 'assets/plain-dict.json', lang: 'json' },
  { name: 'HTML_CONTRACT', file: 'scripts/html-contract.js', lang: 'javascript' },
  // 卡 5（260815）：键形提取单一引擎（key-checker/gic 双消费）
  { name: 'KEY_EXTRACT', file: 'scripts/key-extract.js', lang: 'javascript' }
].concat(
  ['criteria', 'index', 'model-snapshot', 'presentation', 'tendency'].map(s => ({
    name: 'SCHEMA_' + s.toUpperCase().replace(/-/g, '_'),
    file: 'schemas/' + s + '.schema.json',
    lang: 'json'
  })),
  { name: 'SCHEMA_INPUT_CONTRACT', file: 'schemas/input-contract.json', lang: 'json' },
  { name: 'SCHEMA_ADJUDICATION', file: 'schemas/adjudication.schema.json', lang: 'json' },
  { name: 'SCHEMA_READER_GUIDE', file: 'schemas/reader-guide.schema.json', lang: 'json' }
);

function extractBlock(content, name) {
  if (name === 'PIPELINE_CONTROLLER') {
    // A8-P4 修复：拆串，避免 INSTALLER 内嵌后自引用歧义
    const m = content.match(new RegExp('<!-- PIPELINE_CONTROLLER_' + 'START -->\\s*```javascript\\s*([\\s\\S]*?)\\s*```\\s*<!-- PIPELINE_CONTROLLER_' + 'END -->'));
    return m ? m[1].trim() : null;
  }
  const re = new RegExp('<!-- EMBED_ASSET:' + name + '_START -->\\s*```(?:css|html|javascript|json)\\s*([\\s\\S]*?)\\s*```\\s*<!-- EMBED_ASSET:' + name + '_END -->');
  const m = content.match(re);
  return m ? m[1].trim() : null;
}

function parseArgs(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };
  return {
    skill: get('--skill') || path.join(SCRIPT_DIR, 'Skill-Judge.md'),
    work: get('--work') || path.join(SCRIPT_DIR, 'work-omega1-extracted'),
    codexSkills: get('--codex-skills') || (process.env.CODEX_HOME
      ? path.join(process.env.CODEX_HOME, 'skills')
      : path.join(os.homedir(), '.codex', 'skills')),
    verifyOnly: argv.includes('--verify-only'),
    uninstall: argv.includes('--uninstall')
  };
}

function readSkill(p) {
  if (!fs.existsSync(p)) throw new Error('权威文件不存在: ' + p);
  return fs.readFileSync(p, 'utf-8').replace(/\r\n/g, '\n');
}

function verify(content, workDir) {
  const errors = [];
  const extracted = {};
  const tmpBase = workDir || fs.mkdtempSync(path.join(os.tmpdir(), 'dj-verify-'));
  // A8-P4：EMBED_ASSET_LIST 构建期硬编码校验（install-skill.js 只读取不生成）
  // A8-P4 修复：取文件尾部标记（lastIndexOf），避免命中头部协议引用或本源码内嵌副本
  const listHead = content.lastIndexOf('<!-- EMBED_ASSET_LIST -->');
  const listMatch = listHead >= 0 ? content.slice(listHead).match(/<!-- EMBED_ASSET_LIST -->\s*```\s*([\s\S]*?)\s*```\s*<!-- \/EMBED_ASSET_LIST -->/) : null;
  if (!listMatch) {
    errors.push('EMBED_ASSET_LIST 标记缺失（构建期硬编码，install-skill.js 不生成）');
  } else {
    const listed = listMatch[1].split(/\r?\n/).map(s => s.trim()).filter(Boolean)
      .filter(s => /^[A-Z0-9_]+$/.test(s));
    const blockNames = BLOCKS.map(b => b.name);
    const sorted = a => a.slice().sort();
    if (sorted(listed).join('|') !== sorted(blockNames).join('|')) {
      errors.push('EMBED_ASSET_LIST 与 BLOCKS 不一致（清单=' + listed.length + ' 块 · BLOCKS=' + blockNames.length + ' 块）');
    }
  }
  for (const b of BLOCKS) {
    const code = extractBlock(content, b.name);
    if (code === null) { errors.push('内嵌块缺失: ' + b.name); continue; }
    extracted[b.name] = code;
    // 与源文件逐字对比（源文件存在时）
    const srcFile = path.join(SCRIPT_DIR, b.file);
    if (fs.existsSync(srcFile)) {
      const src = fs.readFileSync(srcFile, 'utf-8').replace(/\r\n/g, '\n').trim();
      if (code !== src) errors.push('内嵌与文件不一致: ' + b.name + '（先运行 node scripts/embed-assets.js）');
    }
    // JS 语法 / JSON 可解析
    if (b.lang === 'json') {
      try { JSON.parse(code); } catch (e) { errors.push('schema 解析失败: ' + b.name + ' ' + e.message); }
    } else if (b.lang === 'javascript') {
      const tmp = path.join(tmpBase, '.verify-' + b.name + '.js');
      try {
        fs.mkdirSync(path.dirname(tmp), { recursive: true });
        fs.writeFileSync(tmp, code, 'utf-8');
        execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' });
      } catch (e) {
        errors.push('JS 语法失败: ' + b.name + ' ' + String(e.stdout || e.message).slice(0, 200));
      } finally {
        try { fs.unlinkSync(tmp); } catch (e) { /* 忽略 */ }
      }
    }
  }
  // A8-ERR-1 C7：版本哨兵——内嵌 render-report 必须含 A8 标记，否则判定旧版残留（防 F7 重演）
  const A8_SENTINELS = ['injectChart', 'normalizeStructure', 'CHART_MAXWIDTH'];
  for (const s of A8_SENTINELS) {
    if (!(extracted.RENDER_REPORT || '').includes(s)) {
      errors.push('⚠️ 内嵌 render-report 缺 A8 标记: ' + s + '（工作区版本与源不一致），请重装 node install-skill.js');
    }
  }
  // A8-ERR-1：轻量壳模板自检（龙猫启动协议 + 场次隔离关键词必须在安装产物中）
  const shellProbe = shellTemplate('PROBE', 'PROBE');
  if (!shellProbe.includes('▄▄▄▄▄') || !shellProbe.includes('⚖️ 辩论裁判 V' + '1.0 已就绪')) {
    errors.push('轻量壳模板缺龙猫启动协议');
  }
  if (!shellProbe.includes('非法目录格式，请使用时间戳目录') || !shellProbe.includes('禁止跨场次复用')) {
    errors.push('轻量壳模板缺场次隔离自检');
  }
  if (!shellProbe.includes('RESUME-NODE-PROTOCOL') || !shellProbe.includes('pipeline resume-plan') || !shellProbe.includes('--resume-from')) {
    errors.push('轻量壳模板缺定点续跑发现/规划/执行协议');
  }
  if (shellProbe.includes('如需重跑某个轮次，先删除该轮产物文件')) {
    errors.push('轻量壳模板仍含已废弃的手删产物续跑协议');
  }
  return { ok: errors.length === 0, errors, extracted };
}

function writeWorkspace(extracted, workDir, skillSource) {
  for (const b of BLOCKS) {
    const out = path.join(workDir, b.file);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, extracted[b.name] + '\n', 'utf-8');
  }
  // 管道运行时按 __dirname + '/Skill-Judge.md' 读取规则文件——权威文件必须随提取工作区落地，
  // 否则"仅交付 Skill-Judge.md + install-skill.js"无法直接运行管道。
  fs.copyFileSync(skillSource, path.join(workDir, 'Skill-Judge.md'));
}

function shellTemplate(skillPath, workDir) {
  return `---
name: debate-judge
description: 辩论裁判 Debate-Judge V1.0。当用户提供辩论赛辩词（粘贴文本或文件路径）要求裁判，或提及 Skill-Judge、辩论筑基、三维度六向度、结构性交锋、主线类型（C2/C3）等裁判概念时使用。收到辩词后直接进入裁判流程，按需从权威文件切片加载规则，禁止全文载入。
version: 1.1.0
license: MIT
---

# Debate-Judge 裁判技能

## 唯一运行协议（强制）

本安装壳不维护轮次拓扑、Prompt 输入图、R7/R8 细节或续跑依赖表。运行前必须读取提取工作区 Skill-Judge.md 中 AGENT_RUNTIME_PROTOCOL_START 到 AGENT_RUNTIME_PROTOCOL_END 的现役唯一协议，并严格按该区块执行。若本壳其它历史说明与 canonical protocol 冲突，以 canonical protocol 为准。禁止依赖项目开发目录中的 AGENTS/Upload 文件。

## 启动协议（用户界面文案）

当本技能被加载（用户发送「加载裁判AI」或提及 debate-judge）时，**必须立即在第一条回复中逐字输出以下完整欢迎消息（含龙猫 ASCII Logo，不得跳过、不得改写）**，然后等待辩词：

        ▄▄▄▄▄         ▄▄▄▄▄
       █     █       █     █
      █       █     █       █
     █         █▄▄▄█         █
    █           ▓▓▓▓          █
    █            ▓▓           █
    █                         █
    █        ●         ●      █
    █                         █
    █                         █
    █                         █
    █                         █
     █                       █
      █  █▀▀▀█       █▀▀▀█  █
       ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀

      辩 论 筑 基 · 精 靈 M O O N
      D E B A T E - J U D G E

⚖️ 辩论裁判 V${'1.0'} 已就绪。

请提供需要裁判的辩论赛辩词文本（逐字稿或完整场记的文件路径）。

> 💡 裁判倾向说明：本裁判默认以三轴中立进行分析。系统会根据比赛内容自动推断最匹配的倾向（卫道者/问道者/批判者/审判者/技术者/艺术者），报告中以第一人称"我"自述。如需主动声明倾向入场，可在提供辩词时指定。可选倾向及详情可输入「裁判倾向说明」查询。

## 裁判流程（主用途·收到辩词即执行）

1. **要辩词**：如果用户尚未提供辩词，只做一件事——请用户提供辩词（粘贴文本或文件路径）。**不要主动汇报项目状态或待办批次。**
2. **保存辩词**：用户给文件路径 → 直接使用；用户粘贴文本 → 用 Write 工具写入 \`${workDir}/.tmp-debate-input.txt\`。
3. **自动执行完整真实管道（唯一方式，不询问、不降级）**：运行 \`node ${workDir}/pipeline-controller.js pipeline run <辩词文件> --provider auto --force\`。执行器将：自动探测可用 API 凭据（\`auto\`：ANTHROPIC_* 兼容端点 → OPENAI_* 兼容端点，均无则报错停止）→ 自动新建唯一时间戳输出目录（场次隔离）→ 核心执行拓扑由 canonical Runtime Protocol 与现役执行器唯一决定；本壳不复制轮次图、Prompt 注入图或门禁细节。**API 手动设置**（三种方式，优先级从高到低）：① 报告页 \`⚙️ API 配置\` 面板保存并导出 \`.api-config.json\` → 放入输出目录或 \`--api-config <file>\` 指定；② 环境变量 \`ANTHROPIC_*\`/\`OPENAI_*\`/\`EXECUTOR_*\`；③ 显式 \`--provider\`/\`EXECUTOR_PROVIDER\` 覆盖。
   > **中断恢复（A8-ERR-1）**：若管道中断（外壳超时/进程被杀）且已有时间戳场次目录（含已通过轮次产物），**禁止用 --force 重跑全部**；普通恢复使用：\`node ${workDir}/pipeline-controller.js pipeline run <辩词文件> --provider auto --output-dir <已有时间戳目录>\`（不带 --force），由正式门禁跳过可复用轮次。
   >
   > **RESUME-NODE-PROTOCOL v1（Agent 强制）**：当用户要求“从 Rn / 某环节 / 某节点重新续跑”时，**禁止手动删除 P*.md、structure、report、PLAIN 或 R8 文件，禁止自行猜依赖**。先执行只读规划：\`node ${workDir}/pipeline-controller.js pipeline resume-plan --output-dir <已有时间戳目录> --from <R1|R2|R2.5|R3|R4|R4.5|R5A|R5B|R6|R7|R8>\`。读取 JSON 的 \`allowed / effectiveStartNode / invalidatedNodes / preservedNodes / staleExpansion / requirePlainCacheHit\`；只有 \`allowed=true\` 才执行：\`node ${workDir}/pipeline-controller.js pipeline run <已有目录>/.tmp-debate.txt --provider auto --output-dir <已有时间戳目录> --resume-from <同一节点>\`，按原场次需要保留 \`--plain\` / \`--reader-guide\`。非 auto 定点续跑由 Judge **先创建 .resume-versions 只读旧终态快照，再 rewind，再进入唯一原管道**；快照失败即 fail-close、不得调用 API。R6a/R6b 对用户统一称 R6；R2/R2.5 与 R5A/R5B 是兄弟节点，实际重算范围永远以 planner JSON 为准。
4. **报告输出**：管道完成后读取输出目录（pipeline run 返回的 dir）中的 \`report.html\` 与 \`transition-final.md\`/\`叙事.md\`/\`structure.json\`；输出结构化判决摘要（胜方/比分/判准/六向度/主线类型/关键交锋，引用产物 DATA）与报告文件路径。**禁止**在单会话内直接按 S1–S17 输出判决代替管道。

## 执行模型（强制 · 实测教训 2026-08-04）

**场次隔离自检（A8-ERR-1 新增 · 机械执行）**：
1. 输出目录必须是 \`Output/judge-YYMMDD.HHMMSS[-<辩题>]\` 格式（时间戳到秒）；若为 \`judge-YYYYMMDD-<辩题>\`（无 .HHMMSS）或其它格式 → 阻断并报错“非法目录格式，请使用时间戳目录”。
2. 每次裁判/生成报告必须新建唯一输出目录；若当前输出目录在本次会话开始前已存在 → 阻断并报错“禁止跨场次复用”（仅用户显式指定 \`--output-dir\`/\`--out-dir\` 时允许读取既有产物）。
3. 禁止扫描 \`Output/\` 或 \`archive/\` 查找/复用旧产物（旧 transition/叙事/structure）；\`archive/\` 仅供人工追溯，执行器自动流程一律不读取（仅用户显式 \`--output-dir\` 指向时允许）。
4. 生成完整报告时，必须在本轮新目录中产出本次中间文件后再渲染；不得复制旧目录产物。

- **裁判 = 完整真实的全流程全轮次管道（唯一方式）**：核心执行拓扑、产物图与后处理阶段以 canonical Runtime Protocol 与现役执行器为唯一权威，本壳不维护第二份拓扑。执行入口：\`node pipeline-controller.js pipeline run <辩词> --provider auto\`（executor 每轮使用独立上下文并逐轮独立 API 调用；auto 按环境探测 ANTHROPIC_*/OPENAI_*，可被显式 provider 覆盖）。
- **⛔ 禁止单会话直接裁判**：Codex/任何 Agent 不得在单个会话里“直接按 S1–S17 分析并输出判决”来代替八轮管道；不得把辩词分段总结后裁判。没有可用执行器（API 未配置/未授权）时，**明确告知“当前环境无法执行完整管道”并停止，禁止降级冒充**。
- **以管道产物为准，禁止自行校准**：任何展示/报告（判决摘要、比分、主线类型、六向度）一律取自管道产物（transition-final/叙事/structure/report 的 DATA），不得由执行者凭对话印象“校准”或改写；辩词不裁剪、不总结，由 buildRoundPrompt 机械内嵌全文到每轮 prompt。
- **禁止全文读取 Skill-Judge.md**（必须 SECTION 切片）；禁止把"完整读取技能文档"作为执行前提。
- 用户要求裁判时：先确认执行器可用（API 已配置）；不可用则明确说明，不执行单会话降级。

## 代码修改审批（强制）

- 本项目根目录下的 render-report.js / pipeline-controller.js / render-tables.js / install-skill.js / Skill-Judge.md（含内嵌块）/ assets / schemas / tests / rules / scripts 等程序文件**默认只读**。
- **授权只认明确措辞**（批准实施/按方案修改/执行修改）；排查、梳理、方案、推送、审计、彻底解决等措辞不构成授权；禁止以意图推断代替授权。
- 修改前必须输出拟改文件清单并等待用户批准；未授权时必须停止写盘。
- 开发仓库的审批规则只约束项目维护，不是安装后裁判运行依赖；普通裁判运行只读取 canonical Runtime Protocol。

## 项目维护入口（仅当用户要求查看状态/开发/审计时）

- 若当前确实位于 Debate-Judge 开发仓库，再按该仓库当前控制面推进维护；外部安装环境不得假定存在任何 Upload 交接文件。
- 纪律：以当前项目根目录主版本为唯一开发真源；archive/backup/历史工作区只用于追溯，不作为现役开发入口；先读源后写码；中文经 PowerShell 管道会损坏，用文件方式处理。
- 门禁：\`node pipeline-controller.js self-check\`；公开发行回归：\`node tests/run-public.js\`。私有开发仓库可另有更广的内部审计套件，不构成公开发行依赖。

## 规则加载纪律

- 每轮切片 = 该轮完整规则 + 共享资源区；跨轮结论写入过渡文件/模型，不依赖上下文残留。
- 修改规则/程序后必须重新内嵌：\`node scripts/embed-assets.js\` + \`node pipeline-controller.js sync-embed\`，保持单文件与文件级一致。

## 重新安装/迁移

\`node install-skill.js --skill <新路径>\`；卸载 \`node install-skill.js --uninstall\`。
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.uninstall) {
    const target = path.join(args.codexSkills, 'debate-judge');
    if (!fs.existsSync(target)) { console.log('未安装（不存在: ' + target + '）'); return; }
    fs.rmSync(target, { recursive: true, force: true });
    console.log('已卸载轻量壳: ' + target);
    return;
  }

  const content = readSkill(args.skill);
  const r = verify(content, args.verifyOnly ? null : args.work);
  if (!r.ok) {
    console.error('=== 校验失败 ===');
    r.errors.forEach(e => console.error('  ✗ ' + e));
    process.exit(1);
  }
  console.log('=== 内嵌校验通过（' + BLOCKS.length + ' 块） ===');
  if (args.verifyOnly) { console.log('--verify-only：未落盘、未安装。'); return; }

  writeWorkspace(r.extracted, args.work, args.skill);
  console.log('已提取核心工作区: ' + args.work);

  const shellDir = path.join(args.codexSkills, 'debate-judge');
  fs.mkdirSync(shellDir, { recursive: true });
  fs.writeFileSync(path.join(shellDir, 'SKILL.md'), shellTemplate(args.skill, args.work), 'utf-8');
  console.log('已安装轻量壳: ' + path.join(shellDir, 'SKILL.md'));
  console.log('');
  console.log('下一步：打开【新】Codex 会话（技能列表在会话启动时加载），输入「加载辩论裁判技能」或提及 debate-judge 即自动触发。');
  console.log('卸载：node install-skill.js --uninstall');
}

if (require.main === module) main();
module.exports = { BLOCKS, shellTemplate, parseArgs, verify, writeWorkspace };
