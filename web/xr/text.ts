// Text and card faces for the 3D table, drawn on canvases at run time (no image files to load or license).
import * as THREE from 'three';
import { ALL_CARDS, isWild } from '../../engine/src/index.js';

/** Card size in metres (a real playing card is about 63 x 88 mm). */
export const CARD_W = 0.063;
export const CARD_H = 0.088;

const SUIT_SYMBOL: Record<string, string> = { S: '♠', H: '♥', D: '♦', C: '♣' };
const FACE_PX_W = 256;
const FACE_PX_H = Math.round((FACE_PX_W * CARD_H) / CARD_W);

const faceCache = new Map<string, THREE.Texture>();

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

function canvasTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return tex;
}

/** The face of a card. Both decks share faces, so there are at most 54 textures. */
export function cardFace(id: number): THREE.Texture {
  const c = ALL_CARDS[id]!;
  const key = c.rank === 'JOKER' ? 'JOKER' : `${c.rank}${c.suit}`;
  const hit = faceCache.get(key);
  if (hit) return hit;

  const canvas = document.createElement('canvas');
  canvas.width = FACE_PX_W;
  canvas.height = FACE_PX_H;
  const g = canvas.getContext('2d')!;
  const red = c.suit === 'H' || c.suit === 'D';
  const ink = c.rank === 'JOKER' ? '#7a2d9c' : red ? '#c62828' : '#111';
  roundRect(g, 2, 2, FACE_PX_W - 4, FACE_PX_H - 4, 22);
  g.fillStyle = isWild(c) ? '#fff4cf' : '#ffffff';
  g.fill();
  g.lineWidth = 4;
  g.strokeStyle = isWild(c) ? '#d4a017' : '#9a9a9a';
  g.stroke();

  g.fillStyle = ink;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const rank = c.rank === 'JOKER' ? '★' : c.rank;
  const suit = c.rank === 'JOKER' ? '' : SUIT_SYMBOL[c.suit!]!;
  // Big corner index: in a fan of cards only the left strip shows, so the index must be readable on its own.
  const corner = (rotate: boolean) => {
    g.save();
    if (rotate) {
      g.translate(FACE_PX_W, FACE_PX_H);
      g.rotate(Math.PI);
    }
    g.font = `bold ${rank.length > 1 ? 58 : 70}px system-ui, sans-serif`;
    g.fillText(rank, 44, 52);
    if (suit) {
      g.font = '60px system-ui, sans-serif';
      g.fillText(suit, 44, 116);
    }
    g.restore();
  };
  corner(false);
  corner(true);
  if (c.rank === 'JOKER') {
    g.font = 'bold 44px system-ui, sans-serif';
    g.fillText('JOKER', FACE_PX_W / 2 + 14, FACE_PX_H / 2);
  } else {
    g.font = '150px system-ui, sans-serif';
    g.fillText(suit, FACE_PX_W / 2 + 12, FACE_PX_H / 2 + 6);
  }
  const tex = canvasTexture(canvas);
  faceCache.set(key, tex);
  return tex;
}

export function cardBack(): THREE.Texture {
  const hit = faceCache.get('BACK');
  if (hit) return hit;
  const canvas = document.createElement('canvas');
  canvas.width = FACE_PX_W;
  canvas.height = FACE_PX_H;
  const g = canvas.getContext('2d')!;
  roundRect(g, 2, 2, FACE_PX_W - 4, FACE_PX_H - 4, 22);
  g.fillStyle = '#ffffff';
  g.fill();
  roundRect(g, 14, 14, FACE_PX_W - 28, FACE_PX_H - 28, 14);
  g.fillStyle = '#8e1b1b';
  g.fill();
  g.save();
  g.clip();
  g.strokeStyle = 'rgba(255,255,255,0.25)';
  g.lineWidth = 6;
  for (let i = -FACE_PX_H; i < FACE_PX_W + FACE_PX_H; i += 26) {
    g.beginPath();
    g.moveTo(i, 0);
    g.lineTo(i - FACE_PX_H, FACE_PX_H);
    g.moveTo(i - FACE_PX_H, 0);
    g.lineTo(i, FACE_PX_H);
    g.stroke();
  }
  g.restore();
  const tex = canvasTexture(canvas);
  faceCache.set('BACK', tex);
  return tex;
}

export interface PanelStyle {
  /** Width and height in metres. */
  width: number;
  height: number;
  bg?: string;
  fg?: string;
  /** Font size in metres. */
  size?: number;
  bold?: boolean;
  align?: 'left' | 'center';
  border?: string;
}

const PX_PER_M = 1400;

function wrap(g: CanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(' ')) {
      const next = line ? `${line} ${word}` : word;
      if (g.measureText(next).width > maxWidth && line) {
        out.push(line);
        line = word;
      } else line = next;
    }
    out.push(line);
  }
  return out;
}

/** A flat rectangle with text on it, facing +z. The caller disposes it with disposeObject(). */
export function textPanel(text: string, style: PanelStyle): THREE.Mesh {
  const w = Math.round(style.width * PX_PER_M);
  const h = Math.round(style.height * PX_PER_M);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d')!;
  const radius = Math.min(w, h) * 0.18;
  roundRect(g, 2, 2, w - 4, h - 4, radius);
  g.fillStyle = style.bg ?? 'rgba(10, 30, 20, 0.88)';
  g.fill();
  if (style.border) {
    g.lineWidth = 6;
    g.strokeStyle = style.border;
    g.stroke();
  }
  const px = Math.round((style.size ?? 0.025) * PX_PER_M);
  g.font = `${style.bold ? 'bold ' : ''}${px}px system-ui, sans-serif`;
  g.fillStyle = style.fg ?? '#ffffff';
  g.textBaseline = 'middle';
  const pad = px * 0.6;
  const lines = wrap(g, text, w - pad * 2);
  const lineH = px * 1.25;
  const maxLines = Math.max(1, Math.floor((h - pad) / lineH));
  const shown = lines.slice(0, maxLines);
  let y = h / 2 - ((shown.length - 1) * lineH) / 2;
  g.textAlign = style.align === 'left' ? 'left' : 'center';
  const x = style.align === 'left' ? pad : w / 2;
  for (const line of shown) {
    g.fillText(line, x, y);
    y += lineH;
  }
  const mat = new THREE.MeshBasicMaterial({ map: canvasTexture(canvas), transparent: true, depthWrite: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(style.width, style.height), mat);
  mesh.userData.ownsTexture = true;
  return mesh;
}

/** Free GPU memory for a subtree. Card face textures are shared and kept. */
export function disposeObject(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    if (mesh.userData.ownsGeometry !== false) mesh.geometry.dispose();
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of mats) {
      const basic = m as THREE.MeshBasicMaterial;
      if (mesh.userData.ownsTexture && basic.map) basic.map.dispose();
      m.dispose();
    }
  });
}
