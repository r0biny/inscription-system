# 使用现有 Nginx 部署：不增加常驻 Node 进程

适用于已有 Nginx、内存有限的网站服务器。前端仍在开发机用 Node 构建，发布服务器只保存构建产物，由现有 Nginx 提供静态文件并转发实验 API。原 Node 方案继续保留，二者择一使用。

```text
浏览器 → Music X Lab Nginx
           ├─ /inscription-system/        → 本地 dist/ 页面、脚本、图片
           └─ /inscription-system/api/   → 现有 Cloudflare Worker → 原 D1
```

此方案不创建第二个数据库、不需要 Cloudflare 凭据，也不需要安装或启动服务器 Node、Docker 或新的 systemd 服务。生产登录、问卷和提交仍写入真实 D1，测试时应区分本地模拟与正式数据验收。

## 1. 在开发机安装、验证和构建

使用仓库要求的 Node 22.13+，检查 `deployment.json` 中的网址和上游后运行：

```bash
npm ci
npm test
npm run build:nginx
```

`build:nginx` 完成类型检查、前端构建，并生成：

- `dist/`：与原 Node 方案相同的浏览器产物。
- `deploy/nginx_static_maps.conf`：放入 Nginx 的 `http` 上下文。
- `deploy/nginx_static_locations.conf`：放入主站现有 HTTPS `server` 内部。

原来的 `deploy/nginx_locations.conf` 是转发到 Node 的版本；本方案使用两个文件名带 `nginx_static` 的配置，不能同时安装两套子目录规则。

网址、子目录、Cookie 名称和 Worker 仍统一来自 `deployment.json`。环境相关的路径与 DNS 可在生成时指定：

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `NGINX_STATIC_ROOT` | `/srv/inscription-lab/dist` | 直接包含 `index.html` 的静态文件目录，可为指向版本目录的符号链接 |
| `NGINX_CA_FILE` | `/etc/ssl/certs/ca-certificates.crt` | 验证 Worker HTTPS 证书的 CA 文件，按操作系统调整 |
| `NGINX_RESOLVER` | `1.1.1.1 1.0.0.1` | 公共 DNS 示例，应换成目标环境中可用的解析器 |

例如 Debian/Ubuntu 环境可按实际路径设置：

```bash
NGINX_STATIC_ROOT=/srv/inscription-lab/current/dist \
NGINX_CA_FILE=/etc/ssl/certs/ca-certificates.crt \
NGINX_RESOLVER='1.1.1.1 1.0.0.1' \
npm run build:nginx
```

使用本机环境变量覆盖时，生成出来的配置对应目标服务器；不要把本机的 Windows 路径或测试端口复制到生产。

## 2. 验证真实 Nginx 行为

常规 `npm test` 在未提供 Nginx 时会跳过 Nginx 集成测试。发布此方案前，应在构建完成后提供本机 Nginx 可执行文件，运行包含该适配的测试：

```bash
NGINX_BINARY=/usr/sbin/nginx npm test
```

测试仅临时监听回环地址，使用本地模拟 Worker，在临时目录内保存测试配置；不加载系统的生产 Nginx 配置，也不使用真实 D1。若自动定位不到 `mime.types`，设置 `NGINX_MIME_TYPES` 为其路径。

浏览器测试复用原项目的完整流程。按 README 准备 Playwright 后：

```bash
NGINX_BINARY=/usr/sbin/nginx node scripts/browser_smoke.mjs
```

也可用 `CHROME_PATH` 和 `PLAYWRIGHT_MODULE` 指定已有浏览器及 Playwright。在 Windows PowerShell 中，例如：

```powershell
$env:NGINX_BINARY = 'C:\tools\nginx-1.20.1\nginx.exe'
$env:CHROME_PATH = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
npm test
node scripts/browser_smoke.mjs
```

本次验证使用 Nginx 1.20.1：22 项测试通过，完整浏览器模拟覆盖引导、缓存刷新、单标签页锁、三个任务离线提交、恢复网络后按序补传、响应丢失重试和退出。

## 3. 接入现有网站

