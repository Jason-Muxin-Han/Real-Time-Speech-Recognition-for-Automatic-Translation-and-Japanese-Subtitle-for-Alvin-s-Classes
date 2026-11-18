#!/bin/bash
cd "$(dirname "$0")"
echo '首次启动需要联网下载模型，请耐心等待。关闭此窗口可退出。'
(sleep 3; open "http://127.0.0.1:${PORT:-8765}/") &
exec ./runtime/bin/java --add-modules jdk.httpserver -cp app KotobaLive
