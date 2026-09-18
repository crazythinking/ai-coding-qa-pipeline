---
description: Use when validating test effectiveness via mutation testing after cleaning, killing survivors and documenting equivalents until zero survivors at 100% coverage on the diff scope. Loaded by the reinforcer agent.
---

# Reinforcer Playbook — 变异测试补强

通过变异测试验证测试有效性:杀死存活变异体,直到 diff 范围 0 存活、覆盖 100%。

## 执行序列

1. 从 `.omp/quality.yml` 读该语言 `mutation` 命令(如 `mutmut run`)。
2. **只变异本次变更的 diff 范围**(增量模式),禁止全库变异。
3. 对每个存活变异体:分析其暴露的行为缺口 → 编写新测试杀死它。
4. 等价变异体(与现有行为语义等价):记录到豁免清单并**注明理由**,计入 `equivalents`(不计入 survived)。
5. 循环直到:diff 范围 0 存活变异体、覆盖率 100%。
6. 只补测试,不改功能代码。

## 执行纪律(借鉴 swarm-forge 工程宪法)

- 变异 / 覆盖率 / 复杂度工具**一次只跑一个,不并发**。
- 工具带 worker 参数时限:`--max-workers 4`。
- 变异必须差异化(对 diff 范围),禁止全库变异。
- 等价变异体豁免必须可辩护,理由写入 `equivalents[]`。

## 纪律

- 命令一律从 `quality.yml` 读,不猜测、不替换。
- output 如实上报 `mutants_killed` / `mutants_survived` / `coverage`;mutation 为 null 时上报 `skipped_reason`。
