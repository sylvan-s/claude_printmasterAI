/**
 * Crop a base64 image using a Gemini-style [ymin, xmin, ymax, xmax] bounding box
 * on a 0–1000 scale.  Renders through a CSS image-orientation:from-image element
 * first so EXIF rotation is respected before the crop is taken.
 */
export const cropImageCanvas = (
  base64Data: string,
  box_2d: number[]
): Promise<string> => {
  return new Promise((resolve, reject) => {
    // Step 1: draw the source image into a full-size canvas that respects EXIF
    // orientation.  We do this by rendering into an img element with the CSS
    // property applied, then painting that onto a canvas (which bakes in the
    // rotation) before we crop.
    const img = new Image();
    img.style.imageOrientation = "from-image";

    img.onload = () => {
      // Paint the EXIF-corrected image onto a full-size canvas
      const fullCanvas = document.createElement("canvas");
      fullCanvas.width = img.naturalWidth;
      fullCanvas.height = img.naturalHeight;
      const fullCtx = fullCanvas.getContext("2d");
      if (!fullCtx) { reject(new Error("No 2D context")); return; }

      // Temporarily insert into DOM so the browser applies CSS image-orientation
      img.style.position = "absolute";
      img.style.visibility = "hidden";
      document.body.appendChild(img);
      fullCtx.drawImage(img, 0, 0);
      document.body.removeChild(img);

      // Step 2: crop from the orientation-corrected canvas
      const [ymin, xmin, ymax, xmax] = box_2d;
      const x = (xmin / 1000) * fullCanvas.width;
      const y = (ymin / 1000) * fullCanvas.height;
      const w = Math.max(1, ((xmax - xmin) / 1000) * fullCanvas.width);
      const h = Math.max(1, ((ymax - ymin) / 1000) * fullCanvas.height);

      const cropCanvas = document.createElement("canvas");
      cropCanvas.width = w;
      cropCanvas.height = h;
      const cropCtx = cropCanvas.getContext("2d");
      if (!cropCtx) { reject(new Error("No 2D context for crop")); return; }
      cropCtx.imageSmoothingEnabled = true;
      cropCtx.imageSmoothingQuality = "high";
      cropCtx.drawImage(fullCanvas, x, y, w, h, 0, 0, w, h);
      resolve(cropCanvas.toDataURL("image/jpeg", 0.85));
    };

    img.onerror = () => reject(new Error("Failed to load source image for crop."));
    img.src = base64Data;
  });
};
