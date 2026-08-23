# 工程化接管笔记：让 run_command 成为无感默认

> 状态：2026-08-23 · 基于 commit `e086d22`（描述路由）与 `943f638`（CLIXML 静默）· 本文取代零散讨论，供后续会话确认细节。

## 1. 目标与非目标

- **目标**：模型在任何新会话中发起长 shell 任务（数据清洗、构建、下载等）时，无需任何提示词引导即落入 `run_command` 的超时托管 + 自动唤醒管线——复刻 Antigravity `run_command` 的体验。
- **非目标**：不改动 deepseek-harness 本体；不在用户提示词/系统指令里添加路由说教（除非迫不得已）。

## 2. 已验证事实（证据链）

| # | 事实 | 证据 |
| :-- | :--- | :--- |
| F1 | 插件已经由标准 bundle 机制挂载 | `dsh --profile web --dump-config` 含 `- id: dsh-plugin-background-tasks` 条目；commit `4dc0599` |
| F2 | 组合配置中内置 shell 已被禁用 | 同 dump：`tool-bash` / `tool-pwsh` / `tool-jobs` 均 `disabled: true`，注释标明 patched by `@deepseek-ai/dsh-web-app` |
| F3 | 运行时会话仍可见且可用 pwsh | 本会话（PTC/code-runtime 面）全程调用成功；用户新会话模型亦提及 pwsh |
| F4 | F2 与 F3 并存 ⇒ 存在**会话面动态解禁者**，身份未定 | 见开放问题 Q1 |
| F5 | 非 PTC 会话没有 run_code，呈 native 多工具形态 | 用户陈述；此形态下 defineTool 描述是第一路由杠杆 |
| F6 | 唤醒闭环端到端可用 | 实测：300ms 降级 → 3.60s 完成 → followup → 下一轮收到 `[System Notification]` |
| F7 | 两阶段 preset 会吞掉唤醒 | liangshen `messageSources: [user, goal]` 不含 `plugin`；其注释引 issue #578（被过滤输入可致晋升死锁） |
| F8 | Antigravity 的"自然"来自单入口 | 其时序图中 `run_command` 是唯一 shell 工具，托管逻辑在该工具 execute 内部（`WaitMsBeforeAsync` 竞争-降级），与本插件 manager 同构 |

## 3. 根因分析

Antigravity 无路由问题是因为结构上只有一个门。DSH 中内置 shell 虽然在 host 配置面默认禁用（F2），但被某组件在会话面重新解禁（F4），于是 native 会话出现双入口竞争：`pwsh`（文档明确写了 long-running 用 `run_in_background: true`）对 `run_command`。关键词匹配上前者占优——这正是新会话给出 pwsh 建议的机理。

## 4. 方案矩阵（工程化优先排序）

### S0 结构接管·派生 preset ✅ 已实现

**Q1 已破案**：解禁者是安装侧自带的 standard preset——`apps/cli/config/agent-presets/standard/agent.cordis.yml:44-50` 以平台条件 `!!js` 在代理面重新启用 shell（win32 启用 tool-pwsh）。host 面默认全禁 + preset 面按需解禁，正是"动态解禁"机制的官方形态。

据此落地**零代码、零提示词**方案：派生 preset `~/.dsh/.agent-presets/background-shell/`（复制 standard 全文，仅删除 tool-bash/tool-pwsh 两行；其余逐字节一致，含 plan/compaction/delegation 各 isolate realm）。加入该 preset 的会话继承 host 默认——内置 shell 保持禁用——而插件工具全局在场 ⇒ 单入口自然成立。discovery 热读取，无需重启即可被新会话选择。

回滚：删除该目录即消失。恢复原生 shell：把文件内注释中的两行贴回。

验证：新会话选择「后台任务模式」→ 问「逐字列出可用工具」→ 应无 pwsh/bash 且含 run_command → 直接丢长任务观察托管+唤醒。

### S1 结构接管·插件自动限制（可选增强，暂缓）

思路：插件挂载时监听 agent 生命周期事件（`agent/created` 一族），在每个新 agent 的 scoped context 上执行 `ctx.tools.restrict({ deny: [...] })`，把动态解禁的内置 shell 从该 agent 的可见集中移除。全部会话自动生效，零提示词。

实现要点：

