// Preparing a receipt for upload.
//
// Xero rejects attachments over 3MB, and a phone photo is routinely 4-12MB, so
// the image is resized and re-encoded IN THE BROWSER before it is ever sent.
// Doing it here rather than on the server also means the user's mobile data
// carries 800KB instead of 12MB.
//
// PDFs pass through untouched: there is no raster to resize, and re-encoding
// one would destroy the text layer the parser depends on.

export const MAX_BYTES = 3 * 1024 * 1024;
export const ACCEPTED  = ['image/jpeg', 'image/png', 'application/pdf'];
export const ACCEPT_ATTR = 'image/jpeg,image/png,image/heic,image/heif,application/pdf';

// Long edge. 2000px keeps small print on a receipt legible for the parser while
// landing a typical photo comfortably under the cap.
const MAX_DIM = 2000;
// Tried in order until the result fits. Stopping at 0.5 rather than going lower
// because past that the numbers on a receipt start to smear.
const QUALITY_STEPS = [0.82, 0.7, 0.6, 0.5];

export function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function canvasToBlob(canvas, quality) {
  return new Promise(resolve => canvas.toBlob(b => resolve(b), 'image/jpeg', quality));
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    // Result is a data: URI; the server accepts the prefix and strips it.
    reader.onload  = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('Could not read the file'));
    reader.readAsDataURL(blob);
  });
}

// Returns { blob, mime, originalBytes, bytes } or throws with a message that
// says what the user should do next.
export async function prepareReceipt(file) {
  if (!file) throw new Error('No file selected');
  const originalBytes = file.size;

  if (file.type === 'application/pdf') {
    if (originalBytes > MAX_BYTES) {
      throw new Error(`This PDF is ${humanSize(originalBytes)}; Xero accepts at most ${humanSize(MAX_BYTES)}. PDFs cannot be compressed here — try exporting it smaller.`);
    }
    return { blob: file, mime: 'application/pdf', originalBytes, bytes: originalBytes };
  }

  // Anything the browser can decode is fair game as INPUT — including HEIC on
  // iOS, which decodes natively even though Xero will not accept it. Re-encoding
  // to JPEG is what makes an iPhone photo attachable at all.
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error('That file could not be read as an image. Try a JPEG, PNG or PDF.');
  }

  const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width  = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  if (bitmap.close) bitmap.close();

  for (const quality of QUALITY_STEPS) {
    const blob = await canvasToBlob(canvas, quality);
    if (blob && blob.size <= MAX_BYTES) {
      return { blob, mime: 'image/jpeg', originalBytes, bytes: blob.size };
    }
  }
  throw new Error(`This image is still over ${humanSize(MAX_BYTES)} after compression. Try photographing just the receipt, closer in.`);
}