1. 在网站服务器新建专属的静态版本目录，上传 `dist/` 的内容；不上传参与者数据、原始材料、私钥或研究者数据库。让 `NGINX_STATIC_ROOT` 对应到该目录。后续可通过切换符号链接更新版本。
2. 备份当前 Nginx 配置，确认没有同名子目录规则。
3. 安装生成的两个文件。例如分别放到 `/etc/nginx/inscription-system/maps.conf` 和 `/etc/nginx/inscription-system/locations.conf`。
4. 在 `http` 上下文中添加一次：

```nginx
include /etc/nginx/inscription-system/maps.conf;
```

5. 在主站现有 HTTPS `server` 内添加一次：

```nginx
include /etc/nginx/inscription-system/locations.conf;
```

保留原站的所有其他 location、证书及服务配置。生成的 API 规则应只接入实验所属的主站，不应复制到博客等其他虚拟主机。

6. 检查语法，只有通过后才重载现有 Nginx：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

不要启动 `node server.mjs` 或 `inscription-lab.service`。本方案不使用 4180 等本机 Node 端口。

## 4. 上线检查

使用目标网址检查页面和只读状态接口，例如：

```bash
curl -fI https://www.musicxlab.com/inscription-system/
curl -fsS --connect-timeout 8 --max-time 35 https://www.musicxlab.com/inscription-system/api/status
```

状态应为 HTTP 200，包含 `databaseReady: true`。此路径同时验证了服务器到 Worker 的连接、TLS 验证及实际转发配置。

- 桌面和手机页面、图片及新手引导应正常。
- 非规范主机名和无尾斜杠入口会跳转到配置中的 `publicUrl`。
- 原站首页、其他子目录及原 API 应保持正常。
- 真实实验验收仍由研究者使用专门测试身份完成，并核对 D1 保存结果；不要把本地模拟或状态接口通过当成真实数据验收。

部署后应测量目标环境的内存与交换空间变化。共享内存较多时可参考 PSS（共享内存按比例计算）；低负载测量不能替代并发峰值验证。

## 5. 转发行为、内存上限与兼容范围

- 只转发当前实验的登录 Cookie，名称与 Path 按部署子目录隔离；保留过期、HttpOnly、Secure、SameSite 属性并移除 Domain。
- 检查浏览器 Origin，再转换为 Worker Origin；其他站点的 Cookie / Authorization 不向 Worker 传递。
- 保留请求正文、查询字符串和上游错误；关闭 API 缓存及 POST 自动重放。
- API 全站同时最多处理 8 个请求，超过返回 429。项目的离线同步会退避重试 429；普通交互请求可能需要参与者稍后重试。该限制是并行请求数，不是参与者总人数。
- 单请求最大 1,850,000 字节，与 Worker 一致；正文使用内存缓冲，测试确认未写入临时正文文件。8 个最大正文合计约 14.1 MiB，另有连接及 TLS 等开销。API 访问日志关闭，响应不落入临时文件。
- 带版本号的实验图片与构建脚本使用长期浏览器缓存；入口、Service Worker 等使用 `no-cache`，API 使用 `no-store`。
- 此适配针对当前 Worker 的单个 `paper1_session` Cookie 约定。若将来修改认证、发送多个 Set-Cookie 或更改 Cookie 名称，必须重新验证适配行为。
- 当前 API 不依赖重定向。配置只接受上游同源绝对 URL 或站内根路径重定向；其他重定向返回 502。Nginx 的 30 秒读写等待超时与 Node 的整次请求计时略有不同。
- 只提供既定静态文件类型，不公开 `build_info.json`、配置 JSON 或隐藏文件。实验 Service Worker、缓存与草稿继续限定在子目录。

## 6. 更新和回滚

在开发机拉取更新、测试并执行 `npm run build:nginx`。通过后上传到新的静态版本目录，切换链接；纯静态更新不需要 Nginx 重载。

若 `deployment.json` 中网址、目录或上游改变，重新生成两个配置文件，准备匹配的新静态目录后，备份并替换本实验规则，通过 `nginx -t` 再重载。检查浏览器草稿迁移限制，正式收集期间尽量保持网址稳定。

回滚静态版本时恢复前一版本链接。回滚路由时恢复本实验配置；若使用完整 Nginx 备份，先确认没有其他站点的后续变更需要保留。恢复配置不会自动移除仍可被主站默认规则访问的静态目录，需要停止入口访问时，单独移出实验符号链接或配置其返回维护响应，不删除整个主站目录。
