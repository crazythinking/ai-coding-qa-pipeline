#!/usr/bin/env bun
/**
 * ai-coding-qa-pipeline — 六-agent 开发流水线的可分发门禁 CLI。
 *
 * 子命令:
 *   spec-check <spec.feature> <qa-flow.md>   G0 门禁:L1 语法(官方 @cucumber/gherkin)
 *                                              + L2 结构(每场景三类步骤)+ qa-flow 固定模板
 *   crap-check [--threshold N] [paths...]     CRAP 组合器:radon cc + coverage json → CRAP 公式
 *                                               (不自造分析,复杂度完全由 radon 承担)
 *   doctor [quality.yml路径]                  §5.1冒烟验证:按声明逐条查门禁工具在位性
 *   pipeline-state read|update <json> [内容]  ADR-0001 编排状态读写:环间恢复+审计,带 schema 校验
 *
 * 退出码: 0 = 通过; 1 = 不合格; 2 = 参数错误/依赖工具不可用/输出解析失败。
 * 设计依据: docs/omp-profile-agents-design.md §3①/§5(quality.yml 中 {spec_path}/{qa_flow_path} 由主会话代入)。
 */

import { readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { Parser, AstBuilder, GherkinClassicTokenMatcher, Errors } from "@cucumber/gherkin";

/* ---- Gherkin AST 最小域类型(@cucumber/messages 结构的子集,深度为用到的字段) ---- */

interface ScenarioLike {
  name?: string;
  steps?: StepLike[];
}
interface StepLike {
  text?: string;
  keywordType?: string;
}
interface ChildLike {
  scenario?: ScenarioLike;
  scenarioOutline?: ScenarioLike;
  rule?: { children?: ChildLike[] };
}
interface FeatureLike {
  language?: string;
  name?: string;
  children?: ChildLike[];
}
interface GherkinDocLike {
  feature?: FeatureLike;
}

function asRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 收集 feature 下所有场景/场景大纲(支持 Rule 嵌套)。 */
function collectScenarios(feature: FeatureLike | undefined): ScenarioLike[] {
  const out: ScenarioLike[] = [];
  const walk = (children: ChildLike[] | undefined): void => {
    for (const child of children ?? []) {
      if (child.scenario) out.push(child.scenario);
      if (child.scenarioOutline) out.push(child.scenarioOutline);
      if (child.rule) walk(child.rule.children);
    }
  };
  walk(feature?.children);
  return out;
}

let idCounter = 0;
function parseGherkin(source: string): GherkinDocLike {
  const newId = (): string => String(++idCounter); // AstBuilder 捕获此回调,实例间必须隔离
  return new Parser(new AstBuilder(newId), new GherkinClassicTokenMatcher()).parse(source) as GherkinDocLike;
}

const REQUIRED_QA_HEADER = ["步骤", "操作", "预期结果"];
const NON_DETERMINISM_HINTS = /随机|任意|sleep|等待\s*\d+\s*(秒|s|min|分钟)/;

function checkGherkin(path: string): { count: number; violations: string[] } {
  const violations: string[] = [];
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (e) {
    console.log(`FAIL [spec] 文件不可读: ${path} (${e instanceof Error ? e.message : String(e)})`);
    process.exit(2);
  }
  let feature: FeatureLike | undefined;
  try {
    feature = parseGherkin(source).feature;
  } catch (e) {
    const detail = e instanceof Errors.CompositeParserException
      ? e.errors.map((err) => `${err.location?.line}:${err.location?.column} ${err.message}`).join("; ")
      : String(e);
    return { count: -1, violations: [`Gherkin 语法错误(L1): ${detail}`] };
  }
  if (!feature?.language) violations.push("缺少 # language: 声明");
  const name = feature?.name?.trim() ?? "";
  if (!name) violations.push("Feature 缺少名称");

  let count = 0;
  for (const sc of collectScenarios(feature)) {
    count++;
    const scName = sc.name?.trim() || "(未命名)";
    const stepTypes = (sc.steps ?? []).map((s) => s.keywordType).filter(Boolean);
    if (!stepTypes.length) {
      violations.push(`场景 '${scName}' 没有步骤`);
      continue;
    }
    const found = new Set(stepTypes);
    const FAMILY_LABELS: Array<[string, string]> = [
      ["Context", "前置条件"],
      ["Action", "操作步骤"],
      ["Outcome", "预期结果"],
    ];
    for (const [type, label] of FAMILY_LABELS) {
      if (!found.has(type)) violations.push(`场景 '${scName}' 缺少${label}类步骤(实际: ${[...found].join(",")})`);
    }
  }
  if (count === 0) violations.push("没有任何场景");
  return { count, violations };
}

/** 按 '## ' 切小节: header 之后到下一小节或末尾的行。 */
function qaSection(lines: string[], header: string): string[] {
  const idx = lines.findIndex((l) => l.trim() === header);
  if (idx < 0) return [];
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    if (lines[i].trim().startsWith("## ")) { end = i; break; }
  }
  return lines.slice(idx + 1, end);
}

