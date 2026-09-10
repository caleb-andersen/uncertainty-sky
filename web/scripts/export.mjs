/**
 * Export the flight as a video file, with the soundtrack.
 *
 * Screen recording captures whatever the machine managed to draw. This does
 * not: the page renders film frame n as film second n / RECORD_FPS, posts it
 * here, and waits for the encoder to take it before drawing the next one. A
 * slow machine makes the export take longer and changes nothing about the
 * result. No frame is ever dropped, duplicated or early.
 *
 * Frames are piped straight into ffmpeg, so a 98-second film never lands on
 * disk as thousands of PNGs. Audio is muxed in the same pass.
 *
 * Usage, from `web`:  npm run export -- [options]
 *   --width, --height  video size, default 1920 × 1080
 *   --out              output file, default exports/uncertainty-sky.mp4
 *   --music            audio file, default music/soundtrack.mp3
 *   --seconds          export only the first n seconds, for a quick look
 *   --crf              x264 quality, lower is better, default 16
 *   --ffmpeg           path to ffmpeg, default `ffmpeg` on PATH
 *   --no-audio-fade    keep the soundtrack's own ending, with no fade-out
 *   --no-open          do not open a browser; the URL is printed instead
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FLIGHT_SECONDS, RECORD_FPS } from '../src/flight.ts';

const AUDIO_FADE_SECONDS = 2;
const HOST = '127.0.0.1';
/** Longest silence tolerated from the page before the export is abandoned. */
const IDLE_TIMEOUT_MS = 300_000;
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.bin': 'application/octet-stream',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.mp3': 'audio/mpeg',
};

const args = process.argv.slice(2);
const value = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 || index + 1 >= args.length ? fallback : args[index + 1];
};
const here = (path) => fileURLToPath(new URL(path, import.meta.url));

const width = Math.round(Number(value('width', 1920)));
const height = Math.round(Number(value('height', 1080)));
const crf = String(Number(value('crf', 16)));
const ffmpegPath = value('ffmpeg', process.env.FFMPEG || 'ffmpeg');
const musicPath = resolve(value('music', here('../music/soundtrack.mp3')));
const outputPath = resolve(value('out', here('../exports/uncertainty-sky.mp4')));
// A shorter cut for checking the look and the sound without waiting for the
// whole film. The frames are the film's own opening; nothing is re-timed.
const filmSeconds = Math.min(Number(value('seconds', FLIGHT_SECONDS)), FLIGHT_SECONDS);
const audioFade = !args.includes('--no-audio-fade');
const openBrowser = !args.includes('--no-open');
const distDir = here('../dist');
const totalFrames = Math.round(filmSeconds * RECORD_FPS);

const fail = (message, hint) => {
  console.error(`\n${message}`);
  if (hint) console.error(hint);
  process.exit(1);
};

if (!Number.isFinite(filmSeconds) || filmSeconds <= 0) fail('--seconds must be positive.');
if (!Number.isFinite(width) || !Number.isFinite(height) || width < 16 || height < 16) {
  fail(`Invalid video size ${width} × ${height}.`);
}
// x264 with yuv420p needs even dimensions; refuse rather than silently resize.
if (width % 2 || height % 2) fail(`Video size ${width} × ${height} must be even in both axes.`);
if (!existsSync(join(distDir, 'index.html'))) {
  fail('No build found in dist/.', 'Run `npm run build` first, or use `npm run export`.');
}
if (!existsSync(musicPath)) fail(`No soundtrack at ${musicPath}.`, 'Pass --music <file> to use another.');

/** Fail before rendering 4,680 frames, not after. */
async function requireFfmpeg() {
  try {
    const probe = spawn(ffmpegPath, ['-version'], { stdio: 'ignore' });
    const [code] = await once(probe, 'exit');
    if (code !== 0) throw new Error(`exit ${code}`);
  } catch {
    fail(`Could not run ffmpeg (${ffmpegPath}).`,
      'Install it, then run this again:\n' +
      '  winget install --id Gyan.FFmpeg -e\n' +
      'Open a new terminal afterwards so PATH is picked up, ' +
      'or pass --ffmpeg <path to ffmpeg.exe>.');
  }
}

