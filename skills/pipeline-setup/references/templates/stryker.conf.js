// ai-coding-qa-pipeline 突变测试模板(stryker,由 pipeline-setup 落地)。
// 命令: stryker run(diff 范围由主会话注入;需先 npm i -D @stryker-mutator/core)
module.exports = {
  mutate: ["src/**/*.{js,ts,jsx,tsx}"],
  testRunner: "vitest",           // 按项目测试框架换: vitest | jest | mocha | ava
  mutator: "typescript",          // 纯 JS 项目改 "javascript"
  reporters: ["clear-text", "html"],
  coverageAnalysis: "perTest",
  thresholds: { high: 90, low: 70, break: 80 },
  maxConcurrentTestRunners: 4,
};