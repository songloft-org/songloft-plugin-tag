# songloft-plugin-tag 开发上下文

音乐标签刮削插件（v2.2.0），运行在 Songloft 宿主的 QuickJS 沙箱中。声纹（AcoustID/MusicBrainz）+ 五个国内源（网易云/QQ/酷狗/咪咕/酷我）并发搜索，评分择优后经宿主 API 写回音频文件标签。

## 构建

```bash
npm run build      # songloft-plugin build → dist/tag.jsplugin.zip（esbuild 打包，不做类型检查）
npm run typecheck  # tsc --noEmit（构建器不查类型，提交前必跑）
npm run dev
```

注意：构建器**不跑 tsc**，类型错误会静默进产物——所以有独立的 typecheck 脚本。前端 script 块可用 `node -e "new Function(<script内容>)"` 做语法自检。

## 架构

两个完全隔离的运行环境，勿混用全局对象：

| 环境 | 文件 | 可用全局 |
|---|---|---|
| 后端（QuickJS） | `src/*.ts` → main.js | `songloft.*`（storage/songs/log/plugin/command）、`fetch` |
| 前端（浏览器 iframe/webview） | `static/index.html` | `SongloftPlugin`（getAuthToken/getTheme）、localStorage |

前端**不能**访问 `songloft.*`；后端**不能**访问 localStorage。前端通过相对路径 `./xxx` 调插件自己的 HTTP 路由；插件后端通过 `songloft.plugin.getToken()/getHostUrl()` 调宿主 `/api/v1/*`。

### 模块图（src/）

- `main.ts` — 路由层（createRouter）。批量任务表 `batchTasks`（内存 Map）、自动扫描定时器、SSRF 校验、埋点。生命周期 onInit/onDeinit/onHTTPRequest 挂 globalThis。
- `scraper.ts` — 刮削编排 `doScrape`：extractCandidates（文件名/DB 标签清洗）→ 缓存 → AcoustID（用宿主预计算的 fingerprint）→ 五源文本搜索兜底 → 评分择优 → `writeTags`（PUT 宿主 /songs/:id/tags）。
- `sources.ts` — 各源搜索客户端（网易云含 eapi AES/MD5 加密实现）、歌词下载（含双语合并）、广告过滤、enrichFromChineseSources（AcoustID 命中后富化封面/歌词/genre/year/track）、配置读写。
- `scoring.ts` — Ratcliff/Obershelp 相似度，公式 `0.4×artist + 0.6×title`（**硬编码**，UI 滑块未接线）× 源权重 − 时长惩罚。
- `cache.ts` — 24h KV 缓存，key = 32-bit hash(artist|title)，`cache_keys` 维护键列表。
- `ratelimit.ts` / `circuit.ts` / `semaphore.ts` — 令牌桶、熔断器、并发信号量（均为内存态）。
- `t2s.ts` — OpenCC 繁→简映射（3215 对，编码为数字串）。

### 插件 HTTP 路由（main.ts）

`GET /config`、`PUT /config`（自动派生 enable_* 开关：**有 URL/Key 即启用**）、`GET /config/status`（源连通性探测）、`POST /scrape/batch`（异步任务+轮询 `GET /scrape/batch/progress?taskId=`、`POST /scrape/batch/cancel`）、`POST /scrape/incremental`、`POST /scrape/:id`、`POST /scrape/manual/:id`、`GET /scrape/preview/:id`（校对 Diff 用）、`GET /covers/:id`（封面画廊）、`GET /song/:id`、`PUT /tags/:id`（宿主代理）、`POST /cover/clear/:id`、`GET/POST /storage/failed`、`GET/DELETE /storage/scraped`、`POST /organize/preview|execute`（转发宿主 Bridge `action: songs.organizePreview|organize`）、`GET/POST /circuit-breaker/*`。

### 存储键（songloft.storage）

- `scraper_config` — ScraperConfig JSON 字符串
- `scraped_done` — 已刮削歌曲 ID 数组（每标记一首全量读改写）
- `failed_songs` — 失败记录 JSON 字符串（由前端维护内容）
- `scrape_cache_<hash>` + `cache_keys` — 结果缓存
- `last_scan_time`、`plugin_stats_device_id`、`plugin_stats_last_ver`
- `org_history` — 整理撤销历史（⚠ 前端代码试图写它，但前端没有 songloft 全局，实际不可用）

