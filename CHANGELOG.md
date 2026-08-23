# Changelog

## 0.2.0 — 2026-08-23

**seam-aligned 重写（破坏性）**：`run_command` 成为 shell / jobs / sandbox / approval 四个能力缝的模型面 Consumer，完全对齐 `dsh-tool-bash` / `dsh-tool-pwsh` 官方范式。

### 新增
- 执行走 `ctx.shell` 执行器：workdir 按「沙箱 workspaceRoot → 会话 header.cwd」解析；越界文件操作呈现 `[sandbox: file access denied under <mode> mode]`，confining 组合附带同轮升级提示。
- 后台晋升进入通用 `ctx.jobs` 运行时（kind `command`，owner 会话隔离），由原生 `job_list` / `job_output` / `job_kill` 管控，完成通知由 jobs 消费面投递。
- 同轮沙箱升级：`sandbox_permissions` + `justification` 经共享 `approveEscalation` 序列走 `ctx.approval`。
- 工具调用在等待窗口内被中止时，立即就地晋升（进程即刻获得归属）。

### 移除（破坏性）
- **`manage_background_task` 工具**——职责由原生 `job_*` 工具承接。
- 自管 TaskManager、日志文件体系与唤醒器（`agent.followup` 手搓投递）；连带移除配置键 `taskDir` / `defaultTailLines` / `maxCompletedTasks` / `syncOutputLimitBytes`。
- 安全边界变更：不再绕过 DSH 沙箱与审批管线（v0.1 的 trusted-environment-only 警告随之作废）。

### 内部
- 新增纯适配层 `src/shell-exec.ts` 与两套回归：单元 27 用例 + fake-ctx 集成 16 用例，全绿。
- `scripts/link-deps.ps1` 补齐三个新运行时依赖的 junction 接线。

## 0.1.0 — 初始版本

自管进程池架构：raw spawn + 超时晋升 + `manage_background_task` + followup 唤醒。已知缺陷见 `docs/plan-review-v0.1.md`（存档）。
