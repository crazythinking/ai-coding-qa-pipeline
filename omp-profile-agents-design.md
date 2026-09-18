# 基于omp原生task agent的六Agent开发流水线设计(v2)

> 依据文档:`docs/确保AI代码质量的核心策略.md`(Uncle Bob多Agent流水线)
> 平台:本地omp(Oh My Pi)v18.1.16的**原生task agent机制**
> 版本:v2,取代v1(profile方案,已废弃)
> 状态:设计定稿(待实施)

---

## 0. v1→v2变更记录(架构决策)

| 决策点 | v1(已废弃) | v2(定稿) | 依据 |
|---|---|---|---|
| 隔离载体 | 5个omp profile | 1个profile + 5个**原生task agent** | omp子代理与父会话同进程同profile,无法跨profile派生(`executor.ts:3327-3412`);角色隔离由agent frontmatter实现 |
| 编排方式 | 外层bash脚本串5个进程 | **主会话即编排者**,用内置`task`工具逐环派发 | 用户决策:用omp自身能力串接;omp原生orchestrate契约即为此设计 |
| 适用范围 | 单项目(Python) | **本机全局**,多语言(Python/Java/Shell,预留TS/Go/Rust) | 用户决策 |
| 门禁声明 | 硬编码pytest/mutmut | 项目级`.omp/quality.yml`声明工具链命令 | 确定性优先于提示词;新语言零改agent定义 |
| 存量代码 | 未明确 | 门禁只对**diff范围**生效 | 文档增量变异实践;用户确认 |
| 认证 | 误判为需per-profile处理 | `~/.omp/.env`全局共享,零处理 | 实测:6个环境变量含OMNIROUTE_API_KEY,所有profile/进程共享 |
| 配置分发 | profile生成器脚本 | 不再需要 | agent定义是自包含的md文件 |
| 工具脚本载体 | 项目仓库(scripts/python/spec_check.py、crap_check.py) | **独立插件项目`ai-coding-qa-pipeline`**(agents+门禁CLI,2026-09-16重构) | 用户决策:需跨omp实例分发;仓库内脚本只在单项目有效,换项目即废 |

## 1. omp原生机制调研结论(已验证,file:line见附录A)

1. **自定义task agent** = Markdown + YAML frontmatter,放`~/.omp/agent/agents/*.md`(用户级,本机所有项目可用;项目级`.omp/agents/`优先级更高,可覆盖)。frontmatter字段:`name`、`description`、`tools:`(白名单CSV)、`model:`(角色别名如`"@slow"`)、`spawns:`(可派生谁)、`blocking:`(内联阻塞返回)、`output:`(JSON schema结构化输出)。
2. **task工具**:主会话内`tasks[]`批量派生,支持`agent`、`task`指令、`effort`;`blocking: true`同步收果。父子/兄弟经`hub`工具互发消息。
3. **系统提示词**:agent定义正文即子代理system prompt(经`subagent-system-prompt.md`包裹渲染);`tools:`白名单进一步裁剪工具面、禁MCP/扩展。
4. **同profile限制**:子代理继承父会话的authStorage/modelRegistry/settings,无per-spawn profile字段——这是放弃profile方案的直接原因。

## 2. 总体架构

```
用户(omp主会话): "开发 feature-x"(按需求文档走完整开发流程;质量门禁是流程内嵌机制,不是独立阶段)
  │
  │ 主会话 = 编排者(读 .omp/quality.yml,逐环派发,验证门禁,推进)
  ▼
[task#1 spec-definer]──Gherkin+QA流程──▶ G0:格式门禁──▶ ★人类审查规格(语义,唯一必经人工卡点)
  ▼ (确认后)
[task#2 coder]────代码+测试────▶ 门禁G1: test命令全绿 + arch命令通过
  ▼
[task#3 cleaner]───函数级重构───▶ 门禁G2: CRAP≤threshold + G1复跑
  ▼
[task#4 architect]──结构修正────▶ 门禁G5: arch+test通过 ——有条件派发:仅当
  ▼                              结构信号触发(见§6),否则跳过
[task#5 reinforcer]─补强测试───▶ 门禁G3: 变异0存活(diff范围) + 覆盖率100%
  ▼ (仅e2e非null)
[task#6 qa-runner]──结论────────▶ 门禁G4: 端到端验证退出码0(交互面由quality.yml的e2e声明)
  ▼
主会话汇总:每环结构化output + 门禁证据 → 最终通过/失败报告
```

