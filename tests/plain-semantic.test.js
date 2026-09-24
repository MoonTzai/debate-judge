// A2：R7 逐句语义白话契约（运行：node tests/plain-semantic.test.js）
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const PL = require('../scripts/plain-language.js');
const PC = require('../scripts/plain-comprehension.js');
const hn = require('../executor/host-node.js');
const JudgePC = require('../pipeline-controller.js');

let failed = 0;
const check = (name, cond, detail) => {
  console.log((cond ? 'PASS' : 'FAIL') + ' ' + name + (detail ? ' :: ' + detail : ''));
  if (!cond) failed++;
};

const dict = {
  '结构性交锋': '双方围绕同一个关键问题连续回应和推进',
  '完成度': '论证是否把需要说明的关键环节讲完整'
};
const orig = '<!doctype html><html><body>' +
  '<div class="theme-bar"><button id="plainBtn">白话</button><button>深色模式</button></div>' +
  '<div class="api-config-wrap"><div>⚙️ API 配置</div></div>' +
  '<div class="c-module c2" id="c2"><p>这场结构性交锋的完成度很高。</p><p>后续的结构性交锋继续推进。</p></div>' +
  '</body></html>';
const missing = orig.replace('这场结构性交锋的完成度很高。', '这场关键争论的论证很完整。');
const valid = orig
  .replace('这场结构性交锋的完成度很高。', '这场结构性交锋（双方围绕同一个关键问题连续回应和推进）的完成度（论证是否把需要说明的关键环节讲完整）很高。')
  .replace('后续的结构性交锋继续推进。', '后续的结构性交锋继续推进。');
const purePlain = valid.replace('<div class="theme-bar"><button id="plainBtn">白话</button><button>深色模式</button></div>', '');

const units = PL.extractUnits(PL.parseHtml(orig));
const requirements = PL.annotateSemanticRequirements(units, dict);
check('A2-S1 首现术语要求只标记可译正文且最长词优先',
  requirements.length === 2 && requirements.every(r => r.unitId) &&
  requirements.some(r => r.term === '结构性交锋') && requirements.some(r => r.term === '完成度'),
  JSON.stringify(requirements));
check('A2-S2 报告 UI 不进入可比正文',
  PL.compareVersions(orig, purePlain).ok === true,
  JSON.stringify(PL.compareVersions(orig, purePlain).stats));
const bad = PL.checkSemanticPlain(orig, missing, dict);
check('A2-S3 legacy-v3 首现术语精确释义合同仍可供 A4 无模型 refresh 验真',
  bad.ok === false && bad.missing.length === 2,
  JSON.stringify(bad));
const good = PL.checkSemanticPlain(orig, valid, dict);
check('A2-S4 legacy-v3 精确受控解释通过，后续不重复要求',
  good.ok === true && good.requirements.length === 2 && good.missing.length === 0,
  JSON.stringify(good));

// live PLAIN v4：伪白话/黑箱属于 reviewer 语义职责；机械层不得再用局部 regex hard gate。
const c8Pseudo = PC.inspectPlainText(
  '双方四个象限均被锁定，胜负须看哪方完成更高层收束。',
  '双方四个象限都被锁定，胜负要看哪一方完成更高层汇总。',
  { profile: 'zero_background_summary' }
);
check('P2-S1 C8 同义词式伪白话不再由机械层误判为 hard failure',
  c8Pseudo.ok === true && !c8Pseudo.issues.some(x => x.code === 'surface-only-rewrite'),
  JSON.stringify(c8Pseudo));
const internalGloss = PC.inspectPlainText(
  '技术完成度抵销其微弱优势。',
  '技术完成度（结构性交锋是否真正形成统一结论的语义判定（场感语义，非机械字段组合））抵销了这点微弱优势。',
  { profile: 'professional_explanation' }
);
check('P2-S2 内部实现式黑箱释义交给独立 reviewer，不再由机械层判 opaque',
  internalGloss.ok === true && !internalGloss.issues.some(x => x.code === 'opaque-concept'),
  JSON.stringify(internalGloss));
