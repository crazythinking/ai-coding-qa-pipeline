---
description: Use when initializing ai-coding-qa-pipeline quality gates for a project (detect languages, confirm gate commands, generate .omp/quality.yml), or when adding a new language dependency to an existing project. Trigger words: 初始化质量配置 / 接入流水线 / 加个语言门禁.
---

# Pipeline Setup — 初始化 / 更新项目质量门禁

项目首次接入 ai-coding-qa-pipeline、或使用中要新增语言依赖时,按本流程生成 `.omp/quality.yml`。
它是门禁的唯一事实源:agent 不猜测,所有命令一律从这里读。

## 触发场景

- 项目缺 `.omp/quality.yml`(首次接入;或编排流程第 1 步读到缺失时)
- 已有 quality.yml,但使用过程中要新增语言依赖

## 流程(quality.yml 初始化协议,本技能自包含,不依赖外部设计文档)

### 第 0 步 探测(只读,主会话亲自做)

识别候选语言与候选命令,**只作问答草稿,不写入任何文件**:

- 构建文件:`pyproject.toml`(python)、`pom.xml`/`build.gradle`(java)、`package.json`(node/ts)、`go.mod`(go)、`Cargo.toml`(rust);无清单但存在大量 `*.sh` → shell
- 测试目录:`tests/`、`src/test/`、`spec/`
- 已有工具配置:`setup.cfg`、import-linter 契约、`.pitest`、`.eslintrc` 等
- 工具在位性:`which <候选命令首词>`(pytest / mutmut / bats / shellcheck / mvn / …)

产出:候选语言清单 + 每语言候选命令。候选来自 `references/lang-profiles.md` 建议表 + 项目已有配置推导,逐条标注"建议,非断言"。

### 第 1 步 问答(每题给推荐默认值,用户可回车/口述采纳)

- Q1 本项目启用哪些语言?(候选清单多选;可补录扫描未检测到的、准备引入的语言)
- Q2 各语言的测试命令?(默认 = 建议表候选或项目已有配置)
- Q3 架构约束命令?(有契约文件 → 直接采用;没有 → 问是否初始化,Python 推荐 import-linter 模板)
- Q4 变异测试工具?(Python 推荐 mutmut;无对应工具的语言默认 `null` 并告知后果 = G3 跳过)
- Q5 e2e 验证交互面?(`cli` | `http` | `playwright` | `null`;运维脚本类推荐 cli,无系统级验证面选 null = G4 跳过)
- Q6 scope 与阈值?(推荐 `diff` / `6` / `100`)

原则:探测只产生候选,决定权在问答——**禁止"探测后回填"**。

### 第 2 步 生成

按问答结果生成 `.omp/quality.yml` 全文,展示给用户过目确认后才写入。

生成时遵循**占位符约定**:命令一律用占位符表达"随 feature 变化"的量,**不得写死具体文件路径**——
这样 quality.yml 对项目的所有 feature 稳定,只有每个 feature 实际改了哪些文件(由主会话从 git diff 计算)在跑门禁时注入。占位符:

| 占位符 | 含义 | 由谁注入 |
|---|---|---|
| `{spec_path}` / `{qa_flow_path}` | 本次 spec-definer 产出的规格/QA流程路径 | 主会话从 spec-definer output 代入 |
| `{diff_source_paths}` | 本次 feature diff 的源码文件(非测试) | 主会话执行门禁前从 `git diff` 计算 |
| `{diff_test_paths}` | 本次 feature diff 的测试文件 | 同上 |

**quality.yml 完整案例**(占位符版,分发用):

```yaml
scope: diff            # 门禁只对 diff 范围生效(由占位符注入)
crap_threshold: 6      # Agent 标准(人类 4)
coverage_target: 100
architect_signal:      # architect 派发阈值(§6 触发信号)
  new_files: 3         # 新建文件数≥3
  modules_touched: 3   # 触碰顶层模块数≥3
e2e: cli               # qa-runner 交互面: cli|http|playwright|null(null=G4跳过,终点G3)
spec:                  # G0 规格门禁(主会话派发 spec-definer 后亲自跑)
  check: ai-coding-qa-pipeline spec-check {spec_path} {qa_flow_path}
languages:
  python:
    test: pytest {diff_test_paths} -q
    coverage: coverage run -m pytest {diff_test_paths}
    complexity: ai-coding-qa-pipeline crap-check --threshold 6 {diff_source_paths}
    mutation: mutmut run --paths-to-mutate={diff_source_paths}
    arch: lint-imports
  shell:
    test: bats {diff_test_paths}
    lint: shellcheck {diff_source_paths}
    mutation: null      # 该语言不启用变异门禁 → reinforcer 跳过并上报 skipped_reason
```

- `{diff_source_paths}` / `{diff_test_paths}` 为空时(如 feature 只改了测试),对应门禁用整目录兜底或跳过,主会话决策并在报告中说明。
- 命令首词必须是可在 PATH 找到的工具(doctor 按此校验在位性)。

### 第 3 步 冒烟验证

运行 `ai-coding-qa-pipeline doctor`(逐条查每条非 null 命令的工具在位性):

- 逐条报 `[OK]` / `[MISSING(含安装提示)]` / `[SKIP(null)]`
- 缺失项回问答修正(装工具或置 null);全部 OK 才落盘
- `doctor` exit=2 = 环境问题,不重试 agent,直接报环境

## 更新模式(已有 quality.yml)

增量 diff:对比现有已声明语言 vs 本次扫描候选,**只问新增 / 移除项**,未确认节原样保留;diff 预览后确认。不覆盖未确认的节。

## 原则

- quality.yml 是门禁唯一事实源,agent 不猜测
- 产物纳入版本管理(quality.yml 应进 git)
- 确定性优先:命令必须在位、可两路实测(好 exit=0 / 坏 exit≠0)才准入
- **分发自包含**:本技能作为插件分发时,用户机器上没有设计文档——协议、quality.yml 完整案例、
  占位符约定等一切约定必须直接写在本技能内,禁止"见设计文档 §X"式引用。命令一律用占位符,
  不写死具体 feature 文件路径。
