import path from 'node:path';
import { createRuntime } from './app.js';
import { APP_NAME, APP_VERSION, redactSecrets } from './util.js';

function argumentValue(name) {
  const prefix = `${name}=`;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return '';
}

function parsePort(name, fallback, { allowZero = false } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  const min = allowZero ? 0 : 1;
  if (!Number.isInteger(value) || value < min || value > 65535) {
    throw new Error(`${name} must be an integer between ${min} and 65535.`);
  }
  return value;
}

const adminPort = parsePort('VEILLINK_ADMIN_PORT', 8787);
const publicPort = parsePort('VEILLINK_PUBLIC_PORT', 8788);
const envDataDir = process.env.VEILLINK_DATA_DIR || '';
const argDataDir = argumentValue('--veillink-data-dir');
if (envDataDir && argDataDir && path.resolve(envDataDir) !== path.resolve(argDataDir)) {
  console.error(
    'VEILLINK_DATA_DIR and --veillink-data-dir point to different directories; refusing to start.'
  );
  process.exit(1);
}
const dataDir = envDataDir || argDataDir || '';

process.title = 'VeilLink';

const runtime = await createRuntime({ dataDir, adminPort, publicPort });

try {
  await runtime.start();
} catch (error) {
  console.error(`[${APP_NAME}] 启动失败: ${redactSecrets(error.message)}`);
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${error.port || ''} 已被占用。请关闭重复实例，或设置 VEILLINK_ADMIN_PORT / VEILLINK_PUBLIC_PORT。`);
  }
  await runtime.stop().catch(() => {});
  process.exit(1);
}

const upstream = runtime.configStore.safeSnapshot();
const publicUrl = runtime.configStore.config.public.baseUrl;

console.log('');
console.log(`${APP_NAME} ${APP_VERSION}`);
console.log(`管理端（仅本机）  http://127.0.0.1:${runtime.adminPort}`);
console.log(`公网 API 监听     http://127.0.0.1:${runtime.publicPort}`);
console.log(`数据目录          ${runtime.paths.dataDir}`);
console.log(
  `上游网关          ${upstream.baseUrl || '未配置'}${
    upstream.models?.length ? `  ·  ${upstream.models.join(', ')}` : ''
  }`
);
if (upstream.configured && !upstream.models?.length) {
  console.log('警告: 已配置上游地址但模型白名单为空，公网请求会返回 503。请在管理端至少添加一个模型。');
}
console.log(`公网地址          ${publicUrl || '未填写（配置后显示）'}`);
console.log(`管理令牌文件      ${runtime.paths.adminTokenFile}`);
if (runtime.adminTokenInfo.created && process.stdout.isTTY) {
  console.log('');
  console.log('首次启动，已生成管理令牌（仅本机终端可见）:');
  console.log(runtime.adminTokenInfo.tokenGenerated);
  console.log('该令牌也会保存在上面的管理令牌文件中。');
}
if (runtime.adminTokenInfo.tokenFileMatches === false) {
  console.log('');
  console.log('警告: 管理令牌文件与保存的凭据不一致。若无法登录，请运行: npm run admin:reset');
}
if (!runtime.adminTokenInfo.tokenFileExists) {
  console.log('');
  console.log('警告: 管理令牌文件缺失。请运行: npm run admin:reset');
}
if (runtime.keyStore?.unreadableCount > 0) {
  console.log('');
  console.log(
    `警告: ${runtime.keyStore.unreadableCount} 个已保存的客户端 API Key 无法解密。` +
      '通常是 data/master.key 被替换或丢失。请在管理端重新生成密钥，或恢复备份的 master.key。'
  );
}
if (runtime.permissionWarning) {
  console.log('');
  console.log(`警告: 无法收紧数据目录 ACL（${redactSecrets(runtime.permissionWarning)}）。请以当前用户运行 scripts/setup-acl.ps1。`);
}
console.log('');
console.log(`管理端口 ${runtime.adminPort} 仅绑定 127.0.0.1，请勿通过隧道或防火墙暴露它。`);
console.log('按 Ctrl+C 停止。');
console.log('');

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`\n[${APP_NAME}] 收到 ${signal}，正在停止...`);
  try {
    await runtime.stop();
  } catch (error) {
    console.error(`[${APP_NAME}] 停止时出错: ${redactSecrets(error.message)}`);
  }
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

process.on('uncaughtException', async (error) => {
  console.error(`[${APP_NAME}] 未捕获异常: ${redactSecrets(error?.message || String(error))}`);
  await shutdown('uncaughtException');
});
process.on('unhandledRejection', async (error) => {
  console.error(`[${APP_NAME}] 未处理的 Promise 拒绝: ${redactSecrets(error?.message || String(error))}`);
  await shutdown('unhandledRejection');
});
