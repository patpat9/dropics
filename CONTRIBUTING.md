# Contributing to DropICS

Thanks for your interest in improving DropICS. Bug reports, translations, and pull requests are all welcome.

## Reporting bugs and ideas

- Use the [issue templates](https://github.com/patpat9/dropics/issues/new/choose).
- For bugs, include your Chrome version and, if a specific file is involved, a **redacted** `.ics` / `.csv` sample. Please strip names, emails, links, and descriptions before posting.

## Development setup

No build step or dependencies are needed. The extension is plain JavaScript, HTML, and CSS.

1. Fork and clone the repo:
   ```bash
   git clone https://github.com/<your-username>/dropics.git
   ```
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select the repo folder.
3. Open or refresh `https://calendar.google.com`.
4. After editing code, click the reload icon on the DropICS card in `chrome://extensions`, then **refresh the Google Calendar tab** so the new content script is injected.

Debugging tips:

- Content script (`content.js`): DevTools on the Google Calendar tab.
- Service worker (`background.js`): `chrome://extensions` -> DropICS -> **service worker**.
- Popup (`popup.js`): right-click the toolbar icon -> **Inspect popup**.
- `store_assets/conference_schedule.ics` is a safe sample file for testing.

## Before opening a pull request

Run the validator (Node 18+):

```bash
node scripts/validate.js
```

It checks `manifest.json`, JS syntax, that all 11 locales have the same keys with none unused, Chrome Web Store length limits, and the `.ics` / `.csv` parser tests. CI runs the same script on every PR.

## Guidelines

- **Keep it zero-OAuth and server-free.** DropICS works through the user's existing Google Calendar page. Please don't add external network calls, analytics, or remote code.
- **Keep permissions minimal.** Avoid adding new permissions or host patterns, especially `<all_urls>`. If one is truly necessary, explain why in the PR and update [PRIVACY.md](PRIVACY.md).
- **Localize every string.** Add new UI text to `_locales/en/messages.json` and all other 10 locales. If you can't translate a language, copying the English text is fine; mention it in the PR so a native speaker can follow up.
- **Respect Google Calendar's look.** UI additions should feel native in both light and dark themes.
- **Small, focused PRs** are easier to review than large mixed ones.

## Translations

Locale files live in `_locales/<code>/messages.json`. Improvements to existing translations are very welcome. Note the store limits enforced by the validator: `extName` <= 75 characters and `extDescription` <= 132 characters.

## Releases (maintainers)

1. Bump `version` in `manifest.json` and commit.
2. Tag and push; the release workflow validates the tag against `manifest.json` and publishes `dropics-v<version>.zip`:
   ```bash
   git tag -a v1.2.1 -m "DropICS v1.2.1"
   git push origin v1.2.1
   ```

## License

By contributing, you agree that your contributions are licensed under the [AGPL-3.0](LICENSE) license of this project.
