import 'dotenv/config';

function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Не задана обязательная переменная окружения ${name} (см. .env.example)`);
  }
  return v.trim();
}

const adminIds = (process.env.ADMIN_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => Number(s));

if (adminIds.length === 0) {
  throw new Error('ADMIN_IDS пуст — укажи хотя бы один Telegram user ID (см. .env.example)');
}
if (adminIds.some((id) => !Number.isInteger(id))) {
  throw new Error('ADMIN_IDS должен содержать только числовые Telegram ID через запятую');
}

export const config = {
  botToken: required('BOT_TOKEN'),
  adminIds,
  container: (process.env.CONTAINER || 'amnezia-awg').trim(),
  endpointHost: (process.env.ENDPOINT_HOST || '').trim(),
  dns1: (process.env.DNS1 || '1.1.1.1').trim(),
  dns2: (process.env.DNS2 || '1.0.0.1').trim(),
  serverDescription: (process.env.SERVER_DESCRIPTION || 'Amnezia VPN').trim(),
  // дефолты клиентского конфига
  mtu: '1280',
  persistentKeepalive: 25,
};
