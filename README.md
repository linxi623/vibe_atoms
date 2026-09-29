# Vibe Atoms Demo

Next.js/React 工作台：访客会话、项目、真实模型规划与生成、隔离交互预览、对话迭代、版本差异及恢复。平台项目、消息、任务和版本存于 PostgreSQL。验收范围见 [PRD](docs/PRD.md)，未完成的公网交付见 [执行清单](docs/EXECUTION_PLAN.md)。

## 本地运行

需要 Node.js 20.9+、npm、PostgreSQL 17 和 OpenAI-compatible 模型 API。`docker-compose.yml` 的数据库使用本地 Docker 卷，仅供开发；也可使用本机 PostgreSQL。把以下变量放在未跟踪的 `.env.local`（Next.js）或只在当前 shell 设置，**不要提交真实密钥**：

| 变量 | 用途 |
| --- | --- |
| `DATABASE_URL` | 持久 PostgreSQL 连接串 |
| `MODEL_API_KEY` | 服务端模型密钥，绝不使用 `NEXT_PUBLIC_` 前缀 |
| `MODEL_BASE_URL` | OpenAI-compatible API 基址，代码追加 `/chat/completions` |
| `MODEL_NAME` | 模型名称 |
| `APP_ORIGIN` | 生产 HTTPS 源，如 `https://demo.example.com`；本地可省略 |

PowerShell 示例（值为本地开发占位符）：

```powershell
docker compose up -d db
npm ci
$env:DATABASE_URL="postgres://vibe:vibe@127.0.0.1:5432/vibe_atoms"
# 在当前 shell 安全设置 MODEL_API_KEY、MODEL_BASE_URL、MODEL_NAME
npm run db:migrate
npm run dev
```

打开 `http://localhost:3000`。`npm run db:migrate` 从进程环境读取连接串；若变量只在 `.env.local`，需先导入 shell，不要在命令历史中输入生产密钥。Next.js 会读取 `.env.local`。本地构建与回归：

```powershell
npm run typecheck
npm run build
node --test --test-concurrency=1 tests/f1.test.mjs tests/generation.test.mjs tests/workbench.test.mjs tests/preview.test.mjs tests/frame-policy.test.mjs tests/versions.test.mjs tests/public-demo.test.mjs
```

测试会创建并删除独立 PostgreSQL 测试库，使用模拟模型，不消耗真实额度；运行前须在当前 shell 设置可创建数据库的本地 `DATABASE_URL`（也可用未跟踪的 `.env` 配合 Node 的 `--env-file=.env` 参数）。`tests/real-generation.test.mjs` 仅在 `REAL_MODEL_TEST=1` 时调用真实模型，会消耗额度。

## 部署

生产模型服务必须使用 HTTPS；仅本地回环地址允许 HTTP 测试。COS/OSS 对象存储不是本 Demo 的依赖，不能代替 PostgreSQL；Cloudflare 可作为域名 DNS/代理入口，但不能代替应用主机或数据库。

`Dockerfile` 与 `compose.deploy.yml` 提供单实例 Node.js 运行方式；它们**不创建生产数据库或 HTTPS 代理**。先准备持久的托管 PostgreSQL（连接要求 TLS 时在 `DATABASE_URL` 指定供应商要求的 SSL 参数）、能容纳最长 3 分钟同步请求的宿主、HTTPS 反向代理和可支付的模型额度。设好 `DATABASE_URL`、`APP_ORIGIN`、`MODEL_API_KEY`、`MODEL_BASE_URL`、`MODEL_NAME`、稳定随机的 `IP_HASH_SECRET` 等服务端变量，再在受信任的部署环境执行：

```powershell
docker compose -f compose.deploy.yml up -d --build
```

