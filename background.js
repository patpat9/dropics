const JOB_PREFIX = 'job_';
const TAB_MAP_PREFIX = 'tab_';
const JOB_TTL_MS = 5 * 60 * 1000;
const CONTEXT_MENU_ID = 'gcal-import-ics-link';
const MAX_FILE_BYTES = 6 * 1024 * 1024;

function t(key, subs, fallback = '') {
  return chrome.i18n?.getMessage(key, subs) || fallback || key;
}

// ---------------------------------------------------------------------------
// Context Menu Setup (Feature 3: Right-click .ics / .csv links)
// ---------------------------------------------------------------------------
function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create(
      {
        id: CONTEXT_MENU_ID,
        title: t('contextMenuImportIcs', null, 'Import .ics to Google Calendar'),
        contexts: ['link'],
        targetUrlPatterns: [
          '*://*/*.ics',
          '*://*/*.ics?*',
          '*://*/*.ics#*',
          '*://*/*.ical',
          '*://*/*.ical?*',
          '*://*/*.ifb',
          '*://*/*.ifb?*',
          '*://*/*.csv',
          '*://*/*.csv?*',
          '*://*/*format=ics*',
          '*://*/*type=ics*',
          '*://*/*export=ics*'
        ]
      },
      () => {
        if (chrome.runtime.lastError) {
          console.warn('[GCal Quick Import] Context menu setup warning:', chrome.runtime.lastError.message);
        }
      }
    );
  });
}

chrome.runtime.onInstalled.addListener(setupContextMenus);
chrome.runtime.onStartup.addListener(setupContextMenus);

let badgeTimer = null;
function setBadge(text, color, clearAfterMs = 0) {
  if (badgeTimer) {
    clearTimeout(badgeTimer);
    badgeTimer = null;
  }
  chrome.action.setBadgeText({ text });
  if (color) {
    chrome.action.setBadgeBackgroundColor({ color });
  }
  if (clearAfterMs > 0) {
    badgeTimer = setTimeout(() => {
      chrome.action.setBadgeText({ text: '' });
      badgeTimer = null;
    }, clearAfterMs);
  }
}

async function showPageFlashToast(tabId, message, isError = false) {
  if (tabId == null) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      args: [message, isError],
      func: (text, err) => {
        const id = 'gcal-ext-ctx-toast';
        const existing = document.getElementById(id);
        if (existing) existing.remove();
        const el = document.createElement('div');
        el.id = id;
        el.textContent = text;
        Object.assign(el.style, {
          position: 'fixed',
          bottom: '24px',
          left: '24px',
          zIndex: '2147483647',
          padding: '11px 16px',
          borderRadius: '10px',
          background: err ? '#c5221f' : '#202124',
          color: '#ffffff',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          fontSize: '13.5px',
          boxShadow: '0 6px 20px rgba(0,0,0,0.28)',
          maxWidth: '420px'
        });
        document.body.appendChild(el);
        setTimeout(() => el.remove(), err ? 7000 : 4500);
      }
    });
  } catch {
    // Ignore pages where activeTab injection is restricted (e.g. chrome://)
  }
}

async function findGcalTargetTab() {
  try {
    const currentWinTabs = await chrome.tabs.query({
      url: 'https://calendar.google.com/*',
      currentWindow: true
    });
    if (currentWinTabs && currentWinTabs.length > 0) {
      return currentWinTabs.find((tab) => tab.active) || currentWinTabs[0];
    }
    const allTabs = await chrome.tabs.query({ url: 'https://calendar.google.com/*' });
    if (!allTabs || allTabs.length === 0) return null;
    return allTabs.find((tab) => tab.active) || allTabs[0];
  } catch {
    return null;
  }
}

function getExportUrlFromTabUrl(urlStr) {
  try {
    const u = new URL(urlStr);
    const match = u.pathname.match(/^(\/calendar\/u\/\d+)/);
    const prefix = match ? match[1] : '/calendar/u/0';
    return `https://calendar.google.com${prefix}/r/settings/export`;
  } catch {
    return 'https://calendar.google.com/calendar/u/0/r/settings/export';
  }
}

