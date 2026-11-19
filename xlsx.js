/* Минимальный генератор .xlsx без внешних библиотек.
 * Собирает ZIP (без сжатия) из XML-частей OOXML.
 * Использование:
 *   const bytes = Xlsx.build([{ name: 'Текст', rows: [['абзац 1'], ['абзац 2']], width: 90 }]);
 * В браузере: new Blob([bytes], {type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'})
 */
'use strict';

const Xlsx = (() => {
  /* ---------- CRC32 ---------- */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /* ---------- ZIP (store) ---------- */
  function makeZip(files) {
    const enc = new TextEncoder();
    const entries = files.map((f) => ({
      name: enc.encode(f.name),
      data: typeof f.data === 'string' ? enc.encode(f.data) : f.data,
    }));

    let size = 0;
    for (const e of entries) size += 30 + e.name.length + e.data.length + 46 + e.name.length;
    size += 22;

    const out = new Uint8Array(size);
    const view = new DataView(out.buffer);
    let off = 0;
    const central = [];

    for (const e of entries) {
      const crc = crc32(e.data);
      const start = off;

      view.setUint32(off, 0x04034b50, true); off += 4;
      view.setUint16(off, 20, true); off += 2;
      view.setUint16(off, 0, true); off += 2;      // flags
      view.setUint16(off, 0, true); off += 2;      // method: store
      view.setUint16(off, 0, true); off += 2;      // time
      view.setUint16(off, 0x21, true); off += 2;   // date (1980-01-01)
      view.setUint32(off, crc, true); off += 4;
      view.setUint32(off, e.data.length, true); off += 4;
      view.setUint32(off, e.data.length, true); off += 4;
      view.setUint16(off, e.name.length, true); off += 2;
      view.setUint16(off, 0, true); off += 2;
      out.set(e.name, off); off += e.name.length;
      out.set(e.data, off); off += e.data.length;

      central.push({ name: e.name, crc, size: e.data.length, offset: start });
    }

    const centralStart = off;
    for (const c of central) {
      view.setUint32(off, 0x02014b50, true); off += 4;
      view.setUint16(off, 20, true); off += 2;
      view.setUint16(off, 20, true); off += 2;
      view.setUint16(off, 0, true); off += 2;
      view.setUint16(off, 0, true); off += 2;
      view.setUint16(off, 0, true); off += 2;
      view.setUint16(off, 0x21, true); off += 2;
      view.setUint32(off, c.crc, true); off += 4;
      view.setUint32(off, c.size, true); off += 4;
      view.setUint32(off, c.size, true); off += 4;
      view.setUint16(off, c.name.length, true); off += 2;
      view.setUint16(off, 0, true); off += 2;
      view.setUint16(off, 0, true); off += 2;
      view.setUint16(off, 0, true); off += 2;
      view.setUint16(off, 0, true); off += 2;
      view.setUint32(off, 0, true); off += 4;
      view.setUint32(off, c.offset, true); off += 4;
      out.set(c.name, off); off += c.name.length;
    }

    const centralSize = off - centralStart;
    view.setUint32(off, 0x06054b50, true); off += 4;
    view.setUint16(off, 0, true); off += 2;
    view.setUint16(off, 0, true); off += 2;
    view.setUint16(off, central.length, true); off += 2;
    view.setUint16(off, central.length, true); off += 2;
    view.setUint32(off, centralSize, true); off += 4;
    view.setUint32(off, centralStart, true); off += 4;
    view.setUint16(off, 0, true); off += 2;

    return out;
  }

  /* ---------- XML ---------- */
  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');
  }

  function colName(n) {
    let s = '';
    let x = n;
    while (x > 0) {
      const m = (x - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      x = Math.floor((x - 1) / 26);
    }
    return s;
  }

  function sheetXml(rows, width) {
    const cols = width
      ? `<cols><col min="1" max="${Math.max(1, (rows[0] || []).length)}" width="${width}" customWidth="1"/></cols>`
      : '';
    const body = rows.map((row, r) => {
      const cells = row.map((value, c) => {
        const ref = colName(c + 1) + (r + 1);
        const text = value == null ? '' : String(value);
        if (!text) return `<c r="${ref}" s="1"/>`;
        return `<c r="${ref}" t="inlineStr" s="1"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
      }).join('');
      return `<row r="${r + 1}">${cells}</row>`;
    }).join('');

    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${cols}<sheetData>${body}</sheetData></worksheet>`;
  }

  const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="1"><fill><patternFill patternType="none"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="2">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

  function sanitizeName(name, index) {
    const base = String(name || `Лист${index + 1}`).replace(/[\\/*?:[\]]/g, ' ').trim().slice(0, 31);
    return base || `Лист${index + 1}`;
  }

  function build(sheets) {
    const list = sheets && sheets.length ? sheets : [{ name: 'Лист1', rows: [['']] }];

    const parts = [];
    parts.push({
      name: '[Content_Types].xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
${list.map((s, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
</Types>`,
    });

    parts.push({
      name: '_rels/.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    });

    parts.push({
      name: 'xl/workbook.xml',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${list.map((s, i) => `<sheet name="${esc(sanitizeName(s.name, i))}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`,
    });

    parts.push({
      name: 'xl/_rels/workbook.xml.rels',
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${list.map((s, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${list.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    });

    parts.push({ name: 'xl/styles.xml', data: STYLES });

    list.forEach((s, i) => {
      parts.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s.rows || [['']], s.width) });
    });

    return makeZip(parts);
  }

  return { build, colName, crc32 };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Xlsx;
