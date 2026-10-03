#!/usr/bin/env node
/**
 * read-along-verify — does the voice say what the page says?
 *
 *   read-along-verify notes.md
 *   read-along-verify notes.md --pronunciations fixes.json
 *
 * Synthesizes each sentence with Kokoro (the same neural voice as the
 * component's "Natural voice"), transcribes it back with Whisper, diffs the
 * transcript against the written words, and control-tests every mismatch
 * with the operating system's own voice (Windows SAPI, macOS `say`,
 * espeak-ng on Linux). The protocol, and why the control test is not
 * optional, is in src/verify.js.
 *
 * With --pronunciations, the same map the component uses is applied to the
 * spoken text (one implementation: src/pronunciations.js), and each fixed
 * word is checked to come back as the word on the page.
 *
 * The input script is only ever READ. Never edit source text to satisfy a
 * TTS engine; fix the engine's input with a pronunciation instead.
 *
 * kokoro-js and @huggingface/transformers are optional peer dependencies,
 * so the component stays dependency-free. They are loaded on demand, and
 * their absence is reported with the exact install command.
 *
 * Exit codes: 0 no confirmed problems · 1 a synthesis defect, or a fix that
 * did not take · 2 could not run (usage, missing dependency, bad input).
 */

import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir, platform } from "node:os";
import { join, extname } from "node:path";
import { execFile } from "node:child_process";

import { tokenize } from "../src/tokenizer.js";
import { parsePronunciations, compilePronunciations, spokenChunk } from "../src/pronunciations.js";
import {
  markdownToText,
  splitSentences,
  expectedWords,
  compareTranscript,
  classifyRegion,
  overlaps,
  parseWav,
  resample,
  summarize,
  formatReport,
} from "../src/verify.js";

const KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const KOKORO_DTYPE = "q8"; // what the component's KokoroEngine downloads by default
const DEFAULT_VOICE = "af_heart";
const DEFAULT_ASR = "onnx-community/whisper-small";
const DEFAULT_ASR_DTYPE = "q8";
const ASR_RATE = 16000;

const USAGE = `Usage: read-along-verify <script.txt|script.md> [options]

Synthesizes each sentence with Kokoro, transcribes it back with Whisper,
and control-tests every mismatch with the operating system's voice.

Options:
  --pronunciations <file.json>  apply a spoken-form map, e.g. {"Theravada": "Terra-vah-dah"},
                                and check that each fixed word now comes back as written
  --voice <id>                  Kokoro voice (default ${DEFAULT_VOICE})
  --model <id>                  Whisper model for transcription (default ${DEFAULT_ASR})
  --dtype <type>                Whisper weights: q8 (default, ~250 MB) or fp32 (~1 GB, most accurate)
  --json                        machine-readable output on stdout
  -h, --help                    show this help
  --version                     show the version

Exit codes: 0 no confirmed problems, 1 confirmed problems, 2 could not run.
The script file is only read, never modified.`;

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { voice: DEFAULT_VOICE, model: DEFAULT_ASR, dtype: DEFAULT_ASR_DTYPE, json: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new UsageError(`${a} needs a value`);
      return v;
    };
    if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "--version") opts.version = true;
    else if (a === "--json") opts.json = true;
    else if (a === "--pronunciations") opts.pronunciations = value();
    else if (a === "--voice") opts.voice = value();
    else if (a === "--model") opts.model = value();
    else if (a === "--dtype") opts.dtype = value();
    else if (a.startsWith("-")) throw new UsageError(`unknown option ${a}`);
    else positional.push(a);
  }
  if (!opts.help && !opts.version) {
    if (positional.length !== 1) throw new UsageError("give exactly one script file");
    opts.script = positional[0];
  }
  return opts;
}

const log = (msg) => process.stderr.write(`${msg}\n`);

// -- optional dependencies ------------------------------------------------------

function isMissing(err, name) {
  return err?.code === "ERR_MODULE_NOT_FOUND" && String(err.message).includes(`'${name}'`);
}