async function handleContextMenuImport(info, tab) {
  const linkUrl = info.linkUrl;
  if (!linkUrl || tab?.id == null) return;

  setBadge('...', '#1a73e8');
  await showPageFlashToast(tab.id, t('ctxFetchingLink', null, 'Fetching calendar file...'));

  let fetched;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [linkUrl, MAX_FILE_BYTES],
      func: async (url, maxBytes) => {
        try {
          const resp = await fetch(url, { credentials: 'include' });
          if (!resp.ok) {
            return { ok: false, error: `HTTP ${resp.status}` };
          }
          const buf = await resp.arrayBuffer();
          if (buf.byteLength === 0) {
            return { ok: false, error: 'Empty file' };
          }
          if (buf.byteLength > maxBytes) {
            return { ok: false, error: 'File exceeds 6 MB limit' };
          }

          // Try to determine filename from Content-Disposition or URL path
          let fileName = '';
          const cd = resp.headers.get('content-disposition') || '';
          const utf8Match = cd.match(/filename\*\s*=\s*UTF-8''([^;\r\n]+)/i);
          const basicMatch = cd.match(/filename\s*=\s*"?([^";\r\n]+)"?/i);
          if (utf8Match) {
            fileName = decodeURIComponent(utf8Match[1]);
          } else if (basicMatch) {
            fileName = basicMatch[1].trim();
          } else {
            try {
              const pathname = new URL(url).pathname;
              fileName = decodeURIComponent(pathname.split('/').pop() || '');
            } catch {
              fileName = '';
            }
          }
          if (!fileName || !/\.(ics|ical|ifb|icalendar|csv)$/i.test(fileName)) {
            fileName = fileName ? `${fileName}.ics` : 'event.ics';
          }

          // Quick sanity check so HTML login pages aren't blindly fed to GCal
          const sampleText = new TextDecoder('utf-8', { fatal: false }).decode(
            buf.slice(0, Math.min(buf.byteLength, 2048))
          );
          const isCsv = /\.csv$/i.test(fileName);
          if (!isCsv && !/BEGIN:VCALENDAR/i.test(sampleText)) {
            return {
              ok: false,
              error: 'Link did not return a valid .ics calendar file (may require login or redirect).'
            };
          }

          const bytes = new Uint8Array(buf);
          let binary = '';
          const chunk = 0x8000;
          for (let i = 0; i < bytes.length; i += chunk) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
          }
          return {
            ok: true,
            fileName,
            fileType: resp.headers.get('content-type') || (isCsv ? 'text/csv' : 'text/calendar'),
            fileBase64: btoa(binary)
          };
        } catch (err) {
          return { ok: false, error: err?.message || 'CORS or network error' };
        }
      }
    });
    fetched = results?.[0]?.result;
  } catch (err) {
    fetched = { ok: false, error: err?.message || String(err) };
  }

  if (!fetched?.ok) {
    setBadge('!', '#c5221f', 6000);
    await showPageFlashToast(
      tab.id,
      t('ctxFetchFailed', [fetched?.error || 'Unknown error'], `Failed to fetch .ics link: ${fetched?.error || ''}`),
      true
    );
    return;
  }

  const gcalTab = await findGcalTargetTab();
  const exportUrl = gcalTab?.url
    ? getExportUrlFromTabUrl(gcalTab.url)
    : 'https://calendar.google.com/calendar/u/0/r/settings/export';

  const settings = await chrome.storage.sync.get({ defaultCalendarName: '' });
  const jobId = crypto.randomUUID();
  const job = {
    jobId,
    mode: 'quick',
    sourceTabId: gcalTab?.id ?? null,
    originNotifyTabId: tab.id,
    fromContextMenu: true,
    targetTabId: null,
    fileName: fetched.fileName,
    fileType: fetched.fileType,
    fileBase64: fetched.fileBase64,
    defaultCalendarName: (settings.defaultCalendarName || '').trim(),
    exportUrl,
    createdAt: Date.now()
  };

  await saveJob(job);

  const bgTab = await chrome.tabs.create({
    url: `${exportUrl}#gcal-ext-job=${encodeURIComponent(jobId)}`,
    active: false
  });
  job.targetTabId = bgTab.id;
  await saveJob(job);

  await showPageFlashToast(
    tab.id,
    t('ctxImportingFile', [fetched.fileName], `Importing "${fetched.fileName}" to Google Calendar...`)
  );
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === CONTEXT_MENU_ID) {
    handleContextMenuImport(info, tab);
  }
});

