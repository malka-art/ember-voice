#!/usr/bin/env node
// One-time setup on a new PC, run after "npm install":
//
//   1. Hearing: whisper.cpp's speech server, from its official Windows release
//      on GitHub. The graphics-card (CUDA) build when an NVIDIA card is found,
//      the processor build otherwise.
//   2. A speech model for it, from the ggerganov/whisper.cpp repo on Hugging
//      Face: large-v3-turbo with an NVIDIA card, base.en without (chooseModel).
//   3. The natural voice: Kokoro-82M from onnx-community/Kokoro-82M-v1.0-ONNX.
//   4. The /ember command for Claude Code.
//
// Every download is checked against a sha256 pinned below before it is used,
// and a file that does not match is deleted. Files go into the app's data
// folder, %APPDATA%\ember-voice (or EMBER_USER_DATA when that is set), never
// into this folder. Running it again skips what is already in place.
//
//   npm run setup                          everything
//   npm run setup -- --cpu                 the processor build, even with an NVIDIA card
//   npm run setup -- --model base.en       another speech model (see SPEECH_MODELS)
//   npm run setup -- --skip-hearing --skip-voice --skip-command
//
// Without step 1 or 2 the app still hears you, through a slower engine built
// into it that downloads its own model on first use. Without step 3 it speaks
// with the Windows voice.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, LOCAL_CONFIG, readLocalConfig } from '../lib/config.mjs';
import { KOKORO_MODEL, resolveModelDir } from '../lib/neural-voice.mjs';
import { installCommand } from './install-command.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// whisper.cpp v1.9.5. Its Windows binaries are published under the build tag
// b5454, made from the same commit (d1be6fd). Sizes and checksums are the ones
// GitHub lists for each file.
export const WHISPER_RELEASE = {
  tag: 'b5454',
  version: '1.9.5',
  cpu: {
    file: 'whisper-bin-x64.zip',
    size: 8928640,
    sha256: '6ba69e3482d7826214f90a6a9c84ca07782aec1e1d0c6a7c30c994fd5d816ccb',
  },
  cuda: {
    file: 'whisper-bin-win-cuda-12.4.0-x64.zip',
    size: 684913404,
    sha256: 'afef0b881c500958921c3f5523b50e59ee2ec9b6f5cbd25b324c51ed308a957a',
  },
};

