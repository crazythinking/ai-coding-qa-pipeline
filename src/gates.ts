/**
 * ai-coding-qa-pipeline — 门禁核心逻辑(纯函数,CLI 与 extension 工具共用)。
 *
 * 每个门禁暴露一个返回结构化结果的函数:
 *   - lines:   面向人类的输出行(CLI stdout / 工具 content 共用)
 *   - exitCode: 0=通过 1=不合格 2=参数/依赖/环境错误
 * CLI 薄壳逐行打印并按 exitCode 退出;extension 工具拼接 content 并透传 exitCode。
 *
 * 设计依据: docs/omp-profile-agents-design.md §3①/§5。quality.yml 中
 * {requirement_path}/{spec_path}/{qa_flow_path}/{diff_source_paths} 等占位符由主会话代入。
 * spec-check 传 requirement_path 时追加需求一致性校验(requirement.md 验收项 ↔ 场景 @R<n> 标签双向闭环)。
 */

import { readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse as parseYaml } from "yaml";
import { Parser, AstBuilder, GherkinClassicTokenMatcher, Errors } from "@cucumber/gherkin";

/* ---- Gherkin AST 最小域类型(@cucumber/messages 结构的子集,深度为用到的字段) ---- */

interface ScenarioLike {
  name?: string;
  steps?: StepLike[];
  tags?: Array<{ name?: string }>;
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

export interface GateResult {
  lines: string[];
  exitCode: number;
}

function asRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** 相对路径基于 cwd 解析;绝对路径原样返回。 */
function resolvePath(cwd: string, p: string): string {
  return isAbsolute(p) ? p : join(cwd, p);
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

function checkGherkin(path: string): { count: number; violations: string[]; fatal?: string } {
  const violations: string[] = [];
  let source: string;
  try {
    source = readFileSync(path, "utf8");
  } catch (e) {
    return { count: -1, violations: [], fatal: `文件不可读: ${path} (${e instanceof Error ? e.message : String(e)})` };
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

function checkQaFlow(path: string): { violations: string[]; fatal?: string } {
  const violations: string[] = [];
  let lines: string[];
  try {
    lines = readFileSync(path, "utf8").split(/\r?\n/);
  } catch (e) {
    return { violations: [], fatal: `文件不可读: ${path} (${e instanceof Error ? e.message : String(e)})` };
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
    return { violations };
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

  const warns: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (NON_DETERMINISM_HINTS.test(lines[i])) {
      warns.push(`WARN 第${i + 1}行疑似违反确定性(随机/等待): ${lines[i].trim()}`);
    }
  }
  return { violations, warns };
}

/** 需求验收项条目:[Rn] 描述,或 [Rn] 不做: 理由(显式延后,不允许静默消失)。 */
interface RequirementItem {
  deferred: boolean;
  reason: string;
}

const REQ_ITEM_RE = /^\s*-\s+\[(R\d+)\]\s*(.*)$/;
const REQ_DEFER_RE = /^不做\s*[:：]\s*(.*)$/;

/** 解析 requirement.md(需求基线)的 '## 验收项' 小节:
 *  每条 `- [Rn] 描述` 为活动验收项;`- [Rn] 不做: <理由>` 为显式延后(理由必填)。
 *  小节外正文(背景/范围等)不参与校验;小节内只允许条目行,防止验收项被静默写成散文。 */
function checkRequirement(path: string): { items: Map<string, RequirementItem>; violations: string[]; fatal?: string } {
  const violations: string[] = [];
  let lines: string[];
  try {
    lines = readFileSync(path, "utf8").split(/\r?\n/);
  } catch (e) {
    return { items: new Map(), violations: [], fatal: `文件不可读: ${path} (${e instanceof Error ? e.message : String(e)})` };
  }
  const section = qaSection(lines, "## 验收项");
  if (!section.length) {
    violations.push("缺少 '## 验收项' 小节(需求基线必须逐条列出全部验收项)");
    return { items: new Map(), violations };
  }
  const items = new Map<string, RequirementItem>();
  for (const line of section) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = REQ_ITEM_RE.exec(line);
    if (!m) {
      violations.push(`验收项小节存在非条目行: ${trimmed}`);
      continue;
    }
    const id = m[1];
    const text = m[2].trim();
    const dm = REQ_DEFER_RE.exec(text);
    if (dm) {
      if (!dm[1].trim()) violations.push(`验收项 ${id} 标注不做但未给理由`);
      if (items.has(id)) violations.push(`验收项 ${id} 重复定义`);
      else items.set(id, { deferred: true, reason: dm[1].trim() });
    } else {
      if (!text) violations.push(`验收项 ${id} 描述为空`);
      if (items.has(id)) violations.push(`验收项 ${id} 重复定义`);
      else items.set(id, { deferred: false, reason: "" });
    }
  }
  return { items, violations };
}

/** 场景的 @R<n> 验收项标签(其余标签不参与追溯)。 */
function requirementRefs(sc: ScenarioLike): string[] {
  const out: string[] = [];
  for (const t of sc.tags ?? []) {
    const m = /^@(R\d+)$/.exec((t.name ?? "").trim());
    if (m) out.push(m[1]);
  }
  return out;
}

/** G0 规格门禁: L1 语法 + L2 结构 + qa-flow 固定模板;requirementPath 提供时追加
 *  需求一致性校验(需求验收项 ↔ 场景 @R<n> 标签,双向无孤儿)。cwd 用于解析相对路径。 */
export function specCheck(specPath: string, qaPath: string, cwd = process.cwd(), requirementPath?: string): GateResult {
  const lines: string[] = [];
  const { count, violations: specV, fatal: specFatal } = checkGherkin(resolvePath(cwd, specPath));
  const { violations: qaV, fatal: qaFatal } = checkQaFlow(resolvePath(cwd, qaPath));
  if (specFatal) { lines.push(`FAIL [spec] ${specFatal}`); return { lines, exitCode: 2 }; }
  if (qaFatal) { lines.push(`FAIL [qa-flow] ${qaFatal}`); return { lines, exitCode: 2 }; }
  for (const v of specV) lines.push(`FAIL [spec] ${v}`);
  for (const v of qaV) lines.push(`FAIL [qa-flow] ${v}`);
  if (count >= 0) lines.push(`INFO scenario_count=${count}`);

  const traceV: string[] = [];
  let coverageLine: string | undefined;
  if (requirementPath) {
    const req = checkRequirement(resolvePath(cwd, requirementPath));
    if (req.fatal) { lines.push(`FAIL [requirement] ${req.fatal}`); return { lines, exitCode: 2 }; }
    for (const v of req.violations) traceV.push(`[requirement] ${v}`);
    // 双向闭环:每场景必须有 @R 来源;每个活动验收项必须被 ≥1 场景覆盖。
    let specSource: string;
    try {
      specSource = readFileSync(resolvePath(cwd, specPath), "utf8");
    } catch (e) {
      lines.push(`FAIL [spec] 文件不可读: ${specPath} (${e instanceof Error ? e.message : String(e)})`);
      return { lines, exitCode: 2 };
    }
    const feature = parseGherkin(specSource).feature;
    const covered = new Set<string>();
    for (const sc of collectScenarios(feature)) {
      const scName = sc.name?.trim() || "(未命名)";
      const refs = requirementRefs(sc);
      if (!refs.length) {
        traceV.push(`[spec] 场景 '${scName}' 无 @R<n> 验收项标注(孤儿场景,缺需求来源)`);
        continue;
      }
      for (const id of refs) {
        const item = req.items.get(id);
        if (!item) traceV.push(`[spec] 场景 '${scName}' 引用了需求中不存在的验收项 ${id}`);
        else if (item.deferred) traceV.push(`[spec] 场景 '${scName}' 引用了已标注不做的验收项 ${id}(与延后声明冲突)`);
        else covered.add(id);
      }
    }
    let deferred = 0;
    const activeIds: string[] = [];
    for (const [id, item] of req.items) {
      if (item.deferred) deferred++;
      else activeIds.push(id);
    }
    const missing = activeIds.filter((id) => !covered.has(id));
    for (const id of missing) traceV.push(`[requirement] 验收项 ${id} 无对应场景(孤儿验收项,需求被裁剪)`);
    coverageLine = `INFO coverage: 需求验收项 ${req.items.size} = 覆盖 ${covered.size} + 未覆盖 ${missing.length} + 显式不做 ${deferred}`;
  }

  for (const v of traceV) lines.push(`FAIL ${v}`);
  if (coverageLine) lines.push(coverageLine);
  if (specV.length || qaV.length || traceV.length) return { lines, exitCode: 1 };
  lines.push(requirementPath
    ? "PASS spec结构 + qa-flow模板 + 需求一致性(验收项↔场景闭环) 全部合规"
    : "PASS spec结构 + qa-flow模板 全部合规");
  return { lines, exitCode: 0 };
}

/** CRAP(m) = comp² × (1 − cov/100)³ + comp — 设计文档公式,名称保留可读性。 */
function crap(comp: number, cov: number): number {
  return comp ** 2 * (1 - cov / 100) ** 3 + comp;
}

/** 解析外部命令 JSON 输出,只取 Record 形状;非法即门禁错误。 */
function parseJsonRecord(text: string, what: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (asRecord(parsed)) return parsed;
  } catch {
    /* 落到下方统一报错 */
  }
  return undefined;
}

/** CRAP 组合器:radon cc + coverage json → CRAP 公式(不自造分析,复杂度完全由 radon 承担)。 */
export function crapCheck(threshold: number, paths: string[], extraLines?: string[], cwd = process.cwd()): GateResult {
  const lines: string[] = extraLines ?? [];
  if (!Number.isFinite(threshold)) {
    lines.push("用法: ai-coding-qa-pipeline crap-check [--threshold N] [paths...]");
    return { lines, exitCode: 2 };
  }
  const targets = paths.length ? paths : ["lib", "scripts"];
  const analysis = targets.map((p) => resolvePath(cwd, p)).filter((p) => {
    try { return statSync(p).isFile() || statSync(p).isDirectory(); } catch { return false; }
  });
  if (!analysis.length) {
    lines.push("[CRAP] 无可分析路径(文件或目录均接受)");
    return { lines, exitCode: 2 };
  }

  const spawnOpts = { encoding: "utf8" as const, cwd, maxBuffer: 64 * 1024 * 1024 };
  const radon = spawnSync("radon", ["cc", "--json", "--total-average", ...analysis], spawnOpts);
  if (![0, 2].includes(radon.status ?? -1)) { // radon 对无代码文件返回 2
    lines.push(`[CRAP] radon cc 失败: ${radon.stderr}`);
    return { lines, exitCode: 2 };
  }
  const covRun = spawnSync("coverage", ["json", "-o", "-", "--quiet", "--fail-under=0"], spawnOpts);
  if (covRun.status !== 0) {
    lines.push(`[CRAP] coverage json 失败: ${covRun.stderr}`);
    return { lines, exitCode: 2 };
  }

  const radonRec = parseJsonRecord(radon.stdout, "radon");
  const covRec = parseJsonRecord(covRun.stdout, "coverage");
  if (!radonRec) { lines.push("[CRAP] radon 输出不是 JSON 对象"); return { lines, exitCode: 2 }; }
  if (!covRec) { lines.push("[CRAP] coverage 输出不是 JSON 对象"); return { lines, exitCode: 2 }; }

  const complexity = new Map<string, number>();
  for (const [file, blocks] of Object.entries(radonRec)) {
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (!asRecord(block) || typeof block.type !== "string" || typeof block.name !== "string" || typeof block.complexity !== "number") continue;
      if (block.type === "function" || block.type === "method") complexity.set(`${file}:${block.name}`, block.complexity);
    }
  }
  const coverage = new Map<string, number>();
  if (asRecord(covRec.files)) {
    for (const [file, info] of Object.entries(covRec.files)) {
      if (asRecord(info) && asRecord(info.summary) && typeof info.summary.percent_covered === "number") {
        // radon key 经 resolvePath 已是绝对路径;coverage json 的 key 是相对路径,
        // 必须规范化为绝对路径两者才匹配(否则 cov 恒 0 → 假超标)
        coverage.set(resolvePath(cwd, file), info.summary.percent_covered);
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
  lines.push(`[CRAP] 检查 ${checked} 个函数,阈值 ${threshold}`);
  for (const [func, comp, cov, score] of violations) {
    lines.push(`[CRAP] 超标 ${func}: comp=${comp} cov=${cov.toFixed(1)}% crap=${score.toFixed(1)}`);
  }
  if (violations.length) {
    lines.push(`[CRAP] ${violations.length} 个函数超标`);
    return { lines, exitCode: 1 };
  }
  lines.push("[CRAP] 全部通过");
  return { lines, exitCode: 0 };
}

/** 机器级门禁工具的常见安装提示(仅提示;装不装由用户决定)。 */
export const INSTALL_HINTS: Record<string, string> = {
  pytest: "pip3 install pytest",
  mutmut: "pip3 install mutmut",
  radon: "pip3 install radon",
  coverage: "pip3 install coverage",
  "lint-imports": "pip3 install import-linter",
  bats: "apt install bats / brew install bats-core",
  shellcheck: "apt install shellcheck / brew install shellcheck",
  mvn: "apt install maven / sdk install maven",
  "gherkin-utils": "bun add -g @cucumber/gherkin-utils",
  "ai-coding-qa-pipeline": "omp plugin install ai-coding-qa-pipeline(本插件自带门禁,无需独立安装)",
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

/** 取门禁命令的首词工具名。shell 内建 cd 不在 PATH(`which cd` 必失败),故剥离 `cd <path> && ` 前缀
 *  (可循环,路径支持引号)后再取首词——doctor 只认可 PATH 可寻的执行文件。 */
function leadingTool(cmd: string): string {
  let rest = cmd.trim();
  for (;;) {
    const m = rest.match(/^cd\s+("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+)\s*&&\s+/);
    if (!m) break;
    rest = rest.slice(m[0].length).trim();
  }
  return rest.split(/\s+/)[0];
}

/** e2e 取值合法性:null(单值=不启用)或 ∈ {cli,http,playwright}。
 *  支持 YAML 数组或逗号分隔字符串(多 feature 多交互面:项目可用面集合)。非法返回描述,合法返回 null。 */
function validateE2e(value: unknown): string | null {
  const ALLOWED = ["cli", "http", "playwright"];
  if (value === null || value === undefined) return null;
  const vals: string[] = [];
  if (typeof value === "string") {
    vals.push(...value.split(",").map((s) => s.trim()).filter(Boolean));
  } else if (Array.isArray(value)) {
    if (!value.every((v) => typeof v === "string")) return "e2e 数组元素应为字符串(cli|http|playwright)";
    vals.push(...(value as string[]));
  } else {
    return "e2e 应为字符串(单值/逗号分隔)、数组或 null";
  }
  if (vals.length === 0) return "e2e 不能为空";
  for (const v of vals) {
    if (!ALLOWED.includes(v)) return `e2e 取值非法: "${v}"(应为 cli|http|playwright 之一)`;
  }
  return null;
}

/** npm 包级深度前置检查(node 生态门禁命令的隐式依赖;与 lang-profiles "门禁前置要求"表对应)。
 *  只按命令形态显式匹配,不做 npx→npm ls 通用推断(全局工具会误报)。缺失返回 [{label, hint}]。 */
const DEEP_PRE_HINTS: Record<string, string> = {
  "@vitest/coverage-v8": "npm i -D @vitest/coverage-v8",
  "@stryker-mutator/core": "npm i -D @stryker-mutator/core",
  "stryker.conf.js": "模板 skills/pipeline-setup/references/templates/stryker.conf.js(pipeline-setup 第 2.5 步可落地)",
};

function deepPreChecks(gateLabel: string, cmd: string, cwd: string): Array<{ missingLabel: string; hint: string }> {
  const missing: Array<{ missingLabel: string; hint: string }> = [];
  const deps: string[] = [];
  const files: string[] = [];
  if (/vitest/.test(cmd) && /--coverage/.test(cmd)) deps.push("@vitest/coverage-v8"); // vitest --coverage 隐式依赖
  if (/stryker/.test(cmd)) {
    deps.push("@stryker-mutator/core");
    files.push("stryker.conf.js");
  }
  for (const dep of deps) {
    if (!existsSync(join(cwd, "node_modules", dep))) {
      missing.push({ missingLabel: `${gateLabel} 缺 npm 包 ${dep}`, hint: DEEP_PRE_HINTS[dep] ?? `npm i -D ${dep}` });
    }
  }
  for (const f of files) {
    if (!existsSync(join(cwd, f))) missing.push({ missingLabel: `${gateLabel} 缺配置 ${f}`, hint: DEEP_PRE_HINTS[f] ?? `需项目内 ${f}` });
  }
  return missing;
}

export interface DoctorOutcome {
  lines: string[];
  exitCode: number;
  ok: number;
  missing: number;
  skipped: number;
}

/** 冒烟验证:按 quality.yml 声明逐条查门禁工具在位性。cwd 用于解析 quality.yml 路径。 */
export function doctor(qPath: string, cwd = process.cwd()): DoctorOutcome {
  const resolved = resolvePath(cwd, qPath);
  const lines: string[] = [];
  let text: string;
  try {
    text = readFileSync(resolved, "utf8");
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      lines.push(`[doctor] 未找到质量配置: ${resolved}`);
      lines.push('[doctor] 项目尚未接入流水线。请在 omp 会话中对主会话说"初始化质量配置",触发 pipeline-setup 技能生成 .omp/quality.yml;已有项目新增语言门禁同理。');
      return { lines, exitCode: 2, ok: 0, missing: 0, skipped: 0 };
    }
    lines.push(`[doctor] 读取失败: ${resolved} (${e instanceof Error ? e.message : String(e)})`);
    return { lines, exitCode: 2, ok: 0, missing: 0, skipped: 0 };
  }
  let root: Record<string, unknown>;
  try {
    const parsed: unknown = parseYaml(text);
    if (!asRecord(parsed)) throw new Error("quality.yml 顶层不是对象");
    root = parsed;
  } catch (e) {
    lines.push(`[doctor] quality.yml 解析失败: ${e instanceof Error ? e.message : String(e)}`);
    return { lines, exitCode: 2, ok: 0, missing: 0, skipped: 0 };
  }

  let ok = 0, missing = 0, skipped = 0;
  const e2eErr = validateE2e(root.e2e);
  if (e2eErr) {
    lines.push(`[CONFIG] quality.yml ${e2eErr}`);
    return { lines, exitCode: 2, ok, missing, skipped };
  }
  lines.push(`[doctor] 读取 ${resolved}`);
  for (const gate of collectGates(root)) {
    if (gate.cmd === null) {
      lines.push(`[SKIP]     ${gate.label.padEnd(16)} (null,该门禁不启用)`);
      skipped++;
      continue;
    }
    const tool = leadingTool(gate.cmd);
    const found = spawnSync("which", [tool], { encoding: "utf8", cwd }).status === 0;
    if (found) {
      const deep = deepPreChecks(gate.label, gate.cmd, cwd);
      if (deep.length > 0) {
        for (const d of deep) {
          lines.push(`[MISSING-DEP] ${gate.label.padEnd(11)} ${d.missingLabel}   → ${d.hint}`);
          missing++;
        }
      } else {
        lines.push(`[OK]       ${gate.label.padEnd(16)} ${tool}`);
        ok++;
      }
    } else {
      const hint = INSTALL_HINTS[tool] ?? "请安装该工具并加入 PATH";
      lines.push(`[MISSING]  ${gate.label.padEnd(16)} ${tool}   → ${hint}`);
      missing++;
    }
  }
  lines.push(`[doctor] 结论: ${ok} 个工具在位, ${missing} 个缺失, ${skipped} 个跳过`);
  if (missing > 0) return { lines, exitCode: 2, ok, missing, skipped };
  lines.push("[doctor] 环境检查通过");
  return { lines, exitCode: 0, ok, missing, skipped };
}

/** pipeline-state:读/写 `.scratch/<feature>/pipeline-state.json` 编排状态(ADR-0001)。
 *  恢复粒度=环间续跑;schema 校验防主会话手写漂移;机读 JSON 亦人类可读=审计轨迹。
 *  字段:feature / feature_name / requirement / current_ring / completed_rings /
 *  skipped / gates / paths / backprop_budget_left / config_changes(quality.yml 变更
 *  或用户接受的验证缺口,由主会话在 G0 处置 config_gaps 后写入)/
 *  human_review(G0 人工规格卡点审计,string|null:主会话在用户确认/驳回规格后写入)。 */
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
  if (root.config_changes !== undefined && !asStringArray(root.config_changes)) {
    problems.push("字段 config_changes 应为 string[]");
  }
  // human_review:G0 人工规格卡点审计——string=主会话写入的审查结论(如
  // "user approved: <feature> spec @<时间>" / "user rejected: <理由>"),null=尚未审查,
  // undefined=旧状态无此字段(兼容)。类型校验只认 string|null。
  if (root.human_review !== undefined && root.human_review !== null && typeof root.human_review !== "string") {
    problems.push("字段 human_review 应为 string 或 null");
  }
  return problems;
}

/** 编排状态读(无状态文件→空对象;schema 非法→exit 2)。cwd 用于解析相对路径。 */
export function pipelineStateRead(statePath: string, cwd = process.cwd()): GateResult {
  const resolved = resolvePath(cwd, statePath);
  const lines: string[] = [];
  let text: string;
  try {
    text = readFileSync(resolved, "utf8");
  } catch {
    // 无状态文件 = 尚未开始/已清理,输出空对象供恢复方区分"无状态"与"已完成"
    lines.push("{}");
    return { lines, exitCode: 0 };
  }
  let root: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(text);
    if (!asRecord(parsed)) throw new Error("顶层不是对象");
    root = parsed;
  } catch (e) {
    lines.push(`[pipeline-state] 解析失败: ${resolved} (${e instanceof Error ? e.message : String(e)})`);
    return { lines, exitCode: 2 };
  }
  const problems = validateState(root);
  if (problems.length) {
    lines.push(`[pipeline-state] schema 非法: ${problems.join("; ")}`);
    return { lines, exitCode: 2 };
  }
  lines.push(JSON.stringify(root, null, 2));
  return { lines, exitCode: 0 };
}

/** 编排状态写(带 schema 校验;目录自动建)。cwd 用于解析相对路径。 */
export function pipelineStateUpdate(statePath: string, json: string, cwd = process.cwd()): GateResult {
  const resolved = resolvePath(cwd, statePath);
  const lines: string[] = [];
  let next: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!asRecord(parsed)) throw new Error("顶层不是对象");
    next = parsed;
  } catch (e) {
    lines.push(`[pipeline-state] JSON 无效: ${e instanceof Error ? e.message : String(e)}`);
    return { lines, exitCode: 2 };
  }
  const problems = validateState(next);
  if (problems.length) {
    lines.push(`[pipeline-state] schema 非法: ${problems.join("; ")}`);
    return { lines, exitCode: 2 };
  }
  try {
    mkdirSync(dirname(resolved), { recursive: true });
    writeFileSync(resolved, JSON.stringify(next, null, 2) + "\n", "utf8");
  } catch (e) {
    lines.push(`[pipeline-state] 写入失败: ${resolved} (${e instanceof Error ? e.message : String(e)})`);
    return { lines, exitCode: 2 };
  }
  lines.push("[pipeline-state] 状态已写入");
  return { lines, exitCode: 0 };
}

/** 编排状态读写分发。op: "read" | "update"。 */
export function pipelineState(op: string, args: string[], cwd = process.cwd()): GateResult {
  if (op === "read") {
    const statePath = args[0];
    if (!statePath) {
      return { lines: ["用法: ai-coding-qa-pipeline pipeline-state read <state.json路径>"], exitCode: 2 };
    }
    return pipelineStateRead(statePath, cwd);
  }
  if (op === "update") {
    if (args.length < 2) {
      return { lines: ["用法: ai-coding-qa-pipeline pipeline-state update <state.json路径> <json>"], exitCode: 2 };
    }
    const statePath = args[0];
    const json = args.slice(1).join(" ");
    return pipelineStateUpdate(statePath, json, cwd);
  }
  return { lines: ["用法: ai-coding-qa-pipeline pipeline-state read|update <state.json路径> [json]"], exitCode: 2 };
}
