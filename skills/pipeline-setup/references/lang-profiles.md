# 语言 → 候选门禁命令建议表

pipeline-setup 技能第 0 步探测时引用。**全部为"建议,非断言"**——只作问答草稿的推荐默认值,
最终以用户问答确认、写入 `.omp/quality.yml` 的为准;quality.yml 是门禁唯一事实源。
表外语言:从项目已有配置推导候选命令(package.json scripts / setup.cfg / 已有测试目录),
推不出来则问答留空由用户手填,`doctor` 兜底校验工具在位性。

`null` = 该语言不启用该维度门禁(对应环跳过:如 mutation:null → reinforcer 跳过并上报 skipped_reason)。

命令一律用**占位符**表达随 feature 变化的部分(`{diff_source_paths}` 源码 / `{diff_test_paths}` 测试,
由主会话执行门禁前从 git diff 注入;`{spec_path}`/`{qa_flow_path}` 由 spec-definer output 代入),
**不写死具体文件路径**——这样 quality.yml 对所有 feature 稳定。空集时主会话用整目录兜底或跳过并在报告中说明。

| 语言 | 构建文件 | test | coverage | complexity | mutation | arch/lint |
|---|---|---|---|---|---|---|
| python | pyproject.toml / setup.py / requirements.txt | `pytest {diff_test_paths} -q` | `coverage run -m pytest {diff_test_paths}` | `ai-coding-qa-pipeline crap-check --threshold 6 {diff_source_paths}` | `mutmut run --paths-to-mutate={diff_source_paths}` | `lint-imports`(import-linter 契约) |
| shell | — | `bats {diff_test_paths}` | `null` | `null`(shell 无通用复杂度工具,该维度门禁不启用;复杂 shell 用 shellcheck lint 兜底) | `null`(二期选型) | `shellcheck {diff_source_paths}` |
| java | pom.xml / build.gradle | `mvn -q test` | `mvn -q org.jacoco:jacoco-maven-plugin:check` | `mvn -q pmd:check`(cyclomatic/NPath 规则,阈值配 PMD ruleset) | `mvn -q org.pitest:pitest-maven:mutationCoverage -DwithHistory` | `mvn -q arch-unit` |
| typescript | package.json / tsconfig.json | `npm test` | `vitest run --coverage`(jest/其他框架按其 CLI) | `eslint --rule 'complexity: [error, 10]' {diff_source_paths}`(eslint 内置 cyclomatic 规则) | `stryker run` | `depcruise {diff_source_paths}`(dependency-cruiser 依赖约束)/ `eslint {diff_source_paths}` lint |
| go | go.mod | `go test ./...` | `go test -cover ./...` | `gocyclo -over 10 {diff_source_paths}`(Gocyclo 圈复杂度) | `gremlins` | `go vet {diff_source_paths}` / depguard |
| rust | Cargo.toml | `cargo test` | `cargo llvm-cov` | `cargo clippy -- -W clippy::cognitive_complexity`(官方认知复杂度 lint) | `cargo-mutants` | `cargo clippy`(全量 lint) |

## 使用要点

- Q4 变异工具:Python 推荐 `mutmut`;无对应工具的语言默认 `null`(告知后果 = 对应环 G3 跳过)。
- Q3 架构约束:有契约文件直接采用;没有时 Python 推荐 import-linter 模板初始化。
- CRAP 公式语言无关(comp²×(1−cov/100)³+comp,即复杂度×覆盖率联合惩罚),**当前插件仅实现
  Python 数据源**(crap-check 组合 radon cc + coverage.py 输出)。其他语言的复杂度门禁用各自标准工具
  (见上表:java=PMD cyclomatic、ts=eslint complexity、go=gocyclo、rust=clippy cognitive_complexity),
  阈值在 quality.yml 的命令参数里配——语义等价(复杂度超阈值即失败),只是在覆盖率 100% 目标下
  联合惩罚项退化,故不扩展 CRAP 到多语言。
