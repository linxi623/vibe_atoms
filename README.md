# Vibe Atoms Demo

笔试 Demo 的初始化骨架。当前已实现访客会话、项目创建/列表/重命名和工作台空态；**模型生成、交互预览、版本恢复及在线部署尚未实现**。完整技术方案见 [docs/TECHNICAL_DESIGN.md](docs/TECHNICAL_DESIGN.md)，验收范围见 [docs/PRD.md](docs/PRD.md)。

## 本地运行

需要 Node.js 20.9+、npm、PostgreSQL 以及可选的 Docker。复制 `.env.example` 为 `.env.local`，填入 `DATABASE_URL`，不要提交密钥。

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

所有私有读取由服务端校验访客归属。写接口要求同源 `Origin`；跨访客 ID 返回 404。清除 Cookie 后无法找回该访客项目，跨设备账户登录不在本次范围。公开部署前还必须接入限流、预算、模型密钥、隔离预览并完成安全与线上验收。

## 后续

按技术方案 B → C → D 阶段实施。模型供应商 API、服务端密钥、托管数据库、部署账户和请求时限需另行确认；不能把静态空态视作真实生成成果。
