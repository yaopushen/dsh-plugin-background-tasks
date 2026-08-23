\# `dsh-plugin-background-tasks` 校验与代码审查报告

> **状态：历史存档（针对 v0.1 自管架构的审查）。** 所列缺陷已随 v0.2.0 seam-aligned 重写全部关闭或失效：
> - P0-1（export default 混用）、P0-2/P0-4/P1-5（settle 路径竞态族）、P1-8（无界增长）——随自管 TaskManager 整体删除而消失；
> - P0-3（POSIX 树杀失效）——进程组终止移交 `ctx.subprocess` seam 的 `ShellProcess.kill()`；
> - P1-6（绕过 jobs/沙箱/审批 seam）——由 Tier B 重写正面解决，见 `docs/sandbox-integration.md` §6；
> - P1-7（硬编码可调参数）——收敛为单一 fail-loud `Config` 字段；
> - P2 各项——wakeup 已删除、分块解码归 executor、codeFence 保留，随之失效。
>
> 包规范偏差表中大部分已修复（exports/files 白名单/devDeps 镜像/README Model Experience 与 Known Limitations 章节）；遗留偏差（树外非 `@deepseek-ai` 包名、tsconfig 绝对路径依赖宿主构建产物）为已知接受项。**本文仅作存档，现状以 `README.md` 为准。**



\*\*审查基准\*\*:https://deepseek-harness.github.io/deepseek-harness/reference/(架构页、cordis-primer、adding-a-package 手册)+ 本地代码库 `deepseek-harness`(vendor cordis、core/tools、core/agent、llm/llm、boot/app-boot)逐 API 实源比对。



\## 一、总体结论



设计思路清晰(timeout promotion + reactive wakeup + tree kill),核心选型基本正确:`defineTool`、`createUserMessage`、`agent.followup()`、`ctx.agents.get()/roots()`、`ctx.effect(fn, label)` 全部真实存在且签名匹配，patch 挂载语法有效。\*\*但存在 4 个阻断级缺陷\*\*(其中 1 个是宿主可崩溃的竞态)、1 个架构归属偏差，以及一批包规范违背。当前状态不建议挂载到常驻宿主。



\## 二、API 契约核验(逐项实证)



| 插件用法 | 核验结果 |

|---|---|

| `defineTool({parameters:{type,required:true},output:{schema,render},execute})` | ✅ `packages/core/tools/src/schema.ts:545`,per-property `required: true` 方言见 `schema.ts:101-121` |

| `ctx.tools.register(...)` 返回 disposer | ✅ 符合根 AGENTS.md「registry 的 register() 返回 disposer」约定;`tools: ToolRuntime` Context 增强(`tools/src/index.ts:139`) |

| `inject = \['tools','agents']` | ✅ 两键均有 Context 增强(`agent/src/index.d.ts:28` → `AgentRegistry`,含 `get(id)` `:349` / `roots()` `:370`) |

| `(ctx as unknown as {agents}).agents` 强转(wakeup.ts:7) | ⚠️ \*\*不必要\*\*——类型增强已存在，tsconfig 已映射 dsh-agent 类型；强转反而绕过了编译期检查 |

| `createUserMessage({content, source:{kind:'plugin',plugin:'background-tasks'}})` | ✅ `llm/src/message.ts:192`;`MessageSourceMap.plugin = {kind:'plugin'; plugin:string} \& ContextFormed`(`message.ts:102`),`form` 可省略 |

| `agent.followup(message)` | ✅ `agent/src/runtime-types.ts:124`,经 inbox → 轮次领取时落 `user/message` 日志 → 「model-visible ⟺ logged」不变量成立 |

| `exec?.agent?.session?.header?.id` | ✅ `ToolRunContext.agent?: Agent`(`tools/src/index.ts:325`)、`Session.header`(`session/src:443`)均存在；可选链防御正确 |

| `ctx.effect(fn, 'label')` | ✅ `fiber.ts:415-418`;teardown 顺序正确(先摘 wakeup 钩子 → 注销工具 → dispose manager) |

| README 方式 A patch 语法 `- insert: \[{id, name: <path>}]` | ✅ 与 `app-boot/tests/user-patches.spec.ts:49-58` 同构，entry `name` 支持文件路径(spec:104 `./noop.mjs`) |



\## 三、缺陷清单



\### 🔴 P0 — 阻断级



\*\*P0-1|`export default` 混用触发 Loader 丢弃命名空间(postmortem 0001 反模式)\*\*

