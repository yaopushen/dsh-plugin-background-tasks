# 验收报告 · v0.2.0（seam-aligned 重写）

> 环境：「后台任务模式」预设新会话；`workspace-write` + 审批 `ask`。
> 日期：2026-08-23。执行者：独立验收会话（非实现会话）。
> 结论：**8/8 PASS，无差异。**

---

# 验收汇总报告

**组合状态：** `workspace-write` + 审批 `ask`（已确认当前运行时上下文）

## ① 单入口确认（工具清单）
当前后台任务相关工具面（逐字）：
- ✅ 有：`run_command`、`job_list`、`job_output`、`job_kill`
- ❌ 无：`pwsh`、`bash`、`manage_background_task`

> 结论：单入口收敛到 `run_command` + 三个 job 管控工具，无散落的原生 shell 或旧式管理入口。符合预期。

## 汇总表：项目 | 结果 | 关键证据行

| 项目 | 结果 | 关键证据行 |
|---|---|---|
| ① 单入口确认 | **PASS** | 工具集仅含 `run_command / job_list / job_output / job_kill`；无 `pwsh`、`bash`、`manage_background_task` |
| ② 默认 cwd | **PASS** | `pwd` → `D:\DEEPSEEK`（exit 0） |
| ③ 越界读（对照） | **PASS** | `ls D:\桌面` → exit 0，正常列出目录内容 |
| ④ 越界写·硬约束 | **PASS** | exit 1；`[sandbox: file access denied under workspace-write mode]` 与 `[sandbox: escalation available — retry this exact command once with sandbox_permissions ...]` 两行均出现 |
| ⑤ 升级路径 | **PASS** | 带 `danger-full-access`+justification 触发审批并通过；创建 `dsh-probe.tmp`（0 字节，exit 0）；随后删除成功 |
| ⑥ 越界写回归 | **PASS** | 无升级参数重跑④ → exit 1，同类两行拒绝/升级提示重现（单次授权未泄漏） |
| ⑦ 后台晋升 | **PASS** | 无 `wait_ms` → 约 10s 返回 `[Background Task Started] JobId: command-1`，`job_list` 显示 `command-1 [command] running`；约 20s 自动收到完成通知 `finished [status: completed, exit code: 0]` |
| ⑧ job 管控 | **PASS** | `wait_ms=0` 直接后台 `command-2`；`job_output` 读一次正常；`job_kill` 返回 `requested cancellation of job command-2`；状态 `killed` 且未再收到完成通知 |

## 结论
**全部 8 项 PASS，无差异，未触发「停止」条件。**

重点验证项确认无误：
- **④升级提示存在**（v0.2.0 P0 批次核心新增）：拒绝响应稳定输出两行，第二行为升级指引——与原生 pwsh/bash 拒绝输出逐字对齐。
- **⑤审批路径生效**：`danger-full-access`+justification 触发人机审批，用户批准后命令成功执行，授权具单次性（⑥回归仍被拒）。
- **⑦/⑧后台生命周期**：晋升窗口、JobId 派发、自动完成通知、以及 `job_kill` 终止且无后续完成通知，均符合设计。

## 附注（实现侧对照实验，同日）

在 workspace-write 会话中以原生 `pwsh` 工具镜像执行反例 B 与越界写探针：
- 原生与插件行为完全一致（读成功、越界写硬拒 + 同款 marker），证明 seam 对齐成立；
- 沙箱词汇表只约束**写效果**，读不受限为设计行为；
- 「权限是软约束」的早期判断已被否证：写维度为内核级硬拒绝。
