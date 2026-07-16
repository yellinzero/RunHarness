# RunHarness architecture

[English](ARCHITECTURE.en.md)

这份说明只描述当前代码怎样协作，帮助读者快速找到主流程。

## 一条任务怎样运行

```text
User input
   │
   ▼
TUI ──HTTP/SSE── Project Runtime
                     │
                     ├─ create Session / Run
                     ├─ Planner produces a plan
                     ├─ Generator works in the selected workspace
                     ├─ configured checks collect evidence
                     ├─ Evaluator reviews evidence and changes
                     └─ complete / iterate / fail / stop
```

`POST /api/sessions` 只创建记录并立即返回。Runtime 在后台执行任务，将 Agent 消息、工具调用、检查、审批和终态写入统一事件流。TUI 和 Dashboard 不维护各自的任务状态，而是读取同一 API、SSE 和 Session store。

## 模块边界

```text
packages/cli
  commands/   命令解析、数据维护、非交互输出
  runtime/    Dashboard 资源定位和本地端口生命周期
  terminal/   键盘协议、屏幕、图片与剪贴板
  ui/         Ink TUI 与结果摘要

apps/server
  Project Runtime、HTTP API、SSE、附件与 Runtime 发现

apps/dashboard
  React 控制面，观察和配置同一个 Project Runtime

packages/development
  loop/          Planner → Generator → Evaluator 自循环
  runtime/       可执行检查的 Runtime 接口和失败分类
  verification/  将项目检查转成 Evidence
  workspace/     in-place / isolated、基线与交付

packages/core
  session/   Session、Run 和 JSONL 事件存储
  prompts/   可版本化 Prompt slots
  memory/    长任务恢复上下文与 Run 摘要

packages/providers
  backends/  CLI、API 与具体 transport
  routing/   Agent 配置、职责分配和 fallback
  runtime/   backend 契约、Provider 会话和子进程
  tools/     MCP、控制工具和权限判断

packages/shared
  跨模块使用的 Session、Agent、Evidence、Workspace 和 API 契约
```

## Session、Run 与迭代

- Session 表示可以持续对话和恢复的一项工作。
- 每次新的用户提交产生一个 Run。
- 一个 Run 可以包含多次实现与评审迭代。
- Continue 在原 Session 中创建新 Run；Steer 停止当前 Run，并把新要求和已有证据交给下一次规划。
- Run 必须进入终态。等待计划或权限确认是显式状态，恢复后可以继续同一个 Run。

## Agent 与控制信号

Planner、Generator 和 Evaluator 都通过 `AgentBackend` 调用。Agent 正文原样保留，不要求 JSON。需要影响生命周期的结论通过只读控制工具表达，例如接受评审、要求修改或无法判断。

API backend 自带模型与 MCP 工具之间的有限轮次 loop；CLI backend 保留对应 Agent transport 的原生能力。Provider 原生工具不一定都能回调到 RunHarness，因此事件会区分动作由 RunHarness、Provider 还是外部环境执行。

## 工作区与交付

- `in_place`：Agent 直接在当前项目工作区修改文件。
- `isolated`：Git 项目使用 worktree，非 Git 项目使用受管理副本。结果必须由用户 inspect 后 apply 或 discard。

Runtime 为每个 Run 保存基线和变更集。Apply 前会检查源工作区是否发生冲突；清理只处理 RunHarness 明确拥有的目录。

## Evidence 与权限

项目命令、MCP 工具和未来的容器、VM、设备检查都实现 `ExecutionRuntime`，并返回统一 Evidence：所有者、执行位置、状态、失败类别和产物。

权限分为三层：确定性项目策略、可选 Safety 判断和人工确认。只有 RunHarness 直接调度的动作能够被这一层硬控制；Provider 内部动作仍受其自身 sandbox 与协议能力约束。

## 本地数据

每个项目的数据按项目根哈希隔离，包含配置、Session、Run、事件、附件、Prompt、Memory 和 isolated workspace。Runtime 发现目录只保存在线地址等最小元数据，不复制项目内容。
