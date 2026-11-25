#!/usr/bin/env bash
set -euo pipefail
umask 077

action=$1
entry_ip=$2
entry_port=$3
exit_ip=$4
exit_port=$5
rules_b64=$6
managed=/etc/pepa-relay
unit=/etc/systemd/system/pepa-relay.service

die() { echo "$*" >&2; exit 1; }
[[ $EUID == 0 ]] || die 'Нужен root.'
[[ -d /run/systemd/system ]] || die 'Нужен systemd.'

check_owner() {
  if [[ -e $managed ]]; then
    [[ ! -L $managed && -f $managed/owner ]] || die "$managed уже существует и не принадлежит установщику."
    [[ $(cat "$managed/owner") == pepa-two-vps-v1 ]] || die 'Неизвестный владелец relay.'
  elif [[ -e $unit ]]; then
    die "$unit уже существует и не принадлежит установщику."
  fi
}

preflight() {
  . /etc/os-release
  [[ $ID == debian || $ID == ubuntu ]] || die 'Поддерживаются Debian и Ubuntu.'
  command -v ip >/dev/null && command -v ss >/dev/null || die 'Нужен пакет iproute2.'
  command -v apt-get >/dev/null || die 'Нет apt-get.'
  ip -4 -o addr show | grep -Fq " $entry_ip/" || die 'Публичный IPv4 входа должен быть назначен интерфейсу VPS (cloud NAT не поддержан).'
  ip -4 route get "$exit_ip" >/dev/null || die 'Нет маршрута к выходу.'
  [[ -z $(ss -H -lun "sport = :$entry_port") ]] || die 'UDP-порт входа уже занят.'
  ! systemctl is-active --quiet docker.service || die 'Вход должен быть выделенным VPS без Docker.'
  ! systemctl is-active --quiet firewalld.service || die 'На входе активен firewalld; нужна отдельная машина.'
  ! systemctl is-active --quiet nftables.service || die 'На входе активен отдельный nftables.service; нужна машина без другого firewall.'
  ! systemctl is-enabled --quiet nftables.service || die 'На входе включён автозапуск другого nftables.service.'
  if command -v ufw >/dev/null; then
    ! ufw status | grep -q '^Status: active' || die 'На входе активен ufw; нужна отдельная машина.'
  fi
  if command -v nft >/dev/null; then
    local tables
    tables=$(nft list tables)
    [[ -z $(printf '%s\n' "$tables" | sed '/^table ip pepa_relay$/d; /^$/d') ]] || die 'Обнаружены чужие nftables-таблицы. Автоматическое совмещение firewall не поддерживается.'
    if [[ $tables == *'table ip pepa_relay'* && ! -f $managed/owner ]]; then
      die 'Таблица pepa_relay существует без маркера установщика.'
    fi
  fi
  # Не пропускаем legacy iptables, невидимый через nft list tables.
  for tool in iptables-save ip6tables-save; do
    if command -v "$tool" >/dev/null; then
      local saved
      saved=$("$tool")
      ! printf '%s\n' "$saved" | grep -Eq '^-A |^:[^ ]+ (DROP|REJECT)' || die 'Обнаружен существующий iptables firewall.'
    fi
  done
  if [[ ! -f $managed/owner ]]; then
    [[ $(sysctl -n net.ipv4.ip_forward) == 0 ]] || die 'Вход уже работает как маршрутизатор. Нужен выделенный VPS.'
  fi
  echo 'Preflight входа OK.'
}

check_owner
case "$action" in
  preflight)
    preflight
    ;;
  install)
    preflight
    # Пакет не должен автоматически запустить стандартный nftables.service,
    # который может загрузить /etc/nftables.conf с глобальным flush ruleset.
    (
      masked_by_us=0
      if [[ $(readlink /run/systemd/system/nftables.service 2>/dev/null || true) != /dev/null ]]; then
        systemctl mask --runtime nftables.service >&2
        masked_by_us=1
      fi
      trap 'systemctl disable nftables.service >/dev/null 2>&1 || true; if [[ $masked_by_us == 1 ]]; then systemctl unmask --runtime nftables.service >&2; fi' EXIT
      export DEBIAN_FRONTEND=noninteractive
      apt-get update >&2
      apt-get install -y --no-install-recommends nftables conntrack >&2
    )
    # Проверяем повторно: установка пакетов могла активировать сторонние правила.
    preflight
    mkdir -p "$managed"
    printf '%s\n' pepa-two-vps-v1 > "$managed/owner"
    if [[ ! -f $managed/ip-forward.before ]]; then
      sysctl -n net.ipv4.ip_forward > "$managed/ip-forward.before"
    fi
    tmp=$(mktemp -d)
    trap 'rm -f "$tmp/rules.nft" "$tmp/transaction.nft"; rmdir "$tmp"' EXIT
    printf '%s' "$rules_b64" | base64 --decode > "$tmp/rules.nft"
    if nft list table ip pepa_relay >/dev/null 2>&1; then
      printf '%s\n' 'delete table ip pepa_relay' > "$tmp/transaction.nft"
    else
      : > "$tmp/transaction.nft"
    fi
    cat "$tmp/rules.nft" >> "$tmp/transaction.nft"
    nft --check --file "$tmp/transaction.nft"
    if [[ -f $managed/rules.nft ]]; then
      cp -p "$managed/rules.nft" "$managed/rules.nft.previous"
    fi
    install -m 600 "$tmp/rules.nft" "$managed/rules.nft"
    # Удаляем только старые conntrack-записи нашего публичного endpoint.
    # Это нужно при замене выхода: старые NAT mappings иначе продолжают жить.
    if [[ -f $managed/endpoint ]]; then
      read -r old_ip old_port < "$managed/endpoint"
      conntrack -D -p udp --orig-dst "$old_ip" --dport "$old_port" >/dev/null 2>&1 || true
    fi
    printf '%s %s\n' "$entry_ip" "$entry_port" > "$managed/endpoint"
    cat > "$managed/apply.sh" <<'APPLY'
