import { config } from '../config.js';
import { resolveEndpoint } from '../builders/endpoint.js';
import { buildClientConfig, buildServerPeerBlock } from '../builders/wgquick.js';
import { buildAmneziaConfig, encodeVpn } from '../builders/vpnLink.js';
import { peerLock } from '../util/lock.js';
import { CLIENTS_TABLE_PATH, addClient, readClientsTable, usedIpsFromTable } from './clientsTable.js';
import { backupFile, exec } from './docker.js';
import { allocateIp } from './ipalloc.js';
import { readServerConfig } from './serverConfig.js';

// Генерация ключей клиента тем же бинарём, что и на сервере.
async function generateClientKeys(wg) {
  const privKey = (await exec([wg, 'genkey'])).trim();
  const pubKey = (await exec(['sh', '-c', `echo "$1" | ${wg} pubkey`, '_', privKey])).trim();
  const psk = (await exec([wg, 'genpsk'])).trim();
  return { privKey, pubKey, psk };
}

// Применяет изменения конфига в рантайме без обрыва существующих соединений.
// `<bin> strip` печатает конфиг без управляющих полей -> сохраняем во временный
// файл -> `syncconf`. Через sh (не требует bash / process substitution).
async function applyRuntimeConfig({ wg, wgquick, iface, conf }) {
  const tmp = '/tmp/amnezia-awg-sync.conf';
  const script = `${wgquick} strip "${conf}" > "${tmp}" && ${wg} syncconf "${iface}" "${tmp}"; rc=$?; rm -f "${tmp}"; exit $rc`;
  await exec(['sh', '-c', script]);
}

// Главная операция /add. Выполняется строго по одной (мьютекс).
// clientName — уже валидированное имя клиента.
export function createPeer(clientName) {
  return peerLock.run(async () => {
    const server = await readServerConfig();
    const { host, port, endpoint } = resolveEndpoint(config.endpointHost, config.endpointPort, server.listenPort);

    const table = await readClientsTable();
    const usedIps = [...server.usedIps, ...usedIpsFromTable(table)];
    const clientIp = allocateIp(server.serverAddress, usedIps);

    // Если имя не задано — делаем уникальное по последнему октету IP,
    // чтобы файлы/записи не совпадали (client-13, client-14, …).
    const name = clientName || `client-${clientIp.split('.').pop()}`;

    const keys = await generateClientKeys(server.variant.wg);

    const clientConfigText = buildClientConfig({
      clientIp,
      clientPrivKey: keys.privKey,
      obfuscation: server.obfuscation,
      serverPubKey: server.serverPubKey,
      pskKey: keys.psk,
      endpoint,
    });

    // 0) бэкап обоих файлов ПЕРЕД любой записью — страховка для уже созданных
    //    сертификатов. Восстановление: cp <file>.bak-<ts> <file>.
    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    await backupFile(server.variant.conf, ts);
    await backupFile(CLIENTS_TABLE_PATH, ts);

    // 1) дописать [Peer] в серверный конфиг (переживёт рестарт)
    const peerBlock = buildServerPeerBlock({
      clientPubKey: keys.pubKey,
      pskKey: keys.psk,
      clientIp,
    });
    await exec(['tee', '-a', server.variant.conf], { input: peerBlock });

    // 2) зарегистрировать клиента в clientsTable (в исходном формате файла)
    await addClient(table, { clientPubKey: keys.pubKey, clientName: name, clientIp });

    // 3) применить в рантайме без обрыва соединений
    await applyRuntimeConfig(server.variant);

    // 4) собрать артефакты для шаринга
    const amneziaConfig = buildAmneziaConfig({
      hostName: host,
      port,
      obfuscation: server.obfuscation,
      clientIp,
      clientPrivKey: keys.privKey,
      clientPubKey: keys.pubKey,
      serverPubKey: server.serverPubKey,
      pskKey: keys.psk,
      clientConfigText,
      mtu: config.mtu,
      dns1: config.dns1,
      dns2: config.dns2,
      description: config.serverDescription,
    });
    const vpnLink = encodeVpn(amneziaConfig);

    return { clientName: name, clientIp, vpnLink, clientConfigText };
  });
}
