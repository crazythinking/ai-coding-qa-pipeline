// ai-coding-qa-pipeline 依赖约束模板(dependency-cruiser,由 pipeline-setup 落地)。
// 命令: depcruise {diff_source_paths}(缺配置即报错,故默认放行=需先有规则才生效)
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      comment: "禁止循环依赖",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-orphans",
      comment: "禁止孤儿模块(无人引用的模块)",
      severity: "error",
      from: {
        orphan: true,
        pathNot: ["\\.d\\.ts$", "^(test|tests|spec|scripts)/", "(^|/)(test|tests|spec|__tests__)/"],
      },
      to: {},
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    tsConfig: { fileName: "tsconfig.json" },
    reporterOptions: { tabular: { showUnresolved: false } },
  },
};