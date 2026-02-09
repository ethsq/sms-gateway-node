const GSM_7BIT_DEFAULT_ALPHABET = [
    '@', '£', '$', '¥', 'è', 'é', 'ù', 'ì', 'ò', 'Ç', '\n', 'Ø', 'ø', '\r', 'Å', 'å',
    'Δ', '_', 'Φ', 'Γ', 'Λ', 'Ω', 'Π', 'Ψ', 'Σ', 'Θ', 'Ξ', '\u001b', 'Æ', 'æ', 'ß', 'É',
    ' ', '!', '"', '#', '¤', '%', '&', "'", '(', ')', '*', '+', ',', '-', '.', '/',
    '0', '1', '2', '3', '4', '5', '6', '7', '8', '9', ':', ';', '<', '=', '>', '?',
    '¡', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O',
    'P', 'Q', 'R', 'S', 'T', 'U', 'V', 'W', 'X', 'Y', 'Z', 'Ä', 'Ö', 'Ñ', 'Ü', '§',
    '¿', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o',
    'p', 'q', 'r', 's', 't', 'u', 'v', 'w', 'x', 'y', 'z', 'ä', 'ö', 'ñ', 'ü', 'à'
];

const GSM_7BIT_EXTENSION_TABLE = new Map([
    [0x0A, '\f'],
    [0x14, '^'],
    [0x28, '{'],
    [0x29, '}'],
    [0x2F, '\\'],
    [0x3C, '['],
    [0x3D, '~'],
    [0x3E, ']'],
    [0x40, '|'],
    [0x65, '€']
]);

const STATUS_MAP = {
    0: 'REC UNREAD',
    1: 'REC READ',
    2: 'STO UNSENT',
    3: 'STO SENT',
    4: 'ALL'
};

function normalizeSmsText(text = '') {
    return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function hexToBytes(hex) {
    const normalized = String(hex || '').trim().replace(/\s+/g, '');
    if (!normalized || normalized.length % 2 !== 0 || !/^[0-9A-Fa-f]+$/.test(normalized)) {
        throw new Error('Invalid PDU hex');
    }
    const bytes = [];
    for (let i = 0; i < normalized.length; i += 2) {
        bytes.push(parseInt(normalized.slice(i, i + 2), 16));
    }
    return bytes;
}

function decodeSemiOctetDigits(bytes, digits) {
    let out = '';
    for (const b of bytes) {
        const low = b & 0x0F;
        const high = (b >> 4) & 0x0F;
        out += low.toString(16).toUpperCase();
        if (high !== 0x0F) out += high.toString(16).toUpperCase();
    }
    return out.slice(0, digits);
}

function decodeAddress(length, toa, bytes) {
    const ton = (toa >> 4) & 0x07;
    if (ton === 0x05) {
        // For alphanumeric originator addresses, TP-OA length is in
        // semi-octets. Convert to GSM-7 septet count.
        const septetCount = Math.floor((length * 4) / 7);
        return decodeGsm7(bytes, 0, septetCount);
    }
    const digits = decodeSemiOctetDigits(bytes, length);
    const isInternational = (toa & 0xF0) === 0x90;
    return isInternational && digits ? `+${digits}` : digits;
}

function detectEncodingFromDcs(dcs) {
    if ((dcs & 0xC0) === 0x00) {
        const alphabet = (dcs >> 2) & 0x03;
        if (alphabet === 0x00) return 'GSM7';
        if (alphabet === 0x01) return '8BIT';
        if (alphabet === 0x02) return 'UCS2';
        return 'GSM7';
    }
    if ((dcs & 0xF0) === 0xF0) {
        return (dcs & 0x04) ? '8BIT' : 'GSM7';
    }
    const alphabet = (dcs >> 2) & 0x03;
    if (alphabet === 0x02) return 'UCS2';
    if (alphabet === 0x01) return '8BIT';
    return 'GSM7';
}

function decodeSeptet(bytes, septetIndex) {
    const bitIndex = septetIndex * 7;
    const byteIndex = Math.floor(bitIndex / 8);
    const bitOffset = bitIndex % 8;
    let value = (bytes[byteIndex] >> bitOffset) & 0x7F;
    if (bitOffset > 0 && byteIndex + 1 < bytes.length) {
        value |= (bytes[byteIndex + 1] << (8 - bitOffset)) & 0x7F;
    }
    return value;
}

function decodeGsm7(bytes, startSeptet, septetCount) {
    let out = '';
    let escaped = false;

    for (let i = 0; i < septetCount; i++) {
        const code = decodeSeptet(bytes, startSeptet + i);
        if (escaped) {
            out += GSM_7BIT_EXTENSION_TABLE.get(code) || ' ';
            escaped = false;
            continue;
        }
        if (code === 0x1B) {
            escaped = true;
            continue;
        }
        out += GSM_7BIT_DEFAULT_ALPHABET[code] || ' ';
    }
    return out;
}

function decodeUcs2(bytes) {
    let out = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) {
        out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    }
    return out;
}