要点:

- **6个agent均`blocking: true`且不设`spawns`**(流水线推进权只在主会话,agent本身不能再派生,防失控)。常见路径5环(architect跳过),大变更时6环。
- **产物交接面**:`.scratch/<feature>/`(spec.feature、qa-flow.md、门禁报告),规格短暂性——不进版本库。
- **架构约束**(import-linter/ArchUnit等)作为门禁命令列入quality.yml的`arch`,G1/G2/G5复跑,违反即失败——agent必须修,无"建议"空间;约束文件由人类掌管,architect修改时人类在下一环前知悉。
- **模型分档**经`model:`角色别名映射到现有omniroute池(§4),认证经`~/.omp/.env`全局生效。

## 3. 六个Agent定义(`~/.omp/agent/agents/*.md`)

### ① spec-definer.md(规格定义器)

```markdown
---
name: spec-definer
description: 将需求文档转换为Gherkin规格和QA流程文档。在需要对需求建立机器可验证规格时使用。
model: "@slow"
tools: read, write
blocking: true
---
将需求文档转换为两份文件:
1. spec.feature — Gherkin格式,每个场景必须包含前置条件、操作步骤、预期结果。
2. qa-flow.md — 从用户视角描述界面操作序列与验证点,每步确定性、可重复。
只描述行为和预期结果,不写任何实现细节(不提数据库、API、组件)。
输出目录:.scratch/<feature>/
```

- `output:` schema:`{spec_path, qa_flow_path, scenario_count}`
- 门禁G0(2026-09-16增设,修订原"无门禁(人类审规格即门禁)"):格式由命令机器卡,**人类审规格降级为纯语义卡点**(L3)
  - 单命令:`ai-coding-qa-pipeline spec-check {spec_path} {qa_flow_path}`(插件ai-coding-qa-pipeline的全局CLI,内部用官方@cucumber/gherkin解析:L1语法+L2结构+qa-flow模板一体;零项目路径)
  - scenario_count 对账:spec-check输出 `scenario_count=N`,主会话与agent自报值比对,不一致即门禁失败(防谎报)
  - 演变(2026-09-16):初版为两条命令(gherkin-utils全局安装 + 仓库内spec_check.py),插件化时合并进插件CLI
  - 选型教训:`gherkin-lint` 无`.gherkin-lintrc`时**exit=0零检查**放行一切,弃用;`gherkin-utils --no-ansi`在12.x不存在致好文件也exit=1;门禁命令必须实测过合法/非法两路才准入

### ② coder.md(编码器)

```markdown
---
name: coder
description: 根据Gherkin规格实现功能代码和单元测试,直到门禁全绿。在规格已确认后使用。
model: "@default"
tools: read, write, edit, bash, grep, glob
autoload-skills: [coder-playbook]
blocking: true
---
根据.spec.feature实现功能并编写单元测试。
完成标准(确定性,全部满足才算完成):
1. quality.yml中该语言的test命令退出码0
2. arch命令退出码0
不追求代码风格,风格由下游cleaner处理。一次只处理一个模块的一个功能点。
允许先写实现再补测试,不强制TDD节奏。
```

- `output:` schema:`{files_changed[], test_cmd, gate_results}`
- 门禁G1失败→自查修复(上限3轮,由主会话控制)

### ③ cleaner.md(清理器)

```markdown
---
name: cleaner
description: 运行CRAP复杂度分析并重构超标函数。在coder完成后使用。
model: "@slow"
tools: read, write, edit, bash, grep, glob
autoload-skills: [cleaner-playbook]
blocking: true
---
运行quality.yml中该语言的complexity命令(CRAP = comp²×(1-cov/100)³+comp)。
对CRAP分数超过threshold(默认6)的函数重构:拆分函数、降低圈复杂度、
消除重复代码、重命名不清晰标识符。
每轮重构后复跑test与arch命令确认全绿。循环直到所有函数CRAP≤阈值。
```

- `output:` schema:`{worst_crap_before, worst_crap_after, refactored_functions[], structural_changes[]}`
- 门禁G2:complexity命令无超标项 + test/arch复跑通过
- 职责边界:仅函数级重构,不跨模块搬移、不新建模块——结构工作归⑤architect(触发条件见§6)

