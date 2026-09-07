// Debate-Judge V7.9 · 回归测试套件（node --test tests/self-check.test.js）
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const root = path.resolve(__dirname, '..');
const { renderTable, isSeparatorRow } = require('../render-tables.js');
const { checkTerminologyContent, scanVersionMarkersContent, validateTablePairing, extractEmbeddedBlock, extractEmbeddedAsset } = require('../pipeline-controller.js');

const skill = fs.readFileSync(path.join(root, 'Skill-Judge.md'), 'utf-8');
const jsSrc = fs.readFileSync(path.join(root, 'pipeline-controller.js'), 'utf-8').replace(/\r\n/g, '\n').trim();

// ---- TABLE-SEP 正则（与 checkHtml 同一模式）----
const sepRe = /<\s*t[dh][^>]*>\s*[-:]{3,}\s*<\/\s*t[dh]\s*>/i;
test('TABLE-SEP：命中纯符号单元格（含属性）', () => {
  for (const c of ['<td>---</td>', '<td colspan="2">---</td>', '<td class="sep">---</td>', '<th>---</th>'])
    assert.ok(sepRe.test(c), '应命中: ' + c);
});
test('TABLE-SEP：不误伤普通内容', () => {
  for (const c of ['<td>1:2</td>', '<td>xxx---xxx</td>', '<td>---分隔符---</td>', '<td>2024-01-01</td>', '<td> - - - </td>'])
    assert.ok(!sepRe.test(c), '不应命中: ' + c);
});

// ---- render-tables ----
test('分隔行判定：合法变体命中，数据行不命中', () => {
  assert.ok(isSeparatorRow('|---|:---:|------|'));
  assert.ok(!isSeparatorRow('| A | B |'));
});
test('COLSPAN：N 取 列= 定义列数（权威源）', () => {
  const out3 = renderTable({ attrs: '名称=t,列=A|B|C', body: '| h1 | h2 | h3 |\n| 通宽标题 | | |', index: 0, full: '' });
  assert.match(out3.html, /<td colspan="3"/);
  const out2 = renderTable({ attrs: '名称=t,列=A|B', body: '| h1 | h2 |\n| 通宽标题 | |', index: 0, full: '' });
  assert.match(out2.html, /<td colspan="2"/);
});
test('COLSPAN：多非空单元格行不触发', () => {
  const out = renderTable({ attrs: '名称=t,列=A|B|C', body: '| A | B | C |', index: 0, full: '' });
  assert.ok(!/<td colspan=/.test(out.html));
});

// ---- F-13：COLSPAN 通宽标题识别 + nCols 修正 ----
test('F-13 C2 结构：首行单格=通宽标题、次行=表头、colspan=2', () => {
  const body = [
    '| 2b型·有推进未结晶 | |',
    '| 阶段 | 做什么 |',
    '| Phase I | 立论声明 |',
    '| **本场比赛** | |',
    '| Phase II | 微消化 |'
  ].join('\n');
  const out = renderTable({ attrs: '列=', body, index: 0, full: '' });
  assert.ok(out.html.includes('colspan="2"'), '通宽行 colspan=2，实际: ' + (out.html.match(/colspan="\d+"/g) || []).join(','));
  assert.ok(out.html.includes('<th>阶段</th><th>做什么</th>'), '表头=阶段|做什么');
  const titlePos = out.html.indexOf('2b型·有推进未结晶');
  const theadPos = out.html.indexOf('<thead>');
  assert.ok(titlePos >= 0 && titlePos < theadPos, '通宽标题行在表头之前');
  assert.ok(!out.html.includes('预期=3'), '无虚假列数警告');
});
test('F-13 普通多列表：首行仍为表头（模式不触发）', () => {
  const body = '| 向度 | 正方 | 反方 |\n| 证伪 | 2 | 8 |\n| 证成 | 4 | 6 |';
  const out = renderTable({ attrs: '列=向度|正方|反方', body, index: 0, full: '' });
  assert.ok(out.html.includes('<th>向度</th><th>正方</th><th>反方</th>'), '普通表首行=表头');
  assert.ok(!out.html.includes('colspan'), '普通表无通宽行');
  assert.ok(!out.html.includes('预期='), '无列数警告');
});
test('F-13 注释行不污染：<!--COLSPAN--> 被丢弃', () => {
  const body = '<!--COLSPAN-->\n| 标题 | |\n| A | B |\n| 1 | 2 |';
  const out = renderTable({ attrs: '列=', body, index: 0, full: '' });
  assert.ok(out.html.includes('<th>A</th><th>B</th>'), '注释行不影响表头');
  assert.ok(out.html.includes('colspan="2"'), '标题行为通宽行');
});
test('F-13 单列表（首行次行均单格）不触发标题模式', () => {
  const body = '| 唯一列 |\n| 值1 |\n| 值2 |';
  const out = renderTable({ attrs: '列=', body, index: 0, full: '' });
  assert.ok(out.html.includes('<th>唯一列</th>'), '单列表首行仍为表头');
});

