# 修复方案 — songloft-plugin-tag v2.2.0 → v2.3.0

对应 `CLAUDE.md`「已知问题清单」的 30 项问题（编号 #1–#30 与其一致）。按**可独立提交、可独立验证**的原则分 6 个批次，每批修完即可构建自测，不阻塞下一批。

> #27（reportStats 统计）经确认是**有意接入的统计服务，不是 bug，勿动**——已从修复范围移除，实际待修 29 项。
>
> 2026-07-16 对照**线上 swagger（API v2.10.0）**复核：#31 #32 #34 #36 #37 成立，~~#33~~ ~~#35~~ 撤回（线上 schema 证实插件原用法正确），新增 #38 #39。并入批次：#31→批次 2（方案重写），#32→批次 1，#38→批次 6，#34 #37 #39→批次 6，#36→发布清单。合计待修 **36 项**。改对接代码前以线上 swagger 为准，本地摘要文档会过期。

---

## 总览

| 批次 | 主题 | 覆盖问题 | 改动面 |
|---|---|---|---|
| 1 | 校对 Tab 核心交互 | #1 #4 #12 #22 #32 | 前端 + 后端新端点 |
| 2 | 整理 Tab 修复 | #2 #3 #13 #31 | 前端 + 后端新端点 |
| 3 | 设置页接线 | #6 #7 | 前端 + config 新字段 |
| 4 | 刮削引擎 | #5 #8 #9 #14 #16 #17 #21 #26 | 仅后端 |
| 5 | 并发与稳定性 | #10 #11 #18 #24 #25 | 仅后端 |
| 6 | 体验与清理 | #15 #19 #20 #23 #28 #29 #30 #34 #37 #38 #39 | 前后端零散 |

**全局前置（第一个提交）**：
1. `package.json` 加 `"typecheck": "tsc --noEmit"`。构建器（esbuild）不做类型检查，每批提交前必须手动跑 `npm run typecheck`（#25 这类错误只有它能拦住）。
2. 版本策略：全部完成后 bump `2.3.0`（有新端点 + 行为变更）；`plugin.json` 的 entryHash/zipHash 由 `npm run build` 重新生成。

---

## 批次 1 — 校对 Tab 核心交互（#1 #4 #12 #22 #32）

目标：让「采纳 / 撤销 / 批量采纳」三个动作真正生效且刷新后不还原。

### 1a. 后端：原始标签快照 + 撤销端点（#4 的根基）

**新增存储键**：`backup_<songId>` = `{title, artist, album, genre, year, track, lyrics, ts}`。

- `scraper.ts` 新增 `ensureBackup(songId)`：若 `backup_<songId>` 不存在，GET 宿主 `/api/v1/songs/:id`（+ lyric_url 拉歌词，逻辑同 `clearCover` 里现成的），存快照。**只在首次写入时创建**——后续强制重刮不覆盖，保证撤销恢复的是真·原始标签。
- `writeTags()` 开头调用 `ensureBackup(songId)`（scraper.ts:351）。
- `main.ts` 新增路由：
  - `POST /undo/:id` — 读 `backup_<id>` → PUT 宿主 tags 恢复 → `storage.delete('backup_<id>')` → 从 `scraped_done` 移除该 id → 返回 `{ok:true}`；无快照返回 404 `{error:'无可撤销的记录'}`。
  - `POST /storage/scraped/:id` / `DELETE /storage/scraped/:id` — 单曲增/删已刮标记（复用 `getScrapedDone`，走批次 5 的互斥写）。
- `PUT /tags/:id` 代理（main.ts:601）支持 query `?snapshot=1`：带上时先 `ensureBackup` 再转发。手动编辑弹窗**不带**（用户手改不算刮削，不产生撤销点）；校对页采纳**带**。

**已知局限（写进 CHANGELOG，源自宿主 tags API「非空覆盖、空值保留」语义，#32a）**：
- 快照不含封面 —— 嵌入式封面被覆盖后无法通过撤销恢复，撤销仅恢复文本标签 + 歌词。
- 原本为空、被刮削填充的文本字段（如原无 album），撤销时传空串会被宿主**保留刮削值**，无法清回空。`/undo/:id` 实现时：快照中为空的字段直接不传（少一次无效写），并在响应里返回 `{restored:[...], kept_filled:[...]}`，前端 toast 提示「N 个原为空的字段无法清空」。

