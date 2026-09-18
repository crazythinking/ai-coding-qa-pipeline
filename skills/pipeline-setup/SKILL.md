---
description: Use when initializing ai-coding-qa-pipeline quality gates for a project (detect languages, confirm gate commands, generate .omp/quality.yml), or when adding a new language dependency to an existing project. Trigger words: 初始化质量配置 / 接入流水线 / 加个语言门禁.
---

# Pipeline Setup — 初始化 / 更新项目质量门禁

项目首次接入 ai-coding-qa-pipeline、或使用中要新增语言依赖时,按本流程生成 `.omp/quality.yml`。
它是门禁的唯一事实源:agent 不猜测,所有命令一律从这里读。

## 触发场景

- 项目缺 `.omp/quality.yml`(首次接入;或编排流程第 1 步读到缺失时)
- 已有 quality.yml,但使用过程中要新增语言依赖

## 流程(设计文档 §5.1 协议)

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
