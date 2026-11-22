# Security Policy

## Supported versions

Only the latest release of DropICS (as published on the Chrome Web Store and [GitHub Releases](https://github.com/patpat9/dropics/releases)) receives security fixes.

| Version | Supported |
| :--- | :---: |
| Latest (`1.2.x`) | Yes |
| Older | No |

## Reporting a vulnerability

**Please do not report security issues in public GitHub Issues, Discussions, or pull requests.**

Report them privately through GitHub's **Private Vulnerability Reporting**:

1. Go to the [Security tab](https://github.com/patpat9/dropics/security) of this repository.
2. Click **Report a vulnerability**.
3. Describe the issue, affected version, Chrome version, and steps to reproduce. A proof of concept is helpful but not required. Please redact any personal calendar data.

You can expect an initial response within **7 days**. Once a fix is ready, it will be released as a new version and the reporter will be credited in the advisory unless they prefer to stay anonymous.

## Scope

Examples of issues we want to hear about:

- Ways for a web page or a crafted `.ics` / `.csv` file to execute script in the extension or in Google Calendar (e.g. XSS through event titles or locations in the preview dialog).
- The extension sending calendar data anywhere other than the user's own Google Calendar.
- Permissions being used beyond what is described in [PRIVACY.md](PRIVACY.md).
- Importing into a calendar other than the one the user selected.

Out of scope:

- Vulnerabilities in Google Calendar or Chrome itself (please report those to [Google](https://bughunters.google.com/)).
- Issues that require a compromised browser or a malicious extension already installed.
