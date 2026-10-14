// 本机存储（localStorage）：存不了（无痕模式、被禁用）时安静地退回默认值
export const ls = {
  get<T>(key: string, fallback: T): T {
    try {
      const v = localStorage.getItem(key);
      return v ? (JSON.parse(v) as T) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key: string, value: unknown): void {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // 存不了就算了
    }
  },
};
