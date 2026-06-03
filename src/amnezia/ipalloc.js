// Выбор свободного IPv4 в подсети сервера.
// AmneziaWG по умолчанию использует /24 (напр. 10.8.1.0/24, сервер .1).
// Берём первый свободный последний октет в диапазоне 2..254.

function octets(ip) {
  return ip.split('.').map((n) => parseInt(n, 10));
}

export function allocateIp(serverAddress, usedIps) {
  // serverAddress: "10.8.1.1/24" -> префикс "10.8.1", октет сервера 1
  const serverIp = (serverAddress || '10.8.1.1/24').split('/')[0];
  const [a, b, c, serverHost] = octets(serverIp);
  const prefix = `${a}.${b}.${c}`;

  const taken = new Set([serverHost]); // сервер всегда занят
  for (const ip of usedIps) {
    const o = octets(ip);
    if (o[0] === a && o[1] === b && o[2] === c) taken.add(o[3]);
  }

  for (let host = 2; host <= 254; host += 1) {
    if (!taken.has(host)) return `${prefix}.${host}`;
  }
  throw new Error('В подсети не осталось свободных адресов (2..254 заняты)');
}
