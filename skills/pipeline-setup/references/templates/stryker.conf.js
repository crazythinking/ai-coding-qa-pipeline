// ai-coding-qa-pipeline 突变测试模板(stryker,由 pipeline-setup 落地)。
// 门禁命令: cd <前端根> && npx stryker run --mutate "{diff_source_paths}"
//   - 变异范围由主会话按本次 feature diff 注入:逗号分隔、相对前端根(剥掉 cd 前缀)、只变异改动文件,
//     消除"历史文件堆积在 conf / 本次文件漏变异"的双向错位。
//   - 裸跑 `stryker run`(不带 --mutate)时变异范围取下方 mutate 默认(=全量 src)**兜底**;门禁始终走 --mutate,
//     CLI 选项完全替换 conf 同项(不合并)。
// 需先 npm i -D @stryker-mutator/core @stryker-mutator/vitest-runner(testRunner 对应插件按需换)
module.exports = {
  mutate: ["src/**/*.{js,ts,jsx,tsx}"], // 默认全量;门禁用 CLI --mutate 覆盖
  testRunner: "vitest",           // 按项目测试框架换: vitest | jest | mocha | ava
  mutator: "typescript",          // 纯 JS 项目改 "javascript"
  reporters: ["clear-text", "html"],
  coverageAnalysis: "perTest",
  thresholds: { high: 90, low: 70, break: 80 },
  concurrency: 4,                 // 原 maxConcurrentTestRunners 已废弃
};