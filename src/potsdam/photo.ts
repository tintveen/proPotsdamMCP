import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import sharp, { type Metadata } from "sharp";
import {
  POTSDAM_WASTE_MAX_INPUT_PIXELS,
  POTSDAM_WASTE_MAX_OUTPUT_LONG_EDGE,
  POTSDAM_WASTE_OUTPUT_JPEG_QUALITY
} from "./config.js";
import type { PotsdamWastePhoto, VerifiedPotsdamWastePhoto } from "./types.js";
import { PotsdamWasteError } from "./types.js";

const MAX_PHOTO_BYTES = 8 * 1024 * 1024;
const MIN_OUTPUT_LONG_EDGE = 256;
const CONVERSION_HINT = "Convert the image to a regular, non-animated JPEG or PNG and try again.";

type SupportedInput = "jpeg" | "png" | "webp";

export async function stagePotsdamWastePhoto(
  sourcePath: string,
  stagingDirectory: string
): Promise<PotsdamWastePhoto> {
  const source = await readRegularNonSymlinkFile(sourcePath, MAX_PHOTO_BYTES, "input photo");
  const detected = detectSupportedInput(source);
  const metadata = await readImageMetadata(source);
  validateInputMetadata(detected, metadata);

  let targetLongEdge = Math.max(
    MIN_OUTPUT_LONG_EDGE,
    Math.min(
      POTSDAM_WASTE_MAX_OUTPUT_LONG_EDGE,
      Math.max(metadata.width ?? 0, metadata.height ?? 0)
    )
  );
  let normalized: Buffer | undefined;
  let width = 0;
  let height = 0;

  while (targetLongEdge >= MIN_OUTPUT_LONG_EDGE) {
    const result = await normalizePhoto(source, targetLongEdge);
    normalized = result.data;
    width = result.info.width;
    height = result.info.height;
    if (normalized.byteLength <= MAX_PHOTO_BYTES) {
      break;
    }
    targetLongEdge = Math.floor(targetLongEdge * 0.85);
    normalized = undefined;
  }

  if (!normalized) {
    throw new PotsdamWasteError(
      `The normalized JPEG would exceed 8 MB. ${CONVERSION_HINT}`,
      "PHOTO_INVALID"
    );
  }

  await ensureSafeStagingDirectory(stagingDirectory);
  const filename = `potsdam-waste-${randomUUID()}.jpg`;
  const outputPath = path.resolve(stagingDirectory, filename);
  await writeNewPrivateFile(outputPath, normalized);

  const photo: PotsdamWastePhoto = {
    path: outputPath,
    filename,
    mimeType: "image/jpeg",
    byteLength: normalized.byteLength,
    sha256: sha256(normalized),
    width,
    height
  };
  try {
    await verifyStagedPotsdamWastePhoto(photo);
  } catch (error) {
    await rm(outputPath, { force: true }).catch(() => undefined);
    throw error;
  }
  return photo;
}

/**
 * Reopens a staged artifact without following symlinks and verifies its hash,
 * size, dimensions, format, animation state, and absence of common metadata.
 * The returned bytes are the exact bytes that should be attached immediately
 * afterward by a confirmation commit.
 */
export async function verifyStagedPotsdamWastePhoto(
  photo: PotsdamWastePhoto
): Promise<VerifiedPotsdamWastePhoto> {
  validateStoredPhotoRecord(photo);
  const bytes = await readRegularNonSymlinkFile(photo.path, MAX_PHOTO_BYTES, "staged photo");

  if (bytes.byteLength !== photo.byteLength) {
    throw changedPhoto("The staged photo size changed after confirmation was prepared.");
  }
  const actualHash = Buffer.from(sha256(bytes), "hex");
  const expectedHash = Buffer.from(photo.sha256, "hex");
  if (actualHash.length !== expectedHash.length || !timingSafeEqual(actualHash, expectedHash)) {
    throw changedPhoto("The staged photo content changed after confirmation was prepared.");
  }
  if (!isJpeg(bytes)) {
    throw changedPhoto("The staged photo is no longer a JPEG.");
  }

  const metadata = await readImageMetadata(bytes);
  if (
    metadata.format !== "jpeg"
    || !metadata.width
    || !metadata.height
    || metadata.width !== photo.width
    || metadata.height !== photo.height
    || metadata.width > POTSDAM_WASTE_MAX_OUTPUT_LONG_EDGE
    || metadata.height > POTSDAM_WASTE_MAX_OUTPUT_LONG_EDGE
    || metadata.width * metadata.height > POTSDAM_WASTE_MAX_INPUT_PIXELS
    || (metadata.pages ?? 1) !== 1
  ) {
    throw changedPhoto("The staged photo geometry or format changed after confirmation was prepared.");
  }
  if (hasSensitiveMetadata(metadata)) {
    throw changedPhoto("The staged photo unexpectedly contains metadata.");
  }

  return {
    photo,
    bytes: new Uint8Array(bytes)
  };
}

