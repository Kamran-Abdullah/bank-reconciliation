import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { appendGLAndReconcile, type ReconciliationResult } from '@/lib/reconciler';
import { findHeaderRow, type ColumnMapping } from '@/lib/columnDetector';

export const runtime = 'nodejs';
export const maxDuration = 300;
export const dynamic = 'force-dynamic';

function parseNumber(val: unknown): number | null {
  if (val === null || val === undefined || val === '') return null;
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const clean = val.replace(/,/g, '').trim();
    if (clean === '' || clean === '-') return null;
    // Guard against misparsing non-numeric text (e.g. a stray date) into a fake amount.
    if (/[a-zA-Z]/.test(clean)) return null;
    const num = parseFloat(clean);
    return isNaN(num) ? null : num;
  }
  return null;
}

function parseGLData(
  rows: unknown[][],
  columnMappings?: ColumnMapping[]
): Array<{ postingDate: string; transNo: string; origin: string; originNo: string; offsetAccount: string; details: string; cdLC: number; cumulativeBalance: number | null; debit: number | null; credit: number | null; blanketAgreement: string | null }> {
  const data: Array<{ postingDate: string; transNo: string; origin: string; originNo: string; offsetAccount: string; details: string; cdLC: number; cumulativeBalance: number | null; debit: number | null; credit: number | null; blanketAgreement: string | null }> = [];

  const headerRowIndex = findHeaderRow(rows);

  let rowNoCol = 0, postingDateCol = 1, transNoCol = 2, originCol = 3, originNoCol = 4;
  let offsetAccountCol = 5, detailsCol = 6, cdLCCol = 7, cumBalanceCol = 8;
  let debitCol = 9, creditCol = 10, blanketCol = 11;

  if (columnMappings && columnMappings.length > 0) {
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
    // Derive a signed amount when there's no dedicated C/D (LC) column — see route.ts for why.
    const cdLC = cdLCCol >= 0 ? (parseNumber(row[cdLCCol]) || 0) : ((debit || 0) - (credit || 0));
    const blanketAgreement = blanketCol >= 0 && row[blanketCol] ? String(row[blanketCol]) : null;

    if (origin === 'OB') continue;
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
      postingDate, transNo, origin, originNo, offsetAccount, details, cdLC,
      cumulativeBalance, debit, credit, blanketAgreement
    });
  }

  return data;
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const glFile = formData.get('glFile') as File | null;
    const currentResultStr = formData.get('currentResult') as string | null;
    const glMappingsStr = formData.get('glMappings') as string | null;
    const autoMatchThresholdStr = formData.get('autoMatchThreshold') as string | null;
    
    if (!glFile || !currentResultStr) {
      return NextResponse.json({ error: 'Missing GL file or current result' }, { status: 400 });
    }

    let currentResult: ReconciliationResult;
    try {
      currentResult = JSON.parse(currentResultStr);
    } catch {
      return NextResponse.json({ error: 'Invalid current result JSON' }, { status: 400 });
    }

    let glMappings: ColumnMapping[] = [];
    if (glMappingsStr) {
      try {
        glMappings = JSON.parse(glMappingsStr);
      } catch { }
    }

    let autoMatchThreshold = 55;
    if (autoMatchThresholdStr && !isNaN(parseInt(autoMatchThresholdStr, 10))) {
      autoMatchThreshold = parseInt(autoMatchThresholdStr, 10);
    }

    const buffer = await glFile.arrayBuffer();
    const workbook = XLSX.read(Buffer.from(buffer), { type: 'buffer' });
    const sheetName = workbook.SheetNames[0];
    const ws = workbook.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1 }) as unknown[][];

    const newGlData = parseGLData(rows, glMappings);

    if (newGlData.length === 0) {
      return NextResponse.json({ error: 'No valid data found in uploaded GL file.' }, { status: 400 });
    }

    const updatedResult = appendGLAndReconcile(currentResult, newGlData, autoMatchThreshold);

    return NextResponse.json(updatedResult);
  } catch (error: any) {
    console.error('Update GL Error:', error);
    return NextResponse.json(
      { error: error.message || 'An unexpected error occurred during update' },
      { status: 500 }
    );
  }
}