前端 localStorage：`batchTaskId`/`batchTotal`（批量断点续传）、`tag-plugin-theme`。

### 关键约定

- 酷我/咪咕不用自建 URL：咪咕走公开接口（checkbox 开关），酷我硬编码 kuwo.cn，但 `enable_kuwo` 由 `kuwo_api_url` 是否非空派生 —— URL 内容本身不被使用，纯当开关。
- `writeTags` 把 cover_url 传给宿主由后端下载（QuickJS 处理二进制会损坏）；HTTP 200 即视为成功（`file_write` 仅日志参考），返回值只有 `'ok' | 'failed'`。
- AcoustID 用宿主扫描时算好的 `song.fingerprint`，插件不跑 fpcalc；onInit 会清空 `bin/` 残留。
- 所有 search 函数内部 catch 后返回 `[]`（不抛错）—— 这导致外层熔断器实际收不到失败信号（见已知问题）。
- 前端是无框架手写 JS（ES5 风格单字母变量），全局状态在 `S` 对象上；HTML 拼接必须过 `esc()`（文本）/`escH()`（属性）。

## 宿主 API（对接注意）

Swagger（以线上为准，本地摘要会过期）：https://petstore.swagger.io/?url=https://raw.githubusercontent.com/songloft-org/songloft/refs/heads/main/docs/swagger.json —— 2026-07-16 核对版本 **2.10.0**。改对接代码前先 `curl` 线上 swagger.json 确认。

关键语义（写代码前先看这里）：
- `PUT /songs/:id/tags`：**非空字段覆盖，空值保留原值**——传空串清不掉字段；`cover_data`(base64) 优先于 `cover_url`；`clear_cover=true` 是唯一清除标志（仅封面）。请求字段含 `language`/`style`/`rename_file`（按新标题重命名文件，本地非 CUE）；**`year` 是 integer**（传字符串可能 400）。响应 = `{file_write, song}`（字段名就叫 file_write；`file_write_status` 只属于 lyrics 端点）。
- `POST /songs/organize` + `POST /songs/organize/preview`：body **直接是数组** `[{id, target_path}]`（非 `{items}` 封包）；`target_path` 相对 music_path；**扩展名必须与原文件一致**；CUE 歌曲 skip；preview 是 dry-run，返回 `[{id, old_path, new_path, status: ok|conflict|skip|error, error}]`，含磁盘已存在 + 批内撞名检测。
- `GET /songs` / `GET /songs/ids`：同一套过滤参数（type/keyword/path_prefix/genre/artist/album/language/style/year/decade + sort/order）；ids 一次返回全部匹配 ID（增量/全选用它，别拉全量对象）。注意 `exclude_playlist_labels` 默认排除 hidden 歌单。
- 歌词：读 `GET /songs/:id/lyric`（LyricPayload{lyric,tlyric,rlyric,lxlyric}；`song.lyric_url` 即指向此端点，直接用它没问题），写 `PUT /songs/:id/lyrics`（`lyric_source=manual` 防重扫覆盖；响应 `file_write_status`: written/unchanged/skipped/failed）。
- `models.Song` 易错字段：音轨号是 **`track`**（不是 track_number，字符串，可为 "3/12"）；**没有 `lyrics` 字段**（只有 lyric_url）；`year` 是 integer。
- 指纹：`POST /scan/fingerprints`（可主动触发批量计算）+ `GET /scan/fingerprints/status|progress`。
- **不存在**的端点（插件曾误用）：`GET /api/v1/files`、插件根路径的 POST bridge（见 #31 #37）。

## 已知问题清单（2026-07 审查）

> **2026-07-16 状态：#1–#26、#28–#32、#34、#36–#39 已全部修复**（v2.3.0，见 FIXPLAN.md 六批次提交 18f3529..HEAD）。#27 为有意功能不修；#33/#35 为误报撤回。下列原始描述保留作历史参考；行号对应 v2.2.0 代码，修复后已漂移。

### P0 — 功能失效 / 写错数据

