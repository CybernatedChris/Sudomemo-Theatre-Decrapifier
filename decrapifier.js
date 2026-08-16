// ==UserScript==
// @name         Sudomemo Theatre Decrapifier
// @namespace    http://tampermonkey.net/
// @version      1
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

    const hideUpsells = GM_getValue('hideupsells', true);  // patreon, discord, sudomemo merchandise, uploading flipnotes as shorts
    const hideGoodUpsells = GM_getValue('hidegoodupsells', true);  // wii room, 3ds guide, staying safe, organizer, archive, buy a creator theme
    const hideFlipstreams = GM_getValue('hideflipstreams', true);  // hide flipstream

    if (location.pathname.startsWith('/chat') || location.pathname.startsWith('/watch/embed') || location.pathname.startsWith('/organizer')) return;

    const channelskey   = 'blockedchannels';
    const creatorskey   = 'blockedcreators';
    const whitelistkey  = 'whitelistkey';

    let blockedchannels    = [];
    let blockedcreators    = [];
    let whitelistedcreators = [];
    const channelmap = new Map();
    const creatormap = new Map();
    const creatorNameCache = new Map(); // Maps ID -> { name, avatar }
    let currentuser = null;
    let longpresstimer = null;
    let isRedirecting = false; // Flag to prevent multiple back/redirect triggers
    let slideObserver = null; // Intersection observer for scroll bypass

    // Dynamic scroll direction tracking variables
    let lastScrollTop = 0;
    let scrollDirection = 'down';
    let activeSlide = null; // Tracks the currently visible valid slide

    function loadSets() {
        try {
            blockedchannels     = JSON.parse(GM_getValue(channelskey, '[]'));
            blockedcreators     = JSON.parse(GM_getValue(creatorskey, '[]'));
            whitelistedcreators = JSON.parse(GM_getValue(whitelistkey, '[]'));
        } catch {}
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
        /* Keep layout dimension footprint so slides count/measurements don't break */
        .sm-blocked-slide {
            opacity: 0 !important;
            visibility: hidden !important;
            pointer-events: none !important;
        }
        /* Blur effect for blocked genealogy cards (keeps layout, softens content) */
        .sm-blurred-genealogy {
            filter: blur(6px) !important;
            opacity: 0.55 !important;
            pointer-events: none !important;
            user-select: none !important;
            transition: none !important;
            animation: none !important;
        }
        /* Fully block interaction + kill any transitions on blurred cards and children */
        .sm-blurred-genealogy,
        .sm-blurred-genealogy * {
            pointer-events: none !important;
            cursor: default !important;
            transition: none !important;
            animation: none !important;
        }
        /* Hide any residual block button on blurred genealogy cards */
        .sm-blurred-genealogy .sm-btn-creator {
            display: none !important;
        }
        /* Never put buttons on collapsed group cards */
        .flipnote-genealogy-card.collapsed-group .sm-btn-creator,
        .collapsed-group-content .sm-btn-creator,
        .collapsed-group-layout .sm-btn-creator {
            display: none !important;
        }
        .flipnote-genealogy-card {
            position: relative;
        }
        .related-preview a {
            position: relative;
            display: inline-block;
        }
        /* Force-hide blocked spinoff / related items */
        .related-flipnote-container.sm-hidden,
        .spinoff-flipnote-list .related-flipnote-container.sm-hidden {
            display: none !important;
            visibility: hidden !important;
            height: 0 !important;
            overflow: hidden !important;
            margin: 0 !important;
            padding: 0 !important;
        }
        /* Custom modal responsive container */
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
            .sm-dialog {
                padding: 1.25rem;
                width: 100%;
                max-width: 96%;
            }
        }
        /* Toggles layout styling */
        .form-check-input {
            cursor: pointer;
            background-color: #222;
            border-color: #555;
        }
        .form-check-input:checked {
            background-color: #28a745;
            border-color: #28a745;
        }
        .form-check-label {
            cursor: pointer;
            user-select: none;
            color: #ccc;
        }
        /* Circular Help Badge */
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
        .sm-help-badge:hover {
            background: #007bff;
            color: #fff;
        }
    `);

    function saveblockedchannels()    { GM_setValue(channelskey,   JSON.stringify(blockedchannels)); }
    function saveblockedcreators()    { GM_setValue(creatorskey,   JSON.stringify(blockedcreators)); }
    function savewhitelistedcreators() { GM_setValue(whitelistkey, JSON.stringify(whitelistedcreators)); }

    function getChannelId(el)   { return el.querySelector('a[href^="/channel/"]')?.href.match(/\/channel\/([a-zA-Z0-9]+)/)?.[1] ?? null; }
    function getChannelName(el) { return el.querySelector('a[href^="/channel/"]')?.textContent?.trim() || ''; }

    function getCreatorId(el)   {
        // 1. Check for standard profile anchor link
        let id = el.querySelector('a[href^="/user/"]')?.href.match(/\/user\/([A-F0-9]{16}@DSi)/i)?.[1]?.toUpperCase();
        if (id) return id;

        // 2. Fallback: Parse path directories for nodes lacking profile links (e.g. search samples)
        const img = el.querySelector('img[src*="/dynamic/thumbframe/"], img[src*="/dynamic/playback/"]');
        if (img) {
            const src = img.getAttribute('src') || '';
            const match = src.match(/\/dynamic\/(?:thumbframe|playback)\/([A-F0-9]{16})/i);
            if (match) {
                return match[1].toUpperCase() + '@DSi';
            }
        }
        return null;
    }

    function getCreatorName(el) {
        const links = el.querySelectorAll('a[href^="/user/"]');
        for (const link of links) {
            const name = link.textContent?.trim();
            // Skip anchor links that only wrap avatar image graphics
            if (name && !link.querySelector('img')) {
                if (name.toLowerCase().startsWith('by ')) {
                    return name.substring(3).trim();
                }
                return name;
            }
        }
        let fallbackName = el.querySelector('a[href^="/user/"]')?.textContent?.trim() || '';
        if (fallbackName.toLowerCase().startsWith('by ')) {
            fallbackName = fallbackName.substring(3).trim();
        }
        return fallbackName;
    }

    // Redirection gatekeeper to ensure back or replace is called only once
    function safeRedirect() {
        if (isRedirecting) return;
        isRedirecting = true;
        if (history.length > 1) {
            history.back();
        } else {
            location.replace('https://www.sudomemo.net/');
        }
    }

    // Case-insensitive check utilities
    function isWhitelisted(id) {
        if (!id) return false;
        const upperId = id.toUpperCase();
        return whitelistedcreators.some(c => {
            const cid = c.id || '';
            return cid.toUpperCase() === upperId;
        }) || upperId === currentuser?.toUpperCase();
    }
    function isBlockedCreator(id) {
        if (!id) return false;
        const upperId = id.toUpperCase();
        return blockedcreators.some(c => {
            const cid = c.id || '';
            return cid.toUpperCase() === upperId;
        }) && !isWhitelisted(upperId);
    }

    // Matches extracted 6-hex-digit sequences against blocked creator suffixes
    function isLast6Blocked(last6) {
        if (!last6) return false;
        const upper6 = last6.toUpperCase();
        return blockedcreators.some(c => {
            const hexId = c.id.split('@')[0];
            return hexId.toUpperCase().endsWith(upper6) && !isWhitelisted(c.id);
        });
    }

    // Scrapes the visible DOM to populate the name & avatar cache synchronously
    function harvestCreatorNames() {
        document.querySelectorAll('a[href^="/user/"], a[href*="/user/"]').forEach(a => {
            const href = a.getAttribute('href') || '';
            const match = href.match(/\/user\/([A-F0-9]{16}@DSi)/i);
            if (match) {
                const id = match[1].toUpperCase();
                let name = a.textContent?.trim();
                if (name && name.toLowerCase().startsWith('by ')) {
                    name = name.substring(3).trim();
                }
                if (name && name !== id && !name.includes('/') && !name.includes('@')) {
                    let avatarUrl = '';
                    const img = a.querySelector('img') || a.parentElement?.querySelector('img[src*="/dynamic/thumbframe/"]');
                    if (img) {
                        const src = img.getAttribute('src') || '';
                        if (src.includes('/dynamic/thumbframe/')) {
                            avatarUrl = src;
                        }
                    }
                    const existing = creatorNameCache.get(id);
                    creatorNameCache.set(id, {
                        name: name,
                        avatar: avatarUrl || existing?.avatar || ''
                    });
                }
            }
        });
    }

    // Resolves names and avatar images dynamically using caching and DOM parsing
    async function resolveCreatorName(id, callback) {
        const upperId = id.toUpperCase();

        // 1. Check local cache memory
        if (creatorNameCache.has(upperId)) {
            const cached = creatorNameCache.get(upperId);
            callback(cached.name, cached.avatar);
            return;
        }

        // 2. Check loaded lists for already known properties
        const blocked = blockedcreators.find(c => c.id.toUpperCase() === upperId);
        if (blocked && blocked.name && blocked.name !== 'Unknown') {
            creatorNameCache.set(upperId, { name: blocked.name, avatar: blocked.avatar || '' });
            callback(blocked.name, blocked.avatar || '');
            if (blocked.avatar) return;
        }
        const white = whitelistedcreators.find(c => c.id.toUpperCase() === upperId);
        if (white && white.name && white.name !== 'Unknown') {
            creatorNameCache.set(upperId, { name: white.name, avatar: white.avatar || '' });
            callback(white.name, white.avatar || '');
            if (white.avatar) return;
        }

        // 3. Fallback: Parse profile document dynamically (with lowercase @DSi to prevent routing errors)
        try {
            const fetchId = upperId.replace('@DSI', '@DSi');
            const res = await fetch(`/user/${fetchId}`);
            if (!res.ok) return;
            const html = await res.text();
            const doc = new DOMParser().parseFromString(html, 'text/html');

            // Extract display name from document title
            const title = doc.querySelector('title')?.textContent || '';
            let name = title
                .replace(/'s Profile.*/i, '')
                .replace(/ - Sudomemo.*/i, '')
                .replace(/Theatre/i, '')
                .trim();

            if (!name || name.toLowerCase().includes('theatre') || name.toLowerCase().includes('sudomemo')) {
                name = doc.querySelector('.profile-right .name a, .profile-right .name, h1, .name')?.textContent?.trim();
            }

            // Target profile picture elements (including fallback static icons)
            const hexId = upperId.split('@')[0];
            const avatarImg = doc.querySelector(`img[src*="/dynamic/thumbframe/${hexId}/"]`) ||
                              doc.querySelector('.details-profile-container img, .profile-avatar img, img.profile-avatar, .avatar img, img.avatar');

            let avatarUrl = '';
            if (avatarImg) {
                let src = avatarImg.getAttribute('src') || '';
                if (src) {
                    if (src.startsWith('/')) {
                        src = 'https://www.sudomemo.net' + src;
                    }
                    try {
                        const urlObj = new URL(src);
                        if (src.includes('/dynamic/thumbframe/')) {
                            // Rescale query properties to render a small square preview icon
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
                creatorNameCache.set(upperId, { name, avatar: avatarUrl });
                callback(name, avatarUrl);

                // Commit parameters back into persistent storage
                let updated = false;
                blockedcreators.forEach(c => {
                    if (c.id.toUpperCase() === upperId) {
                        if (c.name === 'Unknown') { c.name = name; updated = true; }
                        if (!c.avatar && avatarUrl) { c.avatar = avatarUrl; updated = true; }
                    }
                });
                whitelistedcreators.forEach(c => {
                    if (c.id.toUpperCase() === upperId) {
                        if (c.name === 'Unknown') { c.name = name; updated = true; }
                        if (!c.avatar && avatarUrl) { c.avatar = avatarUrl; updated = true; }
                    }
                });
                if (updated) {
                    saveblockedcreators();
                    savewhitelistedcreators();
                }
            }
        } catch (e) {
            console.error('[Decrapifier] Error fetching creator metadata:', e);
        }
    }

    function hide(el) { el.classList.add('sm-hidden'); el.style.display = 'none'; }
    function show(el) { el.classList.remove('sm-hidden'); el.style.display = ''; }

    function processItem(el) {
        if (el.classList.contains('sm-processed')) return;
        el.classList.add('sm-processed');

        const chId = getChannelId(el);
        const crId = getCreatorId(el);

        if (chId) {
            if (!channelmap.has(chId)) channelmap.set(chId, new Set());
            channelmap.get(chId).add(el);
            if (blockedchannels.some(c => c.id.toUpperCase() === chId.toUpperCase())) hide(el);
        }
        if (crId) {
            if (!creatormap.has(crId)) {
                creatormap.set(crId, new Set());
            }
            creatormap.get(crId).add(el);
            if (isBlockedCreator(crId)) hide(el);
        }
    }

    function processFlipstreams() {
        if (hideFlipstreams) return; // Save processing cycles if globally hidden
        document.querySelectorAll('img.flipstream-thumbnail-card__image.flipnote-hoverpreview-img').forEach(img => {
            const src = img.getAttribute('src') || img.getAttribute('data-hover-preview-src') || '';
            const match = src.match(/\/dynamic\/(?:thumbframe|playback)\/([A-F0-9]{16})/i);

            if (match) {
                const hexId = match[1].toUpperCase();
                const creatorId = hexId + '@DSI';
                const channelId = hexId;

                const li = img.closest('li.flipstream-list-item') || img.parentElement?.parentElement?.parentElement;

                if (li) {
                    if (!creatormap.has(creatorId)) {
                        creatormap.set(creatorId, new Set());
                    }
                    creatormap.get(creatorId).add(li);

                    const isBlocked = isBlockedCreator(creatorId) || blockedchannels.some(c => c.id.toUpperCase() === channelId);

                    if (isBlocked) {
                        hide(li);
                    } else {
                        show(li);
                    }

                    if (!li.querySelector('.sm-btn-creator') && !li.classList.contains('sm-btn-added')) {
                        const isWhite = isWhitelisted(creatorId);

                        // Only generate buttons for users other than yourself or manually whitelisted creators
                        if (!isWhite && creatorId !== currentuser) {
                            const cached = creatorNameCache.get(creatorId);
                            const initialName = cached?.name || 'Unknown';
                            addBlockBtn(li, 'creator', creatorId, initialName, {blocked: isBlocked, whitelisted: false});

                            resolveCreatorName(creatorId, (resolvedName) => {
                                const btn = li.querySelector('.sm-btn-creator');
                                if (btn) {
                                    btn.title = `Hide ${resolvedName}`;
                                }
                            });
                        }
                        li.classList.add('sm-btn-added');
                    }
                }
            }
        });
    }

    // Inspects the Spotlight player component and hides the panel if the embedding URL belongs to a blocked ID
    function processSpotlight() {
        const header = document.querySelector('.panel-header-spotlight');
        if (header) {
            const parentCard = header.closest('.card') || header.closest('.panel') || header.parentElement;
            if (parentCard) {
                const iframe = parentCard.querySelector('iframe[src*="/watch/embed/"]');
                if (iframe) {
                    const src = iframe.getAttribute('src') || '';
                    const match = src.match(/\/watch\/embed\/([A-F0-9]{6})_/i);
                    if (match) {
                        const last6 = match[1].toUpperCase();
                        if (isLast6Blocked(last6)) {
                            hide(parentCard);
                        } else {
                            show(parentCard);
                        }
                    }
                }
            }
        }
    }

    // Identifies standalone embed frames and evaluates console prefixes to block/hide elements
    function processEmbeds() {
        document.querySelectorAll('.flipnote-embed').forEach(embed => {
            const iframe = embed.querySelector('iframe[src*="/watch/embed/"]');
            if (iframe) {
                const src = iframe.getAttribute('src') || '';
                const match = src.match(/\/watch\/embed\/([A-F0-9]{6})_/i);
                if (match) {
                    const last6 = match[1].toUpperCase();
                    if (isLast6Blocked(last6)) {
                        hide(embed);
                    } else {
                        show(embed);
                    }
                }
            }
        });
    }

    // Handles related / spin-off flipnotes in the left sidebar
    function processRelatedFlipnotes() {
        // Broad selector to catch all spinoff / related items
        const containers = document.querySelectorAll(
            '.related-flipnote-container, ' +
            '.spinoff-flipnote-list .related-flipnote-container, ' +
            '.spinoff-flipnote-list > div, ' +
            '.theme-panel-body.spinoff-flipnote-list .related-flipnote-container'
        );

        containers.forEach(container => {
            // Skip if this isn't actually a related item (avoid false positives)
            if (!container.classList.contains('related-flipnote-container') &&
                !container.querySelector('.related-preview, .related-title, .related-details')) {
                return;
            }

            let creatorId = null;
            let creatorName = 'Unknown';
            let sixDigit = null;

            // 1. Author / title link
            const titleLink = container.querySelector(
                'p.related-title a.theme-link[href*="/user/"], ' +
                '.related-details a.theme-link[href*="/user/"], ' +
                'a.theme-link[href*="/user/"], ' +
                'a[href*="/user/"]'
            );
            if (titleLink) {
                const match = (titleLink.getAttribute('href') || '').match(/\/user\/([A-F0-9]{16}@DSi)/i);
                if (match) {
                    creatorId = match[1].toUpperCase();
                    creatorName = titleLink.textContent?.trim() || 'Unknown';
                    if (creatorName.toLowerCase().startsWith('by ')) creatorName = creatorName.substring(3).trim();
                }
            }

            // 2. Thumbnail src (thumbframe / playback often embeds the 16-char hex)
            if (!creatorId) {
                const img = container.querySelector(
                    'img[src*="/dynamic/thumbframe/"], img[src*="/dynamic/playback/"], ' +
                    '.related-preview img, img'
                );
                if (img) {
                    const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
                    const match = src.match(/\/dynamic\/(?:thumbframe|playback)\/([A-F0-9]{16})/i);
                    if (match) {
                        creatorId = match[1].toUpperCase() + '@DSi';
                    } else {
                        // Sometimes only 6 hex chars appear
                        const sixMatch = src.match(/\/([A-F0-9]{6})(?:[\/_]|$)/i);
                        if (sixMatch) sixDigit = sixMatch[1].toUpperCase();
                    }
                }
            }

            // 3. Any watch / user link
            if (!creatorId) {
                const anyLink = container.querySelector('a[href*="/watch/"], a[href*="/user/"]');
                if (anyLink) {
                    const href = anyLink.getAttribute('href') || '';
                    let match = href.match(/\/user\/([A-F0-9]{16}@DSi)/i);
                    if (match) {
                        creatorId = match[1].toUpperCase();
                    } else {
                        match = href.match(/\/watch\/([A-F0-9]{6})/i) || href.match(/([A-F0-9]{6})_/);
                        if (match) sixDigit = match[1].toUpperCase();
                    }
                }
            }

            // 4. Resolve 6-digit against blocked list (first or last 6 of the 16-char hex)
            if (!creatorId && sixDigit) {
                if (isLast6Blocked(sixDigit)) {
                    const blocked = blockedcreators.find(c => {
                        const hex = (c.id || '').split('@')[0].toUpperCase();
                        return (hex.startsWith(sixDigit) || hex.endsWith(sixDigit)) && !isWhitelisted(c.id);
                    });
                    if (blocked) {
                        creatorId = blocked.id.toUpperCase();
                        creatorName = blocked.name || 'Unknown';
                    }
                } else {
                    // Also check startsWith for first-6 matching
                    const blocked = blockedcreators.find(c => {
                        const hex = (c.id || '').split('@')[0].toUpperCase();
                        return hex.startsWith(sixDigit) && !isWhitelisted(c.id);
                    });
                    if (blocked) {
                        creatorId = blocked.id.toUpperCase();
                        creatorName = blocked.name || 'Unknown';
                    }
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
                container.classList.add('sm-hidden');
                container.style.display = 'none';
            } else {
                show(container);
                container.classList.remove('sm-hidden');
            }

            // Place button on: .related-preview a  (the thumbnail link)
            if (!container.querySelector('.sm-btn-creator') && !isWhite && creatorId !== currentuser && !isBlocked) {
                addBlockBtn(container, 'creator', creatorId, creatorName, { blocked: isBlocked, whitelisted: false });
                const btn = container.querySelector('.sm-btn-creator');
                const thumbTarget = container.querySelector('.related-preview a') ||
                                    container.querySelector('.related-preview') ||
                                    container.querySelector('img')?.parentElement;
                if (btn && thumbTarget) {
                    thumbTarget.style.position = 'relative';
                    if (btn.parentElement !== thumbTarget) {
                        thumbTarget.appendChild(btn);
                    }
                }
            }
        });
    }

    // Category grid: process EACH .category-thumbs .thumb individually (throttled)
    let categoryThumbsLastRun = 0;
    const CATEGORY_THUMBS_THROTTLE_MS = 1200;

    function processCategoryThumbs(force = false) {
        // Only run on pages that actually have category thumbs
        if (!document.querySelector('.category-thumbs .thumb')) return;

        const now = Date.now();
        if (!force && now - categoryThumbsLastRun < CATEGORY_THUMBS_THROTTLE_MS) return;
        categoryThumbsLastRun = now;

        // Remove stray channel-hide buttons inside category thumb strips (once per pass)
        document.querySelectorAll('.category-thumbs .sm-btn-channel, .category-grid .sm-btn-channel')
            .forEach(btn => btn.remove());

        document.querySelectorAll('.category-thumbs .thumb').forEach(thumb => {
            // Reuse cached creator id when possible
            let creatorId = thumb.dataset.smCreatorId || null;
            let creatorName = thumb.dataset.smCreatorName || 'Unknown';

            if (creatorId === '') return; // previously scanned, no id found

            if (!creatorId) {
                const img = thumb.querySelector('img.flipnote-hoverpreview-img, img[src*="/dynamic/thumbframe/"], img[src*="/dynamic/playback/"]');
                if (img) {
                    const src = img.getAttribute('src') || img.getAttribute('data-src') || img.getAttribute('data-hover-preview-src') || '';
                    const match = src.match(/\/dynamic\/(?:thumbframe|playback)\/([A-F0-9]{16})/i);
                    if (match) creatorId = match[1].toUpperCase() + '@DSi';
                }

                if (!creatorId) {
                    const link = thumb.querySelector('a[href*="/user/"]');
                    if (link) {
                        const match = (link.getAttribute('href') || '').match(/\/user\/([A-F0-9]{16}@DSi)/i);
                        if (match) creatorId = match[1].toUpperCase();
                    }
                }

                if (!creatorId) {
                    thumb.dataset.smCreatorId = ''; // mark scanned
                    return;
                }

                thumb.dataset.smCreatorId = creatorId;
                thumb.dataset.smCreatorName = creatorName;
            }

            const isBlocked = isBlockedCreator(creatorId);
            const isWhite = isWhitelisted(creatorId);
            const wasHidden = thumb.classList.contains('sm-hidden');

            // Only touch display when state changes
            if (isBlocked && !wasHidden) {
                thumb.style.display = 'none';
                thumb.classList.add('sm-hidden');
            } else if (!isBlocked && wasHidden) {
                thumb.style.display = '';
                thumb.classList.remove('sm-hidden');
            }

            if (isBlocked || creatorId === currentuser) {
                const existing = thumb.querySelector('.sm-btn-creator');
                if (existing) existing.remove();
                return;
            }

            let btn = thumb.querySelector('.sm-btn-creator');
            if (!btn) {
                btn = document.createElement('button');
                btn.className = 'sm-btn-creator btn btn-sm btn-outline-danger';
                btn.type = 'button';
                btn.title = 'Hide creator (click) · Whitelist (right-click / long-press)';
                btn.innerHTML = '<i class="fas fa-ban"></i>';
                btn.dataset.smState = 'normal';

                btn.onclick = e => {
                    e.stopPropagation();
                    e.preventDefault();
                    const id = thumb.dataset.smCreatorId;
                    const name = thumb.dataset.smCreatorName || 'Unknown';
                    if (!id) return;
                    const upperId = id.toUpperCase();
                    if (whitelistedcreators.some(c => c.id.toUpperCase() === upperId)) {
                        unwhitelistCreator(id);
                    } else if (blockedcreators.some(c => c.id.toUpperCase() === upperId)) {
                        unblockCreator(id);
                    } else {
                        blockCreator(id, name);
                    }
                    processCategoryThumbs(true);
                };

                const toggleWhitelist = () => {
                    const id = thumb.dataset.smCreatorId;
                    const name = thumb.dataset.smCreatorName || 'Unknown';
                    if (!id) return;
                    const upperId = id.toUpperCase();
                    if (whitelistedcreators.some(c => c.id.toUpperCase() === upperId)) unwhitelistCreator(id);
                    else whitelistCreator(id, name);
                    processCategoryThumbs(true);
                };
                btn.addEventListener('mousedown', e => { if (e.button === 2) { e.preventDefault(); toggleWhitelist(); } });
                btn.addEventListener('touchstart', () => { longpresstimer = setTimeout(toggleWhitelist, 600); });
                btn.addEventListener('touchend', () => clearTimeout(longpresstimer));
                btn.addEventListener('touchcancel', () => clearTimeout(longpresstimer));
                btn.addEventListener('contextmenu', e => e.preventDefault());

                const anchor = thumb.querySelector('a') || thumb;
                anchor.style.position = 'relative';
                if (anchor.tagName === 'A') anchor.style.display = 'inline-block';
                anchor.appendChild(btn);
            }

            // Update icon only when whitelist state changes
            const wantState = isWhite ? 'white' : 'normal';
            if (btn.dataset.smState !== wantState) {
                btn.dataset.smState = wantState;
                if (isWhite) {
                    btn.className = 'sm-btn-creator btn btn-sm btn-success';
                    btn.title = 'Remove whitelist (click)';
                    btn.innerHTML = '<i class="fas fa-star"></i>';
                } else {
                    btn.className = 'sm-btn-creator btn btn-sm btn-outline-danger';
                    btn.title = 'Hide creator (click) · Whitelist (right-click / long-press)';
                    btn.innerHTML = '<i class="fas fa-ban"></i>';
                }
            }
        });
    }

    // Genealogy tree: blur blocked creators instead of hiding, add block/whitelist buttons
    // Heavily optimized, only runs when genealogy is present and only processes new/changed cards
    let genealogyLastRun = 0;
    const GENEALOGY_THROTTLE_MS = 800;

    function processGenealogy(force = false) {
        const now = Date.now();
        if (!force && now - genealogyLastRun < GENEALOGY_THROTTLE_MS) return;

        const root = document.getElementById('genealogy-nodes') || document.querySelector('.flipnote-genealogy-tree');
        if (!root) return; // nothing to do on pages without genealogy

        genealogyLastRun = now;

        const cards = root.querySelectorAll('.flipnote-genealogy-card');
        if (!cards.length) return;

        cards.forEach(card => {
            // Skip cards we already fully processed unless force-refreshing block state
            let creatorId = card.dataset.smCreatorId || null;
            let creatorName = card.dataset.smCreatorName || 'Unknown';

            if (!creatorId) {
                // One-time extraction
                const nodeId = card.getAttribute('data-node-id') || '';

                const userLink = card.querySelector('a[href^="/user/"]');
                if (userLink) {
                    const match = userLink.href.match(/\/user\/([A-F0-9]{16}@DSi)/i);
                    if (match) {
                        creatorId = match[1].toUpperCase();
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
                        if (match) creatorId = match[1].toUpperCase() + '@DSi';
                    }
                }

                if (!creatorId) {
                    const watchLink = card.querySelector('a[href*="/watch/"]');
                    const candidate = (watchLink?.getAttribute('href') || '') + ' ' + nodeId;
                    let match = candidate.match(/\/user\/([A-F0-9]{16}@DSi)/i);
                    if (match) {
                        creatorId = match[1].toUpperCase();
                    } else {
                        match = candidate.match(/([A-F0-9]{6})/);
                        if (match) {
                            const six = match[1].toUpperCase();
                            const blocked = blockedcreators.find(c => {
                                const hex = (c.id || '').split('@')[0].toUpperCase();
                                return (hex.startsWith(six) || hex.endsWith(six)) && !isWhitelisted(c.id);
                            });
                            if (blocked) {
                                creatorId = blocked.id.toUpperCase();
                                creatorName = blocked.name || 'Unknown';
                            }
                        }
                    }
                }

                if (!creatorId) {
                    card.dataset.smCreatorId = ''; // mark as checked so we don't retry forever
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

            // Instant blur
            if (isBlocked && !wasBlurred) {
                card.style.transition = 'none';
                card.style.animation = 'none';
                card.classList.add('sm-blurred-genealogy');
                card.style.filter = 'blur(6px)';
                card.style.opacity = '0.55';
                card.style.pointerEvents = 'none';
                // Neutralize all links so they cannot navigate
                card.querySelectorAll('a').forEach(a => {
                    a.dataset.smOrigHref = a.getAttribute('href') || '';
                    a.removeAttribute('href');
                    a.style.pointerEvents = 'none';
                    a.style.cursor = 'default';
                    a.style.transition = 'none';
                });
            } else if (!isBlocked && wasBlurred) {
                card.classList.remove('sm-blurred-genealogy');
                card.style.filter = '';
                card.style.opacity = '';
                card.style.pointerEvents = '';
                card.style.transition = '';
                card.style.animation = '';
                // Restore links
                card.querySelectorAll('a[data-sm-orig-href]').forEach(a => {
                    a.setAttribute('href', a.dataset.smOrigHref);
                    delete a.dataset.smOrigHref;
                    a.style.pointerEvents = '';
                    a.style.cursor = '';
                    a.style.transition = '';
                });
            }

            // Skip block buttons on collapsed group cards and already-blocked cards
            const isCollapsedGroup = card.classList.contains('collapsed-group') ||
                                     card.classList.contains('collapsed-group-layout') ||
                                     !!card.querySelector('.collapsed-group-content');

            if (isBlocked || isCollapsedGroup) {
                const existingBtn = card.querySelector('.sm-btn-creator');
                if (existingBtn) existingBtn.remove();
            } else if (!card.querySelector('.sm-btn-creator') && !isWhite && creatorId !== currentuser) {
                // Only add button for non-blocked, non-collapsed, non-whitelisted creators
                addBlockBtn(card, 'creator', creatorId, creatorName, { blocked: false, whitelisted: false });
                const btn = card.querySelector('.sm-btn-creator');
                if (btn) {
                    btn.style.zIndex = '20';
                }
            }
        });

        // Remove blocked creators from collapsed-group thumbnail strips
        root.querySelectorAll(
            '.flipnote-genealogy-card.collapsed-group .collapsed-group-thumbnails img.collapsed-group-thumb, ' +
            '.collapsed-group-layout .collapsed-group-content img.collapsed-group-thumb, ' +
            '.collapsed-group-thumbnails img.collapsed-group-thumb'
        ).forEach(img => {
            const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
            let blocked = false;

            // Match full 16-char hex from thumbframe/playback path
            const fullMatch = src.match(/\/dynamic\/(?:thumbframe|playback)\/([A-F0-9]{16})/i);
            if (fullMatch) {
                const id = fullMatch[1].toUpperCase() + '@DSi';
                if (isBlockedCreator(id)) blocked = true;
            }

            // Fallback: 6-digit segment (first or last 6 of blocked creator hex)
            if (!blocked) {
                const sixMatch = src.match(/([A-F0-9]{6})/i);
                if (sixMatch) {
                    const six = sixMatch[1].toUpperCase();
                    if (isLast6Blocked(six) || blockedcreators.some(c => {
                        const hex = (c.id || '').split('@')[0].toUpperCase();
                        return (hex.startsWith(six) || hex.endsWith(six)) && !isWhitelisted(c.id);
                    })) {
                        blocked = true;
                    }
                }
            }

            // Also check parent link if present
            if (!blocked) {
                const link = img.closest('a[href*="/user/"], a[href*="/watch/"]');
                if (link) {
                    const href = link.getAttribute('href') || '';
                    const userMatch = href.match(/\/user\/([A-F0-9]{16}@DSi)/i);
                    if (userMatch && isBlockedCreator(userMatch[1].toUpperCase())) {
                        blocked = true;
                    } else {
                        const watchMatch = href.match(/\/watch\/([A-F0-9]{6})/i) || href.match(/([A-F0-9]{6})_/);
                        if (watchMatch) {
                            const six = watchMatch[1].toUpperCase();
                            if (isLast6Blocked(six) || blockedcreators.some(c => {
                                const hex = (c.id || '').split('@')[0].toUpperCase();
                                return (hex.startsWith(six) || hex.endsWith(six)) && !isWhitelisted(c.id);
                            })) {
                                blocked = true;
                            }
                        }
                    }
                }
            }

            if (blocked) {
                img.style.display = 'none';
                img.classList.add('sm-hidden');
                // Hide wrapper if it's just a single-thumb link/container
                const wrap = img.closest('a, .collapsed-group-thumb-wrap, li');
                if (wrap && wrap !== img.parentElement?.closest('.collapsed-group-thumbnails')) {
                    wrap.style.display = 'none';
                    wrap.classList.add('sm-hidden');
                }
            } else {
                img.style.display = '';
                img.classList.remove('sm-hidden');
            }
        });
    }

    // Programmatically skips past a blocked slide element in the active direction
    function skipBlockedSlide(slide, forceDirection = null) {
        if (!slide) return;
        const creatorId = slide.dataset.creatorId;
        if (!creatorId) return;

        const hexId = creatorId.split('@')[0];
        const isBlocked = isBlockedCreator(creatorId) || blockedchannels.some(c => c.id.toUpperCase() === hexId);

        if (isBlocked) {
            const dir = forceDirection || scrollDirection;

            if (dir === 'down') {
                // Find and snap to the next unblocked slide below
                let nextSlide = slide.nextElementSibling;
                while (nextSlide) {
                    if (nextSlide.matches('.flipstream-slide')) {
                        const nextCreatorLink = nextSlide.querySelector('a.flipstream-creator-link[href^="/user/"]');
                        const nextCreatorId = nextCreatorLink?.href.match(/\/user\/([A-F0-9]{16}@DSi)/i)?.[1]?.toUpperCase();
                        if (nextCreatorId) {
                            const nextHexId = nextCreatorId.split('@')[0];
                            const nextBlocked = isBlockedCreator(nextCreatorId) || blockedchannels.some(c => c.id.toUpperCase() === nextHexId);
                            if (!nextBlocked) {
                                break;
                            }
                        }
                    }
                    nextSlide = nextSlide.nextElementSibling;
                }

                if (nextSlide) {
                    nextSlide.scrollIntoView({ behavior: 'auto', block: 'start' });
                }
            } else {
                // Find and snap to the first unblocked slide above
                let prevSlide = slide.previousElementSibling;
                while (prevSlide) {
                    if (prevSlide.matches('.flipstream-slide')) {
                        const prevCreatorLink = prevSlide.querySelector('a.flipstream-creator-link[href^="/user/"]');
                        const prevCreatorId = prevCreatorLink?.href.match(/\/user\/([A-F0-9]{16}@DSi)/i)?.[1]?.toUpperCase();
                        if (prevCreatorId) {
                            const prevHexId = prevCreatorId.split('@')[0];
                            const prevBlocked = isBlockedCreator(prevCreatorId) || blockedchannels.some(c => c.id.toUpperCase() === prevHexId);
                            if (!prevBlocked) {
                                break;
                            }
                        }
                    }
                    prevSlide = prevSlide.previousElementSibling;
                }
                if (prevSlide) {
                    prevSlide.scrollIntoView({ behavior: 'auto', block: 'start' });
                }
            }
        }
    }

    // Instantiates a scrolling observer to dynamically bypass blocked slides
    function initSlideObserver() {
        if (slideObserver) return;

        // Track the general direction of native page scrolls
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
                        const hexId = creatorId.split('@')[0];
                        const isBlocked = isBlockedCreator(creatorId) || blockedchannels.some(c => c.id.toUpperCase() === hexId);

                        if (!isBlocked) {
                            activeSlide = slide;
                            updateTopbarButton();
                        } else {
                            skipBlockedSlide(slide);
                        }
                    }
                }
            });
        }, {
            threshold: 0.15 // Fire early when even 15% of the slide enters viewport coordinates
        });
    }

    // Evaluates dynamic button icon/color states on the topbar action element
    function updateTopbarButton() {
        const btn = document.getElementById('sm-topbar-btn');
        if (!btn) return;

        // Fallback: If the observer has not yet registered an event, find the first active, non-blocked slide
        if (!activeSlide) {
            activeSlide = document.querySelector('article.flipstream-slide:not(.sm-blocked-slide)');
        }

        if (!activeSlide) {
            btn.style.display = 'none';
            return;
        }
        btn.style.display = '';

        const creatorId = activeSlide.dataset.creatorId;
        if (!creatorId) {
            btn.style.display = 'none';
            return;
        }

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

    // Appends the interactive icon action inside the navigation bar
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
            if (!creatorId) return;

            const cached = creatorNameCache.get(creatorId);
            const name = cached?.name || 'Unknown';

            const isWhite = whitelistedcreators.some(c => c.id.toUpperCase() === creatorId);
            const isBlocked = blockedcreators.some(c => c.id.toUpperCase() === creatorId);

            if (isWhite) {
                unwhitelistCreator(creatorId);
            } else if (isBlocked) {
                unblockCreator(creatorId);
            } else {
                blockCreator(creatorId, name);
            }
            processFlipstreamSlides(); // Sync skips and mutations instantly on click
            skipBlockedSlide(activeSlide, 'down'); // Instantly force-skip the slide downward on blocking
            updateTopbarButton();
        };

        // Long press / right click logic for whitelisting
        const toggleWhitelist = () => {
            if (!activeSlide) return;
            const creatorId = activeSlide.dataset.creatorId;
            if (!creatorId) return;

            const cached = creatorNameCache.get(creatorId);
            const name = cached?.name || 'Unknown';

            const isWhite = whitelistedcreators.some(c => c.id.toUpperCase() === creatorId);
            if (isWhite) unwhitelistCreator(creatorId);
            else whitelistCreator(creatorId, name);
            processFlipstreamSlides(); // Sync skips and mutations instantly on click
            updateTopbarButton();
        };

        btn.addEventListener('mousedown', e => { if (e.button === 2) { e.preventDefault(); toggleWhitelist(); } });
        btn.addEventListener('touchstart', () => { longpresstimer = setTimeout(toggleWhitelist, 600); });
        btn.addEventListener('touchend', () => clearTimeout(longpresstimer));
        btn.addEventListener('touchcancel', () => clearTimeout(longpresstimer));
        btn.addEventListener('contextmenu', e => e.preventDefault());

        container.appendChild(btn);
        updateTopbarButton();
    }

    // Processes standard slide posts on the /flipstream viewing page
    function processFlipstreamSlides() {
        if (hideFlipstreams) return; // Exit early if we are hiding/blocking flipstreams anyway
        initSlideObserver();
        injectTopbarButton();

        document.querySelectorAll('article.flipstream-slide').forEach(slide => {
            const creatorLink = slide.querySelector('a.flipstream-creator-link[href^="/user/"]');
            if (creatorLink) {
                const creatorId = creatorLink.href.match(/\/user\/([A-F0-9]{16}@DSi)/i)?.[1]?.toUpperCase();
                if (creatorId) {
                    slide.dataset.creatorId = creatorId;

                    const name = creatorLink.textContent?.trim() || '';
                    const avatarImg = slide.querySelector('img.flipstream-avatar');
                    let avatar = avatarImg?.getAttribute('src') || '';
                    if (avatar && avatar.startsWith('/')) {
                        avatar = 'https://www.sudomemo.net' + avatar;
                    }

                    if (name && !creatorNameCache.has(creatorId)) {
                        creatorNameCache.set(creatorId, { name, avatar });
                    }

                    const hexId = creatorId.split('@')[0];
                    const isBlocked = isBlockedCreator(creatorId) || blockedchannels.some(c => c.id.toUpperCase() === hexId);

                    // Force the slideObserver to track every single slide so activeSlide can update accurately
                    slideObserver.observe(slide);

                    if (isBlocked) {
                        slide.classList.add('sm-blocked-slide');

                        // Ensure background players inside invisible blocks remain muted/paused
                        const video = slide.querySelector('video');
                        if (video) {
                            try {
                                video.pause();
                                video.muted = true;
                            } catch (e) {}
                        }
                    } else {
                        slide.classList.remove('sm-blocked-slide');
                    }
                }
            }
        });
    }

    function processAll() {
        harvestCreatorNames();
        // Target outer search-result cards to avoid broken panel outline structures on the search pages
        document.querySelectorAll('.flipnote-item, .flipnote-list-item, .channel-card, .cat-box, .playlist-flipnote, .trending-user, .recommended-item, li:has(.rec-thumbnail), .watch-next-item, .search-samples__item, .search-result').forEach(processItem);
        processSpotlight(); // Run unconditionally so spotlight is evaluated even when flipstreams are hidden
        processEmbeds();
        processRelatedFlipnotes();
        processCategoryThumbs();
        processGenealogy();
        if (!hideFlipstreams) {
            processFlipstreams();
            processFlipstreamSlides();
        }
    }

    function blockChannel(id, name = null) {
        if (!id || blockedchannels.some(c => c.id.toUpperCase() === id.toUpperCase())) return;
        blockedchannels.push({id, name});
        saveblockedchannels();
        channelmap.get(id)?.forEach(hide);
    }

    // Unblocks targeted IDs
    function unblockChannel(id) {
        blockedchannels = blockedchannels.filter(c => c.id.toUpperCase() !== id.toUpperCase());
        saveblockedchannels();
        channelmap.get(id)?.forEach(show);
    }

    function blockCreator(id, name = null) {
        const upperId = id.toUpperCase();
        if (!id || isWhitelisted(upperId) || blockedcreators.some(c => c.id.toUpperCase() === upperId)) return;
        const cached = creatorNameCache.get(upperId);
        const avatar = cached?.avatar || '';
        blockedcreators.push({id, name: name || 'Unknown', avatar});
        saveblockedcreators();
        creatormap.get(id)?.forEach(hide);
        processGenealogy(true);
        processRelatedFlipnotes();
        processCategoryThumbs(true);
    }

    // Unblocks targeted IDs
    function unblockCreator(id) {
        blockedcreators = blockedcreators.filter(c => c.id.toUpperCase() !== id.toUpperCase());
        saveblockedcreators();
        creatormap.get(id)?.forEach(show);
        processGenealogy(true);
        processRelatedFlipnotes();
        processCategoryThumbs(true);
    }

    // Persistently whitelists specific IDs
    function whitelistCreator(id, name = null) {
        const upperId = id.toUpperCase();
        if (!id || whitelistedcreators.some(c => c.id.toUpperCase() === upperId)) return;
        const cached = creatorNameCache.get(upperId);
        const avatar = cached?.avatar || '';
        whitelistedcreators.push({id, name: name || 'Unknown', avatar});
        savewhitelistedcreators();
        unblockCreator(id);
        creatormap.get(id)?.forEach(show);
        processGenealogy(true);
        processRelatedFlipnotes();
        processCategoryThumbs(true);
    }

    function unwhitelistCreator(id) {
        whitelistedcreators = whitelistedcreators.filter(c => c.id.toUpperCase() !== id.toUpperCase());
        savewhitelistedcreators();
        processGenealogy(true);
        processRelatedFlipnotes();
        processCategoryThumbs(true);
    }

    // Identifies target sidebar profile fields
    function getCreatorIdFromSidebar() {
        const link = document.querySelector('#left-sidebar .details-profile-container .profile-right .name a.theme-link.flipnote-title-link');
        return link?.href.match(/\/user\/([A-F0-9]{16}@DSi)/i)?.[1]?.toUpperCase() ?? null;
    }

    function shouldRedirect() {
        const p = location.pathname;

        // Blocked flipstream page redirect
        if (hideFlipstreams && p.startsWith('/flipstream')) {
            return true;
        }

        if (p.startsWith('/channel/')) {
            const chId = p.split('/')[2];
            if (chId && blockedchannels.some(c => c.id.toUpperCase() === chId.toUpperCase())) return true;
        }

        if (p.startsWith('/watch/')) {
            const channelLink = document.querySelector('a[href^="/channel/"]');
            if (channelLink) {
                const chId = channelLink.href.match(/\/channel\/([a-zA-Z0-9]+)/)?.[1];
                if (chId && blockedchannels.some(c => c.id.toUpperCase() === chId.toUpperCase())) {
                    const flipnoteEl = document.querySelector('.flipnote-title-link[href^="/user/"], .username a[href^="/user/"]');
                    if (flipnoteEl) {
                        const creatorId = flipnoteEl.href.match(/\/user\/([A-F0-9]{16}@DSi)/i)?.[1]?.toUpperCase();
                        if (creatorId && isWhitelisted(creatorId)) return false;
                    }
                    return true;
                }
            }

            const flipnoteEl = document.querySelector('.flipnote-title-link[href^="/user/"], .username a[href^="/user/"]');
            if (flipnoteEl) {
                const creatorId = flipnoteEl.href.match(/\/user\/([A-F0-9]{16}@DSi)/i)?.[1]?.toUpperCase();
                if (creatorId && !isWhitelisted(creatorId) && blockedcreators.some(c => c.id.toUpperCase() === creatorId.toUpperCase())) return true;
            }
        }

        if (p.startsWith('/user/')) {
            let id = p.split('/')[2]?.toUpperCase();
            if (!id) return false;
            if (!id.includes('@DSi')) id = getCreatorIdFromSidebar() || id;
            if (id && !isWhitelisted(id) && blockedcreators.some(c => c.id.toUpperCase() === id.toUpperCase())) return true;
        }

        return false;
    }

    function updateCreatorBtn(btn, isBlocked, isWhite) {
        btn.className = `sm-btn-creator btn btn-sm ms-2 ${isBlocked ? 'btn-danger' : isWhite ? 'btn-success' : 'btn-outline-danger'}`;
        btn.innerHTML = isWhite ? '<i class="fas fa-star"></i>' : '<i class="fas fa-ban"></i>';
        btn.title = isWhite ? 'Remove whitelist' : 'Hide this creator';
    }

    function addBlockBtn(el, type, id, name, status) {
        if (type === 'creator' && status.whitelisted) return;
        if (el.querySelector(`.sm-btn-${type}`)) return;
        const btn = document.createElement('button');
        btn.className = `sm-btn-${type} btn btn-sm ${status.blocked ? 'btn-danger' : status.whitelisted ? 'btn-success' : 'btn-outline-danger'}`;
        btn.title = type === 'channel'
            ? (status.blocked ? 'Show channel' : 'Hide channel')
            : (status.whitelisted ? 'Remove whitelist' : 'Hide this creator');
        // Use icon for both so the circular overlay button stays compact on thumbs
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
                const upperId = id.toUpperCase();
                const cached = creatorNameCache.get(upperId);
                const finalName = cached?.name || name || 'Unknown';

                const isWhite = whitelistedcreators.some(c => c.id.toUpperCase() === upperId);
                const isBlocked = blockedcreators.some(c => c.id.toUpperCase() === upperId);
                if (isWhite) {
                    unwhitelistCreator(id);
                } else if (isBlocked) {
                    unblockCreator(id);
                } else {
                    blockCreator(id, finalName);
                }
                const nowWhite = whitelistedcreators.some(c => c.id.toUpperCase() === upperId);
                updateCreatorBtn(btn, blockedcreators.some(c => c.id.toUpperCase() === upperId), nowWhite);
            }
        };

        if (type === 'creator') {
            const toggleWhitelist = () => {
                const upperId = id.toUpperCase();
                const cached = creatorNameCache.get(upperId);
                const finalName = cached?.name || name || 'Unknown';
                const isWhite = whitelistedcreators.some(c => c.id.toUpperCase() === upperId);
                if (isWhite) unwhitelistCreator(id);
                else whitelistCreator(id, finalName);
                updateCreatorBtn(btn, blockedcreators.some(c => c.id.toUpperCase() === upperId), !isWhite);
            };
            const startLongPress = () => { longpresstimer = setTimeout(toggleWhitelist, 600); };
            const cancel = () => clearTimeout(longpresstimer);
            btn.addEventListener('mousedown', e => { if (e.button === 2) { e.preventDefault(); toggleWhitelist(); } });
            btn.addEventListener('touchstart', startLongPress);
            btn.addEventListener('touchend', cancel);
            btn.addEventListener('touchcancel', cancel);
            btn.addEventListener('touchmove', cancel);
            btn.addEventListener('contextmenu', e => e.preventDefault());
        }

        // Resolves the exact element to overlay the button over (supporting watch-next, playlist, search, related, genealogy, category channels)
        // Prefer category grid path: .category-thumbs .thumb a > img.flipnote-hoverpreview-img
        const catThumbImg = el.querySelector('.category-thumbs .thumb a img.flipnote-hoverpreview-img') ||
                            el.querySelector('.category-thumbs img.flipnote-hoverpreview-img');
        const thumbContainer = (catThumbImg && (catThumbImg.closest('a') || catThumbImg.parentElement)) ||
                               el.querySelector('div.flipnote-item-thumb') ||
                               el.querySelector('.flipstream-thumbnail-card__frame') ||
                               el.querySelector('.related-preview a') ||
                               el.querySelector('.related-preview') ||
                               el.querySelector('.category-thumbs .thumb a') ||
                               el.querySelector('.category-thumbs .thumb') ||
                               el.querySelector('.category-thumbs a') ||
                               el.querySelector('.flipnote-genealogy-card') ||
                               el.querySelector('.playlist-flipnote-thumb')?.parentElement ||
                               el.querySelector('.rec-thumbnail')?.parentElement ||
                               el.querySelector('.search-samples__thumb')?.parentElement ||
                               el.querySelector('.search-movie__thumb')?.parentElement ||
                               el.querySelector('.playlist-flipnote-thumb') ||
                               el.querySelector('.rec-thumbnail') ||
                               el.querySelector('.search-samples__thumb') ||
                               el.querySelector('.search-movie__thumb-link') ||
                               el.querySelector('.recommended-thumb-link, .recommended-thumb')?.closest('a') ||
                               el.querySelector('a[href^="/user/"] img')?.parentElement ||
                               el.querySelector('img')?.parentElement;

        if (thumbContainer) {
            thumbContainer.style.position = 'relative';
            thumbContainer.style.display = thumbContainer.style.display || '';
            // Ensure the anchor can host an absolute child
            if (thumbContainer.tagName === 'A') {
                thumbContainer.style.display = 'inline-block';
            }
            thumbContainer.appendChild(btn);
        } else {
            const target = el.querySelector('.flipnote-stats, .stats, .username, .meta, .flipnote-item-info, .playlist-flipnote-info, .recommended-item-info') || el.lastElementChild;
            if (target) target.appendChild(btn);
        }

        el.classList.add('sm-btn-added');
    }

    function renderList(list, type, iconFn = null) {
        if (list.length === 0) return `<div class="text-muted py-5 text-center"><i class="fas fa-inbox fa-3x mb-3"></i><br>Empty.</div>`;
        let html = `<div class="list-group list-group-flush">`;
        list.forEach(item => {
            const display = item.name || item.id;

            let iconHtml = '';
            if (type === 'channel' && iconFn) {
                iconHtml = `<img src="${iconFn(item.id)}" width="40" height="40" class="me-3 rounded" onerror="this.style.display='none'">`;
            } else if (type === 'creator') {
                const cached = creatorNameCache.get(item.id.toUpperCase());
                const avatarUrl = item.avatar || cached?.avatar || '';

                if (avatarUrl) {
                    iconHtml = `<img src="${avatarUrl}" width="40" height="40" class="me-3 rounded" onerror="this.style.display='none'">`;
                } else {
                    iconHtml = `<div class="me-3 sm-avatar-placeholder" data-id="${item.id}"><i class="fas fa-user text-muted"></i></div>`;
                }
            }

            html += `
                <div class="list-group-item bg-dark border-secondary d-flex align-items-center py-3" data-id="${item.id}">
                    ${iconHtml}
                    <div class="flex-grow-1">
                        <div class="fw-bold">${display}</div>
                        <small class="text-muted">${item.id}</small>
                    </div>
                    <button class="btn btn-sm btn-outline-danger sm-unblock" data-id="${item.id}">Remove</button>
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
        Object.assign(backdrop.style, {position:'fixed', inset:'0', background:'rgba(0,0,0,0.75)', zIndex:9999, display:'flex', justifyContent:'center', alignItems:'center'});
        const dialog = document.createElement('div');
        dialog.className = 'sm-dialog';
        dialog.innerHTML = `
            <!-- Tab Layout -->
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

            <!-- Manual Add Field -->
            <div class="input-group mb-2">
                <select id="sm-add-type" class="form-select bg-dark text-light border-secondary" style="max-width: 110px;">
                    <option value="channel">Channel</option>
                    <option value="creator">Creator</option>
                </select>
                <input id="sm-add-id" type="text" class="form-control bg-dark text-light border-secondary" placeholder="Enter ID">
                <button id="sm-add-btn" class="btn btn-success"><i class="fas fa-plus"></i></button>
            </div>
            <p id="sm-add-hint" class="text-muted small px-1 mb-4">Channel ID from /channel/...</p>

            <!-- Preference Panel Card -->
            <div class="card bg-dark border-secondary p-3 mb-4">
                <h6 class="text-uppercase small tracking-wider text-muted mb-3 fw-bold">Preferences</h6>

                <div class="form-check form-switch mb-3">
                    <input class="form-check-input" type="checkbox" id="sm-toggle-hide-upsells" ${hideUpsells ? 'checked' : ''}>
                    <label class="form-check-label d-inline-flex align-items-center" for="sm-toggle-hide-upsells">
                        Hide Upsells
                        <span class="sm-help-badge" title="Hides Discord, Patreon, Shop/Merchandise, and YouTube Shorts promotions.">?</span>
                    </label>
                    <div class="text-muted small ps-1 mt-1">Discord, Patreon, Merch, Shorts promo</div>
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

            <!-- Side-by-side Import/Export Actions -->
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
            const blob = new Blob([JSON.stringify(data, null, 2)], {type: 'application/json'});
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url; a.download = 'sudomemo_blocklist.json'; a.click();
            URL.revokeObjectURL(url);
        };

        // Listeners for switches
        document.getElementById('sm-toggle-hide-upsells').onchange = (e) => {
            GM_setValue('hideupsells', e.target.checked);
        };
        document.getElementById('sm-toggle-hide-good-upsells').onchange = (e) => {
            GM_setValue('hidegoodupsells', e.target.checked);
        };
        document.getElementById('sm-toggle-hide-flipstreams').onchange = (e) => {
            GM_setValue('hideflipstreams', e.target.checked);
        };

        const addType = document.getElementById('sm-add-type');
        const addInput = document.getElementById('sm-add-id');
        addType.addEventListener('change', () => {
            addInput.placeholder = addType.value === 'channel' ? 'Channel ID' : 'Creator ID (XXXX@DSi)';
        });
        function updateHint() {
            document.getElementById('sm-add-hint').textContent = addType.value === 'channel'
                ? 'Channel ID from /channel/1234ABCD'
                : 'Creator IDs end with "@DSi"';
        }
        addType.addEventListener('change', updateHint);
        updateHint();
        document.getElementById('sm-add-btn').onclick = () => {
            let id = addInput.value.trim();
            if (!id) return;
            const type = addType.value;
            if (type === 'creator') id = id.toUpperCase();
            type === 'channel' ? blockChannel(id) : blockCreator(id);
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
                        const data = JSON.parse(ev.target.result);
                        blockedchannels = data.blockedchannels || [];
                        blockedcreators = data.blockedcreators || [];
                        whitelistedcreators = data.whitelistedcreators || [];
                        saveblockedchannels();
                        saveblockedcreators();
                        savewhitelistedcreators();
                        alert('Imported successfully');
                        backdrop.remove();
                    } catch {
                        alert('Invalid file format');
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
        backdrop.style.cssText = `position:fixed; inset:0; background:rgba(0,0,0,0.8); z-index:10000; display:flex; justify-content:center; align-items:center;`;
        const dialog = document.createElement('div');
        dialog.style.cssText = `background:#121212; color:#e0e0e0; border:1px solid #333; border-radius:12px; width:620px; max-width:94%; max-height:90vh; overflow:hidden; display:flex; flex-direction:column;`;
        dialog.innerHTML = `
            <div class="p-4 pb-2 d-flex justify-content-between align-items-center">
                <button class="btn btn-sm btn-outline-secondary back-btn"><i class="fas fa-arrow-left me-2"></i>Back</button>
                <div class="text-center flex-grow-1">
                    <h5><i class="fas fa-${icon}" style="color:${iconColor}"></i> ${title}</h5>
                    <small>${list.length} item${list.length !== 1 ? 's' : ''}</small>
                </div>
                <button class="btn btn-sm close" style="background:rgba(255,255,255,0.05);color:#ccc;">×</button>
            </div>
            <div class="px-4 pb-4" style="overflow-y:auto; flex-grow:1;">
                ${renderList(list, isChannel ? 'channel' : 'creator', isChannel ? id => `https://www.sudomemo.net/theatre_assets/images/dynamic/channel/${id}.png` : null)}
            </div>
        `;
        backdrop.appendChild(dialog);
        document.body.appendChild(backdrop);
        dialog.querySelector('.close').onclick = () => backdrop.remove();
        backdrop.onclick = e => { if (e.target === backdrop) backdrop.remove(); };
        dialog.querySelector('.back-btn').onclick = () => { backdrop.remove(); openBlocklistModal(); };

        if (mode === 'blocked' || mode === 'whitelist') {
            list.forEach(item => {
                resolveCreatorName(item.id, (resolvedName, resolvedAvatar) => {
                    dialog.querySelectorAll(`.sm-avatar-placeholder[data-id="${item.id}"]`).forEach(placeholder => {
                        if (resolvedAvatar) {
                            const img = document.createElement('img');
                            img.src = resolvedAvatar;
                            img.width = 40;
                            img.height = 40;
                            img.className = 'me-3 rounded';
                            img.onerror = () => { img.style.display = 'none'; };
                            placeholder.replaceWith(img);
                        }
                    });
                    const row = dialog.querySelector(`.list-group-item[data-id="${item.id}"]`);
                    if (row) {
                        const nameEl = row.querySelector('.fw-bold');
                        if (nameEl && (nameEl.textContent === 'Unknown' || nameEl.textContent === item.id)) {
                            nameEl.textContent = resolvedName;
                        }
                    }
                });
            });
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
                                const listContainer = dialog.querySelector('.px-4.pb-4');
                                if (listContainer) {
                                    listContainer.innerHTML = `<div class="text-muted py-5 text-center"><i class="fas fa-inbox fa-3x mb-3"></i><br>Empty.</div>`;
                                }
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

        // Target specifically the top navbar/menus to accurately identify logged-in user profile IDs
        const navLink = document.querySelector('.navbar-nav a[href^="/user/"], nav a[href^="/user/"], .dropdown-menu a[href^="/user/"], #user-dropdown a[href^="/user/"], .user-menu a[href^="/user/"]');
        const own = navLink?.href.match(/\/user\/([A-F0-9]{16}@DSi)/i)?.[1]?.toUpperCase();
        if (own) currentuser = own;

        processAll();
        injectMenuButton();
        setInterval(injectMenuButton, 2000);

        new MutationObserver(muts => {
            if (shouldRedirect()) {
                safeRedirect();
                return;
            }
            processSpotlight(); // Run unconditionally so spotlight is evaluated even when flipstreams are hidden
            processEmbeds();
            processRelatedFlipnotes();
            // Category thumbs + genealogy are throttled in the interval, skip on every mutation
            if (!hideFlipstreams) {
                processFlipstreams();
                processFlipstreamSlides();
            }
            muts.forEach(m => {
                if (m.addedNodes.length) m.addedNodes.forEach(n => {
                    if (n.nodeType !== 1) return;
                    if (n.matches('.flipnote-item, .flipnote-list-item, .channel-card, .cat-box, .playlist-flipnote, .trending-user, .recommended-item, li:has(.rec-thumbnail), .watch-next-item, .search-samples__item, .search-result')) processItem(n);
                    else n.querySelectorAll('.flipnote-item, .flipnote-list-item, .channel-card, .cat-box, .playlist-flipnote, .trending-user, .recommended-item, li:has(.rec-thumbnail), .watch-next-item, .search-samples__item, .search-result').forEach(processItem);
                });
            });
        }).observe(document.body, {childList:true, subtree:true});

        setInterval(() => {
            harvestCreatorNames();

            // Trending creators are explicitly omitted from receiving block buttons, but stay hidden if blocked
            document.querySelectorAll('.flipnote-item:not(.sm-btn-added), .flipnote-list-item:not(.sm-btn-added), .channel-card:not(.sm-btn-added), .cat-box:not(.sm-btn-added), .playlist-flipnote:not(.sm-btn-added), .recommended-item:not(.sm-btn-added), li:has(.rec-thumbnail):not(.sm-btn-added), .watch-next-item:not(.sm-btn-added), .search-samples__item:not(.sm-btn-added), .search-result:not(.sm-btn-added)')
                .forEach(el => {
                    // Category grid cards: per-thumb buttons are handled by processCategoryThumbs, skip card-level buttons
                    if (el.querySelector('.category-thumbs .thumb')) {
                        el.classList.add('sm-btn-added');
                        return;
                    }

                    const ch = getChannelId(el);
                    const cr = getCreatorId(el);
                    const chName = getChannelName(el);
                    const crName = getCreatorName(el);
                    if (ch) addBlockBtn(el, 'channel', ch, chName, {blocked: blockedchannels.some(c => c.id.toUpperCase() === ch.toUpperCase())});
                    if (cr) {
                        const isBlocked = isBlockedCreator(cr);
                        const isWhite = isWhitelisted(cr);

                        // Prevent adding a block button to yourself or whitelisted creators, while still marking the node processed
                        if (!isWhite && cr !== currentuser) {
                            addBlockBtn(el, 'creator', cr, crName, {blocked: isBlocked, whitelisted: false});
                        }
                    }
                    el.classList.add('sm-btn-added');
                });

            processSpotlight(); // Run unconditionally so spotlight is evaluated even when flipstreams are hidden
            processEmbeds();
            processRelatedFlipnotes();
            processCategoryThumbs();
            processGenealogy();

            // Safeguards to save resource cycles if Flipstreams are configured hidden
            if (!hideFlipstreams) {
                processFlipstreams();
                processFlipstreamSlides();
            }
        }, 1200);

        if (shouldRedirect()) {
            safeRedirect();
        }
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
          /* Non-category channel cards: show channel hide on card hover */
          .channel-card:not(:has(.category-thumbs)):hover .sm-btn-channel,
          .cat-box:not(:has(.category-thumbs)):hover .sm-btn-channel {
              opacity: 1;
              display: flex;
          }

          /* Category grid: only show creator button on the specific thumb being hovered */
          .category-thumbs .thumb:hover > .sm-btn-creator,
          .category-thumbs .thumb:hover > a > .sm-btn-creator,
          .category-thumbs .thumb a:hover > .sm-btn-creator {
              opacity: 1;
              display: flex;
          }

          /* Channel hide button should never appear inside category thumb strips */
          .category-thumbs .sm-btn-channel,
          .category-grid .category-thumbs .sm-btn-channel {
              display: none !important;
          }

          .category-thumbs .thumb,
          .category-thumbs .thumb a,
          .category-thumbs .thumb a:has(img.flipnote-hoverpreview-img) {
              position: relative !important;
              display: inline-block;
          }
          .category-thumbs .thumb a img.flipnote-hoverpreview-img {
              display: block;
          }

          /* Never show block button on blurred genealogy cards */
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
              /* Still hide on blurred genealogy even on mobile */
              .sm-blurred-genealogy .sm-btn-creator {
                  display: none !important;
              }
          }
      `);

    // Upsell hiding rules
    if (hideUpsells) {
        GM_addStyle(`
            .advert.mb-3 a[data-banner-name*="discord_slim"],
            .advert.mb-3 a[data-banner-name*="sudomemo_org_slim"],
            .advert.mb-3 a[data-banner-name*="patreon_slim"],
            .advert.mb-3 a[data-banner-name*="shorts_theatre"],
            .advert.mb-3 a[data-banner-name*="ziggy_patreon"],
            a[href*="/shop/#merch"] { display: none !important; }
            .advert:has(a[data-banner-name*="discord_slim"]),
            .advert:has(a[data-banner-name*="sudomemo_org_slim"]) { display: none !important; }
        `);
    }

    if (hideGoodUpsells && hideUpsells) {
        GM_addStyle(`
            .advert a[data-banner-name*="flipnote_organizer_promo"],
            .advert a[data-banner-name*="sudomemo_wii_room"],
            .advert a[data-banner-name*="3ds_install_guide"],
            .advert a[data-banner-name*="staying_safe_online"],
            .advert a[data-banner-name*="organizer_slim"],
            .advert a[data-banner-name*="archive_slim"],
            html body.theme-body.body-fullwidth-mobile div.row.pt-sm-1 div#left-sidebar.col-12.col-lg-3.col-xl-3.ml-lg-auto.px-0.order-3.order-lg-1.order-xl-1 div.mt-3.col-12.px-0 div.card.panel-common.mb-3.theme-advert-card { display: none !important; }
        `);
    }

    if (hideFlipstreams) {
        GM_addStyle(`
            html body.theme-body.body-fullwidth-mobile div.row.page-inner div.col-12.col-lg-12.col-xl-8.px-0 div.col-md-12.col-lg-12.col-xl-12.px-0 div.frontpage-flipstream-row.mx-3.mx-sm-0.mb-3,
            html body.theme-body.body-fullwidth-mobile div.row.pt-sm-1 div#center-column.col-12.col-lg-7.col-xl-6.px-0.mr-lg-auto.px-lg-3.order-1.order-xl-2 div#recommended-flipstreams-mobile.card.panel-common.mb-sm-3.d-xl-none,
            html body.theme-body.body-fullwidth-mobile div.row.pt-sm-1 div#playlist-and-feed-sidebar.col-12.col-xl-3.px-0.order-2.order-xl-3 div#recommended-flipstreams.card.panel-common.mb-sm-3.d-none.d-xl-block,
            html body.theme-body.body-fullwidth-mobile div.row.page-inner div.col-12.col-lg-12.col-xl-8.px-0 div.col-md-12.col-lg-12.col-xl-12.px-0 div#front-explore.card.panel-header-only.mb-3 {
                display: none !important;
            }
        `);
    }

    document.readyState === 'loading' ? document.addEventListener('DOMContentLoaded', init) : init();
})();