### ④ architect.md(架构师,有条件派发)

```markdown
---
name: architect
description: 模块边界与依赖方向的主动式结构修正。仅在主会话检测到结构信号时派发,不是每环必经。
model: "@slow"
tools: read, write, edit, bash, grep, glob
blocking: true
---
负责确定性门禁测不出的结构问题:模块拆分(上帝模块)、新代码的边界落位、
依赖方向修正(依赖反转/提取接口)、消除合法但不合理的依赖。
完成标准(全部确定性命令):
1. arch命令退出码0(约束文件全绿,含新增约束)
2. test命令退出码0(结构重构不改变行为)
3. 可依赖度复核:对新引入的模块间依赖,给出"为什么合理"的一句话说明
不追求CRAP指标——那是cleaner的职责;本agent只管模块间结构。
```

- `output:` schema:`{modules_moved[], new_modules[], deps_inverted[], constraint_updates[]}`
- 门禁G5:arch命令通过 + test复跑通过 + (若约束文件被修改)人类在下一环前知悉

### ⑤ reinforcer.md(强化器)

```markdown
---
name: reinforcer
description: 通过变异测试验证测试有效性,补齐盲区。在cleaner完成后使用。
model: "@default"
tools: read, write, edit, bash, grep, glob
autoload-skills: [reinforcer-playbook]
blocking: true
---
运行quality.yml中该语言的mutation命令。
对每个存活变异体,编写新测试将其杀死;等价变异体记录到豁免清单并注明理由。
循环直到:diff范围内0存活变异体、覆盖率100%。
只补测试,不改功能代码。优先使用增量模式(只变异本次变更的代码)。
执行纪律(借鉴swarm-forge工程宪法):变异/覆盖率/复杂度工具一次只跑一个,不并发;
工具带worker参数时限--max-workers 4;变异必须差异化(对diff范围),禁止全库变异。
```

- `output:` schema:`{mutants_killed, mutants_survived, equivalents[], coverage}`
- 门禁G3:survived=0(豁免除外)+ coverage=100%,**仅限diff范围**

### ⑥ qa-runner.md(QA Agent,端到端验证,交互面可配置)

```markdown
---
name: qa-runner
description: 将QA流程文档转为可执行端到端验证并运行,从真实使用者视角证明系统整体行为正确。仅当quality.yml声明e2e交互面(非null)时使用。
model: "@default"
tools: read, write, edit, bash, grep, glob
autoload-skills: [qa-runner-playbook]
blocking: true
---
将qa-flow.md转换为端到端验证并执行。交互面由quality.yml的e2e声明决定:
- cli面:以真实使用者参数执行命令,断言stdout/stderr、退出码、文件与状态副作用
  (运维脚本的"用户视角"=按文档敲命令能得到文档说的结果)
- http面:发送真实请求,断言响应体、状态码与状态变化
- playwright面(UI):以意图定位(get_by_role/get_by_text)驱动页面,禁止脆弱的CSS选择器
脚本必须确定性:不依赖随机数据或时序;每步有明确预期结果。
输出确定性的通过/失败结论;失败时报告具体步骤、预期与实际差异、证据(cli输出/截图)。
```

- `output:` schema:`{e2e_type, status, steps_passed, steps_failed[], evidence[]}`
- 门禁G4:验证脚本退出码0
- 重定位说明:原设计限定"仅UI",经分析过窄——qa-runner的本质是"系统级端到端验证",
  "用户视角"由被测对象的交互面决定(见§8);运维脚本项目的cli面正是其最有价值的验证层

## 4. 模型分档与工具面

| agent | model角色 | 映射(现有config.yml) | 理由 |
|---|---|---|---|
| spec-definer | @slow | kimi-k3 | 中文规格写作质量优先 |
| coder | @default | deepseek-v4-flash | 模式化编码;难任务主会话可临时升档@slow |
| cleaner | @slow | kimi-k3 | 重构需较强推理 |
| architect | @slow | kimi-k3 | 结构推理(模块拆分/依赖方向)需较强推理;触发频率低,成本可控 |
| reinforcer | @default | deepseek-v4-flash | 补测试模式化;难杀变异体升档 |
| qa-runner | @default | deepseek-v4-flash | 脚本翻译;复杂交互升档 |

