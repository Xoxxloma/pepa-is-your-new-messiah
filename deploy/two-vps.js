import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { shellQuote, sshArgs, validateConfig, renderRules } from './lib.js';

function ssh(server, command, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('ssh', sshArgs(server, command), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (data) => { stdout += data; });
    child.stderr.setEncoding('utf8').on('data', (data) => { stderr += data; });
    child.stdin.on('error', () => {}); // SSH может закрыться до чтения stdin.
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) reject(new Error(`SSH ${server.host}: ${stderr.trim() || stdout.trim() || `exit ${code}`}`));
      else resolve(stdout.trim());
    });
    child.stdin.end(input);
  });
}

async function main() {
  const args = process.argv.slice(2);
  const modes = args.filter((arg) => arg.startsWith('--'));
  const paths = args.filter((arg) => !arg.startsWith('--'));
  const mode = modes[0] ?? '--plan';
  if (modes.length > 1 || paths.length > 1 || !['--plan', '--apply', '--check', '--rollback'].includes(mode)) {
    throw new Error('Использование: npm run deploy:two-vps -- [deploy/two-vps.json] [--plan|--apply|--check|--rollback]');
  }
  const config = validateConfig(JSON.parse(await readFile(paths[0] ?? 'deploy/two-vps.json', 'utf8')));
  console.log(`Вход ${config.entry.host}:${config.entry.port}/udp → AmneziaWG на ${config.exit.host}`);
  console.log(`Бот: ${config.exit.botDir}, ${config.exit.botService}; пользователи и ключи остаются на выходе.`);
  if (mode === '--plan') {
    console.log('План: проверить оба VPS → установить UDP relay на входе → обновить ENDPOINT_HOST/PORT → перезапустить бота.');
    console.log('Вход: выделенный Debian/Ubuntu с systemd, без Docker и другого firewall/forwarding.');
    console.log('Выход: уже работающие AmneziaWG в Docker bridge и бот systemd из этой версии проекта.');
    console.log('План не подключается к VPS. Для применения добавь --apply; подробности: deploy/README.md');
    return;
  }

  const entryScript = (await readFile(new URL('./remote/entry.sh', import.meta.url), 'utf8')).replaceAll('\r\n', '\n');
  const exitScript = await readFile(new URL('./remote/exit.mjs', import.meta.url), 'utf8');
  const runExit = (action) => ssh(config.exit,
    `flock -w 30 /run/lock/pepa-two-vps-bot.lock node --input-type=module - ${shellQuote(action)} ${shellQuote(JSON.stringify(config))}`, exitScript);
  const runEntry = (action, exitPort = 1) => {
    const rules = Buffer.from(renderRules(config, exitPort)).toString('base64');
    const argv = [action, config.entry.host, config.entry.port, config.exit.host, exitPort, rules].map(shellQuote).join(' ');
    return ssh(config.entry, `flock -w 30 /run/lock/pepa-two-vps-entry.lock bash -s -- ${argv}`, entryScript);
  };

  if (mode === '--rollback') {
    // Сначала вернуть выдачу прямых профилей. Ошибка восстановления не отключает relay.
    console.log(await runExit('restore'));
    console.log(await runEntry('remove'));
    console.log('Откат завершён. Уже выданные профили с адресом relay надо переключить вручную.');
    return;
  }

  console.log('Проверяю зарубежный VPS…');
  const probe = JSON.parse(await runExit(mode === '--check' ? 'verify' : 'probe'));
  console.log(`Контейнер: ${probe.container}; ListenPort=${probe.listenPort}; публичный UDP-порт=${probe.publicPort}.`);
  if (mode === '--check') {
    console.log(await runEntry('status', probe.publicPort));
    console.log('Конфигурация и сервисы проверены. Это НЕ проверка VPN: подключи клиент и проверь handshake и внешний IP.');
    return;
  }

  console.log('Проверяю российский VPS…');
  console.log(await runEntry('preflight', probe.publicPort));
  console.log('Устанавливаю relay (nftables, conntrack, systemd)…');
  console.log(await runEntry('install', probe.publicPort));
  console.log('Обновляю адрес в .env бота…');
  console.log(await runExit('configure'));
  console.log('Готово: новые /add используют российский вход. Существующие профили нужно обновить вручную.');
  console.log('Проверь клиентское подключение и внешний IP; --check проверяет только конфигурацию и сервисы.');
}

main().catch((error) => {
  console.error(error.message);
  console.error('При ошибке после установки relay проверь --check. Откат: та же команда с --rollback.');
  process.exitCode = 1;
});
