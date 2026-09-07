#!/usr/bin/env bash
# Restart the local dev server with the newest code loaded.
# nodemon cannot watch /mnt/d (drvfs has no inotify), so after code changes
# the server must be restarted manually — this script does that.
set -u
# Kill stray nodemon instances without matching this script's own cmdline.
for p in $(pgrep -f nodemon); do
  [ "$p" = "$$" ] && continue
  kill -9 "$p" 2>/dev/null || true
done
pkill -9 -f 'node src/server\.js' 2>/dev/null || true
sleep 1
cd /mnt/d/projects/Gitlab/xensemble/server || exit 1
setsid nohup node --env-file=.env src/server.js > /tmp/xe-server.log 2>&1 < /dev/null &
sleep 8
echo "--- listen check ---"
ss -tlnp | grep 3888 | head -1 || echo '3888 NOT LISTENING'
echo "--- log tail ---"
tail -6 /tmp/xe-server.log
