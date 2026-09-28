# Debate-Judge 语义版 · Semantic Edition

[English](README.md) · 分支：`semantic-edition` · 定版：`semantic-2026.09.28-r8-debug`

以 GPT6 r6 白话增强版为基础，保留完整裁判轮次、SC 语义识别、评委倾向、成熟报告布局、续跑恢复、白话解释和章节导览。名称代表发展重心，运行时模型可自行配置。

本次包含中英文界面切换、运行状态面板遮挡修复、R8 导览元数据与草稿恢复，以及项目本地 ComfyUI 生成的深浅背景；进一步修通最终交锋判断与报告汇总、R8 实质异议的责任轮回查和后续重建。运行日志右侧新增一键 Debug 导出，新建与续跑提示按实际入口区分。语言按钮只切换界面；辩词、报告、原始日志及裁判提示词保持原文。

**这是供后续研究和开发的定版快照，不是已经证明裁判准确、也不是全部历史测试通过的版本。** 当前确定性测试子集和公开打包检查通过；两个旧测试套件及旧 self-check 仍失败，完整公开测试入口如实返回失败。详情见[定版说明](docs/semantic-edition.md)。

## 使用和验证

下载后在现代浏览器打开 `web/judge.html`，自行配置 API。单文件表示应用资源已内嵌，不表示模型推理离线运行。

源码构建已在 Node.js 24.16.0 / Windows x64 验证，无需安装 npm 依赖：

```sh
git clone --branch semantic-edition https://github.com/MoonTzai/debate-judge.git
cd debate-judge
node install-skill.js --verify-only
node web/build-judge-web.js
node tests/run-public.js --current
```

`--current` 明确排除已披露的旧测试，不把排除项记作通过。完整现状复现使用 `node tests/run-public.js`，目前会返回非零。

## 公开范围

保留运行和构建依赖、完整规则文本、Codex/Claude 兼容入口、单文件网页、可公开的合成输入测试及必要文档。两个 Skill 镜像与根 `Skill-Judge.md` 完全相同。原包里未使用的过期嵌套 controller 不发布，现役控制器仍为根 `pipeline-controller.js`。

不发布真实辩词、私人报告或飞行记录、API 配置、私人审计交接及旧 vendor 快照。深浅背景是项目本地 ComfyUI 生成素材，所有者已确认纳入 MIT 发布，图片源文件与单文件 HTML 均包含。此前将其列为待确认第三方素材并排除，是错误分类，现已更正。保留 SC 判准、评分机制与报告结构；本次明确最终判断来源和复核职责，不按计数机械改判，详见定版说明。

## 研究复现

论文实验应引用固定 tag 或 commit，并记录模型、设置、允许使用的数据、失败案例及人工评价方法。仓库包含完整源码，不依赖私人文件引用或校验码恢复。文件校验清单只是附加完整性检查，不代替完整源码。

本次没有新增真实模型评测，不宣称人工一致率、领先性或论文录用。参阅[架构](docs/architecture.md)、[复现说明](docs/reproducibility.md)、[AI 使用披露](docs/ai-usage.md)和 [CITATION.cff](CITATION.cff)。

项目所有者已确认此次公开内容统一沿用 [MIT](LICENSE)。第三方材料不因此获得重新授权，具体边界见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
