import { readFile, writeFile } from './docker.js';

export const CLIENTS_TABLE_PATH = '/opt/amnezia/awg/clientsTable';

// Читает clientsTable. Возвращает { entries, format }.
// format: 'array' (новый) | 'object' (старый) — чтобы записать обратно в том же виде.
export async function readClientsTable() {
  let raw = '';
  try {
    raw = await readFile(CLIENTS_TABLE_PATH);
  } catch {
    // файла может не быть — это нормально для свежего сервера
    return { entries: [], format: 'array' };
  }

  const text = raw.trim();
  if (!text) return { entries: [], format: 'array' };

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // не ломаем непонятный файл — лучше упасть явно
    throw new Error('clientsTable повреждён или в неизвестном формате');
  }

  if (Array.isArray(parsed)) {
    return { entries: parsed, format: 'array' };
  }
  if (parsed && typeof parsed === 'object') {
    // старый формат: { "<clientId>": { userData: {...} }, ... }
    const entries = Object.entries(parsed).map(([clientId, value]) => ({ clientId, ...value }));
    return { entries, format: 'object' };
  }
  return { entries: [], format: 'array' };
}

// Собирает уже занятые IPv4 из userData.allowedIps (доп. защита от коллизий).
export function usedIpsFromTable(table) {
  const ips = [];
  for (const e of table.entries) {
    const allowed = e?.userData?.allowedIps;
    if (typeof allowed === 'string') {
      for (const part of allowed.split(',')) {
        const ip = part.trim().split('/')[0];
        if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) ips.push(ip);
      }
    }
  }
  return ips;
}

function isoNow() {
  // Qt ISODate: "yyyy-MM-ddTHH:mm:ss" без миллисекунд и таймзоны
  return new Date().toISOString().slice(0, 19);
}

// Добавляет запись клиента и сохраняет файл в исходном формате.
export async function addClient(table, { clientPubKey, clientName, clientIp }) {
  const userData = {
    clientName,
    creationDate: isoNow(),
    allowedIps: `${clientIp}/32`,
  };

  let out;
  if (table.format === 'object') {
    const obj = {};
    for (const e of table.entries) {
      const { clientId, ...rest } = e;
      obj[clientId] = rest;
    }
    obj[clientPubKey] = { userData };
    out = obj;
  } else {
    out = [...table.entries, { clientId: clientPubKey, userData }];
  }

  await writeFile(CLIENTS_TABLE_PATH, JSON.stringify(out, null, 4));
}
