# AmneziaWG Telegram бот (`/add`)

Telegram-бот на Node.js, который по команде **`/add`** создаёт нового клиента AmneziaWG на твоём VPS — ровно как кнопка «Поделиться» в приложении AmneziaVPN — и присылает в чат:

1. **строку `vpn://`** (вставить в Amnezia → «Добавить» → ключ);
2. **файл `.conf`** (импорт в любой WireGuard/AmneziaWG клиент);
3. **QR-код** (скан в мобильном приложении).

Бот запускается **на самом VPS**, где установлен AmneziaVPN, и работает с контейнером `amnezia-awg` через `docker exec` (SSH не нужен). Доступ к `/add` — только для перечисленных Telegram ID.

## Как это работает

При `/add` бот под мьютексом (по одной операции за раз):
1. Авто-определяет вариант AmneziaWG: `wg0.conf`/`wg` (legacy) или `awg0.conf`/`awg` (new).
2. Читает серверный `[Interface]`: ключи, порт, параметры обфускации (`Jc/Jmin/Jmax/S1/S2[/S3/S4]/H1-H4[/I1-I5]`) и занятые IP.
3. Генерирует клиентскую пару ключей и PSK (тем же бинарём в контейнере), выбирает свободный IP.
4. Дописывает `[Peer]` в серверный конфиг и запись в `clientsTable` (в исходном формате файла — чтобы клиент был виден и в приложении).
5. Применяет изменения в рантайме через `syncconf` — **без обрыва** уже подключённых клиентов.
6. Собирает строку `vpn://` (zlib + 4-байтовый префикс длины + base64url), `.conf` и QR.

Параметры обфускации **копируются с сервера дословно** (не генерируются) — иначе клиент не подключится.

## Установка на VPS

```bash
# на сервере с AmneziaVPN
git clone <repo> amnezia-bot && cd amnezia-bot
npm install
cp .env.example .env
nano .env            # заполнить BOT_TOKEN, ADMIN_IDS, ENDPOINT_HOST
```

Переменные `.env`:

| переменная | назначение |
|---|---|
| `BOT_TOKEN` | токен от [@BotFather](https://t.me/BotFather) |
| `ADMIN_IDS` | разрешённые Telegram ID через запятую (свой ID — у [@userinfobot](https://t.me/userinfobot)) |
| `ENDPOINT_HOST` | **IP или домен VPS** — попадёт в `Endpoint` клиента |
| `ENDPOINT_PORT` | публичный UDP-порт точки входа; если пусто, используется `ListenPort` AmneziaWG |
| `CONTAINER` | имя контейнера (по умолчанию `amnezia-awg`) |
| `DNS1`, `DNS2` | DNS клиента (по умолчанию 1.1.1.1 / 1.0.0.1) |
| `SERVER_DESCRIPTION` | подпись сервера в приложении |

Запуск:

```bash
npm start
```

Пользователь, под которым работает бот, должен иметь доступ к `docker` (root или группа `docker`).

### Российский вход + зарубежный выход

Можно добавить перед текущим зарубежным VPS российский UDP-ретранслятор.
Бот и AmneziaWG остаются на зарубежном сервере, а новые клиентские профили получают
российский endpoint. Весь пользовательский трафик выходит через зарубежный VPS.

После подготовки двух серверов и `deploy/two-vps.json`:

```bash
npm run deploy:two-vps              # локальный план без подключения к VPS
npm run deploy:two-vps -- --apply   # установка relay и настройка endpoint бота
npm run deploy:two-vps -- --check   # проверка конфигурации и сервисов
```

В PowerShell при блокировке `npm.ps1` используй `npm.cmd`.
Требования, подготовка SSH, перенос существующих профилей и откат описаны в
[инструкции двух VPS](deploy/README.md). Скрипт предполагает, что AmneziaWG и бот
уже работают на зарубежном VPS; установка AmneziaVPN с нуля в него не входит.

### Автозапуск (systemd)

`/etc/systemd/system/amnezia-bot.service`:

```ini
[Unit]
Description=Amnezia Telegram bot
After=network-online.target docker.service
Requires=docker.service

[Service]
WorkingDirectory=/root/amnezia-bot
ExecStart=/usr/bin/node src/index.js
Restart=always
EnvironmentFile=/root/amnezia-bot/.env

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now amnezia-bot
journalctl -u amnezia-bot -f
```

## Использование

- `/add` — создать сертификат с автоименем (`tg<твой-id>`).
- `/add Имя` — создать с заданным именем (только `A-Za-z0-9_.-`, до 32 символов).

## Безопасность существующих сертификатов

Бот спроектирован так, чтобы **не повредить уже созданные клиенты**:

- `[Peer]` **дописывается** в конец конфига (`tee -a`) — существующие peer'ы не трогаются;
- `clientsTable` читается, существующие записи сохраняются дословно, добавляется одна новая (как делает само приложение);
- IP подбирается с учётом **и** конфига, **и** `clientsTable` — без коллизий;
- `syncconf` перезагружает рантайм **без обрыва** подключённых клиентов;
- **перед каждой записью** бот делает резервные копии обоих файлов внутри контейнера:
  `…/wg0.conf.bak-<дата>` и `…/clientsTable.bak-<дата>`.

Восстановление вручную при необходимости:

```bash
docker exec amnezia-awg sh -c 'cp /opt/amnezia/awg/clientsTable.bak-<дата> /opt/amnezia/awg/clientsTable'
docker exec amnezia-awg sh -c 'cp /opt/amnezia/awg/wg0.conf.bak-<дата> /opt/amnezia/awg/wg0.conf'
```

### Сначала — проверка без записи

**До первого `/add`** запусти read-only проверку на VPS — она ничего не меняет, только показывает,
что бот корректно видит твои ~20 сертификатов, формат `clientsTable` и какой IP будет выдан:

```bash
npm run inspect
```

Убедись, что число `[Peer]` и записей в `clientsTable` соответствуют ожидаемому, формат определён,
обфускация прочитана — и только потом запускай бота.

## Проверка кодека локально

```bash
npm run check      # round-trip vpn:// (без сервера)
```

## Совместимость с приложением

Бот читает/пишет те же `wg0.conf`/`awg0.conf` и `clientsTable`, что и приложение, поэтому пользоваться можно обоими. Единственное правило — **не создавать клиента в боте и в приложении в один и тот же момент** (гонка за IP).

## Структура

```
src/
  index.js                  старт: проверка docker + запуск
  config.js                 чтение .env
  telegram/bot.js           grammY + whitelist
  telegram/handlers/add.js  обработчик /add
  amnezia/detect.js         вариант legacy/new
  amnezia/docker.js         обёртка docker exec
  amnezia/serverConfig.js   парсинг серверного [Interface]
  amnezia/ipalloc.js        выбор свободного IP
  amnezia/clientsTable.js   чтение/запись clientsTable
  amnezia/peerManager.js    оркестрация /add под мьютексом
  builders/wgquick.js       текст клиентского конфига
  builders/vpnLink.js       кодек vpn:// + сборка Amnezia JSON
  builders/qr.js            QR PNG
  util/lock.js              мьютекс
```
