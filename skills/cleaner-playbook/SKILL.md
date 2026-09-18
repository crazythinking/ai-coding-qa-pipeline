---
description: Use when running CRAP complexity analysis and refactoring over-threshold functions after coding. Loaded by the cleaner agent before its first assignment.
---

# Cleaner Playbook — CRAP 复杂度重构

运行该语言 `complexity` 命令,对超阈值函数重构,直到全部达标。

## CRAP 公式

`CRAP = comp² × (1 − cov/100)³ + comp`(comp = 圈复杂度,cov = 覆盖率),threshold 默认 6。

## 执行序列

1. 从 `.omp/quality.yml` 读该语言 `complexity` 命令(如 `ai-coding-qa-pipeline crap-check --threshold 6`)。
2. 运行得超阈值函数清单,记录 `worst_crap_before`。
3. 逐函数重构:拆分函数、降低圈复杂度、消除重复代码、重命名不清晰标识符。
4. **每轮重构后复跑 `test` 与 `arch` 命令确认全绿**,再继续下一处。
5. 循环直到所有函数 CRAP ≤ 阈值;记录 `worst_crap_after` 与 `refactored_functions`。

## 职责边界

- 仅函数级重构:不跨模块搬移、不新建模块——结构工作归 architect。
- `structural_changes` 如实上报任何跨模块改动;**正常应为空,非空即异常信号**。

## 纪律

- 命令一律从 `quality.yml` 读,不猜测、不替换。
- 每轮重构后必实跑验证,证据先于断言。
- 不追求为降 CRAP 而破坏行为——`test`/`arch` 必须保持全绿。
