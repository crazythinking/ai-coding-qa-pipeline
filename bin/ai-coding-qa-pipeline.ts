#!/usr/bin/env bun
/**
 * ai-coding-qa-pipeline — 六-agent 开发流水线的门禁 CLI。
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
 * 实现:核心逻辑在 src/gates.ts(纯函数),本文件仅为 CLI 薄壳;同一逻辑经 extensions/
 * 注册为 omp 插件工具,主会话可直接调用(见 extensions/index.ts)。
 */

import { specCheck, crapCheck, doctor, pipelineState } from "../src/gates.ts";

const HELP =
  "ai-coding-qa-pipeline — 六-agent 流水线门禁 CLI\n" +
  "用法: ai-coding-qa-pipeline <子命令> [参数]\n" +
  "  spec-check <spec.feature> <qa-flow.md>   G0 规格门禁(L1语法+L2结构+qa-flow模板)\n" +
  "  crap-check [--threshold N] [paths...]     CRAP 组合器(radon+coverage)\n" +
  "  doctor [quality.yml路径]                  §5.1冒烟验证:按声明逐条查门禁工具在位性\n" +
  "  pipeline-state read|update <state.json> [json]\n" +
  "                                           编排状态读/写(ADR-0001,环间恢复+审计)\n" +
  "退出码: 0=通过 1=不合格 2=参数/依赖错误(环境问题)";

const cmd = process.argv[2] ?? "";
let result: { lines: string[]; exitCode: number } | undefined;

if (cmd === "spec-check") {
  const args = process.argv.slice(3);
  if (args.length !== 2) {
    console.log("用法: ai-coding-qa-pipeline spec-check <spec.feature> <qa-flow.md>");
    process.exit(2);
  }
  result = specCheck(args[0], args[1]);
} else if (cmd === "crap-check") {
  let threshold = 6;
  const paths: string[] = [];
  for (let i = 3; i < process.argv.length; i++) {
    if (process.argv[i] === "--threshold") threshold = Number(process.argv[++i]);
    else paths.push(process.argv[i]);
  }
  result = crapCheck(threshold, paths);
} else if (cmd === "doctor") {
  result = doctor(process.argv[3] ?? ".omp/quality.yml");
} else if (cmd === "pipeline-state") {
  const args = process.argv.slice(3);
  const [op, ...rest] = args;
  result = op ? pipelineState(op, rest) : undefined;
} else {
  console.log(HELP);
  process.exit(2);
}

for (const line of result.lines) console.log(line);
process.exit(result.exitCode);
