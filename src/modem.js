const usb = require('usb');

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
        this.initialized = false;
        this.processingIndices = new Set(); // dedup in-flight CMTI
        this._probeInFlight = false;
        this._probeFailures = 0;
    }

    // ── lifecycle ────────────────────────────────────────────────

    async connect() {
        if (this.connected) return;

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
        if (!this.device) throw new Error('SIM7600G-H not found');

        this.device.open();
        this.interface = this.device.interface(AT_INTERFACE);

        if (this.interface.isKernelDriverActive()) {
            this.interface.detachKernelDriver();
        }
        this.interface.claim();

        for (const ep of this.interface.endpoints) {
            if (ep.direction === 'in' && ep.address === EP_IN) this.epIn = ep;
            else if (ep.direction === 'out' && ep.address === EP_OUT) this.epOut = ep;
        }
        if (!this.epIn || !this.epOut) throw new Error('Could not find required endpoints');

        this.connected = true;
        console.log('✅ USB device opened');

        this.startReader();
        await this.sleep(200);

        await this.sendCommand('AT');
        await this.sendCommand('ATE0');
        await this.sendCommand('AT+CMGF=1');
        await this.sendCommand('AT+CSCS="UCS2"');
        // CSMP: fo=17, vp=167(24h), pid=0, dcs=8(UCS2 over-the-air)
        await this.sendCommand('AT+CSMP=17,167,0,8');
        // CNMI=2,1: store SMS on SIM, deliver +CMTI notification only.
        // This avoids multi-line +CMT URCs that have no end-of-message delimiter.
        await this.sendCommand('AT+CNMI=2,1,0,0,0');

        this.initialized = true;
        console.log('✅ Modem initialized');
    }

    disconnect() {
        this.connected = false;
        this.initialized = false;
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

    // ── event system ────────────────────────────────────────────

    addListener(cb) {
        this.listeners.add(cb);
        return () => this.listeners.delete(cb);
    }

    notify(event) {
        for (const l of this.listeners) {
            try { l(event); } catch (e) {}
        }
    }

    // ── USB reader & data handling ──────────────────────────────

    startReader() {
        if (this.readerRunning) return;
        this.readerRunning = true;
        this.consecutiveZlp = 0;
        console.log('📡 USB reader started');

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
                if (data && data.length > 0) {
                    this.consecutiveZlp = 0;
                    this.handleData(data.toString('utf8'));
                } else {
                    this.consecutiveZlp++;
                }
                // Adaptive throttle: 1 ms while active or awaiting response,
                // backs off to 10 ms after 50 consecutive zero-length packets
                // to reduce idle CPU / bridge load.
                const delay = (this.pendingCommand || this.consecutiveZlp < 50) ? 1 : 10;
                if (this.connected) setTimeout(read, delay);
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

                // Extract +CMTI URCs that arrived during a command response
                const cmtiRegex = /\+CMTI:\s*"[^"]*",\s*\d+/g;
                let match;
                while ((match = cmtiRegex.exec(response)) !== null) {
                    const urc = match[0];
                    setImmediate(() => this.handleURC(urc));
                }
                response = response.replace(cmtiRegex, '');

                const pending = this.pendingCommand;
                this.pendingCommand = null;
                pending.resolve(response.trim());
            }
            return;
        }
        this.handleURC(text);
    }

    handleURC(text) {
        const cmtiRegex = /\+CMTI:\s*"(\w+)",\s*(\d+)/g;
        let match;
        while ((match = cmtiRegex.exec(text)) !== null) {
            const [, storage, index] = match;
            if (this.processingIndices.has(index)) {
                console.log(`⏭️  Skipping duplicate CMTI for index=${index}`);
                continue;
            }
            this.processingIndices.add(index);
            console.log(`📩 NEW SMS notification: storage=${storage} index=${index}`);
            this.readAndDeleteSMS(index)
                .catch(err => console.error(`Error processing SMS index ${index}:`, err))
                .finally(() => this.processingIndices.delete(index));
        }
    }

    // ── AT command queue ────────────────────────────────────────

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
            console.warn(`⚠️ AT timeout: ${cmd}`);
            // Probe: send bare AT to check if bridge / modem is still alive.
            // If probe also fails, trigger reconnect instead of silently degrading.
            this._probeConnectivity();
            done(resolve, response || 'TIMEOUT');
        }, timeout);
    }

    /**
     * After an AT timeout, fire a lightweight probe to distinguish
     * "modem busy" from "bridge dead".  Two consecutive probe failures
     * trigger disconnect + reconnect.
     */
    _probeConnectivity() {
        if (this._probeInFlight || !this.connected) return;
        this._probeInFlight = true;
        this._probeFailures = (this._probeFailures || 0);

        const probeTimeout = setTimeout(() => {
            this._probeInFlight = false;
            this._probeFailures++;
            console.warn(`⚠️ Connectivity probe failed (${this._probeFailures}/2)`);
            if (this._probeFailures >= 2) {
                console.error('❌ Bridge appears dead – forcing reconnect');
                this._probeFailures = 0;
                this.disconnect();
                this.scheduleReconnect();
            }
        }, 3000);

        // Temporarily hijack the pending slot for the probe
        const prevPending = this.pendingCommand;
        this.pendingCommand = {
            resolve: () => {
                clearTimeout(probeTimeout);
                this._probeInFlight = false;
                this._probeFailures = 0;
                this.pendingCommand = prevPending;
            },
            reject: () => {
                clearTimeout(probeTimeout);
                this._probeInFlight = false;
                this.pendingCommand = prevPending;
            }
        };
        this.responseBuffer = '';
        this.epOut.transfer(Buffer.from('AT\r\n'), (err) => {
            if (err) {
                clearTimeout(probeTimeout);
                this._probeInFlight = false;
                this.pendingCommand = prevPending;
            }
        });
    }

    // ── SMS operations ──────────────────────────────────────────

    async readAndDeleteSMS(index) {
        const sms = await this.readSingleSMS(index);
        if (sms) {
            this.notify({ type: 'new_sms', timestamp: new Date().toISOString(), sms });
            await this.sendCommand(`AT+CMGD=${index}`, 5000);
        }
    }

    async readSingleSMS(index) {
        const response = await this.sendCommand(`AT+CMGR=${index}`, 5000);
        const lines = response.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.startsWith('+CMGR:')) {
                const parts = line.split(',');
                const bodyLines = [];
                for (let j = i + 1; j < lines.length; j++) {
                    const bl = lines[j].trim();
                    if (bl === 'OK' || bl === '') continue;
                    bodyLines.push(bl);
                }
                const rawStatus = parts[0].replace('+CMGR: ', '').replace(/"/g, '').trim();
                const rawSender = parts.length >= 2 ? parts[1].replace(/"/g, '').trim() : '';
                return {
                    index,
                    status: this.decodeUCS2(rawStatus),
                    sender: this.decodeUCS2(rawSender) || 'Unknown',
                    content: this.decodeUCS2(bodyLines.join(''))
                };
            }
        }
        return null;
    }

    async sendSMS(phone, message) {
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
                        this.pendingCommand = cmdHandler;
                        this.epOut.transfer(
                            Buffer.concat([Buffer.from(this.encodeUCS2(message)), Buffer.from([0x1A])]),
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

            this.epOut.transfer(Buffer.from(`AT+CMGS="${this.encodeUCS2(phone)}"\r`), (err) => {
                if (err) {
                    clearTimeout(promptTimer);
                    if (submitTimer) clearTimeout(submitTimer);
                    finish(reject, err);
                }
            });
        });
    }

    async readSMS() {
        const response = await this.sendCommand(`AT+CMGL="${this.encodeUCS2('ALL')}"`, 10000);
        const messages = [];
        const lines = response.split('\n');
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            if (line.startsWith('+CMGL:')) {
                const parts = line.split(',');
                if (parts.length >= 3) {
                    const rawContent = i + 1 < lines.length ? lines[++i].trim() : '';
                    messages.push({
                        index: parts[0].replace('+CMGL: ', ''),
                        status: this.decodeUCS2(parts[1].replace(/"/g, '').trim()),
                        sender: this.decodeUCS2(parts[2].replace(/"/g, '').trim()),
                        content: this.decodeUCS2(rawContent)
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
            operator: copsMatch ? this.decodeUCS2(copsMatch[1]) : 'Unknown'
        };
    }

    // ── UCS2 encoding helpers ───────────────────────────────────

    /** Encode JS string → UCS2 hex (UTF-16BE, 4 hex digits per char) */
    encodeUCS2(str) {
        let hex = '';
        for (let i = 0; i < str.length; i++) {
            hex += str.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
        }
        return hex;
    }

    /** Decode UCS2 hex → JS string. Returns original if not valid UCS2 hex. */
    decodeUCS2(hex) {
        if (!hex || hex.length < 4 || hex.length % 4 !== 0 || !/^[0-9A-Fa-f]+$/.test(hex)) return hex;
        let str = '';
        for (let i = 0; i < hex.length; i += 4) {
            str += String.fromCharCode(parseInt(hex.substr(i, 4), 16));
        }
        return str;
    }

    // ── helpers ─────────────────────────────────────────────────

    sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
}

module.exports = { SIM7600, VID, PID };
