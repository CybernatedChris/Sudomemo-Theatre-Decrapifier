// ==UserScript==
// @name         Sudomemo Theatre Decrapifier
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Clean up Sudomemo Theatre without blocking anyone (hiding upsells optional)
// @match        https://www.sudomemo.net/*
// @icon         https://icons.duckduckgo.com/ip3/sudomemo.net.ico
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_addStyle
// @run-at       document-end
// ==/UserScript==

(function() {
    'use strict';

    let hideUpsells = GM_getValue('hideupsells', true); // patreon, discord, sudomemo merchandise, uploading flipnotes as shorts
    let hideGoodUpsells = GM_getValue('hidegoodupsells', true); // wii room, 3ds guide, staying safe, organizer, archive, buy a creator theme
    let hideFlipstreams = GM_getValue('hideflipstreams', true); // hide flipstream

    if (location.pathname.startsWith('/chat') || location.pathname.startsWith('/watch/embed') || location.pathname.startsWith('/organizer')) return;

    const channelskey   = 'blockedchannels';
    const creatorskey   = 'blockedcreators';
    const whitelistkey  = 'whitelistkey';

    let blockedchannels    = [];
    let blockedcreators    = [];
    let whitelistedcreators = [];
    const channelmap = new Map();
    const creatormap = new Map();
    const creatorNameCache = new Map();
    let currentuser = null;
    let isRedirecting = false;
    let slideObserver = null;

    let lastScrollTop = 0;
    let scrollDirection = 'down';
    let activeSlide = null;
    let mutationDebounceTimer = null;

    function isWeeklyTopicCategoryPage() {
        return location.pathname.startsWith('/categories/8');
    }

    function escapeHTML(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function cleanCreatorId(id) {
        if (!id || typeof id !== 'string') return '';
        const trimmed = id.trim().toUpperCase();
        const hex = trimmed.split('@')[0].replace(/[^A-F0-9]/g, '');
        if (hex.length === 16) return hex + '@DSI';
        return '';
    }

    function detectCurrentUser() {
        const navLink = document.querySelector('.navbar-nav a[href^="/user/"], nav a[href^="/user/"], .dropdown-menu a[href^="/user/"], #user-dropdown a[href^="/user/"], .user-menu a[href^="/user/"]');
        const match = navLink?.href.match(/\/user\/([A-F0-9]{16}@DSi)/i);
        currentuser = match ? cleanCreatorId(match[1]) : null;
    }

    function sanitizeList(arr, isCreator = false) {
        if (!Array.isArray(arr)) return [];
        return arr.filter(item => item && typeof item.id === 'string' && item.id.trim().length > 0).map(item => {
            const cleanId = isCreator ? cleanCreatorId(item.id) : item.id.trim();
            const cleanName = typeof item.name === 'string' ? item.name.trim().slice(0, 50) : 'Unknown';
            let cleanAvatar = '';
            if (isCreator && typeof item.avatar === 'string' && (item.avatar.startsWith('https://') || item.avatar.startsWith('/'))) {
                cleanAvatar = item.avatar.trim();
            }
            return { id: cleanId, name: cleanName, avatar: cleanAvatar };
        }).filter(item => item.id.length > 0);
    }

    function loadSets() {
        try {
            blockedchannels     = sanitizeList(JSON.parse(GM_getValue(channelskey, '[]')), false);
            blockedcreators     = sanitizeList(JSON.parse(GM_getValue(creatorskey, '[]')), true);
            whitelistedcreators = sanitizeList(JSON.parse(GM_getValue(whitelistkey, '[]')), true);
        } catch {
            blockedchannels = [];
            blockedcreators = [];
            whitelistedcreators = [];
        }
    }

    GM_addStyle(`
        .sm-hidden { display: none !important; }
        .list-group-item {
            transition: opacity 0.25s ease, max-height 0.25s ease, padding 0.25s ease, margin 0.25s ease;
            overflow: hidden;
        }
        .sm-avatar-placeholder {
            width: 40px;
            height: 40px;
            background: #2a2a2a;
            display: flex;
            align-items: center;
            justify-content: center;
            border-radius: 0.25rem;
            color: #666;
        }
        .sm-blocked-slide {
            opacity: 0 !important;
            visibility: hidden !important;
            pointer-events: none !important;
        }
        .sm-blurred-genealogy {
            filter: blur(6px) !important;
            opacity: 0.55 !important;
            pointer-events: none !important;
            user-select: none !important;
            transition: none !important;
            animation: none !important;
        }
        .sm-blurred-genealogy,
        .sm-blurred-genealogy * {
            pointer-events: none !important;
            cursor: default !important;
            transition: none !important;
            animation: none !important;
        }
        .sm-blurred-genealogy .sm-btn-creator,
        .flipnote-genealogy-card.collapsed-group .sm-btn-creator,
        .collapsed-group-content .sm-btn-creator,
        .collapsed-group-layout .sm-btn-creator {
            display: none !important;
        }
        .flipnote-genealogy-card { position: relative; }
        .related-preview a { position: relative; display: inline-block; }
        .related-flipnote-container.sm-hidden,
        .spinoff-flipnote-list .related-flipnote-container.sm-hidden {
            display: none !important;
            visibility: hidden !important;
            height: 0 !important;
            overflow: hidden !important;
            margin: 0 !important;
            padding: 0 !important;
        }
        .sm-dialog {
            background: #121212;
            color: #e0e0e0;
            border: 1px solid #333;
            border-radius: 12px;
            width: 440px;
            max-width: 94%;
            padding: 1.75rem;
            box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
            max-height: 90vh;
            overflow-y: auto;
        }
        @media (max-width: 576px) {
            .sm-dialog { padding: 1.25rem; width: 100%; max-width: 96%; }
        }
        .form-check-input { cursor: pointer; background-color: #222; border-color: #555; }
        .form-check-input:checked { background-color: #28a745; border-color: #28a745; }
        .form-check-label { cursor: pointer; user-select: none; color: #ccc; }
        .sm-help-badge {
            display: inline-flex;
            align-items: center;
            justify-content: center;
            width: 15px;
            height: 15px;
            background: rgba(255, 255, 255, 0.15);
            color: #aaa;
            border-radius: 50%;
            font-size: 10px;
            font-weight: bold;
            margin-left: 6px;
            cursor: help;
            user-select: none;
            transition: background 0.2s, color 0.2s;
            vertical-align: middle;
        }
        .sm-help-badge:hover { background: #007bff; color: #fff; }
    `);

    function saveblockedchannels()    { GM_setValue(channelskey,   JSON.stringify(blockedchannels)); }
    function saveblockedcreators()    { GM_setValue(creatorskey,   JSON.stringify(blockedcreators)); }
    function savewhitelistedcreators() { GM_setValue(whitelistkey, JSON.stringify(whitelistedcreators)); }

    function getChannelId(el) {
        if (!el) return null;
        if (el.matches && el.matches('a[href^="/channel/"]')) {
            return el.href.match(/\/channel\/([a-zA-Z0-9_-]+)/)?.[1] ?? null;
        }
        return el.querySelector('a[href^="/channel/"]')?.href.match(/\/channel\/([a-zA-Z0-9_-]+)/)?.[1] ?? null;
    }

    function getChannelName(el) {
        return el.querySelector('a[href^="/channel/"]')?.textContent?.trim() || '';
    }

    function getCreatorId(el) {
        if (!el) return null;
        const linkMatch = el.querySelector('a[href^="/user/"]')?.href.match(/\/user\/([A-F0-9]{16}@DSi)/i);
        if (linkMatch) return cleanCreatorId(linkMatch[1]);

        const img = el.querySelector('img[src*="/dynamic/thumbframe/"], img[src*="/dynamic/playback/"]');
        if (img) {
            const src = img.getAttribute('src') || '';
            const match = src.match(/\/dynamic\/(?:thumbframe|playback)\/([A-F0-9]{16})/i);
            if (match) return cleanCreatorId(match[1]);
        }
        return null;
    }

    function getCreatorName(el) {
        const links = el.querySelectorAll('a[href^="/user/"]');
        for (const link of links) {
            const name = link.textContent?.trim();
            if (name && !link.querySelector('img')) {
                return name.toLowerCase().startsWith('by ') ? name.substring(3).trim() : name;
            }
        }
        let fallback = el.querySelector('a[href^="/user/"]')?.textContent?.trim() || '';
        return fallback.toLowerCase().startsWith('by ') ? fallback.substring(3).trim() : fallback;
    }

    function safeRedirect() {
        if (isRedirecting) return;
        isRedirecting = true;
        if (history.length > 1) {
            history.back();
        } else {
            location.replace('https://www.sudomemo.net/');
        }
    }

    function isSelf(id) {
        if (!id || !currentuser) return false;
        return cleanCreatorId(id) === currentuser;
    }

    function isWhitelisted(id) {
        if (!id) return false;
        const cleaned = cleanCreatorId(id);
        if (isSelf(cleaned)) return true;
        return whitelistedcreators.some(c => cleanCreatorId(c.id) === cleaned);
    }

    function isBlockedCreator(id) {
        if (!id) return false;
        const cleaned = cleanCreatorId(id);
        if (isSelf(cleaned)) return false;
        return blockedcreators.some(c => cleanCreatorId(c.id) === cleaned) && !isWhitelisted(cleaned);
    }

    function isLast6Blocked(last6) {
        if (!last6) return false;
        const upper6 = last6.toUpperCase();
        if (currentuser) {
            const myHex = currentuser.split('@')[0];
            if (myHex.endsWith(upper6)) return false;
        }
        return blockedcreators.some(c => {
            const hexId = cleanCreatorId(c.id).split('@')[0];
            return hexId.endsWith(upper6) && !isWhitelisted(c.id);
        });
    }

    function harvestCreatorNames() {
        let storageNeedsSave = false;

        document.querySelectorAll('a[href^="/user/"], a[href*="/user/"]').forEach(a => {
            const href = a.getAttribute('href') || '';
            const match = href.match(/\/user\/([A-F0-9]{16}@DSi)/i);
            if (match) {
                const id = cleanCreatorId(match[1]);
                let name = a.textContent?.trim();
                if (name && name.toLowerCase().startsWith('by ')) name = name.substring(3).trim();

                if (name && name !== id && !name.includes('/') && !name.includes('@')) {
                    let avatarUrl = '';
                    const img = a.querySelector('img') || a.parentElement?.querySelector('img[src*="/dynamic/thumbframe/"]');
                    if (img) {
                        const src = img.getAttribute('src') || '';
                        if (src.includes('/dynamic/thumbframe/')) {
                            try {
                                const urlObj = new URL(src.startsWith('/') ? 'https://www.sudomemo.net' + src : src);
                                urlObj.searchParams.set('size', 's');
                                urlObj.searchParams.set('square', '1');
                                avatarUrl = urlObj.toString();
                            } catch {
                                avatarUrl = src;
                            }
                        }
                    }

                    const existing = creatorNameCache.get(id);
                    const finalAvatar = avatarUrl || existing?.avatar || '';

                    creatorNameCache.set(id, { name: name, avatar: finalAvatar });

                    [blockedcreators, whitelistedcreators].forEach(list => {
                        const found = list.find(c => cleanCreatorId(c.id) === id);
                        if (found) {
                            if (name && found.name !== name && name !== 'Unknown') {
                                found.name = name;
                                storageNeedsSave = true;
                            }
                            if (avatarUrl && found.avatar !== avatarUrl) {
                                found.avatar = avatarUrl;
                                storageNeedsSave = true;
                            }
                        }
                    });
                }
            }
        });

        if (storageNeedsSave) {
            saveblockedchannels();
            savewhitelistedcreators();
        }
    }

    async function resolveCreatorName(id, callback, forceRefresh = false) {
        const cleanId = cleanCreatorId(id);
        if (!cleanId) return;

        if (!forceRefresh) {
            if (creatorNameCache.has(cleanId)) {
                const cached = creatorNameCache.get(cleanId);
                callback(cached.name, cached.avatar);
                if (cached.avatar) return;
            }

            const blocked = blockedcreators.find(c => cleanCreatorId(c.id) === cleanId);
            if (blocked && blocked.name && blocked.name !== 'Unknown') {
                creatorNameCache.set(cleanId, { name: blocked.name, avatar: blocked.avatar || '' });
                callback(blocked.name, blocked.avatar || '');
                if (blocked.avatar) return;
            }

            const white = whitelistedcreators.find(c => cleanCreatorId(c.id) === cleanId);
            if (white && white.name && white.name !== 'Unknown') {
                creatorNameCache.set(cleanId, { name: white.name, avatar: white.avatar || '' });
                callback(white.name, white.avatar || '');
                if (white.avatar) return;
            }
        }

        try {
            const fetchId = cleanId.replace('@DSI', '@DSi');
            const res = await fetch(`/user/${fetchId}`, { cache: 'no-cache' });
            if (!res.ok) return;
            const html = await res.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');

            const title = doc.querySelector('title')?.textContent || '';
            let name = title
                .replace(/'s Profile.*/i, '')
                .replace(/ - Sudomemo.*/i, '')
                .replace(/Theatre/i, '')
                .trim();

            if (!name || name.toLowerCase().includes('theatre') || name.toLowerCase().includes('sudomemo')) {
                name = doc.querySelector('.profile-right .name a, .profile-right .name, h1, .name')?.textContent?.trim();
            }

            const hexId = cleanId.split('@')[0];
            const avatarImg = doc.querySelector(`img[src*="/dynamic/thumbframe/${hexId}/"]`) ||
                              doc.querySelector('.details-profile-container img, .profile-avatar img, img.profile-avatar, .avatar img, img.avatar');

            let avatarUrl = '';
            if (avatarImg) {
                let src = avatarImg.getAttribute('src') || '';
                if (src) {
                    if (src.startsWith('/')) src = 'https://www.sudomemo.net' + src;
                    try {
                        const urlObj = new URL(src);
                        if (src.includes('/dynamic/thumbframe/')) {
                            urlObj.searchParams.set('size', 's');
                            urlObj.searchParams.set('square', '1');
                        }
                        avatarUrl = urlObj.toString();
                    } catch {
                        avatarUrl = src;
                    }
                }
            }

            if (name && !name.includes('@')) {
                creatorNameCache.set(cleanId, { name, avatar: avatarUrl });
                callback(name, avatarUrl);

                let updated = false;
                blockedcreators.forEach(c => {
                    if (cleanCreatorId(c.id) === cleanId) {
                        if (c.name !== name) { c.name = name; updated = true; }
                        if (avatarUrl && c.avatar !== avatarUrl) { c.avatar = avatarUrl; updated = true; }
                    }
                });
                whitelistedcreators.forEach(c => {
                    if (cleanCreatorId(c.id) === cleanId) {
                        if (c.name !== name) { c.name = name; updated = true; }
                        if (avatarUrl && c.avatar !== avatarUrl) { c.avatar = avatarUrl; updated = true; }
                    }
                });
                if (updated) {
                    saveblockedchannels();
                    savewhitelistedcreators();
                }
            }
        } catch {}
    }

    function hide(el) {
        if (!el) return;
        el.classList.add('sm-hidden');
        el.style.setProperty('display', 'none', 'important');
    }

    function show(el) {
        if (!el) return;
        el.classList.remove('sm-hidden');
        el.style.display = '';
    }

    function processItem(el) {
        if (el.classList.contains('sm-processed')) return;
        el.classList.add('sm-processed');

        const isChannelCard = el.matches('.channel-card, .cat-box, .channel-grid-item') ||
                              el.classList.contains('channel-card') ||
                              el.classList.contains('cat-box');

        if (isChannelCard) {
            if (isWeeklyTopicCategoryPage()) {
                show(el);
                return;
            }
            const chId = getChannelId(el);
            if (chId) {
                if (!channelmap.has(chId)) channelmap.set(chId, new Set());
                channelmap.get(chId).add(el);
                if (blockedchannels.some(c => c.id.toUpperCase() === chId.toUpperCase())) hide(el);
            }
            return;
        }

        const crId = getCreatorId(el);
        if (crId) {
            if (!creatormap.has(crId)) creatormap.set(crId, new Set());
            creatormap.get(crId).add(el);
            if (isBlockedCreator(crId)) hide(el);
        }
    }

    function processFlipstreams() {
        if (hideFlipstreams) return;
        document.querySelectorAll('img.flipstream-thumbnail-card__image.flipnote-hoverpreview-img').forEach(img => {
            const src = img.getAttribute('src') || img.getAttribute('data-hover-preview-src') || '';
            const match = src.match(/\/dynamic\/(?:thumbframe|playback)\/([A-F0-9]{16})/i);

            if (match) {
                const creatorId = cleanCreatorId(match[1]);
                const li = img.closest('li.flipstream-list-item') || img.parentElement?.parentElement?.parentElement;

                if (li) {
                    if (!creatormap.has(creatorId)) creatormap.set(creatorId, new Set());
                    creatormap.get(creatorId).add(li);

                    const isBlocked = isBlockedCreator(creatorId);
                    if (isBlocked) hide(li);
                    else show(li);

                    if (!li.querySelector('.sm-btn-creator') && !li.classList.contains('sm-btn-added')) {
                        const isWhite = isWhitelisted(creatorId);

                        if (!isWhite && !isSelf(creatorId)) {
                            const cached = creatorNameCache.get(creatorId);
                            const initialName = cached?.name || 'Unknown';
                            addBlockBtn(li, 'creator', creatorId, initialName, { blocked: isBlocked, whitelisted: false });

                            resolveCreatorName(creatorId, (resolvedName) => {
                                const btn = li.querySelector('.sm-btn-creator');
                                if (btn) btn.title = `Hide ${resolvedName}`;
                            });
                        }
                        li.classList.add('sm-btn-added');
                    }
                }
            }
        });
    }

    function processSpotlight() {
        const header = document.querySelector('.panel-header-spotlight');
        if (header) {
            const parentCard = header.closest('.card, .panel') || header.parentElement;
            if (parentCard) {
                const iframe = parentCard.querySelector('iframe[src*="/watch/embed/"]');
                if (iframe) {
                    const src = iframe.getAttribute('src') || '';
                    const match = src.match(/\/watch\/embed\/([A-F0-9]{6})_/i);
                    if (match && isLast6Blocked(match[1])) hide(parentCard);
                    else show(parentCard);
                }
            }
        }
    }

    function processEmbeds() {
        document.querySelectorAll('.flipnote-embed').forEach(embed => {
            const iframe = embed.querySelector('iframe[src*="/watch/embed/"]');
            if (iframe) {
                const src = iframe.getAttribute('src') || '';
                const match = src.match(/\/watch\/embed\/([A-F0-9]{6})_/i);
                if (match && isLast6Blocked(match[1])) hide(embed);
                else show(embed);
            }
        });
    }

    function processRelatedFlipnotes() {
        const containers = document.querySelectorAll(
            '.related-flipnote-container, ' +
            '.spinoff-flipnote-list .related-flipnote-container, ' +
            '.spinoff-flipnote-list > div, ' +
            '.theme-panel-body.spinoff-flipnote-list .related-flipnote-container, ' +
            '#left-sidebar .related-flipnote-container, ' +
            '#left-sidebar [class*="panel"] .related-flipnote-container'
        );

        containers.forEach(container => {
            if (!container.classList.contains('related-flipnote-container') && !container.querySelector('.related-preview, .related-title, .related-details')) return;

            let creatorId = null;
            let creatorName = 'Unknown';
            let sixDigit = null;

            const titleLink = container.querySelector('p.related-title a.theme-link[href*="/user/"], .related-details a.theme-link[href*="/user/"], a.theme-link[href*="/user/"], a[href*="/user/"]');
            if (titleLink) {
                const match = (titleLink.getAttribute('href') || '').match(/\/user\/([A-F0-9]{16}@DSi)/i);
                if (match) {
                    creatorId = cleanCreatorId(match[1]);
                    creatorName = titleLink.textContent?.trim() || 'Unknown';
                    if (creatorName.toLowerCase().startsWith('by ')) creatorName = creatorName.substring(3).trim();
                }
            }

            if (!creatorId) {
                const img = container.querySelector('img[src*="/dynamic/thumbframe/"], img[src*="/dynamic/playback/"], .related-preview img, img');
                if (img) {
                    const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
                    const match = src.match(/\/dynamic\/(?:thumbframe|playback)\/([A-F0-9]{16})/i);
                    if (match) creatorId = cleanCreatorId(match[1]);
                    else {
                        const sixMatch = src.match(/\/([A-F0-9]{6})(?:[\/_]|$)/i);
                        if (sixMatch) sixDigit = sixMatch[1].toUpperCase();
                    }
                }
            }

            if (!creatorId) {
                const anyLink = container.querySelector('a[href*="/watch/"], a[href*="/user/"]');
                if (anyLink) {
                    const href = anyLink.getAttribute('href') || '';
                    let match = href.match(/\/user\/([A-F0-9]{16}@DSi)/i);
                    if (match) creatorId = cleanCreatorId(match[1]);
                    else {
                        match = href.match(/\/watch\/([A-F0-9]{6})/i) || href.match(/([A-F0-9]{6})_/);
                        if (match) sixDigit = match[1].toUpperCase();
                    }
                }
            }

            if (!creatorId && sixDigit) {
                const blocked = blockedcreators.find(c => {
                    const hex = cleanCreatorId(c.id).split('@')[0];
                    return (hex.startsWith(sixDigit) || hex.endsWith(sixDigit)) && !isWhitelisted(c.id);
                });
                if (blocked) {
                    creatorId = cleanCreatorId(blocked.id);
                    creatorName = blocked.name || 'Unknown';
                }
            }

            if (!creatorId) return;

            if (creatorName && creatorName !== 'Unknown') {
                const existing = creatorNameCache.get(creatorId);
                creatorNameCache.set(creatorId, { name: creatorName, avatar: existing?.avatar || '' });
            }

            const isBlocked = isBlockedCreator(creatorId);
            const isWhite = isWhitelisted(creatorId);

            if (isBlocked) {
                hide(container);
            } else {
                show(container);
            }

            if (!container.querySelector('.sm-btn-creator') && !isWhite && !isSelf(creatorId) && !isBlocked) {
                addBlockBtn(container, 'creator', creatorId, creatorName, { blocked: isBlocked, whitelisted: false });
                const btn = container.querySelector('.sm-btn-creator');
                const thumbTarget = container.querySelector('.related-preview a, .related-preview') || container.querySelector('img')?.parentElement;
                if (btn && thumbTarget) {
                    thumbTarget.style.position = 'relative';
                    if (btn.parentElement !== thumbTarget) thumbTarget.appendChild(btn);
                }
            }
        });
    }

    let channelPreviewsLastRun = 0;
    const CHANNEL_PREVIEWS_THROTTLE_MS = 1000;

    function processChannelPreviews(force = false) {
        const now = Date.now();
        if (!force && now - channelPreviewsLastRun < CHANNEL_PREVIEWS_THROTTLE_MS) return;
        channelPreviewsLastRun = now;

        const onWeeklyTopics = isWeeklyTopicCategoryPage();

        if (onWeeklyTopics) {
            document.querySelectorAll('.sm-btn-channel').forEach(btn => btn.remove());
        } else {
            document.querySelectorAll('.category-thumbs .sm-btn-channel, .category-grid .sm-btn-channel').forEach(btn => btn.remove());
        }

        const previewImgs = document.querySelectorAll(
            '.category-thumbs img, .channel-thumbs img, .cat-thumbs img, .cat-box .thumb img, ' +
            '.channel-card .thumb img, .cat-box .category-thumbs img, .channel-card .category-thumbs img, ' +
            '.category-grid img.flipnote-hoverpreview-img, [class*="channel"] .thumb img, [class*="cat-"] .thumb img'
        );

        previewImgs.forEach(img => {
            const thumb = img.closest('.thumb') || img.closest('a') || img.parentElement;
            if (!thumb) return;

            const src = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-hover-preview-src') || '';
            const anchor = img.closest('a') || thumb.querySelector('a');
            const href = anchor?.getAttribute('href') || '';
            const combined = src + ' ' + href;

            let creatorId = thumb.dataset.smCreatorId || null;
            let sixDigit = thumb.dataset.smSix || null;

            if (!creatorId && !sixDigit) {
                const fullMatch = combined.match(/\/user\/([A-F0-9]{16}@DSi)/i) || combined.match(/\/dynamic\/(?:thumbframe|playback)\/([A-F0-9]{16})/i);
                if (fullMatch) {
                    creatorId = cleanCreatorId(fullMatch[1]);
                    thumb.dataset.smCreatorId = creatorId;
                } else {
                    const sixMatch = combined.match(/\/watch\/([A-F0-9]{6})_/i) ||
                                     combined.match(/\/dynamic\/(?:thumbframe|playback)\/([A-F0-9]{6})_/i) ||
                                     combined.match(/([A-F0-9]{6})_[A-F0-9]{8,}/i) ||
                                     combined.match(/\/watch\/([A-F0-9]{6})/i) ||
                                     combined.match(/\/([A-F0-9]{6})(?:[\/_]|$)/i);
                    if (sixMatch) {
                        sixDigit = sixMatch[1].toUpperCase();
                        thumb.dataset.smSix = sixDigit;
                    }
                }
            }

            let isBlocked = false;
            let isWhite = false;

            if (creatorId) {
                isBlocked = isBlockedCreator(creatorId);
                isWhite = isWhitelisted(creatorId);
            } else if (sixDigit) {
                if (currentuser && currentuser.split('@')[0].endsWith(sixDigit)) {
                    isWhite = true;
                    isBlocked = false;
                }
                if (!isWhite) {
                    if (isLast6Blocked(sixDigit)) {
                        isBlocked = true;
                    } else {
                        const white = whitelistedcreators.find(c => cleanCreatorId(c.id).split('@')[0].endsWith(sixDigit));
                        if (white) isWhite = true;
                    }
                }
            }

            if (isBlocked) {
                hide(thumb);
            } else {
                show(thumb);
            }

            if (isBlocked || (creatorId && isSelf(creatorId)) || (sixDigit && currentuser && currentuser.split('@')[0].endsWith(sixDigit))) {
                const existing = thumb.querySelector('.sm-btn-creator');
                if (existing) existing.remove();
                return;
            }

            let resolvedId = creatorId;
            let resolvedName = thumb.dataset.smCreatorName || 'Unknown';
            if (!resolvedId && sixDigit) {
                const matchCreator = blockedcreators.find(c => cleanCreatorId(c.id).split('@')[0].endsWith(sixDigit)) ||
                                     whitelistedcreators.find(c => cleanCreatorId(c.id).split('@')[0].endsWith(sixDigit));
                if (matchCreator) {
                    resolvedId = cleanCreatorId(matchCreator.id);
                    resolvedName = matchCreator.name || 'Unknown';
                }
            }

            if (resolvedId && !isSelf(resolvedId)) {
                let btn = thumb.querySelector('.sm-btn-creator');
                if (!btn) {
                    addBlockBtn(thumb, 'creator', resolvedId, resolvedName, { blocked: false, whitelisted: isWhite });
                } else {
                    const wantState = isWhite ? 'white' : 'normal';
                    if (btn.dataset.smState !== wantState) {
                        btn.dataset.smState = wantState;
                        btn.className = `sm-btn-creator btn btn-sm ${isWhite ? 'btn-success' : 'btn-outline-danger'}`;
                        btn.title = isWhite ? 'Remove whitelist (click), Whitelist (right-click / long-press)' : 'Hide creator (click), Whitelist (right-click / long-press)';
                        btn.innerHTML = isWhite ? '<i class="fas fa-star"></i>' : '<i class="fas fa-ban"></i>';
                    }
                }
            }
        });
    }

    let genealogyLastRun = 0;
    const GENEALOGY_THROTTLE_MS = 800;

    function processGenealogy(force = false) {
        const now = Date.now();
        if (!force && now - genealogyLastRun < GENEALOGY_THROTTLE_MS) return;

        const root = document.getElementById('genealogy-nodes') || document.querySelector('.flipnote-genealogy-tree');
        if (!root) return;

        genealogyLastRun = now;
        const cards = root.querySelectorAll('.flipnote-genealogy-card');
        if (!cards.length) return;

        cards.forEach(card => {
            let creatorId = card.dataset.smCreatorId || null;
            let creatorName = card.dataset.smCreatorName || 'Unknown';

            if (!creatorId) {
                const nodeId = card.getAttribute('data-node-id') || '';
                const userLink = card.querySelector('a[href^="/user/"]');
                if (userLink) {
                    const match = userLink.href.match(/\/user\/([A-F0-9]{16}@DSi)/i);
                    if (match) {
                        creatorId = cleanCreatorId(match[1]);
                        const txt = userLink.textContent?.trim();
                        if (txt && !userLink.querySelector('img')) {
                            creatorName = txt.toLowerCase().startsWith('by ') ? txt.substring(3).trim() : txt;
                        }
                    }
                }

                if (!creatorId) {
                    const img = card.querySelector('img[src*="/dynamic/thumbframe/"], img[src*="/dynamic/playback/"]');
                    if (img) {
                        const src = img.getAttribute('src') || '';
                        const match = src.match(/\/dynamic\/(?:thumbframe|playback)\/([A-F0-9]{16})/i);
                        if (match) creatorId = cleanCreatorId(match[1]);
                    }
                }

                if (!creatorId) {
                    const watchLink = card.querySelector('a[href*="/watch/"]');
                    const candidate = (watchLink?.getAttribute('href') || '') + ' ' + nodeId;
                    let match = candidate.match(/\/user\/([A-F0-9]{16}@DSi)/i);
                    if (match) creatorId = cleanCreatorId(match[1]);
                    else {
                        match = candidate.match(/([A-F0-9]{6})/);
                        if (match) {
                            const six = match[1].toUpperCase();
                            const blocked = blockedcreators.find(c => cleanCreatorId(c.id).split('@')[0].endsWith(six) && !isWhitelisted(c.id));
                            if (blocked) {
                                creatorId = cleanCreatorId(blocked.id);
                                creatorName = blocked.name || 'Unknown';
                            }
                        }
                    }
                }

                if (!creatorId) {
                    card.dataset.smCreatorId = '';
                    return;
                }

                card.dataset.smCreatorId = creatorId;
                card.dataset.smCreatorName = creatorName;

                if (creatorName && creatorName !== 'Unknown') {
                    const existing = creatorNameCache.get(creatorId);
                    creatorNameCache.set(creatorId, { name: creatorName, avatar: existing?.avatar || '' });
                }
            }

            if (!creatorId) return;

            const isBlocked = isBlockedCreator(creatorId);
            const isWhite = isWhitelisted(creatorId);
            const wasBlurred = card.classList.contains('sm-blurred-genealogy');

            if (isBlocked && !wasBlurred) {
                card.classList.add('sm-blurred-genealogy');
                card.querySelectorAll('a').forEach(a => {
                    a.dataset.smOrigHref = a.getAttribute('href') || '';
                    a.removeAttribute('href');
                });
            } else if (!isBlocked && wasBlurred) {
                card.classList.remove('sm-blurred-genealogy');
                card.querySelectorAll('a[data-sm-orig-href]').forEach(a => {
                    a.setAttribute('href', a.dataset.smOrigHref);
                    delete a.dataset.smOrigHref;
                });
            }

            const isCollapsedGroup = card.classList.contains('collapsed-group') || card.classList.contains('collapsed-group-layout') || !!card.querySelector('.collapsed-group-content');

            if (isBlocked || isCollapsedGroup || isSelf(creatorId)) {
                const existingBtn = card.querySelector('.sm-btn-creator');
                if (existingBtn) existingBtn.remove();
            } else if (!card.querySelector('.sm-btn-creator') && !isWhite) {
                addBlockBtn(card, 'creator', creatorId, creatorName, { blocked: false, whitelisted: false });
            }
        });

        root.querySelectorAll('.flipnote-genealogy-card.collapsed-group img.collapsed-group-thumb, .collapsed-group-layout img.collapsed-group-thumb, .collapsed-group-thumbnails img.collapsed-group-thumb').forEach(img => {
            const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
            let blocked = false;

            const fullMatch = src.match(/\/dynamic\/(?:thumbframe|playback)\/([A-F0-9]{16})/i);
            if (fullMatch && isBlockedCreator(cleanCreatorId(fullMatch[1]))) blocked = true;

            if (!blocked) {
                const sixMatch = src.match(/([A-F0-9]{6})/i);
                if (sixMatch && isLast6Blocked(sixMatch[1])) blocked = true;
            }

            if (!blocked) {
                const link = img.closest('a[href*="/user/"], a[href*="/watch/"]');
                if (link) {
                    const href = link.getAttribute('href') || '';
                    const userMatch = href.match(/\/user\/([A-F0-9]{16}@DSi)/i);
                    if (userMatch && isBlockedCreator(cleanCreatorId(userMatch[1]))) blocked = true;
                    else {
                        const watchMatch = href.match(/\/watch\/([A-F0-9]{6})/i) || href.match(/([A-F0-9]{6})_/);
                        if (watchMatch && isLast6Blocked(watchMatch[1])) blocked = true;
                    }
                }
            }

            if (blocked) {
                hide(img);
            } else {
                show(img);
            }
        });
    }

    function processEmptyCards() {
        const trendingItems = document.querySelectorAll('.trending-user, [class*="trending-user"]');
        if (trendingItems.length > 0) {
            const trendingCards = new Set();
            trendingItems.forEach(item => {
                const card = item.closest('.card, .panel, .panel-common, .theme-panel') || item.parentElement?.closest('div');
                if (card) trendingCards.add(card);
            });

            trendingCards.forEach(card => {
                const items = card.querySelectorAll('.trending-user, [class*="trending-user"], a[href*="/user/"]');
                const visible = Array.from(items).filter(el => {
                    if (el.classList.contains('sm-hidden') || el.style.display === 'none') return false;
                    if (el.closest('.sm-hidden')) return false;
                    return true;
                });

                if (visible.length === 0) {
                    hide(card);
                    const col = card.closest('.col, [class*="col-"]');
                    if (col && !col.querySelector('.card:not(.sm-hidden), .panel:not(.sm-hidden), .news-item')) hide(col);
                } else {
                    show(card);
                    const col = card.closest('.col, [class*="col-"]');
                    if (col) show(col);
                }
            });
        }

        const originalHeaders = Array.from(document.querySelectorAll(
            '#left-sidebar .theme-panel-header, #left-sidebar [class*="header"], #left-sidebar [class*="heading"], ' +
            '.theme-panel-header, .panel-header, .card-header'
        )).filter(h => {
            const txt = h.textContent?.trim() || '';
            return /original/i.test(txt) && !/character|creation/i.test(txt);
        });

        originalHeaders.forEach(header => {
            const container = header.parentElement;
            const body = header.nextElementSibling || container?.querySelector('.theme-panel-body, [class*="body"]');
            const wrapper = container?.closest('.col-12, [class*="col-"]');
            const searchTarget = body || container;

            let isBlocked = false;

            const userLink = searchTarget?.querySelector('a[href^="/user/"], a[href*="/user/"]');
            if (userLink) {
                const match = userLink.href.match(/\/user\/([A-F0-9]{16}@DSi)/i);
                if (match && isBlockedCreator(cleanCreatorId(match[1]))) isBlocked = true;
            }

            if (!isBlocked && searchTarget) {
                const img = searchTarget.querySelector('img[src*="thumbframe"], img[src*="playback"], img');
                const watchLink = searchTarget.querySelector('a[href*="/watch/"]');
                const combined = (img?.getAttribute('src') || '') + ' ' + (watchLink?.getAttribute('href') || '');

                const fullMatch = combined.match(/\/dynamic\/(?:thumbframe|playback)\/([A-F0-9]{16})/i);
                if (fullMatch && isBlockedCreator(cleanCreatorId(fullMatch[1]))) {
                    isBlocked = true;
                } else {
                    const sixMatch = combined.match(/([A-F0-9]{6})_/i) || combined.match(/\/watch\/([A-F0-9]{6})/i);
                    if (sixMatch && isLast6Blocked(sixMatch[1])) isBlocked = true;
                }
            }

            const hasPreview = searchTarget?.querySelector('img, a[href*="/watch/"]');

            if (isBlocked || !hasPreview) {
                hide(header);
                if (body) hide(body);
                if (container && container !== document.body && container.id !== 'left-sidebar') hide(container);
                if (wrapper && wrapper.parentElement?.id === 'left-sidebar') hide(wrapper);
            } else {
                show(header);
                if (body) show(body);
                if (container) show(container);
                if (wrapper && wrapper.parentElement?.id === 'left-sidebar') show(wrapper);
            }
        });

        const spinoffHeaders = Array.from(document.querySelectorAll(
            '#left-sidebar .theme-panel-header, #left-sidebar [class*="header"], #left-sidebar [class*="heading"], ' +
            '.theme-panel-header, .panel-header, .card-header'
        )).filter(h => {
            const txt = h.textContent?.trim() || '';
            return /spinoff/i.test(txt);
        });

        const spinoffContainers = new Set();
        spinoffHeaders.forEach(h => { if (h.parentElement) spinoffContainers.add(h.parentElement); });
        document.querySelectorAll('.spinoff-flipnote-list, [class*="spinoff-list"], #spinoff-list').forEach(l => {
            if (l.parentElement) spinoffContainers.add(l.parentElement);
        });

        spinoffContainers.forEach(container => {
            const header = container.querySelector('[class*="header"], [class*="heading"], h1, h2, h3, h4, h5, h6') || container.previousElementSibling;
            const list = container.querySelector('.spinoff-flipnote-list, [class*="spinoff-list"]') || container;
            const wrapper = container.closest('.col-12, [class*="col-"]');
            const items = container.querySelectorAll('.related-flipnote-container, .related-preview, a[href*="/watch/"]');

            items.forEach(item => {
                let blocked = item.classList.contains('sm-hidden') || item.style.display === 'none';
                if (!blocked) {
                    const crId = getCreatorId(item);
                    if (crId && isBlockedCreator(crId)) {
                        blocked = true;
                        hide(item);
                    } else {
                        const img = item.querySelector('img');
                        const a = item.matches('a') ? item : item.querySelector('a');
                        const combined = (img?.getAttribute('src') || '') + ' ' + (a?.getAttribute('href') || '');
                        const sixMatch = combined.match(/([A-F0-9]{6})_/i) || combined.match(/\/watch\/([A-F0-9]{6})/i);
                        if (sixMatch && isLast6Blocked(sixMatch[1])) {
                            blocked = true;
                            hide(item);
                        }
                    }
                }
            });

            const visibleItems = Array.from(items).filter(el => {
                if (el.classList.contains('sm-hidden') || el.style.display === 'none') return false;
                if (el.closest('.sm-hidden')) return false;
                return el.querySelector('img') || el.matches('a:has(img)');
            });

            if (visibleItems.length === 0) {
                if (header) hide(header);
                hide(list);
                if (container && container !== document.body && container.id !== 'left-sidebar') hide(container);
                if (wrapper && wrapper.parentElement?.id === 'left-sidebar') hide(wrapper);
            } else {
                if (header) show(header);
                show(list);
                if (container) show(container);
                if (wrapper && wrapper.parentElement?.id === 'left-sidebar') show(wrapper);
            }
        });
    }

    function skipBlockedSlide(slide, forceDirection = null) {
        if (!slide) return;
        const creatorId = slide.dataset.creatorId;
        if (!creatorId) return;

        if (isBlockedCreator(creatorId)) {
            const dir = forceDirection || scrollDirection;
            let targetSlide = dir === 'down' ? slide.nextElementSibling : slide.previousElementSibling;

            while (targetSlide) {
                if (targetSlide.matches('.flipstream-slide')) {
                    const nextLink = targetSlide.querySelector('a.flipstream-creator-link[href^="/user/"]');
                    const nextId = nextLink?.href.match(/\/user\/([A-F0-9]{16}@DSi)/i)?.[1];
                    if (nextId && !isBlockedCreator(cleanCreatorId(nextId))) break;
                }
                targetSlide = dir === 'down' ? targetSlide.nextElementSibling : targetSlide.previousElementSibling;
            }

            if (targetSlide) targetSlide.scrollIntoView({ behavior: 'auto', block: 'start' });
        }
    }

    function initSlideObserver() {
        if (slideObserver) return;

        document.addEventListener('scroll', (e) => {
            const target = e.target === document ? document.documentElement : e.target;
            const scrollTop = target.scrollTop !== undefined ? target.scrollTop : window.scrollY;
            if (Math.abs(scrollTop - lastScrollTop) > 2) {
                scrollDirection = scrollTop < lastScrollTop ? 'up' : 'down';
                lastScrollTop = scrollTop;
            }
        }, { passive: true, capture: true });

        slideObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const slide = entry.target;
                    const creatorId = slide.dataset.creatorId;
                    if (creatorId) {
                        if (!isBlockedCreator(creatorId)) {
                            activeSlide = slide;
                            updateTopbarButton();
                        } else {
                            skipBlockedSlide(slide);
                        }
                    }
                }
            });
        }, { threshold: 0.15 });
    }

    function updateTopbarButton() {
        const btn = document.getElementById('sm-topbar-btn');
        if (!btn) return;

        if (!activeSlide) activeSlide = document.querySelector('article.flipstream-slide:not(.sm-blocked-slide)');
        if (!activeSlide) { btn.style.display = 'none'; return; }

        const creatorId = activeSlide.dataset.creatorId;
        if (!creatorId || isSelf(creatorId)) { btn.style.display = 'none'; return; }
        btn.style.display = '';

        const isWhite = isWhitelisted(creatorId);
        const isBlocked = isBlockedCreator(creatorId);

        if (isWhite) {
            btn.innerHTML = '<i class="fas fa-star" style="color:#28a745;"></i>';
            btn.title = 'Remove Whitelist (Long-press)';
        } else if (isBlocked) {
            btn.innerHTML = '<i class="fas fa-ban" style="color:#dc3545;"></i>';
            btn.title = 'Unblock Creator';
        } else {
            btn.innerHTML = '<i class="fas fa-ban" style="color:#fff; opacity:0.8;"></i>';
            btn.title = 'Block Creator (Right-click/Long-press to Whitelist)';
        }
    }

    function injectTopbarButton() {
        if (document.getElementById('sm-topbar-btn')) return;
        const container = document.querySelector('.flipstream-topbar-actions');
        if (!container) return;

        const btn = document.createElement('button');
        btn.id = 'sm-topbar-btn';
        btn.className = 'flipstream-icon-button';
        btn.type = 'button';
        btn.style.marginLeft = '12px';

        btn.onclick = (e) => {
            e.stopPropagation();
            if (!activeSlide) return;
            const creatorId = activeSlide.dataset.creatorId;
            if (!creatorId || isSelf(creatorId)) return;

            const cached = creatorNameCache.get(creatorId);
            const name = cached?.name || 'Unknown';

            if (whitelistedcreators.some(c => cleanCreatorId(c.id) === creatorId)) {
                unwhitelistCreator(creatorId);
            } else if (blockedcreators.some(c => cleanCreatorId(c.id) === creatorId)) {
                unblockCreator(creatorId);
            } else {
                blockCreator(creatorId, name);
            }
            processFlipstreamSlides();
            skipBlockedSlide(activeSlide, 'down');
            updateTopbarButton();
        };

        const toggleWhitelist = () => {
            if (!activeSlide) return;
            const creatorId = activeSlide.dataset.creatorId;
            if (!creatorId || isSelf(creatorId)) return;

            const cached = creatorNameCache.get(creatorId);
            const name = cached?.name || 'Unknown';

            if (whitelistedcreators.some(c => cleanCreatorId(c.id) === creatorId)) unwhitelistCreator(creatorId);
            else whitelistCreator(creatorId, name);

            processFlipstreamSlides();
            updateTopbarButton();
        };

        let pressTimer = null;
        btn.addEventListener('mousedown', e => { if (e.button === 2) { e.preventDefault(); toggleWhitelist(); } });
        btn.addEventListener('touchstart', () => { pressTimer = setTimeout(toggleWhitelist, 600); });
        btn.addEventListener('touchend', () => clearTimeout(pressTimer));
        btn.addEventListener('touchcancel', () => clearTimeout(pressTimer));
        btn.addEventListener('contextmenu', e => e.preventDefault());

        container.appendChild(btn);
        updateTopbarButton();
    }

    function processFlipstreamSlides() {
        if (hideFlipstreams) return;
        initSlideObserver();
        injectTopbarButton();

        document.querySelectorAll('article.flipstream-slide').forEach(slide => {
            const creatorLink = slide.querySelector('a.flipstream-creator-link[href^="/user/"]');
            if (creatorLink) {
                const match = creatorLink.href.match(/\/user\/([A-F0-9]{16}@DSi)/i);
                if (match) {
                    const creatorId = cleanCreatorId(match[1]);
                    slide.dataset.creatorId = creatorId;

                    const name = creatorLink.textContent?.trim() || '';
                    const avatarImg = slide.querySelector('img.flipstream-avatar');
                    let avatar = avatarImg?.getAttribute('src') || '';
                    if (avatar && avatar.startsWith('/')) avatar = 'https://www.sudomemo.net' + avatar;

                    if (name && !creatorNameCache.has(creatorId)) creatorNameCache.set(creatorId, { name, avatar });

                    const isBlocked = isBlockedCreator(creatorId);
                    slideObserver.observe(slide);

                    if (isBlocked) {
                        slide.classList.add('sm-blocked-slide');
                        const video = slide.querySelector('video');
                        if (video) {
                            try { video.pause(); video.muted = true; } catch {}
                        }
                    } else {
                        slide.classList.remove('sm-blocked-slide');
                    }
                }
            }
        });
    }

    function processUpsells() {
        if (hideUpsells) {
            document.querySelectorAll('.navbar-nav a[href*="/shop"]').forEach(a => {
                const li = a.closest('li') || a;
                hide(li);
            });

            const standardUpsells = document.querySelectorAll(
                'a[href*="discord.gg"], a[href*="discord.com"], ' +
                'a[href*="patreon.com"], ' +
                'a[href*="/shop"], a[href*="shop.sudomemo.net"], ' +
                'a[href*="plush"], img[src*="plush"], img[alt*="plush" i], ' +
                'a[data-banner-name*="discord_slim"], a[data-banner-name*="patreon_slim"], ' +
                'a[data-banner-name*="ziggy_patreon"], a[data-banner-name*="shorts_theatre"], ' +
                'a[data-banner-name*="sudomemo_org_slim"], a[data-banner-name*="plush"], ' +
                'a[data-banner-name*="merch"]'
            );

            standardUpsells.forEach(el => {
                const adBox = el.closest('.advert, .theme-advert-card, [class*="advert"]');
                if (adBox) {
                    hide(adBox);
                    const col = adBox.closest('.col, [class*="col-"]');
                    if (col && !col.querySelector('.card:not(.theme-advert-card), #genealogy-nodes, .trending-user, .news-item, h1, h2, h3, h4, h5')) {
                        hide(col);
                    }
                } else {
                    const container = el.closest('li, .btn, .nav-item') || el;
                    hide(container);
                }
            });
        }

        if (hideGoodUpsells) {
            const goodUpsells = document.querySelectorAll(
                'a[data-banner-name*="flipnote_organizer_promo"], ' +
                'a[data-banner-name*="organizer_slim"], ' +
                'a[data-banner-name*="archive_slim"], ' +
                'a[data-banner-name*="sudomemo_wii_room"], ' +
                'a[data-banner-name*="3ds_install_guide"], ' +
                'a[data-banner-name*="staying_safe_online"], ' +
                '#left-sidebar .card.theme-advert-card'
            );

            goodUpsells.forEach(el => {
                const adBox = el.closest('.advert, .theme-advert-card, .card') || el;
                hide(adBox);
            });
        }
    }

    function processAll() {
        detectCurrentUser();
        harvestCreatorNames();
        processUpsells();
        document.querySelectorAll('.flipnote-item, .flipnote-list-item, .channel-card, .cat-box, .playlist-flipnote, .trending-user, .recommended-item, li:has(.rec-thumbnail), .watch-next-item, .search-samples__item, .search-result').forEach(processItem);
        processSpotlight();
        processEmbeds();
        processRelatedFlipnotes();
        processChannelPreviews(true);
        processGenealogy();
        processEmptyCards();
        if (!hideFlipstreams) {
            processFlipstreams();
            processFlipstreamSlides();
        }
    }

    function blockChannel(id, name = null) {
        if (!id || blockedchannels.some(c => c.id.toUpperCase() === id.toUpperCase())) return;
        blockedchannels.push({ id: id.trim(), name: name || id });
        saveblockedchannels();
        channelmap.get(id)?.forEach(hide);
    }

    function unblockChannel(id) {
        blockedchannels = blockedchannels.filter(c => c.id.toUpperCase() !== id.toUpperCase());
        saveblockedchannels();
        channelmap.get(id)?.forEach(show);
    }

    function blockCreator(id, name = null) {
        const cleanId = cleanCreatorId(id);
        if (!cleanId || isSelf(cleanId) || isWhitelisted(cleanId) || blockedcreators.some(c => cleanCreatorId(c.id) === cleanId)) return;
        const cached = creatorNameCache.get(cleanId);
        const avatar = cached?.avatar || '';
        blockedcreators.push({ id: cleanId, name: name || 'Unknown', avatar });
        saveblockedcreators();
        creatormap.get(cleanId)?.forEach(hide);
        processGenealogy(true);
        processRelatedFlipnotes();
        processChannelPreviews(true);
        processEmptyCards();
    }

    function unblockCreator(id) {
        const cleanId = cleanCreatorId(id);
        blockedcreators = blockedcreators.filter(c => cleanCreatorId(c.id) !== cleanId);
        saveblockedcreators();
        creatormap.get(cleanId)?.forEach(show);
        processGenealogy(true);
        processRelatedFlipnotes();
        processChannelPreviews(true);
        processEmptyCards();
    }

    function whitelistCreator(id, name = null) {
        const cleanId = cleanCreatorId(id);
        if (!cleanId || whitelistedcreators.some(c => cleanCreatorId(c.id) === cleanId)) return;
        const cached = creatorNameCache.get(cleanId);
        const avatar = cached?.avatar || '';
        whitelistedcreators.push({ id: cleanId, name: name || 'Unknown', avatar });
        savewhitelistedcreators();
        unblockCreator(cleanId);
        creatormap.get(cleanId)?.forEach(show);
        processGenealogy(true);
        processRelatedFlipnotes();
        processChannelPreviews(true);
        processEmptyCards();
    }

    function unwhitelistCreator(id) {
        const cleanId = cleanCreatorId(id);
        whitelistedcreators = whitelistedcreators.filter(c => cleanCreatorId(c.id) !== cleanId);
        savewhitelistedcreators();
        processGenealogy(true);
        processRelatedFlipnotes();
        processChannelPreviews(true);
        processEmptyCards();
    }

    function getCreatorIdFromSidebar() {
        const link = document.querySelector('#left-sidebar .details-profile-container .profile-right .name a.theme-link.flipnote-title-link');
        const match = link?.href.match(/\/user\/([A-F0-9]{16}@DSi)/i);
        return match ? cleanCreatorId(match[1]) : null;
    }

    function shouldRedirect() {
        const p = location.pathname;

        if (hideFlipstreams && p.startsWith('/flipstream')) return true;
        if (isWeeklyTopicCategoryPage()) return false;

        if (p.startsWith('/channel/')) {
            const chId = p.split('/')[2];
            if (chId && blockedchannels.some(c => c.id.toUpperCase() === chId.toUpperCase())) return true;
        }

        if (p.startsWith('/watch/')) {
            const channelLink = document.querySelector('a[href^="/channel/"]');
            if (channelLink) {
                const chId = channelLink.href.match(/\/channel\/([a-zA-Z0-9_-]+)/)?.[1];
                if (chId && blockedchannels.some(c => c.id.toUpperCase() === chId.toUpperCase())) {
                    const flipnoteEl = document.querySelector('.flipnote-title-link[href^="/user/"], .username a[href^="/user/"]');
                    if (flipnoteEl) {
                        const creatorId = cleanCreatorId(flipnoteEl.href.match(/\/user\/([A-F0-9]{16}@DSi)/i)?.[1]);
                        if (creatorId && (isWhitelisted(creatorId) || isSelf(creatorId))) return false;
                    }
                    return true;
                }
            }

            const flipnoteEl = document.querySelector('.flipnote-title-link[href^="/user/"], .username a[href^="/user/"]');
            if (flipnoteEl) {
                const creatorId = cleanCreatorId(flipnoteEl.href.match(/\/user\/([A-F0-9]{16}@DSi)/i)?.[1]);
                if (creatorId && !isSelf(creatorId) && !isWhitelisted(creatorId) && blockedcreators.some(c => cleanCreatorId(c.id) === creatorId)) return true;
            }
        }

        if (p.startsWith('/user/')) {
            let id = cleanCreatorId(p.split('/')[2]);
            if (!id) id = getCreatorIdFromSidebar();
            if (id && isSelf(id)) return false;
            if (id && !isWhitelisted(id) && blockedcreators.some(c => cleanCreatorId(c.id) === id)) return true;
        }

        return false;
    }

    function updateCreatorBtn(btn, isBlocked, isWhite) {
        btn.className = `sm-btn-creator btn btn-sm ms-2 ${isBlocked ? 'btn-danger' : isWhite ? 'btn-success' : 'btn-outline-danger'}`;
        btn.innerHTML = isWhite ? '<i class="fas fa-star"></i>' : '<i class="fas fa-ban"></i>';
        btn.title = isWhite ? 'Remove whitelist' : 'Hide this creator';
    }

    function addBlockBtn(el, type, id, name, status) {
        if (type === 'channel' && isWeeklyTopicCategoryPage()) return;
        if (type === 'creator' && (status.whitelisted || isSelf(id))) return;
        if (el.querySelector(`.sm-btn-${type}`)) return;

        const btn = document.createElement('button');
        btn.className = `sm-btn-${type} btn btn-sm ${status.blocked ? 'btn-danger' : status.whitelisted ? 'btn-success' : 'btn-outline-danger'}`;
        btn.title = type === 'channel'
            ? (status.blocked ? 'Show channel' : 'Hide channel')
            : (status.whitelisted ? 'Remove whitelist' : 'Hide this creator');

        btn.innerHTML = type === 'channel'
            ? (status.blocked ? '<i class="fas fa-eye"></i>' : '<i class="fas fa-eye-slash"></i>')
            : status.whitelisted ? '<i class="fas fa-star"></i>' : '<i class="fas fa-ban"></i>';

        btn.onclick = e => {
            e.stopPropagation();
            e.preventDefault();
            if (type === 'channel') {
                if (status.blocked) {
                    unblockChannel(id);
                    status.blocked = false;
                    btn.className = 'sm-btn-channel btn btn-sm btn-outline-danger';
                    btn.title = 'Hide channel';
                    btn.innerHTML = '<i class="fas fa-eye-slash"></i>';
                } else {
                    blockChannel(id, name);
                    status.blocked = true;
                    btn.className = 'sm-btn-channel btn btn-sm btn-danger';
                    btn.title = 'Show channel';
                    btn.innerHTML = '<i class="fas fa-eye"></i>';
                }
            } else {
                const cleanId = cleanCreatorId(id);
                const cached = creatorNameCache.get(cleanId);
                const finalName = cached?.name || name || 'Unknown';

                const isWhite = whitelistedcreators.some(c => cleanCreatorId(c.id) === cleanId);
                const isBlocked = blockedcreators.some(c => cleanCreatorId(c.id) === cleanId);
                if (isWhite) {
                    unwhitelistCreator(cleanId);
                } else if (isBlocked) {
                    unblockCreator(cleanId);
                } else {
                    blockCreator(cleanId, finalName);
                }
                const nowWhite = whitelistedcreators.some(c => cleanCreatorId(c.id) === cleanId);
                updateCreatorBtn(btn, blockedcreators.some(c => cleanCreatorId(c.id) === cleanId), nowWhite);
            }
        };

        if (type === 'creator') {
            let pressTimer = null;
            const toggleWhitelist = () => {
                const cleanId = cleanCreatorId(id);
                const cached = creatorNameCache.get(cleanId);
                const finalName = cached?.name || name || 'Unknown';
                const isWhite = whitelistedcreators.some(c => cleanCreatorId(c.id) === cleanId);
                if (isWhite) unwhitelistCreator(cleanId);
                else whitelistCreator(cleanId, finalName);
                updateCreatorBtn(btn, blockedcreators.some(c => cleanCreatorId(c.id) === cleanId), !isWhite);
            };
            btn.addEventListener('mousedown', e => { if (e.button === 2) { e.preventDefault(); toggleWhitelist(); } });
            btn.addEventListener('touchstart', () => { pressTimer = setTimeout(toggleWhitelist, 600); });
            btn.addEventListener('touchend', () => clearTimeout(pressTimer));
            btn.addEventListener('touchcancel', () => clearTimeout(pressTimer));
            btn.addEventListener('touchmove', () => clearTimeout(pressTimer));
            btn.addEventListener('contextmenu', e => e.preventDefault());
        }

        const catThumbImg = el.querySelector('.category-thumbs .thumb a img.flipnote-hoverpreview-img, .category-thumbs img.flipnote-hoverpreview-img');
        const thumbContainer = (catThumbImg && (catThumbImg.closest('a') || catThumbImg.parentElement)) ||
                               el.querySelector('div.flipnote-item-thumb, .flipstream-thumbnail-card__frame, .related-preview a, .related-preview, .flipnote-genealogy-card') ||
                               el.querySelector('.playlist-flipnote-thumb, .rec-thumbnail, .search-samples__thumb, .search-movie__thumb-link')?.closest('a, div') ||
                               el.querySelector('img')?.parentElement;

        if (thumbContainer) {
            thumbContainer.style.position = 'relative';
            if (thumbContainer.tagName === 'A') thumbContainer.style.display = 'inline-block';
            thumbContainer.appendChild(btn);
        } else {
            const target = el.querySelector('.flipnote-stats, .stats, .username, .meta, .flipnote-item-info') || el.lastElementChild;
            if (target) target.appendChild(btn);
        }

        el.classList.add('sm-btn-added');
    }

    function renderList(list, type, iconFn = null) {
        if (!list || list.length === 0) return `<div class="text-muted py-5 text-center"><i class="fas fa-inbox fa-3x mb-3"></i><br>Empty.</div>`;
        let html = `<div class="list-group list-group-flush">`;

        list.forEach(item => {
            const safeName = escapeHTML(item.name || item.id);
            const safeId = escapeHTML(item.id);

            let iconHtml = '';
            if (type === 'channel' && iconFn) {
                const safeUrl = escapeHTML(iconFn(item.id));
                iconHtml = `<img src="${safeUrl}" width="40" height="40" class="me-3 rounded" onerror="this.style.display='none'">`;
            } else if (type === 'creator') {
                const cleanId = cleanCreatorId(item.id);
                const cached = creatorNameCache.get(cleanId);
                const rawAvatar = item.avatar || cached?.avatar || '';

                if (rawAvatar && (rawAvatar.startsWith('https://') || rawAvatar.startsWith('/'))) {
                    const safeAvatar = escapeHTML(rawAvatar);
                    iconHtml = `<img src="${safeAvatar}" width="40" height="40" class="me-3 rounded sm-avatar-img" data-id="${safeId}" onerror="this.style.display='none'">`;
                } else {
                    iconHtml = `<div class="me-3 sm-avatar-placeholder" data-id="${safeId}"><i class="fas fa-user text-muted"></i></div>`;
                }
            }

            html += `
                <div class="list-group-item bg-dark border-secondary d-flex align-items-center py-3" data-id="${safeId}">
                    ${iconHtml}
                    <div class="flex-grow-1">
                        <div class="fw-bold">${safeName}</div>
                        <small class="text-muted">${safeId}</small>
                    </div>
                    <button class="btn btn-sm btn-outline-danger sm-unblock" data-id="${safeId}">Remove</button>
                </div>`;
        });
        html += `</div>`;
        return html;
    }

    function openBlocklistModal() {
        const existing = document.getElementById('sm-blocklist-modal');
        if (existing) existing.remove();

        const backdrop = document.createElement('div');
        backdrop.id = 'sm-blocklist-modal';
        Object.assign(backdrop.style, { position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.75)', zIndex: 9999, display: 'flex', justifyContent: 'center', alignItems: 'center' });

        const dialog = document.createElement('div');
        dialog.className = 'sm-dialog';
        dialog.innerHTML = `
            <div class="row g-2 mb-4">
                <div class="col-4">
                    <button id="sm-show-channels" class="btn btn-outline-primary w-100 py-3 d-flex flex-column align-items-center gap-2">
                        <i class="fas fa-tv fa-lg"></i>
                        <span class="small fw-bold">Channels</span>
                    </button>
                </div>
                <div class="col-4">
                    <button id="sm-show-blocked" class="btn btn-outline-danger w-100 py-3 d-flex flex-column align-items-center gap-2">
                        <i class="fas fa-user-slash fa-lg"></i>
                        <span class="small fw-bold">Creators</span>
                    </button>
                </div>
                <div class="col-4">
                    <button id="sm-show-whitelist" class="btn btn-outline-success w-100 py-3 d-flex flex-column align-items-center gap-2">
                        <i class="fas fa-star fa-lg"></i>
                        <span class="small fw-bold">Whitelisted</span>
                    </button>
                </div>
            </div>

            <div class="input-group mb-2">
                <select id="sm-add-type" class="form-select bg-dark text-light border-secondary" style="max-width: 110px;">
                    <option value="channel">Channel</option>
                    <option value="creator">Creator</option>
                </select>
                <input id="sm-add-id" type="text" class="form-control bg-dark text-light border-secondary" placeholder="Enter ID">
                <button id="sm-add-btn" class="btn btn-success"><i class="fas fa-plus"></i></button>
            </div>
            <p id="sm-add-hint" class="text-muted small px-1 mb-4">Channel ID from /channel/...</p>

            <div class="card bg-dark border-secondary p-3 mb-4">
                <h6 class="text-uppercase small tracking-wider text-muted mb-3 fw-bold">Preferences</h6>

                <div class="form-check form-switch mb-3">
                    <input class="form-check-input" type="checkbox" id="sm-toggle-hide-upsells" ${hideUpsells ? 'checked' : ''}>
                    <label class="form-check-label d-inline-flex align-items-center" for="sm-toggle-hide-upsells">
                        Hide Upsells
                        <span class="sm-help-badge" title="Hides Discord, Patreon, Shop/Merchandise, Plush ads, and YouTube Shorts promotions.">?</span>
                    </label>
                    <div class="text-muted small ps-1 mt-1">Discord, Patreon, Merch, Plush, Shorts promo</div>
                </div>

                <div class="form-check form-switch mb-3">
                    <input class="form-check-input" type="checkbox" id="sm-toggle-hide-good-upsells" ${hideGoodUpsells ? 'checked' : ''}>
                    <label class="form-check-label d-inline-flex align-items-center" for="sm-toggle-hide-good-upsells">
                        Hide Good Upsells
                        <span class="sm-help-badge" title="Hides Wii Room links, 3DS Install Guides, safety guidelines, and backup archives.">?</span>
                    </label>
                    <div class="text-muted small ps-1 mt-1">Wii Room, 3DS Guides, backup archives</div>
                </div>

                <div class="form-check form-switch mb-0">
                    <input class="form-check-input" type="checkbox" id="sm-toggle-hide-flipstreams" ${hideFlipstreams ? 'checked' : ''}>
                    <label class="form-check-label d-inline-flex align-items-center" for="sm-toggle-hide-flipstreams">
                        Hide Flipstream
                        <span class="sm-help-badge" title="Hides all Flipstream components and prevents loading/redirects to the flipstream feed.">?</span>
                    </label>
                    <div class="text-muted small ps-1 mt-1">Blocks the Flipstream video feed entirely</div>
                </div>
            </div>

            <hr class="my-3 border-secondary">

            <div class="row g-2 mt-2">
                <div class="col-6">
                    <button id="sm-import-btn" class="btn btn-outline-secondary btn-sm w-100 py-2"><i class="fas fa-file-import me-1"></i> Import</button>
                </div>
                <div class="col-6">
                    <button id="sm-export-all" class="btn btn-outline-secondary btn-sm w-100 py-2"><i class="fas fa-file-export me-1"></i> Export All</button>
                </div>
            </div>
        `;

        backdrop.appendChild(dialog);
        document.body.appendChild(backdrop);

        backdrop.onclick = e => { if (e.target === backdrop) backdrop.remove(); };
        document.getElementById('sm-show-channels').onclick = () => { backdrop.remove(); openListWindow('channel'); };
        document.getElementById('sm-show-blocked').onclick = () => { backdrop.remove(); openListWindow('blocked'); };
        document.getElementById('sm-show-whitelist').onclick = () => { backdrop.remove(); openListWindow('whitelist'); };

        document.getElementById('sm-export-all').onclick = () => {
            const data = { blockedchannels, blockedcreators, whitelistedcreators };
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'sudomemo_blocklist.json';
            a.click();
            URL.revokeObjectURL(url);
        };

        document.getElementById('sm-toggle-hide-upsells').onchange = e => {
            hideUpsells = e.target.checked;
            GM_setValue('hideupsells', hideUpsells);
            processUpsells();
        };

        document.getElementById('sm-toggle-hide-good-upsells').onchange = e => {
            hideGoodUpsells = e.target.checked;
            GM_setValue('hidegoodupsells', hideGoodUpsells);
            processUpsells();
        };

        document.getElementById('sm-toggle-hide-flipstreams').onchange = e => {
            hideFlipstreams = e.target.checked;
            GM_setValue('hideflipstreams', hideFlipstreams);
        };

        const addType = document.getElementById('sm-add-type');
        const addInput = document.getElementById('sm-add-id');

        addType.addEventListener('change', () => {
            addInput.placeholder = addType.value === 'channel' ? 'Channel ID' : 'Creator ID (XXXX@DSi)';
            document.getElementById('sm-add-hint').textContent = addType.value === 'channel'
                ? 'Channel ID from /channel/1234ABCD'
                : 'Creator IDs end with "@DSi"';
        });

        document.getElementById('sm-add-btn').onclick = () => {
            let id = addInput.value.trim();
            if (!id) return;
            if (addType.value === 'channel') blockChannel(id);
            else blockCreator(cleanCreatorId(id));
            addInput.value = '';
        };

        document.getElementById('sm-import-btn').onclick = () => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json';
            input.onchange = e => {
                const file = e.target.files[0];
                if (!file) return;
                const reader = new FileReader();
                reader.onload = ev => {
                    try {
                        const parsed = JSON.parse(ev.target.result);
                        if (typeof parsed !== 'object' || parsed === null) throw new Error();

                        blockedchannels = sanitizeList(parsed.blockedchannels, false);
                        blockedcreators = sanitizeList(parsed.blockedcreators, true);
                        whitelistedcreators = sanitizeList(parsed.whitelistedcreators, true);

                        saveblockedchannels();
                        saveblockedcreators();
                        savewhitelistedcreators();

                        alert('Imported successfully.');
                        backdrop.remove();
                    } catch {
                        alert('Invalid or corrupted blocklist JSON file.');
                    }
                };
                reader.readAsText(file);
            };
            input.click();
        };
    }

    function openListWindow(mode) {
        const isChannel = mode === 'channel';
        const isWhitelist = mode === 'whitelist';
        const list = isChannel ? blockedchannels : isWhitelist ? whitelistedcreators : blockedcreators;
        const title = isChannel ? 'Hidden Channels' : isWhitelist ? 'Whitelisted Creators' : 'Hidden Creators';
        const iconColor = isChannel ? '#4dabf7' : isWhitelist ? '#28a745' : '#ff6b6b';
        const icon = isChannel ? 'tv' : (isWhitelist ? 'star' : 'user');

        const backdrop = document.createElement('div');
        backdrop.style.cssText = 'position:fixed; inset:0; background:rgba(0,0,0,0.8); z-index:10000; display:flex; justify-content:center; align-items:center;';

        const dialog = document.createElement('div');
        dialog.style.cssText = 'background:#121212; color:#e0e0e0; border:1px solid #333; border-radius:12px; width:620px; max-width:94%; max-height:90vh; overflow:hidden; display:flex; flex-direction:column;';
        dialog.innerHTML = `
            <div class="p-4 pb-2 d-flex justify-content-between align-items-center">
                <button class="btn btn-sm btn-outline-secondary back-btn"><i class="fas fa-arrow-left me-2"></i>Back</button>
                <div class="text-center flex-grow-1">
                    <h5><i class="fas fa-${icon}" style="color:${iconColor}"></i> ${title}</h5>
                    <small>${list.length} item${list.length !== 1 ? 's' : ''}</small>
                </div>
                <button class="btn btn-sm close" style="background:rgba(255,255,255,0.05);color:#ccc;">x</button>
            </div>
            <div class="px-4 pb-4" style="overflow-y:auto; flex-grow:1;">
                ${renderList(list, isChannel ? 'channel' : 'creator', isChannel ? id => `https://www.sudomemo.net/theatre_assets/images/dynamic/channel/${encodeURIComponent(id)}.png` : null)}
            </div>
        `;

        backdrop.appendChild(dialog);
        document.body.appendChild(backdrop);

        dialog.querySelector('.close').onclick = () => backdrop.remove();
        backdrop.onclick = e => { if (e.target === backdrop) backdrop.remove(); };
        dialog.querySelector('.back-btn').onclick = () => { backdrop.remove(); openBlocklistModal(); };

        if (mode === 'blocked' || mode === 'whitelist') {
            const queue = [...list];
            let activeRequests = 0;
            const maxConcurrency = 2;

            function runQueue() {
                while (activeRequests < maxConcurrency && queue.length > 0) {
                    const item = queue.shift();
                    activeRequests++;

                    resolveCreatorName(item.id, (resolvedName, resolvedAvatar) => {
                        const safeId = escapeHTML(item.id);

                        dialog.querySelectorAll(`.sm-avatar-placeholder[data-id="${safeId}"]`).forEach(placeholder => {
                            if (resolvedAvatar) {
                                const img = document.createElement('img');
                                img.src = resolvedAvatar;
                                img.width = 40;
                                img.height = 40;
                                img.className = 'me-3 rounded sm-avatar-img';
                                img.dataset.id = item.id;
                                img.onerror = () => { img.style.display = 'none'; };
                                placeholder.replaceWith(img);
                            }
                        });

                        dialog.querySelectorAll(`img.sm-avatar-img[data-id="${safeId}"]`).forEach(img => {
                            if (resolvedAvatar && img.src !== resolvedAvatar) {
                                img.src = resolvedAvatar;
                                img.style.display = '';
                            }
                        });

                        const row = dialog.querySelector(`.list-group-item[data-id="${safeId}"]`);
                        if (row) {
                            const nameEl = row.querySelector('.fw-bold');
                            if (nameEl && resolvedName && nameEl.textContent !== resolvedName) {
                                nameEl.textContent = resolvedName;
                            }
                        }
                    }, true).finally(() => {
                        activeRequests--;
                        setTimeout(runQueue, 150);
                    });
                }
            }
            runQueue();
        }

        dialog.querySelectorAll('.sm-unblock').forEach(btn => {
            btn.onclick = () => {
                const id = btn.dataset.id;
                if (isChannel) unblockChannel(id);
                else if (isWhitelist) unwhitelistCreator(id);
                else unblockCreator(id);

                const row = btn.closest('.list-group-item');
                if (row) {
                    row.style.opacity = '0';
                    row.style.maxHeight = '0px';
                    row.style.padding = '0px';
                    row.style.border = 'none';
                    setTimeout(() => {
                        row.remove();
                        const countEl = dialog.querySelector('.p-4.pb-2 small');
                        if (countEl) {
                            const currentCount = parseInt(countEl.textContent) || 0;
                            const newCount = Math.max(0, currentCount - 1);
                            countEl.textContent = `${newCount} item${newCount !== 1 ? 's' : ''}`;
                            if (newCount === 0) {
                                const container = dialog.querySelector('.px-4.pb-4');
                                if (container) container.innerHTML = '<div class="text-muted py-5 text-center"><i class="fas fa-inbox fa-3x mb-3"></i><br>Empty.</div>';
                            }
                        }
                    }, 250);
                }
            };
        });
    }

    function injectMenuButton() {
        if (document.getElementById('sm-nav-btn')) return;
        const btn = document.createElement('button');
        btn.id = 'sm-nav-btn';
        btn.innerHTML = '<i class="fas fa-ban"></i>';
        btn.title = 'Blocklist';
        btn.onclick = openBlocklistModal;
        Object.assign(btn.style, {
            position: 'fixed', bottom: '1.5rem', right: '1rem', zIndex: 9999,
            background: '#dc3545', color: 'white', border: 'none',
            width: '48px', height: '48px', borderRadius: '50%',
            fontSize: '1.4rem', display: 'flex', alignItems: 'center',
            justifyContent: 'center', boxShadow: '0 2px 8px rgba(0,0,0,0.4)'
        });
        document.body.appendChild(btn);
    }

    function init() {
        loadSets();
        detectCurrentUser();
        processAll();
        injectMenuButton();
        setInterval(injectMenuButton, 2000);

        new MutationObserver(muts => {
            if (mutationDebounceTimer) return;
            mutationDebounceTimer = setTimeout(() => {
                mutationDebounceTimer = null;
                if (shouldRedirect()) {
                    safeRedirect();
                    return;
                }
                processUpsells();
                processSpotlight();
                processEmbeds();
                processRelatedFlipnotes();
                processEmptyCards();
                if (!hideFlipstreams) {
                    processFlipstreams();
                    processFlipstreamSlides();
                }
            }, 250);

            muts.forEach(m => {
                if (m.addedNodes.length) m.addedNodes.forEach(n => {
                    if (n.nodeType !== 1) return;
                    if (n.matches('.flipnote-item, .flipnote-list-item, .channel-card, .cat-box, .playlist-flipnote, .trending-user, .recommended-item, li:has(.rec-thumbnail), .watch-next-item, .search-samples__item, .search-result')) processItem(n);
                    else n.querySelectorAll('.flipnote-item, .flipnote-list-item, .channel-card, .cat-box, .playlist-flipnote, .trending-user, .recommended-item, li:has(.rec-thumbnail), .watch-next-item, .search-samples__item, .search-result').forEach(processItem);
                });
            });
        }).observe(document.body, { childList: true, subtree: true });

        setInterval(() => {
            detectCurrentUser();
            harvestCreatorNames();
            processUpsells();

            const onWeeklyTopics = isWeeklyTopicCategoryPage();

            document.querySelectorAll('.flipnote-item:not(.sm-btn-added), .flipnote-list-item:not(.sm-btn-added), .channel-card:not(.sm-btn-added), .cat-box:not(.sm-btn-added), .playlist-flipnote:not(.sm-btn-added), .recommended-item:not(.sm-btn-added), li:has(.rec-thumbnail):not(.sm-btn-added), .watch-next-item:not(.sm-btn-added), .search-samples__item:not(.sm-btn-added), .search-result:not(.sm-btn-added)')
                .forEach(el => {
                    const isChannelCard = el.matches('.channel-card, .cat-box, .channel-grid-item') || el.classList.contains('channel-card') || el.classList.contains('cat-box');

                    if (isChannelCard) {
                        if (!onWeeklyTopics && !el.querySelector('.category-thumbs .thumb')) {
                            const ch = getChannelId(el);
                            const chName = getChannelName(el);
                            if (ch) addBlockBtn(el, 'channel', ch, chName, { blocked: blockedchannels.some(c => c.id.toUpperCase() === ch.toUpperCase()) });
                        }
                        el.classList.add('sm-btn-added');
                        return;
                    }

                    if (el.querySelector('.category-thumbs .thumb')) {
                        el.classList.add('sm-btn-added');
                        return;
                    }

                    const cr = getCreatorId(el);
                    const crName = getCreatorName(el);
                    if (cr) {
                        const isBlocked = isBlockedCreator(cr);
                        const isWhite = isWhitelisted(cr);
                        if (!isWhite && !isSelf(cr)) {
                            addBlockBtn(el, 'creator', cr, crName, { blocked: isBlocked, whitelisted: false });
                        }
                    }
                    el.classList.add('sm-btn-added');
                });

            processSpotlight();
            processEmbeds();
            processRelatedFlipnotes();
            processChannelPreviews();
            processGenealogy();
            processEmptyCards();

            if (!hideFlipstreams) {
                processFlipstreams();
                processFlipstreamSlides();
            }
        }, 1200);

        if (shouldRedirect()) safeRedirect();
    }

    GM_addStyle(`
        .sm-btn-creator,
        .sm-btn-channel {
            position: absolute !important;
            top: 8px !important;
            right: 8px !important;
            width: 28px !important;
            height: 28px !important;
            border-radius: 50% !important;
            padding: 0 !important;
            font-size: 0.9rem !important;
            opacity: 0;
            transition: opacity 0.2s;
            z-index: 10;
            background: rgba(220, 53, 69, 0.9) !important;
            color: white !important;
            border: none !important;
            display: none;
            align-items: center !important;
            justify-content: center !important;
            line-height: 1 !important;
        }

        .flipnote-list-item:hover .sm-btn-creator,
        .flipstream-list-item:hover .sm-btn-creator,
        .playlist-flipnote:hover .sm-btn-creator,
        .recommended-item:hover .sm-btn-creator,
        li:has(.rec-thumbnail):hover .sm-btn-creator,
        .watch-next-item:hover .sm-btn-creator,
        .search-samples__item:hover .sm-btn-creator,
        .search-result:hover .sm-btn-creator,
        .related-flipnote-container:hover .sm-btn-creator,
        .related-preview:hover .sm-btn-creator,
        .related-preview a:hover .sm-btn-creator,
        .flipnote-genealogy-card:hover .sm-btn-creator,
        .channel-card:not(:has(.category-thumbs)):hover .sm-btn-channel,
        .cat-box:not(:has(.category-thumbs)):hover .sm-btn-channel {
            opacity: 1;
            display: flex;
        }

        .category-thumbs .thumb:hover > .sm-btn-creator,
        .category-thumbs .thumb:hover > a > .sm-btn-creator,
        .category-thumbs .thumb a:hover > .sm-btn-creator,
        .channel-thumbs .thumb:hover > .sm-btn-creator,
        .channel-thumbs .thumb a:hover > .sm-btn-creator,
        .cat-box .thumb:hover > .sm-btn-creator,
        .cat-box .thumb a:hover > .sm-btn-creator,
        .channel-card .thumb:hover > .sm-btn-creator,
        .channel-card .thumb a:hover > .sm-btn-creator {
            opacity: 1;
            display: flex;
        }

        .category-thumbs .sm-btn-channel,
        .category-grid .category-thumbs .sm-btn-channel,
        .channel-thumbs .sm-btn-channel {
            display: none !important;
        }

        .category-thumbs .thumb,
        .category-thumbs .thumb a,
        .category-thumbs .thumb a:has(img.flipnote-hoverpreview-img) {
            position: relative !important;
            display: inline-block;
        }
        .category-thumbs .thumb a img.flipnote-hoverpreview-img { display: block; }

        .sm-blurred-genealogy .sm-btn-creator {
            display: none !important;
            opacity: 0 !important;
        }

        @media (max-width: 768px) {
            .sm-btn-creator,
            .sm-btn-channel {
                opacity: 1 !important;
                display: flex !important;
                width: 36px !important;
                height: 36px !important;
                font-size: 1.1rem !important;
                top: 10px !important;
                right: 10px !important;
            }
            .sm-blurred-genealogy .sm-btn-creator { display: none !important; }
        }
    `);

    if (hideUpsells) {
        GM_addStyle(`
            a[href*="discord.gg"],
            a[href*="discord.com/invite"],
            .advert:has(a[href*="discord"]),
            .advert:has(a[data-banner-name*="discord_slim"]) { display: none !important; }
        `);

        GM_addStyle(`
            a[href*="patreon.com"],
            .advert:has(a[href*="patreon"]),
            .advert:has(a[data-banner-name*="patreon_slim"]),
            .advert:has(a[data-banner-name*="ziggy_patreon"]) { display: none !important; }
        `);

        GM_addStyle(`
            a[href*="/shop"],
            .navbar-nav a[href*="/shop"],
            .navbar-nav li:has(a[href*="/shop"]),
            .advert:has(a[href*="/shop"]),
            .advert:has(a[data-banner-name*="merch"]) { display: none !important; }
        `);

        GM_addStyle(`
            a[href*="plush"],
            img[src*="plush"],
            img[alt*="plush" i],
            .advert:has(img[src*="plush"]),
            .advert:has(a[href*="plush"]),
            .advert:has([data-banner-name*="plush"]) { display: none !important; }
        `);

        GM_addStyle(`
            .advert:has(a[data-banner-name*="shorts_theatre"]),
            .advert:has(a[data-banner-name*="sudomemo_org_slim"]) { display: none !important; }
        `);
    }

    if (hideGoodUpsells) {
        GM_addStyle(`
            .advert a[data-banner-name*="flipnote_organizer_promo"],
            .advert a[data-banner-name*="sudomemo_wii_room"],
            .advert a[data-banner-name*="3ds_install_guide"],
            .advert a[data-banner-name*="staying_safe_online"],
            .advert a[data-banner-name*="organizer_slim"],
            .advert a[data-banner-name*="archive_slim"],
            .advert:has(a[data-banner-name*="flipnote_organizer_promo"]),
            .advert:has(a[data-banner-name*="sudomemo_wii_room"]),
            .advert:has(a[data-banner-name*="3ds_install_guide"]),
            .advert:has(a[data-banner-name*="staying_safe_online"]),
            .advert:has(a[data-banner-name*="organizer_slim"]),
            .advert:has(a[data-banner-name*="archive_slim"]),
            #left-sidebar .card.theme-advert-card {
                display: none !important;
            }
        `);
    }

    if (hideFlipstreams) {
        GM_addStyle(`
            .frontpage-flipstream-row,
            #recommended-flipstreams-mobile,
            #recommended-flipstreams,
            #front-explore { display: none !important; }
        `);
    }

    document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init();
})();
