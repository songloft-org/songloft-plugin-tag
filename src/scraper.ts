/// <reference types="@songloft/plugin-sdk" />

// ============================================================
// 刮削引擎 — 编排 AcoustID + 多源文本搜索 + 评分择优 + 写回
// ============================================================

import {
  searchAcoustid,
  searchNetease,
  searchQQMusic,
  searchKuGou,
  searchMiGu,
  searchKuWo,
  enrichFromChineseSources,
  extractCandidates,
  loadConfig,
  type ScraperConfig,
  type SearchResult,
} from './sources';
import { scoreMatch } from './scoring';
import { toSimplified } from './t2s';
import { cacheGet, cacheSet } from './cache';
import { rateLimitWait } from './ratelimit';
import { circuitFailure, circuitSuccess, circuitIsOpen } from './circuit';

export interface ScrapeResult {
  songId: number;
  artist: string;
  title: string;
  album: string;
  genre?: string;
  year?: string;
  track?: string;
  lyrics?: string;
  cover_url?: string;
  cover_data?: string;  // base64
  source: string;
  score: number;
  fileWriteStatus?: string;
  /** 各源得分明细 */
  sourceScores?: Record<string, number>;
}

/**
 * 单曲刮削（写入模式）
 */
export async function scrapeSong(songId: number, config?: ScraperConfig, opts?: { skipCache?: boolean }): Promise<ScrapeResult | null> {
  const cfg = config || await loadConfig();
  const result = await doScrape(songId, cfg, opts);
  if (!result) return null;

  // 写回标签
  const writeResult = await writeTags(songId, result);
  result.fileWriteStatus = writeResult;
  return result;
}

// ============================================================
// 内部实现
// ============================================================

