# 沙箱接入设计（调研结论 + 已定档并实现）

> 状态：调研完成 → 实测确认 → **已实现 Tier B**（v0.2.0，2026-08-23）。§1–§3 保留为历史调研记录，定档证据与实现记录见 §4 与 §6。

## 1. 背景与根因

首会话以全磁盘 / 桌面目录启动，agent 经 `run_command` 检查 cwd 时落在 `D:\桌面`。

根因在 `src/manager.ts` 的 cwd 解析：

```ts
const cwd = resolve(request.cwd ?? process.cwd())
```

未显式传 `cwd` 时继承宿主进程的 `process.cwd()`（即桌面启动目录），而非会话工作区。原生 `tool-bash` 不踩这个坑，因为它吃的是**会话 header 里的 cwd**。

## 2. 宿主已有的收口三件套（证据）

`packages/shell/tool-bash/src/index.ts` 中的原生 bash 工具已给出完整范式：

- **会话级 cwd**：`exec.agent.session.header.cwd`（`tool-bash/src/index.ts:149`）—— 这才是工作区，不是 `process.cwd()`。
- **动态沙箱策略**：`ctx.get('sandboxPolicy').resolve({ session: exec.agent.session })`（`:194`、`:200`）返回 `SandboxExecutionPolicy`，携带 `mode` 与 `workspaceRoot`。`resolveWorkdir`（`:144`）明确"解析出的 sandbox-policy root 优先，让 workdir 与 confinement 用同一个 per-call 身份"。
- **进程级 confinement**：`ctx.shell.run(ctx.shell.resolve({ command, workdir, sandboxPolicy: policy }))`（`:380`）。底层执行器（`@deepseek-ai/dsh-sandbox-local` 的 `bwrapProfileArgs` / `seatbeltProfileArgs({ mode, workspaceRoot })`，见 `packages/examples/agent-spine-demo/tests/multi-project-sandbox.e2e.ts:13-24`）用 bwrap/seatbelt 把进程的**文件系统访问物理限制在 `workspaceRoot` 内**——`D:\桌面` 不在根里，根本碰不到。

### 结论

直接接 sandbox **能解决桌面乱扫这一核心问题**，而且 `ctx.sandboxPolicy.resolve(exec)` 已经按"会话 mode 日志 + 不可变 cwd"动态更新——即用户设想的"按权限配置动态收口"宿主已实现，插件只需去消费它，无需自建静态 `workspaceRoot` 配置。

顺带：原生 shell 命令走 `ctx.shell` + `ctx.jobs`（后台句柄注册进 `ctx.jobs`，用 `job_*` 收集/终止），升级宽权限时走 `ctx.approval`（`approveEscalation`）。本插件手搓了平行注册表、绕开这两层（旧审查 P1-6），接回它们还能顺手堵上"绕过审批"的洞。

## 3. 设计方案

### Tier A —— 最小改动（保留自管进程，补 cwd + 沙箱包裹）

- `inject` 增加 `'shell'` + `'sandboxPolicy'`。
- 默认 `cwd` 改吃 `exec.agent.session.header.cwd`（根治桌面乱扫）。
- `resolve` 出 `policy.workspaceRoot` / `mode`；宿主挂了 confining executor 就把命令交给 `ctx.shell.run(...)`，否则回退 `spawn` 但用 `policy.workspaceRoot` 作 cwd 兜底 + 越界拒绝。
- 改动小、风险低，先止血。

### Tier B —— 完全对齐 harness seam（退役自管 TaskManager）

- `run_command` 直接走 `ctx.shell.run()`，后台句柄注册进 `ctx.jobs`（用 `job_*` 管），审批回接 `ctx.approval`。
- 一次性关闭三个问题：桌面乱扫 + 绕过审批 + 旧 P1-6 平行注册表。
- 代价：插件大幅重写，且强依赖宿主提供 `shell` / `jobs` / `sandboxPolicy` 三个 service。

## 4. 定档决策（已闭环，2026-08-23）

原挂起的两个实测点在创造模式会话（插件已挂载、非 background-shell 预设）当场验证：

