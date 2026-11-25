import { isIP } from 'node:net';
import { parsePort } from '../src/builders/endpoint.js';

function ipv4(value, name) {
  if (typeof value !== 'string' || isIP(value) !== 4) throw new Error(`${name}: нужен буквальный IPv4`);
  const first = Number(value.split('.')[0]);
  if (first === 0 || first === 127 || first >= 224) throw new Error(`${name}: нужен unicast IPv4`);
  return value;
}

export function validateConfig(raw) {
  if (!raw?.entry || !raw?.exit) throw new Error('Нужны секции entry и exit');
  const entry = {
    host: ipv4(raw.entry.host, 'entry.host'),
    sshPort: parsePort(raw.entry.sshPort ?? 22, 'entry.sshPort'),
    port: parsePort(raw.entry.port, 'entry.port'),
  };
  const exit = {
    host: ipv4(raw.exit.host, 'exit.host'),
    sshPort: parsePort(raw.exit.sshPort ?? 22, 'exit.sshPort'),
    container: raw.exit.container ?? 'amnezia-awg',
    botDir: raw.exit.botDir ?? '/root/amnezia-bot',
    botService: raw.exit.botService ?? 'amnezia-bot.service',
  };
  if (entry.host === exit.host) throw new Error('Вход и выход должны быть разными VPS');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(exit.container)) throw new Error('Некорректное имя контейнера');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.@-]*\.service$/.test(exit.botService)) throw new Error('Некорректное имя systemd service');
  if (typeof exit.botDir !== 'string' || !/^\/[a-zA-Z0-9_./-]+$/.test(exit.botDir)
    || exit.botDir.includes('..') || exit.botDir.endsWith('/') || exit.botDir === '/') {
    throw new Error('exit.botDir: нужен абсолютный путь без пробелов и ..');
  }
  return { entry, exit };
}

export function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function sshArgs(server, command) {
  return ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    '-p', String(server.sshPort), `root@${server.host}`, command];
}

export function renderRules(config, exitPort) {
  const { entry, exit } = validateConfig(config);
  const targetPort = parsePort(exitPort, 'опубликованный порт выхода');
  // Только один фиксированный UDP target. Ни default route, ни plaintext VPN на входе.
  // policy drop относится только к FORWARD на выделенном VPS, не к SSH/INPUT.
  return `table ip pepa_relay {
  chain prerouting {
    type nat hook prerouting priority dstnat; policy accept;
    ip daddr ${entry.host} udp dport ${entry.port} counter dnat to ${exit.host}:${targetPort}
  }
  chain postrouting {
    type nat hook postrouting priority srcnat; policy accept;
    ct status dnat ip daddr ${exit.host} udp dport ${targetPort} counter masquerade
  }
  chain forward {
    type filter hook forward priority filter; policy drop;
    ip protocol icmp ct state related ct original protocol udp ct original ip daddr ${entry.host} ct original proto-dst ${entry.port} counter accept
    ct status dnat ct original ip daddr ${entry.host} ct original proto-dst ${entry.port} ip daddr ${exit.host} udp dport ${targetPort} counter accept
    ct status dnat ct state established ct original ip daddr ${entry.host} ct original proto-dst ${entry.port} ip saddr ${exit.host} udp sport ${targetPort} counter accept
  }
}
`;
}
