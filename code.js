// Minecraft Skins - Figma plugin
// Takes a PNG (as bytes) from the UI and places it on the canvas.

figma.showUI(__html__, { width: 400, height: 720, themeColors: true });

const RECENTS_KEY = 'recents';
const LANG_KEY = 'lang';
const RECENTS_MAX = 10;

// The nametag ships in a plain, always-available font. Picking a typeface is
// left to the user, on the text layer, once it is in Figma.
const NAMETAG_FONTS = [
  { family: 'Inter', style: 'Regular' },
  { family: 'Roboto', style: 'Regular' }
];

// The Figma API exposes no editor language. The UI reads the system locale,
// sends it over, and the user can override it.
const STRINGS = {
  en: {
    imported: 'Skin imported',
    importFailed: 'Import failed: ',
    noFont: 'no font available for the nametag',
    skinLayer: 'Skin',
    nametagLayer: 'Nametag'
  },
  fr: {
    imported: 'Skin importé',
    importFailed: 'Import impossible : ',
    noFont: 'aucune police disponible pour le nametag',
    skinLayer: 'Skin',
    nametagLayer: 'Nametag'
  }
};

let locale = 'en';
const t = (key) => (STRINGS[locale] && STRINGS[locale][key]) || STRINGS.en[key];

let cachedFont = null;

async function nametagFont() {
  if (cachedFont) return cachedFont;
  for (const font of NAMETAG_FONTS) {
    try {
      await figma.loadFontAsync(font);
      cachedFont = font;
      return font;
    } catch (error) { /* try the next font */ }
  }
  throw new Error(t('noFont'));
}

function hexToRgb(hex) {
  const value = parseInt(String(hex).slice(1), 16);
  return { r: ((value >> 16) & 255) / 255, g: ((value >> 8) & 255) / 255, b: (value & 255) / 255 };
}

/* ---------- Import history ---------- */

async function loadRecents() {
  const stored = await figma.clientStorage.getAsync(RECENTS_KEY);
  return Array.isArray(stored) ? stored : [];
}

// Re-importing the same setup moves it back to the top rather than adding a
// duplicate, then the list is trimmed to the ten most recent.
async function saveRecent(entry) {
  const existing = await loadRecents();
  const next = [entry].concat(existing.filter((item) => item.key !== entry.key)).slice(0, RECENTS_MAX);
  await figma.clientStorage.setAsync(RECENTS_KEY, next);
  return next;
}

async function sendRecents(list) {
  figma.ui.postMessage({ type: 'recents', items: list || await loadRecents() });
}

/* ---------- Node creation ---------- */

// Where to drop the result: the selected frame, otherwise the current page.
function insertTarget() {
  const selection = figma.currentPage.selection;
  if (selection.length === 1) {
    const node = selection[0];
    if (node.type === 'FRAME' || node.type === 'COMPONENT' || node.type === 'SECTION') {
      return node;
    }
    if (node.parent && (node.parent.type === 'FRAME' || node.parent.type === 'COMPONENT')) {
      return node.parent;
    }
  }
  return figma.currentPage;
}

async function createSkinNode(item) {
  const image = figma.createImage(item.bytes);
  const size = await image.getSizeAsync();
  const rect = figma.createRectangle();
  rect.name = item.name;
  rect.resize(size.width, size.height);
  rect.fills = [{ type: 'IMAGE', scaleMode: 'FILL', imageHash: image.hash }];
  rect.constrainProportions = true;
  return rect;
}

