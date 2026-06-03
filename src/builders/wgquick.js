import { config } from '../config.js';

// Собирает текст клиентского конфига AmneziaWG (формат wg-quick).
// Этот же текст идёт: в .conf файл, в поле "config" внутри last_config и в QR.
// obfuscation — массив {key,value}, скопированный ДОСЛОВНО из серверного [Interface].
export function buildClientConfig({
  clientIp,
  clientPrivKey,
  obfuscation,
  serverPubKey,
  pskKey,
  endpoint,
}) {
  const obfLines = obfuscation.map((o) => `${o.key} = ${o.value}`).join('\n');

  return [
    '[Interface]',
    `Address = ${clientIp}/32`,
    `DNS = ${config.dns1}, ${config.dns2}`,
    `PrivateKey = ${clientPrivKey}`,
    obfLines,
    '',
    '[Peer]',
    `PublicKey = ${serverPubKey}`,
    `PresharedKey = ${pskKey}`,
    'AllowedIPs = 0.0.0.0/0, ::/0',
    `Endpoint = ${endpoint}`,
    `PersistentKeepalive = ${config.persistentKeepalive}`,
    '',
  ].join('\n');
}

// Блок [Peer], который дописывается в серверный конфиг.
export function buildServerPeerBlock({ clientPubKey, pskKey, clientIp }) {
  return [
    '',
    '[Peer]',
    `PublicKey = ${clientPubKey}`,
    `PresharedKey = ${pskKey}`,
    `AllowedIPs = ${clientIp}/32`,
    '',
  ].join('\n');
}
