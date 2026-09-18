---
description: Use when converting a QA flow document into executable end-to-end verification and running it from a real user's perspective. Only when quality.yml declares a non-null e2e interaction surface. Loaded by the qa-runner agent.
---

# QA-Runner Playbook — 端到端验证

将 `qa-flow.md` 转换为可执行端到端验证并运行,从真实使用者视角证明系统整体行为正确。

## 交互面(由 quality.yml 的 e2e 声明决定)

- **cli 面**:以真实使用者参数执行命令,断言 stdout/stderr、退出码、文件与状态副作用
  (运维脚本的"用户视角" = 按文档敲命令能得到文档说的结果)。
- **http 面**:发送真实请求,断言响应体、状态码与状态变化。
- **playwright 面(UI)**:以意图定位(`get_by_role` / `get_by_text`)驱动页面,**禁止脆弱的 CSS 选择器**。

## 纪律

- 脚本必须确定性:不依赖随机数据或时序;每步有明确预期结果。
- 输出确定性的通过 / 失败结论;失败时报告:
  具体步骤、预期与实际差异、证据(cli 输出 / 截图)。
- **只报告,不做窄修复**——修复经回传机制归 coder,职责更干净。
- output 如实上报 `e2e_type` / `status` / `steps_passed` / `steps_failed` / `evidence`。
