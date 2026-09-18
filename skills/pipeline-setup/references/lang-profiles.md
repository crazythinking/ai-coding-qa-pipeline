# 语言 → 候选门禁命令建议表

pipeline-setup 技能第 0 步探测时引用。**全部为"建议,非断言"**——只作问答草稿的推荐默认值,
最终以用户问答确认、写入 `.omp/quality.yml` 的为准;quality.yml 是门禁唯一事实源。
表外语言:从项目已有配置推导候选命令(package.json scripts / setup.cfg / 已有测试目录),
推不出来则问答留空由用户手填,`doctor` 兜底校验工具在位性。

`null` = 该语言不启用该维度门禁(对应环跳过,见设计 §5)。

| 语言 | 构建文件 | test | coverage | complexity | mutation | arch/lint |
|---|---|---|---|---|---|---|
| python | pyproject.toml / setup.py / requirements.txt | `pytest tests/ -q` | `pytest --cov=<src> --cov-report=term-missing` | `ai-coding-qa-pipeline crap-check --threshold 6` | `mutmut run` | `lint-imports`(import-linter 契约) |
| shell | — | `bats tests/shell/` | `null` | `null`(CRAP 仅 Python 强制,其他语言在 yml 注明替代指标) | `null`(二期选型) | `shellcheck scripts/**/*.sh` |
| java | pom.xml / build.gradle | `mvn test` | 按构建插件(jacoco 等) | 按替代指标声明 | `pitest` 或 `null` | 依赖约束工具 |
| typescript(预留) | package.json / tsconfig.json | `npm test` | 按框架 | 替代指标 | `stryker` | `eslint .` / dependency-cruiser |
| go(预留) | go.mod | `go test ./...` | `go test -cover ./...` | 替代指标 | `gremlins` | `go vet ./...` / depguard |
| rust(预留) | Cargo.toml | `cargo test` | `cargo llvm-cov` | 替代指标 | `cargo-mutants` | `cargo clippy` |

## 使用要点

- Q4 变异工具:Python 推荐 `mutmut`;无对应工具的语言默认 `null`(告知后果 = 对应环 G3 跳过)。
- Q3 架构约束:有契约文件直接采用;没有时 Python 推荐 import-linter 模板初始化。
- CRAP 公式仅 Python 强制:comp²×(1−cov/100)³+comp;其他语言 complexity 用替代指标并注明。
