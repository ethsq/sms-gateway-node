const express = require('express');

function createRouter(modem) {
    const router = express.Router();

    // ── status ──────────────────────────────────────────────────

    router.get('/status', async (_req, res) => {
        try {
            await modem.connect();
            res.json(await modem.getStatus());
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── SMS send ────────────────────────────────────────────────

    router.post('/sms/send', async (req, res) => {
        const { to, message } = req.body;
        if (!to || !message) return res.status(400).json({ error: 'Missing to/message' });
        try {
            await modem.connect();
            const cpin = await modem.sendCommand('AT+CPIN?', 3000);
            if (!cpin.includes('READY')) {
                return res.status(503).json({ error: 'SIM not ready', detail: cpin });
            }
            const result = await modem.sendSMS(to, message);
            modem.notify({ type: 'sms_sent', timestamp: new Date().toISOString(), to, message, ...result });
            res.json({ success: true, ...result });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── SMS list / delete ───────────────────────────────────────

    router.get('/sms', async (_req, res) => {
        try {
            await modem.connect();
            res.json({ messages: await modem.readSMS() });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.delete('/sms/:index', async (req, res) => {
        try {
            await modem.connect();
            res.json({ success: await modem.deleteSMS(req.params.index) });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── diagnostics ─────────────────────────────────────────────

    router.post('/diag/at', async (req, res) => {
        const { cmd, timeout } = req.body;
        if (!cmd) return res.status(400).json({ error: 'Missing cmd' });
        try {
            await modem.connect();
            const response = await modem.sendCommand(cmd, timeout || 5000);
            res.json({ cmd, response });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    router.post('/diag/reset', async (_req, res) => {
        try {
            if (modem.connected) modem.disconnect();
            await modem.sleep(1000);
            await modem.connect();
            res.json({ success: true, message: 'Modem reset and reconnected' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // ── health check ────────────────────────────────────────────

    router.get('/health', (_req, res) => {
        res.json({ status: 'ok', modemConnected: modem.connected });
    });

    return router;
}

module.exports = { createRouter };
