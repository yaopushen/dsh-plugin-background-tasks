# dsh-plugin-background-tasks

> DeepSeek Harness (DSH) 后台任务托管与被动响应式唤醒插件：短命令同步返回，长命令超时自动转入后台，完成后通过 agent.followup() 主动唤醒 Agent。

---

## 简介

在默认情况下，LLM Harness 的 Shell 工具多采用同步阻塞执行模式。长耗时命令（数据清洗、构建编译、大文件下载、模型训练等）会长时间霸占会话轮次甚至被超时中断。

本插件提供了一套参照 **Antigravity** 架构的进程托管与事件驱动唤醒机制：

1. **超时竞争与降级（Timeout Promotion）** — 命令在 `wait_ms`（默认 **10000ms / 10 秒**，可配置）内完成则直接同步返回；超时未完成的命令自动转入后台进程池并分配 TaskId，立即释放当前轮次，Agent 恢复空闲，不阻塞后续用户交互。
2. **免轮询被动唤醒（Reactive Wakeup）** — 后台任务结束时（无论成功或失败），自动抓取最新日志尾部摘要，通过 `agent.followup()` 投递结构化系统通知唤醒 Agent。消息按标准流程持久化到会话日志中（满足 `model-visible ⟺ logged` 核心不变量），Agent 零轮询 Token 损耗。主动 kill 与插件卸载**不会**触发唤醒。
3. **跨平台进程树终止（Tree Kill）** — Windows 使用 `taskkill /T /F` 级联查杀；POSIX 子进程以独立进程组启动（`detached: true`），按 `-pid` 整组发送 `SIGKILL`，孙进程一并彻底回收，防止后台脚本泄漏。
4. **PowerShell 引号安全与 Base64 直编** — Windows 下通过 `-EncodedCommand` 内存直编 UTF-16LE Base64 脚本执行，彻底杜绝外层 CLI 命令行对复杂嵌套引号、换行符和管道符的二次转义歧义，同时默认注入 `$ProgressPreference = 'SilentlyContinue'` 消除 CLIXML 进度噪声。
5. **自带预设自动安装（Auto Preset Packaging）** — 插件随包携带 `preset/background-shell/` 预设，加载时自动写入 `$DSH_HOME/.agent-presets/`，在新会话中选择「后台任务模式」即可享受纯净单入口 Shell 体验。

### 安全边界（必读）

- 本工具执行**任意命令**，直接经 `node:child_process` spawn，**不经过 DSH 的 `ctx.sandbox`、审批（approval）管线与 `ctx.jobs` 运行时**。仅适用于本地或受信任部署；不要在多租户未隔离环境中挂载本插件。
- 唤醒通知中内嵌的命令输出尾部是**不可信数据**（来自外部进程输出），模型将其作为结果事实审阅，不作为指令执行。

---

## 配置（Config）

可在 profile 的 `cordis.patch.yml` 或主配置中通过条目的 `config` 字段覆盖；非法类型在**加载时即抛错**（fail loud）。为保证树外 link/path 挂载时的零外部运行时依赖，校验由插件内置安全实现。

| 字段 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `waitMsBeforeAsync` | int ≥ 0 | `10000` | 同步等待毫秒数（对齐 Antigravity 10 秒标准）；设为 `0` 则直接后台启动 |
| `taskDir` | string | `~/.dsh/tasks` | 任务日志持久化目录 |
| `defaultTailLines` | int ≥ 1 | `50` | `logs` 操作与完成唤醒通知的默认读取行数 |
| `maxCompletedTasks` | int ≥ 1 | `100` | 已完成任务保留上限，超出按最旧淘汰并自动清理对应日志文件 |
| `syncOutputLimitBytes` | int ≥ 1 | `262144` | 同步等待窗口内累计输出的内存字节上限（256 KB） |

```yaml
# cordis.patch.yml 覆盖配置示例
- insert:
    - id: dsh-plugin-background-tasks
      name: dsh-plugin-background-tasks
      config:
        waitMsBeforeAsync: 10000
        maxCompletedTasks: 50
```

---

## 提供的工具 (Tools)

### 1. `run_command`

执行系统 Shell 命令（Windows 经 `-EncodedCommand` 调用 PowerShell；Linux/macOS 使用 `/bin/bash -c`）。

| 参数 | 类型 | 必填 | 默认值 | 描述 |
| :--- | :--- | :--- | :--- | :--- |
| `command` | `string` | 是 | - | 待执行的完整命令行字符串 |
| `cwd` | `string` | 否 | 宿主工作目录 | 命令执行的工作目录 |
| `wait_ms` | `number` | 否 | `10000` | 动态同步等待毫秒数；传入 `0` 则立即挂入后台 |
| `description` | `string` | 否 | - | 任务简短说明 |

- **同步完成**：返回退出码 + 标准输出/错误（超过 32KB 显示尾部截断标记与全量日志路径）；启动失败（spawn error）同步返回 `failed`，绝不悬挂。
- **转入后台**：返回 `[Background Task Started]`、TaskId 与日志文件路径；后台进程退出后自动触发系统通知唤醒。