function decode8Bit(bytes) {
    return Buffer.from(bytes).toString('latin1');
}

function parseConcatFromUdh(udhBytes) {
    let cursor = 0;
    while (cursor + 1 < udhBytes.length) {
        const iei = udhBytes[cursor];
        const iedl = udhBytes[cursor + 1];
        const start = cursor + 2;
        const end = start + iedl;
        if (end > udhBytes.length) break;

        if (iei === 0x00 && iedl === 0x03) {
            return {
                ref: udhBytes[start],
                total: udhBytes[start + 1],
                seq: udhBytes[start + 2]
            };
        }
        if (iei === 0x08 && iedl === 0x04) {
            return {
                ref: (udhBytes[start] << 8) | udhBytes[start + 1],
                total: udhBytes[start + 2],
                seq: udhBytes[start + 3]
            };
        }
        cursor = end;
    }
    return null;
}

function decodeScts(scts) {
    if (!scts || scts.length !== 7) return null;
    const bcd = (octet) => ((octet & 0x0F) * 10) + ((octet >> 4) & 0x0F);
    const year = bcd(scts[0]);
    const month = bcd(scts[1]);
    const day = bcd(scts[2]);
    const hour = bcd(scts[3]);
    const minute = bcd(scts[4]);
    const second = bcd(scts[5]);
    const tzOctet = scts[6];
    const tzQuarters = bcd(tzOctet & 0xF7);
    const tzNegative = (tzOctet & 0x08) === 0x08;
    const offsetMinutes = (tzNegative ? -1 : 1) * tzQuarters * 15;

    if (
        month < 1 || month > 12 ||
        day < 1 || day > 31 ||
        hour > 23 || minute > 59 || second > 59
    ) return null;

    const fullYear = year >= 70 ? 1900 + year : 2000 + year;
    const utcMs = Date.UTC(fullYear, month - 1, day, hour, minute, second) - (offsetMinutes * 60_000);
    return new Date(utcMs).toISOString();
}

function parseUserData(udBytes, udl, dcs, udhi) {
    const encoding = detectEncodingFromDcs(dcs);
    let concat = null;
    let text = '';

    if (encoding === 'GSM7') {
        let headerSeptets = 0;
        if (udhi) {
            const udhl = udBytes[0] || 0;
            const headerBytes = udBytes.slice(1, 1 + udhl);
            concat = parseConcatFromUdh(headerBytes);
            headerSeptets = Math.ceil((udhl + 1) * 8 / 7);
        }
        const payloadSeptets = Math.max(0, udl - headerSeptets);
        text = decodeGsm7(udBytes, headerSeptets, payloadSeptets);
    } else {
        const octetLen = Math.min(udl, udBytes.length);
        let payload = udBytes.slice(0, octetLen);
        if (udhi && payload.length > 0) {
            const udhl = payload[0];
            const headerEnd = 1 + udhl;
            concat = parseConcatFromUdh(payload.slice(1, headerEnd));
            payload = payload.slice(headerEnd);
        }
        text = encoding === 'UCS2' ? decodeUcs2(payload) : decode8Bit(payload);
    }

    return { encoding, concat, text };
}

function parseDeliverPdu(pduHex) {
    const bytes = hexToBytes(pduHex);
    let cursor = 0;

    const smscLen = bytes[cursor++];
    cursor += smscLen;
    if (cursor >= bytes.length) throw new Error('Invalid SMS-DELIVER PDU');

    const firstOctet = bytes[cursor++];
    const mti = firstOctet & 0x03;
    const udhi = (firstOctet & 0x40) === 0x40;
    if (mti !== 0x00) throw new Error('Unsupported PDU type');

    const oaLen = bytes[cursor++];
    const oaToa = bytes[cursor++];
    const oaBytesLen = Math.ceil(oaLen / 2);
    const oaBytes = bytes.slice(cursor, cursor + oaBytesLen);
    cursor += oaBytesLen;

    const pid = bytes[cursor++];
    const dcs = bytes[cursor++];
    const scts = bytes.slice(cursor, cursor + 7);
    cursor += 7;
    const udl = bytes[cursor++];
    const udBytes = bytes.slice(cursor);

    const sender = decodeAddress(oaLen, oaToa, oaBytes) || 'Unknown';
    const timestamp = decodeScts(scts);
    const { encoding, concat, text } = parseUserData(udBytes, udl, dcs, udhi);

    return {
        sender,
        content: text,
        encoding,
        dcs,
        pid,
        concat,
        timestamp
    };
}

