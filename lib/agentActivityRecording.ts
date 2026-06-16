import { adminStorage } from "@/lib/firebaseAdmin";
import { spawn } from "node:child_process";
import ffmpegPath from "ffmpeg-static";

export type ResolvedRecording = {
  recordingUrl: string;
  recordingFileName: string;
};

function guessRecordingFileName(source: string, callId?: string): string {
  const fromPath = source.split(/[/?#]/).pop() || "";
  const cleaned = fromPath.replace(/[^\w.\-()+]/g, "");
  if (cleaned && cleaned.includes(".")) return cleaned;
  const safeCallId = (callId || "call").replace(/[^\w.\-()+]/g, "") || "call";
  return `recording-${safeCallId}.wav`;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

function isStorageReference(value: string): boolean {
  if (!value) return false;
  if (isHttpUrl(value) || value.startsWith("gs://")) return true;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return false;
  return value.includes("/") || /\.[a-z0-9]{2,5}($|[?#])/i.test(value);
}

function cleanObjectPath(path: string): string {
  const withoutQuery = path.split(/[?#]/)[0] || path;
  try {
    return decodeURIComponent(withoutQuery.replace(/\+/g, " "));
  } catch {
    return withoutQuery;
  }
}

/** Read recording fields from Firestore, supporting common aliases from call-center integrations. */
export function resolveRecordingFields(
  data: FirebaseFirestore.DocumentData,
  callId?: string
): ResolvedRecording {
  const fileNameRaw =
    data.recordingFileName ?? data.recording_file_name ?? data.recordingFile ?? "";
  const fileName =
    typeof fileNameRaw === "string" && fileNameRaw.trim() && !fileNameRaw.startsWith("http")
      ? fileNameRaw.trim()
      : "";

  const candidates = [
    data.recordingUrl,
    data.recordingFileUrl,
    data.recording_url,
    data.recordingFile,
    data.recording_file,
  ];

  for (const candidate of candidates) {
    const value = typeof candidate === "string" ? candidate.trim() : "";
    if (!value) continue;
    if (isStorageReference(value)) {
      return {
        recordingUrl: value,
        recordingFileName: fileName || guessRecordingFileName(value, callId),
      };
    }
  }

  return { recordingUrl: "", recordingFileName: "" };
}

function parseStorageUrl(url: string): { bucket: string; path: string } | null {
  try {
    const fbMatch = url.match(/firebasestorage\.googleapis\.com\/v0\/b\/([^/]+)\/o\/([^?]+)/);
    if (fbMatch) {
      let path = fbMatch[2];
      try {
        path = cleanObjectPath(path);
      } catch {
        path = fbMatch[2];
      }
      return { bucket: decodeURIComponent(fbMatch[1]), path };
    }

    const sgMatch = url.match(/storage\.googleapis\.com\/([^/]+)\/(.+)/);
    if (sgMatch) {
      return {
        bucket: decodeURIComponent(sgMatch[1]),
        path: cleanObjectPath(sgMatch[2]),
      };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function guessContentType(fileName: string, fallback = "application/octet-stream"): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".wave")) return "audio/wav";
  if (lower.endsWith(".ogg")) return "audio/ogg";
  if (lower.endsWith(".m4a") || lower.endsWith(".mp4")) return "audio/mp4";
  if (lower.endsWith(".webm")) return "audio/webm";
  return fallback;
}

function normalizeContentType(contentType: string | undefined, fileName: string): string {
  const guessed = guessContentType(fileName);
  const type = contentType?.split(";")[0]?.trim().toLowerCase() || "";
  if (!type || type === "application/octet-stream" || type === "binary/octet-stream") {
    return guessed;
  }
  return type;
}

function bufferSignature(buffer: Buffer): string {
  const sample = buffer.subarray(0, Math.min(buffer.length, 24));
  const hex = Array.from(sample)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
  const ascii = sample
    .toString("ascii")
    .replace(/[^\x20-\x7e]/g, ".");
  return `hex=${hex}; ascii=${ascii}`;
}

function detectAudioContentType(buffer: Buffer, fileName: string): string {
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WAVE") {
    return "audio/wav";
  }
  if (buffer.length >= 3 && buffer.toString("ascii", 0, 3) === "ID3") return "audio/mpeg";
  if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return "audio/mpeg";
  if (buffer.length >= 4 && buffer.toString("ascii", 0, 4) === "OggS") return "audio/ogg";
  if (buffer.length >= 4 && buffer.toString("ascii", 0, 4) === "fLaC") return "audio/flac";
  if (buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) {
    return "audio/webm";
  }
  if (buffer.length >= 12 && buffer.toString("ascii", 4, 8) === "ftyp") return "audio/mp4";
  if (buffer.length >= 6 && buffer.toString("ascii", 0, 6) === "#!AMR\n") return "audio/amr";
  const guessed = guessContentType(fileName, "");
  return guessed;
}

function readWavChunks(buffer: Buffer): {
  fmtOffset: number;
  fmtSize: number;
  dataOffset: number;
  dataSize: number;
} | null {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    return null;
  }

  let offset = 12;
  let fmtOffset = -1;
  let fmtSize = 0;
  let dataOffset = -1;
  let dataSize = 0;

  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const chunkDataOffset = offset + 8;
    if (chunkDataOffset + size > buffer.length) break;

    if (id === "fmt ") {
      fmtOffset = chunkDataOffset;
      fmtSize = size;
    } else if (id === "data") {
      dataOffset = chunkDataOffset;
      dataSize = size;
    }

    offset = chunkDataOffset + size + (size % 2);
  }

  if (fmtOffset < 0 || dataOffset < 0) return null;
  return { fmtOffset, fmtSize, dataOffset, dataSize };
}

function decodeMuLaw(value: number): number {
  const u = (~value) & 0xff;
  const sign = u & 0x80;
  const exponent = (u >> 4) & 0x07;
  const mantissa = u & 0x0f;
  let sample = ((mantissa << 3) + 0x84) << exponent;
  sample -= 0x84;
  return sign ? -sample : sample;
}

function decodeALaw(value: number): number {
  const a = value ^ 0x55;
  const sign = a & 0x80;
  const exponent = (a & 0x70) >> 4;
  const mantissa = a & 0x0f;
  const sample = exponent === 0
    ? (mantissa << 4) + 8
    : ((mantissa << 4) + 0x108) << (exponent - 1);
  return sign ? sample : -sample;
}

function createPcmWav(samples: Int16Array, sampleRate: number, channels: number): Buffer {
  const dataSize = samples.length * 2;
  const out = Buffer.alloc(44 + dataSize);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + dataSize, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * channels * 2, 28);
  out.writeUInt16LE(channels * 2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i++) {
    out.writeInt16LE(samples[i], 44 + i * 2);
  }
  return out;
}

function convertG711WavToPcm(buffer: Buffer): Buffer | null {
  const chunks = readWavChunks(buffer);
  if (!chunks || chunks.fmtSize < 16) return null;

  const audioFormat = buffer.readUInt16LE(chunks.fmtOffset);
  if (audioFormat !== 6 && audioFormat !== 7) return null;

  const channels = buffer.readUInt16LE(chunks.fmtOffset + 2);
  const sampleRate = buffer.readUInt32LE(chunks.fmtOffset + 4);
  if (!channels || !sampleRate || chunks.dataSize <= 0) return null;

  const data = buffer.subarray(chunks.dataOffset, chunks.dataOffset + chunks.dataSize);
  const samples = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) {
    samples[i] = audioFormat === 6 ? decodeALaw(data[i]) : decodeMuLaw(data[i]);
  }
  return createPcmWav(samples, sampleRate, channels);
}

function isBrowserPlayableAudio(contentType: string): boolean {
  return [
    "audio/mpeg",
    "audio/mp3",
    "audio/mp4",
    "audio/ogg",
    "audio/webm",
  ].includes(contentType);
}

function isBrowserPlayableWav(buffer: Buffer): boolean {
  const chunks = readWavChunks(buffer);
  if (!chunks || chunks.fmtSize < 16) return false;
  const audioFormat = buffer.readUInt16LE(chunks.fmtOffset);
  // Browsers reliably handle PCM WAV. Float WAV is supported in modern Chromium,
  // but PCM is the safest target when PBX files vary by codec.
  return audioFormat === 1;
}

async function transcodeToPcmWav(buffer: Buffer, sourceName: string): Promise<Buffer> {
  const executable = ffmpegPath || process.env.FFMPEG_PATH || "ffmpeg";

  return new Promise((resolve, reject) => {
    const child = spawn(executable, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-map",
      "0:a:0",
      "-vn",
      "-acodec",
      "pcm_s16le",
      "-f",
      "wav",
      "pipe:1",
    ]);

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("FFmpeg timed out while converting recording"));
    }, 60_000);

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      const output = Buffer.concat(stdout);
      if (code === 0 && output.length > 44) {
        resolve(output);
        return;
      }
      const detail = Buffer.concat(stderr).toString("utf8").trim();
      reject(
        new Error(
          `FFmpeg could not convert recording${sourceName ? ` (${sourceName})` : ""}: ${detail || `exit ${code}`}`
        )
      );
    });

    child.stdin.end(buffer);
  });
}

