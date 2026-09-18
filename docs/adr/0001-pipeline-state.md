# 流水线编排状态落盘为 .scratch/<feature>/pipeline-state.json

feature 名与编排状态(当前环、已完成环、各环门禁证据)过去只活在主会话内存中,
会话中断(clear/换会话/进程退出)即全部丢失,无法恢复也无法审计——git 阶段提交
(§6)只在 git 项目有效,且只记提交不记机读状态。因此将编排状态落盘为
`.scratch/<feature>/pipeline-state.json`,由主会话在每环门禁通过后更新。

决策内容:

- **每 feature 一状态文件**,与流水线产物同目录(`.scratch/<feature>/pipeline-state.json`),
  与产物同生命周期,feature 删除即消失,不污染项目配置。
- **恢复粒度 = 环间续跑,不承诺环内**:环是 fresh 子代理,环内恢复无额外价值(失败
  已靠失败报告交接);状态文件只保证"从已完成环的下一环继续"。
- **字段**:feature / feature_name / requirement / current_ring / completed_rings /
  skipped / gates(每环 cmd+exit+evidence)/ paths(spec_path、qa_flow_path)/
  backprop_budget_left。由 CLI 子命令 `pipeline-state` 读写并校验 schema,防止
  主会话手写漂移;机读 JSON 亦人类可读,即审计轨迹(补 git 在非 git 项目下的空缺)。
- **写入时机**:与 §6 阶段提交并行——每环门禁通过后主会话更新。

被拒绝的替代:仅靠 git 阶段提交(非 git 项目无恢复点)、把状态放 `.omp/` 项目级
(与产物生命周期不一致,多 feature 需自己区分)、承诺环内恢复(复杂度高价值低)。
