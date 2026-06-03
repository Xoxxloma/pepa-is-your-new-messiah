import { detectVariant } from './detect.js';
import { exec, readFile } from './docker.js';

// Ключи параметров обфускации AmneziaWG, которые должны 1:1 копироваться
// из серверного [Interface] в клиентский конфиг (иначе бесконечный handshake).
// Порядок сохраняем как на сервере. Покрывает оба варианта (legacy без S3/S4/I*).
const OBFUSCATION_KEYS = new Set([
  'Jc', 'Jmin', 'Jmax',
  'S1', 'S2', 'S3', 'S4',
  'H1', 'H2', 'H3', 'H4',
  'I1', 'I2', 'I3', 'I4', 'I5',
]);

function parseKeyValue(line) {
  const idx = line.indexOf('=');
  if (idx === -1) return null;
  return { key: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() };
}

// Читает серверный конфиг и возвращает всё необходимое для генерации клиента.
export async function readServerConfig() {
  const variant = await detectVariant();
  const raw = await readFile(variant.conf);

  let section = null;
  let privateKey = null;
  let listenPort = null;
  let serverAddress = null;
  const obfuscation = []; // [{key, value}] в порядке появления
  const usedIps = []; // занятые IPv4 из [Peer] AllowedIPs

  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    if (line.startsWith('[') && line.endsWith(']')) {
      section = line.slice(1, -1).toLowerCase();
      continue;
    }

    const kv = parseKeyValue(line);
    if (!kv) continue;

    if (section === 'interface') {
      if (kv.key === 'PrivateKey') privateKey = kv.value;
      else if (kv.key === 'ListenPort') listenPort = kv.value;
      else if (kv.key === 'Address') serverAddress = kv.value;
      else if (OBFUSCATION_KEYS.has(kv.key)) obfuscation.push({ key: kv.key, value: kv.value });
    } else if (section === 'peer') {
      if (kv.key === 'AllowedIPs') {
        for (const part of kv.value.split(',')) {
          const ip = part.trim().split('/')[0];
          if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) usedIps.push(ip);
        }
      }
    }
  }

  if (!privateKey) {
    throw new Error(`Не удалось прочитать PrivateKey сервера из ${variant.conf}`);
  }

  // Публичный ключ сервера выводим из приватного тем же бинарём в контейнере.
  const serverPubKey = (await exec(['sh', '-c', `echo "$1" | ${variant.wg} pubkey`, '_', privateKey])).trim();

  return {
    variant,
    listenPort: listenPort || '51820',
    serverAddress, // напр. "10.8.1.1/24"
    obfuscation,
    usedIps,
    serverPubKey,
  };
}
