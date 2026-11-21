/**
 * Universal Column Detection & Mapping Utility
 * 
 * Automatically detects column mappings from ANY bank statement or GL file
 * by scanning header names and matching them against known patterns.
 * 
 * Supports: HMB, HBL, UBL, MCB, ABL, BOP, NBP, SCB, Barclays, Citibank,
 * Bank Alfalah, Askari Bank, Soneri Bank, Silk Bank, Habib Bank, and more.
 */

// ===== KNOWN COLUMN PATTERNS =====

export const BS_FIELD_DEFINITIONS = [
  { field: 'date', label: 'Date', required: true, patterns: [/^date$/i, /value\s*date/i, /posting\s*date/i, /trans.*date/i, /transaction\s*date/i, /^dt$/i, /entry\s*date/i, /^\^?date$/i, /effective\s*date/i, /process.*date/i, /book.*date/i] },
  { field: 'particulars', label: 'Particulars / Description', required: true, patterns: [/^particular/i, /^description/i, /^details/i, /^narration/i, /transaction\s*detail/i, /^memo$/i, /^reference$/i, /particu/i, /^remarks$/i, /^desc$/i, /payee/i, /beneficiar/i] },
  { field: 'debit', label: 'Debit / Withdrawal', required: false, patterns: [/^debit$/i, /^withdraw/i, /^payment/i, /^dr$/i, /debit\s*\(lc\)/i, /amount\s*debit/i, /^outward/i, /^send/i, /^paid\s*out/i, /charge/i, /withdraw/i] },
  { field: 'credit', label: 'Credit / Deposit', required: false, patterns: [/^credit$/i, /^deposit/i, /^receipt/i, /^cr$/i, /credit\s*\(lc\)/i, /amount\s*credit/i, /^inward/i, /^receiv/i, /^paid\s*in/i, /deposit/i] },
  { field: 'balance', label: 'Balance', required: false, patterns: [/^balance$/i, /running\s*balance/i, /cum.*balance/i, /closing\s*balance/i, /^bal$/i, /cum.*bal/i, /running\s*bal/i, /account\s*balance/i] },
  { field: 'chequeNo', label: 'Cheque Number', required: false, patterns: [/cheque/i, /chq/i, /check\s*no/i, /instrument/i, /chq.*ref/i, /cheque.*no/i, /ref.*no/i, /reference\s*no/i, /^ref$/i] },
];

