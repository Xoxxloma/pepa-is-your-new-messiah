import { isIP } from 'node:net';

export function parsePort(value, name = 'порт') {
  const text = String(value);
  const port = Number(text);
  if (!/^\d+$/.test(text) || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name}: ожидается целое число от 1 до 65535`);
  }
  return port;
}

// Публичный порт ретранслятора может отличаться от ListenPort внутри контейнера.
export function resolveEndpoint(host, publicPort, listenPort) {
  if (!host) throw new Error('Не задан ENDPOINT_HOST — укажи IP или домен точки входа в .env.');
  const port = parsePort(publicPort || listenPort, 'ENDPOINT_PORT / ListenPort');
  const endpointHost = isIP(host) === 6 ? `[${host}]` : host;
  return { host, port, endpoint: `${endpointHost}:${port}` };
}
