/**
 * ai-coding-qa-pipeline — omp 插件 extension 入口。
 *
 * 把门禁注册为 omp 插件工具,主会话(orchestrator)在 omp 会话内直接调用,
 * 无需门禁 CLI 进入系统 PATH(替代旧的 `bun link` 第二段安装)。
 *
 * 工具:
 *   qa_spec_check      G0 规格门禁(L1 语法 + L2 结构 + qa-flow 模板)
 *   qa_crap_check      CRAP 组合器(radon cc + coverage json)
 *   qa_doctor          按 quality.yml 声明逐条查门禁工具在位性
 *   qa_pipeline_state  编排状态读/写(ADR-0001,环间恢复+审计)
 *
 * 设计:核心逻辑在 src/gates.ts(纯函数),本文件仅做参数绑定与结果封装,
 * 与 bin/ 薄壳复用同一套逻辑,保证 CLI 与工具行为一致。
 *
 * 零外部 import:运行时只依赖 omp 注入的 `pi.zod` 与 `pi.registerTool`,
 * 不 import @oh-my-pi/* 巨包(omp 宿主加载时按需解析)。
 */

import { specCheck, crapCheck, doctor, pipelineState } from "../src/gates.ts";

/** ExtensionAPI 最小面:只用注入的 zod 与 registerTool,避免 import 宿主包类型。 */
interface MinExtensionAPI {
  zod: {
    object: (shape: Record<string, unknown>) => unknown;
    string: () => unknown;
    number: () => unknown;
    array: (item: unknown) => unknown;
  };
  registerTool: (def: {
    name: string;
    label: string;
    description: string;
    parameters: unknown;
    execute: (
      _id: string,
      params: Record<string, unknown>,
      _signal: unknown,
      _onUpdate: unknown,
      _ctx: { cwd: string },
    ) => Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }>;
  }) => void;
}

/** 门禁结果 → 工具 content(单段文本)。 */
function toContent(lines: string[], exitCode: number): {
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
} {
  return {
    content: [{ type: "text", text: lines.join("\n") }],
    details: { exitCode, passed: exitCode === 0 },
  };
}

export default function extension(pi: MinExtensionAPI) {
  const z = pi.zod;

  pi.registerTool({
    name: "qa_spec_check",
    label: "Spec Check (G0)",
    description:
      "运行 G0 规格门禁:校验 spec.feature 的 Gherkin 语法(L1)与每场景三类步骤结构(L2)," +
      "并校验 qa-flow.md 符合固定模板。退出码 0=通过 1=不合格 2=参数/文件错误。",
    parameters: z.object({
      spec_path: z.string(),
      qa_flow_path: z.string(),
    }),
    async execute(_id, params) {
      const r = specCheck(String(params.spec_path), String(params.qa_flow_path));
      return toContent(r.lines, r.exitCode);
    },
  });

  pi.registerTool({
    name: "qa_crap_check",
    label: "CRAP Check",
    description:
      "运行 CRAP 组合器:radon cc 复杂度 + coverage json 覆盖率 → CRAP 公式,超过阈值判不合格。" +
      "用于 G2 清理环与 G1 编码后的复杂度门禁。paths 为空时对 lib/scripts 兜底。",
    parameters: z.object({
      threshold: z.number().optional(),
      paths: z.array(z.string()).optional(),
    }),
    async execute(_id, params) {
      const threshold = typeof params.threshold === "number" ? params.threshold : 6;
      const paths = Array.isArray(params.paths) ? params.paths.map(String) : [];
      const r = crapCheck(threshold, paths);
      return toContent(r.lines, r.exitCode);
    },
  });

  pi.registerTool({
    name: "qa_doctor",
    label: "Doctor (环境冒烟)",
    description:
      "按 .omp/quality.yml 声明逐条检查门禁工具在位性(只查工具存在,不实跑门禁)。" +
      "缺失工具给出安装提示;exit 2=环境问题,不应重试 agent。",
    parameters: z.object({
      quality_yml_path: z.string().optional(),
    }),
    async execute(_id, params) {
      const qPath = params.quality_yml_path ? String(params.quality_yml_path) : ".omp/quality.yml";
      const r = doctor(qPath);
      return toContent(r.lines, r.exitCode);
    },
  });

  pi.registerTool({
    name: "qa_pipeline_state",
    label: "Pipeline State (编排状态)",
    description:
      "读/写 .scratch/<feature>/pipeline-state.json 编排状态(ADR-0001)。" +
      "op=read:输出当前状态 JSON;无状态文件输出 {}。op=update:<state_path>+<json> 带 schema 校验后写入。" +
      "供主会话环间恢复与审计,执行 agent 不应调用。",
    parameters: z.object({
      op: z.string(),
      state_path: z.string(),
      json: z.string().optional(),
    }),
    async execute(_id, params) {
      const op = String(params.op);
      const statePath = String(params.state_path);
      const rest: string[] = [];
      if (op === "update") {
        if (typeof params.json !== "string") {
          return toContent(["用法: qa_pipeline_state op=update state_path=<path> json=<json>"], 2);
        }
        rest.push(params.json);
      }
      const r = pipelineState(op, [statePath, ...rest]);
      return toContent(r.lines, r.exitCode);
    },
  });
}
