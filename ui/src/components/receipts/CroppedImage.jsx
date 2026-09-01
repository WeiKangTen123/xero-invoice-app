import { useEffect, useRef } from 'react';

// Shows one region of a shared photo.
//
// When an upload holds several receipts, the file is never cut apart — each
// record stores the box it owns and the crop happens here, on display. That is
// what makes the split reversible: the original is always intact.
//
// Drawn to a canvas rather than positioned with CSS because the box is in
// normalised 0-1000 coordinates and the true crop depends on the image's real
// pixel size, which CSS cannot reach.
export default function CroppedImage({ src, box, alt = '', style, onError }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    if (!src) return undefined;
    let cancelled = false;
    const img = new Image();

    img.onload = () => {
      if (cancelled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const W = img.naturalWidth, H = img.naturalHeight;

      if (!box) {
        canvas.width = W; canvas.height = H;
        ctx.drawImage(img, 0, 0);
        return;
      }

      const [ymin, xmin, ymax, xmax] = box;
      const sx = (xmin / 1000) * W;
      const sy = (ymin / 1000) * H;
      const sw = ((xmax - xmin) / 1000) * W;
      const sh = ((ymax - ymin) / 1000) * H;
      canvas.width  = Math.max(1, Math.round(sw));
      canvas.height = Math.max(1, Math.round(sh));
      ctx.drawImage(img, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
    };
    img.onerror = () => { if (!cancelled) onError?.(); };
    img.src = src;

    return () => { cancelled = true; };
  }, [src, box, onError]);

  return <canvas ref={canvasRef} aria-label={alt} style={style} />;
}