function isSeparatorRow(row: string): boolean {
  const cells = row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  return cells.length > 0 && cells.every((c) => c === "" || /^-+$/.test(c));
}

function checkQaFlow(path: string): string[] {
  const violations: string[] = [];
  let lines: string[];
  try {
    lines = readFileSync(path, "utf8").split(/\r?\n/);
  } catch (e) {
    console.log(`FAIL [qa-flow] 文件不可读: ${path} (${e instanceof Error ? e.message : String(e)})`);
    process.exit(2);
  }
  const title = lines.find((l) => l.startsWith("# QA 流程:"));
  if (!title) violations.push("缺少标题行 '# QA 流程:<功能名>'");
  else if (!title.slice("# QA 流程:".length).trim()) violations.push("标题行功能名为空");

  const precond = qaSection(lines, "## 前置条件");
  const steps = qaSection(lines, "## 步骤");
  if (!precond.length) violations.push("缺少 '## 前置条件' 小节");
  if (!steps.length) violations.push("缺少 '## 步骤' 小节");

  const bullets = precond.filter((l) => l.trim().startsWith("-"));
  const badLines = precond.filter((l) => l.trim() && !l.trim().startsWith("-"));
  if (!bullets.length) violations.push("## 前置条件下没有条目(每项以 '- ' 开头)");
  else if (badLines.length) violations.push(`## 前置条件小节存在非列表行: ${badLines[0].trim()}`);

  const table = steps.filter((l) => l.trim().startsWith("|"));
  if (!table.length) {
    violations.push("## 步骤下没有表格(模板: | 步骤 | 操作 | 预期结果 |)");
    return violations;
  }
  const header = table[0].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  if (JSON.stringify(header) !== JSON.stringify(REQUIRED_QA_HEADER)) {
    violations.push(`表头必须是 '| 步骤 | 操作 | 预期结果 |',实际: [${header.join(", ")}]`);
  }
  const dataRows = table.length >= 2 && isSeparatorRow(table[1]) ? table.slice(2) : table.slice(1);
  for (let i = 0; i < dataRows.length; i++) {
    const cells = dataRows[i].trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    const stepNo = cells[0] ?? "";
    if (stepNo !== String(i + 1)) violations.push(`步骤序号应为 ${i + 1},实际 '${stepNo}'`);
    if (cells.length < 3 || !cells[1]) violations.push(`步骤 ${i + 1} 的'操作'为空`);
    if (cells.length < 3 || !cells[2]) violations.push(`步骤 ${i + 1} 的'预期结果'为空`);
  }

  for (let i = 0; i < lines.length; i++) {
    if (NON_DETERMINISM_HINTS.test(lines[i])) {
      console.log(`WARN 第${i + 1}行疑似违反确定性(随机/等待): ${lines[i].trim()}`);
    }
  }
  return violations;
}

function cmdSpecCheck(args: string[]): never {
  if (args.length !== 2) {
    console.log("用法: ai-coding-qa-pipeline spec-check <spec.feature> <qa-flow.md>");
    process.exit(2);
  }
  const [specPath, qaPath] = args;
  const { count, violations: specV } = checkGherkin(specPath);
  const qaV = checkQaFlow(qaPath);
  for (const v of specV) console.log(`FAIL [spec] ${v}`);
  for (const v of qaV) console.log(`FAIL [qa-flow] ${v}`);
  if (count >= 0) console.log(`INFO scenario_count=${count}`);
  if (specV.length || qaV.length) process.exit(1);
  console.log("PASS spec结构 + qa-flow模板 全部合规");
  process.exit(0);
}

