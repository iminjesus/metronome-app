# Publishing to the app stores (Capacitor)

This wraps the web app in a native shell with **Capacitor** and uses the
device's **native speech recognizer** (much better than the browser's — echo
cancellation, gain, works at a distance). The web/PWA version keeps working
unchanged; native speech only kicks in inside the packaged app.

Do everything below from the project folder on your Mac.

---

## 0. One-time tools

- **Node.js 18+** (`node -v`)
- **Android:** [Android Studio](https://developer.android.com/studio) (installs the Android SDK + JDK)
- **iOS:** **Xcode** (from the Mac App Store) + `sudo gem install cocoapods`

Install the project dependencies once:

```bash
npm install
```

---

## 1. Android — first release

### 1a. Add the Android project

```bash
npm run build              # copies the web app into www/
npx cap add android        # creates the android/ project
npm run sync               # copies web + plugins into android/
```

### 1b. Add the microphone permission + speech query

Open `android/app/src/main/AndroidManifest.xml` and:

- add this **inside** `<manifest>` (a sibling of `<application>`):

  ```xml
  <uses-permission android:name="android.permission.RECORD_AUDIO" />

  <queries>
    <intent>
      <action android:name="android.speech.RecognitionService" />
    </intent>
  </queries>
  ```

(The `<queries>` block lets the app find the system speech recognizer on
Android 11+.)

### 1c. Run it on a device/emulator

```bash
npm run android            # builds www + opens Android Studio
```

In Android Studio press **Run ▶**. Grant the microphone permission when asked,
then test voice: say "start", "one thirty", "volume up".

### 1d. Build the upload file (.aab) for Play Store

In Android Studio: **Build → Generate Signed Bundle / APK → Android App Bundle**.
- Create a new **keystore** the first time and **keep it safe** (you need the
  same key for every future update).
- It produces `app-release.aab`.

### 1e. Upload to Google Play

1. [Play Console](https://play.google.com/console) → **Create app**
2. Fill in store listing (name, short/full description, screenshots, an icon,
   privacy policy URL — required because the app uses the mic).
3. **Testing → Internal testing → Create release** → upload the `.aab` → add
   testers by email → share the opt-in link. (Fastest way to try it on real
   phones.)
4. When ready: **Production → Create release** → submit for review.

---

## 2. iOS — App Store (you have a Mac)

```bash
npx cap add ios
npm run sync
```

Add usage strings to `ios/App/App/Info.plist`:

```xml
<key>NSMicrophoneUsageDescription</key>
<string>Used for voice commands and the tuner.</string>
<key>NSSpeechRecognitionUsageDescription</key>
<string>Used to control the metronome by voice.</string>
```

Then:

```bash
npm run ios                # opens Xcode
```

In Xcode: pick your **Team** (needs an Apple Developer account, $99/yr), set a
unique **Bundle Identifier** (matches `appId` in `capacitor.config.json`), run
on a device to test, then **Product → Archive → Distribute App → App Store
Connect**. Finish the listing in
[App Store Connect](https://appstoreconnect.apple.com) and submit for review.

---

## 3. Updating the app later

Whenever the web app changes:

```bash
npm run sync               # re-copies web + plugins into android/ and ios/
```

then rebuild in Android Studio / Xcode and upload a new version (bump the
version number). The web/PWA version updates on its own as before.

---

## Notes

- **App ID / name** live in `capacitor.config.json` — change them before the
  first store upload if you want a different identifier.
- **App icon & splash:** optional but nice —
  `npm i -D @capacitor/assets`, drop a 1024×1024 `icon.png` in an `assets/`
  folder, then `npx @capacitor/assets generate`.
- **Native speech behavior** can differ slightly by OS version; if a command
  behaves oddly on device, note the exact spoken text and it can be tuned.
- `android/`, `ios/`, `www/`, and `node_modules/` are git-ignored (generated
  locally); the web source at the repo root stays the single source of truth.
