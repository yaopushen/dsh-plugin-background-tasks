# dsh-plugin-background-tasks

> DeepSeek Harness (DSH) 后台任务托管与被动响应式唤醒插件：短命令同步返回，长命令超时自动转入后台，完成后通过 agent.followup() 主动唤醒 Agent。

---

## 简介

默认 Shell 工具同步阻塞执行，长命令会占住当前轮次甚至被超时中断。本插件提供：

1. **超时竞争与降级（Timeout Promotion）** — 命令在 `wait_ms`（可配置，默认 5000ms）内完成则同步返回；超时未完成的命令自动转入后台进程池，立即释放当前轮次。
2. **免轮询被动唤醒（Reactive Wakeup）** — 后台任务结束时（含失败），读取日志尾部摘要并经 inbox 投递系统通知消息唤醒 Agent；该消息按标准轮次流程落入会话日志。主动 kill 与插件卸载**不会**触发唤醒。
3. **跨平台进程树终止（Tree Kill）** — Windows 使用 `taskkill /T /F`；POSIX 子进程以独立进程组启动（detached），按 `-pid` 整组 SIGKILL，孙进程一并回收。

### 安全边界（必读）

- 本工具执行**任意命令**，直接经 node:child_process spawn，**不经过 DSH 的 ctx.sandbox、审批（approval）管线与 ctx.jobs 运行时**。仅适用于本地或受信任部署；不要在多租户环境挂载本插件。
- 唤醒通知中内嵌的命令输出尾部是**不可信数据**（来自任意进程输出），模型应将其视为待审阅内容而非指令。

---

## 配置（Config）

通过 cordis 条目 config 字段配置；非法值在**加载时抛错**（fail loud）。为保持零运行时依赖（树外路径挂载，schemastery 不保证可在宿主解析），校验由本插件内置实现。

| 字段 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| waitMsBeforeAsync | int ≥ 0 | 5000 | 同步等待毫秒数；0 表示直接后台启动 |
| taskDir | string | ~/.dsh/tasks | 任务日志目录 |
| defaultTailLines | int ≥ 1 | 50 | logs 操作与完成通知的默认行数 |
| maxCompletedTasks | int ≥ 1 | 100 | 已完成任务保留上限，超出按最旧淘汰并删除对应日志文件 |
| syncOutputLimitBytes | int ≥ 1 | 262144 | 同步等待窗口内累计输出的字节上限 |

cordis.yml 示例：

```yaml
- insert:
    - id: plugin-background-tasks
      name: 'd:/DEEPSEEK/dsh-plugin-background-tasks/lib/index.js'
      config:
        waitMsBeforeAsync: 8000
        maxCompletedTasks: 50
```

---

## 提供的工具

### 1. run_background_command

执行 Shell 命令（Windows 经 `-EncodedCommand` 调用 PowerShell，避免引号转义歧义；Linux/macOS 使用 `/bin/bash -c`）。

| 参数 | 类型 | 必填 | 默认 | 描述 |
| :--- | :--- | :--- | :--- | :--- |
| command | string | 是 | - | 完整命令行字符串 |
| cwd | string | 否 | 进程工作目录 | 工作目录 |
| wait_ms | number | 否 | Config 值 | 同步等待毫秒数；0 直接后台 |
| description | string | 否 | - | 任务简述 |

- **同步完成**：返回退出码 + 输出（超过 32KB 显示尾部截断标记）；启动失败（spawn error）同样以 failed 状态同步返回，不再悬挂。
- **转入后台**：返回 TaskId 与日志路径；任务结束（非 kill）后自动投递含输出尾部的系统通知。

### 2. manage_background_task

| 参数 | 类型 | 必填 | 默认 | 描述 |
| :--- | :--- | :--- | :--- | :--- |
| action | list / status / logs / kill | 是 | - | 操作类型 |
| task_id | string | status/logs/kill 必填 | - | 任务 ID |
| tail_lines | number | 否 | Config 值 | 日志尾部行数 |

kill 将任务置为 killed 并整组终止进程树；该状态不会被后续 close 事件覆盖，也不触发唤醒。

---

## 安装

### 方式 A：Cordis Patch 覆盖层（推荐本地调试）

