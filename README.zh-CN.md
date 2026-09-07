# Debate-Judge

面向华语竞技辩论的结构化分析与裁判研究系统

[English](README.md)

> 2026-09-07 本地 public-candidate 快照。项目有权再许可的代码、规则文本、文档、测试与生成产物已按 MIT 路线收口；定向权利扫描未发现被打包进来的第三方出版物/赛事手册/课程材料长段原文，两张权利尚未单独确认的 Sanctum 背景图也已从 public 闭包移除。当前 MIT/CSS hardening 后的 source 已重新完成 build、public tests、可执行密钥扫描、路径/隐私 postcondition 与 manifest 生成；下一门已切换为 Git/publication 与 JOSS 公开历史/影响积累。

Judge 研究如何将一方的持方架构、跨发言展开的交锋过程和有语境的裁决连接起来。系统结合领域表示、分阶段 LLM 分析、机器可读中间产物和契约检查，输出可回查的裁判报告。学术重点是**论证结构—交锋过程—裁决之间的连接**，不是调用次数或报告美观程度。

## 研究重点

- 持方层表示：用项目的 A→B→C 表示对象、中介理由与结论，并识别持方成立的核心理由。这是表示选择，不是自然语言论证有效性的自动证明。
- 过程性交锋：追踪对方论证如何被接收、质疑、容纳或重新解释。当前 SC 阶段和阈值仍需外部评估。
- 有语境的裁决：显式记录裁判视角与输入语境；模型推断的听众反应不是实测听众数据。
- 可回查产物：保留分析、结构、冲突裁决和报告链。可追溯性有助于审计，但不自动证明解释忠实于模型推理。

## 当前工作流

核心十个执行单元为 R1、R2、R2.5、R3、R4、R4.5、R5A、R5B、R6a、R6b，依次承担提取、交锋/修辞分析、判定合成、结构化与冲突处理、叙事和报告组装；以 `executor/core.js::ROUNDS` 为准。R7 白话、R8 导览是独立可选后处理。分组元数据不等于已实现并行调度。

浏览器入口为 `web/judge.html`。单 HTML 包含前端与内嵌资源，不表示模型离线运行；真实裁判依赖配置的外部模型服务。核心判定与后处理应分别报告状态。

## 与 DUG 的关系

| 路线 | 独立贡献 | Judge 的作用 |
|---|---|---|
| P1 理论纲领 | 跨尺度论证框架与研究议程 | 工程可行性例证，不是整套理论的验证 |
| P2 知识形式化方法 | 从授课媒体到可执行专家系统的追溯管线 | 执行端案例，不等于裁判算法论文 |
| P3 语料/标注 | 协议、资源、人工一致性及基线 | 待评估基线；不能虚写 IAA 或数据发布 |
| 拟议 Judge 实证研究 | 结构化裁判在明确任务中的增益与局限 | 被评估系统，另立证据合同 |

DUG 在研理论版本与 Wayfinder 设计方案有独立状态，不能直接写成当前 HTML 已实现能力。设计冻结不等于代码实现或效果验证。

## 状态与使用边界

当前有较完整的工程原型、提示词与产物契约，但本次准备没有产生裁判准确率、专家一致性、跨赛制泛化或教育效果结果。模型解释错误、领域启发式未校准、逐字稿丢失现场信息、评委合理分歧均需单独讨论。软件门禁通过不等于裁判判断正确。

截至 2026-09-07 post-hardening 验收，三份 public-candidate Markdown 分发镜像 `Skill-Judge.md`、`Debate-Judge.md` 与 `.claude/skills/debate-judge/SKILL.md` 逐字节一致，SHA-256 均为 `81863147ed0a9833e1380e92e631022b5b5c63157822c874f981c5d30413ba09`，frontmatter 为 MIT；当前可复现 `web/judge.html` SHA-256 为 `326d9156d61b071a66b4d9d4a323e72a99078fee04e778f4b38edc46612234dd`，连续两次本地 rebuild 得到完全相同的 hash。`tests/run-public.js` 最终 `PUBLIC TEST SUITE PASS`，可执行密钥扫描对 84 个文件 PASS，三镜像/MIT 传播/图片排除/private path/API config 等 release postcondition 全部通过。public GitHub repository 已于 2026-09-07 建立；当前只剩这次确定性构建修复 push 后的 fresh-clone equality 验收。

当前本地候选已使用 Node v24.16.0 / Windows x64 实际执行以下入口；未来公开前须在 fresh clone 再跑一次：

```sh
node pipeline-controller.js self-check
node tests/run-public.js
```

以上只用于软件检查；`tests/run-public.js` 是经过公开权利/隐私边界筛选的 public subset，并不等同于私有 upstream 全量测试。当前本地验收已通过；仍应在隔离 fresh clone 再跑，测试可能生成文件。公开发布时还应补 browser smoke 与最终依赖/版本记录。

真实裁判入口为：

```sh
node pipeline-controller.js pipeline run /path/to/authorized-transcript.txt --provider auto --plain --reader-guide
```

只对已获使用许可的逐字稿执行，并事先检查模型服务、费用、数据发送和保留设置；不需要白话/导览可省略对应参数。不得上传凭据与私有报告。本次没有发起 API 裁判。

## 开发与发行文档

- [安装](docs/installation.md)
- [使用](docs/usage.md)
- [架构](docs/architecture.md)
- [复现](docs/reproducibility.md)
- [数据与权利边界](docs/data-and-rights.md)
- [权利与许可状态](docs/rights-status.md)
- [研究影响证据跟踪](docs/research-impact.md)
- [发行扫描状态](docs/release-scan-status.md)
- [支持与治理](docs/support-and-governance.md)
- [AI 使用披露](docs/ai-usage.md)
- [JOSS 准备度跟踪](docs/joss-readiness.md)
- [公开测试说明](tests/README.md)
- [公开测试状态](PUBLIC-TEST-STATUS.md)
- [当前发行阻断](RELEASE-BLOCKERS.md)
- [贡献指南](CONTRIBUTING.md)
- [变更记录](CHANGELOG.md)

## 邻近研究与许可

[Debatrix](https://aclanthology.org/2024.findings-acl.868/) 已研究时序与多维 LLM 裁判；[论证质量研究](https://aclanthology.org/E17-1017/) 已有多维框架；[CEDAR](https://aclanthology.org/2026.acl-long.238/) 已提供中文比赛文本及多种标签；[LLM-Rubric](https://aclanthology.org/2024.acl-long.745/) 展示了人类评分校准。Judge 的新增价值应由具体表示差异与实验支撑，不能依赖“首次多维”或“中文辩论语料空白”的笼统表述。

当前 public candidate 已包含 MIT `LICENSE`，canonical Skill frontmatter 也已改为 MIT。`THIRD_PARTY_NOTICES.md` 保留 Toulmin、Grice、Austin/Searle、Perelman、Wittgenstein、Burke 等学术概念的归因边界：MIT 授权的是 Debate-Judge 自身实现与表达，不声称拥有这些理论或其出版物。真实比赛语料、课程媒体、数据集、模型权重、私有产物以及已隔离的 Sanctum 图片均不属于本次 public 分发。

本准备包不附课程原媒体、比赛语料、参赛者数据、模型权重或凭据。未来样例须另附来源与权利声明。作者、首发版本、引用元数据和 DOI 在核定及实际发布后补入；当前不宣称论文已发表或录用。
