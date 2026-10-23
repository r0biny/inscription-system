import { spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { nginxStaticConfig } from '../../scripts/prepare_nginx_static.mjs';

export async function startNginxFixture(config, staticRoot = fileURLToPath(new URL('../../dist', import.meta.url))) {
  const binary = process.env.NGINX_BINARY;
  if (!binary) throw Error('Set NGINX_BINARY to a local Nginx executable.');
  const binaryDir = path.dirname(path.resolve(binary));
  const mimeCandidates = process.env.NGINX_MIME_TYPES ? [process.env.NGINX_MIME_TYPES] : [
    path.join(binaryDir, 'conf/mime.types'),
    path.resolve(binaryDir, '../etc/nginx/mime.types'),
    '/etc/nginx/mime.types',
  ];
  let mimeTypes;
  for (const candidate of mimeCandidates) {
    try { await access(candidate); mimeTypes = path.resolve(candidate); break; } catch {}
  }
  if (!mimeTypes) throw Error('Cannot find mime.types; set NGINX_MIME_TYPES.');
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const origin = 'http://127.0.0.1:' + port;
  const dir = await mkdtemp(path.join(tmpdir(), 'inscription-nginx-'));
  const prefix = dir.replaceAll('\\', '/') + '/';
  await mkdir(path.join(dir, 'logs'));
  await mkdir(path.join(dir, 'temp'));
  const adapted = { ...config, publicOrigin: origin };
  const { maps, locations } = nginxStaticConfig(adapted, { staticRoot, resolver: '127.0.0.1' });
  await writeFile(path.join(dir, 'nginx.conf'), `daemon off;
master_process off;
pid logs/nginx.pid;
error_log logs/error.log notice;
events { worker_connections 128; }
http {
    include "${mimeTypes.replaceAll('\\', '/')}";
    access_log off;
    client_body_temp_path body_temp;
    proxy_temp_path proxy_temp;
    ${maps}
    server {
        listen 127.0.0.1:${port};
        server_name 127.0.0.1;
        ${locations}
        location = / { return 200 'Existing main site'; }
    }
}
`);
  const child = spawn(binary, ['-p', prefix, '-c', 'nginx.conf'], { cwd: dir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', c => output += c);
  child.stderr.on('data', c => output += c);
  const close = async () => {
    if (child.exitCode === null) {
      const stopped = once(child, 'exit');
      const control = spawn(binary, ['-p', prefix, '-c', 'nginx.conf', '-s', 'stop'], { cwd: dir, windowsHide: true, stdio: 'ignore' });
      await once(control, 'exit');
      await Promise.race([stopped, new Promise(resolve => setTimeout(resolve, 4000))]);
      if (child.exitCode === null) child.kill();
    }
    if (!path.resolve(dir).startsWith(path.resolve(tmpdir()) + path.sep) || !path.basename(dir).startsWith('inscription-nginx-')) throw Error('Unexpected temporary directory');
    await rm(dir, { recursive: true, force: true });
  };
  try {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (child.exitCode !== null) throw Error('Nginx exited: ' + output);
      try {
        const response = await fetch(origin);
        if (response.status === 200) return { origin, base: origin + config.basePath + '/', config: adapted, dir, close, logs: () => readFile(path.join(dir, 'logs/error.log'), 'utf8') };
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error('Nginx did not start: ' + output);
  } catch (error) {
    await close();
    throw error;
  }
}
