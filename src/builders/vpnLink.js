import zlib from 'node:zlib';

// === Кодирование строки vpn:// (эквивалент Qt qCompress) ===
// vpn:// + base64url( [4 байта BE = длина НЕсжатого JSON] + zlib.deflate(JSON) ), без паддинга.
export function encodeVpn(obj) {
  const raw = Buffer.from(JSON.stringify(obj), 'utf8');
  const compressed = zlib.deflateSync(raw);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(raw.length, 0);
  const payload = Buffer.concat([len, compressed]);
  return 'vpn://' + payload.toString('base64url').replace(/=+$/, '');
}

// Обратное декодирование — используется для self-check.
export function decodeVpn(str) {
  const b64 = str.replace(/^vpn:\/\//, '');
  const payload = Buffer.from(b64, 'base64url');
  const expectedLen = payload.readUInt32BE(0);
  const raw = zlib.inflateSync(payload.subarray(4));
  if (raw.length !== expectedLen) {
    throw new Error(`Длина не совпала: заявлено ${expectedLen}, получено ${raw.length}`);
  }
  return JSON.parse(raw.toString('utf8'));
}

// === Сборка Amnezia-конфига для шаринга ===
// Возвращает верхнеуровневый объект с last_config-СТРОКОЙ внутри (как делает приложение).
export function buildAmneziaConfig({
  hostName,
  port,
  obfuscation,
  clientIp,
  clientPrivKey,
  clientPubKey,
  serverPubKey,
  pskKey,
  clientConfigText,
  mtu,
  dns1,
  dns2,
  description,
}) {
  // Параметры обфускации попадают и в last_config отдельными ключами.
  const obfFields = {};
  for (const o of obfuscation) obfFields[o.key] = o.value;

  const lastConfig = {
    ...obfFields,
    client_ip: clientIp,
    client_priv_key: clientPrivKey,
    client_pub_key: clientPubKey,
    config: clientConfigText,
    hostName,
    mtu,
    port: Number(port),
    psk_key: pskKey,
    server_pub_key: serverPubKey,
  };

  return {
    containers: [
      {
        container: 'amnezia-awg',
        awg: {
          last_config: JSON.stringify(lastConfig), // ВАЖНО: строка, не объект
          port: String(port),
          transport_proto: 'udp',
        },
      },
    ],
    defaultContainer: 'amnezia-awg',
    hostName,
    description,
    dns1,
    dns2,
  };
}