#!/usr/bin/env bash
set -euo pipefail
managed=/etc/pepa-relay
if [[ ${1:-} == stop ]]; then
  # Восстанавливаем forwarding до удаления фильтра, чтобы не открыть маршрутизацию.
  sysctl -q -w "net.ipv4.ip_forward=$(cat "$managed/ip-forward.before")"
  if nft list table ip pepa_relay >/dev/null 2>&1; then
    nft delete table ip pepa_relay
  fi
  read -r entry_ip entry_port < "$managed/endpoint"
  conntrack -D -p udp --orig-dst "$entry_ip" --dport "$entry_port" >/dev/null 2>&1 || true
  exit 0
fi
# nft применяет удаление и создание таблицы одной атомарной транзакцией.
{
  if nft list table ip pepa_relay >/dev/null 2>&1; then
    echo 'delete table ip pepa_relay'
  fi
  cat "$managed/rules.nft"
} | nft --file -
sysctl -q -w net.ipv4.ip_forward=1
APPLY
    chmod 700 "$managed/apply.sh"
    cat > "$unit" <<'UNIT'
[Unit]
Description=AmneziaWG UDP relay to a fixed foreign exit
Wants=network-online.target
After=network-online.target nftables.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/etc/pepa-relay/apply.sh
ExecReload=/etc/pepa-relay/apply.sh
ExecStop=/etc/pepa-relay/apply.sh stop

[Install]
WantedBy=multi-user.target
UNIT
    systemctl daemon-reload
    systemctl enable pepa-relay.service >&2
    systemctl reload-or-restart pepa-relay.service
    systemctl is-active --quiet pepa-relay.service
    echo 'Relay установлен. INPUT/SSH и default route не изменялись.'
    ;;
  status)
    [[ -f $managed/owner ]] || die 'Relay не установлен.'
    systemctl is-active --quiet pepa-relay.service || die 'Relay service не активен.'
    systemctl is-enabled --quiet pepa-relay.service || die 'Автозапуск relay выключен.'
    [[ $(sysctl -n net.ipv4.ip_forward) == 1 ]] || die 'IPv4 forwarding выключен.'
    expected=$(printf '%s' "$rules_b64" | base64 --decode)
    [[ $(cat "$managed/rules.nft") == "$expected" ]] || die 'Сохранённые правила отличаются от inventory или опубликованного порта Docker. Повтори --apply.'
    # -s убирает текущие значения счётчиков, -n отключает преобразование портов в имена.
    active=$(nft -s -n list table ip pepa_relay)
    printf '%s\n' "$active" | grep -Fq "dnat to $exit_ip:$exit_port" || die 'В активной таблице неверный выход.'
    printf '%s\n' "$active" | grep -Fq "ip daddr $entry_ip udp dport $entry_port" || die 'В активной таблице неверный вход.'
    printf '%s\n' "$active" | grep -Fq 'policy drop' || die 'Отсутствует FORWARD policy drop.'
    printf '%s\n' "$active"
    echo 'Проверь показанные активные правила; полноценную доступность подтверждает только клиентский handshake.'
    ;;
  remove)
    if [[ ! -f $managed/owner ]]; then echo 'Relay уже отсутствует.'; exit 0; fi
    if [[ -f $unit ]]; then systemctl disable --now pepa-relay.service >&2; fi
    # Выполняем также при inactive service: он мог упасть после загрузки части правил.
    if [[ -f $managed/apply.sh ]]; then
      bash "$managed/apply.sh" stop
    else
      # Неудачная первая установка могла остановиться до создания service.
      if [[ -f $managed/ip-forward.before ]]; then
        sysctl -q -w "net.ipv4.ip_forward=$(cat "$managed/ip-forward.before")"
      fi
      if command -v nft >/dev/null && nft list table ip pepa_relay >/dev/null 2>&1; then
        nft delete table ip pepa_relay
      fi
    fi
    rm -f "$unit"
    systemctl daemon-reload
    # Сохраняем конфиги как архив для диагностики; повторный apply их переиспользует.
    echo 'Relay отключён, forwarding восстановлен. Конфиги сохранены в /etc/pepa-relay.'
    ;;
  *) die 'Неизвестное действие.' ;;
esac
