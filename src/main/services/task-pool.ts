interface QueuedTask<T> {
  task: () => Promise<T>;
  signal?: AbortSignal;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

export class TaskPool {
  private active = 0;
  private readonly queue: QueuedTask<unknown>[] = [];

  constructor(private readonly concurrency = 2) {
    if (concurrency < 1) throw new Error("concurrency 必須大於 0");
  }

  run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ task, signal, resolve, reject } as QueuedTask<unknown>);
      this.drain();
    });
  }

  private drain(): void {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const queued = this.queue.shift()!;
      if (queued.signal?.aborted) {
        queued.reject(new DOMException("工作已取消。", "AbortError"));
        continue;
      }

      this.active += 1;
      queued
        .task()
        .then(queued.resolve, queued.reject)
        .finally(() => {
          this.active -= 1;
          this.drain();
        });
    }
  }
}