export async function doScrape(songId: number, cfg: ScraperConfig, opts?: { skipCache?: boolean }): Promise<ScrapeResult | null> {
  // 1. 获取歌曲信息
  const song = await songloft.songs.getById(songId);
  if (!song) {
    songloft.log.warn(`[scraper] 歌曲不存在: ${songId}`);
    return null;
  }

  // 仅支持本地歌曲：宿主 /tags 对非 local 类型直接 400，搜了也写不进去（批量中计为跳过）
  const songType = (song as any).type || 'local';
  if (songType !== 'local') {
    songloft.log.info(`[scraper] 跳过非本地歌曲: songId=${songId} (type=${songType})`);
    return null;
  }

  // SDK 类型声明为 filePath，但运行时桥接返回 file_path（与宿主 JSON 一致），两者兜底
  const filePath = (song as any).file_path || (song as any).filePath || '';
  const candidates = extractCandidates(filePath, { artist: song.artist, title: song.title });

  // 繁体→简体，提高国内音源匹配率
  for (const c of candidates) {
    c.artist = toSimplified(c.artist);
    c.title = toSimplified(c.title);
  }

  const candidate = candidates[0];

  if (!candidate.title) {
    songloft.log.warn(`[scraper] 无法确定搜索关键词: ${songId}`);
    return null;
  }

  // 缓存字段辅助：entry 带 enriched 标记，避免「源本来就没有 genre」时每次命中都重跑 enrich
  const toCacheEntry = (r: { artist: string; title: string; album: string; cover_url?: string; lyrics?: string; genre?: string; year?: string; track?: string; source: string; score: number }) => ({
    artist: r.artist, title: r.title, album: r.album,
    cover_url: r.cover_url, lyrics: r.lyrics,
    genre: r.genre || '', year: r.year || '', track: r.track || '',
    source: r.source, score: r.score,
    enriched: true,
  });

  // 检查缓存（强制刮削跳过读取，但仍会写入覆盖旧缓存）
  if (!opts?.skipCache) {
    const cached = await cacheGet<SearchResult & { enriched?: boolean }>(candidate.artist, candidate.title);
    if (cached && cached.score >= cfg.score_threshold) {
      songloft.log.info(`[scraper] 缓存命中: ${cached.artist} - ${cached.title} (${cached.score.toFixed(2)})`);
      // 旧缓存（无 enriched 标记）补跑一次 enrich 并回写，此后命中不再重复请求
      if (!cached.enriched) {
        const enrich = await enrichFromChineseSources(cached.artist, cached.title, candidate, cfg);
        if (enrich.genre) cached.genre = enrich.genre;
        if (enrich.year) cached.year = enrich.year;
        if (enrich.track) cached.track = enrich.track;
        if (enrich.cover_url && !cached.cover_url) cached.cover_url = enrich.cover_url;
        if (enrich.lyrics && !cached.lyrics) cached.lyrics = enrich.lyrics;
        await cacheSet(candidate.artist, candidate.title, toCacheEntry(cached));
      }
      return buildResult(songId, cached, candidate, {});
    }
  }

  // 2. 声纹优先（指纹与候选关键词无关，只查一次，不进候选循环）
  if (!cfg.enable_acoustid) {
    songloft.log.info(`[scraper] AcoustID 未启用 (cfg.enable_acoustid=${cfg.enable_acoustid})`);
  } else if (!song.fingerprint) {
    songloft.log.info(`[scraper] AcoustID 跳过: 歌曲无指纹 (主程序扫描后异步计算，请稍后重试)`);
  } else {
    await rateLimitWait('acoustid');
    const acoustidResults = await searchAcoustid(song.fingerprint, song.fingerprint_duration || song.duration || 0, cfg.acoustid_api_key);
    if (acoustidResults.length > 0) {
      const best = acoustidResults.reduce((a, b) => a.score > b.score ? a : b);
      if (best.score > cfg.score_threshold) {
        songloft.log.info(`[scraper] 声纹匹配成功: ${best.artist} - ${best.title} (${best.score.toFixed(2)})`);

        best.artist = toSimplified(best.artist);
        best.title = toSimplified(best.title);
        best.album = toSimplified(best.album);

        const enrich = await enrichFromChineseSources(best.artist, best.title, candidate, cfg);
        if (enrich.cover_url) {
          best.cover_url = enrich.cover_url;
          songloft.log.info(`[scraper] 封面来自 ${enrich.source}: ${enrich.cover_url.substring(0, 60)}...`);
        }
        if (enrich.lyrics) best.lyrics = enrich.lyrics;
        if (enrich.genre) best.genre = enrich.genre;
        if (enrich.year) best.year = enrich.year;
        if (enrich.track) best.track = enrich.track;

        const result = buildResult(songId, best, candidate, {});
        await cacheSet(candidate.artist, candidate.title, toCacheEntry(result));
        return result;
      }
    }
  }

  // 3. 文本搜索兜底（多源并发）：先用第一个候选词搜索，若得分不佳且有反向候选则重试
  let bestResult: ScrapeResult | null = null;
  let bestScore = -1;

  for (let ci = 0; ci < candidates.length; ci++) {
    const c = candidates[ci];
    const keyword = `${c.artist} ${c.title}`.trim();
    songloft.log.info(`[scraper] 开始刮削: ${keyword} (songId=${songId}${ci > 0 ? ', 反向排序' : ''})`);

    const sourceScores: Record<string, number> = {};
    const allResults: SearchResult[] = [];

    const addSourceResults = (results: SearchResult[], sourceName: string) => {
      let srcBestScore = 0;
      for (const r of results) {
        const s = scoreMatch({ ...c, duration: song.duration }, r);
        r.score = s;
        if (s > srcBestScore) srcBestScore = s;
      }
      sourceScores[sourceName] = srcBestScore;
      allResults.push(...results);
    };

    const tasks: Promise<{ results: SearchResult[]; source: string }>[] = [];

    const searchWithCircuit = async (fn: (kw: string, url: string) => Promise<SearchResult[]>, url: string, source: string) => {
      if (circuitIsOpen(source)) {
        songloft.log.info(`[scraper] ${source} 熔断中，跳过`);
        return { results: [], source };
      }
      try {
        await rateLimitWait(source);
        const r = await fn(keyword, url);
        circuitSuccess(source);
        return { results: r, source };
      } catch (e) {
        circuitFailure(source);
        throw e;
      }
    };

    if (cfg.enable_netease && cfg.netease_api_url) {
      tasks.push(searchWithCircuit(searchNetease, cfg.netease_api_url, 'netease'));
    }
    if (cfg.enable_qqmusic && cfg.qqmusic_api_url) {
      tasks.push(searchWithCircuit(searchQQMusic, cfg.qqmusic_api_url, 'qqmusic'));
    }
    if (cfg.enable_kugou && cfg.kugou_api_url) {
      tasks.push(searchWithCircuit(searchKuGou, cfg.kugou_api_url, 'kugou'));
    }
    if (cfg.enable_migu) {
      tasks.push(searchWithCircuit(searchMiGu, '', 'migu'));
    }
    if (cfg.enable_kuwo) {
      tasks.push(searchWithCircuit(searchKuWo, '', 'kuwo'));
    }

    const settled = await Promise.allSettled(tasks);
    for (const s of settled) {
      if (s.status === 'fulfilled') {
        addSourceResults(s.value.results, s.value.source);
      }
    }

    const logParts = Object.entries(sourceScores).map(([k, v]) => `${k}=${v.toFixed(2)}`);
    songloft.log.info(`[scraper] 文本刮削得分: ${logParts.join(', ') || '无结果'}`);

    // 选择本轮最佳
    let roundBest: SearchResult | null = null;
    let roundBestScore = -1;
    for (const r of allResults) {
      if (r.score > roundBestScore) {
        roundBestScore = r.score;
        roundBest = r;
      }
    }

    if (roundBest && roundBestScore > bestScore) {
      bestScore = roundBestScore;
      bestResult = buildResult(songId, roundBest, c, sourceScores);
    }

    // 首轮得分已够好，不再尝试反向排序
    if (bestScore >= cfg.score_threshold) break;
  }

  if (!bestResult || bestScore < cfg.score_threshold) {
    songloft.log.info(`[scraper] 最佳得分 ${bestScore.toFixed(2)} 低于阈值 ${cfg.score_threshold}，刮削失败`);
    return null;
  }

  // 写入缓存（文本搜索结果自带 genre/year/track，视为已补全）
  await cacheSet(candidate.artist, candidate.title, toCacheEntry(bestResult));

  songloft.log.info(`[scraper] 选用 ${bestResult.source} (${bestResult.score.toFixed(2)})`);
  return bestResult;
}

