# Security policy

LowRange is a single-player game: a static web app and an offline Windows desktop build
(Electron). It has no server, no accounts and no network features. Settings, best laps and
garage builds are stored only on your machine.

## Supported versions

Only the latest commit on `main` and the most recent desktop build are supported. Fixes are
not backported.

## Reporting a vulnerability

Please report privately through GitHub: open the repository's **Security** tab and choose
**Report a vulnerability**. Do not open a public issue for something exploitable. If private
reporting is unavailable, open an issue titled "Security contact request" with no details and
you will be contacted.

Useful reports include the version or commit, the platform (browser or desktop), the steps
to reproduce, and what an attacker gains. You can expect an acknowledgement within a week.

## In scope

- The desktop shell (`electron/`): escaping the sandbox or context isolation, reading files
  outside the app through the `app://` scheme, opening arbitrary URLs or programs, reaching
  the network, or driving a shipped build remotely.
- Script injection into the game page, from URL parameters, saved data or model files.
- The build and release pipeline, and secrets or personal data committed to the repository.

## Out of scope

- Cheating, editing your own saves or best laps, or modding your own install.
- Attacks that need an attacker who can already run programs as you on your machine.
- Windows SmartScreen warnings on the unsigned desktop build (a known limitation).
