#!/usr/bin/env bash
# backend-core 隔离冒烟验证（仅本机环回；临时文件都在 $TMP，不留仓库垃圾）
#   HTTP 模式：与原状一致（无 HSTS、CSP 严格、/docs 放宽、/openapi.json 严格）
#   HTTPS 模式：同进程终结 TLS，HSTS 下发，凭据接口放行
# 说明：本脚本以真实子进程 + curl 验证「传输层」行为，单测用 app.inject 覆盖逻辑层。
set -u
ROOT=/b/AITrance/backend
TMP=$(mktemp -d)
# node.exe / 子进程是 Windows 原生进程，必须喂 Windows 形式路径
WTMP=$(cygpath -w "$TMP")
DB="$WTMP\\chat.sqlite"
PORT_H=3191
PORT_S=3192
fail=0

cleanup() {
  [ -n "${PID_H:-}" ] && kill "$PID_H" 2>/dev/null
  [ -n "${PID_S:-}" ] && kill "$PID_S" 2>/dev/null
  sleep 0.5
  [ "${KEEP:-0}" = 1 ] || rm -rf "$TMP"
}
trap cleanup EXIT

wait_up() { # port scheme
  for _ in $(seq 1 150); do
    if curl -s -o /dev/null -k "$2://127.0.0.1:$1/health"; then return 0; fi
    sleep 0.1
  done
  return 1
}

check() { # name expected actual
  if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1 (expected [$2] got [$3])"; fail=$((fail+1)); fi
}

# 取单个响应头的完整值（值里可能含 ": "，不能用 awk -F': '）
header() { # header-name
  grep -i "^$1: " | head -1 | sed -e "s/^$1: //I" -e 's/\r$//'
}

# 注册请求体写成文件，避免 shell 编码/长度问题
register_body() { # username url
  local body="$TMP/body-$1.json"
  printf '{"username":"%s","displayName":"Smoke User","password":"correct-password-123"}' "$1" > "$body"
  curl -sSkS -X POST -H 'content-type: application/json' --data-binary "@$body" "$2"
}

echo "== HTTP mode =="
# DEFAULT_FRIEND_USERNAME 置空：全新库无 QJQ，留空才能走正常注册成功路径
(cd "$ROOT" && PORT=$PORT_H DATABASE_PATH="$DB" DEFAULT_FRIEND_USERNAME= LOG_LEVEL=warn \
  exec node dist/src/server.js) >"$TMP/http.log" 2>&1 &
PID_H=$!
wait_up $PORT_H http || { echo "FAIL http server did not start"; sed -n '1,10p' "$TMP/http.log"; exit 1; }

curl -s -D "$TMP/h_health.txt" -o /dev/null "http://127.0.0.1:$PORT_H/health"
check "http health status" "200" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT_H/health")"
check "http x-frame-options" "DENY" "$(header x-frame-options < "$TMP/h_health.txt")"
check "http referrer-policy" "same-origin" "$(header referrer-policy < "$TMP/h_health.txt")"
check "http nosniff" "nosniff" "$(header x-content-type-options < "$TMP/h_health.txt")"
check "http no HSTS" "" "$(header strict-transport-security < "$TMP/h_health.txt")"
check "http permissions-policy" \
  "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()" \
  "$(header permissions-policy < "$TMP/h_health.txt")"
CSP=$(header content-security-policy < "$TMP/h_health.txt")
check "http CSP strict" \
  "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self' ws: wss:" \
  "$CSP"

curl -s -D "$TMP/h_docs.txt" -o /dev/null "http://127.0.0.1:$PORT_H/docs/"
DCSP=$(header content-security-policy < "$TMP/h_docs.txt")
case "$DCSP" in *"style-src 'self' 'unsafe-inline'"*) echo "PASS /docs CSP relaxed for swagger-ui";; *) echo "FAIL /docs CSP [$DCSP]"; fail=$((fail+1));; esac
check "/docs status" "200" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT_H/docs/")"
check "/docs static swagger-ui.css" "200" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT_H/docs/static/swagger-ui.css")"
check "/docs static swagger-initializer.js" "200" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT_H/docs/static/swagger-initializer.js")"
check "/docs static swagger-ui-bundle.js" "200" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT_H/docs/static/swagger-ui-bundle.js")"
check "/openapi.json status" "200" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT_H/openapi.json")"
curl -s -D "$TMP/h_oa.txt" -o /dev/null "http://127.0.0.1:$PORT_H/openapi.json"
OCSP=$(header content-security-policy < "$TMP/h_oa.txt")
check "/openapi.json keeps strict CSP" "$CSP" "$OCSP"

BODY=$(register_body smoke_http "http://127.0.0.1:$PORT_H/api/v1/auth/register")
case "$BODY" in *'"token":'*) echo "PASS register over http works (no TLS required)";; *) echo "FAIL register over http: $BODY"; fail=$((fail+1));; esac

kill "$PID_H" 2>/dev/null; PID_H=""
sleep 0.5

echo "== HTTPS mode =="
node --input-type=module -e "
import { TLS_CERT_PEM, TLS_KEY_PEM } from 'file:///B:/AITrance/backend/dist/test/fixtures/tls.js';
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[1], TLS_CERT_PEM);
writeFileSync(process.argv[2], TLS_KEY_PEM);
" "$TMP/cert.pem" "$TMP/key.pem" || { echo "FAIL materialize cert"; exit 1; }
check "test cert materialized" "yes" "$([ -s "$TMP/cert.pem" ] && [ -s "$TMP/key.pem" ] && echo yes)"

(cd "$ROOT" && PORT=$PORT_S DATABASE_PATH="$DB" DEFAULT_FRIEND_USERNAME= LOG_LEVEL=info \
  TLS_CERT_PATH="$WTMP\\cert.pem" TLS_KEY_PATH="$WTMP\\key.pem" \
  exec node dist/src/server.js) >"$TMP/https.log" 2>&1 &
PID_S=$!
wait_up $PORT_S https || { echo "FAIL https server did not start"; sed -n '1,10p' "$TMP/https.log"; exit 1; }

curl -sk -D "$TMP/s_health.txt" -o /dev/null "https://127.0.0.1:$PORT_S/health"
check "https health status" "200" "$(curl -sk -o /dev/null -w '%{http_code}' "https://127.0.0.1:$PORT_S/health")"
check "https HSTS" "max-age=31536000; includeSubDomains" "$(header strict-transport-security < "$TMP/s_health.txt")"
check "https CSP still strict" "$CSP" "$(header content-security-policy < "$TMP/s_health.txt")"
SBODY=$(register_body smoke_tls "https://127.0.0.1:$PORT_S/api/v1/auth/register")
case "$SBODY" in *'"token":'*) echo "PASS register over TLS works";; *) echo "FAIL register over TLS: $SBODY"; fail=$((fail+1));; esac
# 明文客户端打 TLS 端口必须失败（不是被当成 http 处理）
check "plain http against TLS port fails" "000" "$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT_S/health")"
if grep -q 'https' "$TMP/https.log" && grep -q 'transport' "$TMP/https.log"; then
  echo "PASS startup log states transport"
else
  echo "FAIL startup log does not state transport"; sed -n '1,4p' "$TMP/https.log"; fail=$((fail+1))
fi

echo "== summary: failures=$fail =="
exit "$fail"
