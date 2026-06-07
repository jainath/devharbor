# Security Policy

## Supported versions

DevHarbor is in active development. Only the latest released version receives fixes.

| Version | Supported |
| ------- | --------- |
| latest  | ✅        |
| older   | ❌        |

## Reporting an issue

Please report security concerns **privately** — do **not** open a public GitHub issue.

- Preferred: GitHub's **[private vulnerability reporting](https://github.com/jainath/devharbor/security/advisories/new)**
  (repo → **Security** tab → **Report a vulnerability**).
- Or email the maintainer: **jainath.ponnala@gmail.com**

Please include steps to reproduce and the affected version. You'll get an acknowledgement,
and a fix or mitigation will be coordinated before any public disclosure.

## Scope notes

DevHarbor is a **local, offline** macOS app: your app registry, env vars, and logs stay on
your machine (a local SQLite database). It runs the dev commands you configure and reads
your projects' `.env` files. There is no account system, server, or telemetry.