`src/index.ts:38-41` 同时具名导出 `name/inject/apply` \*\*和\*\* `export default {name, inject, apply}`。Loader 的 `unwrapExports`(`vendor/loader/src/index.ts:192`)优先取 `.default`。当前\*\*侥幸可用\*\*仅因 tsc 产物无 `\_\_esModule` 标记且默认对象逐字复制了全部字段；一旦将来只往具名导出加 `Config`(或两边不一致)，将被静默丢弃。packages/AGENTS.md 明文规定函数插件不得有默认导出。\*\*修复：删除 `export default`。\*\*



\*\*P0-2|dispose 后写已关闭日志流 → 未处理 error 事件 → 宿主崩溃\*\*

`manager.ts` `dispose()`(:275-287)先杀树、再 `end()` 全部流并清空 map;随后子进程 `close` 处理器必然抵达，在 ：178 执行 `logStream.write(...)` → 对已 end 的 WriteStream 写入会异步 emit `ERR\_STREAM\_WRITE\_AFTER\_END`,而流上\*\*没有挂任何 `'error'` 监听器\*\* → uncaughtException,\*\*整个 DSH 宿主进程崩溃\*\*。触发条件：插件热重载/卸载时有运行中任务(dispose 自己 kill 了树，close 事件必然随后到达)。\*\*修复：settle 路径统一加一次性守卫 + 流挂 `on('error')` 或检查 `destroyed`。\*\*



\*\*P0-3|POSIX 进程树查杀失效，README 宣称不实\*\*

spawn 固定 `detached: false`(:118),`killProcessTree` POSIX 分支的 `process.kill(-pid, SIGKILL)`(:256)瞄准的是不存在的进程组 → ESRCH → 回退单杀 pid,\*\*孙进程全部存活\*\*。只有 Windows 的 `taskkill /T /F` 有效。README 第 14 行「Windows/Linux 下均支持递归查杀孙进程」对 Linux/macOS 为虚假声明。修复需 `detached: true` 并处理信号语义，或如实收窄声明。



\*\*P0-4|`killed` 状态被 close 处理器覆盖 + 杀死后误发"Failed"唤醒\*\*

close 处理器无条件 `status = code === 0 ? 'completed' : 'failed'`(:176),冲掉 `killTask`(:75)设置的 `'killed'`,endTime/exitCode 一并覆盖；且因 `isBackground` 为真，完成钩子照样触发 → \*\*用户主动 kill 后，Agent 反而收到一条"\[System Notification] Failed"唤醒消息\*\*。测试 3 之所以通过，恰因它在 close 事件落地\*\*之前\*\*断言状态——测试掩盖了 bug 而非捕获它。修复:`if (taskRecord.status !== 'killed')` 守卫，且 killed 任务跳过唤醒钩子。



\### 🟠 P1 — 高



\*\*P1-5|后台任务的 `error` 路径永不唤醒 Agent\*\*

`child.on('error')`(:194-200)只 resolve promise:不设 exitCode/signal、不写 settle 标记、\*\*即使已转后台也不触发完成钩子\*\*。典型场景:powershell/bash ENOENT(spawn 的 ENOENT 是异步走 error 事件的，:115 的 try/catch 根本捕获不到)→ 任务静默死亡，Agent 永远等不到通知。应把 close/error 收敛到同一个一次性 settle 函数。



\*\*P1-6|架构归属:绕过 `ctx.jobs`、沙箱与审批 seam\*\*

参考架构扩展点表明确：「添加后台工作 → 在 `ctx.jobs` 上注册;`job\_\*` 工具负责收集或停止」。仓库内 `shell/tool-bash`、`tool-pwsh` 正是把进程句柄注册进 `ctx.get('jobs')`。本插件手搓了平行的任务注册表和管理工具，重复实现了 job\_list/job\_output/job\_kill 语义；同时用裸 `node:child\_process` 直接 spawn,\*\*完全绕开 `ctx.sandbox` 后端与审批管线\*\*执行任意命令——这与宿主的沙箱/审批安全模型相抵触。至少应在 README 显式声明安全边界；正确做法是基于 `ctx.jobs` + subprocess seam 实现。



\*\*P1-7|零 Config,硬编码可调参数\*\*

`wait\_ms` 默认 5000 散布三处(tools.ts:30/:50、manager.ts:92),tail 行数 30/50(manager.ts:182、tools.ts:132),任务目录硬编码 `\~/.dsh/tasks`(manager.ts:17)。违反根 AGENTS.md「No hardcoded tunables in plugins」。应导出 schemastery `Config` 并加入 apply 第二参。



\*\*P1-8|无界增长\*\*

`tasks` Map 含已完成记录和 `child` 句柄永不回收；日志文件在 `\~/.dsh/tasks` 永久堆积；README 目录注释宣称「log rotation」\*\*并无实现\*\*。同步等待窗口内的 `syncOutputBuffer` 也无上限。



\### 🟡 P2 — 中



