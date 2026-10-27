#!/bin/sh
# 用手工启动的开发环境跑响应式验收。
#
# 用途：一条命令把「Vite(dev, 代理到隔离后端) + 隔离后端」拉起来，跑
#       e2e-responsive.mjs，然后收尾。
#
# 输入（环境变量）：
#   BASE     前端地址，默认 http://localhost:5173
#   BACKEND  隔离后端地址，默认 http://127.0.0.1:3099
#   SKIP_START=1  只用已在跑的服务，不自行拉起（CI 里由外部编排时用）
#
# 输出：验收脚本的 stdout；退出码与脚本一致。
#
# 副作用：
#   - 在 backend/.data/e2e-responsive.sqlite 建隔离测试库（非生产）
#   - 写 docs/evidence/resp-*.png
#   - 退出时杀掉自己拉起的两个进程；不动任何已存在的服务

set -e

BASE="${BASE:-http://localhost:5173}"
BACKEND="${BACKEND:-http://127.0.0.1:3099}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

echo "[run] BASE=$BASE BACKEND=$BACKEND"

if [ "${SKIP_START:-0}" != "1" ]; then
  echo "[run] 启动隔离后端 :3099（库=backend/.data/e2e-responsive.sqlite）"
  (
    cd "$ROOT/backend"
    DATABASE_PATH=.data/e2e-responsive.sqlite PORT=3099 \
      node --experimental-strip-types src/server.ts > /tmp/resp-backend.log 2>&1
  ) &
  BE_PID=$!

  echo "[run] 启动 Vite :5173（代理到隔离后端）"
  (
    cd "$ROOT/frontend"
    VITE_BACKEND_ORIGIN="$BACKEND" npx vite --mode integration --port 5173 \
      > /tmp/resp-vite.log 2>&1
  ) &
  FE_PID=$!

  # 等两个服务就绪再跑，避免脚本一上来就连不上
  i=0
  while [ $i -lt 40 ]; do
    if curl -sf -o /dev/null "$BACKEND/api/v1/health" && curl -sf -o /dev/null "$BASE/"; then
      break
    fi
    i=$((i + 1))
    sleep 0.5
  done
  echo "[run] 服务就绪（等待 ${i} 次）"

  cleanup() {
    echo "[run] 收尾"
    kill "$BE_PID" 2>/dev/null || true
    kill "$FE_PID" 2>/dev/null || true
  }
  trap cleanup EXIT INT TERM
fi

cd "$ROOT/frontend"
BASE="$BASE" BACKEND="$BACKEND" node e2e-responsive.mjs
