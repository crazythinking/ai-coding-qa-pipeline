# ai-coding-qa-pipeline

omp(Oh My Pi)六-agent 开发流水线的**可分发组件**:agent 定义 + 门禁 CLI。
设计文档:仓库内 `omp-profile-agents-design.md`(§3、§5、§6、§7)。

## 组成

```
agents/*.md            6 个流水线 agent(spec-definer/coder/cleaner/architect/reinforcer/qa-runner)
bin/ai-coding-qa-pipeline.ts    门禁 CLI(bun 运行,@cucumber/gherkin 官方解析器)
skills/                pipeline-setup(初始化)+ orchestrator-playbook(主会话编排)+ coder/cleaner/reinforcer/qa-runner 四份 playbook
```

agent 正文只引用项目级 `.omp/quality.yml`(不写死路径);门禁命令由本 CLI 提供,项目内零脚本。
四个执行 agent 经 frontmatter `autoload-skills` 挂各自 playbook,派发前自动加载;主会话(编排者)按 `orchestrator-playbook` 描述触发加载,承担编排、门禁执行与编排状态读写。

## 安装(每台 omp 实例一次)

```bash
bun install                                 # 先装插件自身依赖(@cucumber/gherkin、yaml)
omp plugin link /path/to/ai-coding-qa-pipeline       # agents 全局分发(发布后: omp install npm:ai-coding-qa-pipeline)
bun link                                    # 门禁 CLI 进 PATH(发布后: bun add -g ai-coding-qa-pipeline)
```

## 初始化质量配置(setup)

项目首次接入,或在已有项目上新增语言依赖,在 **omp 会话 TUI** 里对主会话说"初始化质量配置"(或"加个语言门禁")。
主会话匹配 `pipeline-setup` 技能,按设计 §5.1 协议执行:

1. 只读探测:构建文件 / 测试目录 / 已有工具配置,产出候选语言+候选命令草稿,不回填不落盘
2. 问答:确认语言与各门禁命令(默认值来自 `skills/pipeline-setup/references/lang-profiles.md` 建议表,标注"建议非断言")
3. 生成:渲染 `.omp/quality.yml` 全文,展示给用户过目确认后才写
4. 冒烟:`ai-coding-qa-pipeline doctor` 逐条查工具在位性,全 OK 才落盘

已有 quality.yml 时走**增量更新**:只问新增/移除语言,未确认节原样保留。
命令行只承担确定性子步;向导本体是技能(主会话驱动,`/extensions` 可审计)。

## 门禁命令

```bash
ai-coding-qa-pipeline spec-check <spec.feature> <qa-flow.md>          # G0:L1语法+L2结构+qa-flow模板
ai-coding-qa-pipeline crap-check [--threshold N] [paths...]           # CRAP组合器(radon+coverage;文件或目录)
ai-coding-qa-pipeline doctor [quality.yml路径]                        # §5.1冒烟验证:按声明查门禁工具在位性
ai-coding-qa-pipeline pipeline-state read|update <state.json> [json]  # ADR-0001 编排状态读写:环间恢复+审计
```

退出码:0=通过;1=不合格;2=参数/依赖错误(**环境问题**——主会话不应重试 agent,应装工具或把该门禁置 null 后重跑 doctor)。

## 依赖与缺失处理

三类依赖,归属不同:

| 依赖 | 归属 | 缺失处理 |
|---|---|---|
| 插件自身(@cucumber/gherkin、yaml、bun 运行时) | 随插件 `bun install` | CLI 起不来=环境错误,重装插件依赖 |
| 机器级门禁工具(pytest/mutmut/radon/coverage/bats/shellcheck/mvn…) | **不随插件分发**,由各项目 quality.yml 声明 | `ai-coding-qa-pipeline doctor` 逐条检查并给安装提示;运行期门禁 exit=2=环境问题 |
| 语言工具链差异 | quality.yml 声明式适配(java→mvn,shell→bats),插件零语言假设 | doctor 按声明检查,哪条缺失报哪条 |

新项目/新环境接入流水线第一步:在 omp TUI 里触发 `pipeline-setup` 技能生成 `.omp/quality.yml`,再 `ai-coding-qa-pipeline doctor` 冒烟;缺失项要么安装,要么把该语言该门禁声明为 null(设计 §5:某语言 mutation: null → reinforcer 跳过)。

## quality.yml 用法

完整案例见 `skills/pipeline-setup/SKILL.md`(第 2 步生成,分发自包含)。要点:

```yaml
spec:                                    # G0 规格门禁(主会话派发 spec-definer 后亲自跑)
  check: ai-coding-qa-pipeline spec-check {spec_path} {qa_flow_path}
languages:
  python:
    test: pytest {diff_test_paths} -q
    complexity: ai-coding-qa-pipeline crap-check --threshold 6 {diff_source_paths}
    mutation: mutmut run --paths-to-mutate={diff_source_paths}
```

占位符由主会话执行门禁时注入,quality.yml 对所有 feature 稳定、不写死具体文件路径:

- `{spec_path}`/`{qa_flow_path}` — 主会话从 spec-definer 的 output schema 代入
- `{diff_source_paths}`/`{diff_test_paths}` — 主会话执行前从 `git diff` 计算本次 feature 的源码/测试文件集代入

## 验证

```bash
ai-coding-qa-pipeline spec-check <好spec> <好qa-flow>   # exit=0 PASS
ai-coding-qa-pipeline spec-check <坏spec> <好qa-flow>   # exit=1,列出缺的步骤家族
```

## 开发

- 改 agent 正文后:`omp plugin link` 重链(或重启会话使发现刷新);改技能后 `/reload-plugins`。
- 改 qa-flow 模板时,`bin/ai-coding-qa-pipeline.ts` 的 `REQUIRED_QA_HEADER` 与 spec-definer.md 正文模板**必须同步**。
- 四个执行 agent 经 `autoload-skills` 挂 `skills/*-playbook/SKILL.md`;改技能与 agent 正文时避免同一规则两处表述(双源漂移)。
- 门禁命令改动后必须实测合法/非法两路(教训:gherkin-lint 无配置 exit=0 零检查,已弃用)。