import { Bot } from 'grammy';

import { config } from '../config.js';
import { handleAdd } from './handlers/add.js';

export function createBot() {
  const bot = new Bot(config.botToken);
  const allowed = new Set(config.adminIds);

  // Whitelist: бот реагирует только на разрешённые Telegram ID.
  bot.use(async (ctx, next) => {
    const id = ctx.from?.id;
    if (!id || !allowed.has(id)) {
      if (ctx.chat) {
        await ctx.reply('⛔ Нет доступа.').catch(() => {});
      }
      return; // не передаём дальше
    }
    return next();
  });

  bot.command('start', (ctx) =>
    ctx.reply(
      'Привет! Я выдаю доступы AmneziaWG.\n\n' +
        'Команда:\n' +
        '/add [имя] — создать сертификат и прислать строку vpn://, файл .conf и QR-код.\n' +
        'Если имя не указать — подставлю автоматическое.',
    ),
  );

  // /add [имя]; ctx.match — текст после команды
  bot.command('add', handleAdd);

  bot.catch((err) => {
    console.error('Bot error:', err.error ?? err);
  });

  return bot;
}