async function loadOptionalDeps() {
  const missing = [];
  let transformers = null;
  let kokoro = null;
  try {
    transformers = await import("@huggingface/transformers");
  } catch (err) {
    if (!isMissing(err, "@huggingface/transformers")) throw err;
    missing.push("@huggingface/transformers");
  }
  try {
    kokoro = await import("kokoro-js");
  } catch (err) {
    if (isMissing(err, "kokoro-js")) missing.push("kokoro-js");
    else if (!isMissing(err, "@huggingface/transformers")) throw err;
  }
  return { transformers, kokoro, missing };
}

function installHelp(missing) {
  return [
    `read-along-verify needs ${missing.length === 1 ? "an optional package that is" : "optional packages that are"} not installed:`,
    ...missing.map((m) => `  - ${m}`),
    "",
    "Install both in the project that runs the check:",
    "",
    "  npm install --save-dev kokoro-js @huggingface/transformers@^3",
    "",
    "(transformers 3.x is the copy kokoro-js uses itself, so only one is installed; 4.x works too.)",
    "They are optional peer dependencies, so the <read-along> component itself stays",
    "dependency-free. The first run also downloads the models from Hugging Face:",
    "Kokoro (about 90 MB) and Whisper small (about 250 MB at q8).",
  ].join("\n");
}

// -- OS control voice -----------------------------------------------------------

function run(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 120_000, windowsHide: true, maxBuffer: 1 << 20, ...options }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else {
        resolve(String(stdout));
      }
    });
  });
}

