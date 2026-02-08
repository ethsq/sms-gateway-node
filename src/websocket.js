const { WebSocketServer } = require('ws');

function setupWebSocket(server, modem, apiKey) {
    const wss = new WebSocketServer({
        server,
        path: '/ws',
        verifyClient: (info, cb) => {
            if (!apiKey) return cb(true);
            const url = new URL(info.req.url, 'http://localhost');
            const key = url.searchParams.get('apiKey') || info.req.headers['x-api-key'];
            if (key !== apiKey) return cb(false, 401, 'Unauthorized');
            cb(true);
        }
    });

    // ── connection handler ──────────────────────────────────────

    wss.on('connection', async (ws) => {
        console.log('📱 WebSocket client connected');

        ws.isAlive = true;
        ws.on('pong', () => { ws.isAlive = true; });

        ws.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));

        // Send all existing SMS on SIM card to the new client
        if (modem.connected && modem.initialized) {
            try {
                const messages = await modem.readSMS();
                if (messages.length > 0) {
                    ws.readyState === ws.OPEN && ws.send(JSON.stringify({
                        type: 'sms_history',
                        timestamp: new Date().toISOString(),
                        messages
                    }));
                    console.log(`📨 Sent ${messages.length} existing SMS to new client`);
                }
            } catch (err) {
                console.error('Error sending SMS history:', err.message);
            }
        }

        const unsub = modem.addListener((e) =>
            ws.readyState === ws.OPEN && ws.send(JSON.stringify(e))
        );
        ws.on('close', () => { console.log('📱 WebSocket disconnected'); unsub(); });
    });

    // ── ping/pong heartbeat ─────────────────────────────────────

    const heartbeatInterval = setInterval(() => {
        for (const ws of wss.clients) {
            if (!ws.isAlive) {
                console.log('💀 Terminating stale WebSocket');
                ws.terminate();
                continue;
            }
            ws.isAlive = false;
            ws.ping();
        }
    }, 30_000);

    wss.on('close', () => clearInterval(heartbeatInterval));

    return wss;
}

module.exports = { setupWebSocket };
