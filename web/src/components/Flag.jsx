// Drapeau SVG auto-hébergé (flag-icons) dérivé de l'émoji stocké en base.
// Les émojis drapeaux ne s'affichent pas sous Windows : on convertit
// l'émoji (paire d'indicateurs régionaux, ou séquence tag pour ENG/SCO/WAL)
// en code ISO 3166-1 alpha-2, et on retombe sur l'émoji texte si inconnu.
import React from 'react';
import 'flag-icons/css/flag-icons.min.css';

export function emojiToIso(emoji) {
  if (!emoji) return null;
  const cps = [...emoji].map((c) => c.codePointAt(0));
  if (cps.length === 2 && cps.every((c) => c >= 0x1f1e6 && c <= 0x1f1ff)) {
    return cps.map((c) => String.fromCharCode(c - 0x1f1e6 + 97)).join('');
  }
  if (cps[0] === 0x1f3f4) {
    const tags = cps.filter((c) => c >= 0xe0061 && c <= 0xe007a)
      .map((c) => String.fromCharCode(c - 0xe0000)).join('');
    return tags ? `${tags.slice(0, 2)}-${tags.slice(2)}` : null;
  }
  return null;
}

export default function Flag({ emoji, title }) {
  const iso = emojiToIso(emoji);
  if (!iso) return emoji ? <span title={title}>{emoji}</span> : null;
  return <span className={`fi fi-${iso} flag`} title={title} aria-hidden="true" />;
}
