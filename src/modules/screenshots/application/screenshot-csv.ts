/**
 * The one place this module turns values into CSV (the archive's index.csv and
 * the screenshot manifest). People choose their own names, so a cell can hold
 * anything: it must reach a spreadsheet as plain text, never as a formula.
 */

/**
 * A cell a spreadsheet would read as a formula: its first character, after any
 * leading white space (`\s` covers the no-break space), is =, +, -, @, a tab or
 * a carriage return. White space is skipped because spreadsheets trim it.
 */
const FORMULA_START = /^\s*[=+\-@\t\r]/;

/** Characters that need the cell wrapped in double quotes. */
const NEEDS_QUOTES = /[",\r\n]/;

/** One CSV cell: neutralised with a leading single quote when needed, then quoted. */
export function csvCell(value: string): string {
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return NEEDS_QUOTES.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One CSV line (no line ending): every cell goes through csvCell. */
export function csvLine(cells: readonly string[]): string {
  return cells.map(csvCell).join(',');
}