await requireFfmpeg();
mkdirSync(resolve(outputPath, '..'), { recursive: true });

const ffmpegArgs = [
  '-y', '-loglevel', 'error', '-nostats',
  '-f', 'image2pipe', '-framerate', String(RECORD_FPS), '-i', 'pipe:0',
  '-i', musicPath,
  '-map', '0:v:0', '-map', '1:a:0',
  '-c:v', 'libx264', '-preset', 'slow', '-crf', crf, '-pix_fmt', 'yuv420p',
  '-r', String(RECORD_FPS),
  '-c:a', 'aac', '-b:a', '192k',
  // The film is the master: a longer soundtrack is cut to it, a shorter one
  // simply ends. Without this the file would run on to the length of the mp3.
  '-t', String(filmSeconds),
  ...(audioFade && filmSeconds > AUDIO_FADE_SECONDS
    ? ['-af', `afade=t=out:st=${(filmSeconds - AUDIO_FADE_SECONDS).toFixed(3)}:d=${AUDIO_FADE_SECONDS}`]
    : []),
  '-movflags', '+faststart',
  outputPath,
];

const ffmpeg = spawn(ffmpegPath, ffmpegArgs, { stdio: ['pipe', 'inherit', 'pipe'] });
let ffmpegErrors = '';
ffmpeg.stderr.setEncoding('utf8');
ffmpeg.stderr.on('data', (chunk) => { ffmpegErrors += chunk; });
ffmpeg.stdin.on('error', () => {}); // Reported through the exit code instead.

let expected = 0;
let started = 0;
let idleTimer = null;
let finished = false;

const readBody = async (request) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks);
};

function shutdown(code, message) {
  if (finished) return;
  finished = true;
  clearTimeout(idleTimer);
  if (message) console.error(`\n${message}`);
  server.close();
  if (code !== 0 && ffmpeg.exitCode === null) ffmpeg.kill('SIGKILL');
  process.exit(code);
}

const touch = () => {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(
    () => shutdown(1, `No frame for ${IDLE_TIMEOUT_MS / 1_000}s. Is the browser tab still open and in front?`),
    IDLE_TIMEOUT_MS);
};

function serveStatic(request, response) {
  const path = decodeURIComponent(new URL(request.url, `http://${HOST}`).pathname);
  const file = join(distDir, path === '/' ? 'index.html' : path);
  // Keep the served tree inside dist/, whatever the request path claims.
  if (!file.startsWith(distDir) || !existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404).end('Not found');
    return;
  }
  response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(response);
}