/** CRAP(m) = comp² × (1 − cov/100)³ + comp — 设计文档公式,名称保留可读性。 */
function crap(comp: number, cov: number): number {
  return comp ** 2 * (1 - cov / 100) ** 3 + comp;
}

/** 解析外部命令 JSON 输出,只取 Record 形状;非法即门禁错误。 */
function parseJsonRecord(text: string, what: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text);
    if (asRecord(parsed)) return parsed;
  } catch {
    /* 落到下方统一报错 */
  }
  console.error(`[CRAP] ${what} 输出不是 JSON 对象`);
  process.exit(2);
}

function cmdCrapCheck(args: string[]): never {
  let threshold = 6;
  const paths: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--threshold") threshold = Number(args[++i]);
    else paths.push(args[i]);
  }
  if (!Number.isFinite(threshold)) {
    console.log("用法: ai-coding-qa-pipeline crap-check [--threshold N] [paths...]");
    process.exit(2);
  }
  const targets = paths.length ? paths : ["lib", "scripts"];
  // 允许文件或目录(§5 scope:diff 需对单个新建文件做复杂度门禁;radon cc 两者均接受)。
  // 只筛掉不存在的路径。
  const analysis = targets.filter((p) => {
    try { return statSync(p).isFile() || statSync(p).isDirectory(); } catch { return false; }
  });
  if (!analysis.length) {
    console.error("[CRAP] 无可分析路径(文件或目录均接受)");
    process.exit(2);
  }

  const radon = spawnSync("radon", ["cc", "--json", "--total-average", ...analysis], { encoding: "utf8" });
  if (![0, 2].includes(radon.status ?? -1)) { // radon 对无代码文件返回 2
    console.error(`[CRAP] radon cc 失败: ${radon.stderr}`);
    process.exit(2);
  }
  const covRun = spawnSync("coverage", ["json", "-o", "-", "--quiet"], { encoding: "utf8" });
  if (covRun.status !== 0) {
    console.error(`[CRAP] coverage json 失败: ${covRun.stderr}`);
    process.exit(2);
  }

  const complexity = new Map<string, number>();
  for (const [file, blocks] of Object.entries(parseJsonRecord(radon.stdout, "radon"))) {
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (!asRecord(block) || typeof block.type !== "string" || typeof block.name !== "string" || typeof block.complexity !== "number") continue;
      if (block.type === "function" || block.type === "method") complexity.set(`${file}:${block.name}`, block.complexity);
    }
  }
  const coverage = new Map<string, number>();
  const covRoot = parseJsonRecord(covRun.stdout, "coverage");
  // 词法作用域切分文件键: / 结尾前取目录作为 radon 相对前缀
  if (asRecord(covRoot.files)) {
    for (const [file, info] of Object.entries(covRoot.files)) {
      if (asRecord(info) && asRecord(info.summary) && typeof info.summary.percent_covered === "number") {
        coverage.set(file, info.summary.percent_covered);
      }
    }
  }

  const violations: Array<[string, number, number, number]> = [];
  let checked = 0;
  for (const [func, comp] of [...complexity.entries()].sort()) {
    const cov = coverage.get(func.slice(0, func.lastIndexOf(":"))) ?? 0;
    checked++;
    const score = crap(comp, cov);
    if (score > threshold) violations.push([func, comp, cov, score]);
  }
  console.log(`[CRAP] 检查 ${checked} 个函数,阈值 ${threshold}`);
  for (const [func, comp, cov, score] of violations) {
    console.log(`[CRAP] 超标 ${func}: comp=${comp} cov=${cov.toFixed(1)}% crap=${score.toFixed(1)}`);
  }
  if (violations.length) {
    console.log(`[CRAP] ${violations.length} 个函数超标`);
    process.exit(1);
  }
  console.log("[CRAP] 全部通过");
  process.exit(0);
}

