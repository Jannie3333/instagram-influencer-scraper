/**
 * lib/instagram.js
 * Instagram influencer scraping logic: public web endpoints first,
 * Playwright fallback for profiles that require a browser session.
 */

import { chromium } from 'playwright';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  'Chrome/124.0.0.0 Safari/537.36';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function cleanUsername(input) {
  return String(input || '')
    .trim()
    .replace(/^@/, '')
    .replace(/^https?:\/\/(www\.)?instagram\.com\//i, '')
    .split(/[/?#]/)[0]
    .trim();
}

function cleanKeyword(input) {
  return String(input || '').trim().replace(/^#/, '');
}

function parseCount(value) {
  if (typeof value === 'number') return value;
  if (!value) return 0;
  const s = String(value).replace(/,/g, '').trim().toLowerCase();
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return 0;
  if (s.endsWith('m')) return Math.round(n * 1_000_000);
  if (s.endsWith('k')) return Math.round(n * 1_000);
  return Math.round(n);
}

function extractEmailsFromText(text) {
  if (!text) return [];
  const re = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  return [...new Set(text.match(re) || [])];
}

function extractExternalUrls(text) {
  if (!text) return [];
  const re = /https?:\/\/[^\s"'<>]+/g;
  return [...new Set((text.match(re) || []).filter(url => !url.includes('instagram.com')))];
}

function normalizeCookieHeader(cookieStr) {
  const raw = String(cookieStr || '').trim();
  if (!raw) return '';
  if (!raw.includes('\t') && raw.includes('=')) return raw.replace(/\r?\n/g, '; ');

  const wanted = new Set(['sessionid', 'csrftoken', 'ds_user_id', 'mid', 'ig_did', 'rur', 'datr', 'wd']);
  const pairs = new Map();
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith('#')) continue;
    const parts = line.split('\t');
    if (parts.length < 7 || !/instagram\.com$/i.test(parts[0])) continue;
    const name = parts[5]?.trim();
    const value = parts.slice(6).join('\t').trim();
    if (name && value && wanted.has(name)) pairs.set(name, value);
  }
  return [...pairs].map(([name, value]) => `${name}=${value}`).join('; ');
}

function cookieHeaderToPlaywrightCookies(cookieStr) {
  const header = normalizeCookieHeader(cookieStr);
  return header.split(';').map(c => {
    const [name, ...rest] = c.trim().split('=');
    return { name: name?.trim(), value: rest.join('=').trim(), domain: '.instagram.com', path: '/' };
  }).filter(c => c.name && c.value);
}

function normalizeProfile(user, sourceQuery, source) {
  const username = user.username || user.user_name || user.handle || '';
  const fullName = user.full_name || user.fullName || user.name || '';
  const biography = user.biography || user.bio || '';
  const externalUrl =
    user.external_url ||
    user.externalUrl ||
    user.bio_links?.[0]?.url ||
    user.bio_link?.url ||
    '';
  const bioText = [biography, externalUrl].filter(Boolean).join('\n');
  const emails = extractEmailsFromText(bioText);
  const urls = [...new Set([externalUrl, ...extractExternalUrls(bioText)].filter(Boolean))];
  const followerCount = parseCount(
    user.edge_followed_by?.count ??
    user.follower_count ??
    user.followers_count ??
    user.followerCount ??
    0
  );
  const followingCount = parseCount(
    user.edge_follow?.count ??
    user.following_count ??
    user.followingCount ??
    0
  );
  const mediaCount = parseCount(
    user.edge_owner_to_timeline_media?.count ??
    user.media_count ??
    user.posts_count ??
    user.mediaCount ??
    0
  );

  const popularityScore =
    (followerCount > 0 ? Math.log10(followerCount + 1) * 12 : 0) +
    (mediaCount > 0 ? Math.log10(mediaCount + 1) * 3 : 0);

  return {
    scraped_at: new Date().toISOString(),
    platform: 'instagram',
    username,
    full_name: fullName,
    follower_count: followerCount,
    following_count: followingCount,
    media_count: mediaCount,
    like_count: 0,
    comment_count: 0,
    engagement_rate: '',
    country: '',
    country_source: '',
    region_raw: '',
    email: emails[0] || '',
    email_source: emails[0] ? 'bio' : '',
    email_url: '',
    external_urls: urls.join(','),
    source_tags: sourceQuery,
    caption: '',
    post_url: '',
    thumbnail_url: '',
    biography,
    profile_url: username ? `https://www.instagram.com/${username}/` : '',
    profile_pic_url: user.profile_pic_url || user.profilePicUrl || user.profile_pic_url_hd || '',
    is_verified: Boolean(user.is_verified || user.verified),
    is_private: Boolean(user.is_private || user.private),
    category: user.category_name || user.category || '',
    source,
    popularity_score: Math.round(popularityScore * 10) / 10
  };
}

function extractJsonLd(html) {
  const blocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const match of blocks) {
    try {
      const data = JSON.parse(match[1]);
      const obj = Array.isArray(data) ? data[0] : data;
      if (!obj) continue;
      const username = cleanUsername(obj.url || obj.alternateName || '');
      if (username || obj.name || obj.description) {
        return {
          username,
          full_name: obj.name || '',
          biography: obj.description || '',
          profile_pic_url: obj.image || ''
        };
      }
    } catch {
      // ignore invalid blocks
    }
  }
  return null;
}

function extractSharedDataUser(html) {
  const patterns = [
    /"user"\s*:\s*(\{[\s\S]*?"edge_owner_to_timeline_media"[\s\S]*?\})\s*,\s*"logging_page_id"/,
    /"profilePage_([A-Za-z0-9_.]+)"[\s\S]*?"user"\s*:\s*(\{[\s\S]*?\})\s*,\s*"status"/
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (!match) continue;
    const raw = match[2] || match[1];
    try {
      return JSON.parse(raw);
    } catch {
      // The page data changes often; fall back to JSON-LD/meta below.
    }
  }
  return null;
}

function extractMetaProfile(html, username) {
  const title = html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || '';
  const desc =
    html.match(/<meta\s+property=["']og:description["']\s+content=["']([\s\S]*?)["']/i)?.[1] ||
    html.match(/<meta\s+name=["']description["']\s+content=["']([\s\S]*?)["']/i)?.[1] ||
    '';
  const image = html.match(/<meta\s+property=["']og:image["']\s+content=["']([\s\S]*?)["']/i)?.[1] || '';

  const followerText = desc.match(/([\d,.]+[kKmM]?)\s+Followers?/i)?.[1] || '';
  const followingText = desc.match(/([\d,.]+[kKmM]?)\s+Following/i)?.[1] || '';
  const postsText = desc.match(/([\d,.]+[kKmM]?)\s+Posts?/i)?.[1] || '';
  const name = title.replace(/\(\@.*?\).*$/i, '').replace(/• Instagram.*$/i, '').trim();

  if (!desc && !title) return null;
  return {
    username,
    full_name: name,
    biography: desc,
    profile_pic_url: image,
    follower_count: parseCount(followerText),
    following_count: parseCount(followingText),
    media_count: parseCount(postsText)
  };
}

async function fetchInstagramHtml(url, cookieStr = '') {
  const headers = {
    'User-Agent': USER_AGENT,
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'en-US,en;q=0.9'
  };
  const cookieHeader = normalizeCookieHeader(cookieStr);
  if (cookieHeader) headers.Cookie = cookieHeader;
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Instagram HTTP ${res.status}`);
  return res.text();
}

export async function scrapeInstagramProfile(username, options = {}) {
  const {
    cookieStr = '',
    sourceQuery = username,
    onLog = () => {}
  } = options;

  const handle = cleanUsername(username);
  if (!handle) return null;

  const url = `https://www.instagram.com/${encodeURIComponent(handle)}/`;
  onLog(`[Instagram HTTP] GET ${url}`);
  const html = await fetchInstagramHtml(url, cookieStr);

  if (/login_required|Please wait a few minutes|challenge|checkpoint/i.test(html)) {
    throw new Error('instagram blocked or requires login');
  }

  const shared = extractSharedDataUser(html);
  const jsonLd = extractJsonLd(html);
  const meta = extractMetaProfile(html, handle);
  const user = { username: handle, ...(meta || {}), ...(jsonLd || {}), ...(shared || {}) };
  const row = normalizeProfile(user, sourceQuery, 'instagram.http');
  return row.username ? row : null;
}

async function searchInstagramKeywordPlaywright(keyword, options, logFn) {
  const {
    cookieStr = '',
    headless = true,
    maxProfiles = 30,
    maxScrolls = 6
  } = options;

  logFn(`[Playwright] searching Instagram for ${keyword}`);
  const browser = await chromium.launch({ headless });
  const rows = [];
  const seen = new Set();

  try {
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1366, height: 768 },
      locale: 'en-US',
      timezoneId: 'America/Los_Angeles'
    });

    if (cookieStr) {
      const cookies = cookieHeaderToPlaywrightCookies(cookieStr);
      if (cookies.length) await context.addCookies(cookies);
    }

    const page = await context.newPage();
    const tag = cleanKeyword(keyword);
    await page.goto(`https://www.instagram.com/explore/tags/${encodeURIComponent(tag)}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 45000
    });

    for (let i = 0; i < maxScrolls; i++) {
      const links = await page.$$eval('a[href^="/"]', anchors =>
        anchors.map(a => a.getAttribute('href')).filter(Boolean)
      ).catch(() => []);

      for (const href of links) {
        const match = href.match(/^\/([A-Za-z0-9_.]+)\/$/);
        if (!match) continue;
        const username = match[1];
        if (seen.has(username) || ['explore', 'reels', 'p', 'accounts'].includes(username)) continue;
        seen.add(username);
        try {
          const row = await scrapeInstagramProfile(username, {
            cookieStr,
            sourceQuery: tag,
            onLog: logFn
          });
          if (row) rows.push({ ...row, source: 'instagram.playwright.tag' });
          if (rows.length >= maxProfiles) break;
          await sleep(randInt(800, 1800));
        } catch (e) {
          logFn(`[Profile] @${username} error: ${e.message}`);
        }
      }

      if (rows.length >= maxProfiles) break;
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2)).catch(() => {});
      await sleep(randInt(1500, 2600));
    }

    await context.close();
  } finally {
    await browser.close();
  }

  return rows;
}

export async function scrapeInstagramTargets(options = {}) {
  const {
    tags = [],
    usernames = [],
    maxPostsPerTag = 30,
    cookieStr = '',
    headless = true,
    useBrowserFallback = true,
    onLog = () => {},
    onProgress = () => {}
  } = options;

  const allRows = [];
  const seen = new Set();
  const perTag = [];
  const targets = [
    ...usernames.map(u => ({ type: 'profile', value: cleanUsername(u) })).filter(t => t.value),
    ...tags.map(t => ({ type: 'tag', value: cleanKeyword(t) })).filter(t => t.value)
  ];

  for (let i = 0; i < targets.length; i++) {
    const target = targets[i];
    onProgress({ tag: target.value, index: i, total: targets.length });
    onLog(`\n=== Instagram ${target.type}: ${target.value} (${i + 1}/${targets.length}) ===`);
    let found = 0;
    let method = '';
    let error = null;

    try {
      if (target.type === 'profile') {
        const row = await scrapeInstagramProfile(target.value, {
          cookieStr,
          sourceQuery: target.value,
          onLog
        });
        if (row && !seen.has(row.username)) {
          seen.add(row.username);
          allRows.push(row);
          found++;
        }
        method = 'http.profile';
      } else if (useBrowserFallback) {
        const rows = await searchInstagramKeywordPlaywright(target.value, {
          cookieStr,
          headless,
          maxProfiles: maxPostsPerTag
        }, onLog);
        for (const row of rows) {
          if (!row.username || seen.has(row.username)) continue;
          seen.add(row.username);
          allRows.push(row);
          found++;
        }
        method = 'playwright.tag';
      } else {
        error = 'tag search requires browser fallback';
      }
    } catch (e) {
      error = e.message;
      onLog(`[Instagram] ${target.value} error: ${e.message}`);
    }

    perTag.push({ tag: target.value, type: target.type, method, found, error });
    onLog(`${target.value} done: ${found} new unique profiles`);
  }

  return {
    tags: targets.map(t => t.value),
    count: allRows.length,
    perTag,
    videos: allRows,
    duplicateVideos: []
  };
}

export async function checkInstagramConnectivity() {
  const results = {};
  try {
    const r = await fetch('https://www.instagram.com/', {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(10000)
    });
    results.instagram = r.ok;
  } catch {
    results.instagram = false;
  }
  return results;
}
