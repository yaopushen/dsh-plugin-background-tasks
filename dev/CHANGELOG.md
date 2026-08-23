# Changelog

## 0.0.1 — 首个公开打包版本

> 公开版本号自此起算。此前的内部迭代号（0.1.0 / 0.2.0）已随打包重置，历史见下方「内部迭代史」。

单工具后台命令执行插件：`run_command` 是 DeepSeek Harness shell / jobs / sandboxPolicy / approval 四个能力缝的模型面 Consumer——命令经 `ctx.shell` 执行器在会话沙箱策略与审批管线约束下运行；超过等待窗口（默认 10 秒）自动晋升进通用 `ctx.jobs` 运行时，由原生 `job_list` / `job_output` / `job_kill` 管控、完成通知由 jobs 消费面投递。

- 超时晋升：窗口内同步返回；超时不杀不弃整体晋升（kind `command`，owner 会话隔离）；`wait_ms: 0` 直接后台；调用中止时立即就地晋升。
- 沙箱与升级：每调用解析会话策略下发 confining executor；越界写以 `[sandbox: file access denied under <mode> mode]` 呈现并附带同轮升级提示；`sandbox_permissions` + `justification` 走共享审批序列。
- 方言引导：常驻提示段覆盖脚本片段语义、SSH 外层单引号规则、字节级文件对比姿势（Compare-Object 集合语义陷阱与 CRLF 盲区）。
- 随包预设「后台任务模式」：派生自标准模式，移除内置 pwsh/bash 解禁行，开箱即单入口。
- 质量：纯适配层 27 用例 + fake 组合集成 16 用例全绿；独立会话验收 8/8 PASS（见 `acceptance-2026-08-23.md`）。

---

## 内部迭代史（版本号重置前，仅供考古）

### 内部 0.2.0 — 2026-08-23

seam-aligned 重写（相对内部 0.1.0 为破坏性变更）：退役自管 TaskManager / 日志体系 / followup 唤醒器 / `manage_background_task` 工具，配置收敛为 `waitMsBeforeAsync` 单键；新增纯适配层与两套回归；P0 加固批次（abort 提前晋升、升级提示 marker、shellEnv 缺失告警、编排层集成回归）。完整记录：`sandbox-integration.md` §4–§6。

### 内部 0.1.0

自管进程池架构初版：raw spawn + 超时晋升 + `manage_background_task` + followup 唤醒。已知缺陷审查存档：`plan-review-v0.1.md`。
