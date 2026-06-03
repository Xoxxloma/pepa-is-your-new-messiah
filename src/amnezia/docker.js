import { execFile } from 'node:child_process';

import { config } from '../config.js';

// Низкоуровневая обёртка над `docker exec`. Аргументы передаются массивом
// (никаких shell-строк), поэтому имя клиента и прочий ввод не могут привести
// к инъекции в shell.
function run(args, { input } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'docker',
      args,
      { maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          err.message = `docker ${args.join(' ')}\n${stderr || err.message}`;
          return reject(err);
        }
        resolve(stdout);
      },
    );
    if (input !== undefined) {
      child.stdin.end(input);
    }
  });
}

// Выполнить команду внутри контейнера. cmd — массив: ['cat', '/path'].
export function exec(cmd, opts) {
  return run(['exec', '-i', config.container, ...cmd], opts);
}

// Прочитать файл из контейнера.
export function readFile(path) {
  return exec(['cat', path]);
}

// Проверить существование файла. Возвращает boolean.
export async function fileExists(path) {
  const out = await exec(['sh', '-c', `test -e "$1" && echo yes || echo no`, '_', path]);
  return out.trim() === 'yes';
}

// Перезаписать файл в контейнере содержимым content.
// `tee` пишет stdin в файл, не трогая shell-парсинг пути.
export async function writeFile(path, content) {
  await exec(['tee', path], { input: content });
}

// Делает резервную копию файла внутри контейнера: <path>.bak-<suffix>.
// Если исходного файла нет — тихо пропускаем (нечего бэкапить).
export async function backupFile(path, suffix) {
  if (!(await fileExists(path))) return null;
  const dest = `${path}.bak-${suffix}`;
  await exec(['cp', '-p', path, dest]);
  return dest;
}

// Существует ли исполняемый файл (бинарь) в контейнере.
export async function hasBinary(name) {
  try {
    await exec(['sh', '-c', `command -v "$1" >/dev/null 2>&1`, '_', name]);
    return true;
  } catch {
    return false;
  }
}

// Выполнить bash-команду внутри контейнера (нужно для process substitution `<(...)`).
export function bash(script) {
  return exec(['bash', '-c', script]);
}
