#!/bin/sh
# 安全啟動 ubuntu 外部測試：金鑰不得出現在任何 process argv。
#
# 用法（server 上，以 root 執行）：
#   sudo sh scripts/run-external-test-safe.sh --stop-at NIGHT_RESULT --save-state /tmp/night1.json
#   sudo sh scripts/run-external-test-safe.sh --resume /tmp/night1.json --stop-at DAY_RESULT --save-state /tmp/day1.json
#
# 金鑰只從 root 600 的 /etc/sglang/api-key.env 載入 process environment；
# curl preflight 的 Authorization header 也由 stdin 傳入，不經 argv。

set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "ABORT: 請用 root 執行（需讀取 /etc/sglang/api-key.env）" >&2
  exit 1
fi

if [ "$#" -eq 0 ]; then
  echo "ABORT: 缺少 external-test-stage2.mjs 參數" >&2
  exit 1
fi

set -a
. /etc/sglang/api-key.env
set +a

if [ -z "${SGLANG_API_KEY:-}" ]; then
  echo "ABORT: SGLANG_API_KEY 為空（讀不到 /etc/sglang/api-key.env）" >&2
  exit 1
fi

REPO=/opt/wolfgame
TARGET_USER=morowin
cd "$REPO"

TARGET_UID=$(id -u "$TARGET_USER")
TARGET_GID=$(id -g "$TARGET_USER")

echo "=== preflight ==="
echo "HEAD: $(git log --oneline -1)"

# curl 參數會出現在 /proc/<pid>/cmdline；金鑰改由 stdin 的 curl config 傳入。
# printf 是 shell builtin，不會另外產生帶金鑰的 argv。
code=$(
  printf 'header = "Authorization: Bearer %s"\n' "$SGLANG_API_KEY" |
    curl --config - -s -o /dev/null -w '%{http_code}' http://127.0.0.1:9090/v1/models
)

echo "sglang auth: HTTP $code"
if [ "$code" != "200" ]; then
  echo "ABORT: sglang 拒絕金鑰" >&2
  exit 1
fi

echo "=== start $(date -u +%H:%M:%S) UTC ==="

# setpriv 會保留環境變數；node argv 只包含測試腳本本身與 "$@" 測試參數。
exec setpriv --reuid="$TARGET_UID" --regid="$TARGET_GID" --init-groups \
  node scripts/external-test-stage2.mjs "$@"
