# DropICS Privacy Policy

_Last updated: November 22, 2026_

DropICS ("the extension") is a Chrome extension that helps you import `.ics` and `.csv` calendar files into Google Calendar. This policy explains what data the extension touches and what it does with it.

## Summary

- DropICS does **not** collect, sell, share, or transmit your personal data to the developer or any third party.
- DropICS has **no backend server**, no analytics, no telemetry, and no advertising.
- DropICS does **not** use OAuth or request access to your Google account. It works through the Google Calendar web page you already have open in your browser.

## Data the extension handles

| Data | Where it goes | How long it is kept |
| :--- | :--- | :--- |
| Contents of `.ics` / `.csv` files you drop, pick, or right-click | Parsed locally in your browser to show a preview, then handed to Google Calendar's own Import page (`calendar.google.com`) in your browser | Held temporarily in `chrome.storage.session` only while an import is in progress, then removed. Session storage is also cleared when the browser closes. |
| Your preferred target calendar name | `chrome.storage.sync` (synced by Chrome across your own signed-in browsers, if Chrome Sync is enabled) | Until you change it or uninstall the extension |
| List of your writable calendar names (read from the Google Calendar page) | `chrome.storage.local` on your device | Until refreshed, or until you uninstall the extension |

Imported events end up in your Google Calendar exactly as if you had used Google Calendar's built-in **Import** feature. Google's handling of that data is governed by [Google's Privacy Policy](https://policies.google.com/privacy).

## Network requests

DropICS makes network requests only in these cases:

1. Pages on `https://calendar.google.com/` that the extension opens or interacts with in your browser to perform the import.
2. When **you** right-click a `.ics` / `.csv` link and choose **Import .ics to Google Calendar**, the extension downloads that one file from the link's URL using your current browser session (`activeTab`). The file is not sent anywhere except into Google Calendar's Import page.

No other requests are made, and nothing is sent to the developer.

## Permissions

| Permission | Why it is needed |
| :--- | :--- |
| `https://calendar.google.com/*` | Add the Import button, drag-and-drop overlay, and preview dialog to Google Calendar, and run the import on Google Calendar's Import page. |
| `storage` | Save your target calendar preference and calendar list locally, and hold files temporarily during an import. |
| `scripting` | Attach your file to Google Calendar's Import page and read your writable calendar names. |
| `contextMenus` | Show the right-click **Import .ics to Google Calendar** menu item on links. |
| `activeTab` | Download a right-clicked `.ics` link only when you explicitly choose the menu item, instead of requesting access to all websites. |

## Removing your data

Uninstalling the extension from `chrome://extensions` deletes everything it stored.

## Open source

The full source code is available at [github.com/patpat9/dropics](https://github.com/patpat9/dropics) so you can verify the behavior described here.

## Changes and contact

If this policy changes, the updated version will be published in this file with a new date. Questions or concerns can be raised via [GitHub Issues](https://github.com/patpat9/dropics/issues).
