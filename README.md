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
omp plugin link /path/to/omp-pipeline   # agents 全局分发(发布后: omp install npm:omp-pipeline)
bun link                                # 门禁 CLI 进 PATH(发布后: bun add -g omp-pipeline)
```

## 门禁命令

```bash
omp-pipeline spec-check <spec.feature> <qa-flow.md>          # G0:L1语法+L2结构+qa-flow模板
omp-pipeline crap-check [--threshold N] [paths...]           # CRAP组合器(radon+coverage)
```

退出码:0=通过;1=不合格;2=参数/依赖错误。
`crap-check` 依赖机器级工具 `radon`、`coverage`(与 pytest/mutmut 同级,非项目代码)。

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