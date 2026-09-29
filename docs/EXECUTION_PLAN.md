# Demo 剩余功能执行清单

范围以 [PRD.md](PRD.md) 的笔试 Demo P0 为准；长期路线图和 P1 不计入本轮完成标准。
每一项在**新的对话**中独立实现，验证通过后提交代码，并在此处记录提交号与证据。
`[x]` 只表示该项列出的验收全部通过；未验证或依赖外部资源时保持 `[ ]`。

## 已有基础（待回归）

- [x] A. 访客会话与项目管理（F1）：补足自动化权限/持久化测试，验证刷新、重启、跨访客隔离与重命名。代码提交 `28a438c`。证据（2026-09-29）：`npm run build`、`npm run typecheck` 通过；`DATABASE_URL=postgres://vibe:***@127.0.0.1:5432/vibe_atoms npm run test:f1` 通过（1/1）。测试在独立 PostgreSQL 数据库迁移并清理，启动/停止/重启生产 Next 进程，核对同 Cookie 项目列表与重命名持久化、两个访客的读写隔离、清除 Cookie 后拒绝旧项目、Origin 拒绝、非法 ID 与名称、Cookie 安全属性和数据库摘要；未使用临时存储代替数据库。

## 按顺序交付

1. [x] B. 生成后端（F2、F4、F5、F7）：服务端模型适配、真实规划/生成/基础检查、消息/任务/版本事务、固定基线、幂等、并发限制、超时与一次格式修复、错误分类及重试关联。代码提交 `cbfd8d3`。证据（2026-09-29）：`npm run typecheck`、`npm run build` 通过；独立 PostgreSQL 测试库运行 `node --env-file=.env --test tests/f1.test.mjs tests/generation.test.mjs`（2/2）及真实模型 `$env:REAL_MODEL_TEST="1"; node --env-file=.env --test tests/real-generation.test.mjs`（1/1）。真实模型完成非样例公交票价计算器首次生成与夜间附加费迭代，两版不同源码、四条消息及当前版本指针均来自数据库。模拟测试覆盖格式修复上限、配置/网络/模型超时、存储失败、并发及重复提交、重试关联、旧版保留、陈旧任务回收、跨访客隔离和服务重启后读取。基础检查不等于功能交互测试，UI/预览仍属后续项。
2. [x] C. 对话工作台：输入自定义需求、展示持久消息及真实任务阶段、耗时/失败/重试；项目切换与刷新恢复状态。代码提交 `d01756d`。证据（2026-09-29）：`npm run typecheck`、`npm run build`、`npm run test:c` 通过（浏览器 1/1）；独立 PostgreSQL 测试库的 `node --test tests/f1.test.mjs tests/generation.test.mjs` 通过（2/2）。Chrome 端到端测试覆盖自定义首轮与增量生成、规划和代码生成阶段、运行中刷新/切换后的禁用重复提交、失败后保留 v2、关联重试生成 v3、刷新后消息/任务/版本恢复、跨访客任务列表隔离；检查桌面及 390px 窄屏对话/结果截图与横向布局。生成结果仅显示版本元数据，隔离交互预览/源码仍属 D 项。
3. [x] D. 隔离预览与源码（F3）：同版 iframe/代码/复制/下载，桌面/移动与刷新；严守 sandbox 和 CSP。代码提交 `17b3f0d`。证据（2026-09-29）：`npm run typecheck`、`npm run build` 通过；独立 PostgreSQL 数据库运行 `node --env-file=.env --test tests/f1.test.mjs tests/generation.test.mjs tests/workbench.test.mjs tests/preview.test.mjs tests/frame-policy.test.mjs`（5/5）。Chrome 实测生成 HTML 的按钮与 canvas 像素、版本/源码/复制/下载一致、刷新和失败迭代保留旧版、桌面及 390px 截图（`test-results/d-desktop.png`、`d-mobile.png`）。`sandbox="allow-scripts"` 阻止平台 DOM/Cookie/storage、顶层导航与弹窗；iframe 文档 CSP 阻止 fetch、图片及表单外发。曾发现仅靠 `navigate-to 'none'` 无法阻止 iframe 自身导航；增加父页面响应 `frame-src 'none'` 后，独立探针和完整 E2E 均证实外部目标零请求，拦截后的预览可刷新恢复。
4. [x] E. 版本差异与恢复（F6）：所有权校验、版本列表/源码差异、恢复确认与新版本事务。代码提交 `1ba394e`。证据（2026-09-29）：`npm run typecheck`、`npm run build` 通过；独立 PostgreSQL 数据库运行 `node --env-file=.env --test tests/f1.test.mjs tests/generation.test.mjs tests/workbench.test.mjs tests/preview.test.mjs tests/frame-policy.test.mjs tests/versions.test.mjs`（A–E，6/6）。Chrome E2E 验证两版实际 HTML 增删及相同源码提示、恢复确认/取消、恢复后源码字节/交互预览/下载一致、刷新和后续历史保留；API 验证重复及并发同键恢复只创建一版、不同目标同键冲突、运行中生成任务阻止恢复、插入失败时当前指针不变、跨访客及跨项目读写拒绝、恢复不调用模型。桌面和 390px 截图为 `test-results/e-desktop-diff.png`、`test-results/e-mobile-diff.png`，移动布局无横向越界。
5. [ ] F. 公开 Demo 加固与交付：会话/IP 限流、全局并发和预算、安全及故障回归、README 限制/配置、持久数据库与 HTTPS 部署。验证：PRD 第 9 节 12 项用例、三类任务人工检查、外网首次生成及迭代、重启/重新部署持久化。

## 每项执行规则

- 开工前确认前一项提交、工作区状态和可复用的测试环境；一个功能只在其新对话中编写。
- 实现后运行针对性测试、类型检查和构建；根据风险补充 API/浏览器/人工验收。
- 失败或缺少关键验收条件时保持 `[ ]`，记录原因，不能仅凭代码存在标记完成。
- 验证成功才勾选、附上测试证据与 commit SHA，并提交该功能及本清单更新；之后才开启下一功能的对话。

## 当前外部依赖

- 本地忽略的 `.env` 已具备模型配置，B 项真实模型调用已验收；密钥不得提交，公开部署的模型额度与服务端配置仍待 F 项确认。
- Docker API 当前不可连接，但本机 `127.0.0.1:5432` 的 PostgreSQL 17 可连接，已完成 A 项独立测试库的跨服务重启验证；尚无托管 PostgreSQL，重新部署持久化仍待后续验收。
- 尚无 Git 远端、托管数据库或部署账户信息；无法验证公开 HTTPS Demo。

以上状态仅记录 2026-09-29 的本地检查结果，后续每项开工时重新确认。