1. **校对页「采纳」永远写入第一个候选**：`doAcceptReview` 取 `S._previewResults[0]`，用户点选其它候选（`selectCand`）后采纳的仍是原第一名（index.html:816）。
2. **整理 Tab 打开即 ReferenceError**：`switchTab('organize')` 分支引用未声明的 `t`（应为 `E("treeContainer")`），后续 `loadOrgSongs()` 不执行，首次进入列表空白（index.html:573）。
3. **整理撤销完全不可用**：前端 `orgExecute`/`orgUndo` 调 `songloft.storage`（后端全局，浏览器中 undefined）→ 历史永远存不上、撤销必报错（index.html:1026/1053）。需要后端加 `/organize/history` 端点。
4. **「一键撤销」是伪撤销**：`undoApply` 读当前 `/song/:id` 再原样 PUT 回去（no-op）；从未在写入前快照原始标签；`scraped_done` 也无单曲删除端点，刷新后绿灯复原（index.html:817）。
5. **熔断器从不触发**：所有 search 函数内部吞错返回 `[]`，`searchWithCircuit` 的 catch 永远走不到，`circuitFailure` 全项目实际不可达（sources.ts 各 search catch；scraper.ts:245）。
6. **设置页评分滑块是装饰品**：阈值/标题权重/艺术家权重滑块不从 config 读值、`saveCfg` 不保存（后端 `score_threshold` 是支持的；权重在 scoring.ts 硬编码）（index.html:832/558）。
7. **「清除缓存」清错地方**：缓存在插件 storage，前端却删 localStorage 的 `scrape_cache_*`；`cacheCnt` 永远 0。后端缺 `/cache/count`、`/cache/clear` 端点（index.html:827）。

### P1 — 逻辑 / 数据风险

8. **genre/year/track 从不写入缓存** → `!cached.genre||!cached.year||!cached.track` 恒真，每次缓存命中都重跑五源 enrich + 歌词下载，缓存形同虚设；enrich 结果也不回写缓存（scraper.ts:165、218-222、312-320）。
9. **强制刮削不绕过缓存**：force 只跳过 scraped_done 过滤，`doScrape` 仍命中 24h 缓存 → 强制重刮返回同样（可能错误的）结果（scraper.ts:160；main.ts:419）。
10. **markScrapedDone 读改写竞态**：并发（信号量>1）下丢标记；且每首歌全量重写整个数组，万首库 O(n²) 存储压力（main.ts:51）。
11. **自动扫描 setInterval 回调可重叠**：批次耗时 > 间隔时，同批歌曲被并发重复刮削（main.ts:937）。
12. **batchAccept 写回的是当前 DB 值而非推荐值**：黄灯区批量采纳只是把现有标签原样 PUT 并标绿，没有应用系统推荐（index.html:724）。
13. **_orgBusy 泄漏**：orgPreview（无歌曲/d.error）、orgExecute（无变更/d.error）、orgUndo（无历史/d.error）提前 return 不复位 → 整理三按钮永久失效直到刷新（index.html:977/983/1019/1024/1055/1062）。
14. **酷狗封面 URL 被 `replace(/\/{2,}/g,'/')` 破坏**：`http://` → `http:/`（浏览器容错但宿主后端下载会失败）；`{size}` 占位符也未替换（sources.ts:419）。
15. **前端日志状态永远 unknown**：比较 `fileWriteStatus==="written"/"skipped"`，后端只返回 `'ok'/'failed'`（index.html:592/593/615）。
16. **/covers/:id 评分把歌和自己比**：`scoreMatch(candidate, {artist: song.artist…})` 忽略搜索结果字段，排序退化为按源权重；且咪咕搜索无视 `enable_migu`（/scrape/preview 同）（main.ts:739、714、792）。
17. **缓存 32-bit hash 无碰撞校验**：不同歌 hash 撞车会直接写错标签，读取时应校验 entry 内 artist/title（cache.ts:18）。
18. **令牌桶并发竞态**：多个 waiter 同时醒来各自 `tokens=1` 再扣 → 突发请求超限（ratelimit.ts:36-43）。

### P2 — 体验 / 边缘

