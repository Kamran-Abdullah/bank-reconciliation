import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { performReconciliation, ReconciliationResult } from '@/lib/reconciler';
import { findHeaderRow, type ColumnMapping } from '@/lib/columnDetector';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

export interface ColumnMappingPayload {
  bsMappings?: ColumnMapping[];
  glMappings?: ColumnMapping[];
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const bsFile = formData.get('bsFile') as File | null;
    const glFile = formData.get('glFile') as File | null;
    const combinedFile = formData.get('combinedFile') as File | null;
    const mappingsJson = formData.get('mappings') as string | null;
    const autoMatchThresholdStr = formData.get('autoMatchThreshold') as string | null;
    
    // Parse threshold, default to 55
    let autoMatchThreshold = 55;
    if (autoMatchThresholdStr && !isNaN(parseInt(autoMatchThresholdStr, 10))) {
      autoMatchThreshold = parseInt(autoMatchThresholdStr, 10);
    }

    // Parse column mappings if provided
    let mappings: ColumnMappingPayload = {};
    if (mappingsJson) {
      try {
        mappings = JSON.parse(mappingsJson);
      } catch {
        // Ignore invalid mappings, fall back to default
      }
    }

    if (!bsFile && !glFile && !combinedFile) {
      return NextResponse.json({ error: 'No files uploaded' }, { status: 400 });
    }

    let bsData: Array<{ date: string; particulars: string; debit: number | null; credit: number | null; balance: number | null; chequeNo?: string }> = [];
    let glData: Array<{ postingDate: string; transNo: string; origin: string; originNo: string; offsetAccount: string; details: string; cdLC: number; cumulativeBalance: number | null; debit: number | null; credit: number | null; blanketAgreement: string | null }> = [];

