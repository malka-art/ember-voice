# Ember Voice

From the makers of [illi](https://illi.world), mouse-gesture video control for Chrome.

Like voice mode in ChatGPT, for your Claude Code thread.

A small floating voice bar for Claude Code on Windows. Type `/ember` in a
Claude Code thread and a bar opens on your desktop. Say "Ember" and talk: your
words go into that thread as your own message, and the reply is read aloud.

Hearing and speaking both run on your PC. Nothing you say leaves it except as
the text typed into the thread.

## What you need

- Windows 10 or 11, 64-bit
- [Node.js](https://nodejs.org) 24 (the version it is tested with; older
  versions may work but are untested), and git
- [Claude Code](https://claude.com/claude-code), signed in. Thread mode (the
  default) is tested in the Claude desktop app's Code tab.
- A microphone
- Optional: an NVIDIA graphics card with a current driver. Hearing then runs
  on the card: about 0.2 s a sentence. Without one it runs on the processor:
  about 0.75 s a sentence. (Measured on an RTX 2060 SUPER and a Ryzen 7 3700X.)
- Disk space: about 4.5 GB with an NVIDIA card, 1.8 GB without (the app's
  packages are 1.3 GB of that).

## Install

In a terminal (PowerShell, Command Prompt or Git Bash):

```
git clone https://github.com/malka-art/ember-voice.git
cd ember-voice
npm install
npm run setup
```

`npm install` fetches the app's packages, Electron included. `npm run setup`
downloads the speech engine, a speech model and the natural voice (see
[What setup downloads](#what-setup-downloads)), and adds the `/ember` command
to Claude Code. It can take a few minutes. Running it again skips what is
already in place.

With an NVIDIA card, the very first sentence after setup can take about 40 s
while the card gets the speech engine ready. That happens once; after it,
sentences take about 0.2 s.

Then add the `ember-thread` plugin to Claude Code. It is what lets the bar
type into a thread and hear its replies. From the same folder:

```
claude plugin marketplace add ./mod
claude plugin install ember-thread@ember-voice-local --scope user
```

(Inside Claude Code the same is `/plugin marketplace add <this folder>\mod`,
then `/plugin install ember-thread@ember-voice-local`.)

Threads load the plugin when they start, so close and reopen any thread that
was already open.

## Use

Type `/ember` in a thread. The bar opens and says it is connected.

| To do this | Do this |
|---|---|
| Talk | Start with "Ember", then speak. Right after a reply it listens for a short while without the name |
| Stop it talking | Click the orb, or press Esc. The thread keeps working; only the voice stops |
| Type instead | Double-click the status text |
| Mute the microphone, or the voice | The mic and speaker buttons |
| Change the voice, speed, listening time, wake word, light or dark | The gear button |
| Talk to another thread | Type `/ember` there. Each thread gets its own bar; say a bar's name to wake it |
| Close the bar | Right-click it, Quit |

Approvals are still asked in the Claude app, not on the bar.

Checks that need no Claude usage, from this folder:

| Command | What it does |
|---|---|
| `npm run mic-test` | Real microphone and hearing, with a stand-in for Claude that repeats what it heard |
| `npm run preview` | The bar with nothing behind it, to look at |
| `npm test` | The logic tests |

## What setup downloads

Everything comes from the project's own official source, at a fixed version,
and is checked against a pinned sha256 before it is used. A file that does not
match is deleted. The checksums are in `scripts/setup.mjs`.

| What | From | Size |
|---|---|---|
| whisper.cpp 1.9.5 speech server, NVIDIA (CUDA 12.4) build, only when an NVIDIA card is found | [ggml-org/whisper.cpp releases](https://github.com/ggml-org/whisper.cpp/releases/tag/b5454) | 685 MB download |
| whisper.cpp 1.9.5 speech server, processor build, otherwise | same | 9 MB download |
| Speech model: `large-v3-turbo` with an NVIDIA card, `base.en` without | [ggerganov/whisper.cpp on Hugging Face](https://huggingface.co/ggerganov/whisper.cpp) | 1.6 GB or 148 MB |
| Natural voice, Kokoro-82M, with 13 English voices | [onnx-community/Kokoro-82M-v1.0-ONNX](https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX) | 333 MB |

They go into the app's data folder, `%APPDATA%\ember-voice`, never into this
folder or git.

Options:

```
npm run setup -- --cpu                 the processor build even with an NVIDIA card
npm run setup -- --model small.en      another speech model
npm run setup -- --skip-hearing        skip the speech engine and model
npm run setup -- --skip-voice          skip the natural voice
npm run setup -- --skip-command        skip the /ember command
```

| Model | Size | Notes |
|---|---|---|
| `base.en` | 148 MB | The default without an NVIDIA card. Fastest; mishears unusual words more. About 0.75 s a sentence on a Ryzen 7 3700X |
| `small.en` | 488 MB | Hears better. About 2.9 s a sentence on the same processor, so best with a graphics card |
| `medium.en` | 1.5 GB | Wants a graphics card |
| `large-v3-turbo` | 1.6 GB | The default with an NVIDIA card. Most accurate. About 0.2 s a sentence on an RTX 2060 SUPER, in 1.7 GB of its memory |
| `large-v3-turbo-q8_0`, `large-v3-turbo-q5_0` | 874 MB, 574 MB | Smaller copies of the one above, for cards with less memory (not measured) |

Choosing one with `--model`, or the default, saves it in `config.local.json`;
after that, setup keeps whatever `config.local.json` names.

If you skip any of it, the app still works:

- Without the speech engine or model it hears you through a slower engine
  built into the app, which downloads its own small model the first time.
- Without the natural voice it speaks with the Windows voice.

## Settings

| File | What it is |
|---|---|
| `config.json` | The defaults, shared by everyone. Do not put anything about your own PC here |
| `config.local.json` | Your PC's own settings, laid over `config.json`. Git ignores it. Create it when you need it |
| `%APPDATA%\ember-voice\settings.json` | What you chose in the gear panel |

For example, to use a speech engine or model you already have elsewhere:

```json
{
  "whisperDir": "D:\\tools\\whisper",
  "whisperModel": "D:\\models\\ggml-large-v3-turbo.bin"
}
```

| Setting | Meaning |
|---|---|
| `mode` | `thread` (the default): the bar is a microphone and speaker for a thread you have open. `own`: the bar runs a Claude Code session of its own (needs `claude auth login`) |
| `sttEngine` | `auto` uses the fast engine when it is found, `built-in` always uses the slower one |
| `whisperDir` | The folder holding `whisper-server.exe`. Empty means the one setup made, `%APPDATA%\ember-voice\whisper` |
| `whisperModel` | A model file name (looked for in `%APPDATA%\ember-voice\speech-models`) or a full path |
| `speechWords` | Words the speech model should expect, for example `["Juniper", "Kubernetes"]`: product names, people, unusual spellings. Best kept in `config.local.json` |
| `silenceMs` | How long a pause ends what you are saying |
| `ttsEngine` | `neural`: the natural voice, with the Windows voice taking over if it cannot load. `windows`: the Windows voice only |
| `ttsVoice`, `ttsSpeed` | The natural voice and its pace (the gear panel overrides both) |
| `ttsModelDir` | Where the natural voice's files are. Empty means `%APPDATA%\ember-voice\voice-models` |
| `voiceName`, `voiceRate` | The Windows voice: part of its name (for example `Zira`) and its speed |
| `wakeWord`, `wakeFollowMs` | The name it waits for, and how long it listens without it after a reply |

Paths may use `%NAME%` for environment variables, for example
`%APPDATA%\\models`. Restart the bar after changing a setting.

## If something is wrong

The log is `%APPDATA%\ember-voice\ember.log` (the one before it is kept as
`ember.log.1`). It says which speech engine and
voice loaded, or why they did not. Set `EMBER_DEBUG=1` before starting to also
log what was heard.

| It says | Meaning |
|---|---|
| Thread is not listening | Nothing is running behind that thread right now. Send it any message in the Claude app; the bar reconnects within a few seconds |
| Thread mode needs a thread | The bar was started without one. Type `/ember` in a thread |
| This thread runs an older Ember mod | The thread loaded the plugin before it was updated. Close and reopen it |
| Connect your microphone | No microphone was found |
| The voice is the robotic Windows one | The natural voice's files are missing. Run `npm run setup` |
| Hearing is slow | The fast engine was not found or would not start, and the log says which. Run `npm run setup` |

## Uninstall

```
claude plugin uninstall ember-thread@ember-voice-local
claude plugin marketplace remove ember-voice-local
npm run install-command -- --remove
```

Then delete this folder and `%APPDATA%\ember-voice`.

## Credits

Hearing uses [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (MIT) and
OpenAI's Whisper models (MIT). The natural voice is
[Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) by hexgrad (Apache-2.0),
in the ONNX form from onnx-community. None of them is included in this
repository; setup downloads them from their official sources.

## License

Ember Voice is released under the [MIT License](LICENSE).
