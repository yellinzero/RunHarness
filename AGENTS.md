# RunHarness development guide

本文件是所有 coding agent 的项目级开发规范。

## 项目目标

RunHarness 是一套可运行、可观察、可扩展的 Agent Harness 学习项目。它从 README 中的四篇文章出发，但不把后续设计限制在这些文章内。新增能力应解决真实的 Harness 问题，并让使用者能够从代码、事件和界面中理解其作用。

项目仍处于早期阶段，没有需要保留的内部旧契约。一个概念只保留一个名称、一个入口和一条执行路径；过时设计应直接迁移或删除，不增加兼容别名和双轨逻辑。

## 设计原则

- Harness 用上下文、工具接入、迭代、恢复、安全兜底和证据观察增强 Agent，不为统一格式削弱 Agent 原有能力。
- TUI 是主要工作面；Web 是观察和配置同一个 Runtime 的控制面。
- 用户路径短而一致，状态、失败原因和下一步操作必须直观。
- 代码首先服务阅读。按功能边界组织目录，公共扩展接口使用简短 TSDoc；注释解释生命周期、恢复、安全和非显然取舍，不复述语句本身。
- 只保留有明确用户价值的抽象。扩展性集中在少数稳定接口，不为页面组件或单次需求建立插件系统。
- 只对 Runtime 真正控制的动作承诺硬权限；Provider 原生工具和操作系统边界必须如实展示。
- 不在源码、测试、注释或文档中保留个人绝对路径、私有仓库名称、凭证、机器信息或未公开材料来源。
- 修改完成后搜索并删除旧路径、旧术语、死代码、无用目录、过时文案和重复测试。

## 当前架构

```text
CLI TUI ────────────┐
                    ├─ Project Runtime ─ Session store / Agents / Checks / Review
Web Dashboard ──────┘
```

- `packages/cli`：命令入口、终端协议、TUI 和打印模式。
- `apps/server`：项目 Runtime、异步 Session API、SSE 和 Dashboard 静态服务。
- `apps/dashboard`：观察、学习、审批和配置。
- `packages/development`：开发循环、执行 Runtime、验证和工作区交付。
- `packages/core`：Session 事件存储、Prompt 注册表和恢复 Memory。
- `packages/providers`：Agent backend、路由、进程、MCP 和权限映射。
- `packages/shared`：跨模块稳定契约。

Safety 是执行策略中的可选角色和控制路径，属于 `shared`、`providers` 与 `development` 的协作边界，不是独立 package。

## 稳定扩展点

- `AgentBackend`：接入新的 CLI 或 API Agent transport。
- `ExecutionRuntime`：接入容器、VM、设备或远端检查环境。
- Evaluator：组合独立质量判断。
- MCP/Tool：增加受工作区与权限约束的动作。
- Session store：替换持久化实现。
- Prompt slots：扩展用户可配置的目标、标准和偏好。
- TUI/Web client：消费同一 API 与事件协议。

核心模块不得反向依赖具体扩展。

## 不可破坏的契约

1. `POST /api/sessions` 立即返回 Session ID，任务在后台运行。
2. 每个 Run 必须结束为 `completed`、`failed` 或 `stopped`；异常不得永久停留在 `running`。
3. TUI 与 Web 共享项目根、配置、Session store 和事件协议。
4. in-place 直接修改项目；isolated 必须提供 inspect/apply/discard。
5. 状态与事件变化同步更新 Session 的恢复数据。
6. Git 项目使用仓库根，非 Git 项目使用启动目录。
7. 普通开发只使用 Session 与 Run 概念。

## 开发规则

- 修改前阅读相关模块和测试，不凭文件名猜行为。
- 保持 TypeScript strict，避免 `any` 和无约束 JSON。
- 结构化协议使用类型和解析器，不使用脆弱字符串约定。
- 用户可见中英文文案同步更新。
- 新依赖必须解决核心问题；现有依赖或标准库足够时不新增。
- 不覆盖用户无关工作树变化。
- 文件移动后同步更新 imports、barrel exports、测试、构建入口和打包检查。

## 验证

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm package:check
```

- Runtime 或共享契约变更：运行完整门禁。
- TUI 变更：使用真实 PTY 验证渲染、输入、停止和退出。
- Dashboard 变更：验证桌面和窄屏，无横向溢出、重叠或空白页。
- 异步任务变更：验证立即返回、终态、失败事件、恢复数据和结果交付。

## RunHarness 自我迭代

修改 RunHarness 自身时，活动 Runtime 不能在当前 Run 内覆盖并重启自己。

1. 完成实现和验证后执行 `pnpm dogfood:prepare`。
2. 当前 Run 到达终态后退出旧 TUI/Runtime。
3. 在普通终端执行 `pnpm dogfood:activate`。
4. 从新版本重新进入原 Session，用 `/continue` 验证已安装产物。

## 完成定义

功能可用、生命周期闭合、生产入口可运行、测试通过、README 与架构说明符合实现；没有死代码、孤儿目录、重复概念、隐私路径或旧兼容层。
