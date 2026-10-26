# Fomopad

**Launch Solana coins with real mint addresses ending in `fomo`.**

[Open Fomopad](https://fomopad.name) · [Follow on X](https://x.com/fomoxpad)

## About the app

Fomopad is an independent Solana token launchpad for discovering new coins, creating token launches, and managing creator fees. Creators can choose Meteora Dynamic Bonding Curve (DBC) or Stonk.fun, reserve a real mint address ending in `fomo`, add their token details, and review the launch transaction in their own wallet.

The app brings discovery, launch management, creator fee tools, and eligible Fomo trader reward options into one interface for desktop and mobile.

## Features

- **Discover launches:** Browse verified Fomopad launches, open token pages, and inspect available price, liquidity, volume, and chart data.
- **Choose a launch rail:** Create a coin using Meteora DBC or Stonk.fun, subject to the selected rail's live availability and terms.
- **Real `...fomo` addresses:** Reserve a Solana mint whose actual address ends in `fomo`.
- **Creator fee management:** Access My launches and Claim fees to view supported fee balances and actions. Fee handling depends on the protocol and the fee route selected at launch.
- **Optional DBC reward routes:** Choose creator fees, eligible verified Fomo traders, or verified Fomo traders who still hold the coin. Trader and holder routes use different eligibility and allocation rules; other trading wallets are excluded.
- **Wallet approval:** Connect Phantom or Solflare. Sign-in uses a message signature, and transactions require wallet approval. Fomopad does not ask for your wallet seed phrase.
- **Mobile access:** Use the responsive web app, install the web app where supported, or build the Android project included here.
- **Guides:** Read the in-app How it works and Docs pages for launch and fee flows.

Reward routing is chosen before launch and is fixed for that coin. DBC bonding fees and post-graduation DAMM v2 fees have different handling. Market data depends on third-party indexing, and rewards depend on the selected route, eligibility, available fees, and operational configuration.

Fomopad is independent and is not an official Fomo or Meteora product.

## Repository

This public repository contains the web interface, API, workers, Android project, and deployment instructions for [fomopad.name](https://fomopad.name). Production source was recovered from the live Railway services on 26 October 2026. Production secrets and signing keys must remain outside the repository.

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

`android/` is a Trusted Web Activity using Google's Android Browser Helper. It opens the full production app with `source=android`, not the marketing showcase at `/app`. Wallet approval is delegated to Phantom or Solflare. See [android/README.md](android/README.md) for signing, builds, Digital Asset Links, and Play App Signing.

The downloadable Play Store kit contains listing assets and submission guidance. Google Play release requires the owner's Play Console declarations, verified support contact, region eligibility, testing, and review. The Android source project is not a claim that the app is already listed on Google Play.