function detectSupportedInput(bytes: Buffer): SupportedInput {
  if (isJpeg(bytes)) {
    return "jpeg";
  }
  if (isPng(bytes)) {
    return "png";
  }
  if (isGif(bytes)) {
    throw conversionRequired("GIF images, including static GIFs, are not accepted by the privacy normalizer.");
  }
  if (isWebp(bytes)) {
    if (hasAnimatedWebpChunk(bytes)) {
      throw conversionRequired("Animated WebP images are not accepted.");
    }
    return "webp";
  }
  if (isIsoBmffImage(bytes)) {
    throw conversionRequired("HEIC, HEIF, and other ISO-BMFF images are not accepted.");
  }
  throw new PotsdamWasteError(
    `Only JPEG, PNG, and static WebP input is accepted. ${CONVERSION_HINT}`,
    "PHOTO_INVALID"
  );
}

async function readImageMetadata(bytes: Buffer): Promise<Metadata> {
  try {
    return await sharp(bytes, {
      animated: true,
      failOn: "error",
      limitInputPixels: POTSDAM_WASTE_MAX_INPUT_PIXELS
    }).metadata();
  } catch (error) {
    if (error instanceof PotsdamWasteError) {
      throw error;
    }
    throw new PotsdamWasteError("The photo could not be decoded safely.", "PHOTO_INVALID");
  }
}

function validateInputMetadata(detected: SupportedInput, metadata: Metadata): void {
  if (metadata.format !== detected) {
    throw new PotsdamWasteError("The photo magic bytes and decoded format do not agree.", "PHOTO_INVALID");
  }
  if (!metadata.width || !metadata.height) {
    throw new PotsdamWasteError("The photo dimensions could not be determined.", "PHOTO_INVALID");
  }
  if (metadata.width * metadata.height > POTSDAM_WASTE_MAX_INPUT_PIXELS) {
    throw new PotsdamWasteError("The photo exceeds the 50-megapixel safety limit.", "PHOTO_INVALID");
  }
  if ((metadata.pages ?? 1) !== 1) {
    throw conversionRequired("Animated or multi-page images are not accepted.");
  }
}

async function normalizePhoto(bytes: Buffer, targetLongEdge: number) {
  try {
    return await sharp(bytes, {
      failOn: "error",
      limitInputPixels: POTSDAM_WASTE_MAX_INPUT_PIXELS
    })
      .rotate()
      .resize({
        width: targetLongEdge,
        height: targetLongEdge,
        fit: "inside",
        withoutEnlargement: true
      })
      .flatten({ background: "#ffffff" })
      .jpeg({
        quality: POTSDAM_WASTE_OUTPUT_JPEG_QUALITY,
        progressive: false,
        chromaSubsampling: "4:2:0"
      })
      .toBuffer({ resolveWithObject: true });
  } catch {
    throw new PotsdamWasteError("The photo could not be normalized safely.", "PHOTO_INVALID");
  }
}

