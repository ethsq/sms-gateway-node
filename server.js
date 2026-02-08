require('dotenv').config();

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const usb = require('usb');

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

const PORT = process.env.PORT || 3000;

// SIM7600G-H USB configuration
const VID = 0x1e0e;
const PID = 0x9001;
const AT_INTERFACE = 2;
const EP_OUT = 0x03;
const EP_IN = 0x84;

class SIM7600 {
    constructor() {
        this.device = null;
        this.interface = null;
        this.epIn = null;
        this.epOut = null;
        this.connected = false;
        this.listeners = new Set();
        this.pendingCommand = null;
        this.responseBuffer = '';
        this.readerRunning = false;
        this.commandQueue = [];
        this.processing = false;
        this.reconnecting = false;
        this.reconnectTimer = null;
    }

    async connect() {
        if (this.connected) return;

        // Reset state for clean reconnection
        this.commandQueue = [];
        this.processing = false;
        this.pendingCommand = null;
        this.responseBuffer = '';
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this.reconnecting = false;

        this.device = usb.findByIds(VID, PID);
        if (!this.device) {
            throw new Error('SIM7600G-H not found');
        }

        this.device.open();
        this.interface = this.device.interface(AT_INTERFACE);

        if (this.interface.isKernelDriverActive()) {
            this.interface.detachKernelDriver();
        }

        this.interface.claim();

        for (const ep of this.interface.endpoints) {
            if (ep.direction === 'in' && ep.address === EP_IN) {
                this.epIn = ep;
            } else if (ep.direction === 'out' && ep.address === EP_OUT) {
                this.epOut = ep;
            }
        }

        if (!this.epIn || !this.epOut) {
            throw new Error('Could not find required endpoints');
        }

        this.connected = true;
        console.log('✅ USB device opened');

        this.startReader();
        await this.sleep(200);

        await this.sendCommand('AT');
        await this.sendCommand('ATE0');
        await this.sendCommand('AT+CMGF=1');
        await this.sendCommand('AT+CSCS="GSM"');
        await this.sendCommand('AT+CNMI=2,2,0,0,0');

        console.log('✅ Modem initialized');
    }

    sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    addListener(cb) {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    notify(event) {
        for (const l of this.listeners) {
            try { l(event); } catch (e) { }
        }
    }

    startReader() {
        if (this.readerRunning) return;
        this.readerRunning = true;
        console.log('📡 Single reader started');

        const read = () => {
            if (!this.connected) { this.readerRunning = false; return; }
            this.epIn.transfer(512, (err, data) => {
                if (err) {
                    console.error('❌ USB read error:', err.message);
                    this.readerRunning = false;
                    this.disconnect();
                    this.scheduleReconnect();
                    return;
                }
                if (data && data.length > 0) this.handleData(data.toString('utf8'));
                if (this.connected) setImmediate(read);
            });
        };
        read();
    }

    handleData(text) {
        if (this.pendingCommand) {
            this.responseBuffer += text;
            if (this.responseBuffer.includes('OK') || this.responseBuffer.includes('ERROR') || this.responseBuffer.includes('>')) {
                let response = this.responseBuffer.trim();
                this.responseBuffer = '';

                // Extract URCs embedded in command response
                const cmtiRegex = /\+CMTI:\s*"[^"]*",\s*\d+/g;
                const cmtRegex = /\+CMT:\s*"[^"]*",[^\n]*\n[^\n]+/g;
                for (const regex of [cmtiRegex, cmtRegex]) {
                    let match;
                    while ((match = regex.exec(response)) !== null) {
                        const urc = match[0];
                        setImmediate(() => this.handleURC(urc));
                    }
                    response = response.replace(regex, '');
                }

                const pending = this.pendingCommand;
                this.pendingCommand = null;
                pending.resolve(response.trim());
            }
            return;
        }
        this.handleURC(text);
    }

    handleURC(text) {
        // +CMT direct delivery: +CMT: "<sender>",,"<timestamp>"\r\n<message>
        const cmtMatch = text.match(/\+CMT:\s*"([^"]*)",[^\n]*\n([\s\S]+)/);
        if (cmtMatch) {
            const sender = cmtMatch[1];
            const content = cmtMatch[2].trim();
            console.log(`📩 NEW SMS (direct) from ${sender}: ${content.substring(0, 50)}`);
            const sms = { index: null, status: 'REC UNREAD', sender, content };
            this.notify({ type: 'new_sms', timestamp: new Date().toISOString(), sms });
            return;
        }

        // +CMTI fallback: +CMTI: "<storage>",<index>
        const cmtiMatch = text.match(/\+CMTI:\s*"(\w+)",\s*(\d+)/);
        if (cmtiMatch) {
            const [, storage, index] = cmtiMatch;
            console.log(`📩 NEW SMS! Index: ${index}`);
            this.readSingleSMS(index).then(sms => {
                if (sms) this.notify({ type: 'new_sms', timestamp: new Date().toISOString(), sms });
            }).catch(err => console.error('Error reading SMS:', err));
        }
    }

    sendCommand(cmd, timeout = 5000) {
        return new Promise((resolve, reject) => {
            this.commandQueue.push({ cmd, timeout, resolve, reject });
            this.processQueue();
        });
    }

    processQueue() {
        if (this.processing || this.commandQueue.length === 0) return;
        this.processing = true;

        const { cmd, timeout, resolve, reject } = this.commandQueue.shift();
        this.responseBuffer = '';

        const done = (fn, val) => {
            this.processing = false;
            fn(val);
            setImmediate(() => this.processQueue());
        };

        this.pendingCommand = {
            resolve: (resp) => done(resolve, resp),
            reject: (err) => done(reject, err)
        };

        this.epOut.transfer(Buffer.from(cmd + '\r\n'), (err) => {
            if (err) {
                this.pendingCommand = null;
                done(reject, err);
            }
        });

        setTimeout(() => {
            if (!this.pendingCommand) return;
            const response = this.responseBuffer.trim();
            this.responseBuffer = '';
            this.pendingCommand = null;
            done(resolve, response || 'TIMEOUT');
        }, timeout);
    }

    async readSingleSMS(index) {
        const response = await this.sendCommand(`AT+CMGR=${index}`, 5000);
        const lines = response.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.startsWith('+CMGR:')) {
                const parts = line.split(',');
                return {
                    index,
                    status: parts[0].replace('+CMGR: ', '').replace(/"/g, ''),
                    sender: parts.length >= 2 ? parts[1].replace(/"/g, '') : 'Unknown',
                    content: i + 1 < lines.length ? lines[i + 1].trim() : ''
                };
            }
        }
        return null;
    }

    async sendSMS(phone, message) {
        // Wait for command queue to drain and serialize CMGS flow.
        while (this.pendingCommand || this.processing || this.commandQueue.length > 0) {
            await this.sleep(50);
        }

        return await new Promise((resolve, reject) => {
            this.processing = true;
            this.responseBuffer = '';
            let done = false;
            let stage = 'wait_prompt';

            const finish = (fn, val) => {
                if (done) return;
                done = true;
                this.pendingCommand = null;
                this.processing = false;
                fn(val);
                setImmediate(() => this.processQueue());
            };

            const promptTimer = setTimeout(() => {
                if (!done && stage === 'wait_prompt') {
                    finish(reject, new Error('TIMEOUT'));
                }
            }, 15000);

            let submitTimer = null;

            const cmdHandler = {
                resolve: (resp) => {
                    if (stage === 'wait_prompt') {
                        if (!resp.includes('>')) {
                            clearTimeout(promptTimer);
                            return finish(reject, new Error(resp || 'Failed to get SMS prompt'));
                        }
                        stage = 'wait_submit';
                        this.responseBuffer = '';
                        // Re-install ourselves so handleData routes the OK response back to us
                        this.pendingCommand = cmdHandler;
                        this.epOut.transfer(
                            Buffer.concat([Buffer.from(message), Buffer.from([0x1A])]),
                            (err) => {
                                if (err) {
                                    clearTimeout(promptTimer);
                                    if (submitTimer) clearTimeout(submitTimer);
                                    return finish(reject, err);
                                }
                            }
                        );
                        submitTimer = setTimeout(() => {
                            if (!done && stage === 'wait_submit') {
                                finish(reject, new Error('SMS send timeout'));
                            }
                        }, 30000);
                        return;
                    }

                    if (stage === 'wait_submit') {
                        clearTimeout(promptTimer);
                        if (submitTimer) clearTimeout(submitTimer);
                        if (resp.includes('OK')) {
                            const msgRef = resp.match(/\+CMGS:\s*(\d+)/);
                            return finish(resolve, { success: true, messageId: msgRef ? msgRef[1] : null });
                        }
                        return finish(reject, new Error(resp || 'SMS send failed'));
                    }
                },
                reject: (err) => {
                    clearTimeout(promptTimer);
                    if (submitTimer) clearTimeout(submitTimer);
                    finish(reject, err instanceof Error ? err : new Error(String(err)));
                },
            };
            this.pendingCommand = cmdHandler;

            // For CMGS, use CR only. LF can interfere with prompt stage on some modems.
            this.epOut.transfer(Buffer.from(`AT+CMGS="${phone}"\r`), (err) => {
                if (err) {
                    clearTimeout(promptTimer);
                    if (submitTimer) clearTimeout(submitTimer);
                    finish(reject, err);
                }
            });
        });
    }

    async readSMS() {
        const response = await this.sendCommand('AT+CMGL="ALL"', 10000);
        const messages = [];
        const lines = response.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.startsWith('+CMGL:')) {
                const parts = line.split(',');
                if (parts.length >= 3) {
                    messages.push({
                        index: parts[0].replace('+CMGL: ', ''),
                        status: parts[1].replace(/"/g, ''),
                        sender: parts[2].replace(/"/g, ''),
                        content: i + 1 < lines.length ? lines[++i].trim() : ''
                    });
                }
            }
        }
        return messages;
    }

    async deleteSMS(index) {
        const response = await this.sendCommand(`AT+CMGD=${index}`);
        return response.includes('OK');
    }

    async getStatus() {
        const cpin = await this.sendCommand('AT+CPIN?');
        const csq = await this.sendCommand('AT+CSQ');
        const cops = await this.sendCommand('AT+COPS?');
        const csqMatch = csq.match(/\+CSQ:\s*(\d+)/);
        const copsMatch = cops.match(/\+COPS:\s*\d+,\d+,"([^"]+)"/);
        return {
            connected: this.connected,
            simReady: cpin.includes('READY'),
            signal: csqMatch ? parseInt(csqMatch[1]) : 0,
            signalPercent: csqMatch ? Math.round((parseInt(csqMatch[1]) / 31) * 100) : 0,
            operator: copsMatch ? copsMatch[1] : 'Unknown'
        };
    }

    disconnect() {
        this.connected = false;
        this.readerRunning = false;
        if (this.pendingCommand) {
            try { this.pendingCommand.reject(new Error('Disconnected')); } catch (e) {}
            this.pendingCommand = null;
        }
        for (const cmd of this.commandQueue) {
            try { cmd.reject(new Error('Disconnected')); } catch (e) {}
        }
        this.commandQueue = [];
        this.processing = false;
        this.responseBuffer = '';
        try {
            if (this.interface) this.interface.release(true, () => {});
            if (this.device) this.device.close();
        } catch (e) {}
        this.device = null;
        this.interface = null;
        this.epIn = null;
        this.epOut = null;
        console.log('⚠️ USB device disconnected');
        this.notify({ type: 'modem_disconnected', timestamp: new Date().toISOString() });
    }

    scheduleReconnect() {
        if (this.reconnecting) return;
        this.reconnecting = true;
        console.log('🔄 Scheduling reconnect in 5s...');
        this.reconnectTimer = setTimeout(async () => {
            this.reconnecting = false;
            try {
                await this.connect();
                console.log('✅ Reconnected to modem');
                this.notify({ type: 'modem_reconnected', timestamp: new Date().toISOString() });
            } catch (err) {
                console.error('Reconnect failed:', err.message);
                this.scheduleReconnect();
            }
        }, 5000);
    }
}

