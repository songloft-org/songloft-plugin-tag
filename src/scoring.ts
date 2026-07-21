/// <reference types="@songloft/plugin-sdk" />

// ============================================================
// 文本相似度评分（Ratcliff/Obershelp 算法）
// ============================================================

/**
 * 计算两个字符串的最长公共子串长度
 */
function longestCommonSubstring(a: string, b: string): number {
  const lenA = a.length;
  const lenB = b.length;
  if (lenA === 0 || lenB === 0) return 0;

  // 用滚动数组优化空间
  let maxLen = 0;
  const prev = new Array(lenB + 1).fill(0);

  for (let i = 1; i <= lenA; i++) {
    const curr = new Array(lenB + 1).fill(0);
    for (let j = 1; j <= lenB; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1;
        if (curr[j] > maxLen) maxLen = curr[j];
      }
    }
    // 滚动
    for (let j = 0; j <= lenB; j++) {
      prev[j] = curr[j];
    }
  }
  return maxLen;
}

/**
 * Ratcliff/Obershelp 相似度（递归匹配最长公共子串）
 * Python difflib.SequenceMatcher.ratio() 的 JS 实现
 * 返回值 0.0 ~ 1.0
 */
export function sequenceSimilarity(a: string, b: string): number {
  if (!a && !b) return 1.0;
  if (!a || !b) return 0.0;
  if (a === b) return 1.0;

  const totalLen = a.length + b.length;
  if (totalLen === 0) return 1.0;

  const matches = matchingBlocks(a, b);
  const matchLen = matches.reduce((sum, m) => sum + m.length, 0);
  return (2.0 * matchLen) / totalLen;
}

interface MatchBlock {
  aStart: number;
  bStart: number;
  length: number;
}

function matchingBlocks(a: string, b: string): MatchBlock[] {
  const blocks: MatchBlock[] = [];
  _findMatchingBlocks(a, 0, a.length, b, 0, b.length, blocks);

  // 按 aStart 排序
  blocks.sort((x, y) => x.aStart - y.aStart);

  // 合并相邻/重叠的块
  const merged: MatchBlock[] = [];
  for (const block of blocks) {
    if (merged.length === 0) {
      merged.push(block);
      continue;
    }
    const last = merged[merged.length - 1];
    const lastAEnd = last.aStart + last.length;
    const lastBEnd = last.bStart + last.length;
    if (block.aStart <= lastAEnd && block.bStart <= lastBEnd) {
      // 重叠，扩展
      const newLen = Math.max(lastAEnd, block.aStart + block.length) - last.aStart;
      const maxLen = Math.max(a.length - last.aStart, b.length - last.bStart);
      last.length = Math.min(newLen, maxLen);
    } else {
      merged.push(block);
    }
  }
  return merged;
}

function _findMatchingBlocks(
  a: string, aLo: number, aHi: number,
  b: string, bLo: number, bHi: number,
  blocks: MatchBlock[]
): void {
  // 用显式栈替代递归，防止极端长字符串导致栈溢出
  const stack: Array<{aLo: number; aHi: number; bLo: number; bHi: number}> = [];
  stack.push({ aLo, aHi, bLo, bHi });

  while (stack.length > 0) {
    const { aLo, aHi, bLo, bHi } = stack.pop()!;

    let bestLen = 0;
    let bestA = -1;
    let bestB = -1;

    const subA = a.substring(aLo, aHi);
    const subB = b.substring(bLo, bHi);
    const dp: number[][] = Array.from({ length: subA.length + 1 }, () =>
      new Array(subB.length + 1).fill(0)
    );

    for (let i = 1; i <= subA.length; i++) {
      for (let j = 1; j <= subB.length; j++) {
        if (subA[i - 1] === subB[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
          if (dp[i][j] > bestLen) {
            bestLen = dp[i][j];
            bestA = aLo + i - bestLen;
            bestB = bLo + j - bestLen;
          }
        }
      }
    }

    if (bestLen > 0) {
      // 先 push 右侧子任务，再 push 左侧（栈 LIFO，保证左侧先处理，最终 blocks 有序）
      stack.push({ aLo: bestA + bestLen, aHi, bLo: bestB + bestLen, bHi });
      blocks.push({ aStart: bestA, bStart: bestB, length: bestLen });
      stack.push({ aLo, aHi: bestA, bLo, bHi: bestB });
    }
  }
}

// ============================================================
// 刮削源权重
// ============================================================

export const SOURCE_WEIGHTS: Record<string, number> = {
  acoustid: 1.5,
  netease: 1.0,
  qqmusic: 0.95,
  kugou: 0.85,
  migu: 0.82,
  kuwo: 0.80,
};

// 标题/艺术家相似度权重（可由配置覆盖，loadConfig 时注入）
let W_TITLE = 0.6;
let W_ARTIST = 0.4;

/** 设置评分权重（内部归一化，保证和为 1） */
export function setScoreWeights(titleWeight: number, artistWeight: number): void {
  const t = typeof titleWeight === 'number' && titleWeight > 0 ? titleWeight : 0.6;
  const a = typeof artistWeight === 'number' && artistWeight > 0 ? artistWeight : 0.4;
  const sum = t + a;
  W_TITLE = t / sum;
  W_ARTIST = a / sum;
}

/**
 * 计算候选标签与搜索结果的匹配得分
 * 公式: artist_weight × artist_similarity + title_weight × title_similarity
 * 再乘以源权重，最后应用时长惩罚
 */
export function scoreMatch(
  candidate: { artist: string; title: string; duration?: number },
  result: { artist: string; title: string; source: string; duration?: number }
): number {
  const artistCand = (candidate.artist || '').trim().toLowerCase();
  const titleCand = (candidate.title || '').trim().toLowerCase();
  const artistRes = (result.artist || '').trim().toLowerCase();
  const titleRes = (result.title || '').trim().toLowerCase();

  if (!artistRes || !titleRes) return 0.0;

  const artistSim = sequenceSimilarity(artistCand, artistRes);
  const titleSim = sequenceSimilarity(titleCand, titleRes);
  let rawScore = W_ARTIST * artistSim + W_TITLE * titleSim;
  const weight = SOURCE_WEIGHTS[result.source] || 0.8;
  let score = rawScore * weight;

  // 时长惩罚：时长差 > 5s 时按差值扣分
  if (candidate.duration && result.duration && candidate.duration > 0 && result.duration > 0) {
    const diff = Math.abs(candidate.duration - result.duration);
    if (diff > 5) {
      const penalty = Math.min(0.5, (diff - 5) * 0.02);
      score *= (1 - penalty);
    }
  }

  return score;
}