**#32b 编辑弹窗静默丢改动**：同一语义反向坑——用户在编辑弹窗把某字段**清空**保存，宿主保留原值，改动悄悄丢失。`saveEditSheet`（index.html:612）保存前 diff：若存在「原有值→清空」的字段，toast 警告「宿主不支持清空 XX 字段，该改动不会生效」（仍照常提交其余字段）。

### 1b. 前端：候选切换真正生效（#1 #22）

`index.html` 三处联动改：

- `renderDiffDetail(s, results)` → `renderDiffDetail(s, results, selIdx)`：Diff 右侧用 `results[selIdx]`；候选行始终渲染完整 `results.slice(0,6)`，`sel` class 打在 `selIdx` 上（修 #22 选中后其它候选消失）。
- `selectCand(i, songId)`：只更新 `S._candIdx=i` 并 `renderDiffDetail(s, S._previewResults, i)`，**不再**传 `[r]`（index.html:791）。
- `doAcceptReview(id)`：取 `S._previewResults[S._candIdx||0]`（index.html:816）；`showDiff` 开头重置 `S._candIdx=0`。

### 1c. 前端：采纳/撤销持久化（#4 #12）

- `acceptReview(...)`（index.html:815）：PUT 改为 `./tags/:id?snapshot=1`；成功后调 `POST ./storage/scraped/:id` 持久化绿灯状态（当前只改内存 `S._scraped`，刷新即丢）。
- `undoApply(id)`（index.html:817）：整体替换为调 `POST ./undo/:id`；成功后 `S._scraped.delete(id)` + 刷新列表；404 时 toast「该歌曲无刮削写入记录」。
- `batchAccept()`（index.html:724）：删除现有「原样 PUT 当前 DB 值」的循环（它什么都没改），改为复用批量刮削链路：抽出 `batch(force, idList)`（现 `batch()` 从 `S.sel` 取 id，加可选参数即可），`batchAccept` 调 `batch(false, [...S._selectedIds])`。轮询 done 回调里补一句 `if(S._tab==="failed")renderReview()`。

### 验证

1. 黄灯区选一首歌 → 点第 2 个候选 → 采纳 → 详情/DB 是第 2 个候选的标签。
2. 采纳后**刷新页面** → 仍在绿灯区。
3. 绿灯区撤销 → 标签恢复刮削前原值（对比 file_path 原始文件名）→ 刷新后仍不在绿灯区。
4. 强制重刮同一首 → 再撤销 → 恢复的仍是最初原始标签（不是第一次刮削的结果）。
5. 黄灯区勾 3 首批量采纳 → 进度条走完 → 3 首全部变绿且标签是推荐值。

---

## 批次 2 — 整理 Tab（#2 #3 #13 #31）

### 2a. ReferenceError 修复（#2）

`switchTab('organize')` 分支（index.html:573）：`if(t&&S._allSongs)` 前补 `var t=E("treeContainer");`（与 `orgNavTo` 内写法一致）。

### 2b. 整理调用重写为文档化宿主端点（#31，方案重写）

现状：`/organize/preview|execute` POST 到 `${hostUrl}/api/v1/jsplugin/tag` + `{action:'songs.organizePreview'|'songs.organize', data:{items}}`（main.ts:293/327）。对照线上 swagger（v2.10.0）：插件根路径没有 POST 路由 —— 该调用必失败（整理 Tab 迄今不可用还有这一层原因，#2 只是第一层）。

宿主真实端点（线上均已提供，**preview 也有**）：
- `POST /api/v1/songs/organize/preview` — dry-run，返回 `[{id, old_path, new_path, status: ok|conflict|skip|error, error}]`，含磁盘已存在 + 批内撞名检测，CUE 歌曲 skip
- `POST /api/v1/songs/organize` — 执行，返回 `[{id, file_path, status, error}]`
- 两者 body **直接是数组** `[{id, target_path}]`（无 `{items}` 封包）；`target_path` 相对 music_path；**扩展名必须与原文件一致**

