import { detectVariant } from './amnezia/detect.js';
import { config } from './config.js';
import { createBot } from './telegram/bot.js';

async function main() {
  // Проверяем доступ к контейнеру и определяем вариант AmneziaWG заранее,
  // чтобы упасть с понятной ошибкой на старте, а не при первом /add.
  try {
    const v = await detectVariant();
    console.log(
      `AmneziaWG обнаружен: контейнер "${config.container}", ` +
        `конфиг ${v.conf}, интерфейс ${v.iface}, бинарь ${v.wg}.`,
    );
  } catch (err) {
    console.error(
      `Не удалось обратиться к контейнеру "${config.container}" через docker.\n` +
        'Проверь, что бот запущен на VPS, docker доступен и контейнер запущен (docker ps).\n' +
        (err.message || err),
    );
    process.exit(1);
  }

  const bot = createBot();

  await bot.api.setMyCommands([
    { command: 'add', description: 'Создать сертификат (vpn://, .conf, QR)' },
  ]);

  console.log('Бот запущен. Разрешённые ID:', config.adminIds.join(', '));
  await bot.start();
}

main().catch((err) => {
  console.error('Фатальная ошибка запуска:', err);
  process.exit(1);
});