// ---- A8-P1c：首列标签 + 单内容列 → 内容列 colspan ----
test('A8 三轴对径行：内容列 colspan=(nCols-1)', () => {
  const body = '| 向度 | 正方 | 反方 | 定性 | 依据 |\n| 证伪 | 2 | 8 | 反优 | x |\n| 三轴对径 | 证明轴/说服轴/第三方轴全部指向反方 | | | |';
  const out = renderTable({ attrs: '列=向度|正方|反方|定性|依据', body, index: 0, full: '' });
  assert.ok(out.html.includes('<td>三轴对径</td><td colspan="4">'), '三轴对径内容列 colspan=4，实际: ' + (out.html.match(/三轴对径[^]*?<\/tr>/g) || [''])[0]);
  assert.ok(out.html.includes('<td>证伪</td><td>2</td><td>8</td><td>反优</td>'), '普通行不受影响');
});
test('A8 两列表不触发（避免 colspan=1）', () => {
  const body = '| 判准要素 | 说明 |\n| **A 判准类型** | 组合判准 |';
  const out = renderTable({ attrs: '列=判准要素|说明', body, index: 0, full: '' });
  assert.ok(!out.html.includes('colspan="1"'), '两列表不产生 colspan=1');
});

// ---- checkTerminology ----
test('术语正例：当前 Skill-Judge.md 通过', () => {
  const r = checkTerminologyContent(skill);
  assert.ok(r.passed, JSON.stringify(r.errors));
});
test('术语反例：偏差词必须失败', () => {
  const bad = skill.replace('①A未必→B', '①直接否定前提');
  assert.ok(!checkTerminologyContent(bad).passed);
});
test('术语反例：②③ 调换必须失败', () => {
  const bad = skill.replace('②B未必→C', '②B不重要').replace('③B不重要', '③B未必→C');
  assert.ok(!checkTerminologyContent(bad).passed);
});
test('术语反例：#11 误含反转语义必须失败', () => {
  const bad = skill.replace("对方不满足B'（不重要）", "对方满足B'（恰恰支持）");
  assert.ok(!checkTerminologyContent(bad).passed);
});

// ---- scanVersionMarkers ----
test('版本标记：标注形态阻断，语义性提及仅警告', () => {
  const fixture = '## X\n\n步骤 5（V7.2 强制）\n\nFILE.版本=Judge V1.0\n';
  const r = scanVersionMarkersContent(fixture);
  assert.ok(!r.passed);
  assert.strictEqual(r.blocking.length, 1);
  assert.strictEqual(r.warnings.length, 1);
});
test('版本标记：围栏内标注必须命中（指令正文含代码块）', () => {
  const fixture = '```css\n/* （V9.9 新增） */\n```\n';
  assert.ok(!scanVersionMarkersContent(fixture).passed);
});
test('版本标记：括号内带前缀码的标注必须命中', () => {
  const fixture = '输出前交叉验证（L1+L2+L3·V6.5强化）\n';
  assert.ok(!scanVersionMarkersContent(fixture).passed);
});
test('版本标记：语义性裸版本号仅警告', () => {
  const fixture = 'FILE.版本=Judge V1.0\n降级选项（旧版回退/人工介入）\n';
  const r = scanVersionMarkersContent(fixture);
  assert.ok(r.passed);
  assert.strictEqual(r.warnings.length, 1);
});

// ---- validateTablePairing ----
test('表格配对：栈式校验正反例', () => {
  assert.ok(validateTablePairing('<!--TABLE:名称=a-->\n行\n<!--/TABLE-->\n<!--TABLE:名称=b-->\n行\n<!--/TABLE-->').passed);
  assert.ok(!validateTablePairing('<!--TABLE:名称=a-->\n行\n<!--TABLE:名称=b-->\n行\n<!--/TABLE-->').passed);
});