// ---------------------------------------------------------------------------
// Keyboard Command (Feature 4: Alt+I -> Multi-File Picker)
// ---------------------------------------------------------------------------
chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'open-file-picker') return;

  const gcalTab = await findGcalTargetTab();
  if (gcalTab?.id != null) {
    if (!gcalTab.active) {
      await chrome.tabs.update(gcalTab.id, { active: true });
    }
    try {
      await chrome.tabs.sendMessage(gcalTab.id, { type: 'OPEN_FILE_PICKER' });
    } catch (err) {
      console.warn('[GCal Quick Import] Could not trigger file picker on tab:', err);
    }
  } else {
    await chrome.tabs.create({
      url: 'https://calendar.google.com/calendar/u/0/r/settings/export'
    });
  }
});

// ---------------------------------------------------------------------------
// Session Job Queue & Storage Helpers
// ---------------------------------------------------------------------------
async function cleanupStaleJobs() {
  try {
    const all = await chrome.storage.session.get(null);
    const now = Date.now();
    const toRemove = [];
    for (const [key, value] of Object.entries(all)) {
      if (key.startsWith(JOB_PREFIX) && value && value.createdAt && now - value.createdAt > JOB_TTL_MS) {
        toRemove.push(key);
        if (value.targetTabId) {
          toRemove.push(`${TAB_MAP_PREFIX}${value.targetTabId}`);
        }
      }
    }
    if (toRemove.length > 0) {
      await chrome.storage.session.remove(toRemove);
    }
  } catch (err) {
    console.warn('[GCal Quick Import] Cleanup failed:', err);
  }
}

async function saveJob(job) {
  const payload = {
    [`${JOB_PREFIX}${job.jobId}`]: job
  };
  if (job.targetTabId != null) {
    payload[`${TAB_MAP_PREFIX}${job.targetTabId}`] = job.jobId;
  }
  await chrome.storage.session.set(payload);
}

async function consumeJob(tabId, jobIdHint) {
  let jobId = jobIdHint || null;
  if (!jobId && tabId != null) {
    const mapKey = `${TAB_MAP_PREFIX}${tabId}`;
    const mapRes = await chrome.storage.session.get(mapKey);
    jobId = mapRes[mapKey] || null;
  }
  if (!jobId) return null;

  const jobKey = `${JOB_PREFIX}${jobId}`;
  const res = await chrome.storage.session.get(jobKey);
  const job = res[jobKey] || null;

  const keysToRemove = [jobKey];
  if (tabId != null) {
    keysToRemove.push(`${TAB_MAP_PREFIX}${tabId}`);
  }
  if (job && job.targetTabId != null) {
    keysToRemove.push(`${TAB_MAP_PREFIX}${job.targetTabId}`);
  }
  await chrome.storage.session.remove(keysToRemove);
  return job;
}

// ---------------------------------------------------------------------------
// Calendar List Cache (Feature 1: Auto-detected calendars for Popup & Modal)
// ---------------------------------------------------------------------------
async function saveDetectedCalendars(accountPrefix, calendars, source) {
  const cleanList = Array.from(
    new Set((calendars || []).map((c) => String(c || '').trim()).filter(Boolean))
  );
  if (cleanList.length === 0) return;

  const key = accountPrefix || '/calendar/u/0';
  const stored = await chrome.storage.local.get({ calendarsByAccount: {} });
  const map = stored.calendarsByAccount || {};
  const existing = map[key];

  // Do not overwrite authoritative '/settings/export' list with sidebar scrape
  // unless the export cache is older than 24 hours
  if (
    source === 'sidebar' &&
    existing &&
    existing.source === 'export' &&
    Date.now() - (existing.updatedAt || 0) < 24 * 60 * 60 * 1000
  ) {
    // Still merge any newly created sidebar calendars that weren't in cache? No, keep export authoritative.
    await chrome.storage.local.set({ lastAccountPrefix: key });
    return;
  }

  map[key] = {
    calendars: cleanList,
    source: source || 'sidebar',
    updatedAt: Date.now()
  };

  await chrome.storage.local.set({
    calendarsByAccount: map,
    lastAccountPrefix: key
  });
}

