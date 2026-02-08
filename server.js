require('dotenv').config();

const express = require('express');
const http = require('http');
const usb = require('usb');

const { SIM7600, VID, PID } = require('./src/modem');
const { createRouter } = require('./src/routes');
const { setupWebSocket } = require('./src/websocket');

// ── Express app ─────────────────────────────────────────────

const app = express();
app.use(express.json());

// CORS for external clients
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type, X-API-Key');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

// API Key authentication
app.use((req, res, next) => {
    if (req.path === '/health') return next();
    if (!process.env.API_KEY) return next();
    const apiKey = req.headers['x-api-key'];
    if (apiKey !== process.env.API_KEY) {
        return res.status(401).json({ error: 'Unauthorized: Invalid or missing API key' });
    }
    next();
});

// ── Modem + HTTP server + WebSocket ─────────────────────────

const PORT = process.env.PORT || 3000;
const modem = new SIM7600();
const server = http.createServer(app);

app.use(createRouter(modem));
setupWebSocket(server, modem, process.env.API_KEY);

// ── USB hotplug detection ───────────────────────────────────

usb.usb.on('attach', (device) => {
    if (device.deviceDescriptor.idVendor === VID && device.deviceDescriptor.idProduct === PID) {
        console.log('🔌 SIM7600G-H USB attached');
        if (!modem.connected && !modem.reconnecting) {
            setTimeout(() => modem.connect().catch(err =>
                console.error('Hotplug connect failed:', err.message)
            ), 2000);
        }
    }
});

usb.usb.on('detach', (device) => {
    if (device.deviceDescriptor.idVendor === VID && device.deviceDescriptor.idProduct === PID) {
        console.log('🔌 SIM7600G-H USB detached');
        if (modem.connected) modem.disconnect();
    }
});

// ── Start ───────────────────────────────────────────────────

modem.connect().catch(err => console.error('Modem error:', err.message));

server.listen(PORT, () => {
    console.log(`
╔═══════════════════════════════════════════════════════╗
║           SMS API Server                              ║
╠═══════════════════════════════════════════════════════╣
║  API:       http://localhost:${PORT}                      ║
║  WebSocket: ws://localhost:${PORT}/ws                     ║
║  Auth:      ${process.env.API_KEY ? 'API Key ✅' : 'None ⚠️'}                            ║
║                                                       ║
║  GET  /status      - Modem status                     ║
║  POST /sms/send    - Send SMS {to, message}           ║
║  GET  /sms         - List all SMS                     ║
║  DELETE /sms/:id   - Delete SMS                       ║
║  POST /diag/at     - Send raw AT cmd {cmd, timeout}   ║
║  POST /diag/reset  - Reset modem connection            ║
║  GET  /health      - Health check (no auth)           ║
╚═══════════════════════════════════════════════════════╝
    `);
});
