import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';

const endpointLine = /^\s*(?:export\s+)?ENDPOINT_(?:HOST|PORT)\s*=/;
export function endpointLines(text) {
  return text.split(/\r?\n/).filter((line) => endpointLine.test(line));
}

export function replaceEndpoints(text, lines) {
  const remaining = text.split(/\r?\n/).filter((line) => !endpointLine.test(line));
  while (remaining.at(-1) === '') remaining.pop();
  return [...remaining, ...lines, ''].join('\n');
}

export function publishedPort(ports, listenPort, publicIp) {
  const bindings = ports[`${listenPort}/udp`] ?? [];
  const matches = [...new Set(bindings.filter((b) => b.HostIp === '0.0.0.0' || b.HostIp === publicIp)
    .map((b) => Number(b.HostPort)))];
  if (matches.length !== 1 || !Number.isInteger(matches[0]) || matches[0] < 1 || matches[0] > 65535) {
    throw new Error('Нужен ровно один опубликованный IPv4 UDP-порт AWG на 0.0.0.0 или публичном IP выхода.');
  }
  return matches[0];
}

function run(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000 }).trim();
  } catch {
    // Не печатаем stdout/stderr произвольных команд и содержимое окружения/ключей.
    throw new Error(`Не выполнена проверка/операция ${command} ${args[0] ?? ''}. Проверь сервис на VPS.`);
  }
}

