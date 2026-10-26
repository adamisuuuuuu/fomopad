# Fomopad Android

- Application ID: `com.fomopad.app`
- Version: 1.0.1 (2)
- Compile/target SDK: Android 16, API 36
- Minimum: Android 7.0, API 24
- Runtime: Trusted Web Activity backed by the installed browser; full Fomopad production interface
- Permissions: Internet only
- No embedded ads SDK, analytics SDK, wallet key store, or native code libraries

## Build

Install JDK 17 and Android SDK API 36/build-tools 36.0.0. Set `ANDROID_HOME` or create `local.properties`. Restore the signing backup outside this repo. Set `FOMOPAD_STORE_FILE`, `FOMOPAD_STORE_PASSWORD`, `FOMOPAD_KEY_ALIAS`, and `FOMOPAD_KEY_PASSWORD`, or use a local ignored `key.properties`. Run `./gradlew bundleRelease assembleRelease`. Never create a new upload key for routine updates.

Upload `app/build/outputs/bundle/release/app-release.aab` to Play Console. The APK is for device installation and testing; new Play Store apps use the AAB. Neither file is an iPhone package.

## Domain verification

The web service serves `/.well-known/assetlinks.json` for this exact application ID and the supplied certificate. It currently trusts the key used for the supplied APK. When enrolling in Google Play App Signing with a Google-generated signing key, copy the **app signing certificate SHA-256** from Play Console > App integrity and append it to that JSON, then push the web change. Do not confuse it with the upload certificate. Until the installed app's signer is trusted, the browser may display a Custom Tab toolbar.

Wallet actions hand off to Phantom or Solflare and require the user to approve each message or transaction. Mainnet launch/claim transactions were not executed by the packaging workflow. Test those with the owner before production submission.

The Play release is version 1.0.1 (2), application ID com.fomopad.app, signed with the existing website APK key. For update compatibility, enroll in Play App Signing using that existing key and Google's PEPK import flow. The original private backup is the authoritative signing material.
