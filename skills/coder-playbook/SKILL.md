---
description: Use when implementing a feature and its unit tests from a confirmed Gherkin spec, until the project's quality gates pass. Loaded by the coder agent before its first assignment.
---

# Coder Playbook — 按规格实现 + 验证纪律

从 `spec.feature` 实现功能并编写单元测试,直到该语言门禁全绿。

## 执行序列

1. 读 `spec.feature` 与 `qa-flow.md`,理解行为与预期结果;不写实现细节。
2. 从项目 `.omp/quality.yml` 读该语言的 `test` 与 `arch` 命令(唯一事实源,不猜测、不替换)。
3. 一次只处理一个模块的一个功能点;先复现/理解现状再动手。
4. 实现 + 单元测试。允许先写实现再补测试,不强制 TDD 节奏。
5. **实跑验证**:自跑 `test` 命令,亲眼看退出码与输出——证据先于断言,不凭推理宣称绿。
6. `arch` 命令复核,确认结构约束未破坏。
7. 门禁失败 → 先复现根因再改,自查修复上限 3 轮;改后必重跑验证。

## 纪律

- 命令一律从 `quality.yml` 读,不猜测、不替换命令。
- **证据先于断言**:任何"完成"必须由实跑输出支撑,自报不算。
- 文件范围克制:只动该功能点相关文件,不顺手重构无关代码。
- 不追求代码风格——风格由下游 cleaner 处理。
- output 如实上报 `files_changed` / `test_cmd` / `gate_results`(真实退出码)。
