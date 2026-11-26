<p align="center">
  <img src="./assets/logo.svg" width="84" height="84" alt="Split Workbench Logo" />
</p>

<h1 align="center">Split Workbench for Google Antigravity</h1>

<p align="center">
  A smart BSP auto-splitting side-pane workbench plugin for Antigravity App — view files, web previews (<code>localhost</code> &amp; zero-server local HTML), real interactive PTY terminals, and session artifacts side-by-side or stacked.
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="./assets/demo-dark.png" />
    <source media="(prefers-color-scheme: light)" srcset="./assets/demo-light.png" />
    <img src="./assets/demo-light.png" width="100%" alt="Split Workbench 3-pane demo showing syntax-highlighted file with Quote popover, zero-server HTML preview, and interactive PTY terminal" />
  </picture>
</p>

<details>
<summary>View both Light &amp; Dark theme previews</summary>

| Light Theme | Dark Theme |
| :---: | :---: |
| ![Split Workbench Light Theme](./assets/demo-light.png) | ![Split Workbench Dark Theme](./assets/demo-dark.png) |

</details>

---

## Features / 核心特性

- **Smart Auto-Split BSP Layout（智能自动分屏）**: Automatically decides whether to split **left/right** or **top/bottom** based on the focused pane's aspect ratio (`width > height × 1.1` → horizontal, else vertical), plus manual **Auto / Horizontal / Vertical** mode toggles.
- **Per-Pane Split Orientation Toggle（单窗口自由切换横/竖）**: Click `⇅` / `⇄` on any pane header, press `⌘⇧R`, or right-click any divider to flip that pane group between left/right and top/bottom in place.
- **Zero-Reload Flat Geometry（零重载分屏与拖拽）**: Resizing gutters, splitting panes, maximizing, or dragging pane headers to swap positions never reloads open `<iframe>` previews or disconnects running PTY terminals.
- **Per-Pane Colors（分屏颜色标记）**: Automatically assigns distinct harmonious colors to each new split pane; click any pane's color dot to choose from 8 presets, pick any custom hex color, or clear color.
- **4 Built-in Pane Types（四种内置面板）**:
  - **Files**: Fuzzy workspace file search (`⌘P`) & directory browser, syntax highlighting, Markdown preview/source toggle, image & PDF viewer, live disk auto-reload, optional lightweight inline editing (`⌘S`), and a native-style `⋮` menu (**Copy Content**, **Download File**, **Copy Path**, **In-file Search `⌘F`**, **Reveal in Finder**).
  - **Web Preview**: Back/Forward/Reload history, auto-discovery of listening `localhost` dev ports (`lsof`), quick port input (`5173`), **zero-server local `.html` preview** (HMAC-scoped `/preview/` routes), plus a full native-style browser toolbar (**Download HTML**, **Element Inspector & Quote** for local HTML previews, **Headless Screenshot & Quote** with one-click split view/download, and **Open External**).
  - **Real Interactive Terminal**: Zero-native-build PTY shell powered by Python 3 `pty` + offline-vendored `xterm.js` (256-color, resize-aware, multi-terminal, clicking `http://localhost:...` opens a split Web Preview pane automatically).
  - **Session Artifacts**: Automatically follows `window.sidecar.conversationId` to browse and live-preview files in `<appData>/brain/<conversationId>/`.
- **Quote & Chat Links（划词/点行号 Quote & 对话链接捕获）**:
  - Select text or click / `Shift+Click` line numbers to pop a floating **Quote / 提问 / 复制** toolbar (`addArtifactComment` + clipboard + `⌘Enter` direct send via `agent.sendMessage`). Terminal selections also support one-click Quote.
  - **Chat Links** badge watches the current conversation's `transcript.jsonl` to surface files (`#L` line jumps) and URLs mentioned by the agent for one-click split opening.
- **100% Offline Frontend Assets, Auto EN/ZH UI & Native Theme Sync**: `xterm.js`, `marked`, and `highlight.js` are vendored locally; UI automatically matches English or Chinese locale (`?lang=en|zh`) and Antigravity Light/Dark themes.

---

## Installation / 安装方式

### Option 1: Antigravity App (Recommended)

Clone directly into your global Antigravity plugins directory:

```bash
git clone https://github.com/RZRZ-Q/antigravity-split-workbench.git ~/.gemini/config/plugins/split-workbench
```

Antigravity automatically discovers and starts the plugin without restarting the app:
1. Verify **Split Workbench** is enabled under **Customizations → Installed**.
2. Click **`+`** in the right-hand auxiliary pane header and choose **Split**.

### Option 2: Antigravity CLI (`agy`)

```bash
agy plugin install https://github.com/RZRZ-Q/antigravity-split-workbench
```

### Option 3: Local Development Symlink

```bash
git clone https://github.com/RZRZ-Q/antigravity-split-workbench.git
ln -s "$(pwd)/antigravity-split-workbench" ~/.gemini/config/plugins/split-workbench
```

---

## Keyboard Shortcuts / 快捷键

| Shortcut | Action |
| :--- | :--- |
| `⌘P` / `Ctrl+P` | Quick-open workspace file (auto-splits) |
| `⌘F` / `Ctrl+F` | In-file search inside the active File / Artifact pane |
| `⌘⇧R` / `Ctrl+Shift+R` | Toggle active pane's split between left/right and top/bottom |
| `⌘⇧\` / `Ctrl+Shift+\` | Split right (new empty pane) |
| `⌘⇧-` / `Ctrl+Shift+-` | Split down (new empty pane) |
| `⌘⇧Enter` | Maximize / restore active pane |
| Click / `Shift+Click` line number | Select line(s) and open floating Quote bar |
| Double-click gutter | Reset split ratio to 50/50 |
| Right-click gutter | Flip that split between horizontal and vertical |

---

## Requirements & Architecture

- **Runtime**: Node.js >= 20, Python 3 (built-in `pty` module; macOS / Linux).
- **Security**: Binds strictly to `127.0.0.1`, enforces `X-Sidecar-Token` on API & PTY endpoints, restricts filesystem access to user home/temp paths, and scopes local HTML previews with per-directory HMAC signatures.

### Run Tests & Standalone Debug

```bash
# Run layout unit tests + live HTTP / Auth / FS / PTY SSE smoke tests
node test/smoke.mjs

# Standalone local browser preview
ANTIGRAVITY_SIDECAR_WEB_PORT=49188 node sidecars/workbench/main.mjs
# Open http://127.0.0.1:49188/?workspace=/path/to/your/project
```

## License

[MIT](./LICENSE)
