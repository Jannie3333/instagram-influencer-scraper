# Instagram Influencer Scraper

A local Express web app for collecting Instagram creator/profile leads.

## Features

- Local browser UI
- Profile scraping by username or profile URL
- Hashtag discovery with Playwright browser fallback
- Cookie support for logged-in Instagram sessions
- Deduplication by username
- XLSX autosave and CSV export
- Basic profile fields: username, full name, followers, following, post count, email, bio links, biography, verification status, privacy status, category, source tag

## Start

```powershell
powershell -ExecutionPolicy Bypass -File .\start-local.ps1
```

Then open:

```text
http://localhost:5176
```

## Cookies

Instagram often requires login cookies. You can either paste a normal cookie header into the UI:

```text
sessionid=...; csrftoken=...; ds_user_id=...
```

Or point the server at a browser-exported Netscape cookies file:

```powershell
$env:IG_COOKIE_FILE = "C:\path\to\cookies.txt"
powershell -ExecutionPolicy Bypass -File .\start-local.ps1
```

The scraper automatically converts Netscape/TSV cookie exports into the cookie header format used by HTTP and Playwright.

## Playwright Chromium

Hashtag search uses Playwright. If Chromium is not installed yet, run:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = ".\pw-browsers"
.\node_modules\.bin\playwright.CMD install chromium
```

Username/profile scraping can work without the browser fallback, but Instagram network access and valid cookies may still be required.
