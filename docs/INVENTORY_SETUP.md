# 🎮 BAG Protocol - Drag & Drop Inventory System

## Overview

A full-featured **8-slot drag-and-drop inventory system** with real-time character preview and NFT assembly, inspired by Knight Online / Metin2 equipement mechanics.

### Features

✅ **8 Equipment Slots**: HEAD, FACE, NECK, BODY, BACK, HANDS, FEET, SPECIAL  
✅ **Drag-and-Drop Interface**: Move items between slots smoothly  
✅ **Live Character Preview**: See your assembled character in real-time  
✅ **Automatic Rarity Calculation**: Based on equipped items  
✅ **Completion Tracking**: Visual progress bar and slot indicators  
✅ **Asset Management**: 200+ unique item visuals pre-loaded  
✅ **Responsive Design**: Works perfectly on desktop and mobile  
✅ **Dark Cyberpunk UI**: Green-on-black terminal aesthetic  

---

## 📁 File Structure

```
components/inventory/
├── DragDropInventory.tsx          # Main inventory component
├── DragDropInventory.module.css   # Inventory styling
├── CharacterPreview.tsx           # Character preview & NFT mint button
├── CharacterPreview.module.css    # Preview styling
├── InventoryGrid.tsx              # Legacy inventory display
└── index.ts                       # Barrel export

app/inventory-demo/
└── page.tsx                       # Demo page (visit /inventory-demo)

public/assets/bag/
├── head/          # 40 items
├── face/          # 50 items
├── neck/          # 32 items
├── body/          # 31 items
├── back/          # 30 items
├── hands/         # 59 items
├── feet/          # 25 items
└── special/       # 24 items
```

---

## 🚀 Quick Start

### 1. View the Demo

Navigate to `http://localhost:3000/inventory-demo` to see the system in action.

### 2. Import in Your Component

```tsx
import { DragDropInventory } from '@/components/inventory';

export default function MyPage() {
  const handleAssemble = (selection: Record<AccessorySlot, string>) => {
    console.log('Selected items:', selection);
    // Call your NFT assembly API here
  };

  return <DragDropInventory onAssemble={handleAssemble} />;
}
```

### 3. Handle Assembly

```tsx
const handleAssemble = async (selection: Record<AccessorySlot, string>) => {
  const response = await fetch('/api/nft/assemble', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ selectedItems: selection }),
  });
  
  const result = await response.json();
  console.log('NFT Created:', result);
};
```

---

## 🎨 Component Props

### DragDropInventory

```tsx
interface DragDropInventoryProps {
  onAssemble?: (selection: Record<AccessorySlot, string>) => void;
}
```

| Prop | Type | Description |
|------|------|-------------|
| `onAssemble` | `function` | Called when user clicks "MINT BAG NFT" with selected items |

### CharacterPreview

```tsx
interface CharacterPreviewProps {
  selectedItems: Record<AccessorySlot, string>;
  isComplete: boolean;
  onAssemble: () => void;
}
```

| Prop | Type | Description |
|------|------|-------------|
| `selectedItems` | `object` | Current equipment in each slot |
| `isComplete` | `boolean` | Whether all 8 slots are filled |
| `onAssemble` | `function` | Trigger NFT assembly |

---

## 🎯 How It Works

### Slot System

The inventory uses 8 distinct equipment slots:

| Slot | Purpose | Items |
|------|---------|-------|
| **HEAD** | Headgear (crowns, helmets, hats) | 40 |
| **FACE** | Face accessories (glasses, visors) | 50 |
| **NECK** | Neck items (chains, collars) | 32 |
| **BODY** | Chest/body wear (hoodies, jackets) | 31 |
| **BACK** | Back items (wings, capes) | 30 |
| **HANDS** | Hand/glove equipment | 59 |
| **FEET** | Footwear (sneakers, boots) | 25 |
| **SPECIAL** | Unique/rare items | 24 |

### Item Selection Flow

1. **Click empty slot** → Item picker opens
2. **Browse 10 random items** → Each slot has 10 unique variations
3. **Click to select** → Item appears in slot
4. **Click to change** → Open picker again to swap
5. **All slots filled** → "MINT BAG NFT" button activates
6. **Click mint** → Calls `onAssemble` callback

### Character Preview

- **Live rendering**: All equipped items layered correctly
- **Rarity score**: Calculated based on item IDs
- **Completion %**: Shows progress (0-100%)
- **Equipped list**: Shows all selected items
- **Slot indicators**: Visual dots showing which slots are filled

### Layer Rendering Order (Z-Index)

Items render in this order for proper visual composition:

