[toc]

# 本机提交、后台补传与教程更新

## 本次功能

- 新手引导只需连续点击七条提示，无需实际输入、绘制或答问卷；保留五步实验布局。
- 教程采用完整示例：「郷」outline 29 条笔画，「述」skeleton 9 条笔画。
- 正式任务持续保留浏览器草稿。最终提交先持久保存并冻结，本机成功后立即完成、解锁下一任务。
- 后台按任务顺序上传；网络失败后按 2、5、10、20、30 秒退避，之后最多每 30 秒重试。联网或重新切回页面也会触发同步。
- 每次请求使用固定编号和冻结内容，丢失服务器回复也能安全重试。较早请求的确认不会覆盖最新草稿。
- 未上传时离开会有轻量提醒；退出身份不能清理尚未上传的记录。本机存储失败、身份失效或冲突会明确提示。

## Music X Lab 管理人需要做什么

配套 Worker 和 D1 迁移已由研究者部署，无需申请 Cloudflare 凭据、修改数据库或新增后台。

按 README 的更新流程执行 git pull --ff-only、npm ci、npm test、npm run build，然后仅重启本项目服务。现有子目录和反向代理配置不变；新 /api/offline/* 请求由原有转发规则自动处理。

offline_sw.js 必须从实验子目录提供，保持 no-cache，不添加作用于整个网站的 Service-Worker-Allowed: /。生产环境须使用现有 HTTPS。构建文件含路径，调整子目录须重新构建。

代码推送 GitHub 不代表 Music X Lab 网站已更新，需管理人完成拉取与重启。

## 数据及范围

Cookie、localStorage、IndexedDB、Cache Storage 和浏览器锁均按实验子目录命名。Service Worker 的 scope 仅是实验子目录，缓存中只包含本项目网页与静态素材，不包含 API 响应。

例如默认目录下 IndexedDB 名称为 paper1_lab:/inscription-system/:offline-outbox-v1，缓存名称为 paper1_lab:/inscription-system/:offline-static-v1。研究者继续从原 D1 获取数据，Node 转发服务器不保存第二份实验数据库。

首次登录、完成新手引导和下载实验材料需要联网；材料缓存完成后才能完整离线打开后续任务。关闭网页后不保证持续上传，再次打开同一浏览器、同一网址会恢复。不要清除浏览器数据或更换入口来恢复未上传记录。

两个网站入口的本地记录不互通。避免在两端同时编辑同一任务；若检测到版本冲突，记录会保留并提示联系研究者，不做自动合并。

## 验证

npm test 包含本地转发、路径隔离、固定请求重试和最新草稿保护；npm run build 检查类型及部署路径。构建后可运行 node scripts/browser_smoke.mjs（需要 Playwright），在本地模拟服务器上验证教程、三任务离线完成、刷新、补传和丢失确认。

这些测试不证明 Music X Lab 网站服务器到 Cloudflare 的实际连通性；管理人仍需在服务器运行 npm run check:upstream，再由研究者验收正式链接。
