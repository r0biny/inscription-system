[toc]

# Music X Lab 网站：碑刻修复实验部署与更新指南

本项目是独立复制自 Paper 1 `app-online` 的 Music X Lab 网站子目录版本。暂定访问地址：

https://www.musicxlab.com/inscription-system/

页面、CSS、JS 和已处理图片由 Music X Lab 网站服务器提供；实验请求经本项目的 Node 服务转发到现有 Cloudflare Worker，仍写入同一个 D1 数据库。原 `app-online` 保持原有部署流程。

**Music X Lab 管理人不需要配置 Cloudflare 账号、API Token、数据库账号或 Wrangler，也不需要创建第二个数据库。**

## 分工与交付范围

- **研究者**：维护独立 GitHub 公开仓库，确认访问地址，维护实验代码、材料、Cloudflare Worker 和 D1，并负责实验数据验收。
- **Music X Lab 管理人**：在网站服务器拉取仓库、安装依赖、构建并运行本项目，为实验子目录配置转发，检查访问情况；后续按研究者通知更新。
- **双方共同确认**：最终子目录、服务器到 Worker 的连通性，以及首次上线后的完整实验流程。

本目录是独立公开仓库 [r0biny/inscription-system](https://github.com/r0biny/inscription-system) 的根目录，Music X Lab 管理人可直接克隆，无需额外读取授权。该仓库不包含外层研究项目，也不是仅包含 `app/` 子文件夹。

公开范围仅为运行代码、处理后的实验素材及页面已有的研究者联系方式；参与者信息和实验记录仍保存在 D1，不随代码公开。

仓库包含 `app/`、`public/`、`study-materials/`、`scripts/`、`tests/`、`deploy/`、配置文件和 `package-lock.json`。处理后的实验图片已包含在 `public/` 中，构建不依赖外层研究目录，也不会临时处理原始拓片。

不上传 `node_modules/`、`dist/`、参与者邮箱、问卷回答、笔画记录、D1 快照或登录凭据。问卷定义及练习起始笔画属于运行素材，可以随代码交付。

当前为可信参与者测试版：处理后的图片可以直接访问，没有逐张图片鉴权；任务分配和条件相关材料 JSON 仍由现有 Worker 返回。未复制原始 GT 或研究者素材制作图片。

## Music X Lab 管理人：首次部署

以下命令除特别说明外，均在服务器上的**本项目仓库根目录**执行。示例使用 Linux、Nginx 和 systemd；如果现有网站采用其他服务管理方式，请保留原有体系，只接入本实验子目录。

### 1. 确认环境并取得代码

请 Music X Lab 管理人先确认：

- 已与研究者确认最终访问地址，并可访问上述 GitHub 仓库。
- 服务器具备 Node.js 22.13+、npm、Git 和 curl。
- 可以在独立目录运行 Node 服务，且本机 `127.0.0.1:4180` 端口未被占用。
- 可以修改 Music X Lab 网站现有 HTTPS 站点的子目录配置。

将仓库克隆到独立目录，以下服务器路径仅为示例；执行前确保当前用户对目标目录有写入权限：

~~~bash
git clone https://github.com/r0biny/inscription-system.git /srv/inscription-lab
cd /srv/inscription-lab
~~~

不要覆盖 Music X Lab 网站现有文件。检查 `deployment.json` 中的 `publicUrl` 是否为双方确认的网址；默认端口为 4180，如需更改请在构建前调整。

### 2. 安装、构建并检查后端连接

依次运行；**任意一步失败都应先处理，不要继续发布**：

~~~bash
npm ci
npm test
npm run build
npm run check:upstream
~~~

`check:upstream` 只读取 Worker 的 `/api/status`，检查连接和 D1 是否可读，不创建参与者。必须在 Music X Lab 网站服务器上执行：它会绕过 shell 代理环境变量，验证与默认转发服务一致的直连条件。如果失败，请将错误信息交给研究者共同排查；本地电脑成功不能代替服务器检查。

随后临时启动服务：

~~~bash
npm start
~~~

在另一个终端检查：

~~~bash
curl -I http://127.0.0.1:4180/inscription-system/
curl --fail-with-body http://127.0.0.1:4180/inscription-system/api/status
~~~

预期页面返回 HTTP 200，状态接口显示 `databaseReady: true`。检查完成后，在启动服务的终端按 Ctrl+C 停止临时进程，再配置常驻运行。

服务只监听本机地址，无需向公网开放 4180 端口。若修改过端口或子目录，上述检查地址也需相应调整。

### 3. 配置常驻运行

Music X Lab 管理人可使用 `deploy/inscription_lab.service` 模板。先按实际环境修改其中的运行用户、代码目录和 Node 可执行文件路径，确保运行用户能读取项目文件。

确认没有同名的其他服务后，首次安装并启动：

~~~bash
sudo install -m 644 deploy/inscription_lab.service /etc/systemd/system/inscription-lab.service
sudo systemctl daemon-reload
sudo systemctl enable --now inscription-lab
sudo systemctl status inscription-lab --no-pager
~~~

如果启动失败，检查本服务日志：

~~~bash
sudo journalctl -u inscription-lab -n 80 --no-pager
~~~

如果服务器不使用 systemd，由 Music X Lab 管理人采用现有进程管理方式运行 `node server.mjs`，并设置工作目录和自动重启。

### 4. 接入 Music X Lab 网站子目录

Music X Lab 管理人先备份当前站点配置，检查是否已有相同的子目录规则，再将构建生成的 `deploy/nginx_locations.conf` 中的两个 `location` 段加入 `www.musicxlab.com` **现有 HTTPS server 段内部**。

**不要替换整个站点配置，不要改动原有首页路由和 HTTPS 证书配置。** 本项目只接管 `/inscription-system` 及 `/inscription-system/` 下的请求。

检查 Nginx 配置：

~~~bash
sudo nginx -t
~~~

仅在检查通过后，重载配置：

~~~bash
sudo systemctl reload nginx
~~~

Nginx 将实验子目录请求交给本地 Node 服务；Node 提供静态文件并向 Worker 转发实验请求。已有 HTTPS 证书继续使用，无需为子目录新增证书。

如果 Music X Lab 网站使用 Apache/Caddy，由 Music X Lab 管理人配置等效转发：将这个子目录**保留完整路径**转发给 `127.0.0.1:4180`，不要剥掉 `/inscription-system` 前缀，也不要缓存实验 API 响应。

### 5. 检查上线结果并通知研究者

Music X Lab 管理人检查：

- 实验网址可以打开，Dashboard、图片和新手引导可以加载。
- Music X Lab 网站原有首页和其他页面仍正常访问。
- 实验状态接口可以连接 Worker，没有持续的 502/504 错误。

随后将实际访问地址及检查结果发给研究者。研究者使用专门测试身份完成一次真实绘制和问卷，并从 D1 下载数据确认保存成功。

**正式入口的登录和提交会使用真实 D1。连通性检查通过，不等于完整实验已经验收。**

## Music X Lab 管理人：后续更新

研究者先修改、验证代码并推送 GitHub，再通知 Music X Lab 管理人更新。优先选择没有参与者作答的时间；两份 UI 源码独立维护，不会自动互相同步。

在本项目仓库根目录依次执行；如出现本地改动冲突、测试或构建失败，先停止并联系研究者，**不要强制覆盖文件**：

~~~bash
git pull --ff-only
npm ci
npm test
npm run build
~~~

全部成功后，仅重启本项目服务：

~~~bash
sudo systemctl restart inscription-lab
sudo systemctl status inscription-lab --no-pager
~~~

重新打开实验网址，检查页面与图片，并确认状态接口正常；然后通知研究者本次更新已完成。只更新 UI 时，无需部署 Cloudflare，也无需重载 Nginx。若使用其他进程管理方式，执行对应的本项目重启操作即可。

构建会替换 `dist/`。如果需要不中断更新，由 Music X Lab 管理人使用独立 release 目录构建成功后再切换。不要为更新本实验而重启整个 Music X Lab 网站。

涉及实验 API、条件、问卷校验或材料的变化，由研究者同步维护 `app-online` 的 Worker 和 D1 相关配置，并与 Music X Lab 管理人协调更新顺序，确保前后端及材料版本一致。

## 访问地址或端口改变时

研究者与 Music X Lab 管理人先确认新地址，再修改 `deployment.json`，例如：

~~~json
{
  "publicUrl": "https://www.musicxlab.com/research/inscription",
  "upstreamOrigin": "https://inscription-beta.robin-y.workers.dev",
  "host": "127.0.0.1",
  "port": 4180
}
~~~

重新执行 `npm run build`。Music X Lab 管理人使用重新生成的 Nginx 子目录配置替换**本实验原有的对应规则**，检查后重载 Nginx，并重启本项目服务。不要累加重复规则或删除其他页面的配置。

前端、图片、API、Cookie Path 和浏览器草稿命名空间会使用同一路径。运行时可用 `LAB_PUBLIC_URL`、`LAB_UPSTREAM_ORIGIN`、`HOST`、`PORT` 覆盖配置；改变目录必须重新构建，改变监听地址或端口时还需同步 Nginx 转发目标。

更换目录后需要重新输入邮箱。已同步到 D1 的进度仍可恢复；尚未上传的本地草稿不能自动跨域或跨目录迁移。收集正式数据后应尽量保持网址稳定。

## 研究者：材料与实验数据管理

`public/study-data/` 已包含目前三个正式 case 和新手练习所需的处理后图片，大图沿用 2048px 网页版。更换 case 时，研究者先用 `app-online` 的既有流程准备材料，再将参与者图片、练习 JSON 和练习起始笔画同步到本项目。

完整正式材料 JSON、GT 和数据库不放进 `public/`；不要将原始材料目录作为静态目录公开。本项目运行不依赖这些原始文件。

数据流保持为：

~~~text
Cloudflare 原网页 → 现有 Worker → paper1-online D1
Music X Lab 网站实验子目录 → 本项目 Node 服务 → 同一个 Worker → 同一个 D1
~~~

Music X Lab 网站服务器不创建第二个数据库。研究者继续使用原有的 `cloudflare-data-review` 同步与分析数据，无需 Music X Lab 管理人代为导出。

两个入口的登录 Cookie 和本地草稿分别保存，已上传的进度共享。实验期间建议参与者始终使用同一个入口，避免同时编辑同一任务。

## 本机预览与无数据写入测试

在本项目仓库根目录运行：

~~~bash
npm ci
npm run dev
~~~

打开终端提示的地址并加上 `/inscription-system/`，通常为：

http://127.0.0.1:5173/inscription-system/

**开发预览默认连接真实 Worker，登录和提交会写入真实 D1。** 以下测试不访问真实 D1：

- `npm test`：使用本地模拟 Worker 验证子目录、登录 Cookie、保存、暂停、恢复、heartbeat、完成、反馈、大请求和错误处理。
- `npm run build`：执行类型检查、浏览器构建和部署路径检查。
- 可选浏览器模拟测试：

~~~bash
npm install --no-save --package-lock=false playwright
npx playwright install chromium
node scripts/browser_smoke.mjs
~~~

浏览器测试检查欢迎页、登录、Dashboard 图片、刷新恢复、练习和退出。也可通过 `PLAYWRIGHT_MODULE` 指定已有 Playwright 模块，通过 `CHROME_PATH` 指定浏览器可执行文件。

本地验证不能证明 Music X Lab 网站服务器的网络连通性，也不代表已经发布到正式访问地址。

## 技术说明：转发与缓存

- 浏览器只请求 Music X Lab 网站同域名下的 `/inscription-system/api/...`。
- Node 去掉部署目录前缀，转发到现有 Worker 的 `/api/...`。
- Node 先检查浏览器 Origin 是否属于配置中的 Music X Lab 网站来源，再转换为 Worker origin，满足现有 Worker 的同源检查；没有放宽 Worker 白名单或修改原 `app-online`。
- 只转发本实验 Cookie，与 Music X Lab 网站其他 Cookie 区分名称，并将 Path 限定在实验子目录。
- API 不缓存，保留 POST 正文、状态码、错误和清除 Cookie 的响应。
- 构建资源和带版本号的图片使用长期浏览器缓存，替换图片时需同步新的版本 URL。
- 上传上限与 Worker 相同，为 1,850,000 字节；Nginx 配置为 2m。
- 超时或连接失败会返回错误，不假报保存成功，也不自动重放可能已写入 D1 的 POST。
- 本项目 Node 服务不将实验 API 正文、问卷回答或笔画记录写入本地文件或日志。