export const GL_FIELD_DEFINITIONS = [
  { field: 'rowNo', label: 'Row # / Serial', required: false, patterns: [/^#$/, /^s\.?no/i, /^sr/i, /^serial/i, /^line\s*no/i, /^row/i, /^s\/no/i, /^no$/i, /^sl\.?no/i] },
  { field: 'postingDate', label: 'Posting Date', required: true, patterns: [/posting\s*date/i, /^date$/i, /trans.*date/i, /entry\s*date/i, /transaction\s*date/i, /^dt$/i, /effective\s*date/i, /value\s*date/i] },
  { field: 'transNo', label: 'Transaction No', required: false, patterns: [/trans.*no/i, /transaction.*no/i, /voucher.*no/i, /document.*no/i, /^ref/i, /trans\s*no/i, /doc.*no/i, /voucher/i, /journal/i] },
  { field: 'origin', label: 'Origin / Source', required: false, patterns: [/^origin$/i, /^source$/i, /origin\s*type/i, /entry\s*type/i, /trans.*type/i, /journal\s*type/i, /^type$/i] },
  { field: 'originNo', label: 'Origin No / Reference', required: false, patterns: [/origin.*no/i, /source.*no/i, /reference.*no/i, /origin\s*no/i, /ref.*no/i, /source\s*ref/i, /batch/i] },
  { field: 'offsetAccount', label: 'Offset Account', required: false, patterns: [/offset.*account/i, /counter.*account/i, /contra.*account/i, /^account$/i, /against.*account/i, /other.*account/i, /offset/i, /balancing/i] },
  { field: 'details', label: 'Details / Description', required: true, patterns: [/^details$/i, /^description$/i, /^particular/i, /^narration$/i, /^memo$/i, /transaction\s*detail/i, /^remarks$/i, /^desc$/i, /payee/i] },
  { field: 'cdLC', label: 'C/D (LC) / Amount', required: false, patterns: [/c\/d\s*\(lc\)/i, /c\/d/i, /amount\s*\(lc\)/i, /local\s*currency/i, /^amount$/i] },
  { field: 'cumulativeBalance', label: 'Cumulative Balance', required: false, patterns: [/cum.*balance/i, /running\s*balance/i, /^balance$/i, /cum.*bal/i, /closing\s*balance/i, /^bal$/i] },
  { field: 'debit', label: 'Debit', required: false, patterns: [/^debit$/i, /^dr$/i, /debit\s*\(lc\)/i, /^withdraw/i, /^payment/i, /^outward/i] },
  { field: 'credit', label: 'Credit', required: false, patterns: [/^credit$/i, /^cr$/i, /credit\s*\(lc\)/i, /^deposit/i, /^receipt/i, /^inward/i] },
  { field: 'blanketAgreement', label: 'Blanket Agreement', required: false, patterns: [/blanket/i, /^ba$/i, /agreement/i, /lc.*ref/i] },
];

export interface ColumnMapping {
  field: string;
  label: string;
  required: boolean;
  columnIndex: number | null; // -1 means "not mapped"
  detectedName: string | null; // the actual header text found
  confidence: number; // 0-100 how confident the detection is
  sampleData: unknown[]; // first 5 values from this column
}

export interface SheetPreview {
  sheetName: string;
  headers: string[];
  sampleRows: unknown[][];
  mappings: ColumnMapping[];
  detectedType: 'bs' | 'gl' | 'unknown';
}

export interface FilePreview {
  fileName: string;
  sheets: SheetPreview[];
}

// ===== DETECTION ENGINE =====

/**
 * Detect which type of sheet this is (BS or GL)
 */
export function detectSheetType(headers: string[]): 'bs' | 'gl' | 'unknown' {
  const headerStr = headers.join(' ').toLowerCase();
  
  // GL-specific indicators
  const glIndicators = [/origin/i, /offset.*account/i, /cum.*balance/i, /c\/d/i, /blanket/i, /trans.*no/i, /posting\s*date/i];
  const glScore = glIndicators.reduce((score, pattern) => score + (pattern.test(headerStr) ? 1 : 0), 0);
  
  // BS-specific indicators  
  const bsIndicators = [/particular/i, /^balance$/i, /value\s*date/i, /cheque/i, /narration/i];
  // BS typically has Date, Particulars, Debit, Credit, Balance pattern
  const hasBSAmountPattern = headers.some(h => /^debit$/i.test(String(h))) && headers.some(h => /^credit$/i.test(String(h)));
  const bsScore = bsIndicators.reduce((score, pattern) => score + (pattern.test(headerStr) ? 1 : 0), 0) + (hasBSAmountPattern ? 1 : 0);
  
  if (glScore > bsScore) return 'gl';
  if (bsScore > glScore) return 'bs';
  return 'unknown';
}

/**
 * Match a single header text against known patterns for a field
 */
function matchHeaderToField(headerText: string, fieldDef: typeof BS_FIELD_DEFINITIONS[0]): { matched: boolean; confidence: number } {
  const trimmed = String(headerText).trim();
  if (!trimmed) return { matched: false, confidence: 0 };
  
  let bestConfidence = 0;
  
  for (const pattern of fieldDef.patterns) {
    if (pattern.test(trimmed)) {
      // Exact match = high confidence, partial = medium
      if (pattern.source.startsWith('^') && pattern.source.endsWith('$')) {
        // Exact regex match - very confident
        bestConfidence = Math.max(bestConfidence, 95);
      } else if (pattern.source.startsWith('^') || pattern.source.endsWith('$')) {
        // Starts with or ends with - good confidence
        bestConfidence = Math.max(bestConfidence, 80);
      } else {
        // Contains match - moderate confidence
        bestConfidence = Math.max(bestConfidence, 65);
      }
    }
  }
  
  return { matched: bestConfidence > 0, confidence: bestConfidence };
}

/**
 * Auto-detect column mappings for a sheet
 */
export function detectColumnMappings(headers: string[], sampleRows: unknown[][], type: 'bs' | 'gl' | 'unknown'): ColumnMapping[] {
  const fieldDefs = type === 'gl' ? GL_FIELD_DEFINITIONS : BS_FIELD_DEFINITIONS;
  const mappings: ColumnMapping[] = [];
  
  // Track which columns have been assigned to avoid double-mapping
  const assignedColumns = new Set<number>();
  
  for (const fieldDef of fieldDefs) {
    let bestMatch = { columnIndex: -1, confidence: 0, detectedName: null as string | null };
    
    for (let colIdx = 0; colIdx < headers.length; colIdx++) {
      if (assignedColumns.has(colIdx)) continue;
      
      const headerText = String(headers[colIdx] || '');
      const result = matchHeaderToField(headerText, fieldDef);
      
      if (result.matched && result.confidence > bestMatch.confidence) {
        bestMatch = {
          columnIndex: colIdx,
          confidence: result.confidence,
          detectedName: headerText,
        };
      }
    }
    
    // Get sample data for this column
    const sampleData = bestMatch.columnIndex >= 0 
      ? sampleRows.map(row => row[bestMatch.columnIndex]).slice(0, 5)
      : [];
    
    if (bestMatch.columnIndex >= 0) {
      assignedColumns.add(bestMatch.columnIndex);
    }
    
    mappings.push({
      field: fieldDef.field,
      label: fieldDef.label,
      required: fieldDef.required,
      columnIndex: bestMatch.columnIndex >= 0 ? bestMatch.columnIndex : null,
      detectedName: bestMatch.detectedName,
      confidence: bestMatch.confidence,
      sampleData,
    });
  }
  
  return mappings;
}

/**
 * Smart header row detection - finds the row that looks like headers
 * (not just row 0, some files have title rows before headers)
 */
export function findHeaderRow(rows: unknown[][]): number {
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const row = rows[i];
    if (!row) continue;
    
    // A header row typically has multiple string values that aren't dates or numbers
    let stringCount = 0;
    let numberCount = 0;
    
    for (const cell of row) {
      if (cell === null || cell === undefined || cell === '') continue;
      if (typeof cell === 'string' && isNaN(Number(cell))) {
        stringCount++;
      } else if (typeof cell === 'number') {
        numberCount++;
      }
    }
    
    // Header rows have more text strings than numbers
    if (stringCount >= 3 && stringCount > numberCount) {
      return i;
    }
  }
  
  return 0; // Default to first row
}

// ===== SESSION PERSISTENCE =====

export interface ReconciliationSession {
  id: string;
  name: string;
  savedAt: string;
  fileName: string;
  result: unknown; // ReconciliationResult
  columnMappings?: {
    bsMappings: ColumnMapping[];
    glMappings: ColumnMapping[];
  };
}

const SESSION_STORAGE_KEY = 'bank-recon-sessions';
const MAX_SESSIONS = 5;

/**
 * IndexedDB helper for storing large sessions
 */
async function saveToIndexedDB(key: string, value: unknown): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open('BankReconDB', 1);
      request.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains('store')) {
          db.createObjectStore('store');
        }
      };
      request.onsuccess = (e) => {
        const db = (e.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains('store')) {
          resolve(false);
          return;
        }
        const tx = db.transaction('store', 'readwrite');
        const store = tx.objectStore('store');
        const putReq = store.put(value, key);
        putReq.onsuccess = () => resolve(true);
        putReq.onerror = () => resolve(false);
      };
      request.onerror = () => resolve(false);
    } catch {
      resolve(false);
    }
  });
}

