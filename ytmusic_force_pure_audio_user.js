// ==UserScript==
// @name         YouTube Music 纯享音频守护 (Force Pure Audio / Anti-MV Redirect)
// @namespace    https://music.youtube.com/
// @version      5.6.0
// @description  通用型逆转 YouTube Music 服务端 MV 强制重定向脚本：零冗余原生纯音短路、单次搜索直出完整元数据、跨会话本地缓存、双阶段微节流全队列净化、SAPISIDHASH 登录态同步点赞与可折叠微点胶囊。
// @author       anotherwanwanyi
// @match        https://music.youtube.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  /**
   * ===========================================================================
   * v5.6.0 架构与性能优化说明：
   *
   * 1. 【原生纯音频零干扰短路（Zero-Overhead on Native ATV）】：
   *    - 严格区分「原本就是纯音频的曲目 (Native ATV)」与「由 MV 逆转恢复的纯音频 (Converted ATV)」。
   *    - 播放正常纯音歌单时：0 额外网络请求、0 对象深拷贝、通过 Polymer 原生 `.text` 接口保持标题同步。
   *
   * 2. 【统一轻量级元数据缓存（跨会话 `localStorage` 持久化 + 幂等脏标记）】：
   *    - 自动将解析成功的 `omvId -> { atvId, title, artist, byline, duration, thumb, bylineRuns, albumBrowseId }`
   *      持久化至 `localStorage`（上限 800 首，LRU 自动淘汰），刷新网页或隔天重开 0 秒命中。
   *    - 为已净化的 Redux 队列项与 DOM `<ytmusic-player-queue-item>` 打上轻量级幂等标记（Stamp），O(1) 短路跳过。
   *
   * 3. 【双阶段微节流后台全队列净化 + 可折叠状态胶囊】：
   *    - 首播与相邻曲目同步净化，其余队列曲目采用 280ms 呼吸间隔 + 空闲帧后台净化。
   *    - 点击右上/右下角胶囊即可在「详细状态栏」与「极简颜色状态小圆点」之间切换。
   * ===========================================================================
   */

  const PERSIST_CACHE_KEY = 'ytm_pure_v5_persist_map_v1';
  const MAX_PERSIST_ENTRIES = 800;

  const STATE = {
    enabled: localStorage.getItem('ytm_pure_v5_enabled') !== 'false',
    collapsed: localStorage.getItem('ytm_pure_v5_collapsed') === 'true',
    omvToAtv: new Map(),           // omvVideoId -> atvVideoId
    atvToOmv: new Map(),           // atvVideoId -> omvVideoId (仅记录确实由 OMV 逆转而来的 ATV)
    atvToMeta: new Map(),          // atvVideoId -> { videoId, title, artist, byline, duration, thumb, bylineRuns, albumBrowseId, likeStatus, renderer, ts }
    titleToAtv: new Map(),         // normalized "rootTitle|artist" -> atvVideoId
    omvToPageTitle: new Map(),     // omvVideoId -> 页面列表（如专辑页）上显示的原始曲名
    likeStatusMap: new Map(),      // videoId 或 normTitleKey -> 'LIKE' | 'DISLIKE' | 'INDIFFERENT'
    knownAtvIds: new Set(),
    knownOmvIds: new Set(),
    unresolvableOmvIds: new Set(),
    pendingResolutions: new Map(), // lockKey -> Promise<atvId | null>
    switchingFromOmv: null,
    switchingToAtv: null,
    lastSwitchTime: 0,
    currentId: '',
    currentType: '',               // 'ATV' | 'OMV' | ''
    currentTitle: '',
    currentArtist: '',
    statusMsg: '纯享守护已就绪',
    cachedAuthHeader: null,
    cachedAuthExpireAt: 0,
  };

  const nativeFetch = window.fetch.bind(window);

  function log(...args) {
    console.log('%c[YTM-PureAudio v5.6]', 'color:#10b981;font-weight:bold;', ...args);
  }

  // ===========================================================================
  // 0. 跨会话持久化缓存 (`localStorage`) 与统一元数据构建
  // ===========================================================================

  let saveCacheTimer = null;

  function buildSyntheticRenderer({
    atvId,
    title,
    artist,
    byline,
    duration,
    thumb,
    bylineRuns,
    albumBrowseId,
  }) {
    if (!title && !byline) return null;
    const longRuns =
      Array.isArray(bylineRuns) && bylineRuns.length
        ? bylineRuns.map((r) =>
            r.browseId
              ? {
                  text: r.text,
                  navigationEndpoint: {
                    browseEndpoint: { browseId: r.browseId },
                  },
                }
              : { text: r.text }
          )
        : byline
        ? [{ text: byline }]
        : [];

    const synth = {
      videoId: atvId,
      title: title ? { runs: [{ text: title }] } : undefined,
      longBylineText: longRuns.length ? { runs: longRuns } : undefined,
      shortBylineText: artist ? { runs: [{ text: artist }] } : undefined,
      lengthText: duration ? { runs: [{ text: duration }] } : undefined,
      thumbnail: thumb
        ? { thumbnails: [{ url: thumb, width: 544, height: 544 }] }
        : undefined,
    };

    if (albumBrowseId) {
      synth.menu = {
        menuRenderer: {
          items: [
            {
              menuNavigationItemRenderer: {
                text: { runs: [{ text: '转到专辑' }] },
                icon: { iconType: 'ALBUM' },
                navigationEndpoint: {
                  browseEndpoint: { browseId: albumBrowseId },
                },
              },
            },
          ],
        },
      };
    }
    return synth;
  }

  function upsertAtvMetadata(atvId, fields = {}, omvId = null) {
    if (!atvId || STATE.knownOmvIds.has(atvId)) return null;

    const existing = STATE.atvToMeta.get(atvId);
    const title = fields.title || existing?.title || '';
    const artist = fields.artist || existing?.artist || '';
    const byline = fields.byline || existing?.byline || artist || '';
    const duration = fields.duration || existing?.duration || '';
    const thumb = fields.thumb || existing?.thumb || '';
    const bylineRuns = fields.bylineRuns || existing?.bylineRuns || null;
    const albumBrowseId = fields.albumBrowseId || existing?.albumBrowseId || '';

    if (fields.likeStatus && fields.likeStatus !== 'INDIFFERENT') {
      recordLikeStatus(atvId, title, artist, fields.likeStatus);
    }

    const finalLike =
      getKnownLikeStatus(
        atvId,
        omvId || STATE.atvToOmv.get(atvId),
        title,
        artist
      ) ||
      fields.likeStatus ||
      existing?.likeStatus ||
      'INDIFFERENT';

    const renderer =
      buildSyntheticRenderer({
        atvId,
        title,
        artist,
        byline,
        duration,
        thumb,
        bylineRuns,
        albumBrowseId,
      }) ||
      existing?.renderer ||
      null;

    const meta = {
      videoId: atvId,
      title,
      artist,
      byline,
      duration,
      thumb,
      bylineRuns,
      albumBrowseId,
      likeStatus: finalLike,
      renderer,
      ts: fields.ts || Date.now(),
    };

    STATE.atvToMeta.set(atvId, meta);
    STATE.knownAtvIds.add(atvId);
    if (title) {
      STATE.titleToAtv.set(normKey(title, artist), atvId);
    }
    if (omvId || STATE.atvToOmv.has(atvId)) {
      scheduleSavePersistentCache();
    }
    return meta;
  }

  function loadPersistentCache() {
    try {
      const raw = localStorage.getItem(PERSIST_CACHE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      const entries = Array.isArray(parsed?.entries) ? parsed.entries : [];
      const now = Date.now();

      for (const item of entries) {
        const { omvId, atvId } = item || {};
        if (!omvId || !atvId || omvId === atvId) continue;

        STATE.omvToAtv.set(omvId, atvId);
        STATE.atvToOmv.set(atvId, omvId);
        STATE.knownOmvIds.add(omvId);
        STATE.knownAtvIds.add(atvId);

        if (!STATE.atvToMeta.has(atvId)) {
          upsertAtvMetadata(atvId, {
            title: item.title || '',
            artist: item.artist || '',
            byline: item.byline || '',
            duration: item.duration || '',
            thumb: item.thumb || '',
            bylineRuns: Array.isArray(item.bylineRuns) ? item.bylineRuns : null,
            albumBrowseId: item.albumBrowseId || '',
            ts: item.ts || now,
          });
        }
      }
    } catch (e) {}
  }

  function scheduleSavePersistentCache() {
    if (saveCacheTimer) return;
    saveCacheTimer = setTimeout(() => {
      saveCacheTimer = null;
      try {
        const list = [];
        for (const [omvId, atvId] of STATE.omvToAtv.entries()) {
          const meta = STATE.atvToMeta.get(atvId);
          if (!meta || !meta.title) continue;
          list.push({
            omvId,
            atvId,
            title: meta.title,
            artist: meta.artist || '',
            byline: meta.byline || '',
            duration: meta.duration || '',
            thumb: meta.thumb || '',
            bylineRuns: meta.bylineRuns || undefined,
            albumBrowseId: meta.albumBrowseId || undefined,
            ts: meta.ts || Date.now(),
          });
        }
        if (list.length > MAX_PERSIST_ENTRIES) {
          list.sort((a, b) => (b.ts || 0) - (a.ts || 0));
          list.length = MAX_PERSIST_ENTRIES;
        }
        localStorage.setItem(
          PERSIST_CACHE_KEY,
          JSON.stringify({ v: 1, entries: list })
        );
      } catch (e) {}
    }, 1500);
  }

  function linkOmvAndAtv(omvId, atvId) {
    if (!omvId || !atvId || omvId === atvId) return;
    const isNew = STATE.omvToAtv.get(omvId) !== atvId;
    STATE.omvToAtv.set(omvId, atvId);
    STATE.atvToOmv.set(atvId, omvId);
    STATE.knownOmvIds.add(omvId);
    STATE.knownAtvIds.add(atvId);

    if (STATE.likeStatusMap.has(omvId) && !STATE.likeStatusMap.has(atvId)) {
      const st = STATE.likeStatusMap.get(omvId);
      if (st === 'LIKE' || st === 'DISLIKE') {
        STATE.likeStatusMap.set(atvId, st);
      }
    }
    if (isNew) {
      scheduleSavePersistentCache();
    }
  }

  // ===========================================================================
  // 1. 通用标题词根提取与相似度评分（无硬编码版本后缀）
  // ===========================================================================

  function hasMvTitlePollution(str) {
    if (!str) return false;
    return /\(music video\)|\[music video\]|music\s*video|official\s*(?:music\s*)?video|lyric\s*video|\bmv\b|\bpv\b|m\/v|full\s*ver|short\s*ver|[「『【].+[」』】]/i.test(
      str
    );
  }

  function stripMvTags(str) {
    return (str || '')
      .replace(
        /[\(\[【（][^)\]】）]*(?:official\s*(?:music\s*)?video|music\s*video|lyric\s*video|special\s*video|performance\s*video|official\s*audio|mv|pv|m\/v)[^)\]】）]*[\)\]】）]/gi,
        ''
      )
      .replace(
        /(?:[-–—|｜:：/／]\s*)?(?:official\s*(?:music\s*)?video|music\s*video|lyric\s*video|m\/v|\bmv\b|\bpv\b)\s*$/gi,
        ''
      )
      .replace(/\s+/g, ' ')
      .trim();
  }

  function extractCoreSongTitle(str) {
    const cleaned = stripMvTags(str);
    const quoteMatch = cleaned.match(/[「『《"]([^」』》"]+)[」』》"]/);
    if (quoteMatch && quoteMatch[1].trim().length >= 1) {
      return quoteMatch[1].trim();
    }
    return cleaned;
  }

  function extractBaseTitleRoot(str) {
    const core = extractCoreSongTitle(str);
    const stripped = core
      .replace(/[\(\[（【][^)）\]】]*[\)\]）】]/g, '')
      .replace(/\b(?:feat\.?|ft\.?)\s+.+$/i, '')
      .trim();
    return stripped || core;
  }

  function cleanArtistName(artist) {
    return (artist || '')
      .split(/[•·,&/／、]/)[0]
      .replace(/\s*-\s*topic$/i, '')
      .replace(/vevo$/i, '')
      .replace(/official\s*(?:youtube\s*)?channel$/i, '')
      .replace(/[\(\[（【][^)）\]】]*[\)\]）】]/g, '')
      .trim();
  }

  function simplifyForCompare(str) {
    return (str || '')
      .toLowerCase()
      .replace(/[\s\p{P}\p{S}]+/gu, '');
  }

  function normKey(title, artist) {
    const t = simplifyForCompare(extractBaseTitleRoot(title));
    const a = simplifyForCompare(cleanArtistName(artist));
    return `${t}|${a}`;
  }

  const DERIVATIVE_KEYWORDS = [
    'cover',
    'instrumental',
    'karaoke',
    'remix',
    'live',
    'acoustic',
    'slowed',
    'reverb',
    'nightcore',
    '8d',
    'inst.',
    '伴奏',
    '翻唱',
    'カラオケ',
  ];

  function hasUnwantedDerivativeKeyword(sourceRawTitle, candidateRawTitle) {
    const srcLower = (sourceRawTitle || '').toLowerCase();
    const candLower = (candidateRawTitle || '').toLowerCase();
    for (const kw of DERIVATIVE_KEYWORDS) {
      if (candLower.includes(kw) && !srcLower.includes(kw)) {
        return true;
      }
    }
    return false;
  }

  function scoreCandidateMatch(targetTitle, targetArtist, cand, rankIndex = 0) {
    if (cand.vType && cand.vType !== 'MUSIC_VIDEO_TYPE_ATV') return -100;
    if (hasUnwantedDerivativeKeyword(targetTitle, cand.itemTitle)) return -60;

    const fullTarget = simplifyForCompare(stripMvTags(targetTitle));
    const coreTarget = simplifyForCompare(extractCoreSongTitle(targetTitle));
    const rootTarget = simplifyForCompare(extractBaseTitleRoot(targetTitle));

    const coreCand = simplifyForCompare(extractCoreSongTitle(cand.itemTitle));
    const rootCand = simplifyForCompare(extractBaseTitleRoot(cand.itemTitle));

    if (!rootTarget || !rootCand) return -100;

    let titleScore = -50;
    if (coreTarget === coreCand || rootTarget === rootCand) {
      titleScore = 100;
    } else if (fullTarget.includes(rootCand) || rootCand.includes(rootTarget)) {
      const minLen = Math.min(rootTarget.length, rootCand.length);
      if (minLen >= 2) {
        titleScore = 80;
      } else if (minLen === 1 && fullTarget === rootCand) {
        titleScore = 80;
      }
    } else if (coreTarget.includes(coreCand) || coreCand.includes(coreTarget)) {
      const ratio =
        Math.min(coreTarget.length, coreCand.length) /
        Math.max(coreTarget.length, coreCand.length);
      if (ratio >= 0.5) {
        titleScore = Math.round(75 * ratio);
      }
    }

    if (titleScore < 0) return -50;

    let artistScore = 0;
    const aTarget = simplifyForCompare(cleanArtistName(targetArtist));
    const aCand = simplifyForCompare(cleanArtistName(cand.itemArtist));
    const bylineCand = simplifyForCompare(cand.itemByline);

    if (aTarget && (aCand || bylineCand)) {
      if (aTarget === aCand) {
        artistScore = 50;
      } else if (
        (aCand && (aTarget.includes(aCand) || aCand.includes(aTarget))) ||
        (bylineCand && bylineCand.includes(aTarget)) ||
        (aCand && fullTarget.includes(aCand))
      ) {
        artistScore = 35;
      }
    }

    const rankBonus = Math.max(0, 18 - rankIndex * 4);
    return titleScore + artistScore + rankBonus;
  }

  function recordLikeStatus(videoId, title, artist, status) {
    if (!status || status === 'INDIFFERENT') return;
    if (videoId) {
      STATE.likeStatusMap.set(videoId, status);
      if (STATE.omvToAtv.has(videoId)) {
        STATE.likeStatusMap.set(STATE.omvToAtv.get(videoId), status);
      }
    }
    if (title) {
      const k = normKey(title, artist);
      STATE.likeStatusMap.set(k, status);
      const rootOnly = simplifyForCompare(extractBaseTitleRoot(title));
      if (rootOnly) STATE.likeStatusMap.set(`root:${rootOnly}`, status);
    }
  }

  function getKnownLikeStatus(atvId, omvId, title, artist) {
    if (atvId && STATE.likeStatusMap.has(atvId)) {
      return STATE.likeStatusMap.get(atvId);
    }
    if (omvId && STATE.likeStatusMap.has(omvId)) {
      return STATE.likeStatusMap.get(omvId);
    }
    const meta = atvId ? STATE.atvToMeta.get(atvId) : null;
    if (meta?.likeStatus && meta.likeStatus !== 'INDIFFERENT') {
      return meta.likeStatus;
    }
    const t = title || meta?.title || '';
    const a = artist || meta?.artist || '';
    if (t) {
      const k = normKey(t, a);
      if (STATE.likeStatusMap.has(k)) return STATE.likeStatusMap.get(k);
      const rootOnly = simplifyForCompare(extractBaseTitleRoot(t));
      if (rootOnly && STATE.likeStatusMap.has(`root:${rootOnly}`)) {
        return STATE.likeStatusMap.get(`root:${rootOnly}`);
      }
    }
    return meta?.likeStatus || null;
  }

  function getInnerTubeConfig() {
    const apiKey = window.ytcfg?.get?.('INNERTUBE_API_KEY') || '';
    const hl = document.documentElement.lang || 'zh-CN';
    const gl = window.ytcfg?.get?.('GL') || 'US';
    const clientVersion =
      window.ytcfg?.get?.('INNERTUBE_CLIENT_VERSION') || '1.20260715.04.00';
    return {
      apiKey,
      context: {
        client: {
          clientName: 'WEB_REMIX',
          clientVersion,
          hl,
          gl,
        },
      },
    };
  }

  /**
   * 生成带 60 秒缓存的 SAPISIDHASH 登录态请求头，避免批量解析时重复执行 SHA-1
   */
  async function buildAuthenticatedHeaders() {
    const now = Date.now();
    if (STATE.cachedAuthHeader && now < STATE.cachedAuthExpireAt) {
      return Object.assign({}, STATE.cachedAuthHeader);
    }

    const headers = { 'Content-Type': 'application/json' };
    try {
      const m = document.cookie.match(
        /(?:^|;\s*)(?:SAPISID|__Secure-3PAPISID)=([^;]+)/
      );
      const sapisid = m ? decodeURIComponent(m[1]) : '';
      if (sapisid && window.crypto?.subtle) {
        const origin = 'https://music.youtube.com';
        const ts = Math.floor(now / 1000);
        const raw = `${ts} ${sapisid} ${origin}`;
        const buf = await window.crypto.subtle.digest(
          'SHA-1',
          new TextEncoder().encode(raw)
        );
        const hex = Array.from(new Uint8Array(buf))
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('');
        headers['Authorization'] = `SAPISIDHASH ${ts}_${hex}`;
        headers['X-Origin'] = origin;
        const sessionIdx = window.ytcfg?.get?.('SESSION_INDEX');
        if (sessionIdx !== undefined && sessionIdx !== null) {
          headers['X-Goog-AuthUser'] = String(sessionIdx);
        }
        const visitorId = window.ytcfg?.get?.('VISITOR_DATA');
        if (visitorId) {
          headers['X-Goog-Visitor-Id'] = visitorId;
        }
        STATE.cachedAuthHeader = Object.assign({}, headers);
        STATE.cachedAuthExpireAt = now + 60000;
      }
    } catch (e) {}
    return headers;
  }

  function findMusicVideoTypeDirect(obj) {
    if (!obj || typeof obj !== 'object') return '';
    return (
      obj.navigationEndpoint?.watchEndpoint?.watchEndpointMusicSupportedConfigs
        ?.watchEndpointMusicConfig?.musicVideoType ||
      obj.playNavigationEndpoint?.watchEndpoint
        ?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig
        ?.musicVideoType ||
      obj.overlay?.musicItemThumbnailOverlayRenderer?.content
        ?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint
        ?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig
        ?.musicVideoType ||
      obj.watchEndpoint?.watchEndpointMusicSupportedConfigs
        ?.watchEndpointMusicConfig?.musicVideoType ||
      obj.musicVideoType ||
      ''
    );
  }

  function extractLikeStatusFromMenu(menu) {
    if (!menu || typeof menu !== 'object') return null;
    const topButtons = menu.menuRenderer?.topLevelButtons;
    if (Array.isArray(topButtons)) {
      for (const btn of topButtons) {
        const st = btn?.likeButtonRenderer?.likeStatus;
        if (st) return st;
      }
    }
    const items = menu.menuRenderer?.items;
    if (Array.isArray(items)) {
      for (const it of items) {
        const st = it?.toggleMenuServiceItemRenderer?.defaultIcon?.iconType;
        if (st === 'FAVORITE' || st === 'LIKE') return 'LIKE';
      }
    }
    return null;
  }

  // ===========================================================================
  // 2. 按需采集页面数据与 DOM 中的个人点赞状态 (LIKE) 及纯音频元数据（告别高频轮询与 get_queue）
  // ===========================================================================

  /**
   * 直接从 `musicResponsiveListItemRenderer`（搜索结果/歌手页/浏览页）提取完整纯音频元数据与可点击专辑/歌手链接
   */
  function extractMetaFromResponsiveListItem(r, explicitAtvId) {
    if (!r) return null;
    let vId =
      explicitAtvId ||
      r.playlistItemData?.videoId ||
      r.overlay?.musicItemThumbnailOverlayRenderer?.content
        ?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint
        ?.videoId ||
      r.navigationEndpoint?.watchEndpoint?.videoId ||
      r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text
        ?.runs?.[0]?.navigationEndpoint?.watchEndpoint?.videoId ||
      '';
    if (!vId) return null;

    const itemTitle =
      r.flexColumns?.[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs
        ?.map((x) => x.text)
        .join('') || '';

    const rawSecondRuns =
      r.flexColumns?.[1]?.musicResponsiveListItemFlexColumnRenderer?.text
        ?.runs || [];
    // 若首项为无链接的类型标签（如 "歌曲 • " / "Song • "），自动剥离前缀
    let cleanRuns = rawSecondRuns;
    if (
      cleanRuns.length >= 3 &&
      !cleanRuns[0]?.navigationEndpoint &&
      /^(?:歌曲|song|单曲|视频|video)$/i.test((cleanRuns[0]?.text || '').trim()) &&
      /^[•·\s]+$/.test(cleanRuns[1]?.text || '')
    ) {
      cleanRuns = cleanRuns.slice(2);
    }

    const bylineRuns = [];
    let albumBrowseId = '';
    for (const run of cleanRuns) {
      const text = run?.text || '';
      if (/播放次数|次观看|views|plays/i.test(text)) continue;
      const bId =
        run?.navigationEndpoint?.browseEndpoint?.browseId || undefined;
      if (bId && bId.startsWith('MPREb_')) {
        albumBrowseId = bId;
      }
      bylineRuns.push({ text, browseId: bId });
    }
    // 清理末尾可能残留的分隔符 " • "
    while (
      bylineRuns.length &&
      /^[•·\s]+$/.test(bylineRuns[bylineRuns.length - 1].text)
    ) {
      bylineRuns.pop();
    }

    const thirdColRuns =
      r.flexColumns?.[2]?.musicResponsiveListItemFlexColumnRenderer?.text
        ?.runs || [];
    for (const run of thirdColRuns) {
      const bId = run?.navigationEndpoint?.browseEndpoint?.browseId;
      if (bId && bId.startsWith('MPREb_')) {
        if (!albumBrowseId) albumBrowseId = bId;
        if (!bylineRuns.some((br) => br.browseId === bId)) {
          if (bylineRuns.length) bylineRuns.push({ text: ' • ' });
          bylineRuns.push({ text: run.text || '', browseId: bId });
        }
      }
    }

    if (!albumBrowseId) {
      const menuItems = r.menu?.menuRenderer?.items;
      if (Array.isArray(menuItems)) {
        const albumItem = menuItems.find((it) =>
          it?.menuNavigationItemRenderer?.navigationEndpoint?.browseEndpoint?.browseId?.startsWith(
            'MPREb_'
          )
        );
        albumBrowseId =
          albumItem?.menuNavigationItemRenderer?.navigationEndpoint
            ?.browseEndpoint?.browseId || '';
      }
    }

    const itemByline = bylineRuns.map((x) => x.text).join('');
    const firstText = bylineRuns[0]?.text || '';
    const itemArtist = /播放次数|次观看|views|plays/i.test(firstText)
      ? ''
      : firstText;
    const itemDuration =
      r.fixedColumns?.[0]?.musicResponsiveListItemFixedColumnRenderer?.text
        ?.runs?.[0]?.text || '';
    const thumbs =
      r.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
    const thumb =
      thumbs[thumbs.length - 1]?.url?.replace(/=w\d+-h\d+/, '=w544-h544') ||
      thumbs[0]?.url ||
      '';
    const likeStatus = extractLikeStatusFromMenu(r.menu);

    return {
      vId,
      vType: findMusicVideoTypeDirect(r),
      itemTitle,
      itemArtist,
      itemByline,
      bylineRuns: bylineRuns.length ? bylineRuns : null,
      albumBrowseId,
      itemDuration,
      thumb,
      likeStatus,
    };
  }

  function storeAtvMetaFromExtracted(info, omvId = null) {
    if (!info?.vId) return null;
    return upsertAtvMetadata(
      info.vId,
      {
        title: info.itemTitle,
        artist: info.itemArtist,
        byline: info.itemByline,
        duration: info.itemDuration,
        thumb: info.thumb,
        bylineRuns: info.bylineRuns,
        albumBrowseId: info.albumBrowseId,
        likeStatus: info.likeStatus,
      },
      omvId
    );
  }

  function harvestTracksAndLikesFromData(
    node,
    candidatesOut = null,
    excludeOmvId = null
  ) {
    if (!node || typeof node !== 'object') return;

    const r = node.musicResponsiveListItemRenderer;
    if (r) {
      const info = extractMetaFromResponsiveListItem(r);
      if (!info?.vId) return;

      if (info.likeStatus && info.likeStatus !== 'INDIFFERENT') {
        recordLikeStatus(
          info.vId,
          info.itemTitle,
          info.itemArtist,
          info.likeStatus
        );
      }

      if (candidatesOut) {
        if (info.vId !== excludeOmvId && !STATE.knownOmvIds.has(info.vId)) {
          candidatesOut.push(info);
        }
        return;
      }

      if (info.vType === 'MUSIC_VIDEO_TYPE_ATV') {
        storeAtvMetaFromExtracted(info);
      } else if (info.vType === 'MUSIC_VIDEO_TYPE_OMV') {
        STATE.knownOmvIds.add(info.vId);
        if (info.itemTitle && !hasMvTitlePollution(info.itemTitle)) {
          STATE.omvToPageTitle.set(info.vId, info.itemTitle);
        }
      }
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        harvestTracksAndLikesFromData(item, candidatesOut, excludeOmvId);
      }
      return;
    }

    for (const k of Object.keys(node)) {
      const v = node[k];
      if (v && typeof v === 'object') {
        harvestTracksAndLikesFromData(v, candidatesOut, excludeOmvId);
      }
    }
  }

  // ===========================================================================
  // 3. 解析纯音频 (ATV) 与单次搜索直出完整元数据（彻底告别冗余 get_queue）
  // ===========================================================================

  function parseAndStoreQueueRenderer(renderer, explicitAtvId) {
    if (!renderer) return null;
    const atvId = explicitAtvId || renderer.videoId;
    if (!atvId || STATE.knownOmvIds.has(atvId)) return null;

    const title = renderer.title?.runs?.map((r) => r.text).join('') || '';
    const byline =
      renderer.longBylineText?.runs?.map((r) => r.text).join('') ||
      renderer.shortBylineText?.runs?.map((r) => r.text).join('') ||
      '';
    const artist =
      renderer.shortBylineText?.runs?.[0]?.text ||
      renderer.longBylineText?.runs?.[0]?.text ||
      '';
    const duration =
      renderer.lengthText?.runs?.map((r) => r.text).join('') || '';
    const thumbs = renderer.thumbnail?.thumbnails || [];
    const bestThumb =
      thumbs[thumbs.length - 1]?.url?.replace(/=w\d+-h\d+/, '=w544-h544') ||
      thumbs[0]?.url ||
      '';

    const bylineRuns = Array.isArray(renderer.longBylineText?.runs)
      ? renderer.longBylineText.runs.map((r) => ({
          text: r.text || '',
          browseId: r.navigationEndpoint?.browseEndpoint?.browseId || undefined,
        }))
      : null;

    let albumBrowseId = '';
    const menuItems = renderer.menu?.menuRenderer?.items;
    if (Array.isArray(menuItems)) {
      const albumItem = menuItems.find((it) =>
        it?.menuNavigationItemRenderer?.navigationEndpoint?.browseEndpoint?.browseId?.startsWith(
          'MPREb_'
        )
      );
      albumBrowseId =
        albumItem?.menuNavigationItemRenderer?.navigationEndpoint
          ?.browseEndpoint?.browseId || '';
    }

    return upsertAtvMetadata(atvId, {
      title,
      artist,
      byline,
      duration,
      thumb: bestThumb,
      bylineRuns,
      albumBrowseId,
      likeStatus: extractLikeStatusFromMenu(renderer.menu),
    });
  }

  async function resolveAtvForOmv(title, artist, excludeOmvId) {
    if (excludeOmvId && STATE.omvToAtv.has(excludeOmvId)) {
      const mappedId = STATE.omvToAtv.get(excludeOmvId);
      if (STATE.atvToMeta.get(mappedId)?.title) {
        return mappedId;
      }
    }

    if (excludeOmvId && STATE.unresolvableOmvIds.has(excludeOmvId)) {
      return null;
    }

    const effectiveTitle =
      (excludeOmvId && STATE.omvToPageTitle.get(excludeOmvId)) || title || '';
    const coreTitle = extractCoreSongTitle(effectiveTitle);
    if (!coreTitle) return null;

    const k1 = normKey(coreTitle, artist);
    if (STATE.titleToAtv.has(k1)) {
      const mappedId = STATE.titleToAtv.get(k1);
      if (
        mappedId &&
        mappedId !== excludeOmvId &&
        !STATE.knownOmvIds.has(mappedId) &&
        STATE.atvToMeta.get(mappedId)?.title
      ) {
        linkOmvAndAtv(excludeOmvId, mappedId);
        return mappedId;
      }
    }

    const lockKey = excludeOmvId || k1;
    if (STATE.pendingResolutions.has(lockKey)) {
      return STATE.pendingResolutions.get(lockKey);
    }

    const promise = (async () => {
      try {
        const { apiKey, context } = getInnerTubeConfig();
        const cleanedArtist = cleanArtistName(artist);
        const query = `${coreTitle} ${cleanedArtist}`.trim();
        const authHeaders = await buildAuthenticatedHeaders();
        const useAuth = Boolean(authHeaders['Authorization']);

        const res = await nativeFetch(
          `https://music.youtube.com/youtubei/v1/search?prettyPrint=false${
            apiKey ? `&key=${apiKey}` : ''
          }`,
          {
            method: 'POST',
            headers: authHeaders,
            body: JSON.stringify({
              context,
              query,
              params: 'EgWKAQIIAWoMEA4QChADEAQQCRAF', // 官方 Songs (仅纯音频歌曲) 过滤码
            }),
            credentials: useAuth ? 'same-origin' : 'omit',
          }
        );

        if (!res.ok) return null;
        const data = await res.json();

        const candidates = [];
        harvestTracksAndLikesFromData(data, candidates, excludeOmvId);

        let best = null;
        let bestScore = -Infinity;
        candidates.forEach((cand, idx) => {
          const s = scoreCandidateMatch(effectiveTitle, artist, cand, idx);
          if (s > bestScore) {
            bestScore = s;
            best = cand;
          }
        });

        if (best?.vId && bestScore >= 40) {
          linkOmvAndAtv(excludeOmvId, best.vId);
          storeAtvMetaFromExtracted(best, excludeOmvId);
          log(
            `🔍 匹配成功 [${excludeOmvId} -> ${best.vId}] (得分:${bestScore}, 点赞:${
              getKnownLikeStatus(
                best.vId,
                excludeOmvId,
                best.itemTitle,
                best.itemArtist
              ) || 'INDIFFERENT'
            }): ${best.itemTitle} - ${best.itemByline}`
          );
          return best.vId;
        } else {
          if (excludeOmvId) STATE.unresolvableOmvIds.add(excludeOmvId);
          log(
            `⚠️ 未找到高置信度纯音频匹配 (${effectiveTitle} - ${artist}), 保持原音源`
          );
        }
      } catch (e) {
        console.warn('[YTM-PureAudio] 搜索 ATV 异常:', e);
      }
      return null;
    })();

    STATE.pendingResolutions.set(lockKey, promise);
    try {
      return await promise;
    } finally {
      STATE.pendingResolutions.delete(lockKey);
    }
  }

  // ===========================================================================
  // 4. 幂等脏标记 (Stamp) 与零冗余队列/播放栏同步
  // ===========================================================================

  function replaceVideoIdDeep(obj, oldId, newId) {
    if (!obj || typeof obj !== 'object' || !oldId || !newId || oldId === newId) {
      return;
    }
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if ((k === 'videoId' || k === 'addedVideoId') && v === oldId) {
        obj[k] = newId;
      } else if (
        k === 'musicVideoType' &&
        (v === 'MUSIC_VIDEO_TYPE_OMV' || v === 'MUSIC_VIDEO_TYPE_UGC')
      ) {
        obj[k] = 'MUSIC_VIDEO_TYPE_ATV';
      } else if (Array.isArray(v)) {
        if (k === 'videoIds') {
          for (let i = 0; i < v.length; i++) {
            if (v[i] === oldId) v[i] = newId;
          }
        } else {
          for (const item of v) replaceVideoIdDeep(item, oldId, newId);
        }
      } else if (typeof v === 'object' && v !== null) {
        replaceVideoIdDeep(v, oldId, newId);
      }
    }
  }

  function applyLikeStatusDeep(obj, likeStatus) {
    if (!obj || typeof obj !== 'object' || !likeStatus) return;
    if (obj.likeButtonRenderer && typeof obj.likeButtonRenderer === 'object') {
      obj.likeButtonRenderer.likeStatus = likeStatus;
    }
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (v && typeof v === 'object') {
        applyLikeStatusDeep(v, likeStatus);
      }
    }
  }

  function mergeAlbumNavigationIntoMenu(targetMenu, pureMenu) {
    const targetItems = targetMenu?.menuRenderer?.items;
    const pureItems = pureMenu?.menuRenderer?.items;
    if (!Array.isArray(targetItems) || !Array.isArray(pureItems)) return;

    const hasAlbumLink = targetItems.some((it) =>
      it?.menuNavigationItemRenderer?.navigationEndpoint?.browseEndpoint?.browseId?.startsWith(
        'MPREb_'
      )
    );
    if (hasAlbumLink) return;

    const pureAlbumItem = pureItems.find((it) =>
      it?.menuNavigationItemRenderer?.navigationEndpoint?.browseEndpoint?.browseId?.startsWith(
        'MPREb_'
      )
    );
    if (pureAlbumItem) {
      targetItems.push(JSON.parse(JSON.stringify(pureAlbumItem)));
    }
  }

  function applyPureMetadataToQueueRenderer(targetRenderer, oldOmvId, atvId) {
    if (!targetRenderer || !atvId) return;

    const meta = STATE.atvToMeta.get(atvId);
    const knownLike =
      getKnownLikeStatus(atvId, oldOmvId, meta?.title, meta?.artist) ||
      'INDIFFERENT';

    // O(1) 幂等短路：如果该队列项已经被净化为同一个 atvId 且状态未变，直接跳过！
    if (
      targetRenderer.videoId === atvId &&
      targetRenderer.__ytmPurifiedAtvId === atvId &&
      targetRenderer.__ytmPurifiedLike === knownLike
    ) {
      return;
    }

    const existingTitle = (
      targetRenderer.title?.runs?.map((x) => x.text).join('') || ''
    ).trim();
    const pureTitle = (meta?.title || '').trim();
    const shouldPreserveExistingTitle =
      Boolean(existingTitle) &&
      !hasMvTitlePollution(existingTitle) &&
      (!pureTitle ||
        (simplifyForCompare(extractBaseTitleRoot(existingTitle)) ===
          simplifyForCompare(extractBaseTitleRoot(pureTitle)) &&
          existingTitle.length >= pureTitle.length));

    if (shouldPreserveExistingTitle && meta && existingTitle !== pureTitle) {
      meta.title = existingTitle;
      if (meta.renderer?.title?.runs) {
        meta.renderer.title = JSON.parse(JSON.stringify(targetRenderer.title));
      }
    }

    const targetOldId = oldOmvId || targetRenderer.videoId;
    if (targetOldId && targetOldId !== atvId) {
      replaceVideoIdDeep(targetRenderer, targetOldId, atvId);
    }
    targetRenderer.videoId = atvId;

    const pureR = meta?.renderer;
    if (pureR) {
      if (pureR.title && !shouldPreserveExistingTitle) {
        targetRenderer.title = JSON.parse(JSON.stringify(pureR.title));
      }
      if (pureR.longBylineText) {
        targetRenderer.longBylineText = JSON.parse(
          JSON.stringify(pureR.longBylineText)
        );
      }
      if (pureR.shortBylineText) {
        targetRenderer.shortBylineText = JSON.parse(
          JSON.stringify(pureR.shortBylineText)
        );
      }
      if (pureR.thumbnail) {
        targetRenderer.thumbnail = JSON.parse(JSON.stringify(pureR.thumbnail));
      }
      if (pureR.lengthText) {
        targetRenderer.lengthText = JSON.parse(
          JSON.stringify(pureR.lengthText)
        );
      }
      if (pureR.menu && targetRenderer.menu) {
        mergeAlbumNavigationIntoMenu(targetRenderer.menu, pureR.menu);
      } else if (pureR.menu && !targetRenderer.menu) {
        targetRenderer.menu = JSON.parse(JSON.stringify(pureR.menu));
      }
    }

    if (knownLike && knownLike !== 'INDIFFERENT' && targetRenderer.menu) {
      applyLikeStatusDeep(targetRenderer.menu, knownLike);
    }

    targetRenderer.__ytmPurifiedAtvId = atvId;
    targetRenderer.__ytmPurifiedLike = knownLike;
  }

  function applyPureMetadataToQueueItem(qItem, oldOmvId, atvId) {
    if (!qItem || !atvId) return;
    const wrapper = qItem.playlistPanelVideoWrapperRenderer;
    if (wrapper) {
      const primary = wrapper.primaryRenderer?.playlistPanelVideoRenderer;
      if (primary) {
        applyPureMetadataToQueueRenderer(primary, oldOmvId, atvId);
      }
      if (Array.isArray(wrapper.counterpart)) {
        for (const cp of wrapper.counterpart) {
          const cpR = cp?.counterpartRenderer?.playlistPanelVideoRenderer;
          if (cpR) {
            applyPureMetadataToQueueRenderer(cpR, oldOmvId, atvId);
          }
        }
      }
      return;
    }
    const r = qItem.playlistPanelVideoRenderer || qItem;
    applyPureMetadataToQueueRenderer(r, oldOmvId, atvId);
  }

  /**
   * 通过 Polymer 原生 `.text = { runs: [...] }` 接口更新 `<yt-formatted-string>`，
   * 严禁调用 `el.textContent = ...` 或手动增删子节点，防止破坏 `<yt-formatted-string>` 内部持有的
   * `this.textNode` / `<dom-repeat>` 引用导致切歌时新旧歌名拼接！
   */
  function setFormattedStringRuns(el, runs, fallbackText = '') {
    if (!el) return;
    const normalizedRuns =
      Array.isArray(runs) && runs.length > 0
        ? runs
        : fallbackText
        ? [{ text: fallbackText }]
        : null;
    if (!normalizedRuns) return;

    const targetText = normalizedRuns
      .map((r) => r.text || '')
      .join('')
      .trim();
    if (!targetText) return;

    const currentText = (el.textContent || '').trim();
    const hasMvBylineNoise = /观看|views|回視聴|人赞|likes/i.test(currentText);

    if (
      currentText === targetText &&
      !hasMvBylineNoise &&
      !el.hasAttribute('is-empty')
    ) {
      if (el.getAttribute('title') !== targetText) {
        el.setAttribute('title', targetText);
      }
      return;
    }

    const formattedObj = {
      runs: JSON.parse(JSON.stringify(normalizedRuns)),
    };

    try {
      el.text = formattedObj;
      if (el.polymerController && el.polymerController !== el) {
        el.polymerController.text = formattedObj;
      }
    } catch (e) {}

    el.removeAttribute('is-empty');
    el.removeAttribute('hidden');
    if (el.getAttribute('title') !== targetText) {
      el.setAttribute('title', targetText);
    }
  }

  function getAppReduxState() {
    const candidates = [
      document.querySelector('ytmusic-player-queue'),
      document.querySelector('ytmusic-player-bar'),
      document.querySelector('ytmusic-player-page'),
      document.querySelector('ytmusic-app'),
    ];
    for (const el of candidates) {
      if (!el) continue;
      const ctrl = el.polymerController || el;
      try {
        if (typeof ctrl.getState === 'function') return ctrl.getState();
        if (typeof el.getState === 'function') return el.getState();
        if (typeof ctrl.store?.getState === 'function') {
          return ctrl.store.getState();
        }
        if (typeof el.store?.getState === 'function') {
          return el.store.getState();
        }
      } catch (e) {}
    }
    return null;
  }

  /**
   * 从当前播放队列（DOM `<ytmusic-player-queue-item>` 或 Redux `queue.items`）中
   * 查找正在播放曲目的完整 `playlistPanelVideoRenderer`（保留“（合作音乐人：...）”等完整队列歌名）
   */
  function findActiveQueueRenderer(targetVideoId) {
    const queueItemEls = document.querySelectorAll('ytmusic-player-queue-item');
    let selectedRenderer = null;

    for (const row of queueItemEls) {
      const rowData =
        row.data || row.__data?.data || row.polymerController?.data;
      if (!rowData) continue;
      if (targetVideoId && rowData.videoId === targetVideoId) {
        return rowData;
      }
      if (row.hasAttribute('selected')) {
        selectedRenderer = rowData;
      }
    }

    if (selectedRenderer) return selectedRenderer;

    const state = getAppReduxState();
    const qItems = state?.queue?.items;
    if (Array.isArray(qItems)) {
      for (const qItem of qItems) {
        const r =
          qItem?.playlistPanelVideoRenderer ||
          qItem?.playlistPanelVideoWrapperRenderer?.primaryRenderer
            ?.playlistPanelVideoRenderer ||
          qItem;
        if (!r) continue;
        if (targetVideoId && r.videoId === targetVideoId) return r;
        if (r.selected) selectedRenderer = r;
      }
    }
    return selectedRenderer;
  }

  /**
   * 当播放控制栏（`ytmusic-player-bar`）在上一首/下一首切歌后出现标题空白（`is-empty`）时，
   * 优先从播放列表队列项同步完整歌名（包含 `（合作音乐人：...）`）与副标题，并通过 Polymer `.text` 写入。
   */
  function syncPlayerBarWithActiveQueueItem(liveVideoId, fallbackTitle = '') {
    const bar = document.querySelector('ytmusic-player-bar');
    if (!bar) return;
    const titleEl = bar.querySelector('.title.ytmusic-player-bar');
    if (!titleEl) return;

    const curText = (titleEl.textContent || '').trim();
    if (!titleEl.hasAttribute('is-empty') && curText) return;

    const activeRenderer = findActiveQueueRenderer(liveVideoId);
    const queueTitleRuns = activeRenderer?.title?.runs;
    const queueTitleText = (
      queueTitleRuns?.map((r) => r.text || '').join('') || ''
    ).trim();

    if (queueTitleText && !hasMvTitlePollution(queueTitleText)) {
      setFormattedStringRuns(titleEl, queueTitleRuns, queueTitleText);
    } else if (fallbackTitle) {
      setFormattedStringRuns(titleEl, null, fallbackTitle);
    }

    const bylineEl = bar.querySelector('.byline.ytmusic-player-bar');
    if (
      bylineEl &&
      (bylineEl.hasAttribute('is-empty') || !(bylineEl.textContent || '').trim())
    ) {
      const bylineRuns =
        activeRenderer?.longBylineText?.runs ||
        activeRenderer?.shortBylineText?.runs;
      if (Array.isArray(bylineRuns) && bylineRuns.length > 0) {
        setFormattedStringRuns(bylineEl, bylineRuns);
      }
    }
  }

  function renderFormattedBylineDom(bylineEl, meta, activeRenderer = null) {
    if (!bylineEl) return;
    const runs =
      meta?.renderer?.longBylineText?.runs ||
      activeRenderer?.longBylineText?.runs ||
      meta?.renderer?.shortBylineText?.runs ||
      activeRenderer?.shortBylineText?.runs;
    const targetText = (meta?.byline || meta?.artist || '').trim();
    setFormattedStringRuns(bylineEl, runs, targetText);
  }

  function syncPlayerBarLikeButtonDom(bar, atvId, oldOmvId, meta) {
    const likeBtn = bar?.querySelector(
      '#like-button-renderer, ytmusic-like-button-renderer'
    );
    if (!likeBtn) return;

    const knownLike = getKnownLikeStatus(
      atvId,
      oldOmvId,
      meta?.title,
      meta?.artist
    );

    const likeData =
      likeBtn.data ||
      likeBtn.__data?.data ||
      likeBtn.polymerController?.data ||
      null;
    if (likeData) {
      if (oldOmvId && oldOmvId !== atvId) {
        replaceVideoIdDeep(likeData, oldOmvId, atvId);
      }
      if (likeData.target?.videoId) likeData.target.videoId = atvId;
      if (knownLike) likeData.likeStatus = knownLike;
    }

    if (knownLike) {
      if (likeBtn.getAttribute('like-status') !== knownLike) {
        likeBtn.setAttribute('like-status', knownLike);
      }
      try {
        if ('likeStatus' in likeBtn && likeBtn.likeStatus !== knownLike) {
          likeBtn.likeStatus = knownLike;
        }
      } catch (e) {}

      const likeShapeBtn = likeBtn.querySelector('#button-shape-like button');
      if (likeShapeBtn) {
        const pressed = knownLike === 'LIKE' ? 'true' : 'false';
        if (likeShapeBtn.getAttribute('aria-pressed') !== pressed) {
          likeShapeBtn.setAttribute('aria-pressed', pressed);
        }
      }
      const dislikeShapeBtn = likeBtn.querySelector(
        '#button-shape-dislike button'
      );
      if (dislikeShapeBtn) {
        const pressed = knownLike === 'DISLIKE' ? 'true' : 'false';
        if (dislikeShapeBtn.getAttribute('aria-pressed') !== pressed) {
          dislikeShapeBtn.setAttribute('aria-pressed', pressed);
        }
      }
    }
  }

  function syncQueueItemsInDomAndStore() {
    if (STATE.omvToAtv.size === 0) return;

    try {
      const state = getAppReduxState();
      const qItems = state?.queue?.items;
      if (Array.isArray(qItems)) {
        for (const qItem of qItems) {
          const wrapper = qItem?.playlistPanelVideoWrapperRenderer;
          const r =
            qItem?.playlistPanelVideoRenderer ||
            wrapper?.primaryRenderer?.playlistPanelVideoRenderer ||
            qItem;
          const vid = r?.videoId;
          if (!vid) continue;

          if (STATE.omvToAtv.has(vid)) {
            const atvId = STATE.omvToAtv.get(vid);
            applyPureMetadataToQueueItem(qItem, vid, atvId);
          } else if (STATE.atvToOmv.has(vid)) {
            applyPureMetadataToQueueItem(
              qItem,
              STATE.atvToOmv.get(vid),
              vid
            );
          } else if (Array.isArray(wrapper?.counterpart)) {
            for (const cp of wrapper.counterpart) {
              const cpR = cp?.counterpartRenderer?.playlistPanelVideoRenderer;
              if (cpR?.videoId && cpR.videoId !== vid) {
                linkOmvAndAtv(cpR.videoId, vid);
                applyPureMetadataToQueueRenderer(cpR, cpR.videoId, vid);
              }
            }
          }
        }
      }

      const queueItemEls = document.querySelectorAll(
        'ytmusic-player-queue-item'
      );
      for (const row of queueItemEls) {
        const rowData =
          row.data || row.__data?.data || row.polymerController?.data;
        const rawVid = rowData?.videoId;
        let atvId = null;
        let omvId = null;

        if (rawVid && STATE.omvToAtv.has(rawVid)) {
          omvId = rawVid;
          atvId = STATE.omvToAtv.get(rawVid);
        } else if (rawVid && STATE.atvToOmv.has(rawVid)) {
          atvId = rawVid;
          omvId = STATE.atvToOmv.get(rawVid);
        } else if (
          row.hasAttribute('selected') &&
          STATE.currentType === 'ATV' &&
          STATE.currentId &&
          STATE.atvToOmv.has(STATE.currentId)
        ) {
          atvId = STATE.currentId;
          omvId = STATE.atvToOmv.get(atvId) || rawVid || null;
        }

        if (!atvId) continue;
        const meta = STATE.atvToMeta.get(atvId);
        if (!meta) continue;

        const knownLike =
          getKnownLikeStatus(atvId, omvId, meta.title, meta.artist) ||
          'INDIFFERENT';

        if (rowData) {
          applyPureMetadataToQueueRenderer(rowData, omvId || rawVid, atvId);
        }

        const titleEl = row.querySelector(
          '.song-title.ytmusic-player-queue-item, .song-title'
        );
        const preferredTitleRuns = rowData?.title?.runs || meta.renderer?.title?.runs;
        const preferredTitleText =
          (rowData?.title?.runs?.map((x) => x.text).join('') || '').trim() ||
          meta.title;

        if (
          row.__ytmPurifiedAtvId === atvId &&
          row.__ytmPurifiedLike === knownLike &&
          (!titleEl ||
            !preferredTitleText ||
            (titleEl.textContent || '').trim() === preferredTitleText) &&
          !titleEl?.hasAttribute('is-empty')
        ) {
          continue;
        }

        const targetOldId = omvId || rawVid;
        if (targetOldId && targetOldId !== atvId) {
          const playBtn = row.querySelector(
            'ytmusic-play-button-renderer#play-button, ytmusic-play-button-renderer'
          );
          const playBtnData =
            playBtn?.data ||
            playBtn?.__data?.data ||
            playBtn?.polymerController?.data;
          if (playBtnData) {
            replaceVideoIdDeep(playBtnData, targetOldId, atvId);
          }

          const menuEl = row.querySelector('ytmusic-menu-renderer.menu');
          const menuData =
            menuEl?.data ||
            menuEl?.__data?.data ||
            menuEl?.polymerController?.data;
          if (menuData) {
            replaceVideoIdDeep(menuData, targetOldId, atvId);
          }
        }

        if (titleEl && preferredTitleText) {
          setFormattedStringRuns(titleEl, preferredTitleRuns, preferredTitleText);
        }

        const bylineEl = row.querySelector(
          '.byline.ytmusic-player-queue-item, .byline'
        );
        if (bylineEl && meta.artist) {
          setFormattedStringRuns(
            bylineEl,
            rowData?.shortBylineText?.runs || meta.renderer?.shortBylineText?.runs,
            meta.artist
          );
        }

        const durEl = row.querySelector(
          '.duration.ytmusic-player-queue-item, .duration'
        );
        if (durEl && meta.duration) {
          setFormattedStringRuns(
            durEl,
            rowData?.lengthText?.runs || meta.renderer?.lengthText?.runs,
            meta.duration
          );
        }

        const imgEl = row.querySelector('yt-img-shadow.thumbnail img, #img');
        if (imgEl && meta.thumb && imgEl.src !== meta.thumb) {
          imgEl.src = meta.thumb;
        }

        row.__ytmPurifiedAtvId = atvId;
        row.__ytmPurifiedLike = knownLike;
      }
    } catch (e) {
      console.warn('[YTM-PureAudio] 同步队列 DOM 异常:', e);
    }
  }

  function syncDomPlayerBarMetadata(atvId, oldOmvId) {
    const resolvedOmvId = oldOmvId || STATE.atvToOmv.get(atvId) || null;
    if (!resolvedOmvId) return;

    const meta = STATE.atvToMeta.get(atvId);
    const activeRenderer = findActiveQueueRenderer(atvId);

    try {
      const playerPage = document.querySelector('ytmusic-player-page');
      if (playerPage && playerPage.hasAttribute('video-mode')) {
        playerPage.removeAttribute('video-mode');
      }

      const ytmPlayer = document.querySelector('ytmusic-player');
      if (ytmPlayer) {
        if (ytmPlayer.hasAttribute('video-mode')) {
          ytmPlayer.removeAttribute('video-mode');
        }
        const mainPlayerImg = ytmPlayer.querySelector('#song-image img');
        if (mainPlayerImg && meta?.thumb && mainPlayerImg.src !== meta.thumb) {
          mainPlayerImg.src = meta.thumb;
        }
      }

      const bar = document.querySelector('ytmusic-player-bar');
      if (bar) {
        if (bar.hasAttribute('is-video')) {
          bar.removeAttribute('is-video');
        }

        if (meta || activeRenderer) {
          const titleEl = bar.querySelector('.title.ytmusic-player-bar');
          if (titleEl) {
            const activeTitleRuns = activeRenderer?.title?.runs;
            const activeTitleText = (
              activeTitleRuns?.map((r) => r.text || '').join('') || ''
            ).trim();
            const useActiveQueueTitle =
              Boolean(activeTitleText) &&
              !hasMvTitlePollution(activeTitleText) &&
              (!meta?.title ||
                simplifyForCompare(extractBaseTitleRoot(activeTitleText)) ===
                  simplifyForCompare(extractBaseTitleRoot(meta.title)));

            const targetRuns = useActiveQueueTitle
              ? activeTitleRuns
              : meta?.renderer?.title?.runs;
            const targetTitle = useActiveQueueTitle
              ? activeTitleText
              : meta?.title || activeTitleText;

            if (targetTitle) {
              setFormattedStringRuns(titleEl, targetRuns, targetTitle);
            }
          }

          const bylineEl = bar.querySelector('.byline.ytmusic-player-bar');
          if (bylineEl) {
            renderFormattedBylineDom(bylineEl, meta, activeRenderer);
          }

          const barImg = bar.querySelector('img.image.ytmusic-player-bar');
          if (barImg && meta?.thumb && barImg.src !== meta.thumb) {
            barImg.src = meta.thumb;
          }
        }

        syncPlayerBarLikeButtonDom(bar, atvId, resolvedOmvId, meta);
      }

      syncQueueItemsInDomAndStore();
    } catch (e) {
      console.warn('[YTM-PureAudio] 同步 DOM 歌曲信息异常:', e);
    }
  }

  // ===========================================================================
  // 5. 全链路网络拦截（`/next`、`/player`、`/browse`、`/search` 及 `/like/*`、`/edit_playlist`）
  // ===========================================================================

  async function readFetchBodyText(input, init) {
    try {
      if (typeof init?.body === 'string') return init.body;
      if (input instanceof Request) {
        return await input.clone().text();
      }
    } catch (e) {}
    return '';
  }

  async function readAndModifyFetchRequest(input, init, modifierFn) {
    try {
      const bodyText = await readFetchBodyText(input, init);
      if (!bodyText) return { input, init };
      const modifiedText = await modifierFn(bodyText);
      if (modifiedText && modifiedText !== bodyText) {
        if (input instanceof Request) {
          const mergedInit = Object.assign({}, init || {}, {
            body: modifiedText,
          });
          const newReq = new Request(input, mergedInit);
          return { input: newReq, init: undefined };
        }
        return {
          input,
          init: Object.assign({}, init, { body: modifiedText }),
        };
      }
    } catch (e) {}
    return { input, init };
  }

  function rewriteActionRequestBodySync(bodyText, url = '') {
    if (!bodyText) return null;
    try {
      const json = JSON.parse(bodyText);

      const targetVid = json.target?.videoId;
      if (targetVid && url.includes('/youtubei/v1/like/')) {
        const newLikeStatus = url.includes('/like/like')
          ? 'LIKE'
          : url.includes('/like/dislike')
          ? 'DISLIKE'
          : 'INDIFFERENT';
        const mappedAtv = STATE.omvToAtv.get(targetVid) || targetVid;
        STATE.likeStatusMap.set(mappedAtv, newLikeStatus);
        STATE.likeStatusMap.set(targetVid, newLikeStatus);
        const meta = STATE.atvToMeta.get(mappedAtv);
        if (meta) meta.likeStatus = newLikeStatus;
      }

      if (!STATE.enabled || STATE.omvToAtv.size === 0) return null;

      let changed = false;
      for (const [omvId, atvId] of STATE.omvToAtv.entries()) {
        if (bodyText.includes(omvId)) {
          replaceVideoIdDeep(json, omvId, atvId);
          changed = true;
          log(
            `🛡️ [防污染拦截] 已将点赞/歌单操作的目标从 MV (${omvId}) 修正为纯音频 (${atvId})`
          );
          STATE.statusMsg = `👍 已确保收藏的是纯享版 (${atvId})`;
          updateFloatingCapsule();
        }
      }
      return changed ? JSON.stringify(json) : null;
    } catch (e) {}
    return null;
  }

  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';

    // -------------------------------------------------------------------------
    // A. 终极防污染锁：拦截“点赞 (like/*)”与“加入歌单 (edit_playlist / get_add_to_playlist)”请求
    // -------------------------------------------------------------------------
    if (
      url.includes('/youtubei/v1/like/') ||
      url.includes('/youtubei/v1/browse/edit_playlist') ||
      url.includes('/youtubei/v1/playlist/get_add_to_playlist')
    ) {
      const wrapped = await readAndModifyFetchRequest(
        input,
        init,
        async (bodyText) => rewriteActionRequestBodySync(bodyText, url)
      );
      input = wrapped.input;
      init = wrapped.init;
    }

    // -------------------------------------------------------------------------
    // B. 拦截 `/youtubei/v1/player` 请求体中的已知 MV ID，并提取 `/youtubei/v1/next` 请求体中的 reqVideoId
    // -------------------------------------------------------------------------
    let nextReqVideoId = '';
    let playerOrigBodyText = '';
    let playerReqVideoId = '';
    if (url.includes('/youtubei/v1/next')) {
      const bodyText = await readFetchBodyText(input, init);
      if (bodyText) {
        try {
          const reqJson = JSON.parse(bodyText);
          nextReqVideoId = reqJson.videoId || '';
        } catch (e) {}
      }
    } else if (STATE.enabled && url.includes('/youtubei/v1/player')) {
      playerOrigBodyText = await readFetchBodyText(input, init);
      if (playerOrigBodyText) {
        try {
          const parsedReq = JSON.parse(playerOrigBodyText);
          playerReqVideoId = parsedReq.videoId || '';
          if (playerReqVideoId && STATE.omvToAtv.has(playerReqVideoId)) {
            const atvId = STATE.omvToAtv.get(playerReqVideoId);
            log(
              `[Player 请求净化] 命中缓存，直接将请求 videoId 从 MV (${playerReqVideoId}) 替换为纯音频 (${atvId})`
            );
            parsedReq.videoId = atvId;
            playerReqVideoId = atvId;
            const newBody = JSON.stringify(parsedReq);
            if (input instanceof Request) {
              input = new Request(
                input,
                Object.assign({}, init || {}, { body: newBody })
              );
              init = undefined;
            } else {
              init = Object.assign({}, init, { body: newBody });
            }
          }
        } catch (e) {}
      }
    }

    let response = await nativeFetch(input, init);

    if (
      url.includes('/youtubei/v1/browse') ||
      url.includes('/youtubei/v1/search')
    ) {
      try {
        response
          .clone()
          .json()
          .then((data) => harvestTracksAndLikesFromData(data))
          .catch(() => {});
      } catch (e) {}
      return response;
    }

    // -------------------------------------------------------------------------
    // C. `/youtubei/v1/player` 响应处理：
    //    若已知请求的是纯音频 (ATV)，采用异步非阻塞旁路更新状态，0 延迟把响应交还给页面！
    // -------------------------------------------------------------------------
    if (url.includes('/youtubei/v1/player')) {
      if (
        !STATE.enabled ||
        (playerReqVideoId &&
          STATE.knownAtvIds.has(playerReqVideoId) &&
          !STATE.knownOmvIds.has(playerReqVideoId))
      ) {
        response
          .clone()
          .json()
          .then((data) => inspectPlayerResponse(data))
          .catch(() => {});
        return response;
      }

      try {
        const cloned = response.clone();
        const data = await cloned.json();
        const vd = data?.videoDetails;
        const vId = vd?.videoId || '';
        const vType = vd?.musicVideoType || '';
        const isOmv =
          vType === 'MUSIC_VIDEO_TYPE_OMV' ||
          STATE.knownOmvIds.has(vId) ||
          hasMvTitlePollution(vd?.title || '');

        if (
          STATE.enabled &&
          isOmv &&
          vId &&
          playerOrigBodyText &&
          !STATE.unresolvableOmvIds.has(vId)
        ) {
          const atvId = await resolveAtvForOmv(
            vd?.title || '',
            vd?.author || '',
            vId
          );
          if (atvId && atvId !== vId) {
            const reqJson = JSON.parse(playerOrigBodyText);
            reqJson.videoId = atvId;
            const retryWrapped = await readAndModifyFetchRequest(
              input,
              init,
              async () => JSON.stringify(reqJson)
            );
            const purePlayerRes = await nativeFetch(
              retryWrapped.input,
              retryWrapped.init
            );
            if (purePlayerRes.ok) {
              response = purePlayerRes;
              response
                .clone()
                .json()
                .then((pureData) => inspectPlayerResponse(pureData))
                .catch(() => {});
              return response;
            }
          }
        }
        setTimeout(() => inspectPlayerResponse(data), 0);
      } catch (e) {}
      return response;
    }

    // -------------------------------------------------------------------------
    // D. `/youtubei/v1/next` 响应双阶段自适应队列净化
    // -------------------------------------------------------------------------
    if (url.includes('/youtubei/v1/next')) {
      try {
        const cloned = response.clone();
        const data = await cloned.json();
        const modified = await processNextResponseJson(data, nextReqVideoId);
        if (modified) {
          setTimeout(() => syncQueueItemsInDomAndStore(), 120);
          return new Response(JSON.stringify(data), {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }
      } catch (e) {
        console.warn('[YTM-PureAudio] 处理 /next 响应异常:', e);
      }
    }

    return response;
  };

  // ===========================================================================
  // 6. 双阶段自适应队列净化引擎（极速首播拦截 + 呼吸节流全队列后台工作流）
  // ===========================================================================

  function collectPlaylistPanels(node, out = []) {
    if (!node || typeof node !== 'object') return out;
    if (
      Array.isArray(node.contents) &&
      (node.playlistId ||
        node.isInfinite !== undefined ||
        node.contents[0]?.playlistPanelVideoRenderer ||
        node.contents[0]?.playlistPanelVideoWrapperRenderer)
    ) {
      out.push(node);
      return out;
    }
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (v && typeof v === 'object') {
        collectPlaylistPanels(v, out);
      }
    }
    return out;
  }

  function extractCounterpartAtv(wrapper) {
    const counterparts = wrapper?.counterpart;
    if (!Array.isArray(counterparts)) return null;
    for (const cp of counterparts) {
      const cpRenderer = cp?.counterpartRenderer?.playlistPanelVideoRenderer;
      if (
        cpRenderer?.videoId &&
        findMusicVideoTypeDirect(cpRenderer) === 'MUSIC_VIDEO_TYPE_ATV'
      ) {
        parseAndStoreQueueRenderer(cpRenderer, cpRenderer.videoId);
        return cpRenderer.videoId;
      }
    }
    return null;
  }

  function waitIdleAndDelay(ms = 280) {
    return new Promise((resolve) => {
      setTimeout(() => {
        if (typeof window.requestIdleCallback === 'function') {
          window.requestIdleCallback(() => resolve(), { timeout: 600 });
        } else {
          resolve();
        }
      }, ms);
    });
  }

  let activeBgWorkerId = 0;

  /**
   * 阶段二：后台渐进式全队列净化工作流（带微节流与空闲帧调度，绝不阻塞主线程滚动与动画）
   */
  function startProgressiveQueuePurifier(entries) {
    if (!entries.length) return;
    const workerId = ++activeBgWorkerId;
    const BATCH_SIZE = 4;

    (async () => {
      for (let i = 0; i < entries.length; i += BATCH_SIZE) {
        if (workerId !== activeBgWorkerId || !STATE.enabled) return;
        const batch = entries.slice(i, i + BATCH_SIZE);
        const resolvedInBatch = [];

        await Promise.all(
          batch.map(async (entry) => {
            if (!entry.knownAtvId) {
              entry.knownAtvId = await resolveAtvForOmv(
                entry.title,
                entry.artist,
                entry.omvId
              );
            }
            if (entry.knownAtvId && entry.knownAtvId !== entry.omvId) {
              resolvedInBatch.push(entry);
            }
          })
        );

        if (workerId !== activeBgWorkerId || !STATE.enabled) return;

        if (resolvedInBatch.length) {
          for (const entry of resolvedInBatch) {
            linkOmvAndAtv(entry.omvId, entry.knownAtvId);
            if (entry.item) {
              applyPureMetadataToQueueItem(
                entry.item,
                entry.omvId,
                entry.knownAtvId
              );
            } else if (entry.r) {
              applyPureMetadataToQueueRenderer(
                entry.r,
                entry.omvId,
                entry.knownAtvId
              );
            }
          }
          syncQueueItemsInDomAndStore();
        }

        // 批次间呼吸停顿 + 等待浏览器空闲帧，避免连续网络与 DOM 更新造成主线程掉帧
        if (i + BATCH_SIZE < entries.length) {
          await waitIdleAndDelay(280);
        }
      }
    })();
  }

  /**
   * 同步 `/next` 响应顶层的 `currentVideoEndpoint` 与 `playerOverlays`（用于切歌时 enablePersistentPlaylistPanel 不返回队列列表的场景）
   */
  function syncNextResponseTopLevelEndpoints(data, reqVideoId) {
    if (!data || !STATE.enabled) return false;
    const curEndVid = data.currentVideoEndpoint?.watchEndpoint?.videoId || '';
    let omvId = null;
    let atvId = null;

    if (curEndVid && STATE.omvToAtv.has(curEndVid)) {
      omvId = curEndVid;
      atvId = STATE.omvToAtv.get(curEndVid);
    } else if (
      reqVideoId &&
      STATE.knownAtvIds.has(reqVideoId) &&
      curEndVid &&
      curEndVid !== reqVideoId
    ) {
      omvId = curEndVid;
      atvId = reqVideoId;
      linkOmvAndAtv(omvId, atvId);
    }

    if (!omvId || !atvId || omvId === atvId) return false;

    if (data.currentVideoEndpoint) {
      replaceVideoIdDeep(data.currentVideoEndpoint, omvId, atvId);
    }
    if (data.playerOverlays) {
      replaceVideoIdDeep(data.playerOverlays, omvId, atvId);
      const meta = STATE.atvToMeta.get(atvId);
      const knownLike = getKnownLikeStatus(
        atvId,
        omvId,
        meta?.title,
        meta?.artist
      );
      if (knownLike) {
        applyLikeStatusDeep(data.playerOverlays, knownLike);
      }
    }
    setTimeout(() => navigateAppToPureAtv(omvId, atvId), 40);
    return true;
  }

  async function processNextResponseJson(data, reqVideoId) {
    const panels = collectPlaylistPanels(data);
    if (!panels.length) {
      return syncNextResponseTopLevelEndpoints(data, reqVideoId);
    }

    const omvEntries = [];
    let selectedQueueIndex = 0;
    let wrapperCounterpartPurified = false;

    for (const panel of panels) {
      panel.contents.forEach((item, idx) => {
        const wrapper = item.playlistPanelVideoWrapperRenderer;
        const r =
          item.playlistPanelVideoRenderer ||
          wrapper?.primaryRenderer?.playlistPanelVideoRenderer;
        if (!r || !r.videoId) return;

        if (r.selected) selectedQueueIndex = idx;

        const vId = r.videoId;
        const vType = findMusicVideoTypeDirect(r);
        const title = r.title?.runs?.map((x) => x.text).join('') || '';
        const byline =
          r.longBylineText?.runs?.map((x) => x.text).join('') || '';
        const artist =
          r.shortBylineText?.runs?.[0]?.text ||
          r.longBylineText?.runs?.[0]?.text ||
          '';

        const itemLike = extractLikeStatusFromMenu(r.menu);
        if (itemLike && itemLike !== 'INDIFFERENT') {
          recordLikeStatus(vId, title, artist, itemLike);
        }

        if (vType === 'MUSIC_VIDEO_TYPE_ATV') {
          STATE.knownAtvIds.add(vId);
          parseAndStoreQueueRenderer(r, vId);
          if (title) {
            STATE.titleToAtv.set(normKey(title, artist), vId);
          }
          // 若主渲染器已是纯音频 ATV，但 wrapper.counterpart 中带有 MV 副本，
          // 同步净化 counterpart，防止在 OMV_PREFERRED 模式下上一首/下一首切歌切到 MV 副本导致控制栏歌名错乱
          if (STATE.enabled && Array.isArray(wrapper?.counterpart)) {
            for (const cp of wrapper.counterpart) {
              const cpR = cp?.counterpartRenderer?.playlistPanelVideoRenderer;
              if (cpR?.videoId && cpR.videoId !== vId) {
                STATE.knownOmvIds.add(cpR.videoId);
                linkOmvAndAtv(cpR.videoId, vId);
                applyPureMetadataToQueueRenderer(cpR, cpR.videoId, vId);
                wrapperCounterpartPurified = true;
              }
            }
          }
          return;
        }

        const reqMeta = reqVideoId ? STATE.atvToMeta.get(reqVideoId) : null;
        const isRedirectedFromReq =
          r.selected &&
          reqVideoId &&
          reqVideoId !== vId &&
          STATE.knownAtvIds.has(reqVideoId) &&
          (!reqMeta?.title ||
            simplifyForCompare(extractBaseTitleRoot(reqMeta.title)) ===
              simplifyForCompare(extractBaseTitleRoot(title)));

        const isOmv =
          vType === 'MUSIC_VIDEO_TYPE_OMV' ||
          isRedirectedFromReq ||
          hasMvTitlePollution(title) ||
          (/观看|views|回視聴/i.test(byline) && vType !== 'MUSIC_VIDEO_TYPE_ATV');

        if (!isOmv) return;

        STATE.knownOmvIds.add(vId);
        let knownAtvId = null;

        // 优先从 wrapper.counterpart 提取原生纯音频渲染器（含完整的 `（合作音乐人：...）` 歌名与专辑菜单）
        if (wrapper) {
          const cpAtvId = extractCounterpartAtv(wrapper);
          if (cpAtvId) {
            knownAtvId = cpAtvId;
            linkOmvAndAtv(vId, knownAtvId);
          }
        }

        if (!knownAtvId && isRedirectedFromReq) {
          knownAtvId = reqVideoId;
          linkOmvAndAtv(vId, knownAtvId);
          log(
            `🎯 [直捕服务端重定向] 请求的原曲 (${reqVideoId}) 被重定向为 MV (${vId})，直接还原！`
          );
        }

        if (!knownAtvId && STATE.omvToAtv.has(vId)) {
          knownAtvId = STATE.omvToAtv.get(vId);
        }

        if (!knownAtvId && title) {
          const k1 = normKey(title, artist);
          if (STATE.titleToAtv.has(k1)) {
            const candidateId = STATE.titleToAtv.get(k1);
            if (candidateId !== vId && !STATE.knownOmvIds.has(candidateId)) {
              knownAtvId = candidateId;
              linkOmvAndAtv(vId, knownAtvId);
            }
          }
        }

        omvEntries.push({
          item,
          r,
          omvId: vId,
          title,
          artist,
          selected: Boolean(r.selected),
          queueIndex: idx,
          knownAtvId,
        });
      });
    }

    if (!omvEntries.length) {
      const topModified = syncNextResponseTopLevelEndpoints(data, reqVideoId);
      return wrapperCounterpartPurified || topModified;
    }

    const selectedEntry = omvEntries.find((e) => e.selected);
    if (selectedEntry) {
      STATE.currentId = selectedEntry.omvId;
      STATE.currentType = 'OMV';
      STATE.currentTitle = selectedEntry.title;
      STATE.currentArtist = selectedEntry.artist;
      updateFloatingCapsule();
    }

    if (!STATE.enabled) return false;

    const synchronousEntries = [];
    const backgroundEntries = [];

    omvEntries.sort((a, b) => {
      const distA =
        a.queueIndex >= selectedQueueIndex
          ? a.queueIndex - selectedQueueIndex
          : 1000 + (selectedQueueIndex - a.queueIndex);
      const distB =
        b.queueIndex >= selectedQueueIndex
          ? b.queueIndex - selectedQueueIndex
          : 1000 + (selectedQueueIndex - b.queueIndex);
      return distA - distB;
    });

    for (const entry of omvEntries) {
      const isImmediateNeighbor =
        entry.selected ||
        (entry.queueIndex >= selectedQueueIndex &&
          entry.queueIndex <= selectedQueueIndex + 2);
      if (
        (entry.knownAtvId && STATE.atvToMeta.get(entry.knownAtvId)?.title) ||
        isImmediateNeighbor ||
        synchronousEntries.length < 3
      ) {
        synchronousEntries.push(entry);
      } else {
        backgroundEntries.push(entry);
      }
    }

    await Promise.all(
      synchronousEntries.map(async (entry) => {
        if (!entry.knownAtvId || !STATE.atvToMeta.get(entry.knownAtvId)?.title) {
          const resolvedId = await resolveAtvForOmv(
            entry.title,
            entry.artist,
            entry.omvId
          );
          if (resolvedId) entry.knownAtvId = resolvedId;
        }
      })
    );

    const resolvedSyncEntries = synchronousEntries.filter(
      (e) => e.knownAtvId && e.knownAtvId !== e.omvId
    );

    let modified = wrapperCounterpartPurified;
    for (const entry of resolvedSyncEntries) {
      const { item, r, omvId, knownAtvId: atvId, selected } = entry;
      linkOmvAndAtv(omvId, atvId);
      if (item) {
        applyPureMetadataToQueueItem(item, omvId, atvId);
      } else {
        applyPureMetadataToQueueRenderer(r, omvId, atvId);
      }
      modified = true;

      if (selected) {
        if (data.currentVideoEndpoint) {
          replaceVideoIdDeep(data.currentVideoEndpoint, omvId, atvId);
        }
        if (data.playerOverlays) {
          replaceVideoIdDeep(data.playerOverlays, omvId, atvId);
          const knownLike = getKnownLikeStatus(
            atvId,
            omvId,
            entry.title,
            entry.artist
          );
          if (knownLike) {
            applyLikeStatusDeep(data.playerOverlays, knownLike);
          }
        }
        setTimeout(() => navigateAppToPureAtv(omvId, atvId), 40);
      }
    }

    if (backgroundEntries.length) {
      startProgressiveQueuePurifier(backgroundEntries);
    }

    return modified;
  }

  // ===========================================================================
  // 7. 处理 `/player` 响应与播放器状态同步（原生纯音频零干扰短路）
  // ===========================================================================

  async function inspectPlayerResponse(data) {
    const vd = data?.videoDetails;
    if (!vd?.videoId) return;

    const vId = vd.videoId;
    const vType = vd.musicVideoType || '';
    const title = vd.title || '';
    const author = vd.author || '';

    STATE.currentId = vId;
    STATE.currentTitle = title;
    STATE.currentArtist = author;

    const isOmv =
      vType === 'MUSIC_VIDEO_TYPE_OMV' ||
      STATE.knownOmvIds.has(vId) ||
      hasMvTitlePollution(title);

    if (vType === 'MUSIC_VIDEO_TYPE_ATV' && !isOmv) {
      STATE.currentType = 'ATV';
      STATE.knownAtvIds.add(vId);
      STATE.statusMsg = `纯享录音室版 (ATV: ${vId})`;

      const convertedFromOmv = STATE.atvToOmv.get(vId);
      if (convertedFromOmv) {
        syncDomPlayerBarMetadata(vId, convertedFromOmv);
      } else {
        syncPlayerBarWithActiveQueueItem(vId, title);
      }

      updateFloatingCapsule();
      return;
    }

    if (isOmv) {
      STATE.currentType = 'OMV';
      STATE.knownOmvIds.add(vId);
      STATE.statusMsg = `检测到 MV 视频源 (${vId})`;
      updateFloatingCapsule();

      if (
        STATE.enabled &&
        STATE.switchingFromOmv !== vId &&
        !STATE.unresolvableOmvIds.has(vId)
      ) {
        STATE.statusMsg = `⏳ 正在还原《${extractCoreSongTitle(title)}》纯享音频...`;
        updateFloatingCapsule();
        const atvId = await resolveAtvForOmv(title, author, vId);
        if (atvId && atvId !== vId) {
          navigateAppToPureAtv(vId, atvId);
        } else {
          STATE.statusMsg = `⚠️ 未找到对应纯音频 (保持原音源)`;
          updateFloatingCapsule();
        }
      }
    }
  }

  function navigateAppToPureAtv(omvId, atvId) {
    if (!atvId || atvId === omvId) return;

    const now = Date.now();
    if (
      (STATE.switchingToAtv === atvId || STATE.switchingFromOmv === omvId) &&
      now - STATE.lastSwitchTime < 2000
    ) {
      syncDomPlayerBarMetadata(atvId, omvId);
      return;
    }

    STATE.switchingFromOmv = omvId;
    STATE.switchingToAtv = atvId;
    STATE.lastSwitchTime = now;
    linkOmvAndAtv(omvId, atvId);

    try {
      syncDomPlayerBarMetadata(atvId, omvId);

      const player = document.getElementById('movie_player');
      if (player && typeof player.getVideoData === 'function') {
        const cur = player.getVideoData()?.video_id;
        if (cur !== atvId && typeof player.loadVideoById === 'function') {
          log(
            `🚀 正在将底层播放器音频流从 MV (${cur || omvId}) 切换至纯音频 ATV (${atvId})...`
          );
          player.loadVideoById(atvId);
        }
      }

      setTimeout(() => syncDomPlayerBarMetadata(atvId, omvId), 250);
      setTimeout(() => syncDomPlayerBarMetadata(atvId, omvId), 800);

      STATE.currentId = atvId;
      STATE.currentType = 'ATV';
      STATE.statusMsg = `已锁定纯享版与专辑信息 (${atvId})`;
      updateFloatingCapsule();

      setTimeout(() => {
        if (STATE.switchingToAtv === atvId) {
          STATE.switchingFromOmv = null;
          STATE.switchingToAtv = null;
        }
      }, 2200);
    } catch (e) {
      console.warn('[YTM-PureAudio] 切换异常:', e);
      STATE.switchingFromOmv = null;
      STATE.switchingToAtv = null;
    }
  }

  // ===========================================================================
  // 8. 轻量级 DOM 队列状态同步检查与播放器巡检
  // ===========================================================================

  function syncLiveDomQueueIfNeeded() {
    if (!STATE.enabled || STATE.omvToAtv.size === 0) return;
    const queueItemEls = document.querySelectorAll('ytmusic-player-queue-item');
    for (const row of queueItemEls) {
      const rowData =
        row.data || row.__data?.data || row.polymerController?.data;
      const vId = rowData?.videoId;
      if (!vId) continue;
      if (
        STATE.omvToAtv.has(vId) ||
        (STATE.atvToOmv.has(vId) && row.__ytmPurifiedAtvId !== vId)
      ) {
        syncQueueItemsInDomAndStore();
        return;
      }
    }
  }

  async function pollActivePlayerState() {
    syncLiveDomQueueIfNeeded();

    const player = document.getElementById('movie_player');
    const vData =
      typeof player?.getVideoData === 'function' ? player.getVideoData() : null;
    const liveVideoId = vData?.video_id || '';
    const liveTitle = vData?.title || '';
    const liveAuthor = vData?.author || '';

    if (liveVideoId) {
      STATE.currentId = liveVideoId;
      if (liveTitle) STATE.currentTitle = liveTitle;
      if (liveAuthor) STATE.currentArtist = liveAuthor;
    }

    if (STATE.knownAtvIds.has(liveVideoId)) {
      STATE.currentType = 'ATV';
      const convertedFromOmv = STATE.atvToOmv.get(liveVideoId);
      if (convertedFromOmv) {
        syncDomPlayerBarMetadata(liveVideoId, convertedFromOmv);
      } else {
        syncPlayerBarWithActiveQueueItem(liveVideoId, liveTitle);
      }
      updateFloatingCapsule();
      return;
    }

    const selectedRow = document.querySelector(
      'ytmusic-player-queue-item[selected]'
    );
    const rowData =
      selectedRow?.data ||
      selectedRow?.__data?.data ||
      selectedRow?.polymerController?.data;
    const rowType = findMusicVideoTypeDirect(rowData);

    if (rowType === 'MUSIC_VIDEO_TYPE_ATV' && liveVideoId) {
      STATE.knownAtvIds.add(liveVideoId);
      STATE.currentType = 'ATV';
      syncPlayerBarWithActiveQueueItem(liveVideoId, liveTitle);
      updateFloatingCapsule();
      return;
    }

    const looksLikeOmv =
      rowType === 'MUSIC_VIDEO_TYPE_OMV' ||
      STATE.knownOmvIds.has(liveVideoId) ||
      hasMvTitlePollution(liveTitle);

    if (looksLikeOmv && liveVideoId) {
      STATE.currentType = 'OMV';
      updateFloatingCapsule();
      if (
        STATE.enabled &&
        STATE.switchingFromOmv !== liveVideoId &&
        !STATE.unresolvableOmvIds.has(liveVideoId)
      ) {
        const atvId = await resolveAtvForOmv(
          liveTitle,
          liveAuthor,
          liveVideoId
        );
        if (atvId && atvId !== liveVideoId) {
          navigateAppToPureAtv(liveVideoId, atvId);
        }
      }
    } else {
      updateFloatingCapsule();
    }
  }

  // ===========================================================================
  // 9. 可折叠状态胶囊 UI（点击在「详细胶囊」与「极简颜色状态点」之间切换）
  // ===========================================================================

  let lastRenderedCapsuleSignature = '';

  function toggleCapsuleCollapsed() {
    STATE.collapsed = !STATE.collapsed;
    localStorage.setItem('ytm_pure_v5_collapsed', String(STATE.collapsed));
    lastRenderedCapsuleSignature = '';
    updateFloatingCapsule();
  }

  function updateFloatingCapsule() {
    if (!document.body) return;

    let capsule = document.getElementById('ytm-pure-v3-capsule');
    if (!capsule) {
      capsule = document.createElement('div');
      capsule.id = 'ytm-pure-v3-capsule';
      Object.assign(capsule.style, {
        position: 'fixed',
        right: '24px',
        bottom: '84px',
        zIndex: '2147483647',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: '999px',
        backgroundColor: 'rgba(18, 18, 22, 0.92)',
        border: '1px solid rgba(255, 255, 255, 0.18)',
        boxShadow: '0 4px 16px rgba(0, 0, 0, 0.55)',
        color: '#f3f4f6',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: '12px',
        fontWeight: '600',
        lineHeight: '1.4',
        userSelect: 'none',
        cursor: 'pointer',
        transition: 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
      });

      // 点击胶囊主体（或收缩后的小圆点）切换展开/折叠状态
      capsule.addEventListener('click', () => {
        toggleCapsuleCollapsed();
      });

      const dot = document.createElement('span');
      dot.id = 'ytm-pure-v3-dot';
      Object.assign(dot.style, {
        width: '8px',
        height: '8px',
        borderRadius: '50%',
        backgroundColor: '#10b981',
        flexShrink: '0',
        transition: 'all 0.2s ease',
      });

      const label = document.createElement('span');
      label.id = 'ytm-pure-v3-label';
      label.style.whiteSpace = 'nowrap';

      const toggleBtn = document.createElement('button');
      toggleBtn.id = 'ytm-pure-v3-toggle';
      Object.assign(toggleBtn.style, {
        marginLeft: '4px',
        padding: '2px 8px',
        borderRadius: '999px',
        border: '1px solid rgba(255, 255, 255, 0.2)',
        backgroundColor: 'rgba(255, 255, 255, 0.08)',
        color: '#e5e7eb',
        fontSize: '11px',
        cursor: 'pointer',
      });
      toggleBtn.title = '开启/关闭自动纯音频守护';
      toggleBtn.addEventListener('click', (e) => {
        e.stopPropagation(); // 阻止冒泡，避免点击开关按钮时触发胶囊折叠
        STATE.enabled = !STATE.enabled;
        localStorage.setItem('ytm_pure_v5_enabled', String(STATE.enabled));
        lastRenderedCapsuleSignature = '';
        updateFloatingCapsule();
        if (STATE.enabled) {
          pollActivePlayerState();
        }
      });

      capsule.appendChild(dot);
      capsule.appendChild(label);
      capsule.appendChild(toggleBtn);
      document.body.appendChild(capsule);
    }

    const meta = STATE.atvToMeta.get(STATE.currentId);
    const knownLike = getKnownLikeStatus(
      STATE.currentId,
      null,
      meta?.title || STATE.currentTitle,
      meta?.artist || STATE.currentArtist
    );

    const sig = `${STATE.collapsed}|${STATE.enabled}|${STATE.currentType}|${STATE.currentId}|${meta?.byline || ''}|${knownLike || ''}|${STATE.statusMsg}`;
    if (sig === lastRenderedCapsuleSignature) return;
    lastRenderedCapsuleSignature = sig;

    const dot = document.getElementById('ytm-pure-v3-dot');
    const label = document.getElementById('ytm-pure-v3-label');
    const toggleBtn = document.getElementById('ytm-pure-v3-toggle');

    let dotColor = '#60a5fa';
    let borderColor = 'rgba(255, 255, 255, 0.18)';
    let detailText = STATE.statusMsg || '纯享音频守护已就绪';

    if (!STATE.enabled) {
      dotColor = '#6b7280';
      borderColor = 'rgba(107, 114, 128, 0.45)';
      detailText = '⏸️ 纯享守护已暂停';
    } else if (STATE.currentType === 'ATV') {
      dotColor = '#10b981';
      borderColor = 'rgba(16, 185, 129, 0.55)';
      const isConverted = STATE.atvToOmv.has(STATE.currentId);
      const albumInfo = meta?.byline ? ` · ${meta.byline.slice(0, 20)}` : '';
      const likeBadge = knownLike === 'LIKE' ? ' 👍' : '';
      const modeTag = isConverted ? '逆转纯享' : '原生纯享';
      detailText = `🟢 ${modeTag} (${STATE.currentId}${albumInfo})${likeBadge}`;
    } else if (STATE.currentType === 'OMV') {
      dotColor = '#f59e0b';
      borderColor = 'rgba(245, 158, 11, 0.75)';
      detailText = `🟠 MV 视频源 (${STATE.currentId})`;
    }

    dot.style.backgroundColor = dotColor;
    dot.style.boxShadow = STATE.enabled ? `0 0 8px ${dotColor}` : 'none';
    capsule.style.borderColor = borderColor;
    label.textContent = detailText;
    toggleBtn.textContent = STATE.enabled ? '自动: 开' : '自动: 关';

    if (STATE.collapsed) {
      // 极简圆点形态：仅展示一颗带状态呼吸光效的圆点，完全不遮挡视线
      capsule.style.padding = '5px';
      capsule.style.gap = '0px';
      dot.style.width = '10px';
      dot.style.height = '10px';
      label.style.display = 'none';
      toggleBtn.style.display = 'none';
      capsule.title = `${detailText} · [点击展开胶囊]`;
    } else {
      // 详细胶囊形态
      capsule.style.padding = '6px 12px';
      capsule.style.gap = '8px';
      dot.style.width = '8px';
      dot.style.height = '8px';
      label.style.display = 'inline';
      toggleBtn.style.display = 'inline-block';
      capsule.title = '点击切换为极简圆点模式';
    }
  }

  // ===========================================================================
  // 10. 初始化与事件绑定
  // ===========================================================================

  loadPersistentCache();

  function onReady() {
    updateFloatingCapsule();
    if (window.ytInitialData) {
      harvestTracksAndLikesFromData(window.ytInitialData);
    }
  }

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', onReady);
  } else {
    onReady();
  }

  // 监听 YouTube Music SPA 页面切换完成与媒体流加载事件，做到即时按需触发
  window.addEventListener('yt-navigate-finish', () => {
    setTimeout(pollActivePlayerState, 200);
  });

  document.addEventListener(
    'loadeddata',
    (e) => {
      if (e.target && e.target.tagName === 'VIDEO') {
        pollActivePlayerState();
      }
    },
    true
  );

  // 低频兜底巡检（2.5 秒一次，且在原生纯音歌单下通过脏标记与状态短路达到接近 0 开销）
  setInterval(pollActivePlayerState, 2500);
  log(
    `v5.6.0 已启动 (已从本地缓存加载 ${STATE.omvToAtv.size} 条 MV->纯音频映射)`
  );
})();