// ---- 同步 ----
test('同步：三镜像一致 + 内嵌 JS 一致', () => {
  const md = fs.readFileSync(path.join(root, 'Debate-Judge.md'), 'utf-8');
  const copy = fs.readFileSync(path.join(root, '.claude/skills/debate-judge/SKILL.md'), 'utf-8');
  assert.strictEqual(skill.replace(/\r\n/g, '\n'), md.replace(/\r\n/g, '\n'));
  assert.strictEqual(skill, copy);
  const eb = extractEmbeddedBlock(skill);
  assert.ok(eb.ok, '内嵌 JS 块提取失败');
  assert.strictEqual(eb.code, jsSrc);
  // A8-P4：块后允许且仅允许 EMBED_ASSET_LIST 区块（构建期硬编码）
  const after = eb.after.trim();
  assert.ok(after === '' || /^<!-- EMBED_ASSET_LIST -->[\s\S]*$/.test(after), '块后存在非 EMBED_ASSET_LIST 残留（同步截断污染）');
});
test('内嵌块提取：块后带垃圾必须暴露（结构断言）', () => {
  const fixture = '<!-- PIPELINE_CONTROLLER_START -->\n```javascript\nvar x = 1;\n```\n<!-- PIPELINE_CONTROLLER_END -->\n垃圾尾部';
  const r = extractEmbeddedBlock(fixture);
  assert.ok(r.ok);
  assert.strictEqual(r.code, 'var x = 1;');
  assert.notStrictEqual(r.after.trim(), '');
});
test('内嵌块提取：干净文件无尾随', () => {
  const fixture = '前文\n<!-- PIPELINE_CONTROLLER_START -->\n```javascript\nvar x = 1;\n```\n<!-- PIPELINE_CONTROLLER_END -->';
  const r = extractEmbeddedBlock(fixture);
  assert.ok(r.ok);
  assert.strictEqual(r.after.trim(), '');
});

// ---- L5: 内嵌资产块（单文件交付） ----
test('L5+C10b 内嵌资产：17 块与文件逐字一致', () => {
  const md = fs.readFileSync(path.join(root, 'Skill-Judge.md'), 'utf-8');
  const assetPairs = [
    ['CSS', 'assets/report.css'],
    ['SKELETON', 'assets/skeleton.html'],
    ['CHARTS_CONSTANTS', 'assets/charts-constants.js'],
    ['RENDER_REPORT', 'render-report.js'],
    ['RENDER_TABLES', 'render-tables.js'],
    ['EXECUTOR_CORE', 'executor/core.js'],
    ['EXECUTOR_HOST_NODE', 'executor/host-node.js'],
    ['EXECUTOR_BROWSER', 'executor/browser.js'],
    ['API_PROVIDER', 'executor/api-provider.js'],
    ['INSTALLER', 'install-skill.js'],
    ['SCHEMA_CRITERIA', 'schemas/criteria.schema.json'],
    ['SCHEMA_INDEX', 'schemas/index.schema.json'],
    ['SCHEMA_MODEL_SNAPSHOT', 'schemas/model-snapshot.schema.json'],
    ['SCHEMA_PRESENTATION', 'schemas/presentation.schema.json'],
    ['SCHEMA_TENDENCY', 'schemas/tendency.schema.json'],
    ['SCHEMA_INPUT_CONTRACT', 'schemas/input-contract.json'],
    ['SCHEMA_ADJUDICATION', 'schemas/adjudication.schema.json']
  ];
  for (const [name, file] of assetPairs) {
    const eb = extractEmbeddedAsset(md, name);
    assert.ok(eb.ok, name + ' 内嵌块缺失');
    const fileContent = fs.readFileSync(path.join(root, file), 'utf-8').replace(/\r\n/g, '\n').trim();
    assert.strictEqual(eb.code, fileContent, name + ' 内嵌与文件不一致');
  }
});
test('L5 内嵌资产块提取：通用提取器', () => {
  const fixture = '前文\n<!-- EMBED_ASSET:TEST_START -->\n```json\n{"a":1}\n```\n<!-- EMBED_ASSET:TEST_END -->\n尾文';
  const r = extractEmbeddedAsset(fixture, 'TEST');
  assert.ok(r.ok);
  assert.strictEqual(r.code, '{"a":1}');
  assert.ok(r.after.includes('尾文'));
});

