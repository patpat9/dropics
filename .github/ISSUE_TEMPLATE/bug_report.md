---
name: Bug report
about: Something isn't working as expected
title: "[Bug] "
labels: bug
assignees: ''
---

## What happened

<!-- A clear description of the problem. -->

## Steps to reproduce

1. 
2. 
3. 

## Expected behavior

<!-- What did you expect to happen instead? -->

## Which import method?

- [ ] Top-half drop (preview & pick calendar)
- [ ] Bottom-half drop (quick import)
- [ ] Header Import button / `Alt+Click`
- [ ] `Alt+I` file picker
- [ ] Right-click `.ics` link on a webpage
- [ ] Extension popup (calendar list / sync)

## Environment

- **DropICS version** (see `chrome://extensions`): 
- **Chrome version** (see `chrome://version`, e.g. `131.0.6778.86`): 
- **OS**: <!-- Windows 11 / macOS 15 / ChromeOS / Linux -->
- **Google Calendar language**: <!-- e.g. English, 简体中文 -->
- **Google Calendar theme**: <!-- Light / Dark -->
- **Multiple Google accounts signed in?** <!-- Yes / No (e.g. using /u/1/) -->

## Sample file (please redact personal data)

If the problem is related to a specific `.ics` / `.csv` file, attach or paste a **minimal, redacted** sample.
Before sharing, please replace names, emails, phone numbers, addresses, meeting links, and descriptions with placeholder text. Keep the structure (`BEGIN:VEVENT`, `DTSTART`, `TZID`, `RRULE`, etc.) intact since that is usually what matters.

<details>
<summary>Redacted sample</summary>

```text
BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:example-1@example.com
DTSTART;TZID=America/Los_Angeles:20261123T100000
DTEND;TZID=America/Los_Angeles:20261123T110000
SUMMARY:Sample Event
LOCATION:Room A
END:VEVENT
END:VCALENDAR
```

</details>

## Console errors (optional)

<!--
Open DevTools on the Google Calendar tab (F12 -> Console) and paste any red errors mentioning DropICS.
For background errors: chrome://extensions -> DropICS -> "service worker" -> Console.
-->

## Screenshots (optional)

<!-- Please blur any personal calendar events. -->
