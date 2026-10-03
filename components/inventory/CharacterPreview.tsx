'use client';

import { useMemo, useState } from 'react';
import { AccessorySlot, ACCESSORY_SLOTS } from '@/types/domain';
import { FORGE_BASE_ASSET, getForgeAssetById } from '@/lib/domain/bag-forge/manifest';
import { computeBagRarity } from '@/lib/domain/bag-forge/rarity';
import { buildCombinationJson, buildForgeLayerStack, buildForgeMetadata } from '@/lib/domain/bag-forge/combination';
import { generateCompositeImage } from '@/lib/domain/collectibles/canvas-compositor';
import styles from './CharacterPreview.module.css';

interface CharacterPreviewProps {
  selectedItems: Record<AccessorySlot, string>;
  isComplete: boolean;
  onAssemble: () => void;
}

// -----------------------------------------------------------------------------
// CRITICAL ALIGNMENT RULE: every layer (BASE + each selected accessory) is a
// real 1024x1024 transparent PNG that is ALREADY pre-aligned to the shared
// character canvas. This component draws every layer at x=0, y=0, filling the
// full canvas — no per-layer centering, no bounding-box cropping, no scaling.
// The `.canvas` container is a square (aspect-ratio: 1), so 100%/100% on a
// 1024x1024 source is a 1:1 fill, equivalent to `ctx.drawImage(img, 0, 0,
// 1024, 1024)`. Do NOT reintroduce object-fit, transform: scale, or per-slot
// coordinate systems here — that's the bug this file exists to fix.
// -----------------------------------------------------------------------------

