# dsh-plugin-background-tasks

> 让长命令不再卡死对话：短命令即时返回结果，长命令自动转入后台，跑完主动汇报——复刻 Google Antigravity 的 `run_command` 工作流体验。

---

## 简介

对话式开发里最影响手感的事，莫过于一条构建、训练或下载命令把整个会话挂住。本插件把 Antigravity 的「超时竞争」工作流带到 DeepSeek Harness：

1. **长命令异步化** — 命令先同步等待 10 秒：跑完直接给结果；没跑完就整体转入后台，对话立即释放，你继续干别的，互不打断。
2. **完成主动汇报** — 后台命令结束时自动推送结果摘要（退出码 + 输出尾部），零轮询、不用催。
3. **状态随时可查可控** — 每个后台任务有 ID；列表、读输出、终止都是现成工具，与宿主原生后台任务共用同一套界面。
4. **安全不越界** — 命令走宿主统一执行通道：会话沙箱策略与审批管线照常生效；万一被策略拦下，会明确告诉你如何合规重试。
5. **开箱即用** — 自带「后台任务模式」预设：新建会话选它即得单入口体验；Windows / Linux / macOS 全平台。

> 参数命名对齐 Antigravity 官方的 `run_command` 合约（`CommandLine` / `Cwd` / `WaitMsBeforeAsync`），模型侧习惯零成本迁移。

### 安全边界（必读）

- 命令经由 DSH 的 `ctx.shell` 执行器运行，**受会话沙箱模式约束**：confining executor 在位的部署中，越界文件操作以 `[sandbox: file access denied under <mode> mode]` 标记呈现（升级面在位的组合还会附带与原生 shell 工具逐字一致的同轮升级提示）；`danger-full-access` 会话不设限是该模式自身的语义，不是插件旁路。注意该词汇表约束的是**写效果**——读操作在任何模式下都不受限。
- 加宽请求走 `ctx.approval` 审批管线：审批禁用的会话中升级会被**自动拒绝**（fail-closed），不存在绕过路径。
- 后台任务按 owner 会话隔离：跨会话不可见、不可收集、不可杀；owner 销毁时任务被取消并等待结算。
- `ctx.jobs` 未组合时工具直接报错（fail loud）：每个 `run_command` 调用都必须保持可收集、可停止。

---

## 配置（Config）

可在 profile 的 `cordis.patch.yml` 或主配置中通过条目的 `config` 字段覆盖；非法类型在**加载时即抛错**（fail loud）。为保证树外 link/path 挂载时的最小运行时依赖，校验由插件内置安全实现。

| 字段 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `waitMsBeforeAsync` | int ≥ 0 | `10000` | 同步等待毫秒数（对齐 Antigravity 10 秒标准）；设为 `0` 则直接后台启动 |

```yaml
# cordis.patch.yml 覆盖配置示例
- insert:
    - id: dsh-plugin-background-tasks
      name: dsh-plugin-background-tasks
      config:
        waitMsBeforeAsync: 10000   # 统一标准：10 秒
```

---

## 提供的工具 (Tools)

### `run_command`

通过挂载的 DSH shell 执行器运行系统命令（Windows 为 PowerShell 家族，Linux/macOS 为 bash）。

| 参数 | 类型 | 必填 | 默认值 | 描述 |
| :--- | :--- | :--- | :--- | :--- |
| `command` | `string` | 是 | - | 待执行的完整命令行字符串 |
| `cwd` | `string` | 否 | 会话工作区 | 命令执行的工作目录；相对路径按会话身份解析 |
| `wait_ms` | `number` | 否 | `10000` | 动态同步等待毫秒数；传入 `0` 则直接后台启动 |
| `description` | `string` | 否 | - | 任务简短说明（同时作为 job 列表标签） |
| `sandbox_permissions` | `string` | 否 | - | 仅限对刚发生的沙箱拒绝做一次性同轮加宽重试；需配 `justification` 并经用户审批（仅 confining 组合广告此参数） |
| `justification` | `string` | 否 | - | 与 `sandbox_permissions` 成对出现的给用户的一句话理由 |

- **同步完成**：返回退出码 + 合并输出（executor 负责输出预算与 spill 文件标注）；启动失败以 `killed` 结算并在 stderr 带错误，绝不悬挂。
- **转入后台**：返回 `[Background Task Started]` 与 `JobId`（`command-N`）；此后用原生 `job_*` 工具管控，完成通知由 jobs 消费面自动投递。

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

**组合前提**：profile 需组合 `ctx.shell` 执行器（缺省 fail loud）、`@deepseek-ai/dsh-jobs-local` + `@deepseek-ai/dsh-tool-jobs`（jobs 缺省时调用即报错）；confining executor 在位时需 `ctx.sandboxPolicy`（缺失则加载即抛错，与原生 shell 工具同一判据）。

**树外路径挂载的依赖解析**：插件以绝对路径挂载在宿主工作区之外时，Node 需要能从本目录解析 `@deepseek-ai/*` 运行时包。运行 `scripts/link-deps.ps1` 一次即可幂等建立指向 harness 工作区的 junction（要求 harness 已构建）。

