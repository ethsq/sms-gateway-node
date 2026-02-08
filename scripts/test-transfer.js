const usb = require('usb');
const d = usb.findByIds(0x1e0e, 0x9001);
if (!d) { console.log('Not found'); process.exit(1); }
d.open();

const IFACE = parseInt(process.env.TEST_IFACE || '2');
console.log('Testing interface', IFACE);
const iface = d.interface(IFACE);
try { if (iface.isKernelDriverActive()) iface.detachKernelDriver(); } catch(e) {}
iface.claim();

let epIn, epOut;
for (const ep of iface.endpoints) {
  if (ep.direction === 'in' && ep.transferType === 2 && !epIn) epIn = ep;
  else if (ep.direction === 'out' && ep.transferType === 2 && !epOut) epOut = ep;
}
console.log('Bulk epIn:', epIn ? '0x'+epIn.address.toString(16) : 'none',
            'epOut:', epOut ? '0x'+epOut.address.toString(16) : 'none');
if (!epIn || !epOut) { console.log('Missing bulk eps'); process.exit(1); }

// Also poll interrupt EP if present
let epIntIn;
for (const ep of iface.endpoints) {
  if (ep.direction === 'in' && ep.transferType === 3) epIntIn = ep;
}
if (epIntIn) {
  console.log('Polling interrupt EP 0x'+epIntIn.address.toString(16));
  epIntIn.startPoll(1, 64);
  epIntIn.on('data', (buf) => console.log('INT:', buf.toString('hex')));
  epIntIn.on('error', (err) => console.log('INT err:', err.message));
}

let readCount = 0, nonEmpty = 0;
function startRead() {
  epIn.transfer(512, (err, data) => {
    readCount++;
    if (err) { console.log('Read err:', err.message); return cleanup(); }
    const len = data ? data.length : 0;
    if (len > 0) {
      nonEmpty++;
      const text = data.toString('utf8');
      console.log('DATA len='+len+': ['+text.replace(/\r?\n/g,'\\n')+']');
      if (text.includes('OK') || text.includes('ERROR')) {
        console.log('Got AT response!');
        return cleanup();
      }
    }
    setTimeout(startRead, 5);
  });
}

startRead();

setTimeout(() => {
  console.log('Sending AT... reads='+readCount);
  epOut.transfer(Buffer.from('AT\r\n'), (err) => {
    console.log(err ? 'Write err: '+err.message : 'Write OK');
  });
}, 500);

const timer = setTimeout(() => {
  console.log('TIMEOUT 6s reads='+readCount+' nonEmpty='+nonEmpty);
  cleanup();
}, 6000);

function cleanup() {
  clearTimeout(timer);
  try { if (epIntIn) epIntIn.stopPoll(); } catch(e) {}
  try { iface.release(true, () => {}); } catch(e) {}
  try { d.close(); } catch(e) {}
  process.exit(0);
}
