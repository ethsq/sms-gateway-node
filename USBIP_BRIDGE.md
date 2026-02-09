# USB/IP Bridge (macOS Docker Desktop -> sms-api)

This service needs the SIM7600 modem (`1e0e:9001`) inside Docker VM.

## One-time setup

1. Build the **patched** USB/IP host server:

```bash
cd external-services/sms-api
./scripts/build-usbip-host.sh        # clones upstream, applies patches, builds
```

Or let `usbip-bridge-up.sh` do it automatically on first run.

2. Start bridge and recreate `sms-api`:

```bash
./scripts/usbip-bridge-up.sh
```

3. Check status:

```bash
./scripts/usbip-bridge-status.sh
```

## Patches (`patches/usbip/`)

We carry two patches against [jiegec/usbip](https://github.com/jiegec/usbip) v0.8.0:

| Patch | Problem | Fix |
|-------|---------|-----|
| `0001-claim-interface-for-macos-iokit.patch` | rusb backend never calls `claim_interface()`. On macOS IOKit, bulk I/O silently returns 0 bytes without it — modem appears connected but all AT commands time out. | Call `claim_interface()` for each interface after `set_auto_detach_kernel_driver()`. |
| `0002-reduce-bulk-in-timeout-for-serial.patch` | All `handle_urb` bulk/interrupt IN reads block for 1 s. The sequential handler loop processes one USB/IP command at a time, so OUT writes (AT commands) are starved. | Reduce bulk IN and interrupt IN timeout to 10 ms; control and OUT keep 1 s. |

These patches are applied automatically by `scripts/build-usbip-host.sh`.

## Expected healthy signals

- If modem is not attached yet, `usbip list -r host.docker.internal` shows `1e0e:9001`.
- If modem is already attached, it may disappear from export list (normal), and `vhci status` should show one high-speed port with non-zero `sockfd` and `local_busid` (for example `1-1`).
- `/dev/ttyUSB*` exists in Docker VM.
- `docker compose exec -T sms-api curl -s http://localhost:3000/health` returns:

```json
{"status":"ok","modemConnected":true}
```

## Watchdog operations

`sms-api` runs with a macOS LaunchAgent watchdog.

- Runbook: `WATCHDOG_RUNBOOK.md`
- Install/Reinstall: `./scripts/install-watchdog.sh`
- Remove: `./scripts/install-watchdog.sh --remove`