工具面原则:spec-definer只读+写规格(restrictToolNames裁剪后无法触碰代码);其余五个有完整读写执行面——它们的边界由**门禁命令**约束,而非prompt。

## 5. 项目声明文件`.omp/quality.yml`(确定性门禁的唯一事实源)

```yaml
# 每个项目自声明;未声明的项目走§5.1问答式初始化协议
scope: diff            # 门禁只对diff范围生效
crap_threshold: 6      # Agent标准(人类4)
coverage_target: 100
architect_signal:      # architect派发阈值(§6触发信号)
  new_files: 3         # 新建文件数≥3
  modules_touched: 3   # 触碰顶层模块数≥3
e2e: cli               # qa-runner交互面: cli|http|playwright|null(null=G4跳过,终点G3)
spec:                  # G0规格门禁(spec-definer产出,主会话派发后、人类审查前亲自跑;见§3①)
  check: ai-coding-qa-pipeline spec-check {spec_path} {qa_flow_path}   # 插件CLI,全局可用:L1+L2+qa-flow模板
languages:
  python:
    test: pytest tests/ -q
    coverage: pytest --cov=. --cov-report=term-missing
    complexity: ai-coding-qa-pipeline crap-check --threshold 6   # 插件组合器,不自造分析(见§7)
    mutation: mutmut run
    arch: lint-imports
  shell:
    test: bats tests/
    lint: shellcheck scripts/
    mutation: null      # 二期选型
  java:
    test: mvn -q test
    complexity: mvn -q com.github.spotbugs:spotbugs-maven-plugin:check
    mutation: mvn -q org.pitest:pitest-maven:mutationCoverage -DwithHistory
    arch: mvn -q arch-unit
  # 预留:typescript(stryker/dependency-cruiser)、go(gremlins/depguard)、rust(cargo-mutants)
```

规则:

- 某语言`mutation: null`→reinforcer对该语言跳过并在output中声明`skipped_reason`;
  `e2e: null`→qa-runner不派发(无系统级验证面,终点G3)。
- `e2e`是项目级声明(一个项目一个主交互面),故置于languages之外;多面项目二期再扩展为per-language。
- 命令一律从quality.yml读,agent不猜测——"不遵守就过不去"的确定性来自这里。

### 5.1 quality.yml 初始化协议(问答式,不由用户手写)

触发方式:用户对主会话说"初始化质量配置"(或编排流程走到第1步发现缺文件时主动提议)。

> 载体(2026-09-17):本协议命令化为插件内技能 `skills/pipeline-setup`(含建议表 `references/lang-profiles.md`)。
> 用户在 omp TUI 对主会话说"初始化质量配置"时,主会话按技能描述匹配并加载执行;
> 第3步冒烟仍由 `ai-coding-qa-pipeline doctor` 承担(缺 quality.yml 时给出引导)。

```
第0步 探测(主会话亲自做,只读):
  - 识别项目语言:构建文件(pyproject.toml/pom.xml/build.gradle/package.json/go.mod/Cargo.toml)、
    测试目录(tests/、src/test/)、已有工具配置(setup.cfg、importlinter契约、.pitest等)
  - 检查工具可用性:which pytest / mutmut / bats / mvn...
  - 产出:候选语言清单 + 每语言候选命令(仅为问答草稿,不写入)

第1步 问答(每题给推荐默认值,用户可回车采纳):
  Q1 本项目启用哪些语言?(候选清单多选)
  Q2 各语言的测试命令?(给出探测到的候选,如"pytest tests/ -q";无测试目录则问是否约定)
  Q3 架构约束命令?(有契约文件→直接采用;没有→问是否初始化,Python推荐import-linter模板)
  Q4 变异测试工具?(Python推荐mutmut;无对应工具的语言默认null并告知后果=G3跳过)
  Q5 端到端验证交互面?(决定e2e声明:cli|http|playwright|null;运维脚本类项目推荐cli,
     无系统级验证面选null=G4跳过)
  Q6 scope与阈值?(推荐diff/6/100,一般直接采纳)

第2步 生成:主会话按问答结果生成 .omp/quality.yml 全文,展示给用户过目

第3步 冒烟验证(确定性,由插件命令执行,2026-09-16命令化):
  - 主会话运行 `ai-coding-qa-pipeline doctor`(读 quality.yml,逐条查每条非null命令的工具在位性,
    替代手工逐条执行;缺失时给出安装提示,如 bats/shellcheck)
  - 语义不变:"工具能跑"与"测试全绿"区分开——doctor只验证工具在位,mutation只查mutmut
    存在(mutmut --version),不实跑
  - 验证报告:每条[OK]/[MISSING(含安装提示)]/[SKIP(null)];缺失项回问答修正(装工具或置null),
    全部OK才落盘;doctor exit=2=环境问题(§8)
```