// The speech models, at a fixed revision of ggerganov/whisper.cpp. Checksums
// are the ones Hugging Face records for each file.
const WHISPER_MODELS_REVISION = '5359861c739e955e79d9a303bcbc70fb988958b1';
export const SPEECH_MODELS = {
  'base.en': { size: 147964211, sha256: 'a03779c86df3323075f5e796cb2ce5029f00ec8869eee3fdfb897afe36c6d002' },
  'small.en': { size: 487614201, sha256: 'c6138d6d58ecc8322097e0f987c32f1be8bb0a18532a3f88f734d1bbf9c41e5d' },
  'medium.en': { size: 1533774781, sha256: 'cc37e93478338ec7700281a7ac30a10128929eb8f427dda2e865faa8f6da4356' },
  'large-v3-turbo': { size: 1624555275, sha256: '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69' },
  'large-v3-turbo-q8_0': { size: 874188075, sha256: '317eb69c11673c9de1e1f0d459b253999804ec71ac4c23c17ecf5fbe24e259a1' },
  'large-v3-turbo-q5_0': { size: 574041195, sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2' },
};

// The natural voice, at a fixed revision of onnx-community/Kokoro-82M-v1.0-ONNX.
const KOKORO_REVISION = '1939ad2a8e416c0acfeecc08a694d14ef25f2231';
export const KOKORO_FILES = {
  'config.json': { size: 44, sha256: 'df34b4f930b23447cd4dc410fabfb42eb3f24e803e6c3f97d618fb359380a36f' },
  'tokenizer.json': { size: 3497, sha256: '77a02c8e164413299b4b4c403b14f8e0e1c1b727db4d46a09d6327b861060a34' },
  'tokenizer_config.json': { size: 113, sha256: 'be1cb066d6ef6b074b3f15e6a6dd21ac88ff3cdaedf325f0aaed686c70f75d20' },
  'onnx/model.onnx': { size: 325532232, sha256: '8fbea51ea711f2af382e88c833d9e288c6dc82ce5e98421ea61c058ce21a34cb' },
};
const VOICE_SIZE = 522240;
export const KOKORO_VOICES = {
  af_heart: 'd583ccff3cdca2f7fae535cb998ac07e9fcb90f09737b9a41fa2734ec44a8f0b',
  af_bella: 'f69d836209b78eb8c66e75e3cda491e26ea838a3674257e9d4e5703cbaf55c8b',
  af_nicole: 'cd2191ab31b914ed7b318416b0e4440fdf392ddad9106a060819aa600a64f59a',
  af_aoede: '4a004c33430762e2461eedb2013fad808ef4ab3121f5300f554476caf58d8361',
  af_kore: '9be5221b6a941c04b561959b8ff0b06e809444dcc4ab7e75a7b23606f691819e',
  af_sarah: '4409fbc125afabacc615d94db5398d847006a737b0247d6892b7a9a0007a2f0a',
  am_fenrir: 'c27989f741f7ee34d273a39d8a595cc0837d35f5ced9a29b7cc162614616df43',
  am_michael: '1d1f21dd8da39c30705cd4c75d039d265e9bc4a2a93ed09bc9e1b1225eb95ba1',
  am_puck: 'fcf73c989033e9233e0b98713eca600c8c74dcc1614b37009d5450ff4a2274a0',
  bf_emma: '669fe0647f9dd04fcab92f1439a40eeb4c8b4ab1f82e4996fe3d918ce4a63b73',
  bf_isabella: '3754352c4aaa46d17f27654ab7518d65b62ad6163a0f55a5f4330c2da2c4e94f',
  bm_george: 'c4b235a4c1f2cd3b939fed08b899ce9385638b763f7b73a59616c4fc9bd6c9bc',
  bm_fable: 'f889083196807b4adb15e9204252165f503b8d33d3982e681c52443c49d798f1',
};

// Where the app keeps its data: Electron's own folder for an app named
// "ember-voice", or the folder EMBER_USER_DATA names.
export function dataDirectory(env = process.env) {
  if (env.EMBER_USER_DATA) return path.resolve(env.EMBER_USER_DATA);
  return path.join(env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'ember-voice');
}

// "ggml-small.en.bin" or a path ending in it -> "small.en"; null when it is
// not one of the models this script knows.
export function modelKey(name) {
  const match = /^ggml-(.+)\.bin$/i.exec(path.basename(String(name ?? '')));
  return match && SPEECH_MODELS[match[1]] ? match[1] : null;
}

export function parseSetupArgs(argv) {
  const options = { cpu: false, model: null, hearing: true, voice: true, command: true };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cpu') options.cpu = true;
    else if (arg === '--skip-hearing') options.hearing = false;
    else if (arg === '--skip-voice') options.voice = false;
    else if (arg === '--skip-command') options.command = false;
    else if (arg === '--model') options.model = argv[++i];
    else if (arg.startsWith('--model=')) options.model = arg.slice('--model='.length);
    else throw new Error(`unknown option "${arg}"`);
  }
  if (options.model !== null) {
    options.model = String(options.model ?? '').replace(/^ggml-/, '').replace(/\.bin$/, '');
    if (!SPEECH_MODELS[options.model]) throw new Error(`unknown model "${options.model}". Choose one of: ${Object.keys(SPEECH_MODELS).join(', ')}`);
  }
  return options;
}

// An NVIDIA card with its driver installed. The driver puts nvidia-smi on the
// PATH; Windows' own list of display adapters is the second opinion.
export function hasNvidiaCard() {
  try {
    execFileSync('nvidia-smi', ['-L'], { stdio: 'pipe', windowsHide: true, timeout: 20000 });
    return true;
  } catch {
    // Not found, or no card.
  }
  if (process.platform !== 'win32') return false;
  try {
    const names = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_VideoController).Name'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
      timeout: 30000,
    });
    return /nvidia/i.test(names);
  } catch {
    return false;
  }
}

