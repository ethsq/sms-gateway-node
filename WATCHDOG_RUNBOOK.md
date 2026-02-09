# SMS API Watchdog Runbook

This runbook defines the standard operating procedure for `sms-api` with macOS LaunchAgent watchdog.

## Scope

The watchdog (`net.backvision.sms-watchdog`) keeps these components healthy:

- `node server.js` for SMS API
- Docker container `sms-cloudflared`
- `/health` endpoint with `modemConnected:true`

## Standard Update Procedure

Run from `external-services/sms-api`:

```bash
# 1) Update code
git pull

# 2) Install dependencies
npm ci

# 3) Reinstall watchdog (idempotent: unload old + load new)
./scripts/install-watchdog.sh

# 4) Verify service health
curl -s http://localhost:3000/health
launchctl list | grep net.backvision.sms-watchdog
docker ps --format '{{.Names}}' | grep sms-cloudflared
tail -n 80 /tmp/sms-watchdog.log
```

Expected health response:

```json
{"status":"ok","modemConnected":true}
```

## Install / Reinstall Watchdog

```bash
cd external-services/sms-api
./scripts/install-watchdog.sh
```

What this does:

- Copies watchdog script to `~/.local/bin/sms-watchdog.sh`
- Generates LaunchAgent plist in `~/Library/LaunchAgents/`
- Unloads previous agent, then loads the new one

## Remove Watchdog

```bash
cd external-services/sms-api
./scripts/install-watchdog.sh --remove
```

## Runtime Checks

```bash
# LaunchAgent status
launchctl list | grep sms-watchdog

# Watchdog runtime log
tail -f /tmp/sms-watchdog.log

# launchd stdout/stderr
tail -f /tmp/sms-watchdog-launchd.log

# SMS API log
tail -f /tmp/sms-api.log

# API health
curl -s http://localhost:3000/health
```

## Troubleshooting

1. `node` not found:

```bash
which node
```

If empty, update `PATH` in:

`scripts/net.backvision.sms-watchdog.plist`

Then reinstall:

```bash
./scripts/install-watchdog.sh
```

2. `cloudflared` does not restart:

```bash
docker compose ps
docker compose up -d cloudflared
```

3. Modem remains disconnected:

```bash
curl -s http://localhost:3000/status
tail -n 120 /tmp/sms-api.log
tail -n 120 /tmp/sms-watchdog.log
```

4. Force manual watchdog restart:

```bash
./scripts/install-watchdog.sh --remove
./scripts/install-watchdog.sh
```
