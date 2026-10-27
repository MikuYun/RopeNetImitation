import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const backendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(backendRoot, '../frontend');
const outputRoot = join(backendRoot, '.data/deploy');
mkdirSync(outputRoot, { recursive: true });
const staging = mkdtempSync(join(outputRoot, 'web-'));

for (const path of ['src', 'public', 'mocks', 'scripts', 'package.json', 'package-lock.json', 'index.html',
  'tsconfig.json', 'tsconfig.node.json', 'vite.config.ts', '.env.production']) {
  if (existsSync(join(source, path))) cpSync(join(source, path), join(staging, path), { recursive: true });
}

function replaceExactlyOnce(path, oldValue, newValue) {
  const destination = join(staging, path);
  const content = readFileSync(destination, 'utf8');
  if (content.split(oldValue).length !== 2) throw new Error(`Deployment overlay no longer matches: ${path}`);
  writeFileSync(destination, content.replace(oldValue, newValue));
}

replaceExactlyOnce('vite.config.ts', 'export default defineConfig({', "export default defineConfig({\n  base: '/chat/',");
replaceExactlyOnce('src/router/index.ts', 'history: createWebHistory(),', 'history: createWebHistory(import.meta.env.BASE_URL),');
replaceExactlyOnce('src/api/http.ts', "baseURL: '',", 'baseURL: import.meta.env.BASE_URL,');
replaceExactlyOnce('src/ws/client.ts', '${location.host}/ws?ticket=', '${location.host}${import.meta.env.BASE_URL}ws?ticket=');

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
for (const args of [['ci', '--no-audit', '--no-fund'], ['run', 'build']]) {
  const result = spawnSync(npm, args, { cwd: staging, stdio: 'inherit', shell: process.platform === 'win32',
    env: { ...process.env, VITE_USE_MOCK: 'false' } });
  if (result.status !== 0) throw new Error(`Web build failed: ${args.join(' ')}`);
}

const index = readFileSync(join(staging, 'dist/index.html'), 'utf8');
if (!index.includes('/chat/assets/')) throw new Error('Web assets are not rooted under /chat/');
console.log(JSON.stringify({ staging, dist: join(staging, 'dist'), base: '/chat/' }));