/** 机器级门禁工具的常见安装提示(仅提示;装不装由用户决定)。 */
const INSTALL_HINTS: Record<string, string> = {
  pytest: "pip3 install pytest",
  mutmut: "pip3 install mutmut",
  radon: "pip3 install radon",
  coverage: "pip3 install coverage",
  "lint-imports": "pip3 install import-linter",
  bats: "apt install bats / brew install bats-core",
  shellcheck: "apt install shellcheck / brew install shellcheck",
  mvn: "apt install maven / sdk install maven",
  "gherkin-utils": "bun add -g @cucumber/gherkin-utils",
  "ai-coding-qa-pipeline": "omp plugin link <插件路径> && bun link",
};

interface GateEntry {
  label: string;
  cmd: string | null;
}

/** 读项目 quality.yml,展开为扁平门禁清单(命令模板含 {spec_path} 等占位,只取首 token 查工具)。 */
function collectGates(root: Record<string, unknown>): GateEntry[] {
  const gates: GateEntry[] = [];
  const spec = root.spec;
  if (asRecord(spec) && typeof spec.check === "string") gates.push({ label: "spec.check", cmd: spec.check });
  const languages = root.languages;
  if (asRecord(languages)) {
    for (const [lang, body] of Object.entries(languages)) {
      if (!asRecord(body)) continue;
      for (const [gate, cmd] of Object.entries(body)) {
        if (typeof cmd === "string") gates.push({ label: `${lang}.${gate}`, cmd });
        else gates.push({ label: `${lang}.${gate}`, cmd: null }); // null=跳过
      }
    }
  }
  return gates;
}

