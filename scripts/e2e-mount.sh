#!/usr/bin/env bash
# =============================================================================
# dsh-auto-continue 挂载冒烟编排：
#   1. npm/pnpm pack 出 tarball，用官方 CLI 挂进全新 scratch profile
#      （`dsh plugin --profile web add file:<tarball>`，触发 dsh.profile.bundles）；
#   2. 启动真实 `dsh web`（--port 0 取 OS 分配端口）；
#   3. 运行 tests/e2e 无头渲染 lane（Playwright Chromium）：断言外壳与插件
#      client bundle 挂载、无 pageerror。
#
# 用法：bash scripts/e2e-mount.sh
# 环境变量（可省略）：
#   DSH_CMD       dsh 命令；缺省 PATH 上的 `dsh`
#   PORT          固定端口（默认 0 = OS 分配）
#   KEEP_HOME     非空时保留 scratch home（调试用）
# =============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PACKAGE_NAME="@deepseek-ai/dsh-auto-continue"

DSH_CMD="${DSH_CMD:-dsh}"
PORT="${PORT:-0}"

say()  { printf '\033[32m[e2e-mount]\033[0m %s\n' "$*"; }
die()  { printf '\033[31m[e2e-mount]\033[0m %s\n' "$*" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "未找到 node"
command -v pnpm >/dev/null 2>&1 || die "未找到 pnpm"
command -v "$DSH_CMD" >/dev/null 2>&1 || die "未找到 $DSH_CMD（npm i -g @deepseek-ai/dsh）"

# 构建 + pack
say "构建并打包 ..."
( cd "$ROOT" && pnpm build >/dev/null && pnpm pack >/dev/null )
TARBALL="$(ls -t "$ROOT"/deepseek-ai-dsh-auto-continue-*.tgz 2>/dev/null | head -1)"
[ -n "$TARBALL" ] && [ -f "$TARBALL" ] || die "找不到 tarball（pnpm pack 产物）"
TARBALL="$(cd "$(dirname "$TARBALL")" && pwd)/$(basename "$TARBALL")"
say "tarball: $TARBALL"

# scratch home
SCRATCH="$(mktemp -d /tmp/dsh-e2e-ac.XXXXXX)"
export DSH_HOME="$SCRATCH/home"
WORKSPACE_DIR="$SCRATCH/workspace"
WEB_LOG="$SCRATCH/web.log"
mkdir -p "$DSH_HOME/profiles/web" "$WORKSPACE_DIR"

SERVER_PID=""
cleanup() {
  local code=$?
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [ -z "${KEEP_HOME:-}" ]; then
    rm -rf "$SCRATCH"
  fi
  exit "$code"
}
trap cleanup EXIT

PROFILE_DIR="$DSH_HOME/profiles/web"
cat > "$PROFILE_DIR/package.json" <<EOF
{
  "name": "dsh-profile-web",
  "private": true,
  "dependencies": {},
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"]
    }
  }
}
EOF
printf '[]\n' > "$PROFILE_DIR/cordis.patch.yml"
cat > "$PROFILE_DIR/pnpm-workspace.yaml" <<'EOF'
packages:
  - .

nodeLinker: hoisted
autoInstallPeers: false

allowBuilds:
  node-pty: true
  protobufjs: true
EOF

# 官方 CLI 安装 tarball
say "执行 dsh plugin --profile web add file:$TARBALL ..."
"$DSH_CMD" plugin --profile web add "file:$TARBALL"

# 校验挂载
node -e '
  const fs = require("fs");
  const p = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const bundles = p.dsh?.profile?.bundles ?? [];
  process.exit(bundles.includes(process.argv[2]) ? 0 : 1);
' "$PROFILE_DIR/package.json" "$PACKAGE_NAME" || {
  echo "=== 插件未出现在 dsh.profile.bundles ===" >&2
  cat "$PROFILE_DIR/package.json" >&2
  exit 1
}
say "挂载已注册：dsh.profile.bundles 包含 $PACKAGE_NAME"

# 启动 dsh web
say "启动 dsh web（port=${PORT}）..."
"$DSH_CMD" web --port "$PORT" > "$WEB_LOG" 2>&1 &
SERVER_PID=$!

URL=""
for _ in $(seq 1 180); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "=== dsh web 提前退出，日志尾部 ===" >&2
    tail -40 "$WEB_LOG" >&2 || true
    exit 1
  fi
  if URL="$(grep -oE 'dsh web: http://127\.0\.0\.1:[0-9]+[^ ]*' "$WEB_LOG" | head -1 | awk '{print $3}')" && [ -n "$URL" ]; then
    break
  fi
  sleep 1
done
[ -n "$URL" ] || { echo "=== 未等到 dsh web 就绪 ===" >&2; tail -40 "$WEB_LOG" >&2 || true; exit 1; }
say "dsh web 就绪：${URL}（pid ${SERVER_PID}）"

# 运行 Playwright
say "运行 Playwright 无头渲染 lane ..."
DSH_E2E_URL="$URL" DSH_E2E_WORKSPACE="$WORKSPACE_DIR" \
  pnpm exec playwright test

say "通过：插件挂载到真实 DSH 后无头渲染未崩溃"