function buildResult(
  songId: number,
  best: SearchResult,
  candidate: { artist: string; title: string },
  sourceScores?: Record<string, number>
): ScrapeResult {
  return {
    songId,
    artist: best.artist || candidate.artist,
    title: best.title || candidate.title,
    album: best.album || '',
    genre: best.genre || '',
    year: best.year || '',
    track: best.track || '',
    lyrics: best.lyrics || '',
    cover_url: best.cover_url,
    source: best.source,
    score: best.score,
    sourceScores,
  };
}

/**
 * 从宿主获取歌曲完整信息 + 歌词内容（快照 / 清封面共用）
 */
export async function fetchSongFromHost(songId: number): Promise<{ song: any; lyrics: string } | null> {
  const token = await songloft.plugin.getToken();
  const hostUrl = await songloft.plugin.getHostUrl();
  const getResp = await fetch(`${hostUrl}/api/v1/songs/${songId}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (!getResp.ok) return null;
  const song = await getResp.json();
  let lyrics = '';
  if (song.lyric_url) {
    try {
      const lr = await fetch(`${hostUrl}${song.lyric_url}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      if (lr.ok) {
        const raw = await lr.text();
        try { lyrics = JSON.parse(raw).lyric || raw; } catch { lyrics = raw; }
      }
    } catch { /* ignore */ }
  }
  return { song, lyrics };
}

const BACKUP_KEY_PREFIX = 'backup_';

/**
 * 首次写入前快照原始标签。已存在则不覆盖——多次重刮后撤销仍恢复真·原始值。
 * 快照失败仅告警不阻塞写入（此时宿主大概率也不可用，写入会自行失败）。
 */