设计要点:

- **探测只产生候选,决定权在问答**——避免主会话静默猜测(用户纠偏点:不能"探测后回填")。
- **执行 agent 挂 playbook**:coder/cleaner/reinforcer/qa-runner 经 frontmatter `autoload-skills` 挂各自 `skills/*-playbook/SKILL.md`,派发前自动加载;正文只留角色+完成标准+quality.yml 契约,技能承载操作型纪律。
- **冒烟验证是关键一步**:问答收集的命令若从未执行过,第一次跑流水线才发现 `mutmut` 没装,整条流水线白跑。初始化时逐条验证,把工具链问题拦截在流水线之外。
- 产物纳入版本管理(quality.yml 是项目事实源,应进 git);`.omp/` 下 agent 定义若存在则随之共享。
- 重复执行安全:已有 quality.yml 时进入"更新模式"——展示现有内容,逐节问是否调整,不覆盖未确认的节。

## 6. 主会话编排流程(内置orchestrate契约)

```
用户: "开发 feature-x"(需求文档在 docs/requirements/,走完整开发流程)
主会话:
  0. 定位澄清:这是完整开发流程——规格→编码→清理→(架构)→强化→QA;
     质量门禁是每环的完成条件,不是可单独执行的"流水线任务"
  1. 读 .omp/quality.yml;无则走§5.1问答式初始化协议(探测→问答→生成→冒烟验证)
  2. task(spec-definer, 需求文档) → 主会话亲自跑G0(quality.yml spec段,{spec_path}/{qa_flow_path}从output代入) → 打印路径,暂停请用户确认(纯语义卡点)
  3. 确认后 task(coder, spec) → 验证G1(主会话亲自跑命令,不信agent自报)
  4. G1失败→coder继续修(同任务上下文,≤3轮);成功→**阶段提交C1**→task(cleaner) →验证G2
  5. G2过→**提交C2**→结构信号检测(见下)→
     有信号→task(architect)→验证G5→**提交C5**;无信号→跳过
  6. task(reinforcer)→验证G3→**提交C3**→(e2e非null)task(qa-runner)→验证G4→**提交C4**
  7. 汇总各环结构化output + 门禁证据,给出最终报告
任一环3轮不绿 → 中止,输出失败环、证据、建议,交回用户

architect触发信号(确定性检测,任一命中即派发,均无则跳过):
  - cleaner的output中structural_changes非空(cleaner如实上报跨模块改动;cleaner
    职责已限定为仅函数级,此字段非空即异常信号)
  - git diff统计超阈:新建文件数≥3 或 触碰的顶层模块数≥3(阈值可在quality.yml调整)
  - 本次流程修改了架构约束文件(import-linter契约等)

阶段提交(git仓库时启用,非git项目跳过):
  - 每环门禁通过后,主会话自动commit一次,message格式"pipeline(<环名>): <feature> 门禁G<n>通过",
    正文含该环结构化output与门禁命令摘要
  - 作用:回滚点+审计轨迹(借鉴swarm-forge的commit交接持久化;规格等.scratch产物不入提交)

下游回传(借鉴swarm-forge back-propagation,预算化):
  - G3/G4失败且主会话判定为功能缺陷(非测试盲区)时:
    携失败证据派coder修复 → 复跑失败环及其后所有门禁(不重启整条流水线)
  - 回传预算:整个feature生命周期≤2次,超限中止交回用户
  - G3失败若判定为测试盲区→仍由reinforcer同环重试,不触发回传
```

关键:**门禁由主会话亲自执行命令验证**,不采信子代理自报结果——编排者与执行者分离,与文档"不信任Agent自觉性"原则一致。

## 7. 分发架构(独立插件项目,2026-09-16重构)

**重构动机**:可复用件(spec_check/crap_check)曾放项目仓库,只在本项目有效;换项目即废。
v2定稿为:可复用件全部收进独立插件项目`ai-coding-qa-pipeline`(git管理,可发布 npm 或市场分发),
项目只保留声明与产物。