function downloadDataUrl(filename: string, dataUrl: string) {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function downloadText(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  downloadDataUrl(filename, url);
  URL.revokeObjectURL(url);
}

export function CharacterPreview({
  selectedItems,
  isComplete,
  onAssemble,
}: CharacterPreviewProps) {
  const [debugMode, setDebugMode] = useState(false);
  const [hiddenLayers, setHiddenLayers] = useState<Set<string>>(new Set());
  const [exporting, setExporting] = useState(false);

  const completionPercent = Math.round(
    (ACCESSORY_SLOTS.filter((slot) => selectedItems[slot]).length / ACCESSORY_SLOTS.length) * 100
  );

  const calculatedRarity = computeBagRarity(selectedItems);

  // BASE + every resolved slot, in fixed zIndex order (BASE=0 .. SPECIAL=80).
  const layers = useMemo(() => {
    const resolved: { key: string; slot: string; id: string; name: string; image: string; zIndex: number }[] = [
      {
        key: 'BASE',
        slot: 'BASE',
        id: FORGE_BASE_ASSET.id,
        name: FORGE_BASE_ASSET.name,
        image: FORGE_BASE_ASSET.image,
        zIndex: FORGE_BASE_ASSET.zIndex,
      },
    ];

    for (const slot of ACCESSORY_SLOTS) {
      const asset = getForgeAssetById(selectedItems[slot]);
      if (!asset) continue;
      resolved.push({
        key: slot,
        slot,
        id: asset.id,
        name: asset.name,
        image: asset.image,
        zIndex: asset.zIndex,
      });
    }

    return resolved.sort((a, b) => a.zIndex - b.zIndex);
  }, [selectedItems]);

  const toggleLayer = (key: string) => {
    setHiddenLayers((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const handleExport = async () => {
    if (!isComplete) return;
    setExporting(true);
    try {
      const stack = buildForgeLayerStack(selectedItems);
      const result = await generateCompositeImage(stack);
      if (result.dataUrl) {
        downloadDataUrl('final_bag.png', result.dataUrl);
      } else {
        // eslint-disable-next-line no-alert
        alert(
          `Export edilecek gerçek PNG bulunamadı (${result.layersMissing.length} layer eksik). ` +
            `Asset dosyalarının public/assets/bag/ altında bulunduğundan emin ol.`
        );
      }
      const metadata = buildForgeMetadata(selectedItems);
      downloadText('metadata.json', JSON.stringify(metadata, null, 2), 'application/json');
    } finally {
      setExporting(false);
    }
  };

  const combinationJson = isComplete ? buildCombinationJson(selectedItems) : null;

  return (
    <div className={styles.container}>
      <div className={styles.previewBox}>
        <div className={styles.previewHeader}>
          <h3>Character Preview</h3>
          <div className={styles.headerActions}>
            <div className={styles.rarity}>{calculatedRarity}</div>
            <button
              type="button"
              className={`${styles.debugToggle} ${debugMode ? styles.debugOn : ''}`}
              onClick={() => setDebugMode((v) => !v)}
            >
              {debugMode ? 'DEBUG: ON' : 'DEBUG: OFF'}
            </button>
          </div>
        </div>

        <div className={styles.canvas}>
          {layers.map((layer) => {
            if (hiddenLayers.has(layer.key)) return null;
            return (
              <div key={layer.key} className={styles.layer} style={{ zIndex: layer.zIndex }}>
                <img
                  src={layer.image}
                  alt={layer.name}
                  className={styles.layerImage}
                  onError={(e) => {
                    (e.currentTarget as HTMLImageElement).style.display = 'none';
                  }}
                />
                {debugMode && (
                  <div className={styles.debugLabel}>
                    <div className={styles.debugBorder} />
                    <div className={styles.debugTag}>
                      <span>{layer.slot}</span>
                      <span>{layer.id}</span>
                      <span>zIndex: {layer.zIndex}</span>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          {!isComplete && (
            <div className={styles.emptyState}>
              <div className={styles.emptyIcon}>⚙</div>
              <div className={styles.emptyText}>
                Equip {8 - ACCESSORY_SLOTS.filter((s) => selectedItems[s]).length} more slots
              </div>
            </div>
          )}
        </div>

        {debugMode && (
          <div className={styles.layerToggles}>
            <div className={styles.listHeader}>Toggle Layers</div>
            {layers.map((layer) => (
              <label key={layer.key} className={styles.layerToggleRow}>
                <input
                  type="checkbox"
                  checked={!hiddenLayers.has(layer.key)}
                  onChange={() => toggleLayer(layer.key)}
                />
                <span>{layer.slot}</span>
                <span className={styles.layerToggleId}>{layer.id}</span>
              </label>
            ))}
          </div>
        )}

        <div className={styles.stats}>
          <div className={styles.statRow}>
            <span className={styles.statLabel}>Completion</span>
            <div className={styles.progressBar}>
              <div className={styles.progressFill} style={{ width: `${completionPercent}%` }} />
            </div>
            <span className={styles.statValue}>{completionPercent}%</span>
          </div>

          <div className={styles.slotStatus}>
            {ACCESSORY_SLOTS.map((slot) => (
              <div
                key={slot}
                className={`${styles.statusDot} ${selectedItems[slot] ? styles.filled : ''}`}
                title={slot}
              />
            ))}
          </div>
        </div>

        <div className={styles.itemsList}>
          <div className={styles.listHeader}>Equipped Items</div>
          <div className={styles.listContent}>
            {ACCESSORY_SLOTS.map((slot) => {
              const asset = getForgeAssetById(selectedItems[slot]);
              return (
                <div key={slot} className={styles.listItem}>
                  <span className={styles.itemSlot}>{slot}</span>
                  <span className={styles.itemName}>
                    {asset ? `${asset.name} · ${asset.rarity}` : '—'}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {isComplete && (
          <div className={styles.combinationBox}>
            <div className={styles.listHeader}>COMBINATION COMPLETE</div>
            <pre className={styles.combinationJson}>{JSON.stringify(combinationJson, null, 2)}</pre>
          </div>
        )}

        <button
          type="button"
          className={`${styles.assembleBtn} ${isComplete ? styles.ready : styles.disabled}`}
          onClick={onAssemble}
          disabled={!isComplete}
        >
          {isComplete ? '🔥 MINT BAG NFT' : `${completionPercent}% Complete`}
        </button>

        <button
          type="button"
          className={styles.exportBtn}
          onClick={handleExport}
          disabled={!isComplete || exporting}
        >
          {exporting ? 'Exporting…' : '⬇ EXPORT / GENERATE'}
        </button>
      </div>
    </div>
  );
}
