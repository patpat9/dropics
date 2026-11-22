(() => {
  'use strict';

  const SUPPORTED_EXT_RE = /\.(ics|ical|ifb|icalendar|csv)$/i;
  const MAX_FILE_BYTES = 6 * 1024 * 1024; // 6 MB safety cap for session storage
  const POST_NAV_TOAST_KEY = 'gcal_quick_import_post_nav_toast';

  function t(key, subs, fallback = '') {
    try {
      const msg = chrome?.i18n?.getMessage(key, subs);
      if (msg) return msg;
    } catch {
      // Ignore if extension context was invalidated after reload
    }
    return fallback || key;
  }

  const settings = {
    showToolbarButton: true,
    enableDragDrop: true,
    pickInPageModal: true,
    autoJumpToDate: true,
    defaultCalendarName: ''
  };

  let lastKnownUrl = location.href;
  let exportJobCheckedForUrl = null;
  let activeQuickImportResolvers = [];
  let lastSavedCalendarSignature = '';
  let hiddenMultiFileInput = null;

  // ---------------------------------------------------------------------------
  // Settings Sync
  // ---------------------------------------------------------------------------
  function loadSettings() {
    return new Promise((resolve) => {
      if (!chrome?.storage?.sync) {
        resolve();
        return;
      }
      chrome.storage.sync.get(
        {
          showToolbarButton: true,
          enableDragDrop: true,
          pickInPageModal: true,
          autoJumpToDate: true,
          defaultCalendarName: ''
        },
        (res) => {
          settings.showToolbarButton = Boolean(res.showToolbarButton);
          settings.enableDragDrop = Boolean(res.enableDragDrop);
          settings.pickInPageModal = Boolean(res.pickInPageModal);
          settings.autoJumpToDate = Boolean(res.autoJumpToDate);
          settings.defaultCalendarName = (res.defaultCalendarName || '').trim();
          updateToolbarButtonVisibility();
          refreshOverlayLabels();
          resolve();
        }
      );
    });
  }

  if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'sync') return;
      if (changes.showToolbarButton) {
        settings.showToolbarButton = Boolean(changes.showToolbarButton.newValue);
        updateToolbarButtonVisibility();
      }
      if (changes.enableDragDrop) {
        settings.enableDragDrop = Boolean(changes.enableDragDrop.newValue);
        if (!settings.enableDragDrop) hideDndOverlay();
      }
      if (changes.pickInPageModal) {
        settings.pickInPageModal = Boolean(changes.pickInPageModal.newValue);
      }
      if (changes.autoJumpToDate) {
        settings.autoJumpToDate = Boolean(changes.autoJumpToDate.newValue);
      }
      if (changes.defaultCalendarName) {
        settings.defaultCalendarName = (changes.defaultCalendarName.newValue || '').trim();
        refreshOverlayLabels();
      }
    });
  }

  // ---------------------------------------------------------------------------
  // URL & DOM Utilities
  // ---------------------------------------------------------------------------
  function getAccountPrefix() {
    const match = location.pathname.match(/^(\/calendar\/u\/\d+)/);
    return match ? match[1] : '/calendar';
  }

  function getExportUrl() {
    return `${location.origin}${getAccountPrefix()}/r/settings/export`;
  }

  function buildDateViewUrl(year, month, day) {
    const viewMatch = location.pathname.match(
      /\/r\/(day|week|month|year|agenda|customday)(?:\/|$)/i
    );
    const currentView = viewMatch ? viewMatch[1].toLowerCase() : 'week';
    return `${location.origin}${getAccountPrefix()}/r/${currentView}/${year}/${month}/${day}`;
  }

  function formatDateYmd(dateObj) {
    if (!dateObj) return '';
    const y = String(dateObj.year).padStart(4, '0');
    const m = String(dateObj.month).padStart(2, '0');
    const d = String(dateObj.day).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function parseIcsDateValue(rawValue) {
    const val = (rawValue || '').trim();
    // Matches YYYYMMDD or YYYYMMDDTHHMMSS(Z)
    const match = val.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/i);
    if (!match) return null;

    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;

    if (match[7] && match[7].toUpperCase() === 'Z') {
      // UTC timestamp: convert to browser's local calendar date
      const hh = Number(match[4] || 0);
      const mm = Number(match[5] || 0);
      const ss = Number(match[6] || 0);
      const localDate = new Date(Date.UTC(year, month - 1, day, hh, mm, ss));
      if (Number.isNaN(localDate.getTime())) return null;
      return {
        year: localDate.getFullYear(),
        month: localDate.getMonth() + 1,
        day: localDate.getDate(),
        sortKey: localDate.getTime()
      };
    }

    const hh = Number(match[4] || 0);
    const mm = Number(match[5] || 0);
    const ss = Number(match[6] || 0);
    const localDate = new Date(year, month - 1, day, hh, mm, ss);
    return {
      year,
      month,
      day,
      sortKey: localDate.getTime()
    };
  }

  function parseIcsEventDates(icsText) {
    if (!icsText) return [];
    // Unfold RFC 5545 folded lines
    const unfolded = icsText.replace(/\r?\n[ \t]/g, '');
    const dates = [];

    // Isolate VEVENT blocks so VTIMEZONE DTSTART (e.g. 1970) is never matched
    const veventRe = /BEGIN:VEVENT\b([\s\S]*?)END:VEVENT/gi;
    let blockMatch;
    while ((blockMatch = veventRe.exec(unfolded)) !== null) {
      const block = blockMatch[1];
      const dtMatch = block.match(/(?:^|\r?\n)DTSTART(?:;[^:\r\n]*)?:([^\r\n]+)/i);
      if (!dtMatch) continue;
      const parsed = parseIcsDateValue(dtMatch[1]);
      if (parsed) dates.push(parsed);
    }
    return dates;
  }

  function parseCsvEventDates(csvText) {
    if (!csvText) return [];
    const lines = csvText.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return [];
    const headers = lines[0].split(',').map((h) => h.replace(/^"|"$/g, '').trim().toLowerCase());
    const startIdx = headers.findIndex((h) => h === 'start date' || h === '开始日期');
    if (startIdx < 0) return [];

    const dates = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map((c) => c.replace(/^"|"$/g, '').trim());
      const raw = cols[startIdx];
      if (!raw) continue;
      let year, month, day;
      const ymd = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
      const mdy = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
      if (ymd) {
        year = Number(ymd[1]);
        month = Number(ymd[2]);
        day = Number(ymd[3]);
      } else if (mdy) {
        month = Number(mdy[1]);
        day = Number(mdy[2]);
        year = Number(mdy[3]);
      }
      if (year && month >= 1 && month <= 12 && day >= 1 && day <= 31) {
        dates.push({
          year,
          month,
          day,
          sortKey: new Date(year, month - 1, day).getTime()
        });
      }
    }
    return dates;
  }

  async function extractEarliestEventDateFromFile(file) {
    try {
      const text = await file.text();
      const dates = /\.csv$/i.test(file.name)
        ? parseCsvEventDates(text)
        : parseIcsEventDates(text);
      if (dates.length === 0) return null;
      dates.sort((a, b) => a.sortKey - b.sortKey);
      return dates[0];
    } catch {
      return null;
    }
  }

  function savePostNavToast(payload) {
    try {
      sessionStorage.setItem(
        POST_NAV_TOAST_KEY,
        JSON.stringify({
          ...payload,
          expiresAt: Date.now() + 15000
        })
      );
    } catch {
      // ignore storage errors
    }
  }

  function consumePostNavToast() {
    try {
      const raw = sessionStorage.getItem(POST_NAV_TOAST_KEY);
      if (!raw) return;
      sessionStorage.removeItem(POST_NAV_TOAST_KEY);
      const data = JSON.parse(raw);
      if (!data || (data.expiresAt && Date.now() > data.expiresAt)) return;
      showToast(data.text, {
        variant: data.variant || 'success',
        duration: 6500,
        actionLabel: data.returnUrl ? t('btnReturnOriginDate', null, 'Previous date') : null,
        onAction: data.returnUrl
          ? () => {
              window.location.href = data.returnUrl;
            }
          : null
      });
    } catch {
      // ignore
    }
  }

  function isSettingsPage() {
    return /\/settings(\/|$)/i.test(location.pathname);
  }

  function isExportPage() {
    return /\/settings\/export(\/|$)/i.test(location.pathname);
  }

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function waitForCondition(predicate, timeoutMs = 12000, intervalMs = 150) {
    return new Promise((resolve) => {
      const immediate = predicate();
      if (immediate) {
        resolve(immediate);
        return;
      }

      let settled = false;
      const done = (val) => {
        if (settled) return;
        settled = true;
        clearInterval(timer);
        clearTimeout(timeout);
        observer.disconnect();
        resolve(val);
      };

      const check = () => {
        try {
          const result = predicate();
          if (result) done(result);
        } catch {
          // ignore transient DOM errors
        }
      };

      const observer = new MutationObserver(check);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true
      });

      const timer = setInterval(check, intervalMs);
      const timeout = setTimeout(() => done(null), timeoutMs);
    });
  }

  function simulateUserClick(el) {
    if (!el) return;
    const opts = { bubbles: true, cancelable: true, view: window, button: 0 };
    el.dispatchEvent(new PointerEvent('pointerdown', opts));
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new PointerEvent('pointerup', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        const commaIdx = result.indexOf(',');
        resolve(commaIdx >= 0 ? result.slice(commaIdx + 1) : result);
      };
      reader.onerror = () => reject(reader.error || new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  }

  function base64ToFile(base64, fileName, fileType) {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    const inferredType =
      fileType ||
      (/\.csv$/i.test(fileName) ? 'text/csv' : 'text/calendar');
    return new File([bytes], fileName, { type: inferredType });
  }

  // ---------------------------------------------------------------------------
  // Toast Notifications
  // ---------------------------------------------------------------------------
  function getToastContainer() {
    let container = document.getElementById('gcal-ext-toast-container');
    if (!container) {
      container = document.createElement('div');
      container.id = 'gcal-ext-toast-container';
      document.body.appendChild(container);
    }
    return container;
  }

  function showToast(text, options = {}) {
    const {
      variant = 'info', // 'info' | 'loading' | 'success' | 'error'
      duration = 4500,
      actionLabel = null,
      onAction = null
    } = options;

    const container = getToastContainer();
    const toast = document.createElement('div');
    toast.className = `gcal-ext-toast${variant === 'success' ? ' gcal-toast-success' : ''}${
      variant === 'error' ? ' gcal-toast-error' : ''
    }`;

    let spinnerEl = null;
    if (variant === 'loading') {
      spinnerEl = document.createElement('div');
      spinnerEl.className = 'gcal-ext-toast-spinner';
      toast.appendChild(spinnerEl);
    }

    const textEl = document.createElement('div');
    textEl.className = 'gcal-ext-toast-text';
    textEl.textContent = text;
    toast.appendChild(textEl);

    let actionBtn = null;
    if (actionLabel && typeof onAction === 'function') {
      actionBtn = document.createElement('button');
      actionBtn.type = 'button';
      actionBtn.className = 'gcal-ext-toast-action';
      actionBtn.textContent = actionLabel;
      actionBtn.addEventListener('click', () => {
        onAction();
      });
      toast.appendChild(actionBtn);
    }

    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'gcal-ext-toast-close';
    closeBtn.setAttribute('aria-label', t('toastCloseLabel', null, 'Close'));
    closeBtn.textContent = '\u00d7';
    closeBtn.addEventListener('click', () => remove());
    toast.appendChild(closeBtn);

    container.appendChild(toast);

    let autoTimer = null;
    const scheduleRemove = (ms) => {
      if (autoTimer) clearTimeout(autoTimer);
      if (ms > 0) {
        autoTimer = setTimeout(() => remove(), ms);
      }
    };

    const remove = () => {
      if (autoTimer) clearTimeout(autoTimer);
      toast.remove();
    };

    const update = (newText, newOpts = {}) => {
      const nextVariant = newOpts.variant || variant;
      toast.className = `gcal-ext-toast${nextVariant === 'success' ? ' gcal-toast-success' : ''}${
        nextVariant === 'error' ? ' gcal-toast-error' : ''
      }`;
      textEl.textContent = newText;

      if (nextVariant === 'loading' && !spinnerEl) {
        spinnerEl = document.createElement('div');
        spinnerEl.className = 'gcal-ext-toast-spinner';
        toast.insertBefore(spinnerEl, textEl);
      } else if (nextVariant !== 'loading' && spinnerEl) {
        spinnerEl.remove();
        spinnerEl = null;
      }

      if (actionBtn) {
        actionBtn.remove();
        actionBtn = null;
      }
      if (newOpts.actionLabel && typeof newOpts.onAction === 'function') {
        actionBtn = document.createElement('button');
        actionBtn.type = 'button';
        actionBtn.className = 'gcal-ext-toast-action';
        actionBtn.textContent = newOpts.actionLabel;
        actionBtn.addEventListener('click', () => newOpts.onAction());
        toast.insertBefore(actionBtn, closeBtn);
      }

      scheduleRemove(newOpts.duration !== undefined ? newOpts.duration : 5000);
    };

    if (variant !== 'loading' && duration > 0) {
      scheduleRemove(duration);
    }

    return { el: toast, update, remove };
  }

  // ---------------------------------------------------------------------------
  // 1. Top Toolbar Import & Export Button (Left of Search Icon)
  // ---------------------------------------------------------------------------
  const SEARCH_EXACT_RE = /^(search|搜索|搜尋|buscar|pesquisar|検索|suchen|rechercher|검색|поиск|cerca)$/i;
  const SEARCH_CONTAINS_RE = /(search|搜索|搜尋|buscar|pesquisar|検索|suchen|rechercher|검색|поиск|cerca)/i;
  const SEARCH_EXCLUDE_RE = /(people|clear|close|清除|关闭|關閉|personas|pessoas|ユーザー|personen|personnes|사용자|людей|persone)/i;
  const UTILITY_BTN_RE = /(support|help|settings|支持|帮助|设置|設定|asistencia|ayuda|configuración|suporte|ajuda|configurações|サポート|ヘルプ|hilfe|einstellungen|assistance|aide|paramètres|지원|도움말|설정|справка|поддержка|настройки|assistenza|guida|impostazioni)/i;

  function findSearchButtonInHeader() {
    const header = document.querySelector('header[role="banner"]') || document.querySelector('header');
    if (!header) return null;

    const candidates = Array.from(header.querySelectorAll('button, [role="button"]')).filter(isVisible);

    // Priority 1: Exact localized Search label
    let target = candidates.find((el) => {
      const label = (el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || '').trim();
      return SEARCH_EXACT_RE.test(label);
    });
    if (target) return target;

    // Priority 2: Contains Search (excluding people/clear/close)
    target = candidates.find((el) => {
      const label = (el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || '').trim();
      return SEARCH_CONTAINS_RE.test(label) && !SEARCH_EXCLUDE_RE.test(label);
    });
    if (target) return target;

    // Priority 3: Fallback near Support/Help or Settings gear icon
    const utilityBtn = candidates.find((el) => {
      const label = (el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || '').trim();
      return UTILITY_BTN_RE.test(label);
    });
    return utilityBtn || null;
  }

  function findAlignmentReferenceInHeader(fallbackBtn) {
    const header = document.querySelector('header[role="banner"]') || document.querySelector('header');
    if (!header) return fallbackBtn;
    const candidates = Array.from(header.querySelectorAll('button, [role="button"]')).filter(isVisible);
    // Prefer Help (?) or Settings (gear) because their icons are vertically symmetrical
    const symBtn = candidates.find((el) => {
      const label = (el.getAttribute('aria-label') || el.getAttribute('data-tooltip') || '').trim();
      return UTILITY_BTN_RE.test(label);
    });
    return symBtn || fallbackBtn;
  }

  function alignToolbarButtonVertically(wrapper, fallbackBtn) {
    if (!wrapper || !wrapper.isConnected) return;
    const refBtn = findAlignmentReferenceInHeader(fallbackBtn);
    if (!refBtn || !isVisible(refBtn)) return;

    const myIcon = wrapper.querySelector('svg') || wrapper;
    const refIcon = refBtn.querySelector('svg') || refBtn;

    wrapper.style.transform = '';
    const myRect = myIcon.getBoundingClientRect();
    const refRect = refIcon.getBoundingClientRect();
    if (myRect.height <= 0 || refRect.height <= 0) return;

    const deltaY = Math.round(refRect.top + refRect.height / 2 - (myRect.top + myRect.height / 2));
    if (deltaY !== 0 && Math.abs(deltaY) <= 16) {
      wrapper.style.transform = `translateY(${deltaY}px)`;
    }
  }

  function createToolbarButtonElement(referenceBtn) {
    const wrapper = document.createElement('div');
    wrapper.id = 'gcal-quick-import-wrapper';

    const btn = document.createElement('button');
    btn.id = 'gcal-quick-import-btn';
    btn.type = 'button';
    btn.setAttribute('aria-label', t('toolbarImportLabel', null, 'Import'));

    if (referenceBtn) {
      const refColor = window.getComputedStyle(referenceBtn).color;
      if (refColor) {
        btn.style.color = refColor;
      }
    }

    // Material Symbols "upload" (Import file into calendar) icon - matches GCal 24px 2px-stroke style
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M11 16V7.85l-2.6 2.6L7 9l5-5 5 5-1.4 1.45-2.6-2.6V16h-2Zm-5 4q-.825 0-1.412-.587T4 18v-3h2v3h12v-3h2v3q0 .825-.587 1.413T18 20H6Z"/>
      </svg>
    `;

    const navigateToExport = (openInNewTab) => {
      const url = getExportUrl();
      if (openInNewTab) {
        window.open(url, '_blank', 'noopener');
      } else {
        window.location.href = url;
      }
    };

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.altKey) {
        openMultiFilePicker();
        return;
      }
      navigateToExport(e.metaKey || e.ctrlKey || e.shiftKey);
    });

    btn.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        e.stopPropagation();
        navigateToExport(true);
      }
    });

    const tooltip = document.createElement('div');
    tooltip.id = 'gcal-quick-import-tooltip';
    tooltip.textContent = t('toolbarImportLabel', null, 'Import');

    wrapper.appendChild(btn);
    wrapper.appendChild(tooltip);
    return wrapper;
  }

  function removeToolbarButton() {
    const existing = document.getElementById('gcal-quick-import-wrapper');
    if (existing) existing.remove();
  }

  function ensureToolbarButton() {
    if (!settings.showToolbarButton || isSettingsPage()) {
      removeToolbarButton();
      return;
    }

    const existing = document.getElementById('gcal-quick-import-wrapper');
    if (existing) return;

    const searchBtn = findSearchButtonInHeader();
    if (!searchBtn) return;

    const wrapper = createToolbarButtonElement(searchBtn);

    // If Search button sits inside a single-button tooltip wrapper div inside a flex row,
    // insert right before that wrapper so layout/spacing stays native.
    const parent = searchBtn.parentElement;
    const grandParent = parent?.parentElement;
    if (
      parent &&
      grandParent &&
      parent.tagName === 'DIV' &&
      parent.querySelectorAll('button, [role="button"]').length === 1 &&
      window.getComputedStyle(grandParent).display.includes('flex')
    ) {
      grandParent.insertBefore(wrapper, parent);
    } else if (parent) {
      parent.insertBefore(wrapper, searchBtn);
    }

    // Lock vertical center precisely to GCal's adjacent toolbar icons
    requestAnimationFrame(() => alignToolbarButtonVertically(wrapper, searchBtn));
    setTimeout(() => alignToolbarButtonVertically(wrapper, searchBtn), 300);
  }

  function updateToolbarButtonVisibility() {
    if (!settings.showToolbarButton || isSettingsPage()) {
      removeToolbarButton();
    } else {
      ensureToolbarButton();
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Telegram-Style Split Drag & Drop Overlay
  // ---------------------------------------------------------------------------
  let overlayEl = null;
  let overlayVisible = false;
  let activeDropZone = null;

  function isFileDragEvent(e) {
    const dt = e.dataTransfer;
    if (!dt || !dt.types) return false;
    return Array.from(dt.types).includes('Files');
  }

  function buildOverlayContent() {
    if (!overlayEl) return;

    if (isExportPage()) {
      overlayEl.innerHTML = `
        <div class="gcal-dnd-zone" data-zone="direct">
          <div class="gcal-dnd-icon">
            <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
              <path d="M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm4 18H6V4h7v5h5v11zM8 15.01l1.41 1.41L11 14.84V19h2v-4.16l1.59 1.59L16 15.01 12.01 11 8 15.01z"/>
            </svg>
          </div>
          <span class="gcal-dnd-badge"></span>
          <h2 class="gcal-dnd-title"></h2>
          <p class="gcal-dnd-subtitle"></p>
        </div>
      `;
      overlayEl.querySelector('.gcal-dnd-badge').textContent = t('overlayDirectBadge');
      overlayEl.querySelector('.gcal-dnd-title').textContent = t('overlayDirectTitle');
      overlayEl.querySelector('.gcal-dnd-subtitle').textContent = t('overlayDirectSubtitle');
      return;
    }

    const defaultLabel = settings.defaultCalendarName || t('defaultCalendarFallback');
    overlayEl.innerHTML = `
      <div class="gcal-dnd-zone" data-zone="pick">
        <div class="gcal-dnd-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
            <path d="M19 3h-1V1h-2v2H8V1H6v2H5c-1.11 0-1.99.9-1.99 2L3 19c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V8h14v11zM7 10h5v5H7z"/>
          </svg>
        </div>
        <span class="gcal-dnd-badge"></span>
        <h2 class="gcal-dnd-title"></h2>
        <p class="gcal-dnd-subtitle"></p>
      </div>
      <div class="gcal-dnd-zone" data-zone="quick">
        <div class="gcal-dnd-icon">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
            <path d="M7 2v11h3v9l7-12h-4l4-8z"/>
          </svg>
        </div>
        <span class="gcal-dnd-badge"></span>
        <h2 class="gcal-dnd-title"></h2>
        <p class="gcal-dnd-subtitle">
          <span id="gcal-dnd-sub-prefix"></span><strong id="gcal-dnd-default-name"></strong><span id="gcal-dnd-sub-suffix"></span>
        </p>
      </div>
    `;
    const pickZone = overlayEl.querySelector('[data-zone="pick"]');
    pickZone.querySelector('.gcal-dnd-badge').textContent = t('overlayPickBadge');
    pickZone.querySelector('.gcal-dnd-title').textContent = settings.pickInPageModal
      ? t('overlayPickTitleModal', null, 'Preview events & pick calendar')
      : t('overlayPickTitle');
    pickZone.querySelector('.gcal-dnd-subtitle').textContent = settings.pickInPageModal
      ? t('overlayPickSubtitleModal', null, 'Preview events and pick a target calendar without leaving this page')
      : t('overlayPickSubtitle');

    const quickZone = overlayEl.querySelector('[data-zone="quick"]');
    quickZone.querySelector('.gcal-dnd-badge').textContent = t('overlayQuickBadge');
    quickZone.querySelector('.gcal-dnd-title').textContent = t('overlayQuickTitle');
    quickZone.querySelector('#gcal-dnd-sub-prefix').textContent = t('overlayQuickSubtitlePrefix');
    quickZone.querySelector('#gcal-dnd-default-name').textContent = defaultLabel;
    quickZone.querySelector('#gcal-dnd-sub-suffix').textContent = t('overlayQuickSubtitleSuffix');
  }

  function refreshOverlayLabels() {
    if (!overlayEl) return;
    const nameEl = overlayEl.querySelector('#gcal-dnd-default-name');
    if (nameEl) {
      nameEl.textContent = settings.defaultCalendarName || t('defaultCalendarFallback');
    }
  }

  function isGoogleCalendarDarkTheme() {
    const candidates = [
      document.querySelector('[role="main"]'),
      document.querySelector('header[role="banner"]'),
      document.querySelector('header'),
      document.body,
      document.documentElement
    ];

    for (const el of candidates) {
      if (!el) continue;
      const bg = window.getComputedStyle(el).backgroundColor;
      if (!bg || bg === 'transparent') continue;
      const match = bg.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)/i);
      if (!match) continue;
      const alpha = match[4] !== undefined ? Number(match[4]) : 1;
      if (alpha < 0.1) continue;
      const r = Number(match[1]);
      const g = Number(match[2]);
      const b = Number(match[3]);
      const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      return luminance < 0.5;
    }

    return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  }

  function applyOverlayTheme() {
    if (!overlayEl) return;
    const isDark = isGoogleCalendarDarkTheme();
    overlayEl.classList.toggle('gcal-theme-dark', isDark);
    overlayEl.classList.toggle('gcal-theme-light', !isDark);
  }

  function ensureOverlayElement() {
    if (!overlayEl) {
      overlayEl = document.createElement('div');
      overlayEl.id = 'gcal-dnd-overlay';
      document.body.appendChild(overlayEl);
    }
    buildOverlayContent();
    applyOverlayTheme();
    return overlayEl;
  }

  function setHighlightedZone(zoneName) {
    if (!overlayEl || activeDropZone === zoneName) return;
    activeDropZone = zoneName;
    overlayEl.querySelectorAll('.gcal-dnd-zone').forEach((el) => {
      el.classList.toggle('gcal-dnd-active', el.dataset.zone === zoneName);
    });
  }

  function resolveZoneFromEvent(e) {
    if (isExportPage()) return 'direct';
    return e.clientY < window.innerHeight / 2 ? 'pick' : 'quick';
  }

  function showDndOverlay(e) {
    if (!settings.enableDragDrop) return;
    if (!overlayVisible) {
      ensureOverlayElement();
      overlayEl.classList.add('gcal-dnd-visible');
      overlayVisible = true;
    }
    setHighlightedZone(resolveZoneFromEvent(e));
  }

  function hideDndOverlay() {
    if (!overlayVisible && !overlayEl) return;
    overlayVisible = false;
    activeDropZone = null;
    if (overlayEl) {
      overlayEl.classList.remove('gcal-dnd-visible');
      overlayEl.querySelectorAll('.gcal-dnd-zone').forEach((el) => {
        el.classList.remove('gcal-dnd-active');
      });
    }
  }

  // ---------------------------------------------------------------------------
  // 2B. Feature 1: Auto-Detect Writable Calendars (Sidebar + Export Dropdown)
  // ---------------------------------------------------------------------------
  const EXCLUDED_SYSTEM_CALENDARS_RE =
    /^(tasks|birthdays|reminders|任务|待办事项|生日|提醒|工作表|タスク|誕生日|생일|할 일|geburtstage|aufgaben|cumpleaños|tareas|anniversaires|tâches|aniversários|tarefas|compleanni|attività|дни рождения|задачи)$/i;
  const MATERIAL_LIGATURE_RE =
    /^(more_vert|close|clear|check|add|expand_more|expand_less|keyboard_arrow_down|keyboard_arrow_up|visibility|visibility_off|done|remove|delete|settings|options)$/i;

  function isIconFontElement(el) {
    if (!el || !(el instanceof Element)) return false;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    const cls = String(el.className || '');
    if (/material|icon|symbol/i.test(cls)) return true;
    const font = window.getComputedStyle(el).fontFamily || '';
    return /material|icons|symbols/i.test(font);
  }

  function extractCalendarNameFromRow(cb, row) {
    // 1. Check visible non-icon text inside the listitem / label
    if (row) {
      const textNodes = [];
      const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        const txt = (node.nodeValue || '').replace(/\s+/g, ' ').trim();
        if (!txt) continue;
        const parentEl = node.parentElement;
        if (!parentEl) continue;
        if (parentEl.closest('button, [role="button"], svg, script, style')) continue;
        if (isIconFontElement(parentEl)) continue;
        if (MATERIAL_LIGATURE_RE.test(txt)) continue;
        const style = window.getComputedStyle(parentEl);
        if (style.display === 'none' || style.visibility === 'hidden') continue;
        textNodes.push(txt);
      }
      if (textNodes.length > 0) {
        // Pick the primary calendar label (usually the first text node)
        return textNodes[0];
      }
    }

    // 2. Fallback to aria-label on checkbox or row
    const aria = (cb.getAttribute('aria-label') || row?.getAttribute('aria-label') || '').trim();
    return aria.replace(/^(hide|show|隐藏|显示|隱藏|顯示)\s+/i, '').trim();
  }

  const MY_CALENDARS_HEADING_RE =
    /^(my calendars|我的日历|我的日曆|mis calendarios|minhas agendas|マイカレンダー|meine kalender|mes agendas|내 캘린더|мои календари|i miei calendari)$/i;
  const OTHER_CALENDARS_HEADING_RE =
    /^(other calendars|其他日历|其他日曆|otros calendarios|outras agendas|他のカレンダー|weitere kalender|autres agendas|다른 캘린더|другие календари|altri calendari)$/i;

  function findSidebarSectionBounds(maxSidebarRight) {
    let myTop = null;
    let otherTop = null;
    const candidates = document.querySelectorAll('button, [role="button"], [role="heading"], h2, h3, div, span');
    for (const el of candidates) {
      if (el.children.length > 2) continue;
      const txt = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!txt || txt.length > 40) continue;
      const isMy = MY_CALENDARS_HEADING_RE.test(txt);
      const isOther = OTHER_CALENDARS_HEADING_RE.test(txt);
      if (!isMy && !isOther) continue;

      const rect = el.getBoundingClientRect();
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (rect.left > maxSidebarRight || rect.right > maxSidebarRight + 80) continue;

      if (isMy && (myTop === null || rect.top < myTop)) myTop = rect.top;
      if (isOther && (otherTop === null || rect.top < otherTop)) otherTop = rect.top;
    }
    return { myTop, otherTop };
  }

  function scrapeSidebarCalendars() {
    if (isSettingsPage()) return [];
    const results = [];
    const seen = new Set();

    const maxSidebarRight = Math.min(480, Math.max(320, window.innerWidth * 0.42));
    const { myTop, otherTop } = findSidebarSectionBounds(maxSidebarRight);

    const tryAddName = (rawName) => {
      const name = (rawName || '')
        .replace(/^(hide|show|隐藏|显示|隱藏|顯示)\s+/i, '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!name || name.length > 100) return;
      if (EXCLUDED_SYSTEM_CALENDARS_RE.test(name)) return;
      if (MATERIAL_LIGATURE_RE.test(name)) return;
      if (seen.has(name)) return;
      seen.add(name);
      results.push(name);
    };

    const withinMyCalendarsBounds = (rect) => {
      if (rect.top < 50 || rect.left > maxSidebarRight || rect.right > maxSidebarRight + 60) {
        return false;
      }
      if (myTop !== null && rect.top < myTop) return false;
      if (otherTop !== null && rect.top >= otherTop - 2) return false;
      return true;
    };

    // Strategy 1: Left-sidebar "My calendars" checkboxes only (excludes read-only "Other calendars")
    const checkboxes = document.querySelectorAll('input[type="checkbox"], [role="checkbox"]');
    for (const cb of checkboxes) {
      if (
        cb.closest('header, [role="banner"], [role="dialog"], [role="alertdialog"], #gcal-pick-modal-backdrop')
      ) {
        continue;
      }

      const row =
        cb.closest('[role="listitem"], li, label, [data-id]') || cb.parentElement;
      if (!row) continue;

      const rowStyle = window.getComputedStyle(row);
      if (rowStyle.display === 'none' || rowStyle.visibility === 'hidden') continue;

      const rowRect = row.getBoundingClientRect();
      if (rowRect.width <= 0 || rowRect.height <= 0) continue;
      if (!withinMyCalendarsBounds(rowRect)) continue;

      tryAddName(extractCalendarNameFromRow(cb, row));
    }

    // Strategy 2: Fallback to [role="list"] [role="listitem"] within "My calendars" bounds
    if (results.length === 0) {
      const listItems = document.querySelectorAll('[role="list"] [role="listitem"]');
      for (const item of listItems) {
        if (item.closest('header, [role="banner"], [role="dialog"], [role="alertdialog"]')) continue;
        const rect = item.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) continue;
        if (!withinMyCalendarsBounds(rect)) continue;
        const cb = item.querySelector('input[type="checkbox"], [role="checkbox"]') || item;
        tryAddName(extractCalendarNameFromRow(cb, item));
      }
    }

    return results;
  }

  function syncSidebarCalendars() {
    if (isSettingsPage() || !chrome?.runtime?.id) return;
    const calendars = scrapeSidebarCalendars();
    if (calendars.length === 0) return;

    const sig = `${getAccountPrefix()}|${calendars.join('\n')}`;
    if (sig === lastSavedCalendarSignature) return;
    lastSavedCalendarSignature = sig;

    chrome.runtime
      .sendMessage({
        type: 'SAVE_CALENDAR_LIST',
        accountPrefix: getAccountPrefix(),
        calendars,
        source: 'sidebar'
      })
      .catch(() => {});
  }

  function readExportDropdownOptionsPassive(sectionRoot) {
    const dropdown = findCalendarDropdown(sectionRoot);
    if (!dropdown) return [];

    if (dropdown.kind === 'select') {
      return Array.from(dropdown.el.options)
        .map((o) => o.textContent.trim())
        .filter(Boolean);
    }

    // Check aria-controls / aria-owns listbox (often exists in DOM even while collapsed)
    const controlledId =
      dropdown.el.getAttribute('aria-controls') || dropdown.el.getAttribute('aria-owns');
    if (controlledId) {
      const listbox = document.getElementById(controlledId);
      if (listbox) {
        const opts = Array.from(listbox.querySelectorAll('[role="option"]'))
          .map((o) => (o.textContent || '').replace(/\s+/g, ' ').trim())
          .filter(Boolean);
        if (opts.length > 0) return Array.from(new Set(opts));
      }
    }

    // Check any [role="option"] inside the dropdown or its enclosing Import section
    const containers = [dropdown.el, sectionRoot || findImportSectionRoot(findFileInput())];
    for (const root of containers) {
      if (!root) continue;
      const opts = Array.from(root.querySelectorAll('[role="option"]'))
        .map((o) => (o.textContent || '').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
      if (opts.length > 0) return Array.from(new Set(opts));
    }

    return [];
  }

  async function readExportDropdownOptionsActive(sectionRoot) {
    const passive = readExportDropdownOptionsPassive(sectionRoot);
    if (passive.length > 1) return passive;

    const dropdown = findCalendarDropdown(sectionRoot);
    if (!dropdown || dropdown.kind === 'select') return passive;

    // Expand Google Material dropdown briefly to force lazy-rendered [role="option"] items into DOM
    simulateUserClick(dropdown.el);
    const options = await waitForCondition(
      () => {
        const visibleOpts = Array.from(document.querySelectorAll('[role="option"]')).filter(isVisible);
        return visibleOpts.length > 0 ? visibleOpts : null;
      },
      4000,
      100
    );

    const names = options
      ? Array.from(
          new Set(
            options
              .map((o) => (o.innerText || o.textContent || '').replace(/\s+/g, ' ').trim())
              .filter(Boolean)
          )
        )
      : passive;

    // Close dropdown cleanly
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return names;
  }

  function syncExportDropdownCalendars(sectionRoot) {
    if (!chrome?.runtime?.id) return;
    const calendars = readExportDropdownOptionsPassive(sectionRoot);
    if (calendars.length > 0) {
      chrome.runtime
        .sendMessage({
          type: 'SAVE_CALENDAR_LIST',
          accountPrefix: getAccountPrefix(),
          calendars,
          source: 'export'
        })
        .catch(() => {});
    }
  }

  async function getAvailableCalendars() {
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'GET_CALENDAR_LIST',
        accountPrefix: getAccountPrefix()
      });
      // When authoritative '/settings/export' list is cached, use it STRICTLY as-is!
      if (res?.source === 'export' && Array.isArray(res.calendars) && res.calendars.length > 0) {
        return res.calendars;
      }
      if (Array.isArray(res?.calendars) && res.calendars.length > 0) {
        return res.calendars;
      }
    } catch {
      // ignore
    }

    return scrapeSidebarCalendars();
  }

  // ---------------------------------------------------------------------------
  // 2C. Feature 2: Event Preview Parser & In-Page Pick-Calendar Modal
  // ---------------------------------------------------------------------------
  function unescapeIcsText(val) {
    return (val || '')
      .replace(/\\n/gi, ' ')
      .replace(/\\,/g, ',')
      .replace(/\\;/g, ';')
      .replace(/\\\\/g, '\\')
      .trim();
  }

  function formatPreviewDateTime(rawValue) {
    const val = (rawValue || '').trim();
    const match = val.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/i);
    if (!match) return { label: val, sortKey: Number.MAX_SAFE_INTEGER };

    const y = Number(match[1]);
    const m = Number(match[2]);
    const d = Number(match[3]);
    const hasTime = Boolean(match[4]);

    if (!hasTime) {
      const dt = new Date(y, m - 1, d);
      const ymd = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      return { label: `${ymd} · ${t('previewAllDay', null, 'All day')}`, sortKey: dt.getTime() };
    }

    const hh = Number(match[4]);
    const mm = Number(match[5]);
    const ss = Number(match[6] || 0);
    const dt =
      match[7] && match[7].toUpperCase() === 'Z'
        ? new Date(Date.UTC(y, m - 1, d, hh, mm, ss))
        : new Date(y, m - 1, d, hh, mm, ss);

    const ly = String(dt.getFullYear()).padStart(4, '0');
    const lm = String(dt.getMonth() + 1).padStart(2, '0');
    const ld = String(dt.getDate()).padStart(2, '0');
    const lh = String(dt.getHours()).padStart(2, '0');
    const lmin = String(dt.getMinutes()).padStart(2, '0');
    return { label: `${ly}-${lm}-${ld} ${lh}:${lmin}`, sortKey: dt.getTime() };
  }

  function parseEventsPreviewFromText(text, fileName) {
    const events = [];
    if (!text) return events;

    if (/\.csv$/i.test(fileName)) {
      const lines = text.split(/\r?\n/).filter((l) => l.trim());
      if (lines.length < 2) return events;
      const headers = lines[0].split(',').map((h) => h.replace(/^"|"$/g, '').trim().toLowerCase());
      const subjIdx = headers.findIndex((h) => h === 'subject' || h === '主题');
      const dateIdx = headers.findIndex((h) => h === 'start date' || h === '开始日期');
      const timeIdx = headers.findIndex((h) => h === 'start time' || h === '开始时间');
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',').map((c) => c.replace(/^"|"$/g, '').trim());
        const title = (subjIdx >= 0 ? cols[subjIdx] : '') || fileName;
        const dateStr = dateIdx >= 0 ? cols[dateIdx] : '';
        const timeStr = timeIdx >= 0 ? cols[timeIdx] : '';
        events.push({
          title,
          dateTimeLabel: [dateStr, timeStr].filter(Boolean).join(' '),
          location: '',
          fileName,
          sortKey: i
        });
      }
      return events;
    }

    const unfolded = text.replace(/\r?\n[ \t]/g, '');
    const veventRe = /BEGIN:VEVENT\b([\s\S]*?)END:VEVENT/gi;
    let blockMatch;
    while ((blockMatch = veventRe.exec(unfolded)) !== null) {
      const block = blockMatch[1];
      const summaryMatch = block.match(/(?:^|\r?\n)SUMMARY(?:;[^:\r\n]*)?:([^\r\n]+)/i);
      const dtMatch = block.match(/(?:^|\r?\n)DTSTART(?:;[^:\r\n]*)?:([^\r\n]+)/i);
      const locMatch = block.match(/(?:^|\r?\n)LOCATION(?:;[^:\r\n]*)?:([^\r\n]+)/i);

      const title = summaryMatch ? unescapeIcsText(summaryMatch[1]) : fileName;
      const dtInfo = dtMatch
        ? formatPreviewDateTime(dtMatch[1])
        : { label: '', sortKey: Number.MAX_SAFE_INTEGER };
      const location = locMatch ? unescapeIcsText(locMatch[1]) : '';
      events.push({
        title,
        dateTimeLabel: dtInfo.label,
        location,
        fileName,
        sortKey: dtInfo.sortKey
      });
    }
    return events;
  }

  async function parseEventsPreviewFromFiles(files) {
    const allEvents = [];
    for (const file of files) {
      try {
        const text = await file.text();
        allEvents.push(...parseEventsPreviewFromText(text, file.name));
      } catch {
        // ignore read error for preview
      }
    }
    allEvents.sort((a, b) => a.sortKey - b.sortKey);
    return {
      totalFiles: files.length,
      totalEvents: allEvents.length,
      events: allEvents
    };
  }

  function closePickCalendarModal() {
    const existing = document.getElementById('gcal-pick-modal-backdrop');
    if (existing) existing.remove();
  }

  async function stagePickImportToSettingsPage(file) {
    try {
      const fileBase64 = await fileToBase64(file);
      const res = await chrome.runtime.sendMessage({
        type: 'STAGE_PICK_IMPORT',
        fileName: file.name,
        fileType: file.type,
        fileBase64,
        returnUrl: location.href
      });
      if (!res?.ok) {
        throw new Error(res?.error || 'Failed to stage import');
      }
      window.location.href = `${getExportUrl()}#gcal-ext-job=${encodeURIComponent(res.jobId)}`;
    } catch (err) {
      showToast(t('toastStageFailed', [err.message || String(err)]), { variant: 'error' });
    }
  }

  async function openPickCalendarModal(files) {
    closePickCalendarModal();
    const CUSTOM_VALUE = '__custom__';

    const [preview, calendars] = await Promise.all([
      parseEventsPreviewFromFiles(files),
      getAvailableCalendars()
    ]);

    const backdrop = document.createElement('div');
    backdrop.id = 'gcal-pick-modal-backdrop';
    const isDark = isGoogleCalendarDarkTheme();
    backdrop.classList.toggle('gcal-theme-dark', isDark);
    backdrop.classList.toggle('gcal-theme-light', !isDark);

    const metaText =
      files.length === 1
        ? t('modalMetaSingle', [files[0].name, String(preview.totalEvents)], `${files[0].name} · ${preview.totalEvents} events`)
        : t(
            'modalMetaMulti',
            [String(files.length), String(preview.totalEvents)],
            `${files.length} files · ${preview.totalEvents} events`
          );

    const modal = document.createElement('div');
    modal.className = 'gcal-pick-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    modal.innerHTML = `
      <div class="gcal-pick-modal-header">
        <div class="gcal-pick-modal-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M11 16V7.85l-2.6 2.6L7 9l5-5 5 5-1.4 1.45-2.6-2.6V16h-2Zm-5 4q-.825 0-1.412-.587T4 18v-3h2v3h12v-3h2v3q0 .825-.587 1.413T18 20H6Z"/>
          </svg>
        </div>
        <div class="gcal-pick-modal-headtext">
          <h3 class="gcal-pick-modal-title"></h3>
          <p class="gcal-pick-modal-meta"></p>
        </div>
        <button type="button" class="gcal-pick-modal-close">&times;</button>
      </div>
      <div class="gcal-pick-modal-body">
        <div class="gcal-pick-preview-list"></div>
        <div class="gcal-pick-field">
          <label class="gcal-pick-label" for="gcal-pick-cal-select"></label>
          <select id="gcal-pick-cal-select" class="gcal-pick-select"></select>
          <input id="gcal-pick-cal-custom" type="text" class="gcal-pick-custom-input gcal-hidden" autocomplete="off" />
        </div>
      </div>
      <div class="gcal-pick-modal-footer">
        <button type="button" class="gcal-pick-link-btn"></button>
        <div class="gcal-pick-footer-actions">
          <button type="button" class="gcal-pick-btn-cancel"></button>
          <button type="button" class="gcal-pick-btn-confirm"></button>
        </div>
      </div>
    `;

    modal.querySelector('.gcal-pick-modal-title').textContent = t(
      'modalPickTitle',
      null,
      'Import to Google Calendar'
    );
    modal.querySelector('.gcal-pick-modal-meta').textContent = metaText;
    modal.querySelector('.gcal-pick-modal-close').setAttribute('aria-label', t('toastCloseLabel', null, 'Close'));
    modal.querySelector('.gcal-pick-label').textContent = t('modalSelectCalendarLabel', null, 'Add to calendar');
    modal.querySelector('.gcal-pick-link-btn').textContent = t('modalOpenNativePage', null, 'Native Import page');
    modal.querySelector('.gcal-pick-btn-cancel').textContent = t('modalBtnCancel', null, 'Cancel');
    modal.querySelector('.gcal-pick-btn-confirm').textContent =
      files.length > 1
        ? t('modalBtnImportMulti', [String(files.length)], `Import (${files.length})`)
        : t('toolbarImportLabel', null, 'Import');

    const previewList = modal.querySelector('.gcal-pick-preview-list');
    const maxPreview = 6;
    if (preview.events.length > 0) {
      for (const ev of preview.events.slice(0, maxPreview)) {
        const item = document.createElement('div');
        item.className = 'gcal-pick-preview-item';
        const titleEl = document.createElement('p');
        titleEl.className = 'gcal-pick-preview-title';
        titleEl.textContent = ev.title;
        const timeEl = document.createElement('p');
        timeEl.className = 'gcal-pick-preview-time';
        timeEl.textContent = [ev.dateTimeLabel, ev.location].filter(Boolean).join(' · ');
        item.appendChild(titleEl);
        if (timeEl.textContent) item.appendChild(timeEl);
        previewList.appendChild(item);
      }
      if (preview.events.length > maxPreview) {
        const more = document.createElement('div');
        more.className = 'gcal-pick-preview-more';
        more.textContent = t(
          'modalMoreEvents',
          [String(preview.events.length - maxPreview)],
          `+${preview.events.length - maxPreview} more events`
        );
        previewList.appendChild(more);
      }
    } else {
      for (const f of files.slice(0, maxPreview)) {
        const item = document.createElement('div');
        item.className = 'gcal-pick-preview-item';
        const titleEl = document.createElement('p');
        titleEl.className = 'gcal-pick-preview-title';
        titleEl.textContent = f.name;
        item.appendChild(titleEl);
        previewList.appendChild(item);
      }
    }

    const selectEl = modal.querySelector('#gcal-pick-cal-select');
    const customInput = modal.querySelector('#gcal-pick-cal-custom');
    customInput.placeholder = t('placeholderDefaultCalendar', null, 'Calendar name');

    const defOpt = document.createElement('option');
    defOpt.value = '';
    defOpt.textContent = t('defaultCalendarFallback', null, 'Google default calendar');
    selectEl.appendChild(defOpt);

    for (const calName of calendars) {
      const opt = document.createElement('option');
      opt.value = calName;
      opt.textContent = calName;
      selectEl.appendChild(opt);
    }

    const customOpt = document.createElement('option');
    customOpt.value = CUSTOM_VALUE;
    customOpt.textContent = t('optionCustomCalendar', null, 'Custom calendar name...');
    selectEl.appendChild(customOpt);

    const preferred = settings.defaultCalendarName;
    if (preferred && calendars.includes(preferred)) {
      selectEl.value = preferred;
    } else if (preferred) {
      selectEl.value = CUSTOM_VALUE;
      customInput.value = preferred;
      customInput.classList.remove('gcal-hidden');
    } else {
      selectEl.value = '';
    }

    selectEl.addEventListener('change', () => {
      const isCustom = selectEl.value === CUSTOM_VALUE;
      customInput.classList.toggle('gcal-hidden', !isCustom);
      if (isCustom) customInput.focus();
    });

    const cleanupAndClose = () => {
      document.removeEventListener('keydown', onModalKeyDown, true);
      closePickCalendarModal();
    };

    const confirmImport = () => {
      const chosenCal =
        selectEl.value === CUSTOM_VALUE ? customInput.value.trim() : selectEl.value.trim();
      cleanupAndClose();
      runQuickImportQueue(files, chosenCal);
    };

    const onModalKeyDown = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        cleanupAndClose();
      } else if (e.key === 'Enter' && e.target !== modal.querySelector('.gcal-pick-btn-cancel')) {
        e.preventDefault();
        e.stopPropagation();
        confirmImport();
      }
    };

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) cleanupAndClose();
    });
    modal.querySelector('.gcal-pick-modal-close').addEventListener('click', cleanupAndClose);
    modal.querySelector('.gcal-pick-btn-cancel').addEventListener('click', cleanupAndClose);
    modal.querySelector('.gcal-pick-btn-confirm').addEventListener('click', confirmImport);
    modal.querySelector('.gcal-pick-link-btn').addEventListener('click', () => {
      cleanupAndClose();
      if (files.length > 1) {
        showToast(t('toastPickSingleNotice', [files[0].name]), {
          variant: 'info',
          duration: 3000
        });
      }
      stagePickImportToSettingsPage(files[0]);
    });

    backdrop.appendChild(modal);
    document.body.appendChild(backdrop);
    document.addEventListener('keydown', onModalKeyDown, true);
    selectEl.focus();
  }

  // ---------------------------------------------------------------------------
  // 2D. Feature 4: Multi-File Native File Picker & Alt+I Shortcut
  // ---------------------------------------------------------------------------
  function openMultiFilePicker() {
    if (!chrome?.runtime?.id || typeof chrome.runtime.sendMessage !== 'function') {
      showToast(
        t(
          'toastExtensionReloaded',
          null,
          'Extension was reloaded. Please refresh Google Calendar before importing.'
        ),
        {
          variant: 'error',
          duration: 8000,
          actionLabel: t('btnRefreshNow', null, 'Refresh'),
          onAction: () => window.location.reload()
        }
      );
      return;
    }

    if (!hiddenMultiFileInput) {
      hiddenMultiFileInput = document.createElement('input');
      hiddenMultiFileInput.type = 'file';
      hiddenMultiFileInput.multiple = true;
      hiddenMultiFileInput.accept = '.ics,.ical,.ifb,.icalendar,.csv';
      hiddenMultiFileInput.style.display = 'none';
      document.body.appendChild(hiddenMultiFileInput);

      hiddenMultiFileInput.addEventListener('change', () => {
        const picked = Array.from(hiddenMultiFileInput.files || []);
        hiddenMultiFileInput.value = '';
        if (picked.length === 0) return;

        if (isExportPage() && picked.length === 1) {
          handleDroppedFiles(picked, 'direct');
        } else {
          handleDroppedFiles(picked, 'picker');
        }
      });
    }

    hiddenMultiFileInput.value = '';
    hiddenMultiFileInput.click();
  }

  function isEditableTarget(el) {
    if (!el || !(el instanceof Element)) return false;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return el.isContentEditable;
  }

  window.addEventListener(
    'keydown',
    (e) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key.toLowerCase() === 'i') {
        if (isEditableTarget(e.target)) return;
        e.preventDefault();
        openMultiFilePicker();
      }
    },
    true
  );

  async function handleDroppedFiles(fileList, zone) {
    const allFiles = Array.from(fileList || []);
    const validFiles = allFiles.filter((f) => SUPPORTED_EXT_RE.test(f.name));

    if (validFiles.length === 0) {
      showToast(t('toastUnsupportedFile', null, 'Only .ics or .csv calendar files are supported.'), {
        variant: 'error'
      });
      return;
    }

    const validSizedFiles = validFiles.filter((f) => f.size <= MAX_FILE_BYTES);
    const oversizedFiles = validFiles.filter((f) => f.size > MAX_FILE_BYTES);
    if (validSizedFiles.length === 0) {
      showToast(t('toastFileTooLarge', [oversizedFiles[0].name]), {
        variant: 'error'
      });
      return;
    }

    const skippedCount = allFiles.length - validSizedFiles.length;
    if (skippedCount > 0) {
      showToast(
        t(
          'toastSkippedInvalidFiles',
          [String(skippedCount)],
          `Skipped ${skippedCount} unsupported or oversized file(s).`
        ),
        { variant: 'info', duration: 3500 }
      );
    }

    if (!chrome?.runtime?.id || typeof chrome.runtime.sendMessage !== 'function') {
      showToast(
        t(
          'toastExtensionReloaded',
          null,
          'Extension was reloaded. Please refresh Google Calendar before dropping files.'
        ),
        {
          variant: 'error',
          duration: 8000,
          actionLabel: t('btnRefreshNow', null, 'Refresh'),
          onAction: () => window.location.reload()
        }
      );
      return;
    }

    if (zone === 'direct') {
      const file = validSizedFiles[0];
      const fileBase64 = await fileToBase64(file);
      const attachRes = await attachFileAndVerify(fileBase64, file.name, file.type);
      if (attachRes.accepted) {
        showToast(t('toastDirectFilled', [file.name]), {
          variant: 'success'
        });
      } else if (attachRes.found) {
        showToast(t('toastDirectNotRecognized', [file.name]), {
          variant: 'error',
          duration: 7000
        });
      } else {
        showToast(t('toastInputNotFoundRefresh'), { variant: 'error' });
      }
      return;
    }

    if (zone === 'picker') {
      await openPickCalendarModal(validSizedFiles);
      return;
    }

    if (zone === 'pick') {
      // Feature 2: Default to in-page preview & calendar picker modal (also always used for multi-file)
      if (settings.pickInPageModal || validSizedFiles.length > 1) {
        await openPickCalendarModal(validSizedFiles);
        return;
      }
      await stagePickImportToSettingsPage(validSizedFiles[0]);
      return;
    }

    // zone === 'quick': background auto-import without leaving the main page
    await runQuickImportQueue(validSizedFiles);
  }

  async function runQuickImportQueue(files, overrideCalendarName = undefined) {
    const total = files.length;
    const toast = showToast(
      total > 1
        ? t('toastQuickProgressMulti', ['1', String(total), files[0].name])
        : t('toastQuickProgressSingle', [files[0].name]),
      { variant: 'loading', duration: 0 }
    );

    const successes = [];
    const failures = [];
    const importedDates = [];
    let lastErrorBgTabId = null;

    for (let i = 0; i < total; i++) {
      const file = files[i];
      if (total > 1) {
        toast.update(t('toastQuickProgressMulti', [String(i + 1), String(total), file.name]), {
          variant: 'loading',
          duration: 0
        });
      }

      try {
        const [fileBase64, parsedDate] = await Promise.all([
          fileToBase64(file),
          extractEarliestEventDateFromFile(file)
        ]);
        const payload = {
          type: 'START_QUICK_IMPORT',
          fileName: file.name,
          fileType: file.type,
          fileBase64,
          exportUrl: getExportUrl()
        };
        if (typeof overrideCalendarName === 'string') {
          payload.overrideCalendarName = overrideCalendarName;
        }
        const startRes = await chrome.runtime.sendMessage(payload);

        if (!startRes?.ok) {
          throw new Error(startRes?.error || t('errStartQuickImportFailed'));
        }

        const result = await waitForQuickImportDone(file.name, 30000);
        if (result.ok) {
          successes.push(result);
          if (parsedDate) importedDates.push(parsedDate);
        } else {
          failures.push(result);
          if (result.bgTabId != null) {
            lastErrorBgTabId = result.bgTabId;
          }
        }
      } catch (err) {
        failures.push({
          ok: false,
          fileName: file.name,
          statusText: err.message || String(err)
        });
      }
    }

    if (failures.length === 0) {
      const first = successes[0];
      const calInfo = first.calendarName ? t('calParenFormat', [first.calendarName]) : '';
      const msg =
        total === 1
          ? t('toastQuickSuccessSingle', [calInfo, first.statusText || first.fileName])
          : t('toastQuickSuccessMulti', [String(successes.length), String(total), calInfo]);

      let targetDate = null;
      if (importedDates.length > 0) {
        importedDates.sort((a, b) => a.sortKey - b.sortKey);
        targetDate = importedDates[0];
      }

      if (targetDate) {
        const ymd = formatDateYmd(targetDate);
        const targetUrl = buildDateViewUrl(targetDate.year, targetDate.month, targetDate.day);

        if (settings.autoJumpToDate && targetUrl !== location.href) {
          savePostNavToast({
            text: t('toastQuickJumped', [msg, ymd]),
            variant: 'success',
            returnUrl: location.href
          });
          toast.update(t('toastQuickJumping', [msg, ymd]), { variant: 'success', duration: 3000 });
          window.location.href = targetUrl;
          return;
        }

        toast.update(msg, {
          variant: 'success',
          duration: 6500,
          actionLabel: targetUrl !== location.href ? t('btnJumpToDate', [ymd]) : null,
          onAction:
            targetUrl !== location.href
              ? () => {
                  window.location.href = targetUrl;
                }
              : null
        });
        return;
      }

      toast.update(msg, { variant: 'success', duration: 6000 });
    } else {
      const firstFail = failures[0];
      const detail = firstFail.statusText || firstFail.fileName;
      const errMsg =
        successes.length > 0
          ? t('toastQuickPartialFail', [String(successes.length), String(failures.length), detail])
          : t('toastQuickFailed', [detail]);
      toast.update(errMsg, {
        variant: 'error',
        duration: 10000,
        actionLabel: lastErrorBgTabId != null ? t('btnViewImportTab') : t('btnOpenImportPage'),
        onAction: () => {
          if (lastErrorBgTabId != null) {
            chrome.runtime.sendMessage({ type: 'FOCUS_TAB', tabId: lastErrorBgTabId });
          } else {
            window.location.href = getExportUrl();
          }
        }
      });
    }
  }

  function waitForQuickImportDone(fileName, timeoutMs = 30000) {
    return new Promise((resolve) => {
      let settled = false;
      const entry = {
        fileName,
        resolve: (data) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(data);
        }
      };

      activeQuickImportResolvers.push(entry);

      const timer = setTimeout(() => {
        const idx = activeQuickImportResolvers.indexOf(entry);
        if (idx >= 0) activeQuickImportResolvers.splice(idx, 1);
        entry.resolve({
          ok: false,
          fileName,
          statusText: t('toastQuickTimeout')
        });
      }, timeoutMs);
    });
  }

  // Receive messages from background.js (quick import results, calendar list query, file picker shortcut)
  if (chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message) return false;

      if (message.type === 'REQUEST_CALENDARS_NOW') {
        const calendars = scrapeSidebarCalendars();
        if (calendars.length > 0) {
          syncSidebarCalendars();
        }
        sendResponse({
          ok: true,
          calendars,
          accountPrefix: getAccountPrefix()
        });
        return false;
      }

      if (message.type === 'OPEN_FILE_PICKER') {
        openMultiFilePicker();
        return false;
      }

      if (message.type === 'QUICK_IMPORT_DONE') {
        const idx = activeQuickImportResolvers.findIndex((r) => r.fileName === message.fileName);
        const resolver =
          idx >= 0 ? activeQuickImportResolvers.splice(idx, 1)[0] : activeQuickImportResolvers.shift();
        if (resolver) {
          resolver.resolve(message);
        } else if (message.fromContextMenu) {
          const calInfo = message.calendarName ? t('calParenFormat', [message.calendarName]) : '';
          if (message.ok) {
            showToast(
              t('toastQuickSuccessSingle', [calInfo, message.statusText || message.fileName]),
              { variant: 'success', duration: 6000 }
            );
          } else {
            showToast(t('toastQuickFailed', [message.statusText || message.fileName]), {
              variant: 'error',
              duration: 9000,
              actionLabel: message.bgTabId != null ? t('btnViewImportTab') : null,
              onAction:
                message.bgTabId != null
                  ? () => chrome.runtime.sendMessage({ type: 'FOCUS_TAB', tabId: message.bgTabId })
                  : null
            });
          }
        }
      }
    });
  }

  // Global drag-and-drop listeners (capturing phase so Google Calendar doesn't swallow events)
  window.addEventListener(
    'dragenter',
    (e) => {
      if (!settings.enableDragDrop || !isFileDragEvent(e)) return;
      e.preventDefault();
      showDndOverlay(e);
    },
    true
  );

  window.addEventListener(
    'dragover',
    (e) => {
      if (!settings.enableDragDrop || !isFileDragEvent(e)) return;
      e.preventDefault();
      if (e.dataTransfer) {
        e.dataTransfer.dropEffect = 'copy';
      }
      showDndOverlay(e);
    },
    true
  );

  window.addEventListener(
    'dragleave',
    (e) => {
      if (!overlayVisible) return;
      // Hide only when leaving the browser viewport completely
      const leavingViewport =
        e.relatedTarget === null &&
        (e.clientX <= 0 ||
          e.clientY <= 0 ||
          e.clientX >= window.innerWidth ||
          e.clientY >= window.innerHeight);
      if (leavingViewport) {
        hideDndOverlay();
      }
    },
    true
  );

  window.addEventListener(
    'drop',
    (e) => {
      if (!overlayVisible) return;
      if (!isFileDragEvent(e)) {
        hideDndOverlay();
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      const zone = resolveZoneFromEvent(e);
      const files = e.dataTransfer?.files;
      hideDndOverlay();
      handleDroppedFiles(files, zone);
    },
    true
  );

  window.addEventListener('dragend', () => hideDndOverlay(), true);
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlayVisible) {
      hideDndOverlay();
    }
  });

  // ---------------------------------------------------------------------------
  // 3. Automation on /settings/export Page (Pick Mode & Quick Mode)
  // ---------------------------------------------------------------------------
  function extractJobIdFromHash() {
    const match = location.hash.match(/gcal-ext-job=([^&]+)/);
    if (!match) return null;
    const jobId = decodeURIComponent(match[1]);
    // Remove our synthetic hash cleanly
    try {
      history.replaceState(null, '', location.pathname + location.search);
    } catch {
      // ignore
    }
    return jobId;
  }

  function collectFileInputsDeep(root = document, acc = []) {
    if (!root || !root.querySelectorAll) return acc;
    for (const el of root.querySelectorAll('input[type="file"]')) {
      acc.push(el);
    }
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) {
        collectFileInputsDeep(el.shadowRoot, acc);
      }
    }
    return acc;
  }

  function scoreFileInput(input) {
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

  function findFileInput() {
    const inputs = collectFileInputsDeep(document);
    if (inputs.length === 0) return null;
    return inputs
      .map((el) => ({ el, score: scoreFileInput(el) }))
      .sort((a, b) => b.score - a.score)[0].el;
  }

  function attachFileToInput(fileInput, file) {
    const dt = new DataTransfer();
    dt.items.add(file);
    const nativeSetter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'files'
    )?.set;
    if (nativeSetter) {
      nativeSetter.call(fileInput, dt.files);
    } else {
      fileInput.files = dt.files;
    }
    fileInput.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    fileInput.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
  }

  function isImportFileAccepted(sectionRoot, fileName) {
    const root = sectionRoot || document.querySelector('[role="main"]') || document.body;
    const importBtn = findImportButtonInContainer(root) || findImportButtonInContainer(document);
    if (importBtn && isButtonEnabled(importBtn)) {
      return true;
    }
    if (fileName) {
      const visibleText = (root.innerText || '').toLowerCase();
      if (visibleText.includes(fileName.toLowerCase())) {
        return true;
      }
    }
    return false;
  }

  async function attachFileViaMainWorld(fileBase64, fileName, fileType) {
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'ATTACH_FILE_MAIN_WORLD',
        fileBase64,
        fileName,
        fileType
      });
      return res || { ok: false, result: null };
    } catch (err) {
      console.warn('[GCal Quick Import] MAIN world attach failed, falling back:', err);
      return { ok: false, result: null };
    }
  }

  async function attachFileAndVerify(fileBase64, fileName, fileType, maxWaitMs = 9000) {
    const file = base64ToFile(fileBase64, fileName, fileType);
    const deadline = Date.now() + maxWaitMs;
    let everFound = false;
    let lastDiagnostics = null;

    while (Date.now() < deadline) {
      const fileInput = findFileInput();
      const sectionRoot = findImportSectionRoot(fileInput);

      // Try MAIN world injection first (handles Shadow DOM, iframes, and realm checks)
      const mainRes = await attachFileViaMainWorld(fileBase64, fileName, fileType);
      if (mainRes?.ok) {
        everFound = true;
        lastDiagnostics = mainRes.result;
      } else if (fileInput) {
        everFound = true;
        attachFileToInput(fileInput, file);
      }

      // Give Google Calendar's Wiz controller a moment to update UI & enable Import
      await sleep(350);

      const refreshedInput = findFileInput();
      const refreshedSection = findImportSectionRoot(refreshedInput);
      if (isImportFileAccepted(refreshedSection, fileName)) {
        console.info('[GCal Quick Import] File accepted by Google Calendar:', fileName, lastDiagnostics);
        return {
          found: true,
          accepted: true,
          fileInput: refreshedInput,
          sectionRoot: refreshedSection,
          diagnostics: lastDiagnostics
        };
      }

      // Wait slightly before retrying in case Google Calendar was still hydrating
      await sleep(250);
    }

    const finalInput = findFileInput();
    const finalSection = findImportSectionRoot(finalInput);
    console.warn('[GCal Quick Import] File attach did not trigger UI update:', {
      fileName,
      everFound,
      lastDiagnostics
    });
    return {
      found: everFound || Boolean(finalInput),
      accepted: isImportFileAccepted(finalSection, fileName),
      fileInput: finalInput,
      sectionRoot: finalSection,
      diagnostics: lastDiagnostics
    };
  }

  function findImportSectionRoot(fileInput) {
    if (!fileInput) return document.querySelector('[role="main"]') || document.body;
    let node = fileInput.parentElement;
    while (node && node !== document.body) {
      const hasImportBtn = findImportButtonInContainer(node);
      if (hasImportBtn) return node;
      node = node.parentElement;
    }
    return document.querySelector('[role="main"]') || document.body;
  }

  function findImportButtonInContainer(container) {
    const root = container || document;
    const buttons = Array.from(root.querySelectorAll('button, [role="button"]'));
    const importExactRe =
      /^(import|导入|匯入|importar|インポート|importieren|importer|가져오기|импортировать|импорт|importa)$/i;
    const exportRe =
      /(export|导出|匯出|exportar|エクスポート|exportieren|exporter|내보내기|экспорт|esporta)/i;
    return (
      buttons.find((btn) => {
        if (!isVisible(btn)) return false;
        const text = (btn.innerText || btn.textContent || '').trim();
        const aria = (btn.getAttribute('aria-label') || '').trim();
        const isImportText = importExactRe.test(text) || importExactRe.test(aria);
        const isExportText = exportRe.test(text) || exportRe.test(aria);
        return isImportText && !isExportText;
      }) || null
    );
  }

  function isButtonEnabled(btn) {
    if (!btn) return false;
    if (btn.disabled) return false;
    if (btn.getAttribute('aria-disabled') === 'true') return false;
    const style = window.getComputedStyle(btn);
    if (style.pointerEvents === 'none') return false;
    return true;
  }

  function findCalendarDropdown(sectionRoot) {
    const root = sectionRoot || document.querySelector('[role="main"]') || document;
    // Check native <select> first
    const nativeSelect = root.querySelector('select');
    if (nativeSelect && isVisible(nativeSelect)) {
      return { kind: 'select', el: nativeSelect };
    }

    // Google Material custom select (combobox / listbox)
    const customSelectors = [
      '[role="combobox"]',
      '[aria-haspopup="listbox"]',
      '[role="listbox"]'
    ];
    for (const sel of customSelectors) {
      const found = Array.from(root.querySelectorAll(sel)).find(isVisible);
      if (found) {
        return { kind: 'custom', el: found };
      }
    }

    // Fallback: look for element labelled "Add to calendar" in supported locales
    const labelled = Array.from(root.querySelectorAll('div, button')).find((el) => {
      if (!isVisible(el)) return false;
      const aria = (el.getAttribute('aria-label') || '').trim();
      return /(add to calendar|添加到日历|新增至日曆|añadir al calendario|agregar al calendario|adicionar à agenda|カレンダーに追加|zum kalender hinzufügen|ajouter à l'agenda|캘린더에 추가|добавить в календарь|aggiungi al calendario)/i.test(
        aria
      );
    });
    if (labelled) {
      return { kind: 'custom', el: labelled };
    }

    return null;
  }

  function readSelectedCalendarName(dropdown) {
    if (!dropdown || !dropdown.el) return '';
    if (dropdown.kind === 'select') {
      const opt = dropdown.el.options[dropdown.el.selectedIndex];
      return opt ? opt.textContent.trim() : '';
    }
    const selectedOpt = dropdown.el.querySelector('[aria-selected="true"]');
    if (selectedOpt) return selectedOpt.textContent.trim();
    return (dropdown.el.innerText || dropdown.el.textContent || '').trim().split('\n')[0] || '';
  }

  async function selectCalendarByName(sectionRoot, targetName) {
    const dropdown = findCalendarDropdown(sectionRoot);
    if (!dropdown) {
      return { ok: false, error: t('errDropdownNotFound') };
    }

    const normalizedTarget = targetName.trim().toLowerCase();

    if (dropdown.kind === 'select') {
      const options = Array.from(dropdown.el.options);
      const match =
        options.find((o) => o.textContent.trim().toLowerCase() === normalizedTarget) ||
        options.find((o) => o.textContent.trim().toLowerCase().includes(normalizedTarget));
      if (!match) {
        return { ok: false, error: t('errCalendarNotFound', [targetName]) };
      }
      dropdown.el.value = match.value;
      dropdown.el.dispatchEvent(new Event('input', { bubbles: true }));
      dropdown.el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, selectedName: match.textContent.trim() };
    }

    // Material custom listbox / combobox
    const current = readSelectedCalendarName(dropdown);
    if (current.toLowerCase() === normalizedTarget) {
      return { ok: true, selectedName: current };
    }

    simulateUserClick(dropdown.el);

    const options = await waitForCondition(
      () => {
        const visibleOpts = Array.from(document.querySelectorAll('[role="option"]')).filter(isVisible);
        return visibleOpts.length > 0 ? visibleOpts : null;
      },
      4000,
      100
    );

    if (!options) {
      return { ok: false, error: t('errDropdownExpandFailed') };
    }

    // Cache authoritative export dropdown calendars
    const optionNames = options
      .map((o) => (o.innerText || o.textContent || '').trim())
      .filter(Boolean);
    if (optionNames.length > 0 && chrome?.runtime?.id) {
      chrome.runtime
        .sendMessage({
          type: 'SAVE_CALENDAR_LIST',
          accountPrefix: getAccountPrefix(),
          calendars: optionNames,
          source: 'export'
        })
        .catch(() => {});
    }

    const match =
      options.find((o) => (o.innerText || o.textContent || '').trim().toLowerCase() === normalizedTarget) ||
      options.find((o) => (o.innerText || o.textContent || '').trim().toLowerCase().includes(normalizedTarget));

    if (!match) {
      // Close dropdown via Escape
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return { ok: false, error: t('errCalendarNotFound', [targetName]) };
    }

    const chosenName = (match.innerText || match.textContent || '').trim();
    simulateUserClick(match);
    await sleep(300);
    return { ok: true, selectedName: chosenName };
  }

  function collectVisibleStatusTexts() {
    const selectors = [
      '[role="alertdialog"]',
      '[role="dialog"]',
      '[role="alert"]',
      '[role="status"]',
      '[aria-live="assertive"]',
      '[aria-live="polite"]'
    ];
    const texts = new Set();
    for (const el of document.querySelectorAll(selectors.join(','))) {
      if (!isVisible(el)) continue;
      if (el.closest('#gcal-ext-toast-container')) continue;
      const cleaned = cleanDialogText(el);
      if (cleaned) texts.add(cleaned);
    }
    return texts;
  }

  function cleanDialogText(el) {
    if (!el) return '';
    const clone = el.cloneNode(true);
    // Strip action button labels like "OK", "Close", "确定" from dialog text
    clone.querySelectorAll('button, [role="button"]').forEach((b) => b.remove());
    const parts = [];
    const walker = document.createTreeWalker(clone, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const t = node.nodeValue.replace(/\s+/g, ' ').trim();
      if (t) parts.push(t);
    }
    return parts.join(' ').trim();
  }

  function isMeaningfulImportResultText(text) {
    if (!text || text.length < 4) return false;
    return /(imported|events?|could not|unable|failed|error|out of|invalid|processed|已导入|已匯入|活动|活動|日程|无法|無法|失败|失敗|错误|錯誤|importad[oa]s?|eventos?|инпорт|импортирован|событ|ошибк|インポート|予定|イベント|失敗|エラー|importiert|termine?|fehler|importés?|événements?|erreur|가져왔|일정|오류|실패|importat[oi]|event[oi]|errore)/i.test(
      text
    );
  }

  function isErrorResultText(text) {
    return /(could not|unable|failed|error|invalid|0 out of|无法|無法|失败|失敗|错误|錯誤|出错|出錯|没有导入|沒有匯入|导入了 0|匯入了 0|no se pud|não foi poss|失敗|エラー|konnte nicht|fehler|impossible|erreur|실패|오류|не удалось|ошибк|impossibile|errore)/i.test(
      text
    );
  }

  async function executeExportPageJob(job) {
    if (job.mode === 'sync_calendars') {
      const dropdown = await waitForCondition(
        () => findCalendarDropdown(findImportSectionRoot(findFileInput())),
        10000,
        150
      );
      let calendars = [];
      if (dropdown) {
        const sectionRoot = findImportSectionRoot(findFileInput());
        calendars = await readExportDropdownOptionsActive(sectionRoot);
      }
      await chrome.runtime.sendMessage({
        type: 'SYNC_CALENDARS_RESULT',
        syncId: job.syncId,
        accountPrefix: getAccountPrefix(),
        calendars
      });
      return;
    }

    const reportQuickResult = (extra) =>
      chrome.runtime.sendMessage({
        type: 'QUICK_IMPORT_RESULT',
        sourceTabId: job.sourceTabId,
        originNotifyTabId: job.originNotifyTabId ?? null,
        fromContextMenu: Boolean(job.fromContextMenu),
        fileName: job.fileName,
        ...extra
      });

    const pickToast =
      job.mode === 'pick'
        ? showToast(t('toastFillingFile', [job.fileName]), { variant: 'loading', duration: 0 })
        : null;

    const attachRes = await attachFileAndVerify(
      job.fileBase64,
      job.fileName,
      job.fileType,
      10000
    );

    if (!attachRes.found) {
      if (job.mode === 'quick') {
        await reportQuickResult({
          ok: false,
          statusText: t('errInputNotFound'),
          keepTabOpen: true
        });
      } else if (pickToast) {
        pickToast.update(t('toastInputNotFoundManual'), {
          variant: 'error',
          duration: 7000
        });
      }
      return;
    }

    const sectionRoot = attachRes.sectionRoot || findImportSectionRoot(attachRes.fileInput);
    syncExportDropdownCalendars(sectionRoot);

    // Pick Mode: stop on /settings/export so user can pick calendar & click Import
    if (job.mode === 'pick') {
      if (!attachRes.accepted) {
        if (pickToast) {
          pickToast.update(t('toastPickNotRecognized', [job.fileName]), {
            variant: 'error',
            duration: 10000,
            actionLabel: job.returnUrl ? t('btnBackToCalendar') : null,
            onAction: job.returnUrl
              ? () => {
                  window.location.href = job.returnUrl;
                }
              : null
          });
        }
        return;
      }

      const dropdown = findCalendarDropdown(sectionRoot);
      if (dropdown?.el) {
        dropdown.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        dropdown.el.classList.add('gcal-ext-highlight-pulse');
        setTimeout(() => dropdown.el.classList.remove('gcal-ext-highlight-pulse'), 4000);
      }

      if (pickToast) {
        pickToast.update(t('toastPickSuccess', [job.fileName]), {
          variant: 'success',
          duration: 8000,
          actionLabel: job.returnUrl ? t('btnBackToCalendar') : null,
          onAction: job.returnUrl
            ? () => {
                window.location.href = job.returnUrl;
              }
            : null
        });
      }
      return;
    }

    if (!attachRes.accepted) {
      await reportQuickResult({
        ok: false,
        statusText: t('errQuickNotRecognized', [job.fileName]),
        keepTabOpen: true
      });
      return;
    }

    // Quick Mode: select default calendar (if configured), click Import, wait for result
    try {
      await sleep(250);

      let chosenCalendarName = '';
      if (job.defaultCalendarName) {
        const selectRes = await selectCalendarByName(sectionRoot, job.defaultCalendarName);
        if (!selectRes.ok) {
          await reportQuickResult({
            ok: false,
            statusText: selectRes.error,
            keepTabOpen: true
          });
          return;
        }
        chosenCalendarName = selectRes.selectedName || job.defaultCalendarName;
      } else {
        const dropdown = findCalendarDropdown(sectionRoot);
        chosenCalendarName = readSelectedCalendarName(dropdown);
      }

      const importBtn = await waitForCondition(
        () => {
          const btn = findImportButtonInContainer(sectionRoot) || findImportButtonInContainer(document);
          return btn && isButtonEnabled(btn) ? btn : null;
        },
        8000,
        150
      );

      if (!importBtn) {
        await reportQuickResult({
          ok: false,
          statusText: t('errImportBtnDisabled'),
          keepTabOpen: true
        });
        return;
      }

      const baselineTexts = collectVisibleStatusTexts();
      simulateUserClick(importBtn);

      const resultText = await waitForCondition(
        () => {
          const current = collectVisibleStatusTexts();
          for (const text of current) {
            if (!baselineTexts.has(text) && isMeaningfulImportResultText(text)) {
              return text;
            }
          }
          // Fallback: any newly appearing alertdialog / dialog with text
          for (const dlg of document.querySelectorAll('[role="alertdialog"], [role="dialog"]')) {
            if (!isVisible(dlg)) continue;
            const cleaned = cleanDialogText(dlg);
            if (cleaned && !baselineTexts.has(cleaned)) {
              return cleaned;
            }
          }
          return null;
        },
        20000,
        200
      );

      if (!resultText) {
        await reportQuickResult({
          ok: false,
          calendarName: chosenCalendarName,
          statusText: t('errResultNotCaptured'),
          keepTabOpen: true
        });
        return;
      }

      await sleep(350);
      const ok = !isErrorResultText(resultText);

      await reportQuickResult({
        ok,
        calendarName: chosenCalendarName,
        statusText: resultText,
        keepTabOpen: !ok
      });
    } catch (err) {
      await reportQuickResult({
        ok: false,
        statusText: t('errAutoImportException', [err?.message || String(err)]),
        keepTabOpen: true
      });
    }
  }

  async function checkAndRunPendingExportJob() {
    if (!isExportPage()) return;
    if (exportJobCheckedForUrl === location.pathname + location.search) return;
    exportJobCheckedForUrl = location.pathname + location.search;

    const hashJobId = extractJobIdFromHash();
    try {
      let res = await chrome.runtime.sendMessage({
        type: 'CONSUME_JOB_FOR_TAB',
        jobIdHint: hashJobId
      });

      // Retry once briefly in case tabs.create tabId mapping was still being saved
      if (!res?.job) {
        await sleep(300);
        res = await chrome.runtime.sendMessage({
          type: 'CONSUME_JOB_FOR_TAB',
          jobIdHint: hashJobId
        });
      }

      if (res?.job) {
        await executeExportPageJob(res.job);
      }
    } catch (err) {
      console.warn('[GCal Quick Import] Failed to check pending job:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // 4. SPA Lifecycle & Initialization
  // ---------------------------------------------------------------------------
  function onRouteOrDomUpdate() {
    if (location.href !== lastKnownUrl) {
      lastKnownUrl = location.href;
      exportJobCheckedForUrl = null;
      hideDndOverlay();
      if (isExportPage()) {
        checkAndRunPendingExportJob();
      }
    }
    ensureToolbarButton();
    if (isExportPage()) {
      syncExportDropdownCalendars();
    } else {
      syncSidebarCalendars();
    }
  }

  async function init() {
    await loadSettings();
    ensureToolbarButton();
    consumePostNavToast();

    if (isExportPage()) {
      syncExportDropdownCalendars();
      checkAndRunPendingExportJob();
    } else {
      syncSidebarCalendars();
    }

    const observer = new MutationObserver(() => {
      onRouteOrDomUpdate();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    window.addEventListener('popstate', onRouteOrDomUpdate);
    setInterval(onRouteOrDomUpdate, 1000);
  }

  init();
})();