1. **会话 `header.cwd` ≠ 宿主 `process.cwd()`** —— `run_command` 不传 cwd 落在 `D:\桌面`（宿主从桌面启动），而原生 `pwsh` 默认落在 `D:\DEEPSEEK`（会话工作区）；重启宿主后复测仍如此。Tier A 的止血点成立且必要。
2. **四个 seam 全部在位** —— 经 Inspect 服务目录确认宿主注册了 `shell` / `sandboxPolicy` / `jobs` / `approval`，签名齐全。Tier B 的服务前提成立。

**用户拍板直接上 Tier B**：既然四缝齐备，一次性退役自管 TaskManager 与平行注册表，同时关闭桌面乱扫 + 绕过审批 + 旧 P1-6 三个问题。附带发现：归属校验修复曾因「磁盘新构建 ≠ 运行中构建」（宿主 13:45:50 启动早于 14:00:09 重建）而看似失效——重启后跨会话泄漏消失；此教训写入 README 预设安装注意事项。

**范围划界（用户裁定）**：「宿主进程启动目录为 `D:\桌面`」属安装与启动参数层面的事项，**不由插件实现、不在本插件治理范围内**。插件侧已保证任何经 seam 的调用默认落在会话工作区；executor 最深层兜底（`pwsh-local` 的 `config.cwd ?? process.cwd()`）仅在 agentless 且无会话身份的调用中可达，如需收口由部署配置解决。

## 5. 前期已落地的非沙箱修复（历史记录）

- `preset/background-shell/preset.yml`：`run_background_command` → `run_command` 笔误修正。
- `src/tools.ts` + 重建的 `lib/tools.js`：`run_command` 描述加 `SECURITY: … BYPASSES the DSH sandbox and approval pipeline` 警示。
- `src/manager.ts` + `lib/manager.js`：`getTask` / `readTaskLogs` / `killTask` 增加 `sessionId?` 归属校验（跨会话不可见、不可杀）。
- `README.md`：安全边界新增"挂载本插件即视为放弃该 profile 的命令审批保护"。
- `tests/test-manager.mjs`：6 项回归全绿。

## 6. Tier B 实现记录（v0.2.0）

**架构**：单工具 `run_command` 成为 shell/jobs/sandbox/approval 四缝的 Consumer，完全对齐 `tool-bash` / `tool-pwsh` 范式：

- **执行**：晋升进程统一走 `ctx.shell.start(ctx.shell.resolve(request))`；workdir 解析照抄 `resolveWorkdir`（policy workspaceRoot 优先 → `canonicalPath(header.cwd)` 兜底 → 相对路径按会话身份解析）。
- **后台身份**：`jobs.start({ kind: 'command', owner: exec.agent, run })`，JobKindMap 经声明合并扩展 `'command'`；owner 会话隔离、输出收集、取消与完成通知全部由 jobs 运行时与 `tool-jobs` 消费面持有。
- **晋升竞争**：`raceCompletion(proc, waitMs)` 纯函数竞速——进程先结算则同步返回，窗口先到则整体注册进 jobs（不杀不弃）。注册失败时 kill 已启动进程（producer 清理义务）。
- **沙箱/审批**：每调用 `sandboxPolicy.resolve({ session })` 下发完整策略；`sandbox_permissions` + `justification` 走共享 `approveEscalation`（fail-closed，审批禁用即自动拒绝）；split composition（executor confines 但缺 sandboxPolicy）加载即抛错。
- **删除**：`manager.ts`（自管注册表/日志/Base64 直编/taskkill）、`wakeup.ts`（原生 onJobDone→followup 取代）、`manage_background_task` 工具（job_list/job_output/job_kill 承接）、四个相关 config 键。
- **保留**：`preset-installer.ts`、`format.ts`、fail-loud 手写配置解析（仅剩 `waitMsBeforeAsync`）。
- **回归**：`tests/test-shell-exec.mjs` 23 用例全绿（workdir 四分支、outcome 映射、读渲染含 denial marker、竞速器三态、config 校验、codeFence）。
- **依赖接线**：`node_modules/@deepseek-ai/{dsh-shell,dsh-jobs,dsh-sandbox}` junction 指向 harness 包目录；tsconfig paths 补齐八个类型映射；peerDeps 增加 dsh-shell/dsh-jobs/dsh-sandbox。

**预设同步**：随包预设文本更新后需手动同步 `$DSH_HOME/.agent-presets/background-shell/`（安装器幂等跳过已存在目录）。