export async function ensureBackup(songId: number): Promise<void> {
  try {
    const key = BACKUP_KEY_PREFIX + songId;
    const existing = await songloft.storage.get(key);
    if (existing) return;
    const fetched = await fetchSongFromHost(songId);
    if (!fetched) {
      songloft.log.warn(`[backup] 获取歌曲信息失败，跳过快照: songId=${songId}`);
      return;
    }
    const { song, lyrics } = fetched;
    await songloft.storage.set(key, {
      title: song.title || '',
      artist: song.artist || '',
      album: song.album || '',
      genre: song.genre || '',
      year: typeof song.year === 'number' ? song.year : 0,
      track: song.track || '',
      lyrics,
      ts: Date.now(),
    });
  } catch (e: any) {
    songloft.log.warn(`[backup] 快照失败 songId=${songId}: ${e.message || e}`);
  }
}

/**
 * 调用宿主 API 将标签写入歌曲
 */
export async function writeTags(songId: number, result: ScrapeResult): Promise<string> {
  try {
    // 首次写入前快照原始标签，供撤销恢复
    await ensureBackup(songId);
    const token = await songloft.plugin.getToken();
    const hostUrl = await songloft.plugin.getHostUrl();

    // 封面直接传 URL 给后端下载（避免 QuickJS .text() 损坏二进制）
    const yearNum = result.year ? parseInt(result.year, 10) : 0;
    const body: Record<string, string | number | boolean> = {
      title: result.title,
      artist: result.artist,
      album: result.album || '',
      genre: result.genre || '',
      year: isNaN(yearNum) ? 0 : yearNum,
      track: result.track || '',
      lyrics: result.lyrics || '',
      cover_url: result.cover_url || '',
    };
    songloft.log.info(`[scraper] 写入标签: ${result.artist} - ${result.title} | genre=${body.genre} year=${body.year} track=${body.track} source=${result.source}`);

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
      songloft.log.error(`[scraper] 标签写入失败 (HTTP ${resp.status}): ${errText}`);
      return 'failed';
    }

    const data = await resp.json();
    const fileWrite = data.file_write || 'unknown';
    songloft.log.info(`[scraper] 标签写入完成: ${result.artist} - ${result.title} (file=${fileWrite})`);
    // HTTP 200 = DB 已更新，file_write 仅作日志参考
    return 'ok';
  } catch (e: any) {
    songloft.log.error(`[scraper] 写入异常: ${e.message || e}`);
    return 'failed';
  }
}

/**
 * 清除歌曲中已嵌入的封面（解决老版本 base64 损坏封面无法覆盖的问题）
 * 传全部标签字段 + clear_cover=true 显式清空封面
 */
export async function clearCover(songId: number): Promise<string> {
  try {
    const token = await songloft.plugin.getToken();
    const hostUrl = await songloft.plugin.getHostUrl();

    // 先获取当前歌曲元数据 + 歌词
    const fetched = await fetchSongFromHost(songId);
    if (!fetched) {
      songloft.log.error(`[scraper] 清除封面前获取歌曲信息失败: songId=${songId}`);
      return 'failed';
    }
    const { song, lyrics } = fetched;

    const body: Record<string, string | boolean> = {
      title: song.title || '',
      artist: song.artist || '',
      album: song.album || '',
      genre: (song as any).genre || '',
      year: (song as any).year || '',
      track: (song as any).track || '',
      lyrics: lyrics,
      clear_cover: true,
    };

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
      songloft.log.error(`[scraper] 封面清除失败 (HTTP ${resp.status}): ${errText}`);
      return 'failed';
    }

    const data = await resp.json();
    const fileWrite = data.file_write || 'unknown';
    songloft.log.info(`[scraper] 封面已清除: songId=${songId} (file=${fileWrite})`);
    // HTTP 200 = DB 已更新，与 writeTags 保持一致
    return 'ok';
  } catch (e: any) {
    songloft.log.error(`[scraper] 封面清除异常: ${e.message || e}`);
    return 'failed';
  }
}
