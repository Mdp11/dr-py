/**
 * Writes `fixtures/xlsx/sample.xlsx`, the engine's workbook for the
 * `export_bytes` case `xlsx_types`. `test/export/xlsx.test.ts` holds the
 * engine to these bytes and `tests/golden/test_engine_xlsx.py` opens them
 * with openpyxl: rerun after changing the writer, and commit the file.
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { SAMPLE_URL, sampleWorkbook } from '../test/export/xlsx-sample.ts';

writeFileSync(SAMPLE_URL, sampleWorkbook());
console.log(`wrote ${fileURLToPath(SAMPLE_URL)}`);
