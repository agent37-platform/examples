# A cloud Android phone

An Android phone that runs in the cloud and never sleeps in a drawer: your agent drives it
with ADB, your user watches the screen from a browser tab, and the phone's storage, logins
and installed apps survive restarts.

The instance is a **real virtual machine**, not a container: the Android emulator needs
hardware virtualisation (`/dev/kvm`), so every create here passes `"type": "vm"`. The
`agent37-android` template already has the Android 14 SDK, an AVD and ADB on it, so there
is nothing to install.

## Run it

```bash
export AGENT37_API_KEY=sk_live_...

node phone.js create      # a 4 vCPU / 8 GB VM on agent37-android; remembers the id in .phone
node phone.js wait        # blocks until Android has finished booting, prints how long it took
node phone.js adb shell getprop ro.build.version.release   # -> 14
node phone.js shot        # writes screen.webp
node phone.js screen      # a link that opens the live screen in any browser tab
node phone.js install https://example.com/app.apk
node phone.js delete
```

Every command but `create`, `screen` and `delete` is one `POST /v1/instances/{id}/exec`, so
an agent needs no open ports and no SSH to drive the phone.

## What your agent can do with it

```bash
node phone.js adb shell am start -a android.intent.action.VIEW -d https://example.com
node phone.js adb shell input tap 540 1200
node phone.js adb shell input text hello
node phone.js adb shell dumpsys window | grep mCurrentFocus    # what is on screen
node phone.js adb logcat -d -t 200
```

A screenshot plus `input tap` is the whole loop a computer-use agent needs. `adb exec-out
screencap -p` is the fastest way to a frame, though a full-resolution PNG of a 1080x2400
phone is bigger than an exec response can carry: the image ships `android-shot`, which
returns a scaled WebP as base64 (that is what `shot` runs). `uiautomator dump` gives the
view tree when you would rather act on element bounds than on pixels.

## Watching the screen

`node phone.js screen` mints a [signed URL](https://www.agent37.com/docs/agents-api/urls)
for port 6901 and prints the noVNC page on it. The link carries its own auth, expires, and
opens in any browser tab:

```
https://<id>-6901.agent37.app/vnc.html?a37_token=...&autoconnect=1&resize=scale
```

Add `&view_only=1` to watch without touching. To embed it in your own app, mount the noVNC
client in your page and connect its WebSocket straight to the instance; the
[hermes-vnc-desktop](../custom-images/hermes-vnc-desktop) recipe has the exact code and
explains why an iframe of the signed URL does not work.

noVNC is what the template ships because it needs nothing installed and rides the same
authenticated edge as every other port. It is not the only option:

| View | Latency | What it costs you |
|---|---|---|
| **noVNC** (shipped) | fine for automation, soft on fast scrolling | nothing, it is already running on 6901 |
| **[ws-scrcpy](https://github.com/NetrisTV/ws-scrcpy)** | best in a browser: H.264 decoded by WebCodecs | a Node server in the image, served on its own port |
| **[scrcpy](https://github.com/Genymobile/scrcpy)** | best overall, native client | `agent37 ssh <id> -- -L 5037:localhost:5037`, then `scrcpy` on your laptop |
| The emulator's own gRPC/WebRTC stream | best quality | needs UDP, which the Agent37 edge does not carry, so you would have to bring a TURN server |

## What to know

- **Do not turn on auto-sleep.** The emulator uses nested virtualisation, and a guest that
  has used it can lose `/dev/kvm` after a wake. Use explicit `stop`/`start` instead, which
  is a clean cold boot and still stops the compute bill.
- **First boot is the slow one**: it creates the AVD before Android starts. Later boots load
  the emulator's quick-boot snapshot and come up far faster, because the AVD lives on the
  instance's durable disk.
- **Size it.** 4 vCPU / 8 GB is the floor. Ask for at least 20 GB of disk: the phone's own
  storage and the quick-boot snapshot both live there.
- **Google Play.** The image ships the `google_apis` system image, which has Google Play
  services (so push and sign-in work) but not the Play Store app, and keeps `adb root`.
  Sideload an APK with `install`, or rebuild the image on
  `system-images;android-34;google_apis_playstore;x86_64` if you need the store itself.
- **Another Android version, or your own build of this image.** The template's Dockerfile is
  public: [`images/vm/android`](https://github.com/agent37-platform/templates/tree/main/images/vm/android).
  Copy it, change `SYSTEM_IMAGE` (or anything else), and publish it as your own workspace
  template with `npx agent37 templates build . --name my-phone --default-port 6901`; create
  it with `"type": "vm"` exactly as above. On the stock image you can also just
  `sdkmanager --install "system-images;android-16;google_apis;x86_64"` on the instance.
- **Docker is on the box too**, with its data-root on the durable disk, so the same machine
  runs your own containers next to the phone.