// Text and paths reach PowerShell through environment variables, never by
// splicing them into the command: a sentence is data, not script.
const SAPI_PROBE = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $n = @($s.GetInstalledVoices() | Where-Object { $_.Enabled }).Count
  if ($n -gt 0) { [Console]::Out.Write($s.Voice.Name) } else { exit 3 }
} finally { $s.Dispose() }`;

const SAPI_SPEAK = `
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
try {
  $fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
  $s.SetOutputToWaveFile($env:READ_ALONG_VERIFY_OUT, $fmt)
  $s.Speak([System.IO.File]::ReadAllText($env:READ_ALONG_VERIFY_IN, [System.Text.Encoding]::UTF8))
} finally { $s.Dispose() }`;

/**
 * The OS voice used as the control engine, or null. Each `synth` writes the
 * text to a file first: the text is passed as a file, never as a command
 * line argument.
 */
async function detectControlVoice() {
  const os = platform();
  try {
    if (os === "win32") {
      const ps = ["-NoProfile", "-NonInteractive", "-Command"];
      const voice = (await run("powershell.exe", [...ps, SAPI_PROBE])).trim();
      return {
        engine: "Windows SAPI",
        voice: voice || null,
        synth: (inFile, outFile) =>
          run("powershell.exe", [...ps, SAPI_SPEAK], {
            env: { ...process.env, READ_ALONG_VERIFY_IN: inFile, READ_ALONG_VERIFY_OUT: outFile },
          }),
      };
    }
    if (os === "darwin") {
      await run("say", ["-v", "?"]);
      return {
        engine: "macOS say",
        voice: null,
        synth: (inFile, outFile) =>
          run("say", ["-f", inFile, "-o", outFile, "--file-format=WAVE", "--data-format=LEI16@16000"]),
      };
    }
    await run("espeak-ng", ["--version"]);
    return {
      engine: "espeak-ng",
      voice: "en-us",
      synth: (inFile, outFile) => run("espeak-ng", ["-v", "en-us", "-f", inFile, "-w", outFile]),
    };
  } catch {
    return null;
  }
}

// -- models -----------------------------------------------------------------------

/**
 * Kokoro audio for one sentence. The text goes through an explicitly CLOSED
 * TextSplitterStream: kokoro-js's stream(string) never closes the splitter
 * it creates, so its iterator waits forever for more text after the last
 * sentence, and Node then exits with nothing left to run.
 */
async function synthesizeKokoro(kokoro, tts, text, voice) {
  const splitter = new kokoro.TextSplitterStream();
  splitter.push(text);
  splitter.close();
  const parts = [];
  let sampleRate = 24000;
  let length = 0;
  for await (const part of tts.stream(splitter, { voice })) {
    parts.push(part.audio.audio);
    length += part.audio.audio.length;
    sampleRate = part.audio.sampling_rate || sampleRate;
  }
  const samples = new Float32Array(length);
  let at = 0;
  for (const p of parts) {
    samples.set(p, at);
    at += p.length;
  }
  return { samples, sampleRate };
}

async function transcribe(asr, audio, englishOnly) {
  const x = resample(audio.samples, audio.sampleRate, ASR_RATE);
  const options = englishOnly ? {} : { language: "english", task: "transcribe" };
  if (x.length > 30 * ASR_RATE) Object.assign(options, { chunk_length_s: 30, stride_length_s: 5 });
  const out = await asr(x, options);
  return String((Array.isArray(out) ? out[0]?.text : out?.text) ?? "").trim();
}

// -- the check ----------------------------------------------------------------------

async function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    log(`read-along-verify: ${err.message}\n\n${USAGE}`);
    return 2;
  }
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (opts.version) {
    process.stdout.write(`${pkg.version}\n`);
    return 0;
  }

  // Inputs first: a typo in a path should fail in a second, not after a
  // model download.
  let source;
  try {
    source = await readFile(opts.script, "utf8");
  } catch (err) {
    log(`read-along-verify: cannot read ${opts.script}: ${err.message}`);
    return 2;
  }
  const isMarkdown = /^\.(md|markdown|mdx)$/i.test(extname(opts.script));
  const sentences = splitSentences(isMarkdown ? markdownToText(source) : source);
  if (!sentences.length) {
    log(`read-along-verify: ${opts.script} has no sentences to verify`);
    return 2;
  }

  let compiled = null;
  if (opts.pronunciations) {
    try {
      compiled = compilePronunciations(parsePronunciations(await readFile(opts.pronunciations, "utf8")));
    } catch (err) {
      log(`read-along-verify: cannot use ${opts.pronunciations}: ${err.message}`);
      return 2;
    }
    if (compiled.skipped.length) {
      log(`warning: skipped pronunciation entries without a non-empty text key and value: ${compiled.skipped.join(", ")}`);
    }
  }

  const deps = await loadOptionalDeps();
  if (deps.missing.length) {
    log(installHelp(deps.missing));
    return 2;
  }
  const { KokoroTTS } = deps.kokoro;
  const { pipeline } = deps.transformers;

  const control = await detectControlVoice();
  if (!control) {
    log("warning: no OS voice found for the control test (Windows SAPI, macOS say, espeak-ng on Linux).");
    log("         Mismatches will be reported as unconfirmed: a defect is a hypothesis until a second engine confirms it.");
  }

  log(`Loading the voice: ${KOKORO_MODEL} (${KOKORO_DTYPE})…`);
  const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL, { dtype: KOKORO_DTYPE, device: "cpu" });
  if (!Object.prototype.hasOwnProperty.call(tts.voices, opts.voice)) {
    log(`read-along-verify: unknown voice "${opts.voice}". Available: ${Object.keys(tts.voices).join(", ")}`);
    return 2;
  }
  log(`Loading the transcriber: ${opts.model} (${opts.dtype})…`);
  let asr;
  try {
    asr = await pipeline("automatic-speech-recognition", opts.model, { dtype: opts.dtype, device: "cpu" });
  } catch (err) {
    log(`read-along-verify: cannot load the transcriber ${opts.model}: ${err.message}`);
    return 2;
  }
  const englishOnly = /\.en$/i.test(opts.model);

  const findings = [];
  const fixes = [];
  const usedKeys = new Set();
  const tmp = await mkdtemp(join(tmpdir(), "read-along-verify-"));
  try {
    for (let i = 0; i < sentences.length; i++) {
      const text = sentences[i];
      log(`Sentence ${i + 1} of ${sentences.length}`);
      const tokens = tokenize(text);
      const expected = expectedWords(tokens);
      const view = spokenChunk({ tokens }, compiled);
      for (const m of view.matches) usedKeys.add(m.key);

      const tested = compareTranscript(expected, await transcribe(asr, await synthesizeKokoro(deps.kokoro, tts, view.text, opts.voice), englishOnly));
      if (!tested.regions.length && !view.matches.length) continue;

      // The control voice says the WRITTEN sentence: it is the reference for
      // how the written words transcribe when someone else says them.
      let controlResult = null;
      if (control && tested.regions.length) {
        const inFile = join(tmp, `s${i}.txt`);
        const outFile = join(tmp, `s${i}.wav`);
        await writeFile(inFile, tokens.map((t) => t.text).join(" "), "utf8");
        try {
          await control.synth(inFile, outFile);
          const wav = parseWav(await readFile(outFile));
          controlResult = compareTranscript(expected, await transcribe(asr, wav, englishOnly));
        } catch (err) {
          log(`warning: the control voice failed on sentence ${i + 1}: ${err.message}`);
        }
      }

      const verdicts = new Map(
        tested.regions.map((r) => [r, classifyRegion(r, tested, controlResult, expected)])
      );

      // Mismatches on a replaced word are reported as fix results, once.
      const claimed = new Set();
      for (const m of view.matches) {
        const idx = expected.map((w, k) => (w.token >= m.first && w.token <= m.last ? k : -1)).filter((k) => k >= 0);
        if (!idx.length) continue;
        const lo = idx[0];
        const hi = idx[idx.length - 1] + 1;
        const hits = tested.regions.filter((r) => overlaps(r, lo, hi));
        hits.forEach((r) => claimed.add(r));
        const written = expected.slice(lo, hi).map((w) => w.raw).join(" ");
        let status = "fixed";
        let heard = expected.slice(lo, hi).map((w, k) => tested.heard[tested.heardAt[lo + k]]?.raw ?? w.raw).join(" ");
        let controlHeard = null;
        if (hits.length) {
          const v = hits.map((r) => verdicts.get(r));
          heard = v.map((x) => x.heard).join(" ");
          controlHeard = v[0].control;
          const kinds = new Set(v.map((x) => x.classification));
          status = kinds.has("synthesis-defect") || kinds.has("inconclusive") ? "not-fixed"
            : kinds.has("unconfirmed") ? "unconfirmed"
            : "unverifiable";
        }
        fixes.push({ sentence: i + 1, text, key: m.key, spoken: m.spoken, expected: written, heard, control: controlHeard, status });
      }

      for (const r of tested.regions) {
        if (claimed.has(r)) continue;
        const v = verdicts.get(r);
        findings.push({
          sentence: i + 1,
          text,
          expected: v.expected,
          heard: v.heard,
          control: v.control,
          classification: v.classification,
        });
      }
    }
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }

  const summary = summarize(findings, fixes);
  const result = {
    tool: "read-along-verify",
    version: pkg.version,
    script: opts.script,
    sentences: sentences.length,
    tts: { engine: "kokoro-js", model: KOKORO_MODEL, voice: opts.voice, dtype: KOKORO_DTYPE },
    transcriber: { model: opts.model, dtype: opts.dtype },
    control: control ? { engine: control.engine, voice: control.voice } : null,
    pronunciations: compiled ? { file: opts.pronunciations, entries: compiled.size } : null,
    findings,
    fixes,
    unused: compiled ? compiled.entries.map((e) => e.key).filter((k) => !usedKeys.has(k)) : [],
    summary,
  };
  result.ok = summary["synthesis-defect"] === 0 && summary.fixes["not-fixed"] === 0;
  process.stdout.write(opts.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatReport(result)}\n`);
  return result.ok ? 0 : 1;
}

// Until main() settles, the exit code says "could not run". If a model
// promise never resolves, Node exits when the event loop empties, and that
// must never be mistaken for a clean pass by a CI job.
let settled = false;
process.exitCode = 2;
process.on("exit", () => {
  if (!settled) log("read-along-verify: stopped before the check finished (an engine never returned). Exit code 2.");
});

main(process.argv.slice(2)).then(
  (code) => {
    settled = true;
    process.exitCode = code;
  },
  (err) => {
    settled = true;
    log(`read-along-verify: ${err?.stack ?? err}`);
    process.exitCode = 2;
  }
);
