import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { extname } from 'node:path';
import type { FileFact } from './types.js';

const media: Record<string, string> = {
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif',
  '.pdf': 'application/pdf', '.html': 'text/html', '.htm': 'text/html', '.md': 'text/markdown', '.json': 'application/json',
  '.css': 'text/css', '.js': 'text/javascript', '.ts': 'text/plain', '.java': 'text/plain', '.py': 'text/plain',
};
export function artifactType(path: string, binary: boolean): Pick<FileFact, 'kind' | 'mediaType' | 'representation'> {
  const extension = extname(path).toLowerCase();
  const mediaType = media[extension] ?? (binary ? 'application/octet-stream' : 'text/plain');
  const kind = extension === '.svg' || ['.fig', '.sketch', '.psd', '.blend', '.ai'].includes(extension) ? 'design'
    : mediaType.startsWith('image/') ? 'image' : extension === '.pdf' || extension === '.md' ? 'document' : binary ? 'binary' : 'text';
  return { kind, mediaType, representation: binary ? 'binary' : 'text' };
}

export function parseSvg(content: string) {
  if (/<!DOCTYPE|<!ENTITY/i.test(content)) throw new Error('SVG declarations and entities are not supported.');
  const errors: string[] = [];
  const document = new DOMParser({ onError: (_level, message) => { errors.push(message); } }).parseFromString(content, 'image/svg+xml');
  if (errors.length || document.documentElement?.localName !== 'svg') throw new Error('Invalid SVG document.');
  return document;
}

export function inspectSvg(content: string): { width: string; height: string; viewBox: string; nodes: { id: string; tag: string }[] } {
  const document = parseSvg(content);
  const root = document.documentElement!;
  const nodes: { id: string; tag: string }[] = [];
  const all = document.getElementsByTagName('*');
  for (let index = 0; index < all.length && nodes.length < 200; index++) {
    const node = all.item(index);
    if (node?.getAttribute('id')) nodes.push({ id: node.getAttribute('id')!, tag: node.tagName });
  }
  return { width: root.getAttribute('width') ?? '', height: root.getAttribute('height') ?? '', viewBox: root.getAttribute('viewBox') ?? '', nodes };
}

export function updateSvg(content: string, nodeId: string, attributes: Record<string, string>): string {
  const document = parseSvg(content);
  const all = document.getElementsByTagName('*');
  const matches = nodeId === '$root' ? [document.documentElement] : Array.from({ length: all.length }, (_, i) => all.item(i)!).filter(n => n.getAttribute('id') === nodeId);
  if (matches.length !== 1) throw new Error('SVG node ID must identify exactly one node. Use $root for the root element.');
  const allowed = new Set(['fill', 'stroke', 'stroke-width', 'opacity', 'x', 'y', 'cx', 'cy', 'r', 'rx', 'ry', 'width', 'height', 'viewBox', 'transform', 'font-size', 'font-family']);
  for (const [name, value] of Object.entries(attributes)) {
    if (!allowed.has(name) || /url\(|javascript:|[<>]/i.test(value) || value.length > 500) throw new Error(`Unsupported SVG property: ${name}`);
    matches[0]!.setAttribute(name, value);
  }
  return new XMLSerializer().serializeToString(document);
}
