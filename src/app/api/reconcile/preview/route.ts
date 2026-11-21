import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { detectColumnMappings, detectSheetType, findHeaderRow, type FilePreview, type SheetPreview } from '@/lib/columnDetector';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * Preview endpoint: reads uploaded file headers and auto-detects column mappings
 * Returns detected mappings + sample data so the user can confirm/adjust before reconciliation
 */
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const bsFile = formData.get('bsFile') as File | null;
    const glFile = formData.get('glFile') as File | null;
    const combinedFile = formData.get('combinedFile') as File | null;

    if (!bsFile && !glFile && !combinedFile) {
      return NextResponse.json({ error: 'No files uploaded' }, { status: 400 });
    }

    const previews: FilePreview[] = [];

    const processFile = async (file: File, forceType?: 'bs' | 'gl') => {
      const buffer = await file.arrayBuffer();
      const workbook = XLSX.read(Buffer.from(buffer), { type: 'buffer' });
      const filePreview: FilePreview = {
        fileName: file.name,
        sheets: [],
      };

      for (const sheetName of workbook.SheetNames) {
        const ws = workbook.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1 }) as unknown[][];

        if (rows.length < 2) continue;

        // Find the header row
        const headerRowIndex = findHeaderRow(rows);
        const headers = rows[headerRowIndex].map((h, idx) => {
          if (h === null || h === undefined || h === '') return `Column ${idx + 1}`;
          return String(h);
        });

        // Get sample data rows (up to 5 rows after header)
        const dataStartIdx = headerRowIndex + 1;
        const sampleRows = rows.slice(dataStartIdx, dataStartIdx + 5);

        // Detect sheet type
        let sheetType = forceType || detectSheetType(headers);

        // For combined files, try to auto-detect based on sheet name
        if (!forceType) {
          const nameUpper = sheetName.toUpperCase();
          if (nameUpper === 'BS' || nameUpper.includes('BANK') || nameUpper.includes('STATEMENT')) {
            sheetType = 'bs';
          } else if (nameUpper === 'GL' || nameUpper.includes('LEDGER')) {
            sheetType = 'gl';
          }
        }

        // Detect column mappings
        const mappings = detectColumnMappings(headers, sampleRows, sheetType);

        const sheetPreview: SheetPreview = {
          sheetName,
          headers,
          sampleRows,
          mappings,
          detectedType: sheetType,
        };

        filePreview.sheets.push(sheetPreview);
      }

      previews.push(filePreview);
    };

    if (combinedFile) {
      await processFile(combinedFile);
    } else {
      if (bsFile) await processFile(bsFile, 'bs');
      if (glFile) await processFile(glFile, 'gl');
    }

    return NextResponse.json({ previews });
  } catch (error: unknown) {
    console.error('Preview error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