// ---- A8-ERR-1 场次隔离与启动协议规则断言（三镜像 = 权威文件全文；轻量壳由 install-skill 自检） ----
test('场次隔离：权威三镜像含机械关键词 + 龙猫启动协议', () => {
  const md = fs.readFileSync(path.join(root, 'Skill-Judge.md'), 'utf-8');
  const mirror = fs.readFileSync(path.join(root, '.claude/skills/debate-judge/SKILL.md'), 'utf-8');
  const pc = fs.readFileSync(path.join(root, 'pipeline-controller.js'), 'utf-8');
  assert.ok(md.includes('非法目录格式，请使用时间戳目录'), '权威文件缺“非法目录格式”');
  assert.ok(md.includes('禁止跨场次复用'), '权威文件缺“禁止跨场次复用”');
  assert.ok(mirror.includes('非法目录格式，请使用时间戳目录') && mirror.includes('禁止跨场次复用'), '三镜像缺场次隔离关键词');
  assert.ok(mirror.includes('▄▄▄▄▄') && mirror.includes('⚖️ 辩论裁判 V1.0 已就绪'), '三镜像缺龙猫启动协议');
  assert.ok(pc.includes('VALID_OUTPUT_DIR_RE') && pc.includes('ensureFreshOutputDir'), 'pipeline-controller 缺场次隔离门禁');
});

// ---- 完整管道唯一制（路径 A 已废除，防回退） ----
test('完整管道唯一制：轻量壳模板禁止单会话直接裁判', () => {
  const installer = fs.readFileSync(path.join(root, 'install-skill.js'), 'utf-8');
  const shellStart = installer.indexOf('shellTemplate');
  assert.ok(shellStart >= 0);
  const shellSrc = installer.slice(shellStart);
  assert.ok(!shellSrc.includes('路径 A（Codex 默认且唯一开箱即用）'), '轻量壳模板残留路径 A');
  assert.ok(!shellSrc.includes('直接按 S1–S17 分析并在对话中产出判决'), '轻量壳模板残留单会话裁判表述');
  assert.ok(shellSrc.includes('每轮使用独立上下文'), '轻量壳模板缺“每轮独立上下文”');
  assert.ok(shellSrc.includes('禁止单会话直接裁判'), '轻量壳模板缺“禁止单会话直接裁判”');
  assert.ok(shellSrc.includes('无法执行完整管道'), '轻量壳模板缺“无执行器时停止”语义');
  assert.ok(shellSrc.includes('--provider auto'), '轻量壳模板缺“auto 自适应 provider”');
});

// ---- 根目录主版本：Skill-Judge.md 为唯一真源，两处加载镜像逐字一致 ----
test('根主版本：Claude Skill 与 Debate-Judge.md 均逐字镜像 Skill-Judge.md', () => {
  const main = fs.readFileSync(path.join(root, 'Skill-Judge.md'), 'utf-8');
  for (const rel of ['.claude/skills/debate-judge/SKILL.md', 'Debate-Judge.md']) {
    const p = path.join(root, rel);
    assert.ok(fs.existsSync(p), '根主版本镜像缺失: ' + rel);
    assert.strictEqual(fs.readFileSync(p, 'utf-8'), main, rel + ' 与 Skill-Judge.md 不一致');
  }
});
test('根主版本：install-skill syncRootShells 只允许同步当前项目根镜像', () => {
  const installer = require('../install-skill.js');
  const source = fs.readFileSync(path.join(root, 'install-skill.js'), 'utf-8');
  assert.ok(typeof installer.syncRootShells === 'function', 'install-skill 应导出 syncRootShells');
  assert.ok(source.includes('const projectRoot = SCRIPT_DIR;'), 'syncRootShells 必须以当前脚本目录作为项目根');
  assert.ok(!source.includes("const projectRoot = path.resolve(SCRIPT_DIR, '..')"), '禁止恢复旧 work-omega1 上一级推导');
});
test('单文件协议：安装说明由 EMBED_ASSET_LIST 驱动，不硬编码内嵌块数量', () => {
  const main = fs.readFileSync(path.join(root, 'Skill-Judge.md'), 'utf-8');
  const beforePipeline = main.split('<!-- PIPELINE_CONTROLLER_START -->')[0];
  assert.ok(beforePipeline.includes('EMBED_ASSET_LIST'), '顶部安装说明必须引用 EMBED_ASSET_LIST');
  assert.ok(!/尾部\s*\d+\s*个内嵌块/.test(beforePipeline), '顶部安装说明禁止硬编码内嵌块数量');
});