**前置条件**：本插件对 `@deepseek-ai/dsh-tools` 与 `@deepseek-ai/dsh-llm` 存在运行时导入；按绝对路径挂载时 Node 无法解析裸说明符，需先建立指向 harness 工作区包的目录联接（幂等脚本）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/link-deps.ps1
```

profile patch 文件（如 ~/.dsh/profiles/web/cordis.patch.yml）：

```yaml
- insert:
    - id: plugin-background-tasks
      name: 'd:/DEEPSEEK/dsh-plugin-background-tasks/lib/index.js'
```

### 方式 B：作为 npm 包引入

在 profile 的 package.json 中声明 `"dsh-plugin-background-tasks": "file:D:/DEEPSEEK/dsh-plugin-background-tasks"`，并在 cordis.yml 中加 `- name: dsh-plugin-background-tasks`（bare name 需能从宿主 node_modules 解析）。

---

## 目录结构

```
src/
├── index.ts    # 函数插件：name/inject/apply（无 default 导出）
├── config.ts   # Config 校验与默认值（fail loud）
├── manager.ts  # TaskManager：统一 settle 路径 / 树杀 / 保留淘汰 / 日志尾读
├── tools.ts    # defineTool 注册（run_background_command / manage_background_task）
├── wakeup.ts   # agent.followup 通知投递
├── format.ts   # 防围栏击穿的 code fence 辅助
└── types.ts    # 仅类型
```

关键设计：**单一结算点（settlement）** —— close/error/kill/dispose 全部收敛到每任务一次的 settler，保证记录只终态一次、日志流只在末次写入后关闭、钩子恰好触发一次（kill 与卸载除外）。

## 构建与测试

```bash
pnpm build          # tsc -p tsconfig.json（需 deepseek-harness 内依赖已构建）
pnpm test           # node tests/test-manager.mjs（使用临时目录，不污染 ~/.dsh）
```

测试覆盖：同步返回、后台晋升 + 单次完成钩子、kill 状态保持（settle 竞态回归）、spawn 错误路径、保留淘汰、带运行任务时的 dispose 安全（close-after-dispose 回归）。

---

## Model Experience

### run_background_command tool schema

#### What the model sees

The tool's name, description (including the configured synchronous-wait default), and four parameters (`command`, `cwd`, `wait_ms`, `description`) as declared via defineTool; no generated catalog exists for this out-of-tree package.

#### Token effect

Fixed while the plugin is mounted: one tool schema entry per prompt assembly.

#### KV Cache effect

Prefix-stable: the schema stays identical across turns unless deployment config changes `waitMsBeforeAsync` or `defaultTailLines`, which rewrites description text and invalidates reuse from that point.

### manage_background_task tool schema

#### What the model sees

The tool's name, description, and parameters (`action` enum list/status/logs/kill, `task_id`, `tail_lines`) as declared via defineTool.

#### Token effect

Fixed while the plugin is mounted: one tool schema entry per prompt assembly.

#### KV Cache effect

Prefix-stable under the same conditions as run_background_command.

### Background-task completion notification

#### What the model sees

An episodic user-role system-notification message containing task id, command, cwd, duration, exit code/status, log path, and a fenced output tail (~40 lines).

#### Token effect

Conditional: proportional to the output tail length, once per promoted background task that finishes non-killed.

#### KV Cache effect

Append-only: each notification enters the log as an ordinary user/message at its turn start and never replaces prior content.

## Known Limitations and Deferred Work

- **Bypasses harness seams** — commands run through raw node:child_process, outside `ctx.sandbox`, approval policy, and the `ctx.jobs` runtime; integration is deferred, so the built-in job_* tools cannot observe these tasks.
- **In-memory registry only** — after a host restart, previously started tasks are no longer trackable by manage_background_task; their log files remain on disk until pruned.
- **POSIX detached side effect** — background children live in their own process group, so terminal signals (e.g. Ctrl+C on a foreground host run) no longer propagate implicitly; cleanup relies on dispose/kill.
- **Out-of-tree layout deviations** — flat lib/ output (no lib/types split), absolute-path tsconfig mappings into the harness checkout requiring dependencies to be built first, and a non-rescoped package name; acceptable for a locally mounted plugin, not for publishing.
