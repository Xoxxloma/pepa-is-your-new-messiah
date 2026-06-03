// Простой async-мьютекс: гарантирует, что операции /add выполняются строго по одной.
// Защищает от гонки за IP и одновременной записи в wg0.conf внутри бота.
export class Mutex {
  #queue = Promise.resolve();

  // Запускает fn эксклюзивно; возвращает промис с результатом fn.
  run(fn) {
    const result = this.#queue.then(() => fn());
    // следующая задача ждёт завершения текущей независимо от её исхода
    this.#queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export const peerLock = new Mutex();