| # | 问题 | 位置 |

|---|---|---|

| 9 | wakeup 找不到 agent 时兜底 `roots\[0]`,会把任务结果投递给无关会话的 agent;实际上 `agentId === sessionId`(Agent.id 与 session 共享身份，`runtime-types.ts:65-66`),`get(agentId)` 失败即意味着原 agent 已销毁，此时应直接放弃投递 | `wakeup.ts:15-17` |

| 10 | `chunk.toString('utf8')` 多字节字符跨 chunk 截断产生乱码，污染日志与同步输出 | `manager.ts:156,164` |

| 11 | stdout/stderr 无标记混流；进程输出含 ``` 会击穿 Markdown 围栏(也是提示注入面) | `tools.ts:58,136`、`wakeup.ts:36-38` |

| 12 | 测试用 `new TaskManager()` 直写真实 `\~/.dsh/tasks`(污染用户目录)；Test2/3 纯 sleep 驱动；\*\*Test3 断言恰好落在 P0-4 竞态窗口内\*\*；未覆盖 spawn 失败/wakeup/tools 路径 | `tests/test-manager.mjs:5,45,60-68` |

| 13 | timeoutPromise 的 setTimeout 从不清理(每次调用泄漏一个 ≤waitMs 的 timer) | `manager.ts:215-217` |

| 14 | 空 catch 注释不合规:「// Safe disposal」未说明吞掉了什么(root AGENTS.md 要求；manager.ts 两处合格) | `tools.ts:152-156` |



\### ⚪ P3 — 低



\- Windows 下 Node 对 spawn 数组参数的内嵌双引号拼合有限，复杂 PowerShell 命令可能被 `-Command` 错误解析(Test2 是靠解析容差通过的)；可考虑 `-EncodedCommand`。

\- 任务 ID 取 UUID 前 8 hex(:98),长生命周期主机存在小概率碰撞互相覆盖(同键 Map + 同名日志文件)。

\- `execSync('taskkill ...')` 短暂阻塞事件循环(:250),可接受但宜注释。



\## 四、包规范偏差(对照 adding-a-package 清单)



| 项目 | 规范要求 | 实际 |

|---|---|---|

| 包名 | `@deepseek-ai/dsh-<name>` | `dsh-plugin-background-tasks`(树外可豁免，宜注明) |

| `private: true` | 必须 | ❌ 缺失 |

| `exports\["."]` types/default 映射 | 必须 | ❌ 完全没有 exports 字段 |

| `types` 路径 | `lib/types/index.d.ts` | ❌ `lib/index.d.ts`(平铺布局) |

| peerDeps 镜像 devDeps | 必须(相同范围) | ❌ 只有 peerDependencies |

| `files` | 精确白名单，\*\*禁发 src、\*.map\*\* | ❌ 含 `src` 及全部 `.d.ts.map/.js.map` |

| schemastery | 用 Config 则入 dependencies | ➖ 未用 Config(连带 P1-7) |

| README 结尾 | Model Experience + Known Limitations 规范章节 | ❌ 无——本插件直接注入系统通知消息和两个工具 schema,属“直接 token effect”,按规范必须填写 |

| tsconfig | extends base、相对引用 | ⚠️ 绝对路径指向宿主构建产物 `lib/types/\*.d.ts`(依赖宿主先 build)、`ignoreDeprecations:"6.0"`——树外现实约束，列已知偏差 |



另注：README「零 Token 轮询损耗」表述不准——唤醒本身是一次完整轮次，通知文本(tail 日志)会占用上下文窗口；准确说法是「消除轮询请求」，且这正是 Model Experience 章节应量化的内容。



\## 五、正面确认



teardown 顺序正确；工具输出契约(string schema + render)自洽;`run\_background\_command`/`manage\_background\_task` 命名不与内置工具冲突；同步/后台双模式返回结构清晰;patch 双安装方式的语法均有效；wakeup 消息经由 inbox 落持久日志，满足「model-visible ⟺ logged」核心不变量。



\## 六、修复优先级建议



1\. \*\*删 `export default`\*\*(一行,P0-1);

2\. \*\*重构 settle 路径\*\*:一次性守卫统一 close/error/killed 三分支，顺带修 P0-2/P0-4/P1-5;

3\. `detached: true` 或修正 POSIX 树杀声明(P0-3);

4\. 导出 `Config`(wait\_ms/taskDir/tailLines)(P1-7);

5\. 加任务/日志保留上限(P1-8);去掉 `roots\[0]` 兜底(P2-9);

6\. 补齐 package.json 规范字段与 README 章节；中期考虑迁移到 `ctx.jobs` 作为底层托管(保留 promotion/wakeup 作为增值层)。


