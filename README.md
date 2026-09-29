# Vibe Atoms

一个通过自然语言创建和迭代前端应用的工作台。

## 架构

Next.js + React 提供工作台和服务端 API，PostgreSQL 保存账户、项目、任务与版本。服务端调用兼容 OpenAI 接口的模型；生成页面在隔离预览中运行。

## 功能

- 可匿名使用，也可用邮箱密码注册登录；登录时当前访客项目会并入账户，之后可跨设备访问。
- 创建和管理项目，通过对话生成与修改页面，查看任务进度和失败结果。
- 交互预览、查看与下载源码、比较版本、恢复历史版本。

目前生成的是单文件 HTML/CSS/JS 前端应用，不包含真实业务后端；账户暂不支持密码重置。

## 本地启动

需要 Node.js 20.9+、npm、PostgreSQL 17（可用 Docker 启动）及兼容 OpenAI 接口的模型服务。

1. 运行 `docker compose up -d db` 启动本地数据库；已有 PostgreSQL 可跳过。
2. 运行 `npm ci` 安装依赖。
3. 将 `.env.example` 复制为未跟踪的 `.env`，填写 `DATABASE_URL`，并取消注释、填写 `MODEL_API_KEY`、`MODEL_BASE_URL` 和 `MODEL_NAME`。不要提交真实密钥。
4. 执行：

```powershell
node --env-file=.env scripts/migrate.mjs
npm run dev
```

打开 `http://localhost:3000`。端口被占用时可用 `npm run dev -- -p 3001`，再打开对应端口。

## 部署

复制 `.env.production.example` 为服务器上的 `.env` 并填写配置，然后运行 `docker compose -f compose.deploy.yml up -d --build`。生产环境需要 HTTPS 反向代理；示例见 `deploy/Caddyfile`。更多设计与验收说明见 `docs/`。