const server = createServer(async (request, response) => {
  const { pathname } = new URL(request.url, `http://${HOST}`);
  if (request.method !== 'POST') return serveStatic(request, response);

  if (pathname === '/error') {
    const message = (await readBody(request)).toString();
    response.writeHead(200).end('ok');
    shutdown(1, `The page reported: ${message}`);
    return;
  }
  if (pathname === '/done') {
    response.writeHead(200).end('ok');
    clearTimeout(idleTimer);
    if (expected !== totalFrames) {
      shutdown(1, `Page finished after ${expected} frames; expected ${totalFrames}.`);
      return;
    }
    ffmpeg.stdin.end();
    const [code] = await once(ffmpeg, 'exit');
    finished = true;
    server.close();
    if (code !== 0) {
      console.error(`\nffmpeg failed (exit ${code}):\n${ffmpegErrors.trim()}`);
      process.exit(1);
    }
    const megabytes = (statSync(outputPath).size / 1e6).toFixed(1);
    const elapsed = ((Date.now() - started) / 1_000 / 60).toFixed(1);
    process.stdout.write('\r'.padEnd(80) + '\r');
    console.log(`Wrote ${outputPath}`);
    console.log(`${width} × ${height} · ${RECORD_FPS} fps · ${filmSeconds}s · ${megabytes} MB · exported in ${elapsed} min`);
    process.exit(0);
  }

  const frame = Number(pathname.slice('/frame/'.length));
  if (!pathname.startsWith('/frame/') || !Number.isInteger(frame)) {
    response.writeHead(404).end('Not found');
    return;
  }
  if (frame !== expected) {
    response.writeHead(409).end(`Out of order: expected frame ${expected}, received ${frame}`);
    return;
  }
  // Stop at the first frame past the end rather than at /done. An overrun means
  // the page is rendering a different film from the one asked for, and ffmpeg's
  // -t would otherwise trim the result into a plausible-looking wrong file.
  if (frame >= totalFrames) {
    response.writeHead(409).end(`Too many frames: expected ${totalFrames}`);
    shutdown(1, `The page sent more than ${totalFrames} frames, so it is not rendering ` +
      'the size or length this script asked for. Check that the browser opened the ' +
      'full URL above, query string included.');
    return;
  }
  const body = await readBody(request);
  if (!ffmpeg.stdin.writable) {
    response.writeHead(500).end('Encoder closed early');
    shutdown(1, `ffmpeg stopped early:\n${ffmpegErrors.trim()}`);
    return;
  }
  if (!ffmpeg.stdin.write(body)) await once(ffmpeg.stdin, 'drain');
  expected = frame + 1;
  touch();
  response.writeHead(200).end('ok');
  if (expected === 1) started = Date.now();
  if (expected % 30 === 0 || expected === totalFrames) {
    const share = expected / totalFrames;
    const minutes = (Date.now() - started) / 1_000 / 60;
    const left = share > 0.01 ? ` · about ${(minutes / share - minutes).toFixed(0)} min left` : '';
    process.stdout.write(`\rframe ${expected} / ${totalFrames} · ${(share * 100).toFixed(1)}%${left}   `);
  }
});

server.listen(0, HOST, () => {
  const { port } = server.address();
  const url = `http://${HOST}:${port}/?export&w=${width}&h=${height}&s=${filmSeconds}`;
  console.log(`Exporting ${width} × ${height} at ${RECORD_FPS} fps · ${totalFrames} frames · ${filmSeconds}s` +
    (filmSeconds < FLIGHT_SECONDS ? ` (first ${filmSeconds}s of ${FLIGHT_SECONDS}s)` : ''));
  console.log(`Soundtrack: ${musicPath}${audioFade ? ` (fading out over the last ${AUDIO_FADE_SECONDS}s)` : ''}`);
  console.log(`Output: ${outputPath}`);
  console.log(`\nRendering in ${openBrowser ? 'the browser tab that just opened' : 'your browser'}: ${url}`);
  console.log('Keep that tab visible and in front until it reports it is complete.\n');
  touch();
  if (!openBrowser) return;
  // cmd.exe treats an unquoted `&` as a command separator, so a bare URL would
  // reach the browser as just `?export` and the page would silently fall back
  // to 1920 x 1080 and the full film length. Node's own quoting escapes the
  // quotes past cmd's parser, so the URL is quoted here and passed verbatim.
  const [command, commandArgs, options] = process.platform === 'win32'
    ? ['cmd', ['/c', 'start', '""', `"${url}"`], { windowsVerbatimArguments: true }]
    : process.platform === 'darwin' ? ['open', [url], {}] : ['xdg-open', [url], {}];
  spawn(command, commandArgs, { stdio: 'ignore', detached: true, ...options }).on('error', () => {
    console.log('Could not open a browser automatically; open the URL above.');
  }).unref();
});

process.on('SIGINT', () => shutdown(1, 'Cancelled.'));