export async function sha256File(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function megabytes(bytes) {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

// True when `file` already holds exactly the expected bytes.
async function isInPlace(file, { size, sha256 }) {
  if (!existsSync(file) || statSync(file).size !== size) return false;
  return (await sha256File(file)) === sha256;
}

// Downloads to a side file, checks size and sha256, and only then puts it in
// place. Returns false when the right file was already there.
export async function download(url, dest, { size, sha256, label, fetchImpl = fetch, log = console.log }) {
  if (await isInPlace(dest, { size, sha256 })) {
    log(`  ${label}: already in place`);
    return false;
  }
  mkdirSync(path.dirname(dest), { recursive: true });
  const part = `${dest}.download`;
  log(`  ${label}: downloading ${megabytes(size)}...`);
  const response = await fetchImpl(url, { redirect: 'follow' });
  if (!response.ok || !response.body) throw new Error(`${label}: the download answered ${response.status} (${url})`);
  const hash = createHash('sha256');
  const out = createWriteStream(part);
  let received = 0;
  let shown = 0;
  try {
    for await (const chunk of response.body) {
      hash.update(chunk);
      received += chunk.length;
      if (!out.write(chunk)) await once(out, 'drain');
      const tenth = Math.floor((received / size) * 10);
      if (size > 50e6 && tenth > shown && tenth < 10) {
        shown = tenth;
        log(`    ${tenth * 10}%`);
      }
    }
    await new Promise((resolve, reject) => out.end((error) => (error ? reject(error) : resolve())));
  } catch (error) {
    out.destroy();
    rmSync(part, { force: true });
    throw new Error(`${label}: the download broke off (${error.message}). Run setup again to retry.`);
  }
  const digest = hash.digest('hex');
  if (received !== size || digest !== sha256) {
    rmSync(part, { force: true });
    throw new Error(`${label}: the file did not match its pinned checksum (got ${received} bytes, sha256 ${digest}), so it was deleted and not used.`);
  }
  rmSync(dest, { force: true });
  renameSync(part, dest);
  return true;
}

// Windows' own tar (bsdtar) opens zip files. A "tar" earlier on the PATH, such
// as Git's, may not, so it is called by its full path.
function unzip(zip, into) {
  mkdirSync(into, { recursive: true });
  const systemTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  if (existsSync(systemTar)) {
    execFileSync(systemTar, ['-xf', zip, '-C', into], { stdio: 'pipe', windowsHide: true });
    return;
  }
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force', zip, into], {
    stdio: 'pipe',
    windowsHide: true,
  });
}

// The folder inside an unpacked release that holds whisper-server.exe.
function findServerFolder(dir, depth = 3) {
  if (existsSync(path.join(dir, 'whisper-server.exe'))) return dir;
  if (depth === 0) return null;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const found = findServerFolder(path.join(dir, entry.name), depth - 1);
    if (found) return found;
  }
  return null;
}

async function setUpHearing({ dataDir, flavor, log }) {
  const target = path.join(dataDir, 'whisper');
  const stamp = path.join(target, 'ember-setup.json');
  const wanted = { tag: WHISPER_RELEASE.tag, version: WHISPER_RELEASE.version, flavor };
  try {
    const have = JSON.parse(readFileSync(stamp, 'utf8'));
    if (have.tag === wanted.tag && have.flavor === wanted.flavor && existsSync(path.join(target, 'whisper-server.exe'))) {
      log(`  whisper.cpp ${wanted.version} (${flavor}): already in place`);
      return target;
    }
  } catch {
    // Not set up yet, or by hand.
  }
  const asset = WHISPER_RELEASE[flavor];
  const downloads = path.join(dataDir, 'downloads');
  const zip = path.join(downloads, asset.file);
  const url = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_RELEASE.tag}/${asset.file}`;
  await download(url, zip, { ...asset, label: `whisper.cpp ${WHISPER_RELEASE.version} (${flavor})`, log });

  const unpacked = path.join(downloads, 'whisper-unpacked');
  rmSync(unpacked, { recursive: true, force: true });
  log('  unpacking...');
  unzip(zip, unpacked);
  const server = findServerFolder(unpacked);
  if (!server) throw new Error(`whisper.cpp: ${asset.file} has no whisper-server.exe in it`);
  try {
    rmSync(target, { recursive: true, force: true });
  } catch (error) {
    throw new Error(`could not replace ${target} (${error.code}). Close every Ember bar and run setup again.`);
  }
  renameSync(server, target);
  writeFileSync(stamp, `${JSON.stringify(wanted, null, 2)}\n`);
  rmSync(unpacked, { recursive: true, force: true });
  rmSync(zip, { force: true });
  return target;
}

async function setUpSpeechModel({ dataDir, model, log }) {
  const file = `ggml-${model}.bin`;
  const dest = path.join(dataDir, 'speech-models', file);
  const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/${WHISPER_MODELS_REVISION}/${file}`;
  await download(url, dest, { ...SPEECH_MODELS[model], label: `speech model ${model}`, log });
  return dest;
}

