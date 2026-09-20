---
description: Use when orchestrating the full ai-coding-qa-pipeline development flow (spec → code → clean → architect → reinforce → QA) for a feature in the current project. Trigger words: 开发 feature-x / 完整开发流程 / 走流水线 / 继续 feature-x (恢复). Loaded by the main session (orchestrator), not by any execution agent.
---

# Orchestrator Playbook — 主会话编排六环流水线

主会话(=用户直接对话的会话)是**编排者**:读 `.omp/quality.yml`,逐环派发 task agent,
亲自执行并验证门禁,推进流水线。本 playbook 自包含,不依赖仓库外设计文档。

## 何时用 / 何时不用

- 用:用户发起**完整开发流程**(规格→编码→清理→(架构)→强化→QA),或"继续 feature-x"恢复中断的流水线。
- 不用:单点调试、一次性脚本、非 feature 的小改动——那些不进流水线。

## 恢复:先读编排状态(每 feature 一次)

派发前先查 `.scratch/<feature>/pipeline-state.json`:

```
qa_pipeline_state  op=read state_path=<state.json>
# 或等价的 CLI: ai-coding-qa-pipeline pipeline-state read <state.json>
```

- 输出 `{}`(无状态)= 新 feature,从头开始。
- 输出含 `current_ring` = 已中断,从 `current_ring` 续跑,不重来。向用户报告:"已到 <环>,从下一环继续"。
- 读失败(schema 非法/坏 JSON,exit 2)= 状态损坏,人工检查该文件,勿盲续。

## 主流程

1. **定位**:确认这是完整开发流程;读 `.omp/quality.yml`;无则先跑 `pipeline-setup` 初始化。
2. **G0 规格**:派 `spec-definer`(需求文档)→ 主会话亲自跑 `spec.check`(代入 `{spec_path}`/`{qa_flow_path}`)→ 打印 spec 路径,**暂停请用户确认(纯语义卡点)**。
3. **G1 编码**:用户确认后派 `coder` → 主会话亲自跑该语言 `test`(注入占位符)→ 失败让 coder 同环修(≤3 轮)。
4. **G2 清理**:派 `cleaner` → 跑 `complexity` + 复跑 `test`/`arch`。
5. **architect 信号检测**:新建文件数 ≥ 阈值、或 cleaner 上报 structural_changes 非空、或改了架构约束文件 → 派 `architect`(跑 `arch`+`test`);无信号则跳过(默认路径)。
6. **G3 强化**:派 `reinforcer` → 跑 `mutation`(diff 范围)+ `coverage`。
7. **G4 QA**:`e2e` 非 null 才派 `qa-runner`;null 则终点 G3。
8. **每环门禁通过后**:写编排状态(见下)+ 阶段提交(git 项目,可选)。

任一环连续 3 次门禁失败 → 中止,输出失败环 + 证据 + 建议,交回用户。

## 门禁执行:主会话亲自跑,不信 agent 自报

- **编排者与执行者分离**:门禁一律主会话亲自执行验证,绝不采信执行 agent 的 `gate_results` 自报。
- **工具优先(推荐)**:本插件安装后注册 4 个门禁工具,主会话直接调用(无需 CLI 进 PATH):
  - `qa_spec_check` — G0 规格门禁(参数 `spec_path` + `qa_flow_path`)
  - `qa_crap_check` — CRAP 组合器(参数 `threshold` 可选、`paths` 可选)
  - `qa_doctor` — 环境冒烟(参数 `quality_yml_path` 可选)
  - `qa_pipeline_state` — 编排状态读/写(参数 `op` + `state_path` + `json`)
  工具与 CLI 共享同一套核心逻辑(src/gates.ts),退出码语义一致。quality.yml 里的命令字符串仍保留
  作为协议事实源与独立 CLI 场景;插件已装时主会话**优先用工具**,命令字符串仅在无工具环境回退。
- **占位符注入**:执行前从 `git diff` 计算本次 feature 的 diff 文件集,注入 `{diff_source_paths}`(源码,非测试)/ `{diff_test_paths}`(测试);`{spec_path}`/`{qa_flow_path}` 由 spec-definer output 代入。占位符集为空 → 整目录兜底或跳过,报告中说明。工具调用时把占位符实参直接作为工具参数。
- **退出码语义**:0=通过;1=不合格(该环失败,同环重试/回传);2=环境问题(工具缺失,不重试 agent,装工具或置 null 后重跑)。工具返回的 `details.exitCode` 即该语义。

## 写编排状态(每环通过后,ADR-0001)

将状态写入 `.scratch/<feature>/pipeline-state.json`(主会话持有,agent 不写)。两种等价方式,推荐工具:

```
qa_pipeline_state  op=update state_path=.scratch/<feature>/pipeline-state.json json='{...}'
# 或等价的 CLI: ai-coding-qa-pipeline pipeline-state update <state.json> '<json>'
```

字段:feature / feature_name / requirement / current_ring(下一环)/ completed_rings /
skipped / gates(每环 cmd+exit+evidence)/ paths / backprop_budget_left。
写入由 CLI 做 schema 校验,防手写漂移。

- **粒度 = 环间续跑**:状态只记录"已完成到哪一环",不承诺环内恢复(环是 fresh 子代理,环内失败已靠失败报告交接)。
- 机读 JSON 亦人类可读 = 审计轨迹(补 git 阶段提交在非 git 项目下的空缺)。

## 下游回传(预算化)

G3/G4 失败且判定为功能缺陷(非测试盲区)→ 携失败证据派 coder 修复,复跑失败环及其后所有门禁。
回传预算整个 feature ≤ 2 次,超限中止交回用户。G3 失败若判定为测试盲区 → 仍由 reinforcer 同环重试,不回传。

## 纪律

- 门禁命令一律从 `quality.yml` 读,不猜测、不替换。
- 状态文件由主会话维护,执行 agent 不写(它们只产出代码与测试)。
- 每环交付必须有门禁证据(退出码 + 输出),证据先于"完成"声明。
