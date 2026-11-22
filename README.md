# GCal Quick Import

Chrome extension (Manifest V3, zero OAuth) that adds an **Import** shortcut to the Google Calendar toolbar, split-screen `.ics` / `.csv` drag-and-drop importing, in-page event preview + calendar selection, right-click `.ics` link importing, and multi-file quick import (`Alt+I`).

## Features

1. **Top Toolbar Shortcut**: Adds a native Material-style **Import** button next to the Search icon in Google Calendar's header (normal click opens Import & Export; Ctrl/Cmd-click opens in a new tab; `Alt+Click` opens the multi-file `.ics` picker directly).
2. **Split-Screen Drag & Drop (Light & Dark Theme Aware)**:
   - **Top Half (Preview & Pick Calendar)**: Opens an in-page preview modal showing event titles, times, and locations with a dropdown of your writable calendars, then imports in the background without leaving the main page (supports multiple files; includes a fallback link to the native `/settings/export` page).
   - **Bottom Half (Quick Import)**: Silently imports into your target calendar via a background tab without leaving the main page, auto-closes the tab when done, and jumps to the earliest imported event's date.
3. **Auto-Detected Writable Calendar List**: Automatically reads your calendars from the Google Calendar `My calendars` section and syncs strictly with the `/settings/export` dropdown (with an on-demand sync button in the popup).
4. **Right-Click Web `.ics` Links**: Right-click any `.ics` / `.csv` link on any webpage and select **Import .ics to Google Calendar** to fetch (using your active tab session, no `<all_urls>` needed) and import in the background.
5. **Multi-File Picker & Shortcut (`Alt+I`)**: Press `Alt+I` (or `Alt+Click` the toolbar icon) to select one or multiple `.ics` / `.csv` files, preview all events, choose the target calendar, and batch-import them sequentially.
6. **i18n**: 11 built-in locales (`en`, `es`, `zh_CN`, `pt_BR`, `ja`, `de`, `fr`, `ru`, `ko`, `zh_TW`, `it`) covering ~85% of Chrome desktop users.

## Local Installation

1. Open `chrome://extensions/` in Chrome.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this folder (`chrome_gcal_import`).
4. Refresh your open Google Calendar tab (`https://calendar.google.com`).