    if (combinedFile) {
      const buffer = await combinedFile.arrayBuffer();
      const workbook = XLSX.read(Buffer.from(buffer), { type: 'buffer' });

      // Find BS sheet
      const bsSheetName = workbook.SheetNames.find(n =>
        n.toUpperCase() === 'BS' || n.toUpperCase().includes('BANK') || n.toUpperCase().includes('STATEMENT')
      );
      // Find GL sheet
      const glSheetName = workbook.SheetNames.find(n =>
        n.toUpperCase() === 'GL' || n.toUpperCase() === 'LEDGER' || n.toUpperCase().includes('SHEET1') || n.toUpperCase().includes('LEDGER') || n.toUpperCase().includes('GENERAL')
      );

      if (bsSheetName) {
        const ws = workbook.Sheets[bsSheetName];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1 }) as unknown[][];
        bsData = parseBSData(rows, mappings.bsMappings);
      }

      if (glSheetName) {
        const ws = workbook.Sheets[glSheetName];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1 }) as unknown[][];
        glData = parseGLData(rows, mappings.glMappings);
      }
    } else {
      if (bsFile) {
        const buffer = await bsFile.arrayBuffer();
        const workbook = XLSX.read(Buffer.from(buffer), { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const ws = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1 }) as unknown[][];
        bsData = parseBSData(rows, mappings.bsMappings);
      }

      if (glFile) {
        const buffer = await glFile.arrayBuffer();
        const workbook = XLSX.read(Buffer.from(buffer), { type: 'buffer' });
        const sheetName = workbook.SheetNames[0];
        const ws = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1 }) as unknown[][];
        glData = parseGLData(rows, mappings.glMappings);
      }
    }

    if (bsData.length === 0 && glData.length === 0) {
      return NextResponse.json({ error: 'No valid data found in uploaded files. Please check column mappings.' }, { status: 400 });
    }

    // Perform reconciliation
    const result = performReconciliation(bsData, glData, autoMatchThreshold);

    // Serialize dates for JSON
    const serialized = serializeResult(result);

    return NextResponse.json(serialized);
  } catch (error: unknown) {
    console.error('Reconciliation error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message.includes('body') && (message.includes('size') || message.includes('limit') || message.includes('exceeded') || message.includes('too large'))) {
      return NextResponse.json({ error: 'File too large. Please reduce the file size or split data into smaller chunks and try again.' }, { status: 413 });
    }
    if (message.includes('timeout') || message.includes('ETIMEDOUT') || message.includes('timed out')) {
      return NextResponse.json({ error: 'Processing timed out. The file may be too large. Please try with a smaller dataset.' }, { status: 504 });
    }
    if (message.includes('memory') || message.includes('heap') || message.includes('ENOMEM') || message.includes('FATAL')) {
      return NextResponse.json({ error: 'Insufficient memory to process this file. Please try with a smaller dataset.' }, { status: 507 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * Parse BS data with universal column mapping support
 */
function parseBSData(
  rows: unknown[][],
  columnMappings?: ColumnMapping[]
): Array<{ date: string; particulars: string; debit: number | null; credit: number | null; balance: number | null; chequeNo?: string }> {
  const data: Array<{ date: string; particulars: string; debit: number | null; credit: number | null; balance: number | null; chequeNo?: string }> = [];

  // Find the header row
  const headerRowIndex = findHeaderRow(rows);

  // Build column index map from mappings or use defaults
  let dateCol = 0, particularsCol = 1, debitCol = 2, creditCol = 3, balanceCol = 4, chequeNoCol = -1;

  if (columnMappings && columnMappings.length > 0) {
    // Reset all to -1 first so a field the detector failed to map (columnIndex: null)
    // is treated as genuinely absent, instead of silently keeping the hardcoded default
    // index — which may point at an unrelated column (e.g. a date column) and produce
    // garbage parsed numbers rather than a clean "no data" null.
    dateCol = -1; particularsCol = -1; debitCol = -1; creditCol = -1; balanceCol = -1; chequeNoCol = -1;
    for (const mapping of columnMappings) {
      if (mapping.columnIndex === null || mapping.columnIndex === undefined) continue;
      switch (mapping.field) {
        case 'date': dateCol = mapping.columnIndex; break;
        case 'particulars': particularsCol = mapping.columnIndex; break;
        case 'debit': debitCol = mapping.columnIndex; break;
        case 'credit': creditCol = mapping.columnIndex; break;
        case 'balance': balanceCol = mapping.columnIndex; break;
        case 'chequeNo': chequeNoCol = mapping.columnIndex; break;
      }
    }
  }

  // Parse data rows (skip header row and any rows before it)
  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 2) continue;

    const dateVal = row[dateCol];
    const particulars = String(row[particularsCol] || '');
    const debit = parseNumber(row[debitCol]);
    const credit = parseNumber(row[creditCol]);
    const balance = parseNumber(row[balanceCol]);
    const chequeNo = chequeNoCol >= 0 ? String(row[chequeNoCol] || '') : undefined;

    if (!dateVal && !particulars) continue;

    // Skip opening balance rows
    if ((debit === null || debit === 0) && (credit === null || credit === 0) && balance !== null && balance !== 0) {
      continue;
    }

    let dateStr = '';
    if (dateVal instanceof Date) {
      dateStr = dateVal.toISOString().split('T')[0];
    } else if (typeof dateVal === 'string') {
      dateStr = dateVal;
    } else if (typeof dateVal === 'number') {
      const d = XLSX.SSF.parse_date_code(dateVal);
      if (d) dateStr = `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
    }

    data.push({
      date: dateStr,
      particulars,
      debit: debit !== null ? Math.abs(debit) : null,
      credit: credit !== null ? Math.abs(credit) : null,
      balance: balance,
      chequeNo,
    });
  }

  return data;
}

/**
 * Parse GL data with universal column mapping support
 */
function parseGLData(
  rows: unknown[][],
  columnMappings?: ColumnMapping[]
): Array<{ postingDate: string; transNo: string; origin: string; originNo: string; offsetAccount: string; details: string; cdLC: number; cumulativeBalance: number | null; debit: number | null; credit: number | null; blanketAgreement: string | null }> {
  const data: Array<{ postingDate: string; transNo: string; origin: string; originNo: string; offsetAccount: string; details: string; cdLC: number; cumulativeBalance: number | null; debit: number | null; credit: number | null; blanketAgreement: string | null }> = [];

  // Find the header row
  const headerRowIndex = findHeaderRow(rows);

  // Build column index map from mappings or use defaults
  let rowNoCol = 0, postingDateCol = 1, transNoCol = 2, originCol = 3, originNoCol = 4;
  let offsetAccountCol = 5, detailsCol = 6, cdLCCol = 7, cumBalanceCol = 8;
  let debitCol = 9, creditCol = 10, blanketCol = 11;

  if (columnMappings && columnMappings.length > 0) {
    // Reset all to -1 first
    rowNoCol = -1; postingDateCol = -1; transNoCol = -1; originCol = -1; originNoCol = -1;
    offsetAccountCol = -1; detailsCol = -1; cdLCCol = -1; cumBalanceCol = -1;
    debitCol = -1; creditCol = -1; blanketCol = -1;

    for (const mapping of columnMappings) {
      if (mapping.columnIndex === null || mapping.columnIndex === undefined) continue;
      switch (mapping.field) {
        case 'rowNo': rowNoCol = mapping.columnIndex; break;
        case 'postingDate': postingDateCol = mapping.columnIndex; break;
        case 'transNo': transNoCol = mapping.columnIndex; break;
        case 'origin': originCol = mapping.columnIndex; break;
        case 'originNo': originNoCol = mapping.columnIndex; break;
        case 'offsetAccount': offsetAccountCol = mapping.columnIndex; break;
        case 'details': detailsCol = mapping.columnIndex; break;
        case 'cdLC': cdLCCol = mapping.columnIndex; break;
        case 'cumulativeBalance': cumBalanceCol = mapping.columnIndex; break;
        case 'debit': debitCol = mapping.columnIndex; break;
        case 'credit': creditCol = mapping.columnIndex; break;
        case 'blanketAgreement': blanketCol = mapping.columnIndex; break;
      }
    }
  }

  // Parse data rows (skip header row and any rows before it)
  for (let i = headerRowIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length < 2) continue;

    const postingDateVal = postingDateCol >= 0 ? row[postingDateCol] : undefined;
    const transNo = transNoCol >= 0 ? String(row[transNoCol] || '') : '';
    const origin = originCol >= 0 ? String(row[originCol] || '') : '';
    const originNo = originNoCol >= 0 ? String(row[originNoCol] || '') : '';
    const offsetAccount = offsetAccountCol >= 0 ? String(row[offsetAccountCol] || '') : '';
    const details = detailsCol >= 0 ? String(row[detailsCol] || '') : '';
    const cumulativeBalance = cumBalanceCol >= 0 ? parseNumber(row[cumBalanceCol]) : null;
    const debit = debitCol >= 0 ? parseNumber(row[debitCol]) : null;
    const credit = creditCol >= 0 ? parseNumber(row[creditCol]) : null;
    // Many GL exports have separate Debit/Credit columns instead of one signed C/D (LC)
    // amount column. Reversal-pairing throughout the reconciler compares cdLC by sign/
    // magnitude, so when there's no dedicated amount column, derive a signed value from
    // debit/credit (debit positive, credit negative) instead of silently leaving it at 0
    // for every row, which would make all cdLC-based reversal matching permanently blind.
    const cdLC = cdLCCol >= 0 ? (parseNumber(row[cdLCCol]) || 0) : ((debit || 0) - (credit || 0));
    const blanketAgreement = blanketCol >= 0 && row[blanketCol] ? String(row[blanketCol]) : null;

    // Skip OB rows
    if (origin === 'OB') continue;

    // Skip rows with no useful data
    if (!postingDateVal && !details) continue;

    let postingDate = '';
    if (postingDateVal instanceof Date) {
      postingDate = postingDateVal.toISOString().split('T')[0];
    } else if (typeof postingDateVal === 'string') {
      postingDate = postingDateVal;
    } else if (typeof postingDateVal === 'number') {
      const d = XLSX.SSF.parse_date_code(postingDateVal);
      if (d) postingDate = `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
    }

    data.push({
      postingDate,
      transNo,
      origin,
      originNo,
      offsetAccount,
      details,
      cdLC,
      cumulativeBalance: cumulativeBalance,
      debit: debit !== null ? Math.abs(debit) : null,
      credit: credit !== null ? Math.abs(credit) : null,
      blanketAgreement,
    });
  }

  return data;
}

function parseNumber(val: unknown): number | null {
  if (val === null || val === undefined || val === '') return null;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    // Handle common bank statement formats:
    // - Em dash "\u2014" or hyphen "-" meaning zero/empty
    // - Numbers with commas: "1,234,567.89"
    // - Numbers in parentheses: "(1,234.56)" = negative
    // - Numbers with trailing minus: "1,234.56-" = negative
    // - Numbers with currency symbols: "PKR 1,234.56" or "Rs. 1,234"
    // - Numbers with "CR" or "DR" suffix
    let cleaned = val.trim();
    
    // Replace em dash, en dash, and various dash characters with empty
    cleaned = cleaned.replace(/[\u2014\u2013\u2012\u2015\u002D]/g, '');
    if (!cleaned) return null;
    
    // Remove currency prefixes
    cleaned = cleaned.replace(/^(PKR|Rs\.?|INR|USD|\$)\s*/i, '');
    
    // Remove CR/DR suffix
    cleaned = cleaned.replace(/\s*(CR|DR)\s*$/i, '');

    // Guard against misparsing non-numeric text (e.g. a date like "1-Jul-25" ending up
    // in this column due to a column-mapping mistake). parseFloat would otherwise
    // happily return the leading digit ("1") as a fake amount. Any letters left at
    // this point mean it isn't a real amount.
    if (/[a-zA-Z]/.test(cleaned)) return null;

    // Check for parentheses (negative number)
    const parenMatch = cleaned.match(/^\((.+)\)$/);
    if (parenMatch) {
      cleaned = parenMatch[1];
      const parsed = parseFloat(cleaned.replace(/,/g, ''));
      return isNaN(parsed) ? null : -parsed;
    }
    
    // Check for trailing minus (negative number)
    const trailingMinus = cleaned.endsWith('-');
    if (trailingMinus) {
      cleaned = cleaned.slice(0, -1);
    }
    
    // Remove commas and parse
    const parsed = parseFloat(cleaned.replace(/,/g, ''));
    if (isNaN(parsed)) return null;
    
    return trailingMinus ? -parsed : parsed;
  }
  return null;
}

function serializeResult(result: ReconciliationResult) {
  return JSON.parse(JSON.stringify(result, (_, value) => {
    if (value instanceof Date) {
      return value.toISOString().split('T')[0];
    }
    if (typeof value === 'number' && !isFinite(value)) {
      return 0;
    }
    return value;
  }));
}
