/**
 * ai-coding-qa-pipeline — 插件验证脚本(bun test)。
 *
 * 依据 omp 官方插件实现指导出的可靠验证通道:
 *   1. 单元层:直接断言 src/gates.ts 纯函数(exitCode + 输出行)
 *   2. 集成层(官方通道):loadExtensions() 加载插件 extension →
 *      断言无加载错误、4 个门禁工具全部注册 → 直接调用每个工具的
 *      ToolDefinition.execute()(不经 LLM、离线、确定性)断言返回内容与 exitCode
 *
 * 运行: bun test scripts/verify-plugin.test.ts
 * 发布冒烟(安装层): omp plugin install <tarball> —— 官方 validateInstalledExtensions
 *      在安装时即验证 extension 可解析/import/初始化,失败回滚安装。
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import {
  specCheck,
  crapCheck,
  doctor,
  pipelineState,
  type GateResult,
  type DoctorOutcome,
} from "../src/gates.ts";

const EXTENSION_PATH = join(import.meta.dir, "..", "extensions", "index.ts");
const EXPECTED_TOOLS = ["qa_spec_check", "qa_crap_check", "qa_doctor", "qa_pipeline_state"];

/** 临时目录环境:建造 spec/qa-flow 样例并自动清理。 */
function makeFixture() {
  const dir = mkdtempSync(join(tmpdir(), "qa-pipeline-verify-"));
  const write = (name: string, content: string): string => {
    const p = join(dir, name);
    writeFileSync(p, content, "utf8");
    return p;
  };
  const cleanup = (): void => rmSync(dir, { recursive: true, force: true });
  return { dir, write, cleanup };
}

const GOOD_SPEC =
  '# language: zh-CN\n功能: 示例功能\n  场景: 校验输入\n    假如 存在输入数据\n    当 执行校验\n    那么 校验通过\n';
const BAD_SPEC = "Feature: x\nScenario: s\n  Given a\n";
const GOOD_QA =
  "# QA 流程:示例功能\n## 前置条件\n- 系统已启动\n## 步骤\n| 步骤 | 操作 | 预期结果 |\n| 1 | 执行校验 | 校验通过 |\n";
const BAD_QA = "无标题无小节";

/* ============================== 单元层:gates.ts 纯函数 ============================== */

describe("src/gates.ts 单元层", () => {
  test("specCheck 好样例 exit=0 PASS", () => {
    const fx = makeFixture();
    try {
      const spec = fx.write("good.feature", GOOD_SPEC);
      const qa = fx.write("good-qa.md", GOOD_QA);
      const r = specCheck(spec, qa);
      expect(r.exitCode).toBe(0);
      expect(r.lines.some((l) => l.startsWith("PASS"))).toBe(true);
    } finally { fx.cleanup(); }
  });

  test("specCheck 坏样例 exit=1 且列出缺失步骤家族", () => {
    const fx = makeFixture();
    try {
      const spec = fx.write("bad.feature", BAD_SPEC);
      const qa = fx.write("bad-qa.md", BAD_QA);
      const r = specCheck(spec, qa);
      expect(r.exitCode).toBe(1);
      const joined = r.lines.join("\n");
      expect(joined).toContain("缺少操作步骤类步骤");
      expect(joined).toContain("缺少预期结果类步骤");
    } finally { fx.cleanup(); }
  });

  test("specCheck 文件缺失 exit=2(参数/环境错误)", () => {
    const r = specCheck("/nonexistent/spec.feature", "/nonexistent/qa.md");
    expect(r.exitCode).toBe(2);
  });

  test("crapCheck 无效阈值 exit=2", () => {
    const r = crapCheck(Number.NaN, []);
    expect(r.exitCode).toBe(2);
  });

  test("crapCheck 无可分析路径 exit=2(radon/coverage 需环境,此路径确定性可测)", () => {
    const r = crapCheck(6, ["/nonexistent/path"]);
    expect(r.exitCode).toBe(2);
  });

  test("doctor 缺 quality.yml exit=2(未接入流水线引导)", () => {
    const r = doctor("/nonexistent/quality.yml");
    expect(r.exitCode).toBe(2);
    expect(r.lines.some((l) => l.includes("未找到质量配置"))).toBe(true);
  });

  test("pipelineState read 无状态文件输出 {} exit=0", () => {
    const r = pipelineState("read", ["/nonexistent/state.json"]);
    expect(r.exitCode).toBe(0);
    expect(r.lines[0]).toBe("{}");
  });

  test("pipelineState update 非法 schema exit=2", () => {
    const r = pipelineState("update", ["/tmp/x.json", '{"bad":"shape"}']);
    expect(r.exitCode).toBe(2);
  });

  test("pipelineState update 合法写入后 read 回读一致", () => {
    const fx = makeFixture();
    try {
      const state = join(fx.dir, ".scratch", "demo", "pipeline-state.json");
      const valid = JSON.stringify({
        feature: "demo",
        feature_name: "演示",
        requirement: "演示需求",
        current_ring: "coder",
        completed_rings: ["spec"],
      });
      const w = pipelineState("update", [state, valid]);
      expect(w.exitCode).toBe(0);
      const r = pipelineState("read", [state]);
      expect(r.exitCode).toBe(0);
      const parsed = JSON.parse(r.lines.join("\n"));
      expect(parsed.feature).toBe("demo");
      expect(parsed.completed_rings).toEqual(["spec"]);
    } finally { fx.cleanup(); }
  });
});

