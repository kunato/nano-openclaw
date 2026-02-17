import sharp from "sharp";

// Anthropic API limits: max 8000px per side, but in practice >2000px in
// multi-image requests can fail. Stay well under the limit.
const MAX_IMAGE_DIMENSION_PX = 2000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5MB

export type ImageMetadata = {
  width: number;
  height: number;
};

export async function getImageMetadata(
  buffer: Buffer,
): Promise<ImageMetadata | null> {
  try {
    const meta = await sharp(buffer, { failOnError: false }).metadata();
    if (
      typeof meta.width === "number" &&
      typeof meta.height === "number" &&
      meta.width > 0 &&
      meta.height > 0
    ) {
      return { width: meta.width, height: meta.height };
    }
    return null;
  } catch {
    return null;
  }
}

export async function resizeToJpeg(params: {
  buffer: Buffer;
  maxSide: number;
  quality: number;
  withoutEnlargement?: boolean;
}): Promise<Buffer> {
  return await sharp(params.buffer, { failOnError: false })
    .rotate() // auto-rotate based on EXIF
    .resize({
      width: params.maxSide,
      height: params.maxSide,
      fit: "inside",
      withoutEnlargement: params.withoutEnlargement !== false,
    })
    .jpeg({ quality: params.quality, mozjpeg: true })
    .toBuffer();
}

/**
 * Normalize an image buffer so it stays within API limits.
 * Tries progressively smaller sizes and lower quality until under maxBytes.
 * Returns the normalized buffer + content type.
 */
export async function normalizeImage(
  buffer: Buffer,
  opts?: {
    maxSide?: number;
    maxBytes?: number;
  },
): Promise<{ buffer: Buffer; mimeType: string }> {
  const maxSide = Math.max(1, Math.round(opts?.maxSide ?? MAX_IMAGE_DIMENSION_PX));
  const maxBytes = Math.max(1, Math.round(opts?.maxBytes ?? MAX_IMAGE_BYTES));

  const meta = await getImageMetadata(buffer);
  const width = meta?.width ?? 0;
  const height = meta?.height ?? 0;
  const maxDim = Math.max(width, height);

  // Already within limits — return as-is
  if (
    buffer.byteLength <= maxBytes &&
    (maxDim === 0 || (width <= maxSide && height <= maxSide))
  ) {
    // Infer MIME type from buffer magic bytes
    const mimeType = inferMimeType(buffer) ?? "image/png";
    return { buffer, mimeType };
  }

  // Progressive resize: try different sizes × qualities
  const qualities = [85, 75, 65, 55, 45, 35];
  const sideStart = maxDim > 0 ? Math.min(maxSide, maxDim) : maxSide;
  const sideGrid = [sideStart, 1800, 1600, 1400, 1200, 1000, 800]
    .map((v) => Math.min(maxSide, v))
    .filter((v, i, arr) => v > 0 && arr.indexOf(v) === i)
    .sort((a, b) => b - a);

  let smallest: { buffer: Buffer; size: number } | null = null;

  for (const side of sideGrid) {
    for (const quality of qualities) {
      const out = await resizeToJpeg({
        buffer,
        maxSide: side,
        quality,
        withoutEnlargement: true,
      });

      if (!smallest || out.byteLength < smallest.size) {
        smallest = { buffer: out, size: out.byteLength };
      }

      if (out.byteLength <= maxBytes) {
        return { buffer: out, mimeType: "image/jpeg" };
      }
    }
  }

  // Return the smallest we got, even if over maxBytes
  const best = smallest?.buffer ?? buffer;
  console.warn(
    `[image-ops] Could not reduce image below ${(maxBytes / (1024 * 1024)).toFixed(0)}MB (got ${(best.byteLength / (1024 * 1024)).toFixed(2)}MB)`,
  );
  return { buffer: best, mimeType: "image/jpeg" };
}

/**
 * Normalize a base64-encoded image. Returns normalized base64 + mimeType.
 */
export async function normalizeBase64Image(
  base64: string,
  mimeType: string,
  opts?: { maxSide?: number; maxBytes?: number },
): Promise<{ base64: string; mimeType: string; resized: boolean }> {
  const buf = Buffer.from(base64, "base64");
  const meta = await getImageMetadata(buf);
  const maxSide = opts?.maxSide ?? MAX_IMAGE_DIMENSION_PX;
  const maxBytes = opts?.maxBytes ?? MAX_IMAGE_BYTES;

  const width = meta?.width ?? 0;
  const height = meta?.height ?? 0;

  // Already within limits
  if (
    buf.byteLength <= maxBytes &&
    (width === 0 || (width <= maxSide && height <= maxSide))
  ) {
    return { base64, mimeType, resized: false };
  }

  const normalized = await normalizeImage(buf, opts);
  return {
    base64: normalized.buffer.toString("base64"),
    mimeType: normalized.mimeType,
    resized: true,
  };
}

function inferMimeType(buffer: Buffer): string | undefined {
  if (buffer.length < 4) return undefined;
  // JPEG: FF D8
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
  // PNG: 89 50 4E 47
  if (
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47
  )
    return "image/png";
  // GIF: 47 49 46
  if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46)
    return "image/gif";
  // WebP: 52 49 46 46 ... 57 45 42 50
  if (
    buffer[0] === 0x52 &&
    buffer[1] === 0x49 &&
    buffer[2] === 0x46 &&
    buffer[3] === 0x46 &&
    buffer.length > 11 &&
    buffer[8] === 0x57 &&
    buffer[9] === 0x45 &&
    buffer[10] === 0x42 &&
    buffer[11] === 0x50
  )
    return "image/webp";
  return undefined;
}
