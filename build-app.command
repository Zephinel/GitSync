#!/usr/bin/env bash

# 双击执行此文件以在 macOS 平台上构建 GitSync
# 默认使用 Release 模式并清理缓存

# 切换到脚本所在目录
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
cd "$DIR"

echo "=========================================="
echo "    开始构建 GitSync (Release 模式)       "
echo "=========================================="
echo ""

# 标记为双击启动的独立终端窗口，成功后静默关闭，失败时保留日志
export BUILD_APP_AUTO_CLOSE="${BUILD_APP_AUTO_CLOSE:-1}"

# 直接交给基础构建脚本执行，构建结束后立即结束当前终端会话
exec ./build-app.sh "$@"