改法（两个路由都是薄转发，删掉 bridge 封包）：
- `main.ts` `/organize/preview`：转发 `POST ${hostUrl}/api/v1/songs/organize/preview`，body = `items.map(({id, target_path}) => ({id, target_path}))`；响应字段（old_path/new_path/status）与前端现有渲染（index.html:1003-1010）天然对齐，`skip`/`error` 状态前端补渲染分支（CUE 歌曲显示「跳过（CUE）」）。
- `main.ts` `/organize/execute`：转发 `POST ${hostUrl}/api/v1/songs/organize`，同样去封包；`success/failed` 统计改按 `status==='ok'` 判定（宿主响应字段为 `status`+`error`）。
- 前端 `getTargetPath`（index.html:950）扩展名兜底 `"flac"` 删掉——无扩展名时保留原文件名整体，避免伪造扩展名触发宿主「扩展名必须一致」拒绝。

### 2c. 整理历史落后端（#3）

前端没有 `songloft` 全局，`orgExecute`/`orgUndo` 里的 `songloft.storage.get/set("org_history")`（index.html:1026/1053）必然抛错。

- `main.ts` 新增（照抄 `/storage/failed` 的模式）：
  - `GET /storage/org-history` → 返回数组
  - `POST /storage/org-history` → 整体覆盖存储（前端负责裁剪到最近 10 条）
- 前端两处改为 `af("./storage/org-history")` 读写。
- ⚠ 撤销依赖 `old_path` —— execute 成功后由**后端**把 `{id, old_path, new_path}` 追加进 org_history（后端拿得到 getById 的原 file_path，比前端传参可靠）；`orgUndo` 从历史取 `old_path` 作为 target_path 回迁。

### 2d. `_orgBusy` 泄漏（#13）

`orgPreview` / `orgExecute` / `orgUndo` 三个函数体改成 `try { ... } finally { S._orgBusy=false }`，删除所有提前 `return` 前的手动复位和尾部复位（index.html:974/1015/1050）。

### 验证

1. 冷启动直接点「整理」Tab → 控制台无报错，目录树 + 歌曲列表正常渲染。
2. 选歌 → 预览（**宿主日志确认走 `POST /songs/organize/preview`**，目标已存在的项显示 conflict）→ 执行 → 文件真实移动、宿主曲库路径已更新。
3. 重命名模板改扩展名场景（如原 .flac）→ preview 返回 error/conflict，execute 不移动该项。
4. CUE 拆分歌曲 → 预览显示「跳过（CUE）」，execute 不动它。
5. 「撤销」→ 文件移回原路径。
6. 不预览直接点执行 → toast「请先预览」→ **再点预览仍有响应**（busy 未卡死）。
7. 刷新页面后撤销依然可用（历史在后端）。

---

## 批次 3 — 设置页接线（#6 #7）

### 3a. 评分滑块（#6）

- `sources.ts`：`ScraperConfig` + `DEFAULT_CONFIG` 增加 `title_weight: 0.6`、`artist_weight: 0.4`。
- `main.ts` `PUT /config`：两字段 clamp 到 [0.2, 0.8]。
- `scoring.ts`：模块级 `let W = {title: 0.6, artist: 0.4}` + `export function setScoreWeights(t, a)`（内部按 `t/(t+a)` 归一化）；`scoreMatch` 的 `0.4/0.6` 常量改用 `W`。
- `sources.ts` `loadConfig()` 末尾调 `setScoreWeights(cfg.title_weight, cfg.artist_weight)` —— 所有刮削路径都先 `loadConfig`，这是唯一必经点，不用改任何调用方签名。
- 前端 `initSliders`（index.html:832）：
  - 初始化时从 `S.cfg` 读值定位（`score_threshold` / `title_weight` / `artist_weight`），替换现在写死的 `min+(max-min)*0.5`；
  - 拖动结束把值写回 `S.cfg.score_threshold` 等（`saveCfg` 已整体 PUT `S.cfg`，无需再改）；
  - 标题/艺术家权重联动：拖其一，另一个设为 `1-x` 并同步 UI（保持和为 1，用户心智简单）。

