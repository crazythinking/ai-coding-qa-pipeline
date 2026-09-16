# omp-pipeline

omp(Oh My Pi)六-agent 开发流水线的**可分发组件**:agent 定义 + 门禁 CLI。
设计文档:its 仓库 `docs/omp-profile-agents-design.md`(§3、§5、§6、§7)。

## 组成

```
agents/*.md            6 个流水线 agent(spec-definer/coder/cleaner/architect/reinforcer/qa-runner)
bin/omp-pipeline.ts    门禁 CLI(bun 运行,@cucumber/gherkin 官方解析器)
```

agent 正文只引用项目级 `.omp/quality.yml`(不写死路径);门禁命令由本 CLI 提供,项目内零脚本。

## 安装(每台 omp 实例一次)

```bash
bun install                                 # 先装插件自身依赖(@cucumber/gherkin、yaml)
omp plugin link /path/to/omp-pipeline       # agents 全局分发(发布后: omp install npm:omp-pipeline)
bun link                                    # 门禁 CLI 进 PATH(发布后: bun add -g omp-pipeline)
```

## 门禁命令

```bash
omp-pipeline spec-check <spec.feature> <qa-flow.md>          # G0:L1语法+L2结构+qa-flow模板
omp-pipeline crap-check [--threshold N] [paths...]           # CRAP组合器(radon+coverage)
omp-pipeline doctor [quality.yml路径]                        # §5.1冒烟验证:按声明查门禁工具在位性
```

退出码:0=通过;1=不合格;2=参数/依赖错误(**环境问题**——主会话不应重试 agent,应装工具或把该门禁置 null 后重跑 doctor)。

## 依赖与缺失处理

三类依赖,归属不同:

| 依赖 | 归属 | 缺失处理 |
|---|---|---|
| 插件自身(@cucumber/gherkin、yaml、bun 运行时) | 随插件 `bun install` | CLI 起不来=环境错误,重装插件依赖 |
| 机器级门禁工具(pytest/mutmut/radon/coverage/bats/shellcheck/mvn…) | **不随插件分发**,由各项目 quality.yml 声明 | `omp-pipeline doctor` 逐条检查并给安装提示;运行期门禁 exit=2=环境问题 |
| 语言工具链差异 | quality.yml 声明式适配(java→mvn,shell→bats),插件零语言假设 | doctor 按声明检查,哪条缺失报哪条 |

新项目/新环境接入流水线第一步:`omp-pipeline doctor`;缺失项要么安装,要么把该语言该门禁声明为 null(设计 §5:某语言 mutation: null → reinforcer 跳过)。

## quality.yml 用法

```yaml
spec:                                    # G0 规格门禁(主会话派发 spec-definer 后亲自跑)
  check: omp-pipeline spec-check {spec_path} {qa_flow_path}
languages:
  python:
    complexity: omp-pipeline crap-check --threshold 6
```

`{spec_path}`/`{qa_flow_path}` 由主会话从 spec-definer 的 output schema 代入。

## 验证

```bash
omp-pipeline spec-check <好spec> <好qa-flow>   # exit=0 PASS
omp-pipeline spec-check <坏spec> <好qa-flow>   # exit=1,列出缺的步骤家族
```

## 开发

- 改 agent 正文后:`omp plugin link` 重链(或重启会话使发现刷新)。
- 改 qa-flow 模板时,`bin/omp-pipeline.ts` 的 `REQUIRED_QA_HEADER` 与 spec-definer.md 正文模板**必须同步**。
- 门禁命令改动后必须实测合法/非法两路(教训:gherkin-lint 无配置 exit=0 零检查,已弃用)。