function splitCsv(line) {
    const fields = [];
    let current = '';
    let inQuotes = false;

    for (const ch of line) {
        if (ch === '"') {
            inQuotes = !inQuotes;
            current += ch;
            continue;
        }
        if (ch === ',' && !inQuotes) {
            fields.push(current.trim());
            current = '';
            continue;
        }
        current += ch;
    }
    fields.push(current.trim());
    return fields;
}

function normalizeStatus(statusToken) {
    const unquoted = String(statusToken || '').replace(/^"+|"+$/g, '').trim();
    if (/^\d+$/.test(unquoted)) {
        const numeric = parseInt(unquoted, 10);
        return STATUS_MAP[numeric] || unquoted;
    }
    return unquoted || 'UNKNOWN';
}

function parseCmgrPduResponse(index, response) {
    const match = /\+CMGR:\s*([^\r\n]+)[\r\n]+([0-9A-Fa-f]+)/.exec(response || '');
    if (!match) return null;

    const headerFields = splitCsv(match[1]);
    const status = normalizeStatus(headerFields[0]);
    const parsed = parseDeliverPdu(match[2]);

    return {
        index,
        status,
        ...parsed
    };
}

function parseCmglPduResponse(response) {
    const result = [];
    const regex = /\+CMGL:\s*([^\r\n]+)[\r\n]+([0-9A-Fa-f]+)/g;
    let match;

    while ((match = regex.exec(response || '')) !== null) {
        const headerFields = splitCsv(match[1]);
        const index = parseInt(headerFields[0], 10);
        const status = normalizeStatus(headerFields[1]);

        try {
            result.push({
                index: Number.isFinite(index) ? index : null,
                status,
                ...parseDeliverPdu(match[2])
            });
        } catch (err) {
            // Ignore malformed or unsupported entries and keep parsing.
        }
    }

    return result.sort((a, b) => (a.index || 0) - (b.index || 0));
}

class InboundConcatAssembler {
    constructor({ ttlMs = 120_000 } = {}) {
        this.ttlMs = ttlMs;
        this.sessions = new Map();
    }

    push(fragment, now = Date.now()) {
        if (!fragment) return null;
        const concat = fragment.concat;
        if (!concat || !Number.isInteger(concat.total) || concat.total <= 1) {
            return this.buildMessage(fragment, fragment.content || '', false, false, 1, [1]);
        }
        if (!Number.isInteger(concat.seq) || concat.seq < 1 || concat.seq > concat.total) {
            return this.buildMessage(fragment, fragment.content || '', false, false, 1, [1]);
        }

        const key = this.sessionKey(fragment);
        let session = this.sessions.get(key);
        if (!session) {
            session = {
                meta: fragment,
                firstSeen: now,
                lastSeen: now,
                parts: new Map()
            };
            this.sessions.set(key, session);
        }

        session.lastSeen = now;
        if (!session.parts.has(concat.seq)) {
            session.parts.set(concat.seq, fragment.content || '');
        }
        if (session.parts.size < concat.total) return null;

        let combined = '';
        const received = [];
        for (let seq = 1; seq <= concat.total; seq++) {
            combined += session.parts.get(seq) || '';
            if (session.parts.has(seq)) received.push(seq);
        }
        this.sessions.delete(key);
        return this.buildMessage(fragment, combined, true, false, concat.total, received);
    }

    flushExpired(now = Date.now()) {
        const expired = [];
        for (const [key, session] of this.sessions.entries()) {
            if (now - session.lastSeen < this.ttlMs) continue;

            const parts = [...session.parts.entries()].sort((a, b) => a[0] - b[0]);
            if (parts.length === 0) {
                this.sessions.delete(key);
                continue;
            }

            let combined = '';
            const received = [];
            for (const [seq, text] of parts) {
                combined += text;
                received.push(seq);
            }

            const total = session.meta.concat?.total || parts.length;
            expired.push(this.buildMessage(session.meta, combined, total > 1, true, total, received));
            this.sessions.delete(key);
        }
        return expired;
    }

    sessionKey(fragment) {
        const sender = fragment.sender || '';
        const encoding = fragment.encoding || '';
        const ref = fragment.concat?.ref;
        const total = fragment.concat?.total;
        return `${sender}|${encoding}|${ref}|${total}`;
    }

    buildMessage(fragment, content, multipart, incomplete, totalParts, receivedParts) {
        return {
            index: fragment.index,
            status: fragment.status,
            sender: fragment.sender || 'Unknown',
            content: normalizeSmsText(content || ''),
            timestamp: fragment.timestamp || new Date().toISOString(),
            encoding: fragment.encoding || 'UNKNOWN',
            multipart,
            incomplete,
            totalParts,
            receivedParts
        };
    }
}

module.exports = {
    InboundConcatAssembler,
    normalizeSmsText,
    parseCmgrPduResponse,
    parseCmglPduResponse,
    parseDeliverPdu
};