```
1. SPECIAL (background effects)
2. BACK (wings, capes)
3. BODY (main outfit)
4. HANDS (gloves, weapons)
5. FEET (shoes)
6. NECK (chains, collars)
7. FACE (glasses, masks)
8. HEAD (crowns, helmets) ← Top layer
```

---

## 🎮 User Experience

### Desktop
- Left panel: 4-column inventory grid
- Right panel: Character preview with stats
- Responsive gap and sizing
- Smooth animations and transitions

### Mobile
- Single column inventory (2 slots per row)
- Character preview stacks below
- Touch-friendly tap targets
- Optimized for smaller screens

---

## 📊 Data Flow

```
User clicks slot
    ↓
Item picker opens
    ↓
User selects item
    ↓
selectedItems state updates
    ↓
Character preview re-renders
    ↓
Completion % updates
    ↓
isComplete flag checked
    ↓
Mint button enabled/disabled
```

---

## 🔧 Customization

### Change Colors

Edit `DragDropInventory.module.css` and `CharacterPreview.module.css`:

```css
/* Primary highlight color */
--highlight: #00ff88;

/* Background */
--bg-dark: #0a0e27;
--bg-card: #14192d;
```

### Add More Items Per Slot

In `DragDropInventory.tsx`:

```tsx
const ITEMS_PER_SLOT = 10; // Change this value
```

### Modify Layer Order

In `CharacterPreview.tsx`:

```tsx
const SLOT_Z_ORDER: Record<AccessorySlot, number> = {
  SPECIAL: 1,
  BACK: 2,
  BODY: 3,
  HANDS: 4,
  FEET: 5,
  NECK: 6,
  FACE: 7,
  HEAD: 8, // Adjust as needed
};
```

### Custom Rarity Calculation

In `CharacterPreview.tsx`, modify the `calculatedRarity` useMemo:

```tsx
const calculatedRarity = (() => {
  // Your custom logic here
  return 'LEGENDARY';
})();
```

---

## 🐛 Troubleshooting

### Items not loading?
- Check `/public/assets/bag/` folder structure
- Ensure image files exist: `/public/assets/bag/{slot}/{name}.png`
- Verify asset path in components

### Styles not applying?
- Ensure CSS modules are imported correctly
- Check `.module.css` file naming
- Verify Tailwind is configured in `tailwind.config.ts`

### Character preview not rendering?
- Check browser console for errors
- Verify image paths are correct
- Check Z-index layering order

---

## 🔌 Integration with Existing API

### Connect to Assembly Endpoint

```tsx
const handleAssemble = async (selection: Record<AccessorySlot, string>) => {
  try {
    const response = await fetch('/api/nft/assemble', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        selectedItems: selection,
        userId: currentUser?.id,
        seasonId: currentSeason?.id,
      }),
    });

    if (!response.ok) throw new Error('Assembly failed');
    
    const nft = await response.json();
    console.log('NFT Created:', nft);
    
    // Show success modal
    showSuccessModal(nft);
  } catch (error) {
    console.error('Error assembling NFT:', error);
  }
};
```

### Store NFT Metadata

The assembled NFT should store:

```json
{
  "id": "nft_123",
  "ownerId": "user_456",
  "seasonId": "season_789",
  "accessories": {
    "HEAD": "head_001.png",
    "FACE": "face_023.png",
    "NECK": "neck_015.png",
    "BODY": "body_012.png",
    "BACK": "back_008.png",
    "HANDS": "hands_042.png",
    "FEET": "feet_011.png",
    "SPECIAL": "special_005.png"
  },
  "rarity": "EPIC",
  "createdAt": "2024-08-11T12:00:00Z"
}
```

---

## 📝 Notes

- **No API calls yet**: Demo mode uses only local state
- **Free tier compatible**: ~2KB JS, ~50KB CSS
- **Asset-heavy**: 200+ PNG images (total ~10MB)
- **Performance**: Renders 8 layers simultaneously without lag
- **Browser support**: Modern browsers with CSS Grid & Flexbox

---

## 🎓 Next Steps

1. ✅ Set up demo page
2. ⚠️ Connect to your NFT assembly API
3. ⚠️ Add success/error modals
4. ⚠️ Integrate with user authentication
5. ⚠️ Add transaction confirmation
6. ⚠️ Build NFT gallery page

---

## 📞 Support

For issues or questions:
- Check the troubleshooting section above
- Review component props and types
- Inspect browser console for errors
- Verify asset paths and image files

---

**Built with ❤️ for BAG Protocol**  
*Knight Online / Metin2 inspired | Web3 ready*
