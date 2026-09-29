# Vibe Atoms Demo

笔试 Demo 的后端与工作台骨架。已实现访客会话、项目管理、真实模型生成 API、持久任务/消息/版本；**对话工作台、隔离预览、版本恢复及在线部署尚未实现**。完整技术方案见 [docs/TECHNICAL_DESIGN.md](docs/TECHNICAL_DESIGN.md)，验收范围见 [docs/PRD.md](docs/PRD.md)。

## 本地运行

需要 Node.js 20.9+、npm、PostgreSQL 以及可选的 Docker。在未跟踪的 `.env` 或 `.env.local` 中配置 `DATABASE_URL`、`MODEL_API_KEY`、`MODEL_BASE_URL`、`MODEL_NAME`，不要把真实密钥写进 `.env.example` 或提交到 Git。模型接口采用 OpenAI-compatible `/chat/completions`；DeepSeek 官方端点会发送非思考模式参数。Next.js 运行时读取环境文件，迁移脚本和测试须显式传入环境变量（如 `node --env-file=.env scripts/migrate.mjs`）。

```powershell
docker compose up -d db
npm install
$env:DATABASE_URL="postgres://vibe:vibe@localhost:5432/vibe_atoms"
npm run db:migrate
npm run dev
```

打开 http://localhost:3000。迁移命令从进程环境读取连接串（不会自行加载 `.env.local`）；Next.js 开发服务器会读取 `.env.local`。如端口占用，用 `npm run dev -- -p 3001`。数据库须有持久存储；生产不能使用临时 SQLite、浏览器本地存储或无持久磁盘的数据库容器。

## 当前接口

- `POST /api/session`：同源请求创建或续用 HttpOnly 访客 Cookie。
- `GET /api/projects`、`POST /api/projects`：当前访客项目。
- `GET /api/projects/:id`、`PATCH /api/projects/:id`：详情及重命名。
- `POST /api/projects/:id/generate`：同源 JSON `{ "prompt": "需求", "retryOfId": "可选失败任务 UUID" }`，要求 `Idempotency-Key` 请求头。首次生成与迭代共用接口；重复键且同一请求返回原任务，异参重复键或同项目运行中返回 409。请求同步等待完成，失败响应包含 `taskId`、`errorCode`、`retryable`。
- `GET /api/tasks/:id`：持久任务阶段、规划、耗时所需时间戳、失败类别与版本 ID；过期运行任务在查询时归档为 `TIMEOUT`。
- `GET /api/projects/:id/messages`、`GET /api/projects/:id/versions`、`GET /api/projects/:id/versions/:versionId`：读取当前访客的持久消息、版本元数据和源码。

生成流程先规划，再生成完整 HTML 并做有限的结构/策略检查；格式修复最多一次，单次模型请求上限 90 秒，任务上限 3 分钟。成功版本、当前指针、助手消息和成功状态在一个 PostgreSQL 事务内提交；失败保留旧版。静态检查不是沙箱或功能测试，生成源码不能在平台页面直接执行。模型请求中断后不会保证继续运行；过期状态在后续查询或写入时回收。

所有私有读取由服务端校验访客归属。写接口要求同源 `Origin`；跨访客 ID 返回 404。清除 Cookie 后无法找回该访客项目，跨设备账户登录不在本次范围。公开部署前还必须加入会话/IP 限流、全局并发及预算保护，完成隔离预览和线上安全验收。

隔离数据库的自动化验收（会创建并删除测试库）：

```powershell
node --env-file=.env --test tests/f1.test.mjs tests/generation.test.mjs
$env:REAL_MODEL_TEST="1"
node --env-file=.env --test tests/real-generation.test.mjs
```

真实模型用例会消耗额度；它从服务端配置发起两轮非样例生成，只输出断言结果，不输出密钥或源码。

## 后续

按 [执行清单](docs/EXECUTION_PLAN.md) 继续对话工作台、预览、恢复和线上交付。当前本地模型与 PostgreSQL 可测，但托管数据库、部署账户、公开请求时限和预算仍需确认；不能把工作台空态视作完整生成体验。