async function readRegularNonSymlinkFile(
  filePath: string,
  maxBytes: number,
  label: string
): Promise<Buffer> {
  const resolved = path.resolve(filePath);
  let pathStats;
  try {
    pathStats = await lstat(resolved);
  } catch {
    throw new PotsdamWasteError(`The ${label} cannot be accessed.`, "PHOTO_INVALID");
  }
  if (pathStats.isSymbolicLink() || !pathStats.isFile()) {
    throw new PotsdamWasteError(`The ${label} must be a regular, non-symlink file.`, "PHOTO_INVALID");
  }
  if (pathStats.size <= 0 || pathStats.size > maxBytes) {
    throw new PotsdamWasteError(`The ${label} must be between 1 byte and 8 MB.`, "PHOTO_INVALID");
  }

  let handle;
  try {
    handle = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
    const handleStats = await handle.stat();
    if (!handleStats.isFile() || handleStats.size !== pathStats.size || handleStats.size > maxBytes) {
      throw new PotsdamWasteError(`The ${label} changed while it was being opened.`, "PHOTO_CHANGED");
    }
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    if (offset !== handleStats.size || offset > maxBytes) {
      throw new PotsdamWasteError(`The ${label} changed while it was being read.`, "PHOTO_CHANGED");
    }
    return buffer.subarray(0, offset);
  } catch (error) {
    if (error instanceof PotsdamWasteError) {
      throw error;
    }
    throw new PotsdamWasteError(`The ${label} could not be read safely.`, "PHOTO_INVALID");
  } finally {
    await handle?.close();
  }
}

async function ensureSafeStagingDirectory(directory: string): Promise<void> {
  const resolved = path.resolve(directory);
  await mkdir(resolved, { recursive: true, mode: 0o700 });
  const stats = await lstat(resolved);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new PotsdamWasteError("The photo staging location must be a regular directory, not a symlink.", "PHOTO_INVALID");
  }
  await chmod(resolved, 0o700);
}

async function writeNewPrivateFile(filePath: string, bytes: Buffer): Promise<void> {
  let handle;
  try {
    handle = await open(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

function validateStoredPhotoRecord(photo: PotsdamWastePhoto): void {
  if (
    !path.isAbsolute(photo.path)
    || path.basename(photo.path) !== photo.filename
    || !/^potsdam-waste-[0-9a-f-]+\.jpg$/i.test(photo.filename)
    || photo.mimeType !== "image/jpeg"
    || !Number.isInteger(photo.byteLength)
    || photo.byteLength <= 0
    || photo.byteLength > MAX_PHOTO_BYTES
    || !/^[0-9a-f]{64}$/.test(photo.sha256)
    || !Number.isInteger(photo.width)
    || !Number.isInteger(photo.height)
    || photo.width <= 0
    || photo.height <= 0
  ) {
    throw changedPhoto("The persisted staged-photo record is invalid.");
  }
}

function hasSensitiveMetadata(metadata: Metadata): boolean {
  return Boolean(
    metadata.exif
    || metadata.icc
    || metadata.iptc
    || metadata.xmp
    || metadata.orientation
    || (metadata.comments && metadata.comments.length > 0)
  );
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

function isPng(bytes: Uint8Array): boolean {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return bytes.length >= signature.length && signature.every((value, index) => bytes[index] === value);
}

function isGif(bytes: Buffer): boolean {
  const header = bytes.subarray(0, 6).toString("ascii");
  return header === "GIF87a" || header === "GIF89a";
}

function isWebp(bytes: Buffer): boolean {
  return bytes.length >= 12
    && bytes.subarray(0, 4).toString("ascii") === "RIFF"
    && bytes.subarray(8, 12).toString("ascii") === "WEBP";
}

function hasAnimatedWebpChunk(bytes: Buffer): boolean {
  return bytes.indexOf(Buffer.from("ANIM"), 12) >= 0 || bytes.indexOf(Buffer.from("ANMF"), 12) >= 0;
}

function isIsoBmffImage(bytes: Buffer): boolean {
  if (bytes.length < 12 || bytes.subarray(4, 8).toString("ascii") !== "ftyp") {
    return false;
  }
  const brands = bytes.subarray(8, Math.min(bytes.length, 40)).toString("ascii");
  return /heic|heix|hevc|hevx|heif|mif1|msf1|avif|avis/i.test(brands);
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function conversionRequired(message: string): PotsdamWasteError {
  return new PotsdamWasteError(`${message} ${CONVERSION_HINT}`, "PHOTO_CONVERSION_REQUIRED");
}

function changedPhoto(message: string): PotsdamWasteError {
  return new PotsdamWasteError(message, "PHOTO_CHANGED");
}