### 3b. 缓存管理（#7）

- `cache.ts` 新增 `cacheCount()`（读 `cache_keys` 长度）和 `cacheClear()`（遍历 `cache_keys` 逐个 `storage.delete`，最后清空 `cache_keys`）。注意用 `storage.delete` 而非现在 `cacheCleanup` 里的 `set(k, null)`（顺手把 cacheCleanup 也改成 delete，避免残留 null 值键）。
- `main.ts` 新增 `GET /cache/stats` → `{count}`；`POST /cache/clear` → `{cleared}`。
- 前端：`clearCache()`（index.html:827）改调 `POST ./cache/clear`；`openCfg()` 时请求 `./cache/stats` 填 `cacheCnt`。

### 验证

1. 阈值滑到 0.85 保存 → 重开设置面板位置不变 → `GET /config` 里 `score_threshold: 0.85` → 刮一首模糊匹配的歌确认被拒。
2. 标题权重拖到 70% → 艺术家自动 30% → 保存后刮削日志得分变化符合预期。
3. 刮几首歌 → 设置面板缓存条目 > 0 → 清除 → 变 0 → 再刮同一首（观察日志无「缓存命中」）。

---

## 批次 4 — 刮削引擎（#5 #8 #9 #14 #16 #17 #21 #26）

全部在后端，是收益最大的一批。

### 4a. 让熔断器活过来（#5）

错误信号现在在两层被吞：`fetchWithRetry` 返回 `{ok:false}` 不抛错；各 `searchX` 里 blanket `catch { return [] }`。

- `fetchWithRetry`（sources.ts:58）：重试耗尽后 **throw** 最后一个错误（删掉 `{resp:null, ok:false}` 约定和所有 `if (!rt.ok) return []` 分支）。
- 各 `searchNetease/QQMusic/KuGou/MiGu/KuWo`：删除函数级 try/catch。约定：**网络错误、HTTP 非 2xx、JSON 解析失败 → throw**（都算源故障，计入熔断）；响应合法但无结果 → 返回 `[]`。
- 调用方核对（大多数已兼容）：
  - `doScrape` 的 `searchWithCircuit`（scraper.ts:245）— 本来就为 throw 设计，无需改。
  - `enrichFromChineseSources` 的 `searchWithScoring`（sources.ts:809）— 已有 try/catch，补 `circuitFailure/Success` 调用（现在只有 migu/kuwo 分支有熔断，netease/qq/kugou 没有）。
  - `/covers/:id`、`/scrape/preview/:id`（main.ts）— 用 `Promise.allSettled`，rejected 自动落 `rejected` 分支，无需改。
  - `/scrape/manual/:id`（main.ts:868）— 现在是裸 `await searchNetease(...)`，一个源挂整个端点 500。每个源套独立 try/catch。
- `searchAcoustid` 保留自身 catch（AcoustID 失败要静默降级文本搜索，不参与熔断——保持现状）。

### 4b. 缓存补全 + 防碰撞 + force 绕过（#8 #9 #17）

- **#8**：两处 `cacheSet`（scraper.ts:218、312）的 data 补上 `genre/year/track/sourceId`；缓存命中后跑了 enrich 的，把补全后的 entry **回写** `cacheSet`。为防「源本来就没有 genre」导致每次命中都重跑 enrich，entry 加标记 `enriched: true`，命中时条件改为 `if (!cached.enriched)`（scraper.ts:165）。
- **#17**：`cacheSet` 存入 `_k: artist.toLowerCase()+'|'+title.toLowerCase()`；`cacheGet` 校验 `_k` 一致，不一致视为 miss（哈希碰撞防护，cache.ts:29）。
- **#9**：`doScrape(songId, cfg)` 加第三参 `opts?: {skipCache?: boolean}`；`skipCache` 时跳过 `cacheGet`（仍然 `cacheSet` 覆盖旧缓存）。链路打通：`POST /scrape/batch` 的 `force` → `runBatchTask(taskId, task, {skipCache: force})` → `doScrape`；`POST /scrape/:id` 支持 `?force=1`。