function atomicWrite(filename, content) {
  if (fs.existsSync(filename) && !fs.lstatSync(filename).isFile()) throw new Error(`${filename}: нужен обычный файл`);
  const temporary = `${filename}.pepa-${process.pid}`;
  try {
    fs.writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporary, filename);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

async function main() {
  if (process.getuid() !== 0) throw new Error('Нужен root.');
  const action = process.argv[2];
  const config = JSON.parse(process.argv[3]);
  const { entry, exit } = config;
  const envPath = path.join(exit.botDir, '.env');
  const statePath = path.join(exit.botDir, '.two-vps-state.json');
  if (!fs.lstatSync(envPath).isFile()) throw new Error('.env должен быть обычным файлом.');
  if (run('systemctl', ['show', exit.botService, '--property=WorkingDirectory', '--value']) !== exit.botDir) {
    throw new Error('WorkingDirectory сервиса не совпадает с exit.botDir.');
  }
  const envFiles = run('systemctl', ['show', exit.botService, '--property=EnvironmentFiles', '--value']);
  if (envFiles !== `${envPath} (ignore_errors=no)` && envFiles !== `${envPath} (ignore_errors=yes)`) {
    throw new Error('У сервиса должен быть один EnvironmentFile: .env в exit.botDir (как в README).');
  }
  const text = fs.readFileSync(envPath, 'utf8');
  let state = null;
  if (fs.existsSync(statePath)) {
    if (!fs.lstatSync(statePath).isFile()) throw new Error('State должен быть обычным файлом.');
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (state.owner !== 'pepa-two-vps-v1' || !Array.isArray(state.originalLines)) throw new Error('Неизвестный формат state.');
    if (JSON.stringify(endpointLines(text)) !== JSON.stringify(state.appliedLines)) {
      throw new Error('ENDPOINT_HOST/PORT изменены вручную после deploy. Сначала согласуй .env со state; автоматическая перезапись отменена.');
    }
  }

  const restart = async () => {
    run('systemctl', ['restart', exit.botService]);
    await delay(2000);
    run('systemctl', ['is-active', '--quiet', exit.botService]);
  };
  const change = async (nextText, nextState) => {
    // Сохраняем прежние endpoint до записи .env. Полный токен не попадает в state.
    if (nextState) atomicWrite(statePath, `${JSON.stringify(nextState, null, 2)}\n`);
    try {
      atomicWrite(envPath, nextText);
      await restart();
      if (!nextState && fs.existsSync(statePath)) fs.unlinkSync(statePath);
    } catch (error) {
      atomicWrite(envPath, text);
      if (state) atomicWrite(statePath, `${JSON.stringify(state, null, 2)}\n`);
      else if (fs.existsSync(statePath)) fs.unlinkSync(statePath);
      try { await restart(); } catch { console.error('Прежний .env восстановлен, но бот не запустился. Проверь journalctl на VPS.'); }
      throw error;
    }
  };

  if (action === 'restore') {
    if (!state) { console.log('У бота нет изменений two-vps для отката.'); return; }
    await change(replaceEndpoints(text, state.originalLines), null);
    console.log('Прежние ENDPOINT_HOST/PORT восстановлены, бот перезапущен.');
    return;
  }

  run('systemctl', ['is-active', '--quiet', exit.botService]);
  const requireFromBot = createRequire(path.join(exit.botDir, 'package.json'));
  const env = requireFromBot('dotenv').parse(text);
  if ((env.CONTAINER || 'amnezia-awg').trim() !== exit.container) {
    throw new Error('exit.container не совпадает с CONTAINER в .env бота.');
  }
  const runtime = JSON.parse(run('docker', ['inspect', '--format', '{{json .State.Running}}', exit.container]));
  if (!runtime) throw new Error('Контейнер AmneziaWG не запущен.');
  const networkMode = run('docker', ['inspect', '--format', '{{.HostConfig.NetworkMode}}', exit.container]);
  if (networkMode === 'host' || networkMode === 'none' || networkMode.startsWith('container:')) {
    throw new Error('Поддерживается Docker bridge с опубликованным UDP-портом.');
  }
  // Получаем только ListenPort; закрытые ключи не покидают контейнер.
  const portScript = `for file in /opt/amnezia/awg/awg0.conf /opt/amnezia/awg/wg0.conf; do
    if test -f "$file"; then awk -F= '/^[[:space:]]*ListenPort[[:space:]]*=/ {gsub(/[[:space:]]/, "", $2); print $2; exit}' "$file"; exit; fi
  done; exit 1`;
  const listenPort = Number(run('docker', ['exec', exit.container, 'sh', '-c', portScript]));
  if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) throw new Error('Не определён ListenPort AmneziaWG.');
  const ports = JSON.parse(run('docker', ['inspect', '--format', '{{json .NetworkSettings.Ports}}', exit.container]));
  const publicPort = publishedPort(ports, listenPort, exit.host);
  const botConfig = fs.readFileSync(path.join(exit.botDir, 'src/config.js'), 'utf8');
  const peerManager = fs.readFileSync(path.join(exit.botDir, 'src/amnezia/peerManager.js'), 'utf8');
  if (!botConfig.includes('endpointPort:') || !peerManager.includes('config.endpointPort')) {
    throw new Error('Сначала обнови код бота на выходном VPS до версии с ENDPOINT_PORT.');
  }
  const appliedLines = [`ENDPOINT_HOST=${entry.host}`, `ENDPOINT_PORT=${entry.port}`];
  if (action === 'verify') {
    if (!state || JSON.stringify(state.appliedLines) !== JSON.stringify(appliedLines)) {
      throw new Error('Endpoint бота не соответствует inventory или deploy ещё не применён.');
    }
  } else if (action === 'configure') {
    const nextState = { owner: 'pepa-two-vps-v1', originalLines: state?.originalLines ?? endpointLines(text), appliedLines };
    const nextText = replaceEndpoints(text, appliedLines);
    if (state && nextText === text) console.log('Endpoint бота уже настроен; перезапуск не нужен.');
    else {
      await change(nextText, nextState);
      console.log('Endpoint бота обновлён; прежние значения сохранены для --rollback.');
    }
    return;
  } else if (action !== 'probe') throw new Error('Неизвестное действие.');
  console.log(JSON.stringify({ container: exit.container, listenPort, publicPort }));
}

// При импорте локальными тестами не выполняет SSH/системные операции.
if (process.argv[1] === '-') {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
