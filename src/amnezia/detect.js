import { fileExists, hasBinary } from './docker.js';

// AmneziaWG на сервере бывает в двух вариантах с разными путями/бинарями:
//   new    -> /opt/amnezia/awg/awg0.conf, интерфейс awg0, бинари awg / awg-quick
//   legacy -> /opt/amnezia/awg/wg0.conf,  интерфейс wg0,  бинари wg  / wg-quick
// Определяем по наличию awg0.conf и доступности бинарей. Кэшируем результат.
let cached = null;

export async function detectVariant() {
  if (cached) return cached;

  const newConf = '/opt/amnezia/awg/awg0.conf';
  const legacyConf = '/opt/amnezia/awg/wg0.conf';

  const isNew = await fileExists(newConf);
  const base = isNew
    ? { conf: newConf, iface: 'awg0', wg: 'awg', wgquick: 'awg-quick' }
    : { conf: legacyConf, iface: 'wg0', wg: 'wg', wgquick: 'wg-quick' };

  // Подстраховка: если предполагаемого бинаря нет, пробуем альтернативный.
  if (!(await hasBinary(base.wg)) && (await hasBinary(base.wg === 'awg' ? 'wg' : 'awg'))) {
    base.wg = base.wg === 'awg' ? 'wg' : 'awg';
    base.wgquick = base.wg === 'awg' ? 'awg-quick' : 'wg-quick';
  }

  cached = base;
  return cached;
}