const modem = new SIM7600();
const server = http.createServer(app);
const wss = new WebSocketServer({
    server,
    path: '/ws',
    verifyClient: (info, cb) => {
        if (!process.env.API_KEY) return cb(true);
        const url = new URL(info.req.url, 'http://localhost');
        const key = url.searchParams.get('apiKey') || info.req.headers['x-api-key'];
        if (key !== process.env.API_KEY) return cb(false, 401, 'Unauthorized');
        cb(true);
    }
});

// USB hotplug detection
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

wss.on('connection', async (ws) => {
    console.log('📱 WebSocket client connected');
    ws.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));

    // Send all existing SMS on SIM card to the new client
    if (modem.connected) {
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

    const unsub = modem.addListener((e) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(e)));
    ws.on('close', () => { console.log('📱 WebSocket disconnected'); unsub(); });
});

modem.connect().catch(err => console.error('Modem error:', err.message));

app.get('/status', async (req, res) => {
    try { await modem.connect(); res.json(await modem.getStatus()); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/sms/send', async (req, res) => {
    try {
        const { to, message } = req.body;
        if (!to || !message) return res.status(400).json({ error: 'Missing to/message' });
        await modem.connect();

        // Quick SIM readiness check before attempting SMS send
        const cpin = await modem.sendCommand('AT+CPIN?', 3000);
        if (!cpin.includes('READY')) {
            return res.status(503).json({ error: 'SIM not ready', detail: cpin });
        }

        const result = await modem.sendSMS(to, message);
        modem.notify({ type: 'sms_sent', timestamp: new Date().toISOString(), to, message, ...result });
        res.json({ success: true, ...result });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/sms', async (req, res) => {
    try { await modem.connect(); res.json({ messages: await modem.readSMS() }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/sms/:index', async (req, res) => {
    try { await modem.connect(); res.json({ success: await modem.deleteSMS(req.params.index) }); }
    catch (err) { res.status(500).json({ error: err.message }); }
});

// Diagnostic: send raw AT command to modem
app.post('/diag/at', async (req, res) => {
    try {
        const { cmd, timeout } = req.body;
        if (!cmd) return res.status(400).json({ error: 'Missing cmd' });
        await modem.connect();
        const response = await modem.sendCommand(cmd, timeout || 5000);
        res.json({ cmd, response });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Diagnostic: reset modem (disconnect + reconnect)
app.post('/diag/reset', async (req, res) => {
    try {
        if (modem.connected) modem.disconnect();
        await modem.sleep(1000);
        await modem.connect();
        res.json({ success: true, message: 'Modem reset and reconnected' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/health', (req, res) => res.json({ status: 'ok', modemConnected: modem.connected }));

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
