# Fomopad

Production source for https://fomopad.name, recovered from the live Railway services on 26 October 2026. This private repository contains the web interface, API, cron workers, Android app, and deployment instructions. No production secrets or signing keys are committed.

## Services

| Directory | Railway service | Purpose |
| --- | --- | --- |
| `services/web` | fomopad-web | Live interface and public web assets |
| `services/api` | fomopad-api | Solana launch, wallet auth, token data and fee routes |
| `services/mint-grinder` | fomopad-mint-grinder | Pre-generates encrypted fomo mints; existing 5-minute cron |
| `services/rewards-staging` | fomopad-rewards-staging | Existing rewards cron; respects production activation variables |

Each service builds from its own root directory with its Dockerfile. Existing Railway variables, database, domains, replica counts, and cron configuration are retained when linking this source. Push to `main` redeploys linked services. The name `rewards-staging` is the existing service name; its environment is production.

## Local use

Install Bun 1.3.3. In a service directory run `bun install --frozen-lockfile`, then `bun run server.ts`. Copy `.env.example` to `.env` and supply your own values for services that need them. The web server runs without secrets. Never commit `.env`, wallet seeds, encryption keys, or Android signing keys.

The `archive/railway-functions` directory preserves exact source from the original Function deployment. Editable web assets live in `services/web/public`; the original compressed copies are historical records, not the deployment source.

## Android

`android/` is a Trusted Web Activity using Google's Android Browser Helper. It opens the full production app with `source=android`, not the marketing showcase at `/app`. Wallet approval is delegated to Phantom or Solflare. See `android/README.md` for signing, builds, Digital Asset Links, and Play App Signing.

This repository is private. The downloadable Play Store kit contains listing assets and submission guidance. Production release still requires the owner's Play Console declarations, verified support contact, region eligibility, testing, and review.
