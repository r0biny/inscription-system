import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../lab_config.mjs';

const quote = (value) => '"' + String(value).replaceAll('\\', '/').replaceAll('"', '\\"') + '"';
const regex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Stock Nginx adapter for the Worker's per-archive session cookie contract.
// Build on a workstation; production needs neither Node nor a new daemon.
export function nginxStaticConfig(config, options = {}) {
  const base = config.basePath;
  const escapedBase = regex(base);
  const upstream = new URL(config.upstreamOrigin);
  const publicHost = new URL(config.publicOrigin).hostname;
  const root = (options.staticRoot || '/srv/inscription-lab/dist').replaceAll('\\', '/');
  const ca = options.caFile || '/etc/ssl/certs/ca-certificates.crt';
  const resolver = options.resolver || '1.1.1.1 1.0.0.1';
  if (!/^[a-zA-Z0-9_:.[\] ]+$/.test(resolver)) throw Error('Invalid DNS resolver');
  const maps = `# Generated from deployment.json; include once in the http context.
# Bound peak in-memory request buffering to eight concurrent API requests.
limit_conn_zone $server_name zone=inscription_api_connections:64k;
map $http_origin $inscription_origin_ok {
    default 0;
    "" 1;
    ${quote(config.publicOrigin)} 1;
}
map $http_origin $inscription_upstream_origin {
    "" "";
    default ${quote(config.upstreamOrigin)};
}
map $cookie_${config.cookieName} $inscription_cookie_legacy {
    "" "";
    default "paper1_session=$cookie_${config.cookieName}; ";
}
map $cookie_${config.cookieName}_archive_1 $inscription_cookie_archive_1 {
    "" "";
    default "paper1_session_archive_1=$cookie_${config.cookieName}_archive_1; ";
}
map $cookie_${config.cookieName}_archive_2 $inscription_cookie_archive_2 {
    "" "";
    default "paper1_session_archive_2=$cookie_${config.cookieName}_archive_2; ";
}
map $cookie_${config.cookieName}_archive_3 $inscription_cookie_archive_3 {
    "" "";
    default "paper1_session_archive_3=$cookie_${config.cookieName}_archive_3; ";
}
map $cookie_${config.cookieName}_active_archive $inscription_cookie_active_archive {
    "" "";
    default "paper1_active_archive=$cookie_${config.cookieName}_active_archive";
}
map $request_uri $inscription_worker_uri {
    default "";
    "~^${escapedBase}(?<inscription_api_suffix>/api/.*)$" $inscription_api_suffix;
}
map "$uri|$arg_v" $inscription_static_cache {
    default "no-cache";
    "~^${escapedBase}/assets/" "public, max-age=31536000, immutable";
    "~^${escapedBase}/study-data/[^|]*\\|[a-f0-9]{12,64}$" "public, max-age=31536000, immutable";
}
# API redirects are only allowed back into the experiment. Unexpected relative
# or external redirects fail closed instead of leaving the study origin.
map $upstream_http_location $inscription_redirect_target {
    default "";
    "~^${regex(config.upstreamOrigin)}(?<inscription_absolute_path>/.*)$" "${base}$inscription_absolute_path";
    "~^/(?<inscription_root_path>[^/].*)$" "${base}/$inscription_root_path";
}
`;
  const apiHeaders = `    add_header Cache-Control "no-store" always;
    add_header X-Content-Type-Options "nosniff" always;`;
  const locations = `# Generated from deployment.json; include inside the main HTTPS server only.
location = ${base} {
    return 308 ${config.publicOrigin}${base}/$is_args$args;
}
location ^~ ${base}/api/ {
    default_type application/json;
    if ($host != ${quote(publicHost)}) { return 308 ${config.publicOrigin}$request_uri; }
    if ($inscription_origin_ok = 0) { return 403 '{"ok":false,"message":"请求来源无效。"}'; }
    if ($inscription_worker_uri = "") { return 404; }
    limit_conn inscription_api_connections 8;
    limit_conn_status 429;
    resolver ${resolver} ipv6=off valid=300s;
    resolver_timeout 5s;
    set $inscription_worker ${quote(config.upstreamOrigin)};
    proxy_pass $inscription_worker$inscription_worker_uri;
    proxy_http_version 1.1;
    proxy_pass_request_headers off;
    proxy_set_header Host ${quote(upstream.host)};
    proxy_set_header Connection "";
    proxy_set_header Accept "application/json";
    proxy_set_header Accept-Encoding "identity";
    proxy_set_header Content-Type $http_content_type;
    proxy_set_header User-Agent $http_user_agent;
    proxy_set_header Origin $inscription_upstream_origin;
    proxy_set_header Cookie "$inscription_cookie_legacy$inscription_cookie_archive_1$inscription_cookie_archive_2$inscription_cookie_archive_3$inscription_cookie_active_archive";
${upstream.protocol === 'https:' ? `    proxy_ssl_server_name on;
    proxy_ssl_name ${quote(upstream.hostname)};
    proxy_ssl_verify on;
    proxy_ssl_trusted_certificate ${quote(ca)};
    proxy_ssl_verify_depth 3;\n` : ''}    client_max_body_size 1850000;
    client_body_buffer_size 1850000;
    client_body_in_file_only off;
    proxy_request_buffering on;
    proxy_buffering off;
    proxy_max_temp_file_size 0;
    proxy_cache off;
    proxy_next_upstream off;
    proxy_connect_timeout 8s;
    proxy_read_timeout 30s;
    proxy_send_timeout 30s;
    proxy_cookie_name paper1_session ${config.cookieName};
    proxy_cookie_name paper1_session_archive_1 ${config.cookieName}_archive_1;
    proxy_cookie_name paper1_session_archive_2 ${config.cookieName}_archive_2;
    proxy_cookie_name paper1_session_archive_3 ${config.cookieName}_archive_3;
    proxy_cookie_name paper1_active_archive ${config.cookieName}_active_archive;
    proxy_cookie_path / ${base}/;
    proxy_hide_header Cache-Control;
    proxy_hide_header Expires;
    proxy_hide_header Location;
    proxy_ignore_headers X-Accel-Redirect X-Accel-Buffering;
    proxy_intercept_errors on;
    error_page 301 302 303 307 308 = @inscription_redirect;
    error_page 413 = @inscription_too_large;
    access_log off;
${apiHeaders}
}
location @inscription_redirect {
    default_type application/json;
${apiHeaders}
    if ($inscription_redirect_target = "") { return 502 '{"ok":false,"message":"实验服务返回了意外跳转。"}'; }
    if ($upstream_status = 301) { return 301 $inscription_redirect_target; }
    if ($upstream_status = 302) { return 302 $inscription_redirect_target; }
    if ($upstream_status = 303) { return 303 $inscription_redirect_target; }
    if ($upstream_status = 307) { return 307 $inscription_redirect_target; }
    return 308 $inscription_redirect_target;
}
location @inscription_too_large {
    default_type application/json;
    add_header Cache-Control "no-store" always;
    return 413 '{"ok":false,"message":"提交内容过大，请联系研究者。"}';
}
location ^~ ${base}/ {
    alias ${quote(root + '/')};
    if ($host != ${quote(publicHost)}) { return 308 ${config.publicOrigin}$request_uri; }
    index index.html;
    autoindex off;
    if ($request_method !~ "^(GET|HEAD)$") { return 405; }
    if ($uri ~ "(?:^|/)\\.") { return 404; }
    if ($uri !~ "(?:/$|\\.(?:html|js|css|svg|png|jpg|jpeg|webp|ico|woff2)$)") { return 404; }
    add_header Cache-Control $inscription_static_cache always;
    add_header X-Content-Type-Options "nosniff" always;
}
`;
  return { maps, locations };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = new URL('../deploy/', import.meta.url);
  const generated = nginxStaticConfig(readConfig(), {
    staticRoot: process.env.NGINX_STATIC_ROOT,
    caFile: process.env.NGINX_CA_FILE,
    resolver: process.env.NGINX_RESOLVER,
  });
  await mkdir(output, { recursive: true });
  await writeFile(new URL('nginx_static_maps.conf', output), generated.maps);
  await writeFile(new URL('nginx_static_locations.conf', output), generated.locations);
  console.log('Prepared Nginx-only deployment: no production Node process.');
}
