import { CompositeLayer, COMPOSITE_CANVAS_SIZE } from './compositor';

// -----------------------------------------------------------------------------
// Browser-only. Bakes an ordered layer stack into a single 1024x1024
// transparent-background PNG (as a data URL) for storage on the BagNFT
// record and for the metadata `image` field.
//
// Contract with the artist: every layer PNG (base + every accessory) must be
// pre-aligned to the same COMPOSITE_CANVAS_SIZE x COMPOSITE_CANVAS_SIZE
// canvas. The compositor draws each layer at (0,0) full-size with no
// scaling/cropping — that's what "preserve the BAG character's proportions"
// means here: this code never resizes or distorts anything, it just stacks
// pre-aligned transparent layers. If a layer PNG isn't 1024x1024 pre-aligned,
// fix the art, not this function.
//
// Missing/404 layers (expected before real art is supplied) are skipped
// rather than failing the whole composite, so preview and assembly keep
// working with placeholder references.
// -----------------------------------------------------------------------------

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null); // placeholder/missing asset — skip, don't reject
    img.src = src;
  });
}

export interface GenerateCompositeResult {
  dataUrl: string | null;
  layersDrawn: number;
  layersMissing: string[];
}

export async function generateCompositeImage(
  layers: CompositeLayer[],
  size: number = COMPOSITE_CANVAS_SIZE
): Promise<GenerateCompositeResult> {
  if (typeof document === 'undefined') {
    // Server-side call (shouldn't normally happen — this is a client-only
    // operation) — fail soft instead of throwing.
    return { dataUrl: null, layersDrawn: 0, layersMissing: layers.map((l) => l.image) };
  }

  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return { dataUrl: null, layersDrawn: 0, layersMissing: layers.map((l) => l.image) };

  ctx.clearRect(0, 0, size, size); // transparent background, preserved throughout

  let layersDrawn = 0;
  const layersMissing: string[] = [];

  for (const layer of layers) {
    const img = await loadImage(layer.image);
    if (!img) {
      layersMissing.push(layer.image);
      continue;
    }
    ctx.drawImage(img, 0, 0, size, size);
    layersDrawn += 1;
  }

  if (layersDrawn === 0) {
    // Nothing actually rendered (no real art yet anywhere) — don't hand back
    // a blank-but-"successful" image.
    return { dataUrl: null, layersDrawn, layersMissing };
  }

  try {
    return { dataUrl: canvas.toDataURL('image/png'), layersDrawn, layersMissing };
  } catch {
    // toDataURL can throw on a tainted canvas (cross-origin image without
    // proper CORS headers). Same-origin /public assets never hit this, but
    // fail soft rather than crash the assembly flow if art is ever hosted
    // externally without CORS.
    return { dataUrl: null, layersDrawn, layersMissing };
  }
}