### 2. `manage_background_task`

管理由 `run_command` 启动的后台任务。

| 参数 | 类型 | 必填 | 默认值 | 描述 |
| :--- | :--- | :--- | :--- | :--- |
| `action` | `string` | 是 | - | 操作类型：`list`、`status`、`logs`、`kill` |
| `task_id` | `string` | 部分必填 | - | 任务 ID（`status`、`logs`、`kill` 操作必选） |
| `tail_lines` | `number` | 否 | `50` | `logs` 操作时获取的日志尾部行数 |

- `list`：列出所有运行中与历史完成的任务及状态。
- `status`：查看指定任务的耗时、退出码、日志路径与状态。
- `logs`：读取日志尾部（512KB 内存滑动窗口分块，防止大日志打爆内存）。
- `kill`：彻底递归查杀指定任务的进程树，状态永久置为 `killed`，绝不误发完成唤醒。

---

## 安装与注册方式

本插件遵循标准 DSH Bundle 规范，自带 `dsh.bundle` 补丁声明与随包预设：

```powershell
# 1. 注册安装到指定 profile（例如 web profile）
dsh plugin --profile web add "dsh-plugin-background-tasks@link:D:/DEEPSEEK/dsh-plugin-background-tasks" -w

# 2. 检查配置层生效状态（权威诊断，应显示 - id: dsh-plugin-background-tasks）
dsh --profile web --dump-config | Select-String background

# 3. 启动 DSH Web
dsh web
```

### 零提示词的“无感化”使用体验（后台任务预设）

插件加载时会自动把 `preset/background-shell/` 释放到 `$DSH_HOME/.agent-presets/background-shell/`：
- 在 Web GUI 新建会话时，选择预设 **「后台任务模式」** 即可。
- 该预设继承标准编程模式的全部功能（文件读写、检索、工作流、计划等），唯一区别在于**移除了代理面的 pwsh/bash 解禁行**，模型在面对任何终端操作时将天然以 `run_command` 为唯一单入口，无需在系统提示词中增加说教规则，彻底复刻 Antigravity 体验。

---

## 目录结构

```
dsh-plugin-background-tasks/
├── package.json               # Bundle 声明、files 导出白名单
├── cordis.patch.yml           # Bundle 默认挂载补丁
├── preset/                    # 随包附带预设（自动释放）
│   └── background-shell/      # 单入口 Shell 派生预设（agent.cordis.yml / preset.yml）
├── src/
│   ├── index.ts               # 函数插件入口（无 default 导出，防 loader 丢弃 inject）
│   ├── config.ts              # fail-loud 配置解析器（默认 10s 超时窗口）
│   ├── manager.ts             # TaskManager 核心类（单结算点、Base64 直编、进程树查杀、日志截断）
│   ├── tools.ts               # defineTool 声明（run_command / manage_background_task）
│   ├── wakeup.ts              # agent.followup 响应式消息投递
│   ├── preset-installer.ts    # 预设幂等自动释放辅助器
│   ├── format.ts              # 防 Markdown 围栏击穿工具
│   └── types.ts               # 强类型定义
├── lib/                       # 编译产物
└── tests/
    └── test-manager.mjs       # 自动化回归测试套件（临时目录，无副作用）
```

---

## Model Experience

### `run_command` tool schema

#### What the model sees

The tool's name, description (with configured 10000ms synchronous default), and parameters (`command`, `cwd`, `wait_ms`, `description`) as declared via `defineTool`.

#### Token effect

Fixed while the plugin is mounted: one tool schema entry per prompt assembly.

#### KV Cache effect

Prefix-stable: schema text is identical across turns unless deployment overrides `waitMsBeforeAsync` in config.

### `manage_background_task` tool schema

#### What the model sees

The tool's name, description, and parameters (`action` enum `list`/`status`/`logs`/`kill`, `task_id`, `tail_lines`) as declared via `defineTool`.

#### Token effect

Fixed while the plugin is mounted: one tool schema entry per prompt assembly.

#### KV Cache effect

Prefix-stable across turns.

### Background-task completion notification

#### What the model sees

An episodic user-role system-notification message containing task id, command, cwd, duration, exit code/status, log path, and a fenced output tail (~40 lines).

#### Token effect

Conditional: proportional to the output tail length, once per promoted background task that finishes non-killed.

#### KV Cache effect

Append-only: each notification enters the session log as an ordinary `user/message` at its turn start and never replaces prior content.

---

## Known Limitations and Deferred Work

- **Bypasses harness seams** — commands run through raw `node:child_process`, outside `ctx.sandbox`, approval policy, and the `ctx.jobs` runtime; integration is deferred.
- **In-memory registry only** — after a host restart, previously started task handles are no longer trackable by `manage_background_task`; their log files remain on disk until pruned by retention cap.
- **POSIX detached side effect** — background children live in their own process group, so terminal signals (e.g. Ctrl+C on a foreground host run) no longer propagate implicitly; cleanup relies on dispose/kill.

## 开源许可

MIT