```
ai-coding-qa-pipeline/(独立插件项目,~/apps/ai-coding-qa-pipeline)
├── package.json              # name=ai-coding-qa-pipeline;omp插件清单;bin入口(ai-coding-qa-pipeline)
├── agents/                   # 6个agent定义,随插件全局分发(发现顺序:项目>用户>插件根)
│   ├── spec-definer.md       #   正文含 qa-flow 模板 + spec.feature 骨架(与校验器 REQUIRED_QA_HEADER 同步)
│   ├── coder.md              #   autoload-skills: coder-playbook
│   ├── cleaner.md            #   autoload-skills: cleaner-playbook
│   ├── architect.md          # 有条件派发(§6触发信号);无 playbook
│   ├── reinforcer.md         #   autoload-skills: reinforcer-playbook
│   └── qa-runner.md          #   autoload-skills: qa-runner-playbook
├── bin/ai-coding-qa-pipeline.ts       # 门禁CLI(bun运行;@cucumber/gherkin官方解析器,零项目路径)
│   ├── spec-check <spec> <qa-flow>   # G0:L1语法+L2结构+qa-flow模板+scenario_count对账
│   ├── crap-check [--threshold N] [paths...]  # CRAP组合器(radon+coverage,自不解析源码)
│   └── doctor [quality.yml]        # §5.1冒烟验证命令化:按声明查门禁工具在位性(缺失给安装提示/缺配置引导)
├── skills/                   # 技能,随插件分发(/extensions 可审计)
│   ├── pipeline-setup/       #   初始化质量配置向导(§5.1),含 references/lang-profiles.md 建议表
│   ├── coder-playbook/       #   执行 agent 的操作型 playbook
│   ├── cleaner-playbook/
│   ├── reinforcer-playbook/
│   └── qa-runner-playbook/
└── README.md                 # 安装/升级/使用说明(+quality.yml模板)

安装(每台目标机的omp实例,一次):
  omp plugin link ~/apps/ai-coding-qa-pipeline    # agents分发(发布后:omp install npm:ai-coding-qa-pipeline)
  bun link                              # 门禁CLI进PATH(发布后:bun add -g ai-coding-qa-pipeline)

<落地项目>/——只有项目声明,无可复用代码
├── .omp/quality.yml           # 门禁命令引用插件CLI(ai-coding-qa-pipeline),零仓库路径
└── .scratch/<feature>/        # 流水线产物(短暂,gitignore)
```

CRAP工具定位(不变,对照swarm-forge后,推翻原"量身定制"建议):

