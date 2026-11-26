/**
 * Split Workbench Frontend Application
 *
 * Features:
 * - Smart BSP auto-splitting (wide => left/right, tall/square => top/bottom)
 * - Persistent flat-stage DOM mounting (splitting/swapping never reloads iframes or resets PTYs)
 * - 4 built-in pane types: File (highlight + Markdown + Image + optional Edit + live auto-reload),
 *   Web Preview (localhost port auto-discovery + URL bar), Terminal (real Python PTY + xterm.js),
 *   and Session Artifacts (auto-linked to window.sidecar.conversationId)
 * - Live Chat Links watcher extracting file:// and http(s):// links from current conversation
 * - Drag gutter to resize, double-click gutter for 50/50, drag pane header to swap panes
 * - Select text in File/Artifact -> send comment directly to Antigravity conversation
 */
(() => {
  const L = window.SplitLayout;
  const I18N = window.SWI18n || { lang: 'en', t: (k) => k, colorName: (id) => id, applyDom() {} };
  const t = I18N.t;
  const $ = (id) => document.getElementById(id);

  const stageEl = $('stage');
  const dragShieldEl = $('drag-shield');
  const fileModalEl = $('file-modal');
  const fileSearchInput = $('file-search-input');
  const fileBreadcrumbEl = $('file-breadcrumb');
  const fileWsSwitcherEl = $('file-ws-switcher');
  const fileListEl = $('file-list');
  const fileReplaceCheckbox = $('file-replace-mode');
  const chatLinksBtn = $('btn-chat-links');
  const chatLinksBadge = $('chat-links-badge');
  const chatLinksPopover = $('chat-links-popover');
  const chatLinksBody = $('chat-links-body');
  const autoOpenChatCheckbox = $('auto-open-chat-links');
  const colorPopoverEl = $('color-popover');
  const colorSwatchesEl = $('color-swatches');
  const colorCustomInputEl = $('color-custom-input');
  const quotePopoverEl = $('quote-popover');
  const quoteLocEl = $('quote-loc');
  const commentBarEl = $('comment-bar');
  const commentPreviewEl = $('comment-preview');
  const commentInputEl = $('comment-input');
  const toastEl = $('toast');

  // Harmonious 8-color palette for auto-distinguishing split panes (works on light & dark themes)
  const PANE_COLORS = [
    { id: 'blue',    name: I18N.colorName('blue'),    hex: '#3b82f6' },
    { id: 'emerald', name: I18N.colorName('emerald'), hex: '#10b981' },
    { id: 'amber',   name: I18N.colorName('amber'),   hex: '#f59e0b' },
    { id: 'violet',  name: I18N.colorName('violet'),  hex: '#8b5cf6' },
    { id: 'rose',    name: I18N.colorName('rose'),    hex: '#f43f5e' },
    { id: 'cyan',    name: I18N.colorName('cyan'),    hex: '#06b6d4' },
    { id: 'orange',  name: I18N.colorName('orange'),  hex: '#f97316' },
    { id: 'pink',    name: I18N.colorName('pink'),    hex: '#ec4899' },
  ];

  function pickNextDistinctColor(root, avoidHex = '') {
    const counts = new Map(PANE_COLORS.map((c) => [c.hex.toLowerCase(), 0]));
    for (const lf of L.listLeaves(root)) {
      const c = String(lf.state?.color || '').toLowerCase();
      if (counts.has(c)) counts.set(c, counts.get(c) + 1);
    }
    const avoid = String(avoidHex || '').toLowerCase();
    // 1. Prefer an unused color distinct from avoidHex
    for (const c of PANE_COLORS) {
      const k = c.hex.toLowerCase();
      if (counts.get(k) === 0 && k !== avoid) return c.hex;
    }
    // 2. Otherwise pick the least-used color distinct from avoidHex
    let best = PANE_COLORS[0].hex;
    let bestCount = Infinity;
    for (const c of PANE_COLORS) {
      const k = c.hex.toLowerCase();
      const cnt = counts.get(k) ?? 0;
      if (k !== avoid && cnt < bestCount) {
        bestCount = cnt;
        best = c.hex;
      }
    }
    return best;
  }

  const urlParams = new URLSearchParams(location.search);
  const urlToken = urlParams.get('token') || '';
  const convId = () => window.sidecar?.conversationId || urlParams.get('conversationId') || '';

  // -------------------------------------------------------------------------
  // Authenticated API helpers
  // -------------------------------------------------------------------------
  async function apiGet(path) {
    const res = await window.sidecar.fetch(path, { method: 'GET' });
    if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
    return res.json();
  }

  async function apiPost(path, body = {}) {
    const res = await window.sidecar.fetch(path, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.text()) || `HTTP ${res.status}`);
    return res.json();
  }

  function withTokenUrl(path) {
    if (!urlToken) return path;
    const sep = path.includes('?') ? '&' : '?';
    return `${path}${sep}token=${encodeURIComponent(urlToken)}`;
  }

  function uriToPath(uri) {
    if (!uri) return '';
    if (!uri.startsWith('file://')) return uri;
    try {
      return decodeURIComponent(new URL(uri).pathname);
    } catch {
      return decodeURIComponent(uri.replace(/^file:\/\//, ''));
    }
  }

  function basename(p) {
    if (!p) return '';
    const clean = p.replace(/\/+$/, '');
    const idx = clean.lastIndexOf('/');
    return idx >= 0 ? clean.slice(idx + 1) : clean;
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function splitHighlightedLines(html) {
    const rawLines = html.split('\n');
    const out = [];
    const openStack = [];
    const tagRe = /<(\/?)span([^>]*)>/g;
    for (const line of rawLines) {
      const prefix = openStack.join('');
      tagRe.lastIndex = 0;
      let m;
      while ((m = tagRe.exec(line)) !== null) {
        if (m[1] === '/') {
          openStack.pop();
        } else {
          openStack.push(`<span${m[2]}>`);
        }
      }
      const suffix = '</span>'.repeat(openStack.length);
      out.push(prefix + line + suffix);
    }
    return out;
  }

  let toastTimer = null;
  function showToast(msg, ms = 2200) {
    toastEl.textContent = msg;
    toastEl.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.add('hidden'), ms);
  }

  // -------------------------------------------------------------------------
  // Theme Sync (detect light/dark from host CSS variable --background)
  // -------------------------------------------------------------------------
  let isLightTheme = false;

  function parseCssColorLuminance(str) {
    if (!str) return null;
    const s = str.trim();
    let r, g, b;
    const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(s);
    if (hex) {
      const h = hex[1];
      if (h.length === 3) {
        r = parseInt(h[0] + h[0], 16);
        g = parseInt(h[1] + h[1], 16);
        b = parseInt(h[2] + h[2], 16);
      } else {
        r = parseInt(h.slice(0, 2), 16);
        g = parseInt(h.slice(2, 4), 16);
        b = parseInt(h.slice(4, 6), 16);
      }
    } else {
      const rgb = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(s);
      if (rgb) {
        r = Number(rgb[1]);
        g = Number(rgb[2]);
        b = Number(rgb[3]);
      } else {
        return null;
      }
    }
    return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  }

  function getXtermTheme() {
    const cs = getComputedStyle(document.documentElement);
    const bg = cs.getPropertyValue('--bg').trim() || (isLightTheme ? '#f6f7f9' : '#18181b');
    const fg = cs.getPropertyValue('--fg').trim() || (isLightTheme ? '#1b1d22' : '#eceef2');
    const accent = cs.getPropertyValue('--accent-color').trim() || '#5b9bff';
    return isLightTheme
      ? {
          background: bg,
          foreground: fg,
          cursor: accent,
          selectionBackground: 'rgba(37, 99, 235, 0.22)',
          black: '#1f2937',
          red: '#dc2626',
          green: '#16a34a',
          yellow: '#ca8a04',
          blue: '#2563eb',
          magenta: '#9333ea',
          cyan: '#0891b2',
          white: '#f3f4f6',
        }
      : {
          background: bg,
          foreground: fg,
          cursor: accent,
          selectionBackground: 'rgba(91, 155, 255, 0.28)',
          black: '#27272a',
          red: '#f87171',
          green: '#4ade80',
          yellow: '#facc15',
          blue: '#60a5fa',
          magenta: '#c084fc',
          cyan: '#22d3ee',
          white: '#f4f4f5',
        };
  }

  function syncTheme() {
    const forcedTheme = (urlParams.get('theme') || '').toLowerCase();
    const bgRaw = getComputedStyle(document.documentElement).getPropertyValue('--background').trim();
    const lum = parseCssColorLuminance(bgRaw);
    if (forcedTheme === 'light' || forcedTheme === 'dark') {
      isLightTheme = forcedTheme === 'light';
    } else if (lum !== null) {
      isLightTheme = lum > 0.55;
    } else if (window.matchMedia) {
      isLightTheme = window.matchMedia('(prefers-color-scheme: light)').matches;
    }
    document.documentElement.dataset.theme = isLightTheme ? 'light' : 'dark';
    const hljsLink = $('hljs-theme');
    if (hljsLink) {
      const targetHref = isLightTheme ? '/vendor/hljs-light.css' : '/vendor/hljs-dark.css';
      if (!hljsLink.getAttribute('href').endsWith(targetHref)) {
        hljsLink.setAttribute('href', targetHref);
      }
    }
    for (const view of paneViews.values()) {
      if (view.onThemeChange) view.onThemeChange();
    }
  }

  window.addEventListener('message', (e) => {
    if (e.data?.type === 'theme-change') {
      requestAnimationFrame(syncTheme);
    }
  });

  // -------------------------------------------------------------------------
  // Core Application State
  // -------------------------------------------------------------------------
  const appState = {
    root: L.createLeaf('empty', { color: PANE_COLORS[0].hex }),
    activePaneId: null,
    maximizedPaneId: null,
    splitMode: 'auto', // 'auto' | 'horizontal' | 'vertical'
    workspaces: [],    // array of absolute directory paths
    activeWorkspace: '',
    chatLinks: { files: [], urls: [] },
    seenChatKeys: new Set(),
    autoOpenChatLinks: false,
    ports: [],
    artifacts: [],
  };
  appState.activePaneId = appState.root.id;

  // Persistent DOM views per leafId so splits/swaps NEVER destroy iframes or xterm terminals!
  const paneViews = new Map();  // leafId -> PaneView instance
  const gutterEls = new Map();  // splitId -> HTMLElement
  let lastGeometry = { leaves: new Map(), gutters: [] };
  let saveStateTimer = null;
  let draggingPaneId = null;

  function stateKey() {
    return appState.activeWorkspace || 'default';
  }

  function scheduleSaveState() {
    clearTimeout(saveStateTimer);
    saveStateTimer = setTimeout(() => {
      apiPost('/api/state', {
        key: stateKey(),
        layout: appState.root,
        prefs: {
          splitMode: appState.splitMode,
          autoOpenChatLinks: appState.autoOpenChatLinks,
        },
      }).catch(() => {});
    }, 350);
  }

  async function loadPersistedState() {
    try {
      const res = await apiGet(`/api/state?key=${encodeURIComponent(stateKey())}`);
      if (res.prefs?.splitMode) {
        setSplitMode(res.prefs.splitMode, false);
      }
      if (typeof res.prefs?.autoOpenChatLinks === 'boolean') {
        appState.autoOpenChatLinks = res.prefs.autoOpenChatLinks;
        autoOpenChatCheckbox.checked = res.prefs.autoOpenChatLinks;
      }
      if (res.layout) {
        const sanitized = L.sanitizeTree(res.layout);
        if (sanitized) {
          // Clear any accidentally saved self-nested workbench URLs & ensure distinct colors
          let workingTree = sanitized;
          for (const lf of L.listLeaves(workingTree)) {
            if (lf.paneType === 'web' && lf.state?.url && isSelfOriginUrl(lf.state.url)) {
              lf.state.url = '';
            }
            if (lf.state?.color === undefined) {
              lf.state.color = pickNextDistinctColor(workingTree);
            }
          }
          // Tear down old views AND remove their DOM elements cleanly
          for (const view of paneViews.values()) {
            view.destroy(false);
            view.el.remove();
          }
          paneViews.clear();
          appState.root = workingTree;
          const leaves = L.listLeaves(appState.root);
          appState.activePaneId = leaves[0]?.id || null;
          appState.maximizedPaneId = null;
          renderStage();
          return;
        }
      }
    } catch {
      // ignore on fresh start
    }
    renderStage();
  }

  // -------------------------------------------------------------------------
  // Smart Auto-Split & Pane Opening
  // -------------------------------------------------------------------------
  function getActiveLeafRect() {
    const geom = lastGeometry.leaves.get(appState.activePaneId);
    if (geom) return geom;
    const stageRect = stageEl.getBoundingClientRect();
    return { x: 0, y: 0, w: stageRect.width, h: stageRect.height };
  }

  function setActivePane(paneId) {
    if (!paneId || appState.activePaneId === paneId) return;
    const prev = paneViews.get(appState.activePaneId);
    if (prev) prev.el.classList.remove('active');
    appState.activePaneId = paneId;
    const next = paneViews.get(paneId);
    if (next) next.el.classList.add('active');
  }

  function focusAndFlashPane(paneId) {
    if (appState.maximizedPaneId && appState.maximizedPaneId !== paneId) {
      appState.maximizedPaneId = null;
    }
    setActivePane(paneId);
    renderStage();
    const view = paneViews.get(paneId);
    if (view) {
      view.el.classList.remove('flash');
      void view.el.offsetWidth;
      view.el.classList.add('flash');
    }
  }

  /**
   * Opens a pane using Smart Auto-Split:
   * - If the currently focused pane is 'empty', fills it directly.
   * - If forceDirection is 'replace', replaces active pane.
   * - Otherwise measures the active pane's aspect ratio (width > height * 1.1 => left/right, else top/bottom)
   *   and splits it!
   */
  function openPane(paneType, state = {}, { forceDirection = null, deduplicate = false } = {}) {
    if (deduplicate && paneType === 'file' && state.path) {
      const existing = L.findLeafByPredicate(
        appState.root,
        (leaf) => leaf.paneType === 'file' && leaf.state?.path === state.path
      );
      if (existing) {
        if (state.line) {
          appState.root = L.updateLeafState(appState.root, existing.id, {
            line: state.line,
            endLine: state.endLine || null,
          });
          paneViews.get(existing.id)?.jumpToLine?.(state.line, state.endLine);
        }
        focusAndFlashPane(existing.id);
        return existing.id;
      }
    }

    if (deduplicate && paneType === 'web' && state.url) {
      const existing = L.findLeafByPredicate(
        appState.root,
        (leaf) => leaf.paneType === 'web' && leaf.state?.url === state.url
      );
      if (existing) {
        focusAndFlashPane(existing.id);
        return existing.id;
      }
    }

    if (appState.maximizedPaneId) {
      appState.maximizedPaneId = null;
    }

    const activeLeaf = L.findLeaf(appState.root, appState.activePaneId);
    if (activeLeaf && (activeLeaf.paneType === 'empty' || forceDirection === 'replace')) {
      const preservedColor =
        state.color !== undefined
          ? state.color
          : (activeLeaf.state?.color !== undefined ? activeLeaf.state.color : pickNextDistinctColor(appState.root));
      const oldView = paneViews.get(activeLeaf.id);
      if (oldView) {
        oldView.destroy(forceDirection === 'replace');
        oldView.el.remove();
        paneViews.delete(activeLeaf.id);
      }
      appState.root = L.replaceLeaf(appState.root, activeLeaf.id, paneType, { ...state, color: preservedColor });
      appState.activePaneId = activeLeaf.id;
      renderStage();
      scheduleSaveState();
      return activeLeaf.id;
    }

    const targetId = activeLeaf ? activeLeaf.id : L.listLeaves(appState.root)[0]?.id;
    const rect = getActiveLeafRect();
    const dir = L.decideSplitDirection(
      { width: rect.w, height: rect.h },
      forceDirection || appState.splitMode
    );
    const assignedColor =
      state.color !== undefined
        ? state.color
        : pickNextDistinctColor(appState.root, activeLeaf?.state?.color || '');
    const newLeaf = L.createLeaf(paneType, { ...state, color: assignedColor });
    appState.root = L.splitLeaf(appState.root, targetId, newLeaf, dir, 0.5);
    appState.activePaneId = newLeaf.id;
    renderStage();
    scheduleSaveState();
    return newLeaf.id;
  }

  function closePane(paneId) {
    const view = paneViews.get(paneId);
    if (view) {
      view.destroy(true); // user explicitly closed => kill PTY if terminal
      view.el.remove();
      paneViews.delete(paneId);
    }
    if (appState.maximizedPaneId === paneId) {
      appState.maximizedPaneId = null;
    }
    const { root, nextActiveId } = L.removeLeaf(appState.root, paneId);
    if (!root) {
      const fresh = L.createLeaf('empty', { color: PANE_COLORS[0].hex });
      appState.root = fresh;
      appState.activePaneId = fresh.id;
    } else {
      appState.root = root;
      if (appState.activePaneId === paneId || !L.findLeaf(root, appState.activePaneId)) {
        appState.activePaneId = nextActiveId || L.listLeaves(root)[0]?.id || null;
      }
    }
    renderStage();
    scheduleSaveState();
  }

  function toggleMaximize(paneId) {
    appState.maximizedPaneId = appState.maximizedPaneId === paneId ? null : paneId;
    setActivePane(paneId);
    renderStage();
  }

  function togglePaneSplitOrientation(paneId) {
    const parent = L.findParentSplit(appState.root, paneId);
    if (!parent) return;
    const nextDir = parent.direction === 'horizontal' ? 'vertical' : 'horizontal';
    appState.root = L.toggleSplitDirection(appState.root, parent.id);
    setActivePane(paneId);
    renderStage();
    scheduleSaveState();
    showToast(nextDir === 'horizontal' ? t('switchedHoriz') : t('switchedVert'), 1400);
  }

  function setSplitMode(mode, persist = true) {
    appState.splitMode = mode;
    document.querySelectorAll('.sm-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.splitMode === mode);
    });
    if (persist) scheduleSaveState();
  }

  // -------------------------------------------------------------------------
  // Per-Pane Color Picker Popover
  // -------------------------------------------------------------------------
  let colorTargetPaneId = null;

  function applyPaneColorToEl(el, colorHex) {
    if (colorHex) {
      el.style.setProperty('--pane-color', colorHex);
      el.classList.add('has-color');
    } else {
      el.style.removeProperty('--pane-color');
      el.classList.remove('has-color');
    }
  }

  function setPaneColor(paneId, colorHex) {
    if (!paneId) return;
    appState.root = L.updateLeafState(appState.root, paneId, { color: colorHex || '' });
    const view = paneViews.get(paneId);
    if (view) applyPaneColorToEl(view.el, colorHex || '');
    scheduleSaveState();
  }

  function hideColorPopover() {
    colorTargetPaneId = null;
    colorPopoverEl.classList.add('hidden');
  }

  function openColorPopover(paneId, anchorEl) {
    colorTargetPaneId = paneId;
    const leaf = L.findLeaf(appState.root, paneId);
    const current = String(leaf?.state?.color || '').toLowerCase();

    colorSwatchesEl.innerHTML = '';
    for (const c of PANE_COLORS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `color-swatch${c.hex.toLowerCase() === current ? ' selected' : ''}`;
      b.style.background = c.hex;
      b.title = c.name;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        setPaneColor(paneId, c.hex);
        hideColorPopover();
      });
      colorSwatchesEl.appendChild(b);
    }
    if (/^#[0-9a-f]{6}$/i.test(current)) {
      colorCustomInputEl.value = current;
    }

    colorPopoverEl.classList.remove('hidden');
    const aRect = anchorEl.getBoundingClientRect();
    const pRect = colorPopoverEl.getBoundingClientRect();
    const left = Math.max(8, Math.min(window.innerWidth - pRect.width - 8, aRect.left));
    const top = Math.min(window.innerHeight - pRect.height - 8, aRect.bottom + 6);
    colorPopoverEl.style.left = `${Math.round(left)}px`;
    colorPopoverEl.style.top = `${Math.round(top)}px`;
  }

  colorCustomInputEl.addEventListener('input', () => {
    if (colorTargetPaneId) setPaneColor(colorTargetPaneId, colorCustomInputEl.value);
  });
  colorCustomInputEl.addEventListener('change', () => hideColorPopover());
  $('color-clear-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    if (colorTargetPaneId) setPaneColor(colorTargetPaneId, '');
    hideColorPopover();
  });

  // -------------------------------------------------------------------------
  // Quote & Comment -> Attach Selection directly to Antigravity Conversation
  // -------------------------------------------------------------------------
  let pendingQuoteContext = null; // { path, title, selection, startLine, endLine, isTerminal }

  function formatQuoteLoc(ctx) {
    if (!ctx) return '';
    if (ctx.isTerminal) return ctx.title || 'Terminal';
    const base = ctx.title || basename(ctx.path || '');
    if (ctx.startLine) {
      return ctx.endLine && ctx.endLine !== ctx.startLine
        ? `${base}:L${ctx.startLine}-${ctx.endLine}`
        : `${base}:L${ctx.startLine}`;
    }
    return base;
  }

  function formatCleanFileUri(ctx) {
    if (!ctx?.path) return '';
    // Keep clean file:// URI (without #L hash) for Antigravity addArtifactComment compatibility
    return `file://${encodeURI(ctx.path)}`;
  }

  function formatQuoteUri(ctx) {
    if (!ctx?.path) return '';
    const base = `file://${ctx.path}`;
    if (ctx.startLine) {
      return ctx.endLine && ctx.endLine !== ctx.startLine
        ? `${base}#L${ctx.startLine}-L${ctx.endLine}`
        : `${base}#L${ctx.startLine}`;
    }
    return base;
  }

  function formatMarkdownQuote(ctx) {
    const loc = formatQuoteLoc(ctx);
    const body = String(ctx.selection || '').trim();
    const header = ctx.path && !ctx.isTerminal ? `[${loc}](${formatQuoteUri(ctx)})` : loc;
    if (body.includes('\n')) {
      return `${header}\n\`\`\`\n${body}\n\`\`\``;
    }
    return `> ${body}\n> — ${header}`;
  }

  async function copyTextSilent(text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none;';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
        return true;
      } catch {
        return false;
      }
    }
  }

  function hideQuotePopover() {
    quotePopoverEl.classList.add('hidden');
  }

  function showQuotePopover(ctx, clientX, clientY, { placeBelow = false } = {}) {
    pendingQuoteContext = ctx;
    quoteLocEl.textContent = formatQuoteLoc(ctx);
    quotePopoverEl.classList.remove('hidden');
    const rect = quotePopoverEl.getBoundingClientRect();
    const pad = 8;
    let left = Math.max(pad, Math.min(window.innerWidth - rect.width - pad, clientX - rect.width / 2));
    let top;
    if (placeBelow) {
      top = clientY + 8;
      if (top + rect.height > window.innerHeight - pad) {
        top = Math.max(40, clientY - rect.height - 10);
      }
    } else {
      top = clientY - rect.height - 10;
      if (top < 40) top = Math.min(window.innerHeight - rect.height - pad, clientY + 14);
    }
    quotePopoverEl.style.left = `${Math.round(left)}px`;
    quotePopoverEl.style.top = `${Math.round(top)}px`;
  }

  async function sendDirectQuote(ctx, customComment = '') {
    if (!ctx || !ctx.selection) return;
    const loc = formatQuoteLoc(ctx);
    const cleanUri = formatCleanFileUri(ctx);
    const mdQuote = formatMarkdownQuote(ctx);
    const commentText = customComment.trim() || t('quotePrefix', { loc });

    if (window.sidecar?.ui?.addArtifactComment) {
      window.sidecar.ui.addArtifactComment({
        uri: cleanUri,
        selection: ctx.selection,
        comment: commentText,
        pageTitle: loc,
      });
      await copyTextSilent(mdQuote);
      showToast(t('toastQuoted', { loc }), 2600);
    } else {
      await copyTextSilent(mdQuote);
      showToast(t('toastCopiedQuote', { loc }));
    }
  }

  async function sendQuoteMessageNow(ctx, userPrompt = '') {
    if (!ctx || !ctx.selection) return;
    const mdQuote = formatMarkdownQuote(ctx);
    const msg = userPrompt.trim() ? `${mdQuote}\n\n${userPrompt.trim()}` : mdQuote;
    if (window.sidecar?.agent?.sendMessage && convId()) {
      try {
        await window.sidecar.agent.sendMessage(msg, convId());
        showToast(t('toastSentNow', { loc: formatQuoteLoc(ctx) }));
        return;
      } catch (err) {
        await copyTextSilent(msg);
        showToast(t('toastSendFailed', { err: err.message }), 3000);
        return;
      }
    }
    await copyTextSilent(msg);
    showToast(t('toastCopied'));
  }

  function openCommentBar(ctx) {
    pendingQuoteContext = ctx;
    hideQuotePopover();
    const loc = formatQuoteLoc(ctx);
    const snippet = String(ctx.selection || '').replace(/\s+/g, ' ').slice(0, 90);
    commentPreviewEl.textContent = `❝ ${loc}: ${snippet}${ctx.selection.length > 90 ? '…' : ''}`;
    commentInputEl.value = '';
    commentBarEl.classList.remove('hidden');
    commentInputEl.focus();
  }

  function closeCommentBar() {
    commentBarEl.classList.add('hidden');
  }

  async function submitComment() {
    if (!pendingQuoteContext) return;
    const comment = commentInputEl.value.trim();
    await sendDirectQuote(pendingQuoteContext, comment);
    closeCommentBar();
  }

  $('quote-btn-send').addEventListener('click', (e) => {
    e.stopPropagation();
    const ctx = pendingQuoteContext;
    hideQuotePopover();
    sendDirectQuote(ctx);
  });

  $('quote-btn-comment').addEventListener('click', (e) => {
    e.stopPropagation();
    if (pendingQuoteContext) openCommentBar(pendingQuoteContext);
  });

  $('quote-btn-copy').addEventListener('click', async (e) => {
    e.stopPropagation();
    const ctx = pendingQuoteContext;
    hideQuotePopover();
    if (!ctx) return;
    await copyTextSilent(formatMarkdownQuote(ctx));
    showToast(t('toastCopiedQuote', { loc: formatQuoteLoc(ctx) }));
  });

  $('comment-send').addEventListener('click', submitComment);
  $('comment-send-now').addEventListener('click', async () => {
    if (!pendingQuoteContext) return;
    const text = commentInputEl.value.trim();
    closeCommentBar();
    await sendQuoteMessageNow(pendingQuoteContext, text);
  });
  $('comment-cancel').addEventListener('click', closeCommentBar);
  commentInputEl.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      if (!pendingQuoteContext) return;
      const text = commentInputEl.value.trim();
      closeCommentBar();
      await sendQuoteMessageNow(pendingQuoteContext, text);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      submitComment();
    } else if (e.key === 'Escape') {
      closeCommentBar();
    }
  });

  document.addEventListener('pointerdown', (e) => {
    if (!quotePopoverEl.classList.contains('hidden') && !quotePopoverEl.contains(e.target)) {
      hideQuotePopover();
    }
    if (!colorPopoverEl.classList.contains('hidden') && !colorPopoverEl.contains(e.target) && !e.target.closest?.('.pane-color-btn')) {
      hideColorPopover();
    }
  });

  // -------------------------------------------------------------------------
  // Pane View Factory (Persistent DOM per leaf)
  // -------------------------------------------------------------------------
  function createPaneView(leaf) {
    const el = document.createElement('section');
    el.className = 'pane';
    el.dataset.paneId = leaf.id;
    el.addEventListener('pointerdown', () => setActivePane(leaf.id), true);

    // Header
    const header = document.createElement('div');
    header.className = 'pane-header';
    header.draggable = true;

    const colorBtn = document.createElement('button');
    colorBtn.type = 'button';
    colorBtn.className = 'pane-color-btn';
    colorBtn.draggable = false;
    colorBtn.title = t('colorBtnTitle');
    const dot = document.createElement('span');
    dot.className = `pane-type-dot ${leaf.paneType}`;
    colorBtn.appendChild(dot);
    colorBtn.addEventListener('pointerdown', (e) => e.stopPropagation());
    colorBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openColorPopover(leaf.id, colorBtn);
    });

    applyPaneColorToEl(el, leaf.state?.color || '');

    const titleEl = document.createElement('span');
    titleEl.className = 'pane-title';

    const statusPill = document.createElement('span');
    statusPill.className = 'pane-status-pill hidden';

    const customActions = document.createElement('div');
    customActions.className = 'pane-actions';

    const universalActions = document.createElement('div');
    universalActions.className = 'pane-actions';

    const btnToggleDir = makeIconBtn('⇄', t('toggleDirTitle'), () => {
      togglePaneSplitOrientation(leaf.id);
    });
    btnToggleDir.classList.add('hidden');
    const btnSplitRight = makeIconBtn('◫', t('splitRightTitle'), () => {
      setActivePane(leaf.id);
      openPane('empty', {}, { forceDirection: 'horizontal' });
    });
    const btnSplitDown = makeIconBtn('⬓', t('splitDownTitle'), () => {
      setActivePane(leaf.id);
      openPane('empty', {}, { forceDirection: 'vertical' });
    });
    const btnMax = makeIconBtn('⤢', t('maxTitle'), () => toggleMaximize(leaf.id));
    const btnClose = makeIconBtn('✕', t('closePaneTitle'), () => closePane(leaf.id));

    universalActions.append(btnToggleDir, btnSplitRight, btnSplitDown, btnMax, btnClose);
    header.append(colorBtn, titleEl, statusPill, customActions, universalActions);

    // Drag pane header to swap two panes without unmounting!
    header.addEventListener('dragstart', (e) => {
      if (e.target.closest?.('button, input, select, a')) {
        e.preventDefault();
        return;
      }
      draggingPaneId = leaf.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', leaf.id);
    });
    header.addEventListener('dragend', () => {
      draggingPaneId = null;
      document.querySelectorAll('.pane.drop-target').forEach((p) => p.classList.remove('drop-target'));
    });
    el.addEventListener('dragover', (e) => {
      if (!draggingPaneId || draggingPaneId === leaf.id) return;
      e.preventDefault();
      el.classList.add('drop-target');
    });
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
    el.addEventListener('drop', (e) => {
      el.classList.remove('drop-target');
      if (!draggingPaneId || draggingPaneId === leaf.id) return;
      e.preventDefault();
      appState.root = L.swapLeaves(appState.root, draggingPaneId, leaf.id);
      draggingPaneId = null;
      renderStage();
      scheduleSaveState();
    });

    const body = document.createElement('div');
    body.className = 'pane-body';
    el.append(header, body);

    const view = {
      id: leaf.id,
      paneType: leaf.paneType,
      el,
      header,
      titleEl,
      statusPill,
      customActions,
      body,
      btnToggleDir,
      btnMax,
      destroy() {},
      onResize() {},
      onThemeChange() {},
      jumpToLine: null,
    };

    if (leaf.paneType === 'empty') {
      mountEmptyPane(view, leaf);
    } else if (leaf.paneType === 'file') {
      mountFilePane(view, leaf);
    } else if (leaf.paneType === 'web') {
      mountWebPane(view, leaf);
    } else if (leaf.paneType === 'terminal') {
      mountTerminalPane(view, leaf);
    } else if (leaf.paneType === 'artifact') {
      mountArtifactPane(view, leaf);
    }

    return view;
  }

  function makeIconBtn(label, title, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'icon-btn';
    b.draggable = false;
    b.textContent = label;
    b.title = title;
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick(e);
    });
    return b;
  }

  function makeMiniBtn(label, title, onClick, primary = false) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `pane-mini-btn${primary ? ' primary' : ''}`;
    b.draggable = false;
    b.textContent = label;
    b.title = title;
    b.addEventListener('pointerdown', (e) => e.stopPropagation());
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      onClick(e);
    });
    return b;
  }

  // -------------------------------------------------------------------------
  // 1. Empty / Launcher Pane
  // -------------------------------------------------------------------------
  function mountEmptyPane(view, leaf) {
    view.titleEl.textContent = t('newPane');
    const wrap = document.createElement('div');
    wrap.className = 'empty-pane';
    wrap.innerHTML = `
      <div class="empty-title">Split Workbench</div>
      <div class="empty-desc">${escapeHtml(t('emptyDesc'))}</div>
      <div class="quick-grid">
        <button class="quick-card" data-action="file" type="button">
          <span class="quick-card-title">${escapeHtml(t('cardFile'))}</span>
          <span class="quick-card-sub">${escapeHtml(t('cardFileSub'))}</span>
        </button>
        <button class="quick-card" data-action="web" type="button">
          <span class="quick-card-title">${escapeHtml(t('cardWeb'))}</span>
          <span class="quick-card-sub">${escapeHtml(t('cardWebSub'))}</span>
        </button>
        <button class="quick-card" data-action="terminal" type="button">
          <span class="quick-card-title">${escapeHtml(t('cardTerm'))}</span>
          <span class="quick-card-sub">${escapeHtml(t('cardTermSub'))}</span>
        </button>
        <button class="quick-card" data-action="artifact" type="button">
          <span class="quick-card-title">${escapeHtml(t('cardArtifact'))}</span>
          <span class="quick-card-sub">${escapeHtml(t('cardArtifactSub'))}</span>
        </button>
      </div>
    `;
    wrap.querySelectorAll('.quick-card').forEach((btn) => {
      btn.addEventListener('click', () => {
        setActivePane(leaf.id);
        const act = btn.dataset.action;
        if (act === 'file') openFilePicker(true);
        else if (act === 'web') openPane('web', {}, { forceDirection: 'replace' });
        else if (act === 'terminal') openPane('terminal', { cwd: appState.activeWorkspace }, { forceDirection: 'replace' });
        else if (act === 'artifact') openPane('artifact', {}, { forceDirection: 'replace' });
      });
    });
    view.body.appendChild(wrap);
  }

  // -------------------------------------------------------------------------
  // 2. File Pane (Code / Markdown / Image / PDF + Live Auto-Reload + Optional Edit)
  // -------------------------------------------------------------------------
  function mountFilePane(view, leaf, { isArtifact = false } = {}) {
    let currentPath = leaf.state?.path || '';
    let highlightStart = leaf.state?.line || null;
    let highlightEnd = leaf.state?.endLine || highlightStart;
    let selectedLineAnchor = null;
    let selectedLineStart = null;
    let selectedLineEnd = null;
    let fileData = null;
    let mdPreview = true;
    let editMode = false;
    let editorEl = null;
    let pollTimer = null;

    view.titleEl.textContent = currentPath ? basename(currentPath) : (isArtifact ? 'Artifacts' : t('paneFile'));

    // Subbar
    const subbar = document.createElement('div');
    subbar.className = 'file-subbar';

    let artifactSelect = null;
    const pathLabel = document.createElement('span');
    pathLabel.className = 'file-path-label';
    if (isArtifact) {
      artifactSelect = document.createElement('select');
      artifactSelect.className = 'artifact-select';
      artifactSelect.addEventListener('change', () => {
        currentPath = artifactSelect.value;
        appState.root = L.updateLeafState(appState.root, leaf.id, { path: currentPath });
        scheduleSaveState();
        loadFile(false);
      });
      subbar.appendChild(artifactSelect);
    } else {
      subbar.appendChild(pathLabel);
    }

    const scrollEl = document.createElement('div');
    scrollEl.className = 'file-scroll';

    view.body.append(subbar, scrollEl);

    function getActiveSelectionContext() {
      // 1. Prefer mouse text selection inside this pane
      const sel = window.getSelection();
      const selText = sel?.toString()?.trim() || '';
      if (selText && sel && sel.rangeCount > 0 && scrollEl.contains(sel.anchorNode)) {
        let startLine = null;
        let endLine = null;
        const startRow = (sel.anchorNode?.nodeType === 1 ? sel.anchorNode : sel.anchorNode?.parentElement)?.closest?.('tr[data-line]');
        const endRow = (sel.focusNode?.nodeType === 1 ? sel.focusNode : sel.focusNode?.parentElement)?.closest?.('tr[data-line]');
        if (startRow && endRow) {
          const a = Number(startRow.dataset.line);
          const b = Number(endRow.dataset.line);
          startLine = Math.min(a, b);
          endLine = Math.max(a, b);
        }
        return {
          path: currentPath,
          title: basename(currentPath),
          selection: selText,
          startLine,
          endLine,
          isTerminal: false,
        };
      }
      // 2. Fallback to line-number click selection
      if (selectedLineStart && fileData?.content) {
        const lines = fileData.content.split('\n');
        const s = Math.max(1, selectedLineStart);
        const e = Math.min(lines.length, selectedLineEnd || s);
        return {
          path: currentPath,
          title: basename(currentPath),
          selection: lines.slice(s - 1, e).join('\n'),
          startLine: s,
          endLine: e,
          isTerminal: false,
        };
      }
      return null;
    }

    function updateLineSelectionHighlight() {
      scrollEl.querySelectorAll('tr.code-row').forEach((row) => {
        const ln = Number(row.dataset.line);
        const on = selectedLineStart && ln >= selectedLineStart && ln <= (selectedLineEnd || selectedLineStart);
        row.classList.toggle('line-selected', Boolean(on));
      });
    }

    // Floating Quote toolbar on mouse text selection
    scrollEl.addEventListener('mouseup', (e) => {
      if (editMode) return;
      // Ignore clicks on line number cell (handled separately)
      if (e.target.closest?.('td.code-ln')) return;
      setTimeout(() => {
        const ctx = getActiveSelectionContext();
        if (ctx && ctx.selection) {
          showQuotePopover(ctx, e.clientX, e.clientY);
        }
      }, 10);
    });

    // Click / Shift+Click line numbers to select lines and pop Quote toolbar!
    scrollEl.addEventListener('click', (e) => {
      const lnCell = e.target.closest?.('td.code-ln');
      if (!lnCell || !fileData?.content) return;
      const ln = Number(lnCell.parentElement?.dataset?.line);
      if (!ln) return;
      if (e.shiftKey && selectedLineAnchor) {
        selectedLineStart = Math.min(selectedLineAnchor, ln);
        selectedLineEnd = Math.max(selectedLineAnchor, ln);
      } else {
        selectedLineAnchor = ln;
        selectedLineStart = ln;
        selectedLineEnd = ln;
      }
      updateLineSelectionHighlight();
      const ctx = getActiveSelectionContext();
      if (ctx) {
        const endRow = scrollEl.querySelector(`tr[data-line="${selectedLineEnd || ln}"]`) || lnCell.parentElement;
        const r = endRow.getBoundingClientRect();
        showQuotePopover(ctx, r.left + 175, r.bottom, { placeBelow: true });
      }
    });

    // Header actions
    const btnPreviewHtml = makeMiniBtn(t('previewHtml'), t('previewHtmlTitle'), async () => {
      if (!currentPath) return;
      try {
        const res = await apiGet(`/api/preview-url?path=${encodeURIComponent(currentPath)}`);
        const previewUrl = `${location.origin}${res.previewPath}`;
        setActivePane(leaf.id);
        openPane('web', { url: previewUrl, localHtmlPath: currentPath }, { deduplicate: true });
      } catch (err) {
        showToast(t('previewErr', { err: err.message }));
      }
    });
    btnPreviewHtml.classList.add('hidden');

    const btnToggleMd = makeMiniBtn(t('sourceBtn'), t('toggleMdTitle'), () => {
      mdPreview = !mdPreview;
      btnToggleMd.textContent = mdPreview ? t('sourceBtn') : t('previewBtn');
      renderFileContent();
    });
    btnToggleMd.classList.add('hidden');

    const btnQuote = makeMiniBtn(t('quoteBtn'), t('quoteBtnTitle'), () => {
      const ctx = getActiveSelectionContext();
      if (!ctx) {
        showToast(t('quoteSelectHint'));
        return;
      }
      sendDirectQuote(ctx);
    });

    const btnEdit = makeMiniBtn(t('editBtn'), t('editTitle'), () => {
      if (!fileData || (fileData.kind !== 'text' && fileData.kind !== 'markdown')) return;
      editMode = !editMode;
      renderFileContent();
    });
    btnEdit.classList.add('hidden');

    const btnSave = makeMiniBtn(t('saveBtn'), t('saveTitle'), async () => {
      if (!editorEl || !currentPath) return;
      try {
        const res = await apiPost('/api/file/write', { path: currentPath, content: editorEl.value });
        fileData.content = editorEl.value;
        fileData.mtimeMs = res.mtimeMs;
        editMode = false;
        showToast(t('savedToast', { name: basename(currentPath) }));
        renderFileContent();
      } catch (err) {
        showToast(t('saveErr', { err: err.message }));
      }
    }, true);
    btnSave.classList.add('hidden');

    const btnRefresh = makeIconBtn('↻', t('refresh'), () => loadFile(false));

    view.customActions.append(btnPreviewHtml, btnToggleMd, btnQuote, btnEdit, btnSave, btnRefresh);

    function flashUpdated() {
      view.statusPill.textContent = t('updatedPill');
      view.statusPill.classList.remove('hidden');
      setTimeout(() => view.statusPill.classList.add('hidden'), 1800);
    }

    function scrollToHighlightedLine() {
      if (!highlightStart) return;
      const row = scrollEl.querySelector(`tr[data-line="${highlightStart}"]`);
      if (row) {
        row.scrollIntoView({ block: 'center' });
      }
    }

    view.jumpToLine = (startLine, endLine) => {
      highlightStart = startLine;
      highlightEnd = endLine || startLine;
      if (fileData && !editMode) {
        if (fileData.kind === 'markdown' && mdPreview) {
          mdPreview = false;
          btnToggleMd.textContent = t('previewBtn');
        }
        renderFileContent();
        requestAnimationFrame(scrollToHighlightedLine);
      }
    };

    function renderCode(content, ext) {
      const langMap = {
        '.js': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript', '.jsx': 'javascript',
        '.ts': 'typescript', '.tsx': 'typescript', '.py': 'python', '.json': 'json',
        '.html': 'xml', '.xml': 'xml', '.svg': 'xml', '.css': 'css', '.scss': 'scss',
        '.sh': 'bash', '.zsh': 'bash', '.bash': 'bash', '.yml': 'yaml', '.yaml': 'yaml',
        '.md': 'markdown', '.go': 'go', '.rs': 'rust', '.java': 'java', '.sql': 'sql',
        '.c': 'c', '.cpp': 'cpp', '.h': 'c', '.swift': 'swift', '.rb': 'ruby', '.toml': 'ini',
      };
      const lang = langMap[ext];
      let highlightedHtml = '';
      try {
        if (window.hljs && content.length < 350000) {
          if (lang && window.hljs.getLanguage(lang)) {
            highlightedHtml = window.hljs.highlight(content, { language: lang, ignoreIllegals: true }).value;
          } else {
            highlightedHtml = window.hljs.highlightAuto(content).value;
          }
        } else {
          highlightedHtml = escapeHtml(content);
        }
      } catch {
        highlightedHtml = escapeHtml(content);
      }

      // Split highlighted HTML by line while balancing multi-line <span> tags (e.g. block comments)
      const rawLines = content.split('\n');
      const hlLines = splitHighlightedLines(highlightedHtml);
      const useHl = hlLines.length === rawLines.length;

      const rows = [];
      for (let i = 0; i < rawLines.length; i++) {
        const ln = i + 1;
        const isHi = highlightStart && ln >= highlightStart && ln <= (highlightEnd || highlightStart);
        const lineHtml = useHl ? (hlLines[i] || ' ') : (escapeHtml(rawLines[i]) || ' ');
        rows.push(
          `<tr class="code-row${isHi ? ' highlighted' : ''}" data-line="${ln}">` +
          `<td class="code-ln">${ln}</td>` +
          `<td class="code-line hljs">${lineHtml}</td>` +
          `</tr>`
        );
      }
      scrollEl.innerHTML = `<table class="code-table"><tbody>${rows.join('')}</tbody></table>`;
      if (highlightStart) requestAnimationFrame(scrollToHighlightedLine);
    }

    function renderMarkdown(content) {
      const container = document.createElement('div');
      container.className = 'md-body';
      if (window.marked) {
        container.innerHTML = window.marked.parse(content, { gfm: true, breaks: false });
        if (window.hljs) {
          container.querySelectorAll('pre code').forEach((block) => {
            try { window.hljs.highlightElement(block); } catch {}
          });
        }
        // Intercept local file:// and http:// links inside Markdown to open in split workbench!
        container.querySelectorAll('a[href]').forEach((a) => {
          a.addEventListener('click', (e) => {
            const href = a.getAttribute('href') || '';
            if (href.startsWith('file://')) {
              e.preventDefault();
              const [rawP, hash] = href.split('#');
              const m = /^L(\d+)(?:-L?(\d+))?$/.exec(hash || '');
              openPane('file', {
                path: uriToPath(rawP),
                line: m ? Number(m[1]) : null,
                endLine: m && m[2] ? Number(m[2]) : null,
              }, { deduplicate: !e.shiftKey });
            } else if (href.startsWith('http://localhost') || href.startsWith('http://127.0.0.1')) {
              e.preventDefault();
              openPane('web', { url: href }, { deduplicate: !e.shiftKey });
            } else if (href.startsWith('http://') || href.startsWith('https://')) {
              a.target = '_blank';
              a.rel = 'noopener noreferrer';
            }
          });
        });
      } else {
        container.innerHTML = `<pre>${escapeHtml(content)}</pre>`;
      }
      scrollEl.innerHTML = '';
      scrollEl.appendChild(container);
    }

    function renderFileContent() {
      if (!fileData) return;
      const isMd = fileData.kind === 'markdown';
      const isHtml = fileData.ext === '.html' || fileData.ext === '.htm';
      const isText = fileData.kind === 'text' || isMd;
      btnPreviewHtml.classList.toggle('hidden', !isHtml || editMode);
      btnToggleMd.classList.toggle('hidden', !isMd || editMode);
      btnEdit.classList.toggle('hidden', !isText || isArtifact);
      btnEdit.textContent = editMode ? t('cancelBtn') : t('editBtn');
      btnSave.classList.toggle('hidden', !editMode);
      btnQuote.classList.toggle('hidden', !isText || editMode);

      if (editMode && isText) {
        const ta = document.createElement('textarea');
        ta.className = 'file-editor';
        ta.value = fileData.content;
        ta.spellcheck = false;
        ta.addEventListener('keydown', (e) => {
          if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
            e.preventDefault();
            btnSave.click();
          }
        });
        editorEl = ta;
        scrollEl.innerHTML = '';
        scrollEl.appendChild(ta);
        ta.focus();
        return;
      }

      editorEl = null;
      if (fileData.kind === 'image') {
        const imgUrl = withTokenUrl(`/api/file/raw?path=${encodeURIComponent(fileData.path)}&t=${fileData.mtimeMs}`);
        scrollEl.innerHTML = `<div class="image-wrap"><img src="${imgUrl}" alt="${escapeHtml(fileData.name)}"></div>`;
      } else if (fileData.kind === 'pdf') {
        const pdfUrl = withTokenUrl(`/api/file/raw?path=${encodeURIComponent(fileData.path)}`);
        scrollEl.innerHTML = `<iframe class="web-frame" src="${pdfUrl}" title="${escapeHtml(fileData.name)}"></iframe>`;
      } else if (fileData.kind === 'binary' || fileData.kind === 'too-large') {
        scrollEl.innerHTML = `<div class="empty-pane"><div class="empty-title">${escapeHtml(fileData.name)}</div><div class="empty-desc">${escapeHtml(fileData.error || t('binaryUnsupported'))}</div></div>`;
      } else if (isMd && mdPreview) {
        renderMarkdown(fileData.content);
      } else {
        renderCode(fileData.content, fileData.ext);
      }
    }

    async function loadFile(preserveScroll = false) {
      if (!currentPath) {
        if (isArtifact) {
          scrollEl.innerHTML = `<div class="empty-pane"><div class="empty-title">${escapeHtml(t('noArtifactsTitle'))}</div><div class="empty-desc">${escapeHtml(t('noArtifactsDesc'))}</div></div>`;
        }
        return;
      }
      const prevTop = preserveScroll ? scrollEl.scrollTop : 0;
      try {
        const next = await apiGet(`/api/file/read?path=${encodeURIComponent(currentPath)}`);
        fileData = next;
        view.titleEl.textContent = next.name;
        view.titleEl.title = next.path;
        if (pathLabel) {
          pathLabel.textContent = appState.activeWorkspace && next.path.startsWith(appState.activeWorkspace + '/')
            ? next.path.slice(appState.activeWorkspace.length + 1)
            : next.path;
          pathLabel.title = next.path;
        }
        renderFileContent();
        if (preserveScroll) scrollEl.scrollTop = prevTop;
      } catch (err) {
        scrollEl.innerHTML = `<div class="empty-pane"><div class="empty-title">${escapeHtml(t('loadFileErr'))}</div><div class="empty-desc">${escapeHtml(err.message)}</div></div>`;
      }
    }

    async function refreshArtifactList() {
      if (!isArtifact || !artifactSelect) return;
      try {
        const res = await apiGet(`/api/artifacts?conversationId=${encodeURIComponent(convId())}`);
        appState.artifacts = res.items || [];
        artifactSelect.innerHTML = '';
        if (appState.artifacts.length === 0) {
          const opt = document.createElement('option');
          opt.value = '';
          opt.textContent = t('noArtifactsOpt');
          artifactSelect.appendChild(opt);
          currentPath = '';
          loadFile(false);
          return;
        }
        for (const item of appState.artifacts) {
          const opt = document.createElement('option');
          opt.value = item.path;
          opt.textContent = item.rel;
          artifactSelect.appendChild(opt);
        }
        if (!currentPath || !appState.artifacts.some((a) => a.path === currentPath)) {
          currentPath = appState.artifacts[0].path;
          appState.root = L.updateLeafState(appState.root, leaf.id, { path: currentPath });
        }
        artifactSelect.value = currentPath;
        loadFile(false);
      } catch {
        // ignore
      }
    }

    // Live file change auto-reload
    pollTimer = setInterval(async () => {
      if (document.hidden || editMode) return;
      if (isArtifact && !currentPath) {
        refreshArtifactList();
        return;
      }
      if (!currentPath || !fileData) return;
      try {
        const st = await apiGet(`/api/file/stat?path=${encodeURIComponent(currentPath)}`);
        if (st.mtimeMs && fileData.mtimeMs && Math.abs(st.mtimeMs - fileData.mtimeMs) > 10) {
          await loadFile(true);
          flashUpdated();
        }
      } catch {
        // ignore
      }
    }, 2500);

    view.destroy = () => clearInterval(pollTimer);

    if (isArtifact) {
      refreshArtifactList();
    } else {
      loadFile(false);
    }
  }

  function mountArtifactPane(view, leaf) {
    mountFilePane(view, leaf, { isArtifact: true });
  }

  // -------------------------------------------------------------------------
  // 3. Web Preview Pane (Localhost port auto-discovery + Local HTML + Anti-Inception)
  // -------------------------------------------------------------------------
  function isSelfOriginUrl(u) {
    try {
      const parsed = new URL(u, location.origin);
      // Allow our own /preview/... local HTML static hosting route!
      if (parsed.pathname.startsWith('/preview/')) return false;
      const selfHost = location.hostname;
      const selfPort = location.port || (location.protocol === 'https:' ? '443' : '80');
      const targetPort = parsed.port || (parsed.protocol === 'https:' ? '443' : '80');
      const bothLoopback =
        (selfHost === '127.0.0.1' || selfHost === 'localhost') &&
        (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost');
      return (parsed.hostname === selfHost || bothLoopback) && targetPort === selfPort;
    } catch {
      return false;
    }
  }

  function normalizeUserUrl(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    if (s.startsWith('/') || s.startsWith('~/') || s.startsWith('file://')) return s;
    if (/^https?:\/\//i.test(s)) return s;
    if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(s)) {
      return `http://${s}`;
    }
    if (/^:\d+/.test(s)) {
      return `http://localhost${s}`;
    }
    if (/^\d{2,5}$/.test(s)) {
      return `http://localhost:${s}`;
    }
    return `https://${s}`;
  }

  function mountWebPane(view, leaf) {
    let currentUrl = leaf.state?.url || '';
    let localHtmlPath = leaf.state?.localHtmlPath || '';
    if (currentUrl && isSelfOriginUrl(currentUrl)) currentUrl = '';
    view.titleEl.textContent = localHtmlPath ? basename(localHtmlPath) : (currentUrl ? shortHost(currentUrl) : t('paneWeb'));

    const bar = document.createElement('div');
    bar.className = 'web-bar';

    const urlInput = document.createElement('input');
    urlInput.className = 'web-url-input';
    urlInput.type = 'text';
    urlInput.placeholder = t('webPlaceholder');
    urlInput.value = localHtmlPath || currentUrl;

    const btnGo = makeMiniBtn(t('goBtn'), t('goBtnTitle'), () => navigate(urlInput.value));
    const btnReload = makeIconBtn('↻', t('refresh'), () => {
      if (iframeEl && currentUrl) {
        iframeEl.src = currentUrl;
      } else {
        renderStartScreen();
      }
    });
    const btnExt = makeIconBtn('↗', t('openExtTitle'), () => {
      if (currentUrl) window.open(currentUrl, '_blank', 'noopener,noreferrer');
    });

    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        navigate(urlInput.value);
      }
    });

    bar.append(urlInput, btnGo, btnReload, btnExt);

    const contentHost = document.createElement('div');
    contentHost.style.cssText = 'flex:1;min-height:0;display:flex;flex-direction:column;';

    view.body.append(bar, contentHost);

    let iframeEl = null;

    function shortHost(u) {
      try {
        const parsed = new URL(u);
        if (parsed.pathname.startsWith('/preview/')) {
          return decodeURIComponent(basename(parsed.pathname));
        }
        return parsed.host + (parsed.pathname !== '/' ? parsed.pathname : '');
      } catch {
        return u;
      }
    }

    async function navigate(raw) {
      let normalized = normalizeUserUrl(raw);
      if (!normalized) return;

      // Support opening a local .html file directly with zero external server!
      if (normalized.startsWith('/') || normalized.startsWith('~/') || normalized.startsWith('file://')) {
        try {
          const res = await apiGet(`/api/preview-url?path=${encodeURIComponent(normalized)}`);
          localHtmlPath = res.path;
          normalized = `${location.origin}${res.previewPath}`;
        } catch (err) {
          showToast(t('localHtmlErr', { err: err.message }));
          return;
        }
      } else if (!normalized.includes('/preview/')) {
        localHtmlPath = '';
      }

      if (isSelfOriginUrl(normalized)) {
        showToast(t('selfNestBlocked'));
        return;
      }

      currentUrl = normalized;
      urlInput.value = localHtmlPath || normalized;
      view.titleEl.textContent = localHtmlPath ? basename(localHtmlPath) : shortHost(normalized);
      view.titleEl.title = localHtmlPath || normalized;
      appState.root = L.updateLeafState(appState.root, leaf.id, { url: normalized, localHtmlPath });
      scheduleSaveState();

      if (!iframeEl) {
        contentHost.innerHTML = '';
        iframeEl = document.createElement('iframe');
        iframeEl.className = 'web-frame';
        iframeEl.setAttribute('referrerpolicy', 'no-referrer-when-downgrade');
        iframeEl.setAttribute('allow', 'clipboard-read; clipboard-write; fullscreen');
        contentHost.appendChild(iframeEl);
      }
      iframeEl.src = normalized;
    }

    async function renderStartScreen() {
      iframeEl = null;
      let ports = [];
      try {
        const res = await apiGet('/api/ports');
        ports = res.ports || [];
        appState.ports = ports;
      } catch {
        ports = appState.ports;
      }

      const startEl = document.createElement('div');
      startEl.className = 'web-start';

      // Detected local ports
      const portSection = document.createElement('div');
      portSection.innerHTML = `<div class="section-label">${escapeHtml(t('detectedPorts'))}</div>`;
      const portChips = document.createElement('div');
      portChips.className = 'chip-list';
      if (ports.length === 0) {
        portChips.innerHTML = `<span class="muted" style="font-size:12px;">${t('noPortsHint')}</span>`;
      } else {
        for (const p of ports) {
          const c = document.createElement('button');
          c.type = 'button';
          c.className = 'chip';
          c.innerHTML = `<span class="chip-dot"></span><span>localhost:${p.port}</span><span class="muted">(${escapeHtml(p.proc)})</span>`;
          c.addEventListener('click', () => navigate(p.url));
          portChips.appendChild(c);
        }
      }
      portSection.appendChild(portChips);
      startEl.appendChild(portSection);

      // URLs mentioned in chat
      if (appState.chatLinks.urls.length > 0) {
        const chatSection = document.createElement('div');
        chatSection.innerHTML = `<div class="section-label">${escapeHtml(t('chatUrlsLabel'))}</div>`;
        const urlChips = document.createElement('div');
        urlChips.className = 'chip-list';
        for (const item of appState.chatLinks.urls.slice(0, 10)) {
          const c = document.createElement('button');
          c.type = 'button';
          c.className = 'chip';
          c.textContent = item.isLocal ? item.host + item.path : item.url;
          c.title = item.url;
          c.addEventListener('click', () => navigate(item.url));
          urlChips.appendChild(c);
        }
        chatSection.appendChild(urlChips);
        startEl.appendChild(chatSection);
      }

      const tip = document.createElement('div');
      tip.className = 'web-tip';
      tip.textContent = t('webTip');
      startEl.appendChild(tip);

      contentHost.innerHTML = '';
      contentHost.appendChild(startEl);
    }

    if (currentUrl) {
      navigate(currentUrl);
    } else {
      renderStartScreen();
      requestAnimationFrame(() => urlInput.focus());
    }
  }

  // -------------------------------------------------------------------------
  // 4. Terminal Pane (Real Python 3 PTY + xterm.js + SSE)
  // -------------------------------------------------------------------------
  function mountTerminalPane(view, leaf) {
    const cwd = leaf.state?.cwd || appState.activeWorkspace || '';
    view.titleEl.textContent = cwd ? `zsh — ${basename(cwd)}` : 'zsh';

    const host = document.createElement('div');
    host.className = 'term-host';
    view.body.appendChild(host);

    const term = new window.Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Monaco, Consolas, monospace',
      fontSize: 12.5,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      theme: getXtermTheme(),
    });

    const fitAddon = new window.FitAddon.FitAddon();
    term.loadAddon(fitAddon);

    // Clicking localhost / web URLs inside terminal automatically opens a split Web Preview pane!
    if (window.WebLinksAddon?.WebLinksAddon) {
      const linksAddon = new window.WebLinksAddon.WebLinksAddon((_event, uri) => {
        if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/i.test(uri)) {
          openPane('web', { url: uri }, { deduplicate: true });
        } else {
          window.open(uri, '_blank', 'noopener,noreferrer');
        }
      });
      term.loadAddon(linksAddon);
    }

    term.open(host);

    let termId = leaf.state?.termId || null;
    let eventSource = null;
    let destroyed = false;
    let resizeTimer = null;
    let exitedBanner = null;

    const btnQuoteTerm = makeMiniBtn(t('quoteBtn'), t('quoteTermTitle'), () => {
      const sel = term.getSelection()?.trim() || '';
      if (!sel) {
        showToast(t('quoteTermHint'));
        return;
      }
      sendDirectQuote({
        path: cwd || appState.activeWorkspace || '',
        title: `Terminal (${basename(cwd || appState.activeWorkspace || 'zsh')})`,
        selection: sel,
        isTerminal: true,
      });
    });
    btnQuoteTerm.classList.add('hidden');
    term.onSelectionChange(() => {
      const hasSel = Boolean(term.getSelection()?.trim());
      btnQuoteTerm.classList.toggle('hidden', !hasSel);
    });

    const btnClear = makeIconBtn('⌫', t('clearTermTitle'), () => term.clear());
    const btnNewTerm = makeIconBtn('+', t('newTermTitle'), () => {
      setActivePane(leaf.id);
      openPane('terminal', { cwd: cwd || appState.activeWorkspace });
    });
    view.customActions.append(btnQuoteTerm, btnClear, btnNewTerm);

    function fitAndSync() {
      if (destroyed) return;
      try {
        fitAddon.fit();
        if (termId && term.cols > 0 && term.rows > 0) {
          apiPost('/api/term/resize', { id: termId, cols: term.cols, rows: term.rows }).catch(() => {});
        }
      } catch {
        // ignore when hidden
      }
    }

    const ro = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(fitAndSync, 60);
    });
    ro.observe(host);

    term.onData((data) => {
      if (!termId || destroyed) return;
      apiPost('/api/term/input', { id: termId, data }).catch(() => {});
    });

    function showExitedBanner(code) {
      if (exitedBanner) exitedBanner.remove();
      exitedBanner = document.createElement('div');
      exitedBanner.className = 'term-banner';
      exitedBanner.innerHTML = `<span>${escapeHtml(t('termExited', { code }))}</span>`;
      const restartBtn = makeMiniBtn(t('restartTerm'), t('restartTermTitle'), () => {
        exitedBanner?.remove();
        exitedBanner = null;
        term.reset();
        termId = null;
        startOrAttach();
      }, true);
      exitedBanner.appendChild(restartBtn);
      view.body.appendChild(exitedBanner);
    }

    function connectStream(id) {
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      const streamUrl = withTokenUrl(`/api/term/stream?id=${encodeURIComponent(id)}`);
      const es = new EventSource(streamUrl);
      eventSource = es;

      es.addEventListener('data', (ev) => {
        try {
          const payload = JSON.parse(ev.data);
          if (payload.b64) {
            const binary = atob(payload.b64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            term.write(bytes);
          }
        } catch {
          // ignore
        }
      });

      es.addEventListener('exit', (ev) => {
        es.close();
        try {
          const payload = JSON.parse(ev.data);
          showExitedBanner(payload.code ?? 0);
        } catch {
          showExitedBanner(0);
        }
      });

      es.onerror = () => {
        if (destroyed) es.close();
      };
    }

    async function startOrAttach() {
      try {
        fitAddon.fit();
      } catch {}
      const cols = Math.max(20, term.cols || 80);
      const rows = Math.max(6, term.rows || 24);

      // Re-attach if persisted termId is still alive on backend
      if (termId) {
        try {
          const list = await apiGet('/api/term/list');
          const alive = (list.terminals || []).find((t) => t.id === termId && !t.exited);
          if (alive) {
            connectStream(termId);
            setTimeout(fitAndSync, 80);
            return;
          }
        } catch {}
        termId = null;
      }

      try {
        const created = await apiPost('/api/term/create', {
          cwd: cwd || appState.activeWorkspace || '',
          cols,
          rows,
        });
        termId = created.id;
        view.titleEl.textContent = `zsh — ${basename(created.cwd)}`;
        view.titleEl.title = created.cwd;
        appState.root = L.updateLeafState(appState.root, leaf.id, { termId, cwd: created.cwd });
        scheduleSaveState();
        connectStream(termId);
        setTimeout(() => {
          fitAndSync();
          term.focus();
        }, 80);
      } catch (err) {
        term.writeln(`\r\n[Split Workbench] ${t('termStartErr', { err: err.message })}`);
      }
    }

    view.onResize = fitAndSync;
    view.onThemeChange = () => {
      term.options.theme = getXtermTheme();
    };
    view.destroy = (explicitClose = false) => {
      destroyed = true;
      clearTimeout(resizeTimer);
      ro.disconnect();
      if (eventSource) eventSource.close();
      term.dispose();
      if (explicitClose && termId) {
        apiPost('/api/term/close', { id: termId }).catch(() => {});
      }
    };

    requestAnimationFrame(startOrAttach);
  }

  // -------------------------------------------------------------------------
  // Stage Reconciliation (Flat absolute layout — zero iframe reloads!)
  // -------------------------------------------------------------------------
  function renderStage() {
    const stageW = stageEl.clientWidth;
    const stageH = stageEl.clientHeight;
    if (stageW <= 0 || stageH <= 0) return;

    const geom = L.computeGeometry(appState.root, stageW, stageH, 6);
    lastGeometry = geom;

    const activeLeafIds = new Set(geom.leaves.keys());

    // 1. Remove stale views whose leaves were removed + sweep any orphan pane elements
    for (const [id, view] of paneViews.entries()) {
      if (!activeLeafIds.has(id)) {
        view.destroy(false);
        view.el.remove();
        paneViews.delete(id);
      }
    }
    for (const orphan of stageEl.querySelectorAll(':scope > section.pane')) {
      if (!activeLeafIds.has(orphan.dataset.paneId)) {
        orphan.remove();
      }
    }

    // 2. Mount new views and update geometry of all leaves in-place
    for (const [id, rect] of geom.leaves.entries()) {
      let view = paneViews.get(id);
      if (!view) {
        view = createPaneView(rect.leaf);
        paneViews.set(id, view);
        stageEl.appendChild(view.el);
      }
      const isMax = appState.maximizedPaneId === id;
      const isHiddenByMax = Boolean(appState.maximizedPaneId) && !isMax;

      view.el.classList.toggle('active', appState.activePaneId === id);
      view.el.classList.toggle('maximized', isMax);
      applyPaneColorToEl(view.el, rect.leaf.state?.color || '');
      const parentSplit = L.findParentSplit(appState.root, id);
      if (view.btnToggleDir) {
        view.btnToggleDir.classList.toggle('hidden', !parentSplit || isMax);
        if (parentSplit) {
          const isHoriz = parentSplit.direction === 'horizontal';
          view.btnToggleDir.textContent = isHoriz ? '⇅' : '⇄';
          view.btnToggleDir.title = isHoriz
            ? t('toggleDirToVert')
            : t('toggleDirToHoriz');
        }
      }
      view.btnMax.textContent = isMax ? '⤡' : '⤢';
      view.btnMax.title = isMax ? t('restoreTitle') : t('maxTitle');

      if (isMax) {
        view.el.style.left = '0px';
        view.el.style.top = '0px';
        view.el.style.width = `${stageW}px`;
        view.el.style.height = `${stageH}px`;
        view.el.style.visibility = 'visible';
        view.el.style.pointerEvents = 'auto';
      } else {
        view.el.style.left = `${rect.x}px`;
        view.el.style.top = `${rect.y}px`;
        view.el.style.width = `${rect.w}px`;
        view.el.style.height = `${rect.h}px`;
        view.el.style.visibility = isHiddenByMax ? 'hidden' : 'visible';
        view.el.style.pointerEvents = isHiddenByMax ? 'none' : 'auto';
      }
    }

    // 3. Reconcile split gutters
    const activeGutterIds = new Set(geom.gutters.map((g) => g.id));
    for (const [id, el] of gutterEls.entries()) {
      if (!activeGutterIds.has(id)) {
        el.remove();
        gutterEls.delete(id);
      }
    }

    for (const g of geom.gutters) {
      let gel = gutterEls.get(g.id);
      if (!gel) {
        gel = document.createElement('div');
        gel.className = `gutter ${g.direction}`;
        gel.dataset.splitId = g.id;
        attachGutterDrag(gel, g.id);
        gutterEls.set(g.id, gel);
        stageEl.appendChild(gel);
      }
      gel.className = `gutter ${g.direction}`;
      gel.style.left = `${g.x}px`;
      gel.style.top = `${g.y}px`;
      gel.style.width = `${g.w}px`;
      gel.style.height = `${g.h}px`;
      gel.style.display = appState.maximizedPaneId ? 'none' : 'flex';
    }
  }

  function attachGutterDrag(gel, splitId) {
    gel.title = t('gutterTitle');
    gel.addEventListener('dblclick', () => {
      appState.root = L.updateSplitRatio(appState.root, splitId, 0.5);
      renderStage();
      scheduleSaveState();
    });
    gel.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const splitNode = L.findSplit(appState.root, splitId);
      if (!splitNode) return;
      const nextDir = splitNode.direction === 'horizontal' ? 'vertical' : 'horizontal';
      appState.root = L.toggleSplitDirection(appState.root, splitId);
      renderStage();
      scheduleSaveState();
      showToast(nextDir === 'horizontal' ? t('switchedHoriz') : t('switchedVert'), 1400);
    });

    gel.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const splitGeom = lastGeometry.gutters.find((g) => g.id === splitId);
      if (!splitGeom) return;
      const stageRect = stageEl.getBoundingClientRect();
      const { direction, parentRect } = splitGeom;

      gel.classList.add('dragging');
      dragShieldEl.className = `drag-shield ${direction === 'horizontal' ? 'col-resize' : 'row-resize'}`;

      let rafId = null;
      const onMove = (ev) => {
        if (rafId) return;
        rafId = requestAnimationFrame(() => {
          rafId = null;
          let ratio;
          if (direction === 'horizontal') {
            const relX = ev.clientX - stageRect.left - parentRect.x;
            ratio = relX / Math.max(1, parentRect.w);
          } else {
            const relY = ev.clientY - stageRect.top - parentRect.y;
            ratio = relY / Math.max(1, parentRect.h);
          }
          appState.root = L.updateSplitRatio(appState.root, splitId, ratio);
          renderStage();
        });
      };

      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        gel.classList.remove('dragging');
        dragShieldEl.className = 'drag-shield hidden';
        scheduleSaveState();
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }

  new ResizeObserver(() => renderStage()).observe(stageEl);

  // -------------------------------------------------------------------------
  // Quick File Picker Modal
  // -------------------------------------------------------------------------
  let pickerDir = '';
  let pickerItems = [];
  let pickerSelectedIdx = 0;
  let pickerSearchTimer = null;

  function openFilePicker(replaceCurrent = false) {
    fileReplaceCheckbox.checked = Boolean(replaceCurrent);
    fileModalEl.classList.remove('hidden');
    fileSearchInput.value = '';
    pickerDir = appState.activeWorkspace || '';

    // Show active pane split hint
    const rect = getActiveLeafRect();
    const nextDir = L.decideSplitDirection({ width: rect.w, height: rect.h }, appState.splitMode);
    $('file-split-hint').textContent = fileReplaceCheckbox.checked
      ? t('fileReplaceHint')
      : (nextDir === 'horizontal' ? t('fileSplitHintHoriz') : t('fileSplitHintVert'));

    renderWorkspaceSwitcher();
    loadDirectoryIntoPicker(pickerDir);
    requestAnimationFrame(() => fileSearchInput.focus());
  }

  function closeFilePicker() {
    fileModalEl.classList.add('hidden');
  }

  function renderWorkspaceSwitcher() {
    fileWsSwitcherEl.innerHTML = '';
    if (appState.workspaces.length <= 1) return;
    for (const ws of appState.workspaces) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `crumb-btn${ws === appState.activeWorkspace ? ' active' : ''}`;
      b.textContent = basename(ws);
      b.addEventListener('click', () => {
        appState.activeWorkspace = ws;
        pickerDir = ws;
        loadDirectoryIntoPicker(ws);
      });
      fileWsSwitcherEl.appendChild(b);
    }
  }

  async function loadDirectoryIntoPicker(dir) {
    try {
      const res = await apiGet(`/api/fs/list?dir=${encodeURIComponent(dir || '')}`);
      pickerDir = res.dir;
      renderBreadcrumb(res.dir, res.parent);
      pickerItems = [];
      if (res.parent) {
        pickerItems.push({ name: '..', path: res.parent, isDir: true, rel: t('parentDir') });
      }
      for (const e of res.entries) {
        pickerItems.push({
          name: e.name,
          path: e.path,
          isDir: e.isDir,
          rel: e.isDir ? t('dirLabel') : formatBytes(e.size),
        });
      }
      pickerSelectedIdx = 0;
      renderPickerList();
    } catch (err) {
      fileListEl.innerHTML = `<div class="empty-pane"><div class="empty-desc">${escapeHtml(err.message)}</div></div>`;
    }
  }

  async function runPickerSearch(q) {
    const root = appState.activeWorkspace || pickerDir;
    try {
      const res = await apiGet(`/api/fs/search?root=${encodeURIComponent(root)}&q=${encodeURIComponent(q)}`);
      pickerItems = (res.items || []).map((it) => ({
        name: it.name,
        path: it.path,
        isDir: false,
        rel: it.rel,
      }));
      pickerSelectedIdx = 0;
      renderPickerList();
    } catch {
      // ignore
    }
  }

  function renderBreadcrumb(dir, parent) {
    fileBreadcrumbEl.innerHTML = '';
    const parts = dir.split('/').filter(Boolean);
    const tail = parts.slice(-3);
    if (parts.length > 3 && parent) {
      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'crumb-btn';
      up.textContent = '…';
      up.title = parent;
      up.addEventListener('click', () => loadDirectoryIntoPicker(parent));
      fileBreadcrumbEl.appendChild(up);
    }
    tail.forEach((seg, idx) => {
      const sepEl = document.createElement('span');
      sepEl.textContent = '/';
      fileBreadcrumbEl.appendChild(sepEl);
      const target = '/' + parts.slice(0, parts.length - tail.length + idx + 1).join('/');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'crumb-btn';
      btn.textContent = seg;
      btn.addEventListener('click', () => loadDirectoryIntoPicker(target));
      fileBreadcrumbEl.appendChild(btn);
    });
  }

  function formatBytes(n) {
    if (!n) return '0 B';
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  }

  function selectPickerItem(item, forceReplace = false) {
    if (!item) return;
    if (item.isDir) {
      fileSearchInput.value = '';
      loadDirectoryIntoPicker(item.path);
      return;
    }
    closeFilePicker();
    openPane('file', { path: item.path }, {
      forceDirection: (forceReplace || fileReplaceCheckbox.checked) ? 'replace' : null,
      deduplicate: !(forceReplace || fileReplaceCheckbox.checked),
    });
  }

  function renderPickerList() {
    fileListEl.innerHTML = '';
    if (pickerItems.length === 0) {
      fileListEl.innerHTML = `<div class="empty-pane"><div class="empty-desc">${escapeHtml(t('noMatches'))}</div></div>`;
      return;
    }
    pickerItems.forEach((item, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `list-item${idx === pickerSelectedIdx ? ' selected' : ''}`;
      btn.innerHTML = `<span>${item.isDir ? '📁' : '📄'}</span><span class="list-item-name">${escapeHtml(item.name)}</span><span class="list-item-rel">${escapeHtml(item.rel)}</span>`;
      btn.addEventListener('click', (e) => selectPickerItem(item, e.shiftKey));
      fileListEl.appendChild(btn);
    });
  }

  fileSearchInput.addEventListener('input', () => {
    clearTimeout(pickerSearchTimer);
    const q = fileSearchInput.value.trim();
    if (!q) {
      loadDirectoryIntoPicker(pickerDir);
      return;
    }
    pickerSearchTimer = setTimeout(() => runPickerSearch(q), 90);
  });

  fileSearchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeFilePicker();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      pickerSelectedIdx = Math.min(pickerItems.length - 1, pickerSelectedIdx + 1);
      renderPickerList();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      pickerSelectedIdx = Math.max(0, pickerSelectedIdx - 1);
      renderPickerList();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      selectPickerItem(pickerItems[pickerSelectedIdx], e.shiftKey);
    }
  });

  $('file-modal-close').addEventListener('click', closeFilePicker);
  fileModalEl.addEventListener('click', (e) => {
    if (e.target === fileModalEl) closeFilePicker();
  });

  // -------------------------------------------------------------------------
  // Chat Links Live Extraction & Popover
  // -------------------------------------------------------------------------
  let initialChatSyncDone = false;

  async function pollChatLinks() {
    const id = convId();
    if (!id) return;
    try {
      const data = await apiGet(`/api/chat-links?conversationId=${encodeURIComponent(id)}`);
      const files = data.files || [];
      const urls = data.urls || [];
      appState.chatLinks = { files, urls };

      const total = files.length + urls.length;
      chatLinksBadge.textContent = String(total);
      chatLinksBadge.classList.toggle('hidden', total === 0);

      // Detect newly added items for optional Auto-Open mode
      const newFiles = [];
      const newLocalUrls = [];
      for (const f of files) {
        const key = `file:${f.path}`;
        if (!appState.seenChatKeys.has(key)) {
          appState.seenChatKeys.add(key);
          if (initialChatSyncDone && (f.source === 'chat' || f.source === 'edited')) {
            newFiles.push(f);
          }
        }
      }
      for (const u of urls) {
        const key = `url:${u.url}`;
        if (!appState.seenChatKeys.has(key)) {
          appState.seenChatKeys.add(key);
          if (initialChatSyncDone && u.isLocal) {
            newLocalUrls.push(u);
          }
        }
      }
      initialChatSyncDone = true;

      if (appState.autoOpenChatLinks) {
        for (const f of newFiles.slice(0, 2)) {
          openPane('file', { path: f.path, line: f.line, endLine: f.endLine }, { deduplicate: true });
        }
        for (const u of newLocalUrls.slice(0, 1)) {
          openPane('web', { url: u.url }, { deduplicate: true });
        }
      }

      if (!chatLinksPopover.classList.contains('hidden')) {
        renderChatLinksPopover();
      }
    } catch {
      // ignore
    }
  }

  function renderChatLinksPopover() {
    chatLinksBody.innerHTML = '';
    const { files, urls } = appState.chatLinks;
    if (files.length === 0 && urls.length === 0) {
      chatLinksBody.innerHTML = `<div class="muted" style="padding:12px;text-align:center;">${t('noChatLinks')}</div>`;
      return;
    }

    if (urls.length > 0) {
      const sec = document.createElement('div');
      sec.innerHTML = `<div class="section-label">${escapeHtml(t('urlsHeader', { n: urls.length }))}</div>`;
      for (const u of urls) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'list-item';
        btn.innerHTML = `<span>🌐</span><span class="list-item-name">${escapeHtml(u.host)}</span><span class="list-item-rel">${escapeHtml(u.path)}</span><span class="source-tag">${escapeHtml(u.isLocal ? t('tagLocal') : t('tagExternal'))}</span>`;
        btn.title = u.url;
        btn.addEventListener('click', (e) => {
          chatLinksPopover.classList.add('hidden');
          chatLinksBtn.classList.remove('active');
          openPane('web', { url: u.url }, { deduplicate: !e.shiftKey });
        });
        sec.appendChild(btn);
      }
      chatLinksBody.appendChild(sec);
    }

    if (files.length > 0) {
      const sec = document.createElement('div');
      sec.innerHTML = `<div class="section-label">${escapeHtml(t('filesHeader', { n: files.length }))}</div>`;
      for (const f of files) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'list-item';
        const lineTag = f.line ? `#L${f.line}${f.endLine ? '-' + f.endLine : ''}` : '';
        const srcText = f.source === 'chat' ? t('srcChat') : f.source === 'edited' ? t('srcEdited') : t('srcRead');
        btn.innerHTML = `<span>📄</span><span class="list-item-name">${escapeHtml(f.name)}${escapeHtml(lineTag)}</span><span class="list-item-rel">${escapeHtml(f.path)}</span><span class="source-tag">${srcText}</span>`;
        btn.title = f.path;
        btn.addEventListener('click', (e) => {
          chatLinksPopover.classList.add('hidden');
          chatLinksBtn.classList.remove('active');
          openPane('file', { path: f.path, line: f.line, endLine: f.endLine }, { deduplicate: !e.shiftKey });
        });
        sec.appendChild(btn);
      }
      chatLinksBody.appendChild(sec);
    }
  }

  chatLinksBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isHidden = chatLinksPopover.classList.contains('hidden');
    chatLinksPopover.classList.toggle('hidden', !isHidden);
    chatLinksBtn.classList.toggle('active', isHidden);
    if (isHidden) {
      renderChatLinksPopover();
      pollChatLinks();
    }
  });

  $('chat-links-refresh').addEventListener('click', () => pollChatLinks());
  autoOpenChatCheckbox.addEventListener('change', () => {
    appState.autoOpenChatLinks = autoOpenChatCheckbox.checked;
    scheduleSaveState();
    showToast(appState.autoOpenChatLinks ? t('autoOpenOn') : t('autoOpenOff'));
  });

  document.addEventListener('click', (e) => {
    if (!chatLinksPopover.classList.contains('hidden') && !chatLinksPopover.contains(e.target) && e.target !== chatLinksBtn) {
      chatLinksPopover.classList.add('hidden');
      chatLinksBtn.classList.remove('active');
    }
  });

  // -------------------------------------------------------------------------
  // Toolbar & Keyboard Shortcuts
  // -------------------------------------------------------------------------
  $('btn-add-file').addEventListener('click', () => openFilePicker(false));
  $('btn-add-web').addEventListener('click', () => openPane('web', {}));
  $('btn-add-term').addEventListener('click', () => openPane('terminal', { cwd: appState.activeWorkspace }));
  $('btn-add-artifact').addEventListener('click', () => openPane('artifact', {}));
  $('btn-reset-ratios').addEventListener('click', () => {
    appState.root = L.resetAllRatios(appState.root);
    renderStage();
    scheduleSaveState();
    showToast(t('resetRatiosToast'));
  });

  document.querySelectorAll('.sm-btn').forEach((btn) => {
    btn.addEventListener('click', () => setSplitMode(btn.dataset.splitMode));
  });

  window.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && !e.shiftKey && e.key.toLowerCase() === 'p') {
      e.preventDefault();
      openFilePicker(false);
    } else if (mod && e.shiftKey && e.key === '\\') {
      e.preventDefault();
      openPane('empty', {}, { forceDirection: 'horizontal' });
    } else if (mod && e.shiftKey && e.key === '-') {
      e.preventDefault();
      openPane('empty', {}, { forceDirection: 'vertical' });
    } else if (mod && e.shiftKey && e.key.toLowerCase() === 'r') {
      e.preventDefault();
      if (appState.activePaneId) togglePaneSplitOrientation(appState.activePaneId);
    } else if (mod && e.shiftKey && e.key === 'Enter') {
      e.preventDefault();
      if (appState.activePaneId) toggleMaximize(appState.activePaneId);
    } else if (e.key === 'Escape' && !fileModalEl.classList.contains('hidden')) {
      closeFilePicker();
    }
  });

  // -------------------------------------------------------------------------
  // Bootstrap: Theme + Workspace Sync + Initial State + Pollers
  // -------------------------------------------------------------------------
  async function init() {
    I18N.applyDom(document);
    syncTheme();

    const applyWorkspaces = (uris) => {
      const paths = (uris || []).map(uriToPath).filter(Boolean);
      const prevActive = appState.activeWorkspace;
      appState.workspaces = paths;
      if (paths.length > 0 && !paths.includes(appState.activeWorkspace)) {
        appState.activeWorkspace = paths[0];
      }
      if (prevActive !== appState.activeWorkspace) {
        loadPersistedState();
      }
    };

    if (window.sidecar?.onWorkspaceChange) {
      window.sidecar.onWorkspaceChange(applyWorkspaces);
    }
    try {
      const initialUris = window.sidecar?.getWorkspaceUris
        ? await Promise.race([
            window.sidecar.getWorkspaceUris(),
            new Promise((r) => setTimeout(() => r([]), 500)),
          ])
        : [];
      if (initialUris.length > 0) {
        applyWorkspaces(initialUris);
      } else if (urlParams.get('workspace')) {
        applyWorkspaces([urlParams.get('workspace')]);
      } else {
        await loadPersistedState();
      }
    } catch {
      await loadPersistedState();
    }

    // Handle optional URL query params (?openFile=... / ?openUrl=...)
    const openFileParam = urlParams.get('openFile');
    const openUrlParam = urlParams.get('openUrl');
    if (openFileParam) openPane('file', { path: openFileParam }, { deduplicate: true });
    if (openUrlParam) openPane('web', { url: openUrlParam }, { deduplicate: true });

    await pollChatLinks();
    setInterval(() => {
      if (!document.hidden) pollChatLinks();
    }, 3000);
  }

  init();
})();