19. 目录名含单引号时树节点 onclick 解码后 JS 语法错误，无法导航（`escH` 的 `&#39;` 在属性中还原）（index.html:578/949）。
20. `_musicPrefix` 只取第一首歌的根目录，多根曲库其它根在树/筛选中不可见（index.html:571）。
21. `/scrape/preview/:id` 直接用当前标签拼关键词，不走 `extractCandidates` 垃圾标签清洗 → "Track 01" 类歌曲校对推荐全错，与实际刮削行为不一致（main.ts:777）。
22. `selectCand` 后候选行只剩 1 张卡片（`renderDiffDetail(s,[r])`），无法切回其它候选（index.html:791）。
23. `songs.list({limit:10000})` 硬上限，超万首曲库截断（main.ts:487/635/939；index.html 全量加载同样有性能上限）。
24. `batchTasks` 只在被轮询到 done 时才定时清理，前端关页后任务（含 results 大对象）永驻内存（main.ts:466）。
25. `/scrape/incremental` 的 task 缺 `cancelled` 字段（Map 类型要求有，esbuild 不查）（main.ts:497）。
26. AcoustID 查询在候选循环内，反向候选轮会用同一指纹重查 AcoustID+MusicBrainz（scraper.ts:176-226）。
27. ~~埋点~~ **非 bug，勿动**：`reportStats`（main.ts:60）是有意接入的自建统计服务（countapi 计数安装/升级量），保留原样，重构时不得删除。
28. 手动刮削 `applyR` 丢 genre/year/track（dataset 未带，`/scrape/manual` 响应也没返回）（index.html:606）。
29. 死代码：`scrapeBatch`/`previewScrape`（scraper.ts）、`clearFailed`/`openManualRetry`/`preview`/`applyPrev`/`closePrev`（index.html）、`GET /test/t2s` 调试端点。
30. 手动编辑/applyR 的 `year` 以字符串 PUT 给宿主，刮削路径却转 int（scraper.ts:357）—— 依赖宿主容错，建议统一。

### 对照宿主 API 补充（#31–#39；2026-07-16 按线上 swagger v2.10.0 核对）

31. **(P0) 整理调用不存在的宿主路由**：/organize/preview|execute POST 到插件自身根路径 `/api/v1/jsplugin/tag` + `{action:...}` 封包；swagger 无此 POST 路由 → 预览/执行必失败。文档化端点：`POST /songs/organize` 与 `POST /songs/organize/preview`（body 均为裸数组）（main.ts:293/327）
32. **(P1) tags「空值保留原值」语义未处理**：(a) 撤销时「原本为空、被刮削填充」的文本字段无法清空（仅封面有 clear_cover）；(b) 编辑弹窗清空字段保存 → 宿主保留原值，改动静默丢失且无提示（index.html:612）
33. ~~file_write 字段名不匹配~~ **撤回**：线上 tags 响应 schema 即 `{file_write, song}`，插件读法正确；`file_write_status` 只属于 lyrics 端点
34. **(P2) 手动编辑歌词可被重扫覆盖**：编辑弹窗歌词经 /tags 写入；应走 `PUT /songs/:id/lyrics` + `lyric_source=manual`（index.html:612）
35. ~~lyric_url 未文档化~~ **撤回**：`models.Song.lyric_url` 已文档化且指向 /songs/:id/lyric，现有用法正确
36. **(P2) minHostVersion 矛盾**：plugin.json 写 2.5.0，README 要求 v2.10.0+（track 全格式写入），整理又依赖 /songs/organize——低版本宿主可装但功能残缺（plugin.json:9）
37. **(P2) 本地 .lrc 兜底调用不存在的 `GET /api/v1/files`**：线上 swagger 亦无此端点，兜底静默失效，等同死代码，应删除（sources.ts:596-663）
38. **(P1) 音轨号读错字段**：`models.Song` 字段名为 `track`，插件读 `s.track_number`（main.ts:590 /song/:id、main.ts:667 /songs）→ 编辑弹窗/列表音轨号恒空
39. **(P2) 歌词健康度恒 0%**：`models.Song` 无 `lyrics` 字段（只有 lyric_url），/songs 路由映射 `s.lyrics` 恒空 → 前端 updateHealth 歌词完整度恒 0（需实测 SDK list 返回形状；若同 HTTP 模型，改用 `lyric_url` 非空判断）（main.ts:664；index.html:826）

### 线上 API 新能力（功能优化候选，非 bug）

- tags 支持 `language`/`style` 字段（刮削源可回填）与 `rename_file=true`（按新标题重命名文件——可替代整理 Tab 的纯重命名场景）
- `GET /songs/facets`：按 genre/artist/album/language/style/year/decade 聚合
- `POST /scan/fingerprints`：歌曲无指纹时插件可主动触发计算（现在只是提示「请稍后重试」），配合 status/progress 轮询
