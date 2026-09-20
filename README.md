# ai-coding-qa-pipeline

omp(Oh My Pi)六-agent 开发流水线的**完整插件**:agent 定义 + 门禁 CLI + extension 工具。
设计文档:仓库内 `omp-profile-agents-design.md`(§3、§5、§6、§7)。

## 组成

```
agents/*.md            6 个流水线 agent(spec-definer/coder/cleaner/architect/reinforcer/qa-runner)
bin/ai-coding-qa-pipeline.ts    门禁 CLI 薄壳(bun 运行,@cucumber/gherkin 官方解析器)
extensions/index.ts    omp extension:注册 4 个门禁工具(qa_spec_check/qa_crap_check/qa_doctor/qa_pipeline_state)
src/gates.ts           门禁核心逻辑(纯函数,CLI 与 extension 工具共用,行为一致)
skills/                pipeline-setup(初始化)+ orchestrator-playbook(主会话编排)+ coder/cleaner/reinforcer/qa-runner 四份 playbook
```

agent 正文只引用项目级 `.omp/quality.yml`(不写死路径);门禁由插件提供(工具优先,CLI 等价),项目内零脚本。
四个执行 agent 经 frontmatter `autoload-skills` 挂各自 playbook,派发前自动加载;主会话(编排者)按 `orchestrator-playbook` 描述触发加载,承担编排、门禁执行与编排状态读写。

## 安装(每台 omp 实例一次,一步到位)

```bash
omp plugin install ai-coding-qa-pipeline        # 发布后(npm):agents/skills/tools 全部就位,免 bun link
# 本地 tarball / 目录: omp plugin install /path/to/ai-coding-qa-pipeline-0.1.0.tgz
```

安装即得:6 个 agent 全局可用、4 个门禁工具注册(主会话直接调用,无需 CLI 进 PATH)、skills 可被技能发现。
不需要再单独 `bun link` —— 旧的两段式(link + bun link)已由单步 `omp plugin install` 取代。

## 初始化质量配置(setup)

项目首次接入,或在已有项目上新增语言依赖,在 **omp 会话 TUI** 里对主会话说"初始化质量配置"(或"加个语言门禁")。
主会话匹配 `pipeline-setup` 技能,按设计 §5.1 协议执行:

1. 只读探测:构建文件 / 测试目录 / 已有工具配置,产出候选语言+候选命令草稿,不回填不落盘
2. 问答:确认语言与各门禁命令(默认值来自 `skills/pipeline-setup/references/lang-profiles.md` 建议表,标注"建议非断言")
3. 生成:渲染 `.omp/quality.yml` 全文,展示给用户过目确认后才写
4. 冒烟:`qa_doctor`(或 `ai-coding-qa-pipeline doctor`)逐条查工具在位性,全 OK 才落盘

已有 quality.yml 时走**增量更新**:只问新增/移除语言,未确认节原样保留。
命令行只承担确定性子步;向导本体是技能(主会话驱动,`/extensions` 可审计)。

## 门禁:工具与 CLI 等价

插件安装后注册 4 个门禁工具(主会话/agent 在会话内直接调用,无需 PATH);CLI 为等价薄壳,供独立场景或工具不可用时回退:

| 门禁 | extension 工具(推荐) | 等价 CLI |
|---|---|---|
| G0 规格 | `qa_spec_check` `spec_path`+`qa_flow_path` | `ai-coding-qa-pipeline spec-check <spec.feature> <qa-flow.md>` |
| CRAP 复杂度 | `qa_crap_check` `threshold`(可选)+`paths`(可选) | `ai-coding-qa-pipeline crap-check [--threshold N] [paths...]` |
| 环境冒烟 | `qa_doctor` `quality_yml_path`(可选) | `ai-coding-qa-pipeline doctor [quality.yml路径]` |
| 编排状态 | `qa_pipeline_state` `op`+`state_path`(+`json`) | `ai-coding-qa-pipeline pipeline-state read\|update <state.json> [json]` |

两者共享同一套核心逻辑(`src/gates.ts`),行为一致。退出码语义:`details.exitCode` / CLI 退出码 ——
0=通过;1=不合格;2=参数/依赖错误(**环境问题**——主会话不应重试 agent,应装工具或把该门禁置 null 后重跑 doctor)。

## 依赖与缺失处理

三类依赖,归属不同:

| 依赖 | 归属 | 缺失处理 |
|---|---|---|
| 插件自身(@cucumber/gherkin、yaml、bun 运行时) | 随插件 `bun install`(npm 分发时自动) | CLI/工具起不来=环境错误,重装插件依赖 |
| 机器级门禁工具(pytest/mutmut/radon/coverage/bats/shellcheck/mvn…) | **不随插件分发**,由各项目 quality.yml 声明 | `qa_doctor`(或 CLI doctor)逐条检查并给安装提示;运行期门禁 exit=2=环境问题 |
| 语言工具链差异 | quality.yml 声明式适配(java→mvn,shell→bats),插件零语言假设 | doctor 按声明检查,哪条缺失报哪条 |

新项目/新环境接入流水线第一步:在 omp TUI 里触发 `pipeline-setup` 技能生成 `.omp/quality.yml`,再 `qa_doctor` 冒烟;缺失项要么安装,要么把该语言该门禁声明为 null(设计 §5:某语言 mutation: null → reinforcer 跳过)。

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

quality.yml 命令字符串仍是协议事实源(doctor 按首词查在位性、CLI 可独立执行);主会话在会话内**优先用等价工具**(`qa_spec_check`/`qa_crap_check`/`qa_doctor`)执行同一门禁,占位符实参直接作为工具参数。

占位符由主会话执行门禁时注入,quality.yml 对所有 feature 稳定、不写死具体文件路径:

- `{spec_path}`/`{qa_flow_path}` — 主会话从 spec-definer 的 output schema 代入
- `{diff_source_paths}`/`{diff_test_paths}` — 主会话执行前从 `git diff` 计算本次 feature 的源码/测试文件集代入

## 验证

```bash
ai-coding-qa-pipeline spec-check <好spec> <好qa-flow>   # exit=0 PASS
ai-coding-qa-pipeline spec-check <坏spec> <好qa-flow>   # exit=1,列出缺的步骤家族
# 插件已装时,同一门禁经 qa_spec_check 工具调用,行为一致
```

## 开发

- 改 agent 正文 / extension / skill 后:`omp plugin install <tarball> --force` 重装(或重启会话使发现刷新)。
- 门禁逻辑在 `src/gates.ts`(单一事实源),`bin/` 薄壳与 `extensions/index.ts` 都复用它;改门禁只改 gates.ts。
- 改 qa-flow 模板时,`src/gates.ts` 的 `REQUIRED_QA_HEADER` 与 spec-definer.md 正文模板**必须同步**。
- 四个执行 agent 经 `autoload-skills` 挂 `skills/*-playbook/SKILL.md`;改技能与 agent 正文时避免同一规则两处表述(双源漂移)。
- 门禁改动后必须实测合法/非法两路(教训:gherkin-lint 无配置 exit=0 零检查,已弃用)。