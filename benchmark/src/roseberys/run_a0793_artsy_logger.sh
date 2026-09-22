#!/bin/zsh
# Artsy-side A0793 poller. 15 min normally; every 5 min once live bidding opens
# (23 Sep 09:50 local) until 20:00; stops 24 Sep 12:00.
# Artsy drops lotWatcherCount when the sale closes, so the pre-close series is the whole point.
# Waits in 20 s steps against the wall clock — a plain sleep stops counting while the Mac sleeps.
HERE=${0:a:h}
LOG=$HERE/../../../tests/backtest/output/A0793_interest/artsy_logger.log
END=$(date -j -f "%Y-%m-%d %H:%M" "2026-09-24 12:00" +%s)
SALE_FROM=$(date -j -f "%Y-%m-%d %H:%M" "2026-09-23 09:50" +%s)
SALE_TO=$(date -j -f "%Y-%m-%d %H:%M" "2026-09-23 20:00" +%s)
while [ "$(date +%s)" -lt "$END" ]; do
  /usr/bin/python3 "$HERE/a0793_artsy_logger.py" >> "$LOG" 2>&1 || echo "$(date -u +%FT%TZ) run failed" >> "$LOG"
  NOW=$(date +%s)
  if [ "$NOW" -ge "$SALE_FROM" ] && [ "$NOW" -lt "$SALE_TO" ]; then NEXT=$((NOW + 300))
  else NEXT=$((NOW + 900)); [ "$NOW" -lt "$SALE_FROM" ] && [ "$NEXT" -gt "$SALE_FROM" ] && NEXT=$SALE_FROM; fi
  while [ "$(date +%s)" -lt "$NEXT" ]; do sleep 20; done
done
echo "$(date -u +%FT%TZ) artsy logger finished" >> "$LOG"