const pendingCalendarSyncResolvers = new Map();

// ---------------------------------------------------------------------------
// Runtime Message Router
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  (async () => {
    await cleanupStaleJobs();

    switch (message.type) {
      case 'SAVE_CALENDAR_LIST': {
        await saveDetectedCalendars(message.accountPrefix, message.calendars, message.source);
        sendResponse({ ok: true });
        return;
      }

      case 'SYNC_CALENDARS_RESULT': {
        const bgTabId = sender.tab?.id;
        const { syncId, accountPrefix, calendars } = message;
        if (Array.isArray(calendars) && calendars.length > 0) {
          await saveDetectedCalendars(accountPrefix, calendars, 'export');
        }
        if (bgTabId != null) {
          try {
            await chrome.tabs.remove(bgTabId);
          } catch {
            // ignore
          }
        }
        const resolver = syncId ? pendingCalendarSyncResolvers.get(syncId) : null;
        if (resolver) {
          pendingCalendarSyncResolvers.delete(syncId);
          resolver({ ok: true, calendars: calendars || [], source: 'export' });
        }
        sendResponse({ ok: true });
        return;
      }

      case 'SYNC_CALENDARS_FROM_EXPORT': {
        const gcalTab = await findGcalTargetTab();
        const exportUrl = gcalTab?.url
          ? getExportUrlFromTabUrl(gcalTab.url)
          : 'https://calendar.google.com/calendar/u/0/r/settings/export';

        const jobId = crypto.randomUUID();
        const syncId = crypto.randomUUID();
        const job = {
          jobId,
          syncId,
          mode: 'sync_calendars',
          targetTabId: null,
          createdAt: Date.now()
        };
        await saveJob(job);

        const bgTab = await chrome.tabs.create({
          url: `${exportUrl}#gcal-ext-job=${encodeURIComponent(jobId)}`,
          active: false
        });
        job.targetTabId = bgTab.id;
        await saveJob(job);

        const result = await new Promise((resolve) => {
          const timer = setTimeout(async () => {
            pendingCalendarSyncResolvers.delete(syncId);
            try {
              await chrome.tabs.remove(bgTab.id);
            } catch {
              // ignore
            }
            resolve({ ok: false, calendars: [], error: 'Timeout' });
          }, 15000);

          pendingCalendarSyncResolvers.set(syncId, (data) => {
            clearTimeout(timer);
            resolve(data);
          });
        });

        sendResponse(result);
        return;
      }

      case 'GET_CALENDAR_LIST': {
        const gcalTab = !sender.tab ? await findGcalTargetTab() : null;
        let detectedPrefix = message.accountPrefix || null;
        if (!detectedPrefix && gcalTab?.url) {
          const m = new URL(gcalTab.url).pathname.match(/^(\/calendar\/u\/\d+)/);
          if (m) detectedPrefix = m[1];
        }

        const storedBefore = await chrome.storage.local.get({
          calendarsByAccount: {},
          lastAccountPrefix: '/calendar/u/0'
        });
        const mapBefore = storedBefore.calendarsByAccount || {};
        const keyBefore = detectedPrefix || storedBefore.lastAccountPrefix || '/calendar/u/0';
        const existingEntry = mapBefore[keyBefore] || null;

        // If we already have the exact authoritative '/settings/export' dropdown list,
        // return it STRICTLY without mixing in sidebar calendars!
        if (
          existingEntry &&
          existingEntry.source === 'export' &&
          Array.isArray(existingEntry.calendars) &&
          existingEntry.calendars.length > 0
        ) {
          sendResponse({
            ok: true,
            calendars: existingEntry.calendars,
            source: 'export'
          });
          return;
        }

        // Otherwise, when opened from Popup, scrape ONLY the "My calendars" section
        // (excluding read-only "Other calendars") so it matches /settings/export cleanly.
        let liveCalendars = [];
        let liveSource = 'sidebar';
        let livePrefix = detectedPrefix;
        if (!sender.tab && gcalTab?.id != null) {
          try {
            const execRes = await chrome.scripting.executeScript({
              target: { tabId: gcalTab.id },
              func: () => {
                const excludedRe =
                  /^(tasks|birthdays|reminders|任务|待办事项|生日|提醒|工作表|タスク|誕生日|생일|할 일|geburtstage|aufgaben|cumpleaños|tareas|anniversaires|tâches|aniversários|tarefas|compleanni|attività|дни рождения|задачи)$/i;
                const ligatureRe =
                  /^(more_vert|close|clear|check|add|expand_more|expand_less|keyboard_arrow_down|keyboard_arrow_up|visibility|visibility_off|done|remove|delete|settings|options)$/i;
                const myHeadRe =
                  /^(my calendars|我的日历|我的日曆|mis calendarios|minhas agendas|マイカレンダー|meine kalender|mes agendas|내 캘린더|мои календари|i miei calendari)$/i;
                const otherHeadRe =
                  /^(other calendars|其他日历|其他日曆|otros calendarios|outras agendas|他のカレンダー|weitere kalender|autres agendas|다른 캘린더|другие календари|altri calendari)$/i;

                const isIconEl = (el) => {
                  if (!el || !(el instanceof Element)) return false;
                  if (el.getAttribute('aria-hidden') === 'true') return true;
                  const cls = String(el.className || '');
                  if (/material|icon|symbol/i.test(cls)) return true;
                  const font = window.getComputedStyle(el).fontFamily || '';
                  return /material|icons|symbols/i.test(font);
                };

                const extractName = (cb, row) => {
                  if (row) {
                    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
                    let node;
                    while ((node = walker.nextNode())) {
                      const txt = (node.nodeValue || '').replace(/\s+/g, ' ').trim();
                      if (!txt) continue;
                      const p = node.parentElement;
                      if (!p) continue;
                      if (p.closest('button, [role="button"], svg, script, style')) continue;
                      if (isIconEl(p)) continue;
                      if (ligatureRe.test(txt)) continue;
                      const st = window.getComputedStyle(p);
                      if (st.display === 'none' || st.visibility === 'hidden') continue;
                      return txt;
                    }
                  }
                  const aria = (cb.getAttribute('aria-label') || row?.getAttribute('aria-label') || '').trim();
                  return aria.replace(/^(hide|show|隐藏|显示|隱藏|顯示)\s+/i, '').trim();
                };

                const prefixMatch = location.pathname.match(/^(\/calendar\/u\/\d+)/);
                const accountPrefix = prefixMatch ? prefixMatch[1] : '/calendar/u/0';

                // If currently on /settings/export, read the exact dropdown options
                if (/\/settings\/export(\/|$)/i.test(location.pathname)) {
                  const sel = document.querySelector('select');
                  if (sel && sel.options?.length > 0) {
                    const opts = Array.from(sel.options)
                      .map((o) => o.textContent.trim())
                      .filter(Boolean);
                    if (opts.length > 0) {
                      return { calendars: opts, accountPrefix, source: 'export' };
                    }
                  }
                  const optEls = Array.from(document.querySelectorAll('[role="option"]'))
                    .map((o) => (o.textContent || '').replace(/\s+/g, ' ').trim())
                    .filter(Boolean);
                  if (optEls.length > 0) {
                    return { calendars: Array.from(new Set(optEls)), accountPrefix, source: 'export' };
                  }
                }

                const maxRight = Math.min(480, Math.max(320, window.innerWidth * 0.42));
                let myTop = null;
                let otherTop = null;
                for (const el of document.querySelectorAll('button, [role="button"], [role="heading"], h2, h3, div, span')) {
                  if (el.children.length > 2) continue;
                  const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
                  if (!txt || txt.length > 40) continue;
                  const isMy = myHeadRe.test(txt);
                  const isOther = otherHeadRe.test(txt);
                  if (!isMy && !isOther) continue;
                  const r = el.getBoundingClientRect();
                  if (r.width <= 0 || r.height <= 0 || r.left > maxRight || r.right > maxRight + 80) continue;
                  if (isMy && (myTop === null || r.top < myTop)) myTop = r.top;
                  if (isOther && (otherTop === null || r.top < otherTop)) otherTop = r.top;
                }

                const withinMySection = (rect) => {
                  if (rect.top < 50 || rect.left > maxRight || rect.right > maxRight + 60) return false;
                  if (myTop !== null && rect.top < myTop) return false;
                  if (otherTop !== null && rect.top >= otherTop - 2) return false;
                  return true;
                };

                const results = [];
                const seen = new Set();
                const tryAdd = (raw) => {
                  const name = (raw || '')
                    .replace(/^(hide|show|隐藏|显示|隱藏|顯示)\s+/i, '')
                    .replace(/\s+/g, ' ')
                    .trim();
                  if (!name || name.length > 100) return;
                  if (excludedRe.test(name) || ligatureRe.test(name) || seen.has(name)) return;
                  seen.add(name);
                  results.push(name);
                };

                for (const cb of document.querySelectorAll('input[type="checkbox"], [role="checkbox"]')) {
                  if (cb.closest('header, [role="banner"], [role="dialog"], [role="alertdialog"]')) continue;
                  const row = cb.closest('[role="listitem"], li, label, [data-id]') || cb.parentElement;
                  if (!row) continue;
                  const st = window.getComputedStyle(row);
                  if (st.display === 'none' || st.visibility === 'hidden') continue;
                  const rect = row.getBoundingClientRect();
                  if (rect.width <= 0 || rect.height <= 0) continue;
                  if (!withinMySection(rect)) continue;
                  tryAdd(extractName(cb, row));
                }

                if (results.length === 0) {
                  for (const item of document.querySelectorAll('[role="list"] [role="listitem"]')) {
                    if (item.closest('header, [role="banner"], [role="dialog"], [role="alertdialog"]')) continue;
                    const rect = item.getBoundingClientRect();
                    if (rect.width <= 0 || rect.height <= 0) continue;
                    if (!withinMySection(rect)) continue;
                    const cb = item.querySelector('input[type="checkbox"], [role="checkbox"]') || item;
                    tryAdd(extractName(cb, item));
                  }
                }

                return { calendars: results, accountPrefix, source: 'sidebar' };
              }
            });

            const scraped = execRes?.[0]?.result;
            if (Array.isArray(scraped?.calendars) && scraped.calendars.length > 0) {
              liveCalendars = scraped.calendars;
              livePrefix = scraped.accountPrefix || livePrefix;
              liveSource = scraped.source || 'sidebar';
              await saveDetectedCalendars(livePrefix, liveCalendars, liveSource);
            }
          } catch (err) {
            console.warn('[GCal Quick Import] Live calendar scrape skipped:', err);
          }
        }

        const stored = await chrome.storage.local.get({
          calendarsByAccount: {},
          lastAccountPrefix: '/calendar/u/0'
        });
        const map = stored.calendarsByAccount || {};
        const key = livePrefix || stored.lastAccountPrefix || '/calendar/u/0';
        const entry = map[key] || Object.values(map)[0] || null;
        const finalCalendars =
          liveCalendars.length > 0 ? liveCalendars : entry?.calendars || [];

        sendResponse({
          ok: true,
          calendars: finalCalendars,
          source: liveCalendars.length > 0 ? liveSource : entry?.source || null
        });
        return;
      }

      case 'TRIGGER_FILE_PICKER_ON_GCAL': {
        const gcalTab = await findGcalTargetTab();
        if (gcalTab?.id != null) {
          if (!gcalTab.active) {
            await chrome.tabs.update(gcalTab.id, { active: true });
          }
          await chrome.tabs.sendMessage(gcalTab.id, { type: 'OPEN_FILE_PICKER' });
          sendResponse({ ok: true });
        } else {
          await chrome.tabs.create({
            url: 'https://calendar.google.com/calendar/u/0/r/settings/export'
          });
          sendResponse({ ok: true, openedSettings: true });
        }
        return;
      }

      case 'STAGE_PICK_IMPORT': {
        const sourceTabId = sender.tab?.id;
        if (sourceTabId == null) {
          sendResponse({ ok: false, error: 'Missing source tab id' });
          return;
        }
        const jobId = crypto.randomUUID();
        const job = {
          jobId,
          mode: 'pick',
          sourceTabId,
          targetTabId: sourceTabId,
          fileName: message.fileName,
          fileType: message.fileType,
          fileBase64: message.fileBase64,
          returnUrl: message.returnUrl || '',
          createdAt: Date.now()
        };
        await saveJob(job);
        sendResponse({ ok: true, jobId });
        return;
      }

      case 'START_QUICK_IMPORT': {
        const sourceTabId = sender.tab?.id;
        if (sourceTabId == null) {
          sendResponse({ ok: false, error: 'Missing source tab id' });
          return;
        }

        const settings = await chrome.storage.sync.get({
          defaultCalendarName: ''
        });

        const hasOverride = typeof message.overrideCalendarName === 'string';
        const targetCalendarName = hasOverride
          ? message.overrideCalendarName.trim()
          : (settings.defaultCalendarName || '').trim();

        const jobId = crypto.randomUUID();
        const exportUrl = message.exportUrl;

        const job = {
          jobId,
          mode: 'quick',
          sourceTabId,
          targetTabId: null,
          fileName: message.fileName,
          fileType: message.fileType,
          fileBase64: message.fileBase64,
          defaultCalendarName: targetCalendarName,
          exportUrl,
          createdAt: Date.now()
        };

        await saveJob(job);

        const bgTab = await chrome.tabs.create({
          url: `${exportUrl}#gcal-ext-job=${encodeURIComponent(jobId)}`,
          active: false,
          index: sender.tab ? sender.tab.index + 1 : undefined
        });

        job.targetTabId = bgTab.id;
        await saveJob(job);

        sendResponse({ ok: true, jobId, bgTabId: bgTab.id });
        return;
      }

      case 'CONSUME_JOB_FOR_TAB': {
        const tabId = sender.tab?.id;
        const job = await consumeJob(tabId, message.jobIdHint || null);
        sendResponse({ ok: true, job });
        return;
      }

      case 'QUICK_IMPORT_RESULT': {
        const bgTabId = sender.tab?.id;
        const {
          sourceTabId,
          originNotifyTabId,
          fromContextMenu,
          ok,
          statusText,
          fileName,
          calendarName,
          keepTabOpen
        } = message;

        if (sourceTabId != null) {
          try {
            await chrome.tabs.sendMessage(sourceTabId, {
              type: 'QUICK_IMPORT_DONE',
              ok,
              statusText,
              fileName,
              calendarName,
              fromContextMenu: Boolean(fromContextMenu),
              bgTabId: keepTabOpen ? bgTabId : null
            });
          } catch (err) {
            console.warn('[GCal Quick Import] Could not notify source tab:', err);
          }
        }

        if (fromContextMenu) {
          if (ok) {
            setBadge('\u2713', '#137333', 5000);
            if (originNotifyTabId != null && originNotifyTabId !== sourceTabId) {
              const calInfo = calendarName ? ` (${calendarName})` : '';
              await showPageFlashToast(
                originNotifyTabId,
                t(
                  'toastQuickSuccessSingle',
                  [calInfo, statusText || fileName],
                  `Imported${calInfo}: ${statusText || fileName}`
                ),
                false
              );
            }
          } else {
            setBadge('!', '#c5221f', 8000);
            if (originNotifyTabId != null && originNotifyTabId !== sourceTabId) {
              await showPageFlashToast(
                originNotifyTabId,
                t('toastQuickFailed', [statusText || fileName], `Import incomplete: ${statusText || fileName}`),
                true
              );
            }
          }
        }

        if (bgTabId != null && !keepTabOpen) {
          try {
            await chrome.tabs.remove(bgTabId);
          } catch (err) {
            console.warn('[GCal Quick Import] Could not close background tab:', err);
          }
        }
        sendResponse({ ok: true });
        return;
      }

      case 'FOCUS_TAB': {
        if (message.tabId != null) {
          try {
            await chrome.tabs.update(message.tabId, { active: true });
          } catch (err) {
            console.warn('[GCal Quick Import] Could not focus tab:', err);
          }
        }
        sendResponse({ ok: true });
        return;
      }

      case 'ATTACH_FILE_MAIN_WORLD': {
        const tabId = sender.tab?.id;
        if (tabId == null) {
          sendResponse({ ok: false, error: 'Missing tab id' });
          return;
        }
        const results = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          world: 'MAIN',
          args: [message.fileBase64, message.fileName, message.fileType || ''],
          func: (fileBase64, fileName, fileType) => {
            function collectInputsDeep(root, acc = []) {
              if (!root || !root.querySelectorAll) return acc;
              for (const el of root.querySelectorAll('input[type="file"]')) {
                acc.push(el);
              }
              for (const el of root.querySelectorAll('*')) {
                if (el.shadowRoot) {
                  collectInputsDeep(el.shadowRoot, acc);
                }
              }
              return acc;
            }

            const inputs = collectInputsDeep(document);
            if (inputs.length === 0) {
              return { found: false, count: 0 };
            }

            function scoreInput(input) {
              let score = 0;
              const accept = (input.getAttribute('accept') || '').toLowerCase();
              const name = (input.getAttribute('name') || '').toLowerCase();
              if (/(ics|ical|csv|calendar)/i.test(accept)) score += 30;
              if (/(file|import|ics)/i.test(name)) score += 10;
              if (input.closest('[role="main"], main')) score += 20;

              let p = input.parentElement;
              for (let depth = 0; depth < 6 && p; depth++, p = p.parentElement) {
                const txt = (p.innerText || p.textContent || '').trim();
                if (
                  /(select file|选择文件|選擇檔案|from your computer|从计算机|seleccionar archivo|selecionar arquivo|ファイルを選択|datei.*auswählen|sélectionner un fichier|파일 선택|выберите файл|seleziona file)/i.test(
                    txt
                  )
                ) {
                  score += 50;
                  break;
                }
                if (
                  /(import|导入|匯入|importar|インポート|importieren|importer|가져오기|импорт|importa)/i.test(
                    txt
                  )
                ) {
                  score += 15;
                }
              }
              return score;
            }

            const ranked = inputs
              .map((el) => ({ el, score: scoreInput(el) }))
              .sort((a, b) => b.score - a.score);

            const target = ranked[0].el;

            const binary = atob(fileBase64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) {
              bytes[i] = binary.charCodeAt(i);
            }
            const inferredType =
              fileType || (/\.csv$/i.test(fileName) ? 'text/csv' : 'text/calendar');
            const file = new File([bytes], fileName, {
              type: inferredType,
              lastModified: Date.now()
            });

            const dt = new DataTransfer();
            dt.items.add(file);

            const nativeSetter = Object.getOwnPropertyDescriptor(
              HTMLInputElement.prototype,
              'files'
            )?.set;
            if (nativeSetter) {
              nativeSetter.call(target, dt.files);
            } else {
              target.files = dt.files;
            }

            target.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            target.dispatchEvent(new Event('change', { bubbles: true, composed: true }));

            return {
              found: true,
              count: inputs.length,
              chosenScore: ranked[0].score,
              filesLength: target.files ? target.files.length : 0,
              diagnostics: ranked.map(({ el, score }) => ({
                score,
                name: el.name || '',
                accept: el.accept || '',
                jsname: el.getAttribute('jsname') || '',
                jsaction: el.getAttribute('jsaction') || '',
                parentText: (el.parentElement?.innerText || el.parentElement?.textContent || '')
                  .replace(/\s+/g, ' ')
                  .trim()
                  .slice(0, 80)
              }))
            };
          }
        });

        const matched = results.map((r) => r.result).find((r) => r && r.found);
        sendResponse({ ok: Boolean(matched), result: matched || null });
        return;
      }

      default:
        sendResponse({ ok: false, error: 'Unknown message type' });
    }
  })().catch((err) => {
    console.error('[GCal Quick Import] Background error:', err);
    sendResponse({ ok: false, error: err?.message || String(err) });
  });

  return true;
});
