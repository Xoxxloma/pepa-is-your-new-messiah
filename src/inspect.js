// READ-ONLY проверка. Ничего не пишет и не меняет на сервере.
// Показывает, что бот видит: вариант, серверный конфиг, число peer'ов,
// формат clientsTable и какой IP будет выдан следующему клиенту.
// Запуск на VPS: npm run inspect
import { CLIENTS_TABLE_PATH, readClientsTable, usedIpsFromTable } from './amnezia/clientsTable.js';
import { detectVariant } from './amnezia/detect.js';
import { exec } from './amnezia/docker.js';
import { allocateIp } from './amnezia/ipalloc.js';
import { readServerConfig } from './amnezia/serverConfig.js';
import { config } from './config.js';
import { resolveEndpoint } from './builders/endpoint.js';

function mask(key) {
  if (!key || key.length < 12) return key;
  return `${key.slice(0, 6)}…${key.slice(-4)}`;
}

async function main() {
  console.log('=== READ-ONLY проверка (никаких изменений не вносится) ===\n');

  const variant = await detectVariant();
  console.log('Вариант AmneziaWG:');
  console.log(`  контейнер : ${config.container}`);
  console.log(`  конфиг    : ${variant.conf}`);
  console.log(`  интерфейс : ${variant.iface}`);
  console.log(`  бинарь    : ${variant.wg} / ${variant.wgquick}\n`);

  const server = await readServerConfig();
  console.log('Серверный [Interface]:');
  console.log(`  ListenPort     : ${server.listenPort}`);
  console.log(`  Address        : ${server.serverAddress}`);
  console.log(`  server pub key : ${mask(server.serverPubKey)}`);
  console.log(`  обфускация     : ${server.obfuscation.map((o) => o.key).join(', ') || '(нет)'}`);

  // Кол-во [Peer] в конфиге для сверки с clientsTable
  const peerCount = (await exec(['sh', '-c', `grep -c '^\\[Peer\\]' "$1" || true`, '_', variant.conf])).trim();
  console.log(`  [Peer] в конфиге: ${peerCount}`);
  console.log(`  занятых IP из конфига: ${server.usedIps.length}\n`);

  const table = await readClientsTable();
  const tableIps = usedIpsFromTable(table);
  console.log('clientsTable:');
  console.log(`  путь    : ${CLIENTS_TABLE_PATH}`);
  console.log(`  формат  : ${table.format} (${table.format === 'array' ? 'новый' : 'старый объектный'})`);
  console.log(`  записей : ${table.entries.length}`);
  console.log(`  IP из таблицы: ${tableIps.length}\n`);

  const allUsed = [...server.usedIps, ...tableIps];
  const nextIp = allocateIp(server.serverAddress, allUsed);
  console.log('Проверка выдачи:');
  console.log(`  следующий свободный IP: ${nextIp}`);
  console.log(`  endpoint клиента      : ${config.endpointHost
    ? resolveEndpoint(config.endpointHost, config.endpointPort, server.listenPort).endpoint
    : '(ENDPOINT_HOST не задан!)'}\n`);

  // Простая сверка целостности
  const warnings = [];
  if (!config.endpointHost) warnings.push('ENDPOINT_HOST не задан в .env — без него /add выдаст ошибку.');
  if (Number(peerCount) !== table.entries.length) {
    warnings.push(
      `Число [Peer] (${peerCount}) ≠ числу записей в clientsTable (${table.entries.length}). ` +
        'Это нормально, если часть клиентов создавалась вручную, но проверь, что это ожидаемо.',
    );
  }
  if (server.obfuscation.length === 0) {
    warnings.push('В серверном [Interface] не найдено параметров обфускации (Jc/S/H…) — это подозрительно для AmneziaWG.');
  }

  if (warnings.length) {
    console.log('⚠️  Предупреждения:');
    for (const w of warnings) console.log(`  - ${w}`);
  } else {
    console.log('✅ Всё выглядит корректно. Бот готов добавлять клиентов, не трогая существующие.');
  }
}

main().catch((err) => {
  console.error('Ошибка проверки:', err.message || err);
  process.exit(1);
});