function cmdDoctor(args: string[]): never {
  const qPath = args[0] ?? ".omp/quality.yml";
  let text: string;
  try {
    text = readFileSync(qPath, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      console.log(`[doctor] 未找到质量配置: ${qPath}`);
      console.log('[doctor] 项目尚未接入流水线。请在 omp 会话中对主会话说"初始化质量配置",触发 pipeline-setup 技能生成 .omp/quality.yml;已有项目新增语言门禁同理。');
      process.exit(2);
    }
    console.log(`[doctor] 读取失败: ${qPath} (${e instanceof Error ? e.message : String(e)})`);
    process.exit(2);
  }
  let root: Record<string, unknown>;
  try {
    const parsed: unknown = parseYaml(text);
    if (!asRecord(parsed)) throw new Error("quality.yml 顶层不是对象");
    root = parsed;
  } catch (e) {
    console.log(`[doctor] quality.yml 解析失败: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }

  let ok = 0, missing = 0, skipped = 0;
  console.log(`[doctor] 读取 ${qPath}`);
  for (const gate of collectGates(root)) {
    if (gate.cmd === null) {
      console.log(`[SKIP]     ${gate.label.padEnd(16)} (null,该门禁不启用)`);
      skipped++;
      continue;
    }
    const tool = gate.cmd.trim().split(/\s+/)[0];
    const found = spawnSync("which", [tool], { encoding: "utf8" }).status === 0;
    if (found) {
      console.log(`[OK]       ${gate.label.padEnd(16)} ${tool}`);
      ok++;
    } else {
      const hint = INSTALL_HINTS[tool] ?? "请安装该工具并加入 PATH";
      console.log(`[MISSING]  ${gate.label.padEnd(16)} ${tool}   → ${hint}`);
      missing++;
    }
  }
  console.log(`[doctor] 结论: ${ok} 个工具在位, ${missing} 个缺失, ${skipped} 个跳过`);
  if (missing > 0) process.exit(2); // 环境问题,主会话不应重试 agent,应装工具或把该门禁置 null
  console.log("[doctor] 环境检查通过");
  process.exit(0);
}

/** pipeline-state:读/写 `.scratch/<feature>/pipeline-state.json` 编排状态(ADR-0001)。
 *  恢复粒度=环间续跑;schema 校验防主会话手写漂移;机读 JSON 亦人类可读=审计轨迹。 */
const REQUIRED_STATE_FIELDS = ["feature", "current_ring", "completed_rings"] as const;
const STRING_FIELDS = ["feature", "feature_name", "requirement", "current_ring"] as const;

function asStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/** 校验状态对象形状,返回缺字段/错类型清单;合法返回 []。 */
function validateState(root: Record<string, unknown>): string[] {
  const problems: string[] = [];
  for (const f of REQUIRED_STATE_FIELDS) {
    if (typeof root[f] !== "string" && !(f === "completed_rings" && asStringArray(root[f]))) {
      problems.push(`缺少必填字段或类型错误: ${f}`);
    }
  }
  for (const f of STRING_FIELDS) {
    if (root[f] !== undefined && typeof root[f] !== "string") problems.push(`字段类型应为 string: ${f}`);
  }
  if (root.completed_rings !== undefined && !asStringArray(root.completed_rings)) {
    problems.push("字段 completed_rings 应为 string[]");
  }
  if (root.backprop_budget_left !== undefined && typeof root.backprop_budget_left !== "number") {
    problems.push("字段 backprop_budget_left 应为 number");
  }
  if (root.gates !== undefined && !asRecord(root.gates)) problems.push("字段 gates 应为对象");
  if (root.paths !== undefined && !asRecord(root.paths)) problems.push("字段 paths 应为对象");
  if (root.skipped !== undefined && !asRecord(root.skipped)) problems.push("字段 skipped 应为对象");
  return problems;
}

function cmdPipelineState(args: string[]): never {
  const [op, statePath] = args;
  if (op === "read") {
    if (!statePath) {
      console.log("用法: ai-coding-qa-pipeline pipeline-state read <state.json路径>");
      process.exit(2);
    }
    let text: string;
    try {
      text = readFileSync(statePath, "utf8");
    } catch {
      // 无状态文件 = 尚未开始/已清理,输出空对象供恢复方区分"无状态"与"已完成"
      console.log("{}");
      process.exit(0);
    }
    let root: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (!asRecord(parsed)) throw new Error("顶层不是对象");
      root = parsed;
    } catch (e) {
      console.error(`[pipeline-state] 解析失败: ${statePath} (${e instanceof Error ? e.message : String(e)})`);
      process.exit(2);
    }
    const problems = validateState(root);
    if (problems.length) {
      console.error(`[pipeline-state] schema 非法: ${problems.join("; ")}`);
      process.exit(2);
    }
    console.log(JSON.stringify(root, null, 2));
    process.exit(0);
  }
  if (op === "update") {
    if (args.length < 3) {
      console.log("用法: ai-coding-qa-pipeline pipeline-state update <state.json路径> <json>");
      process.exit(2);
    }
    const json = args.slice(2).join(" ");
    let next: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(json);
      if (!asRecord(parsed)) throw new Error("顶层不是对象");
      next = parsed;
    } catch (e) {
      console.error(`[pipeline-state] JSON 无效: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    }
    const problems = validateState(next);
    if (problems.length) {
      console.error(`[pipeline-state] schema 非法: ${problems.join("; ")}`);
      process.exit(2);
    }
    try {
      mkdirSync(dirname(statePath), { recursive: true });
      writeFileSync(statePath, JSON.stringify(next, null, 2) + "\n", "utf8");
    } catch (e) {
      console.error(`[pipeline-state] 写入失败: ${statePath} (${e instanceof Error ? e.message : String(e)})`);
      process.exit(2);
    }
    console.log("[pipeline-state] 状态已写入");
    process.exit(0);
  }
  console.log("用法: ai-coding-qa-pipeline pipeline-state read|update <state.json路径> [json]");
  process.exit(2);
}

const cmd = process.argv[2] ?? "";
if (cmd === "spec-check") cmdSpecCheck(process.argv.slice(3));
else if (cmd === "crap-check") cmdCrapCheck(process.argv.slice(3));
else if (cmd === "doctor") cmdDoctor(process.argv.slice(3));
else if (cmd === "pipeline-state") cmdPipelineState(process.argv.slice(3));
else {
  console.log(
    "ai-coding-qa-pipeline — 六-agent 流水线门禁 CLI\n" +
    "用法: ai-coding-qa-pipeline <子命令> [参数]\n" +
    "  spec-check <spec.feature> <qa-flow.md>   G0 规格门禁(L1语法+L2结构+qa-flow模板)\n" +
    "  crap-check [--threshold N] [paths...]     CRAP 组合器(radon+coverage)\n" +
    "  doctor [quality.yml路径]                  §5.1冒烟验证:按声明逐条查门禁工具在位性\n" +
    "  pipeline-state read|update <state.json> [json]\n" +
    "                                           编排状态读/写(ADR-0001,环间恢复+审计)\n" +
    "退出码: 0=通过 1=不合格 2=参数/依赖错误(环境问题)"
  );
  process.exit(2);
}