### 4c. 源客户端修复（#14 #16 #21 #26）

- **#14 酷狗封面**（sources.ts:419）：`s.AlbumImg?.replace(/\{size\}/g,'400').replace(/([^:])\/{2,}/g,'$1/')` —— 先替换 `{size}` 占位符，再压重复斜杠但保护 `://`。
- **#16 /covers/:id**（main.ts:739）：现在 `scoreMatch(candidate, {artist: song.artist, title: song.title, ...})` 是拿歌和自己比。改为收集时保留搜索结果的 `artist/title`，对**结果字段**评分。同文件 714 行咪咕无条件搜索 → 包 `if (cfg.enable_migu)`；`/scrape/preview/:id`（main.ts:792）同样补 migu 开关。
- **#21 preview 关键词**（main.ts:777）：`/scrape/preview/:id` 改用 `extractCandidates(song.file_path, {artist, title})[0]` + `toSimplified` 生成关键词（与 `doScrape` 一致），否则 "Track 01" 类垃圾标签的校对推荐全错。
- **#26 AcoustID 提到循环外**（scraper.ts:176-226）：声纹查询不依赖候选关键词，整块提到 `for (ci...)` 循环之前（enrich 的 candidate 参数用 `candidates[0]`）。反向候选轮不再重复打 AcoustID + MusicBrainz。

### 验证

1. 断网（或填一个必超时的 URL）连刮 10+ 首 → 日志出现 `[circuit] xxx 熔断 60s` → `GET /circuit-breaker/status` 显示 open。
2. 刮一首 → 日志「缓存命中」→ **不再**跟随五源 enrich 请求日志（对比修复前）。
3. 同一首「强制」重刮 → 日志无「缓存命中」，走完整搜索。
4. 配置了酷狗源的歌 → 封面 URL 含 `https://`（双斜杠完好）且无 `{size}`。
5. 文件名 `周杰伦 - 晴天.flac` 但标签是 `Track 01` 的歌 → 校对页推荐与「歌曲页刮削」结果一致。

---

## 批次 5 — 并发与稳定性（#10 #11 #18 #24 #25）

- **#10 scraped_done 竞态**（main.ts:41-57）：模块级缓存 + 写串行化。
  ```
  let doneCache: Set<number> | null = null;   // 首次 getScrapedDone 时填充
  let writeChain: Promise<void> = Promise.resolve();
  markScrapedDone(id) { doneCache.add(id); writeChain = writeChain.then(() => storage.set('scraped_done', [...doneCache])); return writeChain; }
  ```
  读走缓存（省掉每首歌一次全量读），写靠 promise 链互斥，不丢并发标记。`DELETE /storage/scraped`（清空）和批次 1 的单曲增删同样过这套。
- **#11 自动扫描重叠**（main.ts:937）：`setInterval` 改 `setTimeout` 自链式——回调 `finally` 里 `autoScanTimer = setTimeout(tick, intervalMs)`。批次跑多久都不会重叠，`stopAutoScan` 逻辑不变（clearTimeout）。
- **#18 令牌桶**（ratelimit.ts:36）：等待分支改 `while` 循环——睡醒后**重新补充并检查**令牌，够了才原子地 `tokens -= 1`（单线程内同步段是原子的），删掉现在无条件 `tokens = 1` 的赋值。多 waiter 同时醒来也不会超发。
- **#24 batchTasks 泄漏**（main.ts:466）：`runBatchTask` 末尾（`task.status='done'` 后）统一 `setTimeout(() => batchTasks.delete(taskId), 10*60*1000)`；删除 progress 轮询里那个只有被轮询才生效的清理。自动扫描分支现有的立即 `batchTasks.delete` 保留。
- **#25**：`/scrape/incremental` 的 task 对象补 `cancelled: false`（main.ts:497）。`npm run typecheck` 应从此报错清零。

### 验证

