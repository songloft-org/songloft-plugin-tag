/// <reference types="@songloft/plugin-sdk" />

// ============================================================
// 结果缓存 — 24 小时本地 KV 缓存，避免重复请求
// ============================================================

const CACHE_KEY_PREFIX = 'scrape_cache_';
const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 小时

interface CacheEntry {
  data: any;
  ts: number;
  /** 原始 key（artist|title 小写），读取时校验防哈希碰撞 */
  k?: string;
}

/**
 * 简易哈希：将字符串转为稳定的短 key
 */
function hashKey(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

function rawKey(artist: string, title: string): string {
  return artist.toLowerCase() + '|' + title.toLowerCase();
}

/**
 * 从缓存读取
 */
export async function cacheGet<T>(artist: string, title: string): Promise<T | null> {
  try {
    const rk = rawKey(artist, title);
    const key = CACHE_KEY_PREFIX + hashKey(rk);
    const raw = await songloft.storage.get(key);
    if (!raw) return null;
    const entry: CacheEntry = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (Date.now() - entry.ts > CACHE_TTL) {
      await songloft.storage.delete(key);
      return null;
    }
    // 32-bit 哈希可能碰撞：校验原始 key，不一致视为 miss（旧格式无 k 字段也视为 miss，自然换血）
    if (entry.k !== rk) return null;
    return entry.data as T;
  } catch {
    return null;
  }
}

/**
 * 写入缓存
 */
export async function cacheSet(artist: string, title: string, data: any): Promise<void> {
  try {
    const rk = rawKey(artist, title);
    const key = CACHE_KEY_PREFIX + hashKey(rk);
    const entry: CacheEntry = { data, ts: Date.now(), k: rk };
    await songloft.storage.set(key, JSON.stringify(entry));
    // 注册到键列表，供 cleanup 使用
    try {
      const raw = await songloft.storage.get('cache_keys');
      let keys: string[] = [];
      if (Array.isArray(raw)) keys = raw;
      else if (typeof raw === 'string') { try { keys = JSON.parse(raw); } catch { /* ignore */ } }
      else if (raw && typeof raw === 'object') keys = Object.values(raw) as string[];
      if (!keys.includes(key)) {
        keys.push(key);
        await songloft.storage.set('cache_keys', JSON.stringify(keys));
      }
    } catch { /* ignore */ }
  } catch { /* ignore */ }
}

/**
 * 清理过期缓存（可选，调用时机：批量刮削完成时）
 */
export async function cacheCleanup(): Promise<void> {
  try {
    const all = await songloft.storage.get('cache_keys');
    const keys: string[] = Array.isArray(all) ? all : [];
    const now = Date.now();
    const alive: string[] = [];
    for (const k of keys) {
      const raw = await songloft.storage.get(k);
      if (!raw) continue;
      const entry: CacheEntry = typeof raw === 'string' ? JSON.parse(raw) : raw;
      if (now - entry.ts > CACHE_TTL) {
        await songloft.storage.delete(k);
      } else {
        alive.push(k);
      }
    }
    await songloft.storage.set('cache_keys', JSON.stringify(alive));
  } catch { /* ignore */ }
}

/** 缓存条目数 */
export async function cacheCount(): Promise<number> {
  try {
    const raw = await songloft.storage.get('cache_keys');
    let keys: string[] = [];
    if (Array.isArray(raw)) keys = raw;
    else if (typeof raw === 'string') { try { keys = JSON.parse(raw); } catch { /* ignore */ } }
    return keys.length;
  } catch { return 0; }
}

/** 清空全部缓存，返回清除条数 */
export async function cacheClear(): Promise<number> {
  try {
    const raw = await songloft.storage.get('cache_keys');
    let keys: string[] = [];
    if (Array.isArray(raw)) keys = raw;
    else if (typeof raw === 'string') { try { keys = JSON.parse(raw); } catch { /* ignore */ } }
    for (const k of keys) {
      try { await songloft.storage.delete(k); } catch { /* ignore */ }
    }
    await songloft.storage.set('cache_keys', JSON.stringify([]));
    return keys.length;
  } catch { return 0; }
}