/* ============================== 集成层:官方 loadExtensions 通道 ============================== */

describe("extension 集成层(loadExtensions 官方加载器)", () => {
  test("插件 extension 无加载错误", async () => {
    const result = await loadExtensions([EXTENSION_PATH], process.cwd());
    expect(result.errors).toEqual([]);
  });

  test("4 个门禁工具全部注册", async () => {
    const result = await loadExtensions([EXTENSION_PATH], process.cwd());
    const tools = new Set<string>();
    for (const ext of result.extensions) {
      for (const name of ext.tools.keys()) tools.add(name);
    }
    for (const name of EXPECTED_TOOLS) {
      expect(tools.has(name), `缺少工具 ${name}`).toBe(true);
    }
  });

  /** 从加载结果取已注册工具的 execute,直接调用(免 LLM)。 */
  async function executeTool(
    name: string,
    params: Record<string, unknown>,
  ): Promise<{ text: string; exitCode: number }> {
    const result = await loadExtensions([EXTENSION_PATH], process.cwd());
    let tool;
    for (const ext of result.extensions) {
      const t = ext.tools.get(name);
      if (t) { tool = t; break; }
    }
    expect(tool, `工具 ${name} 未注册`).toBeDefined();
    const res = await tool!.definition.execute(
      "verify-test",
      params as never,
      undefined as never,
      undefined as never,
      { cwd: process.cwd() } as never,
    );
    const text = (res.content as Array<{ type: string; text?: string }>)
      .map((c) => c.text ?? "").join("\n");
    const exitCode = (res.details as Record<string, unknown>).exitCode as number;
    return { text, exitCode };
  }

  test("qa_spec_check 坏样例 exit=1(与 CLI 语义一致)", async () => {
    const fx = makeFixture();
    try {
      const spec = fx.write("bad.feature", BAD_SPEC);
      const qa = fx.write("bad-qa.md", BAD_QA);
      const { text, exitCode } = await executeTool("qa_spec_check", { spec_path: spec, qa_flow_path: qa });
      expect(exitCode).toBe(1);
      expect(text).toContain("FAIL [spec]");
    } finally { fx.cleanup(); }
  });

  test("qa_spec_check 好样例 exit=0", async () => {
    const fx = makeFixture();
    try {
      const spec = fx.write("good.feature", GOOD_SPEC);
      const qa = fx.write("good-qa.md", GOOD_QA);
      const { text, exitCode } = await executeTool("qa_spec_check", { spec_path: spec, qa_flow_path: qa });
      expect(exitCode).toBe(0);
      expect(text).toContain("PASS");
    } finally { fx.cleanup(); }
  });

  test("qa_pipeline_state 无状态 read 返回 {} exit=0", async () => {
    const { text, exitCode } = await executeTool("qa_pipeline_state", {
      op: "read",
      state_path: "/nonexistent/state.json",
    });
    expect(exitCode).toBe(0);
    expect(text.trim()).toBe("{}");
  });

  test("qa_doctor 缺 quality.yml exit=2", async () => {
    const { text, exitCode } = await executeTool("qa_doctor", {
      quality_yml_path: "/nonexistent/quality.yml",
    });
    expect(exitCode).toBe(2);
    expect(text).toContain("未找到质量配置");
  });
});