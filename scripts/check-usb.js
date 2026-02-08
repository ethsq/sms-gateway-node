const usb = require('usb');
const d = usb.findByIds(0x1e0e, 0x9001);
if (!d) { console.log('Not found'); process.exit(1); }
d.open();
for (const i of d.interfaces) {
  console.log('Iface', i.interfaceNumber, 'eps:', i.endpoints.length);
  for (const e of i.endpoints) {
    console.log('  EP 0x' + e.address.toString(16), e.direction, 'type=' + e.transferType);
  }
}
d.close();
