// Round-trip проверка кодека vpn://: кодируем объект и тут же декодируем обратно.
// Запуск: npm run check  (или node src/builders/vpnLink.selfcheck.js)
import assert from 'node:assert/strict';

import { encodeVpn, decodeVpn } from './vpnLink.js';

const sample = {
  containers: [
    {
      container: 'amnezia-awg',
      awg: {
        last_config: JSON.stringify({ Jc: '4', H1: '1234567890', port: 51820, mtu: '1280' }),
        port: '51820',
        transport_proto: 'udp',
      },
    },
  ],
  defaultContainer: 'amnezia-awg',
  hostName: '203.0.113.10',
  description: 'Test',
  dns1: '1.1.1.1',
  dns2: '1.0.0.1',
};

const link = encodeVpn(sample);
assert.ok(link.startsWith('vpn://'), 'строка должна начинаться с vpn://');
assert.ok(!link.includes('='), 'паддинга = быть не должно');

const decoded = decodeVpn(link);
assert.deepEqual(decoded, sample, 'декодированный объект должен совпасть с исходным');

console.log('OK — vpn:// round-trip совпал. Длина строки:', link.length);
