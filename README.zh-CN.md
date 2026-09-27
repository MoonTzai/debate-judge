> **当前分支：Debate-Judge · Deliberative Edition｜审议版**  
> 谱系：V10-R2.1 优化定版。该分支重点研究从语义理解到最终裁决的可审计形成过程，包括 SC 高阶关系、dependency 去重、局部事实与最终裁决后果分离、authority/review/projection/fidelity 与可复现运行时。  
> 参见 [审议版架构说明](docs/deliberative-edition.md) 与 [复现说明](docs/deliberative-reproducibility.md)。

# Debate-Judge

面向华语竞技辩论的结构化分析与裁判研究系统

[English](README.md)

Debate-Judge 用于研究如何把**持方结构、跨发言展开的交锋过程与最终裁决**连接起来。系统采用分阶段 LLM 分析、显式中间表示、产物契约、恢复机制与浏览器报告。

**当前公开状态：v0.1.2 Research Preview。** 项目代码与工程文档采用仓库 MIT License；冻结的 `Skill-Judge.md` 规则/runtime 文本及其逐字节一致的 `Debate-Judge.md` 镜像保留该冻结源文件内的 `CC BY-NC-SA 4.0` 声明。该分支已完成软件层面的公开复现验证；不宣称达到 SOTA、等同人类评委、普遍有效，或已经完成独立裁判质量验证。

## 仓库里有什么

仓库只维护一个规则/runtime 权威源：

- `Skill-Judge.md` —— canonical Skill，也是单文件自包含分发源。
- `Debate-Judge.md` —— 与其逐字节一致的生成镜像；审议版为保持冻结 V10 bundle/runtime-identity 合同的精确复现而保留该文件，禁止直接编辑。

其它文件围绕它组成实现：

- `pipeline-controller.js` —— 管道编排、校验、续跑规划与源码同步。
- `executor/` —— Provider/runtime 执行与契约校验。
- `schemas/` —— 机器可读产物契约。
- `assets/` —— 报告模板、CSS、字典与图表常量。
- `scripts/` —— 构建、内嵌、校验、发行与文本处理工具。
- `web/src/` —— 可维护的浏览器源码。
- `web/judge.html` —— 生成的单文件浏览器版本。
- `tests/` —— 经过公开权利/隐私边界筛选的确定性测试。
- `MANIFEST.sha256` —— 公开源码树校验清单。

仓库不版本化 `.claude/skills/.../SKILL.md` 安装目标。唯一例外是上述 `Debate-Judge.md` 冻结镜像；它用于精确复现 V10 定版产物，不构成第二个可编辑权威源。

## 执行模型

当前核心执行单元以 `executor/core.js::ROUNDS` 为准：

`R1 → R2 / R2.5 → R3 → R4 → R4.5 → R5A / R5B → R6a → R6b`

R7 白话化与 R8 导览属于可选后处理。依赖图、恢复门禁和软件自检只能证明工程一致性，不能证明裁判结论本身正确。

## 快速验证

当前源码不需要 npm install 或第三方 Node 包。

```sh
node tests/run-deliberative-public.js
node scripts/secret-scan.js
node scripts/generate-manifest.js
```

`web/judge.html` 是审议版冻结的精确浏览器产物，并通过 SHA 校验。历史 browser builder 作为源码谱系保留，但由于两张 Sanctum 隔离图片不进入公开仓库，公开复现范围不包含该历史视觉产物的逐字节重新构建。不要直接手改冻结 artifact。

## 真实裁判

对你有权使用的逐字稿执行：

```sh
node pipeline-controller.js pipeline run /path/to/transcript.txt --provider auto --plain --reader-guide
```

真实运行会调用外部模型服务，可能产生费用，也可能把逐字稿发送到外部 Provider。运行前应检查数据授权、服务条款与本地配置。不要提交 API key、私有逐字稿或私有裁判报告。

Provider 与续跑说明见 [Usage](docs/usage.md)。

## 研究边界

本项目主要研究：

- 如何表示持方架构，而不是把整场辩论当作平面文本；
- 如何追踪交锋在不同发言中的发展过程；
- 如何显式表达有语境的裁判视角；
- 如何保存可回查的中间产物与恢复状态。

这些都是建模选择。软件门禁通过不等于裁判准确、人类一致、基准领先或科学有效。

Debate-Judge 与 Debate Universal Grammar / 辩论筑基研究体系存在理论与历史联系，但这个仓库只代表当前公开的软件实现。仓库外的理论草案、私有审计或设计冻结记录不会自动变成 public runtime 的能力声明。

## 文档

- [安装](docs/installation.md)
- [使用](docs/usage.md)
- [架构](docs/architecture.md)
- [复现](docs/reproducibility.md)
- [数据与权利](docs/data-and-rights.md)
- [支持与治理](docs/support-and-governance.md)
- [AI 使用披露规范](docs/ai-usage.md)
- [公开测试](tests/README.md)
- [贡献指南](CONTRIBUTING.md)
- [变更记录](CHANGELOG.md)

## 许可与数据边界

仓库中的项目代码、schemas、测试、工程文档与纯代码资产按 [MIT License](LICENSE) 发布；冻结的 `Skill-Judge.md` 规则/runtime 文本及其 `Debate-Judge.md` 镜像保留文件内的 `CC BY-NC-SA 4.0` 声明，因此嵌入该文本的单文件生成产物属于混合许可边界。[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 记录具体边界与学术归因。

仓库不分发真实比赛语料库、课程媒体、模型权重、Provider 凭据、私有裁判产物，也不包含此前隔离的 Sanctum 背景图。

## 引用 / JOSS

当前是公开 research-software preview，不是 JOSS 论文。真实公开开发历史从 2026-09-07 的 GitHub 历史开始计算。引用元数据、归档 DOI 与 JOSS paper 应在对应版本与研究证据真实存在后再加入。