// The nametag is an auto-layout frame around a real text layer, so it stays
// editable in Figma and is never baked into the skin image.
async function createNametagNode(config) {
  const font = await nametagFont();
  const text = figma.createText();
  text.fontName = font;
  text.characters = config.text;
  text.fontSize = config.fontSize;
  text.fills = [{ type: 'SOLID', color: hexToRgb(config.textColor) }];

  const frame = figma.createFrame();
  frame.name = t('nametagLayer') + ' · ' + config.text;
  frame.layoutMode = 'HORIZONTAL';
  frame.primaryAxisSizingMode = 'AUTO';
  frame.counterAxisSizingMode = 'AUTO';
  frame.paddingLeft = frame.paddingRight = Math.max(2, Math.round(config.fontSize * 0.5));
  frame.paddingTop = frame.paddingBottom = Math.max(1, Math.round(config.fontSize * 0.25));
  frame.cornerRadius = 0;
  frame.clipsContent = false;
  frame.fills = [{ type: 'SOLID', color: hexToRgb(config.bgColor), opacity: config.bgOpacity }];
  frame.appendChild(text);
  return frame;
}

// Wrapper frame: nametag and image stay two separate layers inside it, but the
// pair moves as one. Auto-layout keeps the nametag centred even after the text
// is edited.
function wrapPair(rect, tag, gap, name) {
  const frame = figma.createFrame();
  frame.name = name;
  frame.layoutMode = 'VERTICAL';
  frame.primaryAxisSizingMode = 'AUTO';
  frame.counterAxisSizingMode = 'AUTO';
  frame.counterAxisAlignItems = 'CENTER';
  frame.itemSpacing = gap;
  frame.fills = [];
  frame.clipsContent = false;
  frame.appendChild(tag);
  frame.appendChild(rect);
  return frame;
}

// Without a nametag the image goes in on its own; with one, both layers are
// wrapped in a frame.
async function importItem(item) {
  const rect = await createSkinNode(item);
  let node = rect;
  if (item.nametag) {
    const tag = await createNametagNode(item.nametag);
    rect.name = t('skinLayer');
    node = wrapPair(rect, tag, Math.max(4, Math.round(rect.height * 0.04)), item.name);
  }

  const target = insertTarget();
  target.appendChild(node);
  if (target.type === 'PAGE') {
    const center = figma.viewport.center;
    node.x = Math.round(center.x - node.width / 2);
    node.y = Math.round(center.y - node.height / 2);
  } else {
    node.x = Math.round((target.width - node.width) / 2);
    node.y = Math.round((target.height - node.height) / 2);
  }

  figma.currentPage.selection = [node];
  figma.viewport.scrollAndZoomIntoView([node]);
  return node;
}

/* ---------- Messages ---------- */

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'boot') {
    locale = STRINGS[msg.locale] ? msg.locale : 'en';
    let lang = 'auto';
    try {
      lang = (await figma.clientStorage.getAsync(LANG_KEY)) || 'auto';
    } catch (error) { /* unreadable preference, stay on automatic */ }
    figma.ui.postMessage({ type: 'boot', lang });
    // A corrupt history must not stop the plugin from opening.
    try {
      await sendRecents();
    } catch (error) {
      figma.ui.postMessage({ type: 'recents', items: [] });
    }
    return;
  }

  if (msg.type === 'set-lang') {
    locale = STRINGS[msg.locale] ? msg.locale : 'en';
    try {
      await figma.clientStorage.setAsync(LANG_KEY, msg.lang);
    } catch (error) { /* preference not saved, no consequence */ }
    return;
  }

  if (msg.type === 'import') {
    try {
      await importItem(msg.item);
      figma.notify(t('imported'));
      if (msg.entry) {
        // History must never turn a successful import into a failure.
        try {
          await sendRecents(await saveRecent(msg.entry));
        } catch (error) {
          console.error('History not saved:', error);
        }
      }
      figma.ui.postMessage({ type: 'import-done' });
    } catch (error) {
      figma.notify(t('importFailed') + error.message, { error: true });
      figma.ui.postMessage({ type: 'import-done', error: error.message });
    }
    return;
  }

  if (msg.type === 'clear-recents') {
    await figma.clientStorage.setAsync(RECENTS_KEY, []);
    await sendRecents([]);
    return;
  }

  if (msg.type === 'notify') {
    figma.notify(msg.message, msg.error ? { error: true } : undefined);
    return;
  }

  if (msg.type === 'close') {
    figma.closePlugin();
  }
};
