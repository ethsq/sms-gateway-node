// Test sending multiple AT commands sequentially, like modem.js init
const usb = require('usb');
const d = usb.findByIds(0x1e0e, 0x9001);
if (!d) { console.log('Not found'); process.exit(1); }
d.open();

const iface = d.interface(2);
try { if (iface.isKernelDriverActive()) iface.detachKernelDriver(); } catch(e) {}
iface.claim();

let epIn, epOut;
for (const ep of iface.endpoints) {
  if (ep.direction === 'in' && ep.transferType === 2 && !epIn) epIn = ep;
  else if (ep.direction === 'out' && ep.transferType === 2 && !epOut) epOut = ep;
}
console.log('Bulk epIn:', '0x'+epIn.address.toString(16), 'epOut:', '0x'+epOut.address.toString(16));

// Continuous reader with configurable delay
const DELAY = parseInt(process.env.READ_DELAY || '1');
let readCount = 0, dataChunks = [];
let pendingResolve = null;
let responseBuffer = '';

function startReader() {
  const read = () => {
    epIn.transfer(512, (err, data) => {
      if (err) { console.log('Read err:', err.message); return; }
      readCount++;
      if (data && data.length > 0) {
        const text = data.toString('utf8');
        responseBuffer += text;
        if (responseBuffer.includes('OK') || responseBuffer.includes('ERROR')) {
          const resp = responseBuffer.trim();
          responseBuffer = '';
          if (pendingResolve) {
            const r = pendingResolve;
            pendingResolve = null;
            r(resp);
          }
        }
      }
      if (DELAY === 0) {
        setImmediate(read);  
      } else {
        setTimeout(read, DELAY);
      }
    });
  };
  read();
}

function sendCommand(cmd, timeout = 5000) {
  return new Promise((resolve) => {
    responseBuffer = '';
    pendingResolve = resolve;
    epOut.transfer(Buffer.from(cmd + '\r\n'), (err) => {
      if (err) { console.log('Write err:', err.message); resolve('WRITE_ERR'); }
    });
    setTimeout(() => {
      if (pendingResolve === resolve) {
        pendingResolve = null;
        resolve('TIMEOUT (reads=' + readCount + ')');
      }
    }, timeout);
  });
}

async function main() {
  startReader();
  await new Promise(r => setTimeout(r, 200));

  const cmds = [
    'AT',
    'ATE0',
    'AT+CMGF=1',
    'AT+CSCS="UCS2"',
    'AT+CSMP=17,167,0,8',
    'AT+CNMI=2,1,0,0,0',
    'AT+CPIN?',
    'AT+CSQ',
    'AT+COPS?',
  ];

  console.log(`--- READ_DELAY=${DELAY}ms ---`);
  for (const cmd of cmds) {
    const t0 = Date.now();
    const resp = await sendCommand(cmd);
    const dt = Date.now() - t0;
    const short = resp.replace(/\r?\n/g, '\\n').substring(0, 60);
    console.log(`[${dt}ms] ${cmd} => ${short}`);
    if (resp.startsWith('TIMEOUT')) {
      console.log('STOPPED: subsequent commands would also timeout');
      break;
    }
  }
  console.log(`Total reads: ${readCount}`);
  cleanup();
}

function cleanup() {
  try { iface.release(true, () => {}); } catch(e) {}
  try { d.close(); } catch(e) {}
  process.exit(0);
}

main().catch(e => { console.error(e); cleanup(); });
