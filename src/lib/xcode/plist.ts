export type PlistValue = string | number | boolean | PlistValue[] | { [key: string]: PlistValue };

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function serialize(value: PlistValue, indent: string): string {
  if (typeof value === 'string') return `${indent}<string>${escapeXml(value)}</string>`;
  if (typeof value === 'boolean') return `${indent}<${value}/>`;
  if (typeof value === 'number') return Number.isInteger(value) ? `${indent}<integer>${value}</integer>` : `${indent}<real>${value}</real>`;
  if (Array.isArray(value)) {
    return [`${indent}<array>`, ...value.map((item) => serialize(item, `${indent}\t`)), `${indent}</array>`].join('\n');
  }
  const lines = [`${indent}<dict>`];
  for (const [key, item] of Object.entries(value)) {
    lines.push(`${indent}\t<key>${escapeXml(key)}</key>`, serialize(item, `${indent}\t`));
  }
  lines.push(`${indent}</dict>`);
  return lines.join('\n');
}

export function toPlist(value: { [key: string]: PlistValue }): string {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    serialize(value, ''),
    '</plist>',
    '',
  ].join('\n');
}
