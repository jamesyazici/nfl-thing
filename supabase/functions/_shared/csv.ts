// Minimal RFC4180-ish CSV parser: handles quoted fields, embedded commas,
// escaped quotes ("") and CRLF/LF. nflverse's games.csv uses all of these
// (e.g. surface field can be `""`), so a naive split(',') is not safe.
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\r') {
      // skip; \n (or end of input) terminates the row
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  const [header, ...dataRows] = rows.filter((r) => !(r.length === 1 && r[0] === ''));
  return dataRows.map((r) => Object.fromEntries(header.map((h, idx) => [h, r[idx] ?? ''])));
}