1. 并发 8 批量刮 50 首 → 完成后 `GET /storage/scraped` 数量 = 成功数（修复前会少）。
2. 自动扫描间隔设 5 分钟、灌一批慢源歌曲 → 日志中两轮 `[auto-scan]` 永不交叠。
3. `npm run typecheck` 零报错。

---

## 批次 6 — 体验与清理（#15 #19 #20 #23 #28 #29 #30 #34 #37 #38 #39）

- **#15**：前端三处（index.html:592/593/615）状态映射改为后端真实值：`fileWriteStatus==="ok"` → 成功、`"failed"` → 失败，删掉 `"written"/"skipped"` 分支。
- **#19 单引号目录**：`buildTree`/`buildOrgTree`（index.html:578/949）onclick 生成改为 `navTo(decodeURIComponent('${encodeURIComponent(pn)}'))`；根节点两处同改。encodeURIComponent 后不含引号/反斜杠，属性层安全。
- **#20 多根曲库**：`loadSongs` 里 `_musicPrefix` 从「取第一首的第一段」改为**全库最长公共目录前缀**（逐首求交，无公共前缀则 `""`，`_rootName` 用 `"全部"`）。`buildTree/filterPath/getTargetPath` 已按 prefix 参数化，无需再改。
- **#23 万首上限**：main.ts 抽 `listAllSongs()` 辅助——按 `{limit:1000, offset}` 翻页循环到短页为止（保险上限 100 页）；替换 `/songs` 端点的全量拉取。**增量扫描与 auto-scan 改用宿主 `GET /songs/ids`**（swagger 文档化端点，与 /songs 同过滤条件、一次返回全部匹配 ID）——这两处只需要 id 集合做 `scraped_done` 差集，拉全量对象纯属浪费。
- ~~#27 埋点~~：**不修**。`reportStats`（main.ts:59-79）是有意接入的自建统计服务，保留原样；后续任何重构不得删除或改动其上报逻辑。
- **#28 手动刮削丢字段**：`/scrape/manual/:id` 响应补 `genre/year/track`（best 里现成）；前端 `doRetry` 渲染的写入按钮 dataset 加 `data-gen/data-yr/data-tr`（index.html:606），`applyR` 已在读这三个 dataset，天然接上。
- **#30 year 类型统一（swagger 证实为硬性要求）**：`WriteSongTagsRequest.year` 是 **integer**——前端手动编辑/applyR 传字符串不是「依赖容错」而是潜在 400。`PUT /tags/:id` 代理（main.ts:601）转发前统一 `body.year = parseInt(body.year,10)||0`，与刮削路径（scraper.ts:357）一致。
- ~~#33 file_write 字段名~~：**撤回**——线上 tags 响应 schema 即 `{file_write, song}`，插件读法正确（`file_write_status` 只属于 lyrics 端点）。#15 的状态映射仍按 tags 真实值改。
- **#34 手动编辑歌词防覆盖**：`saveEditSheet` 的歌词不再混进 /tags body，单独走宿主 `PUT /songs/:id/lyrics`（经插件代理转发），带 `lyric_source: 'manual'`——文档明确 manual 标记 scanner 重扫不覆盖。刮削路径（writeTags）歌词保持走 tags 不变（刮削结果本就应可被重刮覆盖）。
- ~~#35 lyric_url~~：**撤回**——`models.Song.lyric_url` 已文档化（"客户端唯一可见字段，指向 /api/v1/songs/{id}/lyric"），现有用法正确，不改。
- **#37 删除 .lrc 本地兜底死代码**：`fetchLrcFromLocal`（sources.ts:596-663）调用宿主不存在的 `GET /api/v1/files` 端点（线上 swagger 亦无此路由），自发布起静默失效。整个函数 + `enrichFromChineseSources` 里的调用点（sources.ts:934）+ `filePath` 参数链一并删除。若未来想要 .lrc 兜底，需宿主先提供文件读取 API。
- **#38 音轨号字段名修正**：`models.Song` 字段是 `track`（字符串，可为 "3/12"），插件两处读 `s.track_number`（main.ts:590 的 /song/:id、main.ts:667 的 /songs 映射）恒 undefined → 改为 `s.track`。改完编辑弹窗/Diff 面板的音轨号才有值。
- **#39 歌词健康度**：`models.Song` 无 `lyrics` 字段，/songs 映射的 `s.lyrics` 恒空 → 健康度面板歌词恒 0%。实测 `songloft.songs.list` 返回形状：若同 HTTP 模型，改用 `lyric_url` 非空作为「有歌词」信号（main.ts:664 映射 `has_lyrics: !!s.lyric_url`，index.html:826 改读该字段）。
- **#29 死代码删除**：`scraper.ts` 的 `scrapeBatch`/`previewScrape`（导出但无人调）、`main.ts` 的 `GET /test/t2s`、index.html 的 `clearFailed`/`openManualRetry`/`preview`/`applyPrev`/`closePrev`、`main.ts` import 里未用的 `scrapeSong 之外项`核对一遍（`scrapeBatch` 删后 import 同步清）。