async function prepareBrowserAudio(
  buffer: Buffer,
  contentType: string | undefined,
  sourceName: string
): Promise<{ buffer: Buffer; contentType: string }> {
  if (!buffer.length) {
    throw new Error("Recording file is empty");
  }

  if (detectAudioContentType(buffer, sourceName) === "audio/wav" && isBrowserPlayableWav(buffer)) {
    return { buffer, contentType: "audio/wav" };
  }

  const convertedWav = convertG711WavToPcm(buffer);
  if (convertedWav) {
    return { buffer: convertedWav, contentType: "audio/wav" };
  }

  const detected = detectAudioContentType(buffer, sourceName);
  const normalized = normalizeContentType(contentType || detected, sourceName);
  const contentTypeToSend = detected || normalized;
  if (/^(text\/html|application\/json|text\/plain)$/i.test(contentTypeToSend)) {
    throw new Error(`Recording URL returned ${contentTypeToSend}, not audio`);
  }

  if (isBrowserPlayableAudio(contentTypeToSend)) {
    return { buffer, contentType: contentTypeToSend };
  }

  try {
    const converted = await transcodeToPcmWav(buffer, sourceName);
    return { buffer: converted, contentType: "audio/wav" };
  } catch (error) {
    const message = error instanceof Error ? error.message : "FFmpeg conversion failed";
    throw new Error(`${message}. ${bufferSignature(buffer)}`);
  }
}

