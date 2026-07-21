/// <reference types="@songloft/plugin-sdk" />
import { jsonResponse, createRouter, type HTTPRequest, type HTTPResponse } from '@songloft/plugin-sdk';
import { toSimplified } from './t2s';
import { scrapeSong, doScrape, writeTags, clearCover, ensureBackup, type ScrapeResult } from './scraper';
import { loadConfig, saveConfig, DEFAULT_CONFIG, searchNetease, searchQQMusic, searchKuGou, searchMiGu, searchKuWo, extractCandidates, type ScraperConfig, type SearchResult } from './sources';
import { scoreMatch } from './scoring';
import { rateLimitWait } from './ratelimit';
import { circuitStatus, circuitReset } from './circuit';
import { cacheCount, cacheClear, cacheCleanup } from './cache';
import { createSemaphore } from './semaphore';

const router = createRouter();

// ---- SSRF 防护：内网地址拦截 ----
function isBadHost(url: string): boolean {
  if (!/^https?:\/\//.test(url)) return true;
  // 支持 IPv6 方括号地址（如 http://[::1]/）
  const m = url.match(/^https?:\/\/(?:\[([^\]]+)\]|([^\/:?#]+))/);
  if (!m) return true;
  const h = (m[1] || m[2]).toLowerCase();
  if (/^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|::1|0:0:0:0:0:0:0:1|\[::1\]|\[0:0:0:0:0:0:0:1\])$/i.test(h)) return true;
  if (/^(10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+)$/.test(h)) return true;
  return false;
}

// 异步批量任务状态
const batchTasks = new Map<string, {
  ids: number[];
  current: number;
  total: number;
  results: any[];
  success: number;
  skipped: number;
  skippedIds: number[];
  failed: number;
  failedIds: number[];
  status: 'running' | 'done';
  cancelled: boolean;
}>();

// 已成功刮削的歌曲 ID 集合
// 内存缓存 + promise 链串行写：并发标记不丢（原先读改写竞态），也省掉每首歌一次全量读
let scrapedDoneCache: Set<number> | null = null;
let scrapedWriteChain: Promise<void> = Promise.resolve();

async function getScrapedDone(): Promise<Set<number>> {
  if (scrapedDoneCache) return scrapedDoneCache;
  try {
    const raw = await songloft.storage.get('scraped_done');
    let arr: number[];
    if (Array.isArray(raw)) { arr = raw; }
    else if (typeof raw === 'string') { arr = JSON.parse(raw); }
    else { arr = []; }
    scrapedDoneCache = new Set(arr.map(Number));
  } catch { scrapedDoneCache = new Set(); }
  return scrapedDoneCache;
}
function persistScrapedDone(): Promise<void> {
  scrapedWriteChain = scrapedWriteChain.then(async () => {
    try {
      if (scrapedDoneCache) await songloft.storage.set('scraped_done', [...scrapedDoneCache]);
    } catch { /* ok */ }
  });
  return scrapedWriteChain;
}
async function markScrapedDone(songId: number): Promise<void> {
  const done = await getScrapedDone();
  done.add(songId);
  await persistScrapedDone();
}
async function removeScrapedDone(songId: number): Promise<void> {
  const done = await getScrapedDone();
  done.delete(songId);
  await persistScrapedDone();
}
async function clearScrapedDone(): Promise<void> {
  scrapedDoneCache = new Set();
  scrapedWriteChain = scrapedWriteChain.then(async () => {
    try { await songloft.storage.delete('scraped_done'); } catch { /* ok */ }
  });
  await scrapedWriteChain;
}

// 埋点统计（首次安装/升级记数）
async function reportStats(): Promise<void> {
  try {
    const DEV_ID = 'plugin_stats_device_id';
    const LAST_VER = 'plugin_stats_last_ver';
    let deviceId = await songloft.storage.get(DEV_ID);
    const lastVer = await songloft.storage.get(LAST_VER);
    const currentVer = '2.3.1';
    const isNew = !deviceId;
    const isUpgrade = lastVer && lastVer !== currentVer;
    if (!isNew && !isUpgrade) return;
    if (isNew) {
      deviceId = Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      await songloft.storage.set(DEV_ID, deviceId);
    }
    await songloft.storage.set(LAST_VER, currentVer);
    // 用免费计数器 API（无需 token，GET 即计数）
    const key = isNew ? 'songloft-tag-installs' : 'songloft-tag-upgrades';
    await fetch(`https://countapi.mileshilliard.com/api/v1/hit/${key}`);
  } catch { /* 统计失败不影响功能 */ }
}

/** 安全解析请求体（Uint8Array/string → JSON） */
function parseBody(req: any): any {
  const raw = req.body;
  if (!raw) return {};
  try {
    if (typeof raw === 'string') return JSON.parse(raw);
    if (raw instanceof Uint8Array || (typeof raw === 'object' && typeof raw.length === 'number' && typeof raw[0] === 'number')) {
      return JSON.parse(new TextDecoder().decode(raw));
    }
    if (typeof raw === 'object') return raw;
  } catch {}
  return {};
}

/** 全量歌曲列表（分页拉取，突破单次 10000 上限；保险上限 100 页） */
async function listAllSongs(): Promise<any[]> {
  const all: any[] = [];
  const pageSize = 1000;
  for (let page = 0; page < 100; page++) {
    const batch = await songloft.songs.list({ limit: pageSize, offset: page * pageSize });
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < pageSize) break;
  }
  return all;
}

/** 全量本地歌曲 ID（优先宿主文档化端点 GET /songs/ids?type=local；失败回退分页过滤）
 *  刮削/整理仅支持本地歌曲（宿主 /tags 对非 local 直接 400），网络歌曲进队列只会白耗配额+永久失败 */
async function listAllSongIds(): Promise<number[]> {
  try {
    const token = await songloft.plugin.getToken();
    const hostUrl = await songloft.plugin.getHostUrl();
    const resp = await fetch(`${hostUrl}/api/v1/songs/ids?type=local`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (resp.ok) {
      const data = await resp.json();
      const ids = Array.isArray(data) ? data : (data?.ids || data?.data || []);
      if (Array.isArray(ids) && ids.length > 0) return ids.map(Number).filter(n => Number.isFinite(n));
    }
  } catch { /* 回退分页 */ }
  return (await listAllSongs())
    .filter(s => ((s as any).type || 'local') === 'local')
    .map(s => Number(s.id));
}

// ============================================================
// 静态首页重定向
// ============================================================
router.get('/', (_req) => ({
  statusCode: 302,
  headers: { 'Location': 'static/index.html' },
  body: '',
}));

// ============================================================
// 配置
// ============================================================
router.get('/config', async (_req) => {
  const config = await loadConfig();
  return jsonResponse(config);
});

router.put('/config', async (req) => {
  try {
    const updates = parseBody(req);
    const current = await loadConfig();
    const merged = { ...current, ...updates };

    // 自动推导开关：有 Key/URL 则开启，清空则关闭
    merged.enable_acoustid = !!(merged.acoustid_api_key);
    merged.enable_netease  = !!(merged.netease_api_url);
    merged.enable_qqmusic  = !!(merged.qqmusic_api_url);
    merged.enable_kugou    = !!(merged.kugou_api_url);
    merged.enable_kuwo     = !!(merged.kuwo_api_url);

    // 验证并发数和扫描间隔
    if (typeof merged.max_concurrency === 'number') {
      merged.max_concurrency = Math.max(1, Math.min(16, Math.round(merged.max_concurrency)));
    }
    if (typeof merged.auto_scan_interval === 'number') {
      merged.auto_scan_interval = Math.max(5, Math.min(1440, Math.round(merged.auto_scan_interval)));
    }
    // 评分参数范围校验
    if (typeof merged.score_threshold === 'number') {
      merged.score_threshold = Math.max(0.5, Math.min(0.9, merged.score_threshold));
    }
    if (typeof merged.title_weight === 'number') {
      merged.title_weight = Math.max(0.2, Math.min(0.8, merged.title_weight));
    }
    if (typeof merged.artist_weight === 'number') {
      merged.artist_weight = Math.max(0.2, Math.min(0.8, merged.artist_weight));
    }

    if (merged.netease_api_url && isBadHost(merged.netease_api_url)) {
      songloft.log.warn('[ssrf] 拦截内网 URL: ' + merged.netease_api_url);
      return jsonResponse({ error: 'URL 不允许：netease_api_url 指向内网地址' }, 400);
    }
    if (merged.qqmusic_api_url && isBadHost(merged.qqmusic_api_url)) {
      return jsonResponse({ error: 'URL 不允许：qqmusic_api_url 指向内网地址' }, 400);
    }
    if (merged.kugou_api_url && isBadHost(merged.kugou_api_url)) {
      return jsonResponse({ error: 'URL 不允许：kugou_api_url 指向内网地址' }, 400);
    }
    if (merged.kuwo_api_url && isBadHost(merged.kuwo_api_url)) {
      return jsonResponse({ error: 'URL 不允许：kuwo_api_url 指向内网地址' }, 400);
    }

    // 清理可能被污染的存储（防止 {status, config} 响应体被写入 config）
    delete merged['status'];
    delete merged['config'];

    await saveConfig(merged);

    // 如果自动监测配置变更，重启定时器
    if (updates.enable_auto_scan !== undefined || updates.auto_scan_interval !== undefined) {
      stopAutoScan();
      if (merged.enable_auto_scan) {
        startAutoScan();
      }
    }

    return jsonResponse({ status: 'ok', config: merged });
  } catch (e: any) {
    return jsonResponse({ error: e.message || String(e) }, 400);
  }
});

// ============================================================
// 源可连接性检测
// ============================================================
router.get('/config/status', async (_req) => {
  const cfg = await loadConfig();
  const result: Record<string, boolean> = {};
  const probes: Promise<void>[] = [];

  // AcoustID: 解析 JSON 判断 status 字段（无效 key 也返回 200）
  if (cfg.acoustid_api_key) {
    probes.push((async () => {
      try {
        const resp = await fetch(
          `https://api.acoustid.org/v2/lookup?client=${cfg.acoustid_api_key}&duration=1&fingerprint=AQAAzJg8U&meta=recordingids`
        );
        const data = await resp.json();
        // status='ok' → 正常；error.code=3(指纹无效,返回400) → key 有效
        result['acoustid'] = data?.status === 'ok' || data?.error?.code === 3;
      } catch { result['acoustid'] = false; }
    })());
  }

  // 网易云 — 连通性：检测主机是否可达（eapi 加密由搜索函数处理)
  if (cfg.enable_netease && !isBadHost(cfg.netease_api_url)) {
    probes.push((async () => {
      try {
        const m = cfg.netease_api_url.match(/^(https?:\/\/[^\/]+)/);
        const host = m ? m[1] : cfg.netease_api_url;
        const resp = await fetch(host, { headers: { 'User-Agent': 'Mozilla/5.0' } });
        result['netease'] = resp.ok;
      } catch { result['netease'] = false; }
    })());
  }

  // QQ音乐
  if (cfg.enable_qqmusic && !isBadHost(cfg.qqmusic_api_url)) {
    probes.push((async () => {
      try {
        const resp = await fetch(
          `${cfg.qqmusic_api_url}?w=test&format=json&n=1`,
          { headers: { 'Referer': 'https://y.qq.com', 'User-Agent': 'Mozilla/5.0' } }
        );
        if (!resp.ok) { result['qqmusic'] = false; return; }
        const data = await resp.json();
        result['qqmusic'] = data?.data?.song?.list !== undefined;
      } catch { result['qqmusic'] = false; }
    })());
  }

  // 酷狗
  if (cfg.enable_kugou && !isBadHost(cfg.kugou_api_url)) {
    probes.push((async () => {
      try {
        const resp = await fetch(
          `${cfg.kugou_api_url}?keyword=test&page=1&pagesize=1`,
          { headers: { 'User-Agent': 'Mozilla/5.0' } }
        );
        if (!resp.ok) { result['kugou'] = false; return; }
        const data = await resp.json();
        result['kugou'] = data?.data?.lists !== undefined;
      } catch { result['kugou'] = false; }
    })());
  }

  // 酷我（直接测 kuwo.cn）
  if (cfg.enable_kuwo) {
    probes.push((async () => {
      try {
        const resp = await fetch(
          `https://kuwo.cn/search/searchMusicBykeyWord?vipver=1&client=kt&ft=music&cluster=0&strategy=2012&encoding=utf8&rformat=json&mobi=1&pn=0&rn=1&all=test`,
          { headers: { 'Referer': 'https://kuwo.cn/', 'User-Agent': 'Mozilla/5.0' } }
        );
        if (!resp.ok) { result['kuwo'] = false; return; }
        const data = await resp.json();
        result['kuwo'] = data?.abslist !== undefined;
      } catch { result['kuwo'] = false; }
    })());
  }

  // 咪咕（公开 API，无需 URL）
  if (cfg.enable_migu) {
    probes.push((async () => {
      try {
        const resp = await fetch(
          `https://c.musicapp.migu.cn/v1.0/content/search_all.do?text=test&pageNo=1&pageSize=1&isCopyright=1&sort=1&searchSwitch=%7B%22song%22%3A1%7D`,
          { headers: { 'ua': 'Android_migu', 'version': '7.0.0', 'channel': '014021I', 'User-Agent': 'MIGU/7.0.0 (Android 12)', 'Referer': 'https://music.migu.cn/' } }
        );
        if (!resp.ok) { result['migu'] = false; return; }
        const data = await resp.json();
        result['migu'] = data?.code === '000000';
      } catch { result['migu'] = false; }
    })());
  }

  await Promise.all(probes);
  return jsonResponse(result);
});

// ============================================================
// 熔断器状态
// ============================================================
router.get('/circuit-breaker/status', async (_req) => {
  return jsonResponse(circuitStatus());
});

router.post('/circuit-breaker/reset', async (req) => {
  const body = parseBody(req);
  const source = body?.source;
  circuitReset(source);
  return jsonResponse({ ok: true, source: source || 'all' });
});

// ============================================================
// 缓存管理（缓存在插件 storage，非前端 localStorage）
// ============================================================
router.get('/cache/stats', async (_req) => {
  return jsonResponse({ count: await cacheCount() });
});

router.post('/cache/clear', async (_req) => {
  const cleared = await cacheClear();
  songloft.log.info(`[cache] 手动清除 ${cleared} 条缓存`);
  return jsonResponse({ cleared });
});

// ============================================================
// 目录整理（转发宿主文档化端点，body 为裸数组 [{id, target_path}]）
// ============================================================
router.post('/organize/preview', async (req) => {
  try {
    const body = parseBody(req);
    const items = body?.items || [];
    if (!Array.isArray(items) || items.length === 0) {
      return jsonResponse({ error: '请提供歌曲列表', changes: [] }, 400);
    }

    const token = await songloft.plugin.getToken();
    const hostUrl = await songloft.plugin.getHostUrl();
    const resp = await fetch(`${hostUrl}/api/v1/songs/organize/preview`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(items.map((it: any) => ({ id: Number(it.id), target_path: String(it.target_path || '') }))),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return jsonResponse({ error: errText.substring(0, 300), changes: [] }, resp.status);
    }

    // 宿主返回 [{id, old_path, new_path, status: ok|conflict|skip|error, error}]
    const result = await resp.json();
    return jsonResponse({ changes: Array.isArray(result) ? result : [] });
  } catch (e: any) {
    return jsonResponse({ error: e.message || String(e), changes: [] }, 500);
  }
});

router.post('/organize/execute', async (req) => {
  try {
    const body = parseBody(req);
    const items = body?.items || [];
    if (!Array.isArray(items) || items.length === 0) {
      return jsonResponse({ error: '请提供歌曲列表', results: [] }, 400);
    }

    const token = await songloft.plugin.getToken();
    const hostUrl = await songloft.plugin.getHostUrl();

    // 执行前记录 old_path（宿主 execute 响应只带 file_path，撤销历史需要原路径）
    const oldPaths: Record<number, string> = {};
    for (const it of items) {
      const id = Number(it.id);
      try {
        const song = await songloft.songs.getById(id);
        oldPaths[id] = (song as any)?.file_path || (song as any)?.filePath || '';
      } catch { oldPaths[id] = ''; }
    }

    const resp = await fetch(`${hostUrl}/api/v1/songs/organize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(items.map((it: any) => ({ id: Number(it.id), target_path: String(it.target_path || '') }))),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return jsonResponse({ error: errText.substring(0, 300), results: [] }, resp.status);
    }

    // 宿主返回 [{id, file_path, status, error}]
    const result = await resp.json();
    const arr: any[] = Array.isArray(result) ? result : [];
    const success = arr.filter((r: any) => r.status === 'ok').length;
    const failed = arr.length - success;

    // 成功项写入撤销历史（后端持有 old_path，比前端传参可靠）；撤销自身不入史
    const okItems = body?.skip_history ? [] : arr
      .filter((r: any) => r.status === 'ok')
      .map((r: any) => ({ id: r.id, old_path: oldPaths[r.id] || '', new_path: r.file_path || '' }))
      .filter((r: any) => r.old_path);
    if (okItems.length > 0) {
      try {
        const raw = await songloft.storage.get('org_history');
        let history: any[] = Array.isArray(raw) ? raw : (typeof raw === 'string' && raw ? JSON.parse(raw) : []);
        history.push({ items: okItems, time: Date.now() });
        if (history.length > 10) history = history.slice(-10);
        await songloft.storage.set('org_history', history);
      } catch { /* 历史写入失败不影响整理结果 */ }
    }

    return jsonResponse({ success, failed, results: arr });
  } catch (e: any) {
    return jsonResponse({ error: e.message || String(e), results: [] }, 500);
  }
});

// 整理撤销历史（前端无 songloft 全局，历史必须存后端）
router.get('/storage/org-history', async (_req) => {
  try {
    const raw = await songloft.storage.get('org_history');
    const arr = Array.isArray(raw) ? raw : (typeof raw === 'string' && raw ? JSON.parse(raw) : []);
    return jsonResponse(arr);
  } catch {
    return jsonResponse([]);
  }
});
router.post('/storage/org-history', async (req) => {
  try {
    const data = parseBody(req);
    await songloft.storage.set('org_history', Array.isArray(data) ? data : []);
    return jsonResponse({ ok: true });
  } catch (e: any) {
    return jsonResponse({ error: e.message || String(e) }, 500);
  }
});

// ============================================================
// 刮削
// ============================================================

// 批量任务执行器（支持并发控制）
async function runBatchTask(taskId: string, task: any, opts?: { skipCache?: boolean }): Promise<void> {
  const cfg = await loadConfig();
  const sem = createSemaphore(cfg.max_concurrency || 2);
  const total = task.ids.length;

  // 并发执行，但保持进度追踪
  let processed = 0;
  await Promise.all(task.ids.map(async (songId: number) => {
    await sem.acquire();
    try {
      if (task.cancelled) {
        songloft.log.info(`[batch] 任务 ${taskId} 已取消，跳过剩余歌曲`);
        task.skipped++;
        task.skippedIds.push(songId);
        return;
      }
      const result = await doScrape(songId, cfg, opts);
      if (!result) {
        songloft.log.info(`[batch] 跳过 songId=${songId}: 无匹配结果`);
        task.skipped++;
        task.skippedIds.push(songId);
      } else {
        const ws = await writeTags(songId, result);
        result.fileWriteStatus = ws;
        task.results.push(result);
        if (ws === 'failed') {
          task.failed++;
          task.failedIds.push(songId);
        } else {
          task.success++;
          await markScrapedDone(songId);
        }
      }
    } catch {
      task.failed++;
      task.failedIds.push(songId);
    } finally {
      processed++;
      task.current = processed;
      sem.release();
    }
  }));

  task.status = 'done';
  // 批量完成后清理过期缓存
  cacheCleanup().catch(() => {});
  // 无论前端是否轮询，10 分钟后清理任务，防内存泄漏
  setTimeout(() => batchTasks.delete(taskId), 10 * 60 * 1000);
}

// 批量刮削（异步+轮询，解决超时）
router.post('/scrape/batch', async (req) => {
  const body = parseBody(req);
  const ids: number[] = [...new Set<number>((body.ids || []).map(Number))].filter(n => Number.isFinite(n) && n > 0);
  const force: boolean = body.force === true;
  if (!ids.length) return jsonResponse({ error: '请提供歌曲 ID 列表' }, 400);

  // 过滤已成功刮削的（强制模式跳过此检查）
  let skipIds: number[] = [];
  let newIds = ids;
  if (!force) {
    const doneIds = await getScrapedDone();
    skipIds = ids.filter(id => doneIds.has(id));
    newIds = ids.filter(id => !doneIds.has(id));
  }
  songloft.log.info(`[batch] 总${ids.length}首${force?'(强制)':''}, 已刮过${skipIds.length}首跳过, 待刮${newIds.length}首`);

  const taskId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const task = {
    ids: newIds, current: 0, total: newIds.length,
    results: [] as any[], success: 0, skipped: 0, skippedIds: [] as number[],
    failed: 0, failedIds: [] as number[], status: 'running' as const,
    cancelled: false,
  };
  batchTasks.set(taskId, task);

  // 异步执行（强制模式同时绕过结果缓存）
  setTimeout(() => runBatchTask(taskId, task, { skipCache: force }), 100);

  return jsonResponse({ taskId, status: 'started', total: newIds.length, skipped: skipIds.length });
});

// 批量取消
router.post('/scrape/batch/cancel', async (req) => {
  const body = parseBody(req);
  const taskId = body.taskId;
  if (!taskId) return jsonResponse({ error: '缺少 taskId' }, 400);
  const task = batchTasks.get(taskId);
  if (!task) return jsonResponse({ error: '任务不存在' }, 404);
  task.cancelled = true;
  return jsonResponse({ ok: true, message: '任务已标记取消' });
});

// 批量进度查询
router.get('/scrape/batch/progress', async (req) => {
  const q = (req as any).query || '';
  const taskId = q.match(/taskId=([^&]+)/)?.[1];
  if (!taskId) return jsonResponse({ error: '缺少 taskId' }, 400);
  const task = batchTasks.get(taskId);
  if (!task) return jsonResponse({ error: '任务不存在' }, 404);
  const latest = task.results[task.results.length - 1];
  return jsonResponse({
    status: task.status,
    current: task.current,
    total: task.total,
    success: task.success,
    skipped: task.skipped,
    failed: task.failed,
    lastLog: latest ? `${latest.artist} - ${latest.title} | ${latest.source} | ${latest.fileWriteStatus}` : null,
    loggedCount: task.results.length + task.skippedIds.length + task.failedIds.length,
    results: task.results,
    skippedIds: task.skippedIds.length ? task.skippedIds : undefined,
    failedIds: task.failedIds.length ? task.failedIds : undefined,
  });
});

// 增量扫描：自动扫描所有未处理的歌曲
router.post('/scrape/incremental', async () => {
  try {
    const allIds = await listAllSongIds();
    const doneIds = await getScrapedDone();
    const newIds = allIds.filter(id => !doneIds.has(id));

    if (!newIds.length) return jsonResponse({ message: '没有新的歌曲需要刮削', count: 0 });

    // 复用 batch 逻辑
    const taskId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const task = {
      ids: newIds, current: 0, total: newIds.length,
      results: [] as any[], success: 0, skipped: 0, skippedIds: [] as number[],
      failed: 0, failedIds: [] as number[], status: 'running' as 'running' | 'done',
      cancelled: false,
    };
    batchTasks.set(taskId, task);

    // 异步执行
    runBatchTask(taskId, task).catch(e => {
      songloft.log.error(`[batch] 增量任务异常: ${e.message || e}`);
      task.status = 'done';
    });

    // 记录扫描时间
    await songloft.storage.set('last_scan_time', Date.now());

    return jsonResponse({ taskId, total: newIds.length, message: `增量扫描: ${newIds.length} 首新歌曲` });
  } catch (e: any) {
    return jsonResponse({ error: e.message || String(e) }, 500);
  }
});

// 单曲刮削（?force=1 绕过结果缓存）
router.post('/scrape/:id', async (req, params) => {
  const songId = parseInt(params?.id || '0', 10);
  if (!songId) return jsonResponse({ error: '无效的歌曲 ID' }, 400);
  const force = /(?:^|&)force=1(?:&|$)/.test((req as any).query || '');

  songloft.log.info(`[api] 刮削请求: songId=${songId}${force ? ' (强制)' : ''}`);
  const result = await scrapeSong(songId, undefined, { skipCache: force });
  if (!result) {
    return jsonResponse({ error: '刮削失败，无匹配结果', songId }, 404);
  }
  await markScrapedDone(songId);
  return jsonResponse(result);
});

// 清除歌曲中已嵌入的封面（解决老版本损坏封面无法覆盖的问题）
router.post('/cover/clear/:id', async (req, params) => {
  const songId = parseInt(params?.id || '0', 10);
  if (!songId) return jsonResponse({ error: '无效的歌曲 ID' }, 400);

  songloft.log.info(`[api] 清除封面: songId=${songId}`);
  const result = await clearCover(songId);
  if (result === 'failed') {
    return jsonResponse({ error: '封面清除失败', songId }, 500);
  }
  return jsonResponse({ status: 'ok', file_write: result, songId });
});

// ============================================================
// 撤销：恢复刮削写入前的原始标签快照
// ============================================================
router.post('/undo/:id', async (_req, params) => {
  const songId = parseInt(params?.id || '0', 10);
  if (!songId) return jsonResponse({ error: '无效的歌曲 ID' }, 400);

  try {
    const key = `backup_${songId}`;
    const raw = await songloft.storage.get(key);
    if (!raw || typeof raw !== 'object') {
      return jsonResponse({ error: '无可撤销的记录' }, 404);
    }
    const backup = raw as Record<string, any>;

    // 宿主 tags 语义为「非空覆盖，空值保留」：快照中为空的字段传了也不生效，
    // 直接不传（省一次无效写），并把这些字段名回报给前端提示。
    const body: Record<string, string | number> = {};
    const restored: string[] = [];
    const keptFilled: string[] = [];
    const fields: [string, string | number][] = [
      ['title', backup.title || ''],
      ['artist', backup.artist || ''],
      ['album', backup.album || ''],
      ['genre', backup.genre || ''],
      ['year', typeof backup.year === 'number' ? backup.year : 0],
      ['track', backup.track || ''],
      ['lyrics', backup.lyrics || ''],
    ];
    for (const [k, v] of fields) {
      if (v === '' || v === 0) { keptFilled.push(k); continue; }
      body[k] = v;
      restored.push(k);
    }

    if (restored.length > 0) {
      const token = await songloft.plugin.getToken();
      const hostUrl = await songloft.plugin.getHostUrl();
      const resp = await fetch(`${hostUrl}/api/v1/songs/${songId}/tags`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      if (!resp.ok) {
        const errText = await resp.text();
        return jsonResponse({ error: errText.substring(0, 200) }, resp.status);
      }
    }

    await songloft.storage.delete(key);
    await removeScrapedDone(songId);
    songloft.log.info(`[undo] songId=${songId} 已恢复 ${restored.length} 个字段` + (keptFilled.length ? `，${keptFilled.length} 个原为空的字段无法清空` : ''));
    return jsonResponse({ ok: true, restored, kept_filled: keptFilled });
  } catch (e: any) {
    return jsonResponse({ error: e.message || String(e) }, 500);
  }
});

// 单曲已刮标记增/删（校对页采纳/撤销后持久化状态）
router.post('/storage/scraped/:id', async (_req, params) => {
  const songId = parseInt(params?.id || '0', 10);
  if (!songId) return jsonResponse({ error: '无效的歌曲 ID' }, 400);
  await markScrapedDone(songId);
  return jsonResponse({ ok: true });
});
router.delete('/storage/scraped/:id', async (_req, params) => {
  const songId = parseInt(params?.id || '0', 10);
  if (!songId) return jsonResponse({ error: '无效的歌曲 ID' }, 400);
  await removeScrapedDone(songId);
  return jsonResponse({ ok: true });
});

// ============================================================
// 单曲详情（编辑页用）
// ============================================================
router.get('/song/:id', async (_req, params) => {
  try {
    const id = parseInt(params?.id || '0', 10);
    if (!id) return jsonResponse({ error: '无效 ID' }, 400);
    const token = await songloft.plugin.getToken();
    const host = await songloft.plugin.getHostUrl();
    const resp = await fetch(`${host}/api/v1/songs/${id}`, {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!resp.ok) return jsonResponse({ error: '歌曲不存在' }, 404);
    const s = await resp.json();
    let lyrics = '';
    if (s.lyric_url) {
      try {
        const lr = await fetch(`${host}${s.lyric_url}`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (lr.ok) {
          const raw = await lr.text();
          try { lyrics = JSON.parse(raw).lyric || raw; } catch { lyrics = raw; }
        }
      } catch { /* ignore */ }
    }
    // 构建带认证的封面 URL（本地 cover 用相对路径 + access_token，外链直接用）
    // 注意：宿主 CoverURLPath 返回 /api/v1/songs/{id}/cover?v=<ts> 已含查询串，须按 ?/& 拼接
    let coverUrl = '';
    if (s.cover_url) {
      if (s.cover_url.startsWith('http://') || s.cover_url.startsWith('https://')) {
        coverUrl = s.cover_url;
      } else {
        const sep = s.cover_url.includes('?') ? '&' : '?';
        coverUrl = `${s.cover_url}${sep}access_token=${token}`;
      }
    }
    return jsonResponse({
      id: s.id,
      title: s.title || '',
      artist: s.artist || '',
      album: s.album || '',
      cover_url: coverUrl,
      lyrics: lyrics,
      genre: s.genre || '',
      year: s.year || '',
      track: s.track || '',
      file_path: s.file_path || '',
    });
  } catch (e: any) {
    return jsonResponse({ error: e.message || String(e) }, 500);
  }
});

// ============================================================
// 标签写入代理（避免前端跨域）
// ============================================================
router.put('/tags/:id', async (req, params) => {
  try {
    const id = parseInt(params?.id || '0', 10);
    if (!id) return jsonResponse({ error: '无效 ID' }, 400);
    const body = parseBody(req);
    // 校对页采纳等场景带 ?snapshot=1：写入前快照原始标签，供撤销恢复
    if (/(?:^|&)snapshot=1(?:&|$)/.test((req as any).query || '')) {
      await ensureBackup(id);
    }
    // 宿主 WriteSongTagsRequest.year 为 integer，前端可能传字符串
    if (typeof body.year === 'string') {
      const y = parseInt(body.year, 10);
      body.year = isNaN(y) ? 0 : y;
    }
    const token = await songloft.plugin.getToken();
    const host = await songloft.plugin.getHostUrl();
    const resp = await fetch(`${host}/api/v1/songs/${id}/tags`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      return jsonResponse({ error: errText.substring(0, 200) }, resp.status);
    }
    const data = await resp.json();
    return jsonResponse(data);
  } catch (e: any) {
    return jsonResponse({ error: e.message || String(e) }, 500);
  }
});

// ============================================================
// 歌词写入代理（手动编辑走 lyrics 端点 + lyric_source=manual，重扫不覆盖）
// ============================================================
router.put('/lyrics/:id', async (req, params) => {
  try {
    const id = parseInt(params?.id || '0', 10);
    if (!id) return jsonResponse({ error: '无效 ID' }, 400);
    const body = parseBody(req);
    const token = await songloft.plugin.getToken();
    const host = await songloft.plugin.getHostUrl();
    const resp = await fetch(`${host}/api/v1/songs/${id}/lyrics`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        lyric: body.lyric || '',
        lyric_source: body.lyric_source || 'manual',
      }),
    });
    if (!resp.ok) {
      const errText = await resp.text();
      return jsonResponse({ error: errText.substring(0, 200) }, resp.status);
    }
    const data = await resp.json();
    return jsonResponse(data);
  } catch (e: any) {
    return jsonResponse({ error: e.message || String(e) }, 500);
  }
});

// ============================================================
// 歌曲列表（前端用）
// ============================================================
router.get('/songs', async (req) => {
  try {
    const query = req.query || '';
    const params = new URLSearchParams(query);
    const keyword = params.get('q') || '';
    const limit = parseInt(params.get('limit') || '10000', 10);
    const offset = parseInt(params.get('offset') || '0', 10);

    let songs;
    if (keyword) {
      songs = await songloft.songs.search(keyword);
    } else if (params.get('limit')) {
      songs = await songloft.songs.list({ limit, offset });
    } else {
      // 未显式指定 limit 时分页拉全量（突破单次 10000 上限）
      songs = await listAllSongs();
    }

    let token = '';
    try { token = await songloft.plugin.getToken(); } catch (e) {}

    const items = songs.map((s: any) => {
      let cUrl = (s as any).cover_url || '';
      if (cUrl && !cUrl.startsWith('http://') && !cUrl.startsWith('https://')) {
        const sep = cUrl.includes('?') ? '&' : '?';
        cUrl = `${cUrl}${sep}access_token=${token}`;
      }
      return {
        id: s.id,
        title: s.title || '',
        artist: s.artist || '',
        album: s.album || '',
        type: s.type || '',
        file_path: s.file_path || '',
        format: s.format || '',
        duration: s.duration || 0,
        cover_url: cUrl,
        // Song 模型无 lyrics 字段，lyric_url 非空即视为有歌词（健康度用）
        has_lyrics: !!(s as any).lyric_url,
        genre: (s as any).genre || '',
        year: (s as any).year || '',
        track: (s as any).track || '',
      };
    });

    return jsonResponse({ songs: items, total: items.length });
  } catch (e: any) {
    return jsonResponse({ error: e.message || String(e), songs: [] }, 500);
  }
});

// ============================================================
// 封面画廊：搜索各源封面
// ============================================================
router.get('/covers/:id', async (_req, params) => {
  const songId = parseInt(params?.id || '0', 10);
  if (!songId) return jsonResponse({ error: '无效的歌曲 ID', covers: [] }, 400);

  try {
    const song = await songloft.songs.getById(songId);
    if (!song) return jsonResponse({ error: '歌曲不存在', covers: [] }, 404);

    const cfg = await loadConfig();
    const keyword = `${song.artist || ''} ${song.title || ''}`.trim();
    if (!keyword) return jsonResponse({ covers: [] });

    const candidate = { artist: toSimplified(song.artist || ''), title: toSimplified(song.title || '') };

    // 每源保留结果的 artist/title 供评分（against 搜索结果，而非歌曲自身）
    const tasks: Promise<{ covers: { url: string; source: string; artist: string; title: string }[]; source: string }>[] = [];
    const mapCovers = (r: SearchResult[], label: string) =>
      r.filter(x => x.cover_url).map(x => ({ url: x.cover_url!, source: label, artist: x.artist || '', title: x.title || '' }));

    if (cfg.enable_netease && cfg.netease_api_url) {
      tasks.push(searchNetease(keyword, cfg.netease_api_url).then(r => ({ covers: mapCovers(r, '网易云'), source: 'netease' })));
    }
    if (cfg.enable_qqmusic && cfg.qqmusic_api_url) {
      tasks.push(searchQQMusic(keyword, cfg.qqmusic_api_url).then(r => ({ covers: mapCovers(r, 'QQ音乐'), source: 'qqmusic' })));
    }
    if (cfg.enable_kugou && cfg.kugou_api_url) {
      tasks.push(searchKuGou(keyword, cfg.kugou_api_url).then(r => ({ covers: mapCovers(r, '酷狗'), source: 'kugou' })));
    }
    if (cfg.enable_migu) {
      tasks.push(searchMiGu(keyword).then(r => ({ covers: mapCovers(r, '咪咕'), source: 'migu' })));
    }
    if (cfg.enable_kuwo) {
      tasks.push(searchKuWo(keyword).then(r => ({ covers: mapCovers(r, '酷我'), source: 'kuwo' })));
    }

    const settled = await Promise.allSettled(tasks);
    const allCovers: { url: string; source: string; score: number }[] = [];

    for (const s of settled) {
      if (s.status === 'fulfilled') {
        for (const c of s.value.covers) {
          // URL 处理：相对路径补全，外部 URL 保持原样
          let url = c.url;
          if (url.startsWith('/')) {
            const hostUrl = await songloft.plugin.getHostUrl();
            url = hostUrl + url;
            const token = await songloft.plugin.getToken();
            url += (url.includes('?') ? '&' : '?') + 'access_token=' + token;
          }
          // 对搜索结果本身评分，命中度高的封面排前
          const score = scoreMatch(candidate, { artist: c.artist, title: c.title, source: s.value.source });
          allCovers.push({ url, source: c.source, score });
        }
      }
    }

    allCovers.sort((a, b) => b.score - a.score);
    const unique: { url: string; source: string }[] = [];
    const seen = new Set<string>();
    for (const c of allCovers) {
      if (!seen.has(c.url)) {
        seen.add(c.url);
        // 过滤低分辨率封面（URL 中含小尺寸标识）
        const isLowRes = /\/100x100|\/120x120|\/150x150|\/50x50|_small|_thumb|_100\.|_120\.|_150\./i.test(c.url);
        if (!isLowRes) {
          unique.push({ url: c.url, source: c.source });
        }
      }
    }

    return jsonResponse({ covers: unique.slice(0, 12) });
  } catch (e: any) {
    return jsonResponse({ error: e.message || String(e), covers: [] }, 500);
  }
});

// ============================================================
// 预览刮削（返回真实搜索结果供 Diff 面板使用）
// ============================================================
router.get('/scrape/preview/:id', async (_req, params) => {
  const songId = parseInt(params?.id || '0', 10);
  if (!songId) return jsonResponse({ error: '无效的歌曲 ID', results: [] }, 400);

  try {
    const song = await songloft.songs.getById(songId);
    if (!song) return jsonResponse({ error: '歌曲不存在', results: [] }, 404);

    const cfg = await loadConfig();
    // 与 doScrape 一致：走 extractCandidates 清洗垃圾标签（如 "Track 01"）+ 繁简转换
    const filePath = (song as any).file_path || (song as any).filePath || '';
    const cand0 = extractCandidates(filePath, { artist: song.artist, title: song.title })[0];
    cand0.artist = toSimplified(cand0.artist);
    cand0.title = toSimplified(cand0.title);
    const keyword = `${cand0.artist} ${cand0.title}`.trim();
    if (!keyword) return jsonResponse({ results: [] });

    const candidate = { artist: cand0.artist, title: cand0.title, duration: song.duration };
    const tasks: Promise<{ results: SearchResult[]; source: string }>[] = [];

    if (cfg.enable_netease && cfg.netease_api_url) {
      tasks.push(rateLimitWait('netease').then(() => searchNetease(keyword, cfg.netease_api_url)).then(r => ({ results: r, source: '网易云' })));
    }
    if (cfg.enable_qqmusic && cfg.qqmusic_api_url) {
      tasks.push(rateLimitWait('qqmusic').then(() => searchQQMusic(keyword, cfg.qqmusic_api_url)).then(r => ({ results: r, source: 'QQ音乐' })));
    }
    if (cfg.enable_kugou && cfg.kugou_api_url) {
      tasks.push(rateLimitWait('kugou').then(() => searchKuGou(keyword, cfg.kugou_api_url)).then(r => ({ results: r, source: '酷狗' })));
    }
    if (cfg.enable_migu) {
      tasks.push(rateLimitWait('migu').then(() => searchMiGu(keyword)).then(r => ({ results: r, source: '咪咕' })));
    }
    if (cfg.enable_kuwo) {
      tasks.push(rateLimitWait('kuwo').then(() => searchKuWo(keyword)).then(r => ({ results: r, source: '酷我' })));
    }

    const settled = await Promise.allSettled(tasks);
    const allResults: { artist: string; title: string; album: string; cover_url?: string; lyrics?: string; source: string; score: number }[] = [];

    for (const s of settled) {
      if (s.status === 'fulfilled') {
        for (const r of s.value.results) {
          const sc = scoreMatch(candidate, { artist: r.artist, title: r.title, source: s.value.source, duration: r.duration });
          allResults.push({
            artist: r.artist || '',
            title: r.title || '',
            album: r.album || '',
            cover_url: r.cover_url,
            lyrics: r.lyrics,
            source: s.value.source,
            score: sc,
          });
        }
      }
    }

    allResults.sort((a, b) => b.score - a.score);
    return jsonResponse({ results: allResults.slice(0, 10) });
  } catch (e: any) {
    return jsonResponse({ error: e.message || String(e), results: [] }, 500);
  }
});

// ============================================================
// 失败记录存储
// ============================================================
router.get('/storage/failed', async (_req) => {
  try {
    const raw = await songloft.storage.get('failed_songs');
    const arr = Array.isArray(raw) ? raw : (typeof raw === 'string' && raw ? JSON.parse(raw) : []);
    return jsonResponse(arr);
  } catch {
    return jsonResponse([]);
  }
});

router.post('/storage/failed', async (req) => {
  try {
    const data = parseBody(req);
    await songloft.storage.set('failed_songs', JSON.stringify(data));
    return jsonResponse({ ok: true });
  } catch (e: any) {
    return jsonResponse({ error: e.message || String(e) }, 500);
  }
});

// 清除已刮削标记
router.get('/storage/scraped', async (_req) => {
  try {
    const done = await getScrapedDone();
    return jsonResponse([...done]);
  } catch (e: any) {
    return jsonResponse({ error: e.message || String(e) }, 500);
  }
});
router.delete('/storage/scraped', async (_req) => {
  try {
    await clearScrapedDone();
    return jsonResponse({ ok: true });
  } catch (e: any) {
    return jsonResponse({ error: e.message || String(e) }, 500);
  }
});

// ============================================================
// 手动刮削（用户输入关键词）
// ============================================================
router.post('/scrape/manual/:id', async (req, params) => {
  const songId = parseInt(params?.id || '0', 10);
  if (!songId) return jsonResponse({ error: '无效的歌曲 ID' }, 400);

  try {
    const body = parseBody(req);
    const keyword: string = body.keyword || '';
    const artist: string = body.artist || '';
    const title: string = body.title || '';
    if (!keyword) return jsonResponse({ error: '缺少关键词' }, 400);

    const { searchNetease, searchQQMusic, searchKuGou, loadConfig: lc } = await import('./sources');
    const { scoreMatch } = await import('./scoring');
    const cfg = await lc();

    const allResults: any[] = [];
    const scores: Record<string, number> = {};

    // 各源独立 try/catch：搜索函数失败会 throw，单源故障不拖垮整个手动刮削
    if (cfg.enable_netease && cfg.netease_api_url) {
      try {
        const r = await searchNetease(keyword, cfg.netease_api_url);
        r.forEach((x: any) => { x.score = scoreMatch({ artist, title }, x); });
        if (r.length) { scores['netease'] = Math.max(...r.map((x: any) => x.score)); allResults.push(...r); }
      } catch (e: any) { songloft.log.warn(`[manual] netease 搜索失败: ${e.message || e}`); }
    }
    if (cfg.enable_qqmusic && cfg.qqmusic_api_url) {
      try {
        const r = await searchQQMusic(keyword, cfg.qqmusic_api_url);
        r.forEach((x: any) => { x.score = scoreMatch({ artist, title }, x); });
        if (r.length) { scores['qqmusic'] = Math.max(...r.map((x: any) => x.score)); allResults.push(...r); }
      } catch (e: any) { songloft.log.warn(`[manual] qqmusic 搜索失败: ${e.message || e}`); }
    }
    if (cfg.enable_kugou && cfg.kugou_api_url) {
      try {
        const r = await searchKuGou(keyword, cfg.kugou_api_url);
        r.forEach((x: any) => { x.score = scoreMatch({ artist, title }, x); });
        if (r.length) { scores['kugou'] = Math.max(...r.map((x: any) => x.score)); allResults.push(...r); }
      } catch (e: any) { songloft.log.warn(`[manual] kugou 搜索失败: ${e.message || e}`); }
    }

    let best: any = null;
    let bestScore = -1;
    for (const r of allResults) { if (r.score > bestScore) { bestScore = r.score; best = r; } }

    if (!best) return jsonResponse({ error: '无匹配', songId }, 404);
    return jsonResponse({
      songId,
      artist: best.artist,
      title: best.title,
      album: best.album || '',
      genre: best.genre || '',
      year: best.year || '',
      track: best.track || '',
      cover_url: best.cover_url || '',
      source: best.source,
      score: best.score,
      sourceScores: scores,
    });
  } catch (e: any) {
    return jsonResponse({ error: e.message || String(e) }, 500);
  }
});

// ============================================================
// 生命周期
// ============================================================

// 自动监测定时器（自链式 setTimeout：上一批跑完才排下一次，批次耗时超过间隔也不会重叠执行）
let autoScanTimer: ReturnType<typeof setTimeout> | null = null;
let autoScanStopped = true;

async function startAutoScan(): Promise<void> {
  if (!autoScanStopped) return; // 已在运行
  const cfg = await loadConfig();
  if (!cfg.enable_auto_scan) return;

  const intervalMs = (cfg.auto_scan_interval || 30) * 60 * 1000;
  autoScanStopped = false;
  songloft.log.info(`[tag] 自动监测已启动，间隔 ${cfg.auto_scan_interval || 30} 分钟`);

  const tick = async () => {
    if (autoScanStopped) return;
    try {
      const allIds = await listAllSongIds();
      const doneIds = await getScrapedDone();
      const newIds = allIds.filter(id => !doneIds.has(id));
      if (newIds.length > 0) {
        songloft.log.info(`[auto-scan] 发现 ${newIds.length} 首新歌曲，开始增量扫描`);
        const taskId = 'auto-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        const task = {
          ids: newIds, current: 0, total: newIds.length,
          results: [] as any[], success: 0, skipped: 0, skippedIds: [] as number[],
          failed: 0, failedIds: [] as number[], status: 'running' as 'running' | 'done',
          cancelled: false,
        };
        batchTasks.set(taskId, task);
        await runBatchTask(taskId, task);
        songloft.log.info(`[auto-scan] 完成: 成功${task.success} 跳过${task.skipped} 失败${task.failed}`);
        batchTasks.delete(taskId);
      }
    } catch (e: any) {
      songloft.log.error(`[auto-scan] 异常: ${e.message || e}`);
    } finally {
      if (!autoScanStopped) {
        autoScanTimer = setTimeout(tick, intervalMs);
      }
    }
  };

  autoScanTimer = setTimeout(tick, intervalMs);
}

function stopAutoScan(): void {
  autoScanStopped = true;
  if (autoScanTimer !== null) {
    clearTimeout(autoScanTimer);
    autoScanTimer = null;
    songloft.log.info('[tag] 自动监测已停止');
  }
}

async function onInit(): Promise<void> {
  songloft.log.info('[tag] 标签刮削插件已启动');
  // 清理旧版残留（bin/ 下文件在 overlayfs 上会导致 AcoustID 失败）
  try {
    const files = await songloft.command.listBin();
    if (Array.isArray(files)) {
      for (const f of files) {
        try { await songloft.command.deleteBin(f); } catch { /* ok */ }
      }
    }
  } catch { /* ok */ }
  // 确保默认配置存在
  const existing = await loadConfig();
  if (!existing || Object.keys(existing).length === 0) {
    await saveConfig(DEFAULT_CONFIG);
  }
  // 启动自动监测
  startAutoScan();
  // 埋点统计（异步，不阻塞启动）
  reportStats();
}

async function onDeinit(): Promise<void> {
  stopAutoScan();
  // 标记所有批量任务为已取消
  for (const [taskId, task] of batchTasks) {
    task.cancelled = true;
  }
  batchTasks.clear();
  songloft.log.info('[tag] 标签刮削插件已卸载');
}

async function onHTTPRequest(req: HTTPRequest): Promise<HTTPResponse> {
  return router.handle(req);
}

// QuickJS 全局注入（SDK declare global 已声明签名）
globalThis.onInit = onInit;
globalThis.onDeinit = onDeinit;
globalThis.onHTTPRequest = onHTTPRequest;