- swarm-forge工程宪法明令禁止自造CRAP/DRY/变异代理工具("Do not invent project-local
  CRAP, DRY, mutation, or coverage proxies")——agent手写的分析器即不可靠代理,正是
  原始文档"让Agent为自己量身定制CRAP工具"建议的风险实证。
- `ai-coding-qa-pipeline crap-check`定位为**纯组合器**:只解析`radon cc`(圈复杂度)与`coverage`
  (覆盖率)的标准输出,按公式 comp²×(1−cov/100)³+comp 计算——复杂度分析完全由radon
  承担,CLI不含任何解析Python源码的逻辑。
- 变异测试同理:直接用mutmut,不自写变异算子。

## 8. 错误处理与风险

| 风险 | 缓解 |
|---|---|
| 变异测试耗时长 | diff-based增量 + mutmut缓存;一期串行(§3⑤执行纪律:工具不并发),确有瓶颈时再评估按模块并行(需worktree隔离,二期) |
| 等价变异体 | 豁免清单+理由,不计入门禁 |
| 子代理上下文污染 | 每环fresh子代理,靠output schema交接;主会话只留门禁证据 |
| agent自报门禁结果造假 | 主会话亲自执行命令验证(§6关键设计) |
| 难任务flash档不够 | 主会话对该环升档@slow重派(omp model角色天然支持) |
| quality.yml缺失/失真 | 主会话探测→草稿→用户确认;命令执行失败即门禁失败;`ai-coding-qa-pipeline doctor`做初始化拦截 |
| 运行环境缺门禁工具 | doctor按声明逐条检查(缺失给安装提示,或该语言该门禁置null);运行期门禁 exit=2=环境问题,主会话不重试agent,直接报环境 |
| 插件自身依赖缺失 | 插件CLI(bun)起不来=环境错误;重跑`bun install`恢复;README记录安装三步 |
| 非Python语言的complexity命令语义差异 | quality.yml按语言各自声明,CRAP仅Python强制;其他语言在yml中注明替代指标 |

## 9. 验收标准

1. `ai-coding-qa-pipeline`插件安装后,插件`agents/`下6个md被omp discovery识别,任一omp会话可派发(spec-definer/coder/cleaner/architect/reinforcer/qa-runner);`ai-coding-qa-pipeline spec-check`/`crap-check`在PATH可用,对好样例exit=0、坏样例exit=1(已实测)。
2. 以<落地项目>(用户指定)一个功能点为例,五环串通:产出规格→代码→CRAP≤6→变异0存活→(e2e为null则止于G3),每环门禁由主会话验证;architect未被信号触发时自动跳过。
3. 构造一个命中触发信号的变更(如新建≥3文件),architect环被派发并通过G5验证。
4. 在<落地项目>的交互面(按其声明 e2e: cli|http|playwright)走端到端验证:qa-runner按qa-flow.md以真实参数执行命令并断言输出/退出码/副作用,通过G4。
5. 任一环连续3次门禁失败时流程中止并输出人类可读报告。
6. 换一个声明了java的项目,同一组agent定义无需修改即可按该项目的quality.yml执行。

---

## 附录A:v2关键事实的源码证据

| 事实 | 证据 |
|---|---|
| 自定义agent发现顺序与磁盘位置 | `src/task/discovery.ts:1-141`(项目`.omp/agents/`>用户`~/.omp/agent/agents/`>扩展>内置) |
| frontmatter字段 | `src/task/types.ts:375-395`、`src/prompts/agents/frontmatter.md` |
| tools白名单+restrictToolNames | `discovery/helpers.ts:330-332`、`executor.ts:467,3278-3281` |
| 子代理同profile(不可跨) | `executor.ts:3327-3412`(继承authStorage/settings,spawn无profile字段)、`cli.ts:356-367`(profile为进程级) |
| 认证全局共享 | `~/.omp/.env`(实测6变量含OMNIROUTE_API_KEY),位于config根,各profile共享 |
| v1认证共享判断错误 | v1基于`agent.db` per-profile(`dirs.ts:838-840`),但`.env`在config根级先于agent.db生效 |

## 附录B:swarm-forge对照记录(2026-09-14)

对照对象:`github.com/unclebob/swarm-forge`(six-pack分支+main分支handoff协议与工程宪法)。

### B.1 采纳的修正

| # | 修正 | 落点 |
|---|---|---|
| C1 | **有条件第6个agent(architect)**:非每环必经,由确定性结构信号触发(cleaner上报结构变更/diff统计超阈/约束文件被修改);常见路径仍5环。必要性分析结论:现有门禁测不出"合法但坏的结构"(import-linter只抓已声明违规,CRAP是函数级指标),大项目结构工作高频;经条件派发后小项目零开销。职责对齐six-pack(cleaner→architect→hardender顺序),cleaner收紧为仅函数级重构 | §3④、§6、§2 |
| C2 | crap_check.py从"定制分析工具"降级为**组合器**(只解析radon cc+coverage.py输出并套公式);变异直接用mutmut不自写算子。依据:swarm-forge工程宪法明令禁止自造CRAP/DRY/变异/覆盖率代理工具 | §7 |
| C5 | 变异执行纪律:工具一次只跑一个不并发;worker上限4;变异必须差异化(对diff范围),禁全库 | §3⑤ |
| Q2 | **下游回传**:G3/G4失败且判定为功能缺陷时携证据派coder修复,复跑失败环及其后所有门禁;预算≤2次/feature;测试盲区仍走同环重试。借鉴back-propagation但不引入常驻会话 | §6 |
| Q3 | **阶段提交**:git仓库中每环门禁通过后主会话自动commit(message含环名+门禁证据);非git项目跳过。借鉴commit交接持久化 | §6 |
| Q4 | **qa-runner从"仅UI"扩为端到端验证**:交互面由quality.yml的`e2e`声明(cli/http/playwright/null)。原"仅UI"忠实于原始文档⑤与swarm-forge("executable UI-level checks"),但对全局流水线过窄——"用户视角"由被测对象决定,运维脚本项目的cli面(真实执行+断言输出/退出码/副作用)恰是其最有价值的验证层;`e2e:null`(原ui:false)语义不变 | §3⑥、§5、§6 |

### B.2 评估后不采纳

| swarm-forge实践 | 不采纳理由 |
|---|---|
| 无条件第6个agent(每feature必过architect) | 小feature/小项目每单多一环开销;经必要性分析改为**信号触发的有条件派发**(B.1/C1),既补"主动式结构工作无主人"的空缺,又避免常驻开销。原始文档5角色表无architect只是次要佐证,非决定性理由 |
| 常驻tmux会话+worktree隔离+handoff守护进程 | 顺序阻塞执行不需要;task子代理已是进程级隔离,复杂度低一个量级 |
| 分层宪法(共享articles+项目articles+角色prompt) | 6个角色prompt足够小,自包含md+quality.yml的重复量可忽略,组合机制收益为零 |
| Gherkin层变异(gherkin-mutator) | 记为二期可选;一期先覆盖语言级变异 |
| QA做窄修复 | 保持qa-runner只报告——修复经回传机制归coder,职责更干净 |

### B.3 architect决策记录(必要性分析,响应"勿无脑遵循原始文档"的纠偏)

证据链修正:最初拒architect的理由是"原始5角色表无architect"(诉诸先例,被用户纠偏)。
修正后的分析:

- swarm-forge产品线证据:**4-pack与6-pack均含architect**(职责"boundaries, dependency
  direction, structural corrections",独立worktree)——同一作者的产品化演进,效力高于文章叙述;
  "6角色从5角色实践改进而来"属推测(commit级证据缺),但产品线模式一致支持。
- 必要性核心论证:v2原门禁测不出"**合法但坏的结构**"——import-linter只抓已声明的违规与
  循环依赖,抓不住上帝模块/扇入爆炸/代码落错位置;CRAP是函数级指标。走完五环后功能正确、
  测试真实、复杂度达标,模块边界仍可静默侵蚀。原始文档⑥"人类定期查看架构查看器"兜此底,
  但滞后(事后定期,非每feature)。
- 不并入cleaner的理由:(1)cleaner循环有确定性终止条件(CRAP≤6),模块级重构无数字终止
  条件,并入后失去硬出口;(2)函数级与模块级是两种推理粒度,违背"单Agent单职责"。
- 最终决策:**有条件第6环**(用户选定)——信号触发而非必经,常见路径仍5环;
  architect职责对齐six-pack(cleaner→architect→reinforcer顺序),cleaner收紧为仅函数级。
  swarm-forge的"变异工具scan/count模式探模块混职"信号依赖其自家工具,本设计改用
  cleaner的structural_changes上报+git diff统计作为确定性触发信号(§6)。

## 附录C:vibe模式评估结论(不可用作流水线主干)

调研结论:vibe模式与五agent流水线形似而神不似,**不引入**;但记录其机制供未来借鉴。

vibe机制事实(源码验证):

| 机制 | 证据 |
|---|---|
| `/vibe`进入director模式,主会话工具集裁剪为**只读**(read+todo) | `modes/interactive-mode.ts:~4100`(`vibeBaseTools=["read"]`+可选`"todo"`) |
| worker只有fast/good两档,映射到内置sonic(@smol)/task(@task)agent | `vibe/runtime.ts:56-60`(`VIBE_CLI_AGENT`) |
| worker用**内置bundled agent**,不读`~/.omp/agent/agents/*.md`自定义定义 | `runtime.ts:394-411`(`getBundledAgent(agentName)`) |
| worker是持久会话:保留完整对话历史,vibe_send续话/转向,结果自动回报 | `prompts/tools/vibe-spawn.md`、`vibe-send.md` |

三条硬冲突:

1. **director只读**→无法亲自执行门禁命令,违背§6"门禁由主会话亲自验证"的核心设计。
2. **只有fast/good两档**→无法表达六个角色各自的prompt/工具面/模型档。
3. **忽略自定义agent定义**→①~⑥的md文件在vibe路径下不生效。

可借鉴点(未来变异测试耗时过长时再评估):worker持久会话使"门禁失败→继续修"的重试循环保留完整上下文(v2的task子代理每轮重试是fresh spawn,靠失败报告交接);若某语言mutation单轮超过30分钟,可考虑extension方式实现持久worker+门禁,而非启用vibe模式。
