# Liège Nationality Appointment Watcher — Cloud Hybrid v3

24/7 cloud backup for the local Chrome watcher.

## What it does

- Checks the official Ville de Liège nationality booking calendar every **5 minutes**, even when the PC is off.
- Scans up to **24 months** ahead.
- Publishes a mobile-friendly status dashboard through **GitHub Pages**.
- Sends an **ntfy urgent push only when something important changes**:
  - an appointment appears when previously none existed;
  - the earliest appointment **date** becomes earlier;
  - a date appears in the urgent window.
- Does **not** alert for a time-only change on the same date.
- Sends **email only when a date in the urgent window appears**.
- Current urgent window: **today through 31 January 2027**.
- If the same urgent date disappears and later reappears, it alerts again.
- After three consecutive cloud failures, it sends one health alert.

## Recommended hybrid setup

Keep the existing Chrome extension as the **1-minute fast lane** when the PC is on. The cloud watcher is the **24/7 safety net** for evenings, weekends, and times when the PC is off.

To avoid duplicate phone noise once cloud is active, disable repeated mobile status notifications in the local extension or reduce them to once per day.

## Secrets

Notification credentials are stored only as GitHub Actions Secrets and are never committed to the repository.

Required for ntfy:
- `NTFY_TOPIC`

Optional for email:
- `SMTP_HOST`
- `SMTP_PORT`
- `SMTP_USER`
- `SMTP_PASS`
- `EMAIL_TO`
- `EMAIL_FROM`

The dashboard contains no personal data.
