#!/usr/bin/env sh
# Ferry 启动脚本：双击 / ./start.sh 打开界面，也可传 CLI 参数。
set -e
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1 || ! node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 23 || (major === 23 && minor >= 8) || (major === 22 && minor >= 15) ? 0 : 1)" >/dev/null 2>&1; then
  echo "[Ferry] 需要 Node.js 22.15+（22.x）或 23.8+：https://nodejs.org/"
  exit 1
fi

if [ "$#" -eq 0 ]; then
  exec node bin/ferry.js ui --open
else
  exec node bin/ferry.js "$@"
fi