### 零提示词的“无感化”使用体验（后台任务预设）

插件加载时会自动把 `preset/background-shell/` 释放到 `$DSH_HOME/.agent-presets/background-shell/`：
- 在 Web GUI 新建会话时，选择预设 **「后台任务模式」** 即可。
- 该预设继承标准编程模式的全部功能（文件读写、检索、工作流、计划等），唯一区别在于**移除了代理面的 pwsh/bash 解禁行**，模型在面对任何终端操作时将天然以 `run_command` 为唯一单入口，无需在系统提示词中增加说教规则。
- 注意：安装器幂等且**跳过已存在的目标目录**——更新随包预设后需手动同步 `$DSH_HOME` 下的副本（或删除该目录让安装器重建）。

---

## 目录结构

```
dsh-plugin-background-tasks/
├── package.json               # Bundle 声明、files 导出白名单
├── cordis.patch.yml           # Bundle 默认挂载补丁
├── preset/                    # 随包附带预设（自动释放）
│   └── background-shell/      # 单入口 Shell 派生预设（agent.cordis.yml / preset.yml）
├── scripts/
│   └── link-deps.ps1          # 树外路径挂载时的依赖 junction 接线（幂等）
├── src/
│   ├── index.ts               # 函数插件入口（inject ['tools','shell','systemPrompt']；split-composition fail loud）
│   ├── config.ts              # fail-loud 配置解析器（默认 10s 等待窗口）
│   ├── tools.ts               # run_command Consumer（晋升竞争、审批升级、jobs 注册）
│   ├── shell-exec.ts          # 纯适配层（workdir 解析、outcome 映射、读渲染、竞速器）
│   ├── preset-installer.ts    # 预设幂等自动释放辅助器
│   ├── format.ts              # 防 Markdown 围栏击穿工具
│   └── types.ts               # 强类型定义
├── lib/                       # 编译产物（随库提交，供 link 挂载免构建部署）
├── tests/
│   ├── test-shell-exec.mjs    # 纯适配层回归（27 用例，无宿主依赖）
│   └── test-tool-execute.mjs  # 编排层集成回归（fake ctx，16 用例）
└── dev/                       # 内部研发基线与 changelog（不入发布包，见 dev/README.md）
```

---

## Model Experience

### `run_command` tool schema

#### What the model sees

The tool's name, description (with configured wait window), parameters (`command`, `cwd`, `wait_ms`, `description`, plus the escalation pair only when a confining executor is mounted), and the string output contract.

#### Token effect

Fixed while the plugin is mounted: one tool schema entry per prompt assembly.

#### KV Cache effect

Prefix-stable: schema text is identical across turns unless deployment overrides `waitMsBeforeAsync` or the composition's confinement changes which parameters are advertised.

### Dialect-guidance prompt section

#### What the model sees

A standing system-prompt section (`tool:run_command`) teaching the failure classes observed in the wild on bare compositions: verbatim script-fragment semantics (never whole-command quoting), SINGLE-quote wrapping for SSH remote arguments (bash-style `\"` nesting mangles silently), and byte-truth file comparison idioms using built-ins (`fc.exe /b`, `Get-FileHash`, CRLF counting) with Compare-Object's set-semantics caveat.

#### Token effect

Fixed while the plugin is mounted: roughly 100 tokens per prompt assembly.

#### KV Cache effect

Prefix-stable.

### Background completion notification

#### What the model sees

Delivered natively by the jobs consumer (`tool-jobs`), not by this plugin: an episodic user-role system message with job id, label, terminal status/detail, and the output tail capped by the registry.

#### Token effect

Conditional: proportional to the output tail, once per promoted job that finishes non-killed and unreported.

#### KV Cache effect

Append-only: each notice enters the session log as an ordinary user-role message and never replaces prior content.

---

## Known Limitations and Deferred Work

- **Promotion pre-starts before registry preflight** — racing a live process inherently starts it before `jobs.start` runs its preflight; a rejected registration kills the partial start, but the process does briefly exist outside the registry in that failure window.
- **Requires a composed jobs runtime** — without `@deepseek-ai/dsh-jobs-local` (+ `tool-jobs`) every call fails loudly; there is no sync-only degradation, because a command that outlives its turn must remain collectable.
- **No executor timeout inside the wait window** — promotion uses `shell.start()`, whose spec ignores `timeoutMs`; `wait_ms` alone governs when the turn is released, so a model passing an enormous `wait_ms` blocks its own turn by request.
- **Confinement completeness inherits the mounted backend** — enforcement quality (e.g. Windows ACL restricted-token runner) is the executor's contract, not this plugin's.
- **Preset installer skips existing directories** — packaged-preset edits do not propagate to already-installed copies without manual sync.

## 文档

- **发布面**：本 README 即发布文档，自足可用。
- **内部研发基线**（设计决策记录、验收报告、历史存档）与**版本史**：[`dev/`](dev/README.md)，不随 npm 包发布。

## 开源许可

MIT