async function getFromIndexedDB(key: string): Promise<unknown> {
  if (typeof window === 'undefined') return null;
  return new Promise((resolve) => {
    try {
      const request = indexedDB.open('BankReconDB', 1);
      request.onupgradeneeded = (e) => {
        const db = (e.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains('store')) {
          db.createObjectStore('store');
        }
      };
      request.onsuccess = (e) => {
        const db = (e.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains('store')) {
          resolve(null);
          return;
        }
        const tx = db.transaction('store', 'readonly');
        const store = tx.objectStore('store');
        const getReq = store.get(key);
        getReq.onsuccess = () => resolve(getReq.result);
        getReq.onerror = () => resolve(null);
      };
      request.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

/**
 * Save a reconciliation session to IndexedDB
 */
export async function saveSession(session: ReconciliationSession): Promise<void> {
  if (typeof window === 'undefined') return;

  const sessions = await getSessions();
  const existingIdx = sessions.findIndex(s => s.id === session.id);

  if (existingIdx >= 0) {
    sessions[existingIdx] = session;
  } else {
    sessions.unshift(session);
  }

  // Keep max sessions
  const trimmed = sessions.slice(0, MAX_SESSIONS);
  const success = await saveToIndexedDB(SESSION_STORAGE_KEY, trimmed);

  if (!success) {
    console.warn('Session could not be saved to IndexedDB.');
  }
}

/**
 * Get all saved sessions from IndexedDB
 */
export async function getSessions(): Promise<ReconciliationSession[]> {
  if (typeof window === 'undefined') return [];

  try {
    const raw = await getFromIndexedDB(SESSION_STORAGE_KEY);
    if (!raw) return [];
    return raw as ReconciliationSession[];
  } catch {
    return [];
  }
}

/**
 * Delete a saved session
 */
export async function deleteSession(sessionId: string): Promise<void> {
  if (typeof window === 'undefined') return;

  const sessions = await getSessions();
  const filtered = sessions.filter(s => s.id !== sessionId);
  await saveToIndexedDB(SESSION_STORAGE_KEY, filtered);
}

/**
 * Auto-save current reconciliation state
 */
export async function autoSaveSession(fileName: string, result: unknown): Promise<void> {
  if (typeof window === 'undefined') return;
  if (!result) return;

  const session: ReconciliationSession = {
    id: `auto-${fileName.replace(/[^a-zA-Z0-9]/g, '_')}`,
    name: `Auto-save: ${fileName}`,
    savedAt: new Date().toISOString(),
    fileName,
    result,
  };

  await saveSession(session);
}

/**
 * Export session to a JSON file for download
 */
export function exportSessionToFile(session: ReconciliationSession): void {
  const blob = new Blob([JSON.stringify(session, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `recon-session-${session.name.replace(/[^a-zA-Z0-9]/g, '_')}-${new Date().toISOString().split('T')[0]}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Import session from a JSON file
 */
export function importSessionFromFile(file: File): Promise<ReconciliationSession> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const session = JSON.parse(e.target?.result as string) as ReconciliationSession;
        if (!session.result || !session.id) {
          reject(new Error('Invalid session file'));
          return;
        }
        resolve(session);
      } catch (err) {
        reject(new Error('Failed to parse session file'));
      }
    };
    reader.onerror = () => reject(new Error('Failed to read file'));
    reader.readAsText(file);
  });
}