async function downloadFromGsUrl(gsUrl: string): Promise<{ buffer: Buffer; contentType: string }> {
  const withoutScheme = gsUrl.slice(5);
  const slash = withoutScheme.indexOf("/");
  if (slash <= 0) throw new Error("Invalid gs:// recording URL");
  const bucketName = withoutScheme.slice(0, slash);
  const objectPath = cleanObjectPath(withoutScheme.slice(slash + 1));
  const file = adminStorage().bucket(bucketName).file(objectPath);
  const [buffer] = await file.download();
  let contentType = guessContentType(objectPath);
  try {
    const [metadata] = await file.getMetadata();
    contentType = normalizeContentType(metadata.contentType, objectPath);
  } catch {
    /* use guessed type */
  }
  return prepareBrowserAudio(buffer, contentType, objectPath);
}

async function downloadFromStorageUrl(url: string): Promise<{ buffer: Buffer; contentType: string } | null> {
  const parsed = parseStorageUrl(url);
  if (!parsed) return null;

  try {
    const file = adminStorage().bucket(parsed.bucket).file(parsed.path);
    const [buffer] = await file.download();
    let contentType = guessContentType(parsed.path);
    try {
      const [metadata] = await file.getMetadata();
      contentType = normalizeContentType(metadata.contentType, parsed.path);
    } catch {
      /* use guessed type */
    }
    return prepareBrowserAudio(buffer, contentType, parsed.path);
  } catch {
    const defaultBucketName =
      process.env.FIREBASE_STORAGE_BUCKET ||
      process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET ||
      "";
    if (defaultBucketName && defaultBucketName !== parsed.bucket) {
      try {
        const file = adminStorage().bucket(defaultBucketName).file(parsed.path);
        const [buffer] = await file.download();
        return prepareBrowserAudio(buffer, guessContentType(parsed.path), parsed.path);
      } catch {
        return null;
      }
    }
    return null;
  }
}

async function downloadFromDefaultStoragePath(path: string): Promise<{ buffer: Buffer; contentType: string }> {
  const objectPath = cleanObjectPath(path);
  const file = adminStorage().bucket().file(objectPath);
  const [buffer] = await file.download();
  let contentType = guessContentType(objectPath);
  try {
    const [metadata] = await file.getMetadata();
    contentType = normalizeContentType(metadata.contentType, objectPath);
  } catch {
    /* use guessed type */
  }
  return prepareBrowserAudio(buffer, contentType, objectPath);
}

/** Fetch recording bytes from https, gs://, Firebase Storage URLs, or object paths. */
export async function fetchRecordingBuffer(
  recordingUrl: string,
  fileName: string
): Promise<{ buffer: Buffer; contentType: string }> {
  const trimmed = recordingUrl.trim();
  if (!trimmed) throw new Error("Missing recording URL");

  if (trimmed.startsWith("gs://")) {
    return downloadFromGsUrl(trimmed);
  }

  if (!isHttpUrl(trimmed)) {
    return downloadFromDefaultStoragePath(trimmed);
  }

  const fromStorage = await downloadFromStorageUrl(trimmed);
  if (fromStorage?.buffer.length) return fromStorage;

  const res = await fetch(trimmed, {
    headers: { Accept: "audio/*,*/*" },
    cache: "no-store",
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    throw new Error(`Failed to fetch recording (${res.status})`);
  }
  const arr = await res.arrayBuffer();
  const buffer = Buffer.from(arr);
  return prepareBrowserAudio(buffer, res.headers.get("content-type") || undefined, fileName);
}
