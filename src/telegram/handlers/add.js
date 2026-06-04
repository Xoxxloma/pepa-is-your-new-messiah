import { InputFile } from 'grammy';

import { createPeer } from '../../amnezia/peerManager.js';
import { buildQrPng } from '../../builders/qr.js';

// Очищает имя клиента: только [A-Za-z0-9_.-], до 32 символов.
// Если после очистки пусто — возвращает null (имя задаст peerManager по IP).
function sanitizeName(input) {
  const cleaned = (input || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 32);
  return cleaned || null;
}

export async function handleAdd(ctx) {
  // Имя из аргумента команды; если не задано — null, тогда peerManager
  // сгенерирует уникальное имя по выданному IP (client-<последний октет>).
  const clientName = sanitizeName(ctx.match);

  const notice = await ctx.reply('⏳ Создаю сертификат…');

  let result;
  try {
    result = await createPeer(clientName);
  } catch (err) {
    console.error('createPeer failed:', err);
    await ctx.reply(`❌ Не удалось создать сертификат:\n${err.message}`);
    return;
  } finally {
    // убираем «⏳ …» — необязательно, но аккуратнее
    ctx.api.deleteMessage(ctx.chat.id, notice.message_id).catch(() => {});
  }

  const { clientName: finalName, clientIp, vpnLink, clientConfigText } = result;

  // 1) строка vpn:// (моноширинно, чтобы удобно копировать)
  await ctx.reply(
    `✅ Готово: «${finalName}» (IP ${clientIp})\n\n` +
      `🔗 Строка для импорта (Amnezia → добавить → вставить ключ):\n` +
      `<code>${escapeHtml(vpnLink)}</code>`,
    { parse_mode: 'HTML' },
  );

  // 2) файл-конфиг
  await ctx.replyWithDocument(
    new InputFile(Buffer.from(clientConfigText, 'utf8'), `${finalName}.conf`),
    { caption: '📄 Файл конфигурации (.conf)' },
  );

  // 3) QR-код строки vpn://
  const qr = await buildQrPng(vpnLink);
  await ctx.replyWithPhoto(new InputFile(qr, `${finalName}.png`), {
    caption: '📷 QR-код (скан в мобильном клиенте Amnezia)',
  });
}

function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