async function setUpVoice({ dir, log }) {
  const modelDir = path.join(dir, ...KOKORO_MODEL.split('/'));
  for (const [name, pin] of Object.entries(KOKORO_FILES)) {
    const url = `https://huggingface.co/${KOKORO_MODEL}/resolve/${KOKORO_REVISION}/${name}`;
    await download(url, path.join(modelDir, ...name.split('/')), { ...pin, label: `voice ${name}`, log });
  }
  let fetched = 0;
  for (const [voice, sha256] of Object.entries(KOKORO_VOICES)) {
    const url = `https://huggingface.co/${KOKORO_MODEL}/resolve/${KOKORO_REVISION}/voices/${voice}.bin`;
    const quiet = () => {};
    if (await download(url, path.join(dir, 'voices', `${voice}.bin`), { size: VOICE_SIZE, sha256, label: `voice ${voice}`, log: quiet })) fetched++;
  }
  log(`  ${Object.keys(KOKORO_VOICES).length} voices in place${fetched ? ` (${fetched} downloaded)` : ''}`);
  return dir;
}

// Which speech model to fetch:
//   --model, when given
//   else the one this PC's config.local.json already names
//   else large-v3-turbo with an NVIDIA card (about 0.2 s a sentence on an
//   RTX 2060 SUPER, 1.7 GB of its memory) and base.en without one (about
//   0.75 s on a Ryzen 7 3700X; small.en hears better but took 2.9 s)
// `remember`: write the choice into config.local.json.
export function chooseModel({ option = null, local = {}, flavor }) {
  if (option) return { model: option, remember: true };
  const named = String(local.whisperModel ?? '').trim();
  if (named) {
    if (path.isAbsolute(named)) return { model: null, note: `${LOCAL_CONFIG} points at ${named}; setup leaves that as it is` };
    const key = modelKey(named);
    if (key) return { model: key, remember: false };
    return { model: null, note: `${LOCAL_CONFIG} names "${named}", a model setup does not know; setup leaves that as it is` };
  }
  return { model: flavor === 'cuda' ? 'large-v3-turbo' : 'base.en', remember: true };
}

// Writes the speech model into config.local.json, this PC's own settings,
// which git never sees.
function rememberModel(model, log) {
  const file = path.join(root, LOCAL_CONFIG);
  const local = readLocalConfig(root);
  const name = `ggml-${model}.bin`;
  if (local.whisperModel === name) return;
  writeFileSync(file, `${JSON.stringify({ ...local, whisperModel: name }, null, 2)}\n`);
  log(`  ${LOCAL_CONFIG}: whisperModel is now ${name}`);
}

export async function setup(argv = process.argv.slice(2), { log = console.log } = {}) {
  const options = parseSetupArgs(argv);
  const config = loadConfig(root);
  const dataDir = dataDirectory();
  log(`Ember setup. Files go to ${dataDir}`);

  if (options.hearing) {
    const flavor = options.cpu ? 'cpu' : hasNvidiaCard() ? 'cuda' : 'cpu';
    log(`\nHearing (whisper.cpp, ${flavor === 'cuda' ? 'NVIDIA graphics card' : 'processor'} build)`);
    if (config.whisperDir) log(`  note: config sets whisperDir to ${config.whisperDir}, so the app uses that folder, not the one setup makes`);
    await setUpHearing({ dataDir, flavor, log });
    const choice = chooseModel({ option: options.model, local: readLocalConfig(root), flavor });
    if (choice.note) log(`  note: ${choice.note}`);
    if (choice.model) {
      await setUpSpeechModel({ dataDir, model: choice.model, log });
      if (choice.remember) rememberModel(choice.model, log);
    }
  }

  if (options.voice) {
    log('\nNatural voice (Kokoro-82M)');
    await setUpVoice({ dir: resolveModelDir(config.ttsModelDir, { root, defaultDir: path.join(dataDir, 'voice-models') }), log });
  }

  if (options.command) {
    log('\nThe /ember command');
    log(`  ${installCommand()}`);
  }

  log('\nDone. Next: install the ember-thread plugin in Claude Code (see README.md), then type /ember in a thread.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setup().catch((error) => {
    console.error(`\nSetup stopped: ${error.message}`);
    process.exit(1);
  });
}