容器启动前运行 SQL 迁移；健康检查 `GET /api/health` 检查数据库连接及模型配置是否存在，不消费模型额度，**不证明模型账户可用**。容器只绑定宿主 `127.0.0.1:3000`；HTTPS 代理应连接此端口，覆盖而不是透传客户端自带的 `X-Forwarded-For`，并确保只有代理可访问应用。`TRUST_PROXY_IP=true` 时应用只读取转发头首个有效 IP，并以 `IP_HASH_SECRET` HMAC 摘要入库；若无法保证受信任代理，请设 `TRUST_PROXY_IP=false`，所有未知客户端共用一个 IP 配额。`APP_ORIGIN` 必须是实际公开 HTTPS 源，写请求依赖精确 `Origin` 检查。请在反向代理与宿主分别验证请求时限，并在上线前实测首次生成、迭代、重启和重新部署后的持久化。

## 配额与安全

所有 JSON 写入请求体上限 16 KB；超限返回 `413`。健康检查还要求最新数据库迁移已应用，返回 `503` 表示暂不可接流量。

配置值为单数据库全局有效，所有正整数须大于零，错误配置导致相关请求 `503`。默认值：每 IP 每小时创建会话 20 次；每会话/每 IP 每分钟写入 120/180 次；生成每会话每小时/每日 20/50 次、每 IP 每小时/每日 40/100 次、每项目每小时 25 次；全局运行任务 2 个，数据库累计生成任务预算 200 个。对应环境变量依次为 `LIMIT_SESSION_PER_HOUR`、`LIMIT_WRITE_PER_MINUTE`、`LIMIT_IP_WRITE_PER_MINUTE`、`LIMIT_GENERATION_PER_SESSION_HOUR`、`LIMIT_GENERATION_PER_SESSION_DAY`、`LIMIT_GENERATION_PER_IP_HOUR`、`LIMIT_GENERATION_PER_IP_DAY`、`LIMIT_GENERATION_PER_PROJECT_HOUR`、`LIMIT_GLOBAL_CONCURRENCY`、`LIMIT_TOTAL_TASKS`。预算计数跨重启/部署持续，失败任务也占一次；在额度用尽后应暂停入口并人工核对费用，不能自动重置计数。幂等重放不增加生成预算。

`MODEL_TASK_TOKEN_BUDGET` 默认 25,000，限制单任务各模型调用请求的 `max_tokens` 上限之和（规划 1,000，生成 12,000，最多一次修复 1,000 或 12,000）。这是输出上限，不是精确计费或输入 token 限额；模型供应商的账户硬额度仍必须单独设置。`MODEL_REQUEST_TIMEOUT_MS` 默认为 90,000（最大 90,000），`TASK_TIMEOUT_MS` 默认为 180,000。提示词不超过 8,000 字符、生成 HTML 不超过 500 KB、模型响应体不超过 2 MB。模型配置错误、网络/超时、格式和存储故障返回固定错误类别，不回显密钥、供应商响应或内部堆栈。

平台私有读取由服务端校验访客归属，写入校验同源 `Origin`；跨访客 ID 返回 404。访客 Cookie 为 HttpOnly、SameSite=Lax，生产为 Secure，数据库只存凭证摘要。预览 iframe 仅允许脚本，不授予同源、导航、弹窗和网络权限；平台响应设置 CSP 与其他安全头。静态源码检查是辅助防线，不等于应用代码安全审计。

## 功能与限制

创建项目后输入任意前端需求，等待规划、生成和检查；预览、源码、复制/下载、版本比较和确认恢复都使用数据库中的版本。首次生成与迭代使用 `POST /api/projects/:id/generate` 和 `Idempotency-Key`，重复同键重放原任务，不重复生成。失败保留旧版并可关联重试。平台只生成自包含单文件 HTML/CSS/JS，**不提供生成应用的真实后端、任意依赖、附件解析或业务数据持久化**。不要在生成页面输入敏感数据。

清除 Cookie 后无法找回访客项目；没有跨设备账户登录。同步生成请求若客户端或进程中断，不保证后台继续运行；陈旧任务在随后读取或新建任务时按时限标记失败。公开 HTTPS 地址、托管数据库、生产模型额度和外网端到端验收尚未提供，不能将本地验证当作线上交付。AI 辅助编写了实现，人工验证证据及剩余验收列于 [执行清单](docs/EXECUTION_PLAN.md)。
