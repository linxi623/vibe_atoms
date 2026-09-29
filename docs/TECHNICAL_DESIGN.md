# 笔试 Demo 技术方案

状态：实施方案，2026-09-29。范围以 [PRD](PRD.md) 为准，不包含长期路线图的发布、支付、附件和任意依赖构建。

## 1. 目标和交付边界

评审者无需自己的模型密钥，从空访客会话完成创建项目、真实生成单文件前端、交互预览、对话迭代、源码对比、历史恢复，刷新后仍能找回项目。平台数据持久化不等于生成应用内业务数据持久化。在线 HTTPS 地址与模型额度需要外部资源，未部署前不声称通过线上验收。

当前已交付访客与项目 API，以及生成后端的任务、消息、版本和真实模型调用；对话工作台、预览与恢复仍未实现，不能用静态空态伪装完整闭环。

## 2. 架构和选型

```text
浏览器 Next.js 工作台
  ├─ Cookie 会话 / 项目 / 对话
  ├─ 版本列表 / 差异 / 源码下载
  └─ sandbox="allow-scripts" iframe(srcdoc, 无 allow-same-origin)
             │ 同源 API
Next.js Node Route Handlers（单实例有界请求）
  ├─ 访客归属、Origin 校验、输入和配额限制
  ├─ 任务状态机：计划 → 生成 → 结构检查 → 原子提交
  ├─ 服务端模型适配器（密钥不进入浏览器）
  └─ PostgreSQL（托管持久实例，迁移随代码）
```

- Next.js + React + TypeScript：一个部署入口承载 UI 和 API，避免前后端跨域 Cookie 与额外服务。运行时必须是 Node.js，不使用静态导出或 Edge。
- PostgreSQL + `pg` 参数化查询和显式 SQL 迁移：部署于持久数据库，便于事务、唯一约束和任务锁；本地 Docker 数据卷仅供开发。生产连接串由托管方提供，不以容器或临时磁盘当生产数据库。
- 模型适配器使用服务端 OpenAI-compatible HTTP；本地已用真实模型完成非样例首次生成与迭代。DeepSeek 官方端点关闭思考模式，以免规划响应的输出预算被推理内容耗尽。密钥不在前端透传；供应商不兼容时只替换适配层。
- 预览只运行无外部资源的单 HTML 文件。静态检查拒绝外部 URL/资源、内联事件等不受控输入；浏览器 sandbox 与 CSP 是主隔离手段，字符串检查不能代替安全边界。
- 不采用队列、任意代码服务器执行、第三方依赖安装或生成应用后端。

## 3. 数据模型及一致性

`visitors(id, token_hash, created_at)`、`projects(id, visitor_id, name, current_version_id, timestamps)`、`messages(id, project_id, role, content, task_id, created_at)`、`tasks(id, project_id, base_version_id, status, stage, error_code, idempotency_key, retry_of_id, timestamps)`、`versions(id, project_id, sequence, html, summary, task_id, restored_from_id, created_at)`。具体约束在 `db/migrations/0001_initial.sql`。

- Cookie 存 32 字节随机凭证（HttpOnly、SameSite=Lax；HTTPS 下 Secure）；数据库仅存 SHA-256 摘要。所有查询从服务端会话联接所有权，不接受客户端传 visitorId。
- 创建任务时锁定项目行，记录当前基线和幂等键；同项目只允许一个运行任务。并发重复请求由 `(project_id, idempotency_key)` 唯一约束返回同一任务。恢复也应在相同项目锁下进行。
- 生成成功在一笔事务中插入不可变版本、更新 `current_version_id`、标记任务成功。失败保留旧版本。恢复复制目标 HTML 成新版本，设置 `restored_from_id`，不调用模型或删除历史。
- 任务按服务端阶段及规划记录。首版采用有界同步请求加 `GET /api/tasks/:id` 轮询，避免“断网仍后台运行”的假承诺。单次模型调用最长 90 秒、任务最长 3 分钟；运行超时（含进程中断后的陈旧任务）由下次读取/任务启动时回收为 failed。部署宿主请求上限必须先验证。

## 4. API 和错误约定

| 接口 | 方法与行为 |
| --- | --- |
| `/api/session` | POST 创建/续用访客 Cookie |
| `/api/projects` | GET 当前访客列表，POST 创建 |
| `/api/projects/:id` | GET 详情，PATCH 重命名 |
| `/api/projects/:id/generate` | POST 提示词和幂等键，固定基线并执行任务 |
| `/api/tasks/:id` | GET 所属任务真实状态、阶段和错误 |
| `/api/projects/:id/versions` | GET 版本列表 |
| `/api/projects/:id/versions/:versionId` | GET 源码和摘要，受归属约束 |
| `/api/projects/:id/restore` | POST 目标版本和幂等键，事务创建恢复版 |

写请求校验同源 `Origin`，会话失效返回 401，跨访客资源统一返回 404。输入错误 400、并发写 409、限额 429；模型/格式/存储错误用稳定错误码和可重试标记，不返回内部堆栈。所有私有响应禁缓存。

## 5. 生成和预览边界

1. 校验提示词长度、会话/IP 速率、全局并发和单任务预算，创建任务与用户消息。
2. 规划：整理目标、交互和保留约束；迭代携带固定基线源码，限制上下文大小。
3. 生成：要求结构化计划和完整 HTML/CSS/JS；模型格式异常最多修复一次，超时立即失败。
4. 检查：HTML 基本结构、大小、禁止网络资源和危险能力；不将静态检查称为功能测试。保存成功后才响应成功。
5. 预览：`iframe` 不加 `allow-same-origin`，用 CSP 禁止网络请求、表单外发、导航、弹窗及插件；平台侧文本只按文本渲染。验证平台 Cookie/DOM/storage 不可达。预览的数据不承诺跨刷新持久。

具体 CSP 必须结合浏览器实测，尤其 `srcdoc` 的 `base-uri`、表单和导航行为。生产还要做请求预算和滥用监控，不能只依赖浏览器隔离。

## 6. 实施顺序与验收门槛

| 阶段 | 交付 | 门槛 |
| --- | --- | --- |
| A 初始化（本次） | 工作台、访客/项目 API、SQL 迁移、环境样例 | 本地构建通过；连接 PostgreSQL 后项目可刷新找回、跨访客隔离 |
| B 生成 | 模型适配、任务、消息、原子版本提交、状态轮询 | 非预置需求真实生成；失败保留旧版；重复提交幂等 |
| C 预览与版本 | 隔离 iframe、源码/下载、差异、恢复 | 可操作页面、隔离验证、恢复源码一致 |
| D 上线 | 限流/预算、故障测试、移动端、HTTPS 部署 | PRD 12 项必测和外网实测；README 标注限制 |

待确认：模型 API/服务端密钥、托管 PostgreSQL、部署账户、请求时限和预算。没有这些资源时可完成本地骨架与模拟失败测试，但不能声称完成真实生成或在线交付。

## 7. 风险与取舍

- 同步生成受平台请求时限影响。部署前用真实任务验证；若超时不能满足，改为受控后台 worker + 租约，不能用前端长等待掩盖。
- 单文件生成无法覆盖后端、任意依赖或真实支付。输出应明确说明模拟能力。
- 访客 Cookie 丢失即无法找回项目；跨设备登录不在范围。
- 公开 Demo 要有 IP/会话配额、全局并发与花费上限；限制不能仅在 UI 实现。
- 代码检查只保障有限格式与策略，不证明生成应用符合所有需求；待办、记账、展示站需人工关键路径测试。