- `restrict` 要求 scoped context（root 上调用抛错），agent scope 合法；deny 名单必须先对照全局注册表已知名（`restrict` 对未知名 fail loud），因此先查 knownNames 再过滤。
- 用 `Config` 字段开关（如 `suppressBuiltinShells: boolean`，默认 false），cordis.yml 可配——部署自选，符合"硬编码不可调参数禁止"约定。
- 回退：开关关闭即恢复原状；restrict 返回 disposer，随 agent 作用域释放。
- 风险：所有 shell 流量绕过沙箱/审批 seam 与内置超时策略——仅适合可信本地部署，README 安全边界已有声明，需在此功能处重申。
- 待确认前置：Q1（解禁者）。若解禁发生在 restrict 之后注册的更晚层，需要改挂事件时序或改为 deny + 观察是否被覆盖。

### S2 结构接管·专用 preset（轻量备选）

仿 `.agent-presets/data-agent` 新建目录（不动 liangshen/data-agent 原文件）：

```
~/.dsh/.agent-presets/background-shell/
├── preset.yml          # name/description/order
├── agent.cordis.yml    # persona 尾部一句路由 + （可选）restrict 条目
└── restrict-shell.mjs  # name/inject/apply → ctx.tools.restrict({deny:[...]})
```

适用：只想对选中的会话启用单入口。局限：依赖 preset 名单校验（F4 未定位前，deny 名单可能踩未知名抛错）；且要逐 preset 选择。S1 若落地则 S2 仅剩 persona 句的价值。

### S3 描述级路由 ✅ 已完成

commit `e086d22`：描述以使用时机开头并以显式偏好句收尾（Prefer over pwsh/bash whenever ...）。native 形态会话（F5）的第一杠杆。PTC 面不生效（run_code 折叠了 schema）。

### S4 指令句（备而不用）

工作区 AGENTS.md 或全局 `~/.dsh/AGENTS.md` 一句路由规则。用户明确不倾向；仅当 S1 受阻时的兜底。

### S5 默认等待窗对齐参考实现（一行，待决）

Antigravity 参考为 `WaitMsBeforeAsync = 10000ms`；本插件默认 5000ms（`src/config.ts` BACKGROUND_TASKS_DEFAULTS）。改 10000 可减少中等命令被误降级的抖动；代价是同步阻塞上限翻倍。与 S1 无耦合。

## 5. 两阶段 preset 集成注意（若在梁神类模式下使用）

- Phase 1 的 `messageSources` 白名单需追加 `plugin`，否则后台完成唤醒被静默过滤，并存在晋升死锁风险（见 F7 引用的 #578 机制）。
- 或者接受限制：Phase 1 期间启动的后台任务只能靠 `manage_background_task` 主动查询。
- persona 尾部一句路由（data-agent 范式）是与两阶段架构兼容的最小文本增量——若连这也想避免，S1 是唯一纯工程路径。

## 6. 决定性实验清单（新会话执行，约两分钟）

1. 直接下令「调用 manage_background_task，action=list」→ 成功返回即插件在场（预期）；UNKNOWN_TOOL 则回头查 bundles。
2. 「逐字列出你当前可用的工具名称」→ 拿到该形态下真实工具集地面真相。
3. 若清单含 pwsh/bash → 记录其来源线索：当前选择的 preset、工作区路径（AGENTS.md 注入源）、宿主启动方式。
4. 定位解禁者（对应 Q1）：在安装根 grep 内置 preset 定义（关键词 shellTools / tool-pwsh），并对比 settings 中预设选择状态。

## 7. 开放问题

- ~~**Q1 解禁者身份**~~ ✅ 已定位：standard preset 的代理面行（见 S0）。
- **Q2 restrict 时序**：agent/created 时点全局注册表是否已含 pwsh 名；若解禁晚于 restrict，需评估覆盖行为。
- **Q3 是否顺带禁 tool-jobs 相关呈现**：job_* 工具与 manage_background_task 语义重叠（虽然 host 面 tool-jobs 已 disabled，但同 F4 需复核会话面）。

## 8. 参考锚点

- 机制：`packages/boot/app-boot/src/profile.ts`（bundle 强制声明 :388-394）、`packages/core/tools/src/index.ts`（restrict/scoped layers）、`packages/preset/agent-presets/`（roster standing scope）。
- 反例教训：postmortem 0001（default export 丢弃 inject）。
- 本仓关键提交：`f65f19f` 初版基线 → 修复系列 → `943f638` CLIXML → `e086d22` 描述路由。
- 用户侧既有资产：`.agent-presets/liangshen`（两阶段锚定范本）、`.agent-presets/data-agent`（persona+继承限制范本）。