### 验证

1. 建目录 `Rock'n'Roll/` 放歌 → 目录树可点击进入。
2. 曲库挂两个根目录 → 树上两个根都可见可筛。
3. 批量刮削日志行显示「ok」而非「unknown」。

---

## 新增后端端点汇总

| 端点 | 方法 | 批次 | 说明 |
|---|---|---|---|
| `/undo/:id` | POST | 1 | 恢复快照 + 移除已刮标记 |
| `/storage/scraped/:id` | POST / DELETE | 1 | 单曲已刮标记增/删 |
| `/tags/:id?snapshot=1` | PUT | 1 | 代理写标签前建快照 |
| `/scrape/:id?force=1` | POST | 4 | 单曲强制（绕缓存） |
| `/storage/org-history` | GET / POST | 2 | 整理撤销历史 |
| `/cache/stats` | GET | 3 | 缓存条目数 |
| `/cache/clear` | POST | 3 | 清空缓存 |

## 存储变更汇总

| 键 | 变更 | 兼容性 |
|---|---|---|
| `backup_<songId>` | 新增 | — |
| `org_history` | 归属从（不存在的）前端挪到后端端点 | 无旧数据，无迁移 |
| `scraper_config` | 新增 `title_weight`/`artist_weight` | loadConfig 与 DEFAULT_CONFIG 合并，旧配置自动补默认 |
| 缓存 entry | 新增 `_k`（碰撞校验）、`enriched` 标记 | 旧 entry 无 `_k` → 按 miss 处理，自然过期换血 |
| `scraped_done` | 格式不变（写路径改互斥） | 完全兼容 |

## 回归测试清单（全部批次完成后过一遍）

1. 歌曲 Tab：单曲刮削 / 批量 / 强制 / 停止 / 增量 / 封面下载 / 清除封面 / 清空记录
2. 校对 Tab：三灯计数正确；黄灯 Diff + 候选切换 + 采纳 + 批量采纳；绿灯详情 + 撤销；红灯重试（手动关键词）
3. 整理 Tab：树导航 / 预览 / 执行 / 撤销 / 冲突展示
4. 设置：源配置保存与连通性圆点、三滑块持久化、广告词、并发、自动监测开关、缓存计数与清除
5. 刷新页面：绿灯状态、批量任务恢复（resumeBatch）、主题
6. 移动端（<768px）：汉堡菜单、单列布局、底部弹层
7. `npm run typecheck` + `npm run build` 通过，zip 安装到宿主冷启动无报错

## 发布清单

- [ ] 6 批全部合入，回归清单通过
- [ ] **#36** `plugin.json` 的 `minHostVersion` 从 2.5.0 提到 **2.10.0**（README 环境要求 + track 全格式写入 + `/songs/organize` 依赖，三者一致）
- [ ] `plugin.json` / `package.json` / index.html 头部版本号 → `2.3.0`
- [ ] `CHANGELOG.md` 记录（用户可见变化：撤销真实可用、候选选择生效、熔断生效、缓存提速、多根曲库；注明撤销不恢复封面的局限）
- [ ] `npm run build` 生成 zip，`plugin.json` 哈希已更新
- [ ] 更新 `CLAUDE.md` 问题清单（标注已修复项）