const expanded = PC.inspectPlainText(
  '结构性交锋推进。',
  '这里说“结构性交锋”，就是双方围绕同一个关键问题连续回应；关键不是谁提到的材料更多，而是谁能接住对方的材料，再把它变成支持自己结论的理由。',
  { profile: 'professional_explanation' }
);
check('P2-S3 解释到具体行为的正文应通过', expanded.ok === true, JSON.stringify(expanded));
const idDrift = PC.inspectPlainText(
  '依据 M-FA-2 展开。',
  'M-FA-3 在这里代表反方把前面的回应重新接回核心主张。',
  { profile: 'professional_explanation' }
);
check('P2-S4 放开混合 ID 句后仍必须机械阻断 ID 漂移',
  idDrift.ok === false && idDrift.issues.some(x => x.code === 'protected-token-drift'),
  JSON.stringify(idDrift));

// live 审查：即使 translation adapter 被替换/绕过，applyPlain 在没有完整 draft/review 序列时仍须 fail-close。
(async () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'r7-semantic-apply-'));
  const source = '<!doctype html><html><body><p>结构性交锋推进了。</p></body></html>';
  const originalProcess = PL.processReportAsync;
  try {
    fs.writeFileSync(path.join(workDir, 'report.html'), source, 'utf8');
    fs.writeFileSync(path.join(workDir, 'transition-final.md'), '', 'utf8');
    PL.processReportAsync = async () => ({ html: source });
    let blocked = '';
    try {
      await hn.applyPlain(workDir, { provider: 'mock' }, () => {}, null, { cache: false });
    } catch (e) { blocked = String(e.message); }
    check('A2-S5 applyPlain 写盘前阻断绕过 adapter 的未复核产物',
      blocked.includes('未获得可复核的完整 draft 单元序列') && !fs.existsSync(path.join(workDir, 'report-plain.html')), blocked);

    // PRODUCTION_ACTIVE presentation failure-atomicity: once report-plain.html has been produced, a later
    // final HTML gate failure must restore report.html byte-for-byte and remove the newly-created
    // public plain artifact. Private review/cache checkpoints may survive for bounded retry.
    const originalCheckHtml = JudgePC.checkHtml;
    const source2 = '<!doctype html><html><body><div class="c-module c1"><p>这是一段普通说明。</p></div></body></html>';
    fs.writeFileSync(path.join(workDir, 'report.html'), source2, 'utf8');
    fs.writeFileSync(path.join(workDir, 'transition-final.md'), '', 'utf8');
    fs.rmSync(path.join(workDir, 'report-plain.html'), { force: true });
    PL.processReportAsync = async (_html, opts) => {
      const draftUnits = [{ id: 'A46-u1', module: 'C1', blockType: 'p', text: '这是一段普通说明。', path: [0] }];
      const translated = await opts.translateUnits(draftUnits);
      const text = translated.get('A46-u1');
      return {
        html: '<!doctype html><html><body><div class="c-module c1"><p>' + text + '</p></div></body></html>',
        units: draftUnits,
        stats: { translatable: 1, coverage: { coveragePct: 100 } }
      };
    };
    JudgePC.checkHtml = () => ({ blocking: [{ message: 'A46 forced post-write final gate failure' }], warnings: [] });
    let rollbackError = '';
    try {
      await hn.applyPlain(workDir, { provider: 'mock' }, () => {}, null, { cache: false });
    } catch (e) { rollbackError = String(e.message); }
    check('A46 R7 后置门失败必须回滚公开 presentation 文件',
      rollbackError.includes('A46 forced post-write final gate failure') &&
      fs.readFileSync(path.join(workDir, 'report.html'), 'utf8') === source2 &&
      !fs.existsSync(path.join(workDir, 'report-plain.html')),
      rollbackError);
    JudgePC.checkHtml = originalCheckHtml;
  } finally {
    PL.processReportAsync = originalProcess;
    fs.rmSync(workDir, { recursive: true, force: true });
  }
})().then(() => {
  console.log(failed === 0 ? '=== ALL PASS ===' : '=== FAILED: ' + failed + ' ===');
  process.exit(failed === 0 ? 0 : 1);
});
