const test = require('node:test');
const assert = require('node:assert/strict');

const { InboundConcatAssembler, parseDeliverPdu } = require('./inboundSms');

const FIXED_SCTS = [0x62, 0x20, 0x90, 0x21, 0x43, 0x65, 0x00];

function toHex(bytes) {
    return bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
}

function encodeGsm7(text) {
    const septets = Array.from(text).map((ch) => ch.charCodeAt(0) & 0x7F);
    const bytes = [];
    let buffer = 0;
    let bits = 0;

    for (const septet of septets) {
        buffer |= septet << bits;
        bits += 7;
        while (bits >= 8) {
            bytes.push(buffer & 0xFF);
            buffer >>= 8;
            bits -= 8;
        }
    }
    if (bits > 0) bytes.push(buffer & 0xFF);
    return bytes;
}

function encodeAddress(sender) {
    const digits = sender.replace(/\D/g, '');
    const toa = sender.startsWith('+') ? 0x91 : 0x81;
    const nibbles = digits.length % 2 === 1 ? `${digits}F` : digits;
    const bytes = [];
    for (let i = 0; i < nibbles.length; i += 2) {
        bytes.push(parseInt(nibbles[i + 1] + nibbles[i], 16));
    }
    return { length: digits.length, toa, bytes };
}

function encodeUcs2(text) {
    const bytes = [];
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        bytes.push((code >> 8) & 0xFF, code & 0xFF);
    }
    return bytes;
}

function buildUcs2DeliverPdu({ sender, payloadBytes, concat }) {
    const addr = encodeAddress(sender);
    const firstOctet = concat ? 0x44 : 0x04; // SMS-DELIVER + UDHI(optional)

    let ud = payloadBytes;
    if (concat) {
        ud = [0x05, 0x00, 0x03, concat.ref & 0xFF, concat.total & 0xFF, concat.seq & 0xFF, ...payloadBytes];
    }

    return toHex([
        0x00, // SMSC length (use modem default)
        firstOctet,
        addr.length,
        addr.toa,
        ...addr.bytes,
        0x00, // PID
        0x08, // DCS: UCS2
        ...FIXED_SCTS,
        ud.length,
        ...ud
    ]);
}

function buildAlphanumericSenderPdu(senderId) {
    const oaBytes = encodeGsm7(senderId);
    const oaLen = Math.ceil((senderId.length * 7) / 4);

    return toHex([
        0x00, // SMSC length
        0x04, // SMS-DELIVER
        oaLen,
        0xD0, // TON=alphanumeric
        ...oaBytes,
        0x00, // PID
        0x00, // DCS GSM7
        ...FIXED_SCTS,
        0x00 // UDL
    ]);
}

function splitEvenChunks(bytes, maxChunkBytes) {
    const chunks = [];
    let cursor = 0;
    while (cursor < bytes.length) {
        let end = Math.min(cursor + maxChunkBytes, bytes.length);
        if ((end - cursor) % 2 === 1) end -= 1;
        if (end <= cursor) end = Math.min(cursor + 2, bytes.length);
        chunks.push(bytes.slice(cursor, end));
        cursor = end;
    }
    return chunks;
}

test('parses multilingual UCS2 content without mojibake', () => {
    const text = '中文測試 مرحبا Привет';
    const pdu = buildUcs2DeliverPdu({
        sender: '+61412345678',
        payloadBytes: encodeUcs2(text)
    });

    const parsed = parseDeliverPdu(pdu);
    assert.equal(parsed.sender, '+61412345678');
    assert.equal(parsed.encoding, 'UCS2');
    assert.equal(parsed.content, text);
});

test('parses alphanumeric sender ID without trailing @', () => {
    const pdu = buildAlphanumericSenderPdu('Telstra');
    const parsed = parseDeliverPdu(pdu);
    assert.equal(parsed.sender, 'Telstra');
    assert.equal(parsed.sender.includes('@'), false);
});

test('reassembles newline across segments into one message', () => {
    const fullText = '第一行\r\n第二行';
    const fullBytes = encodeUcs2(fullText);

    // Split between CR (0x000D) and LF (0x000A)
    const splitPos = fullBytes.findIndex((_, idx, arr) =>
        idx + 3 < arr.length &&
        arr[idx] === 0x00 && arr[idx + 1] === 0x0D &&
        arr[idx + 2] === 0x00 && arr[idx + 3] === 0x0A
    ) + 2;

    const part1 = fullBytes.slice(0, splitPos);
    const part2 = fullBytes.slice(splitPos);

    const parsed1 = parseDeliverPdu(buildUcs2DeliverPdu({
        sender: '+886912345678',
        payloadBytes: part1,
        concat: { ref: 0x2A, total: 2, seq: 1 }
    }));
    const parsed2 = parseDeliverPdu(buildUcs2DeliverPdu({
        sender: '+886912345678',
        payloadBytes: part2,
        concat: { ref: 0x2A, total: 2, seq: 2 }
    }));

    const assembler = new InboundConcatAssembler();
    const out1 = assembler.push({ ...parsed1, index: 1, status: 'REC UNREAD' });
    const out2 = assembler.push({ ...parsed2, index: 2, status: 'REC UNREAD' });

    assert.equal(out1, null);
    assert.ok(out2);
    assert.equal(out2.multipart, true);
    assert.equal(out2.content, '第一行\n第二行');
});

test('long concatenated content is emitted as exactly one message', () => {
    const fullText = '長內容測試-'.repeat(80);
    const bytes = encodeUcs2(fullText);
    const payloadParts = splitEvenChunks(bytes, 200);

    const parts = payloadParts.map((payloadBytes, i) => {
        const parsed = parseDeliverPdu(buildUcs2DeliverPdu({
            sender: '+61411112222',
            payloadBytes,
            concat: { ref: 0x33, total: payloadParts.length, seq: i + 1 }
        }));
        return { ...parsed, index: i + 1, status: 'REC UNREAD' };
    });

    const assembler = new InboundConcatAssembler();
    const outputs = parts
        .map((fragment) => assembler.push(fragment))
        .filter(Boolean);

    assert.equal(outputs.length, 1);
    assert.equal(outputs[0].multipart, true);
    assert.equal(outputs[0].content, fullText);
    assert.equal(assembler.flushExpired(Number.MAX_SAFE_INTEGER).length, 0);
});
