// Turn pasted/dropped image files into API-ready base64 attachments.
// The API accepts jpeg/png/gif/webp up to 5MB and downscales anything whose
// long edge exceeds ~1568px — so oversized or foreign-type images are
// re-encoded through a canvas client-side instead of shipping dead weight.

import type { PromptImage } from '../../server/protocol';

const API_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_BYTES = 4_000_000; // re-encode above this (API cap is 5MB decoded)
const MAX_EDGE = 1568; // the API's optimal long edge

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Could not decode ${file.type || 'image'}`));
    };
    img.src = url;
  });
}

function fromDataUrl(dataUrl: string): PromptImage {
  const comma = dataUrl.indexOf(',');
  const mediaType = dataUrl.slice(5, dataUrl.indexOf(';'));
  return { mediaType, data: dataUrl.slice(comma + 1) };
}

/**
 * Convert a File to a PromptImage, re-encoding through a canvas when the
 * type isn't API-supported, the file is large, or the long edge exceeds the
 * API's optimum. Returns null for things the browser can't decode.
 */
export async function fileToImage(file: File): Promise<PromptImage | null> {
  if (!file.type.startsWith('image/')) return null;

  let img: HTMLImageElement;
  try {
    img = await loadImage(file);
  } catch {
    return null; // undecodable (e.g. HEIC on most browsers)
  }
  const edge = Math.max(img.naturalWidth, img.naturalHeight);

  // GIFs pass through when small enough — rasterizing would drop animation.
  const passthrough =
    API_TYPES.has(file.type) &&
    file.size <= MAX_BYTES &&
    (edge <= MAX_EDGE || file.type === 'image/gif');
  if (passthrough) return fromDataUrl(await readAsDataUrl(file));

  const scale = Math.min(1, MAX_EDGE / edge);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  // PNG keeps screenshots (text!) and transparency crisp; JPEG for photos.
  let dataUrl =
    file.type === 'image/jpeg'
      ? canvas.toDataURL('image/jpeg', 0.9)
      : canvas.toDataURL('image/png');
  if (dataUrl.length > MAX_BYTES * 1.4) {
    dataUrl = canvas.toDataURL('image/jpeg', 0.85); // PNG came out huge
  }
  return fromDataUrl(dataUrl);
}
