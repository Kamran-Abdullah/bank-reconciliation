/**
 * Bank Reconciliation Engine
 * 
 * Matches Bank Statement (BS) transactions with General Ledger (GL) entries
 * using cheque numbers, PSID numbers, amounts, and description matching.
 */

export interface BSTransaction {
  rowNo: number;
  date: string;
  particulars: string;
  debit: number | null;
  credit: number | null;
  balance: number | null;
  keyExtracted: string;
  uniqueKey: string;
  reconStatus: string;
  matchedWith?: string;
}

export interface GLTransaction {
  rowNo: number;
  postingDate: string;
  transNo: string;
  origin: string;
  originNo: string;
  offsetAccount: string;
  details: string;
  cdLC: number;
  cumulativeBalance: number | null;
  debit: number | null;
  credit: number | null;
  blanketAgreement: string | null;
  keyExtracted: string;
  uniqueKey: string;
  reconStatus: string;
  isReversal: boolean;
  reversalPartnerTransNo?: string;
  matchedWith?: string;
}

export interface MatchedPair {
  id: number;
  type: 'Payment' | 'Receipt';
  bsDate: string;
  bsParticulars: string;
  glDetails: string;
  uniqueKey: string;
  bsDebit: number | null;
  bsCredit: number | null;
  glDebit: number | null;
  glCredit: number | null;
  bsRowNo: number;
  glRowNo: number;
}

export interface PossibleMatch {
  id: number;
  bsTransaction: BSTransaction;
  glTransaction: GLTransaction;
  confidence: number; // 0-100
  matchReason: string;
  bsCategory: 'unRecordedPayment' | 'unRecordedReceipt';
  glCategory: 'unPresentedCheque' | 'unClearedReceipt';
}

export interface GapAuditItem {
  source: 'reversal_net' | 'matched_amount_diff' | 'bs_unaccounted' | 'gl_unaccounted' | 'calculation_check';
  label: string;
  amount: number;
  description: string;
  entries?: Array<{ transNo?: string; particulars?: string; debit: number | null; credit: number | null; details?: string }>;
}

export interface GapAudit {
  gap: number;
  items: GapAuditItem[];
  reversalNetImpact: number;
  matchedAmountDiff: number;
  bsUnaccountedNet: number;
  glUnaccountedNet: number;
  unexplainedGap: number;
}

export interface ReconciliationResult {
  summary: {
    glBalance: number;
    bsBalance: number;
    unPresentedCheques: { count: number; total: number };
    unClearedReceipts: { count: number; total: number };
    unRecordedPayments: { count: number; total: number };
    unRecordedReceipts: { count: number; total: number };
    matchedPairs: { count: number; totalPayments: number; totalReceipts: number };
    bsReversals: { count: number; totalDebit: number; totalCredit: number; netImpact: number };
    adjustedGLBalance: number;
    difference: number;
    glOpeningBalance: number;
    glTotalDebit: number;
    glTotalCredit: number;
    glComputedBalance: number;
    bsOpeningBalance: number;
    bsTotalDebit: number;
    bsTotalCredit: number;
    bsComputedBalance: number;
    totalBSDebitMatched: number;
    totalBSCreditMatched: number;
    totalGLDebitMatched: number;
    totalGLCreditMatched: number;
  };
  bsTransactions: BSTransaction[];
  glTransactions: GLTransaction[];
  matchedPairs: MatchedPair[];
  unPresentedCheques: GLTransaction[];
  unClearedReceipts: GLTransaction[];
  unRecordedPayments: BSTransaction[];
  unRecordedReceipts: BSTransaction[];
  manualMatches: ManualMatch[];
  reversalEntries: GLTransaction[];
  bsReversalEntries: BSTransaction[];
  possibleMatches: PossibleMatch[];
  gapAudit: GapAudit;
}

export interface ManualMatch {
  id: string;
  bsKey: string;
  glKey: string;
  bsRowNo: number;
  glRowNo: number;
  type: 'Payment' | 'Receipt';
  bsParticulars: string;
  glDetails: string;
  bsAmount: number;
  glAmount: number;
  timestamp: string;
  reason: string;
}

/**
 * Extract cheque number from text - handles various formats
 */
function extractChequeNo(text: string): string | null {
  if (!text) return null;
  
  const patterns = [
    /^(\d{5,10})\s+\S+\s+CHQ\b/i,                            // Leading number before "CHQ" keyword, e.g. "10168068 TRNSFERS CHQ DR SALARIES..." — the cheque number precedes "CHQ" here, not after it
    /(?:Chq|CHQ|Cheque|chq)[\s#:.\-]{0,6}(\d{4,9})/i,        // "Chq" keyword directly followed by punctuation/spaces then digits (no intervening words)
    /(?<!ADV)(?<!PSID)(?<!REF)(?<!INV)(?<!DOC)(?<!TXN)#[^0-9]*(\d{4,9})/i, // "#123456" format - common in GL details, but not when "#" belongs to a non-cheque reference like "ADV#"/"PSID#"
    /Cheque\s+(\d{4,9})\s+encashed/i,
    /Cheque\s+Cleared\s+\(#[^0-9]*(\d{4,9})\)/i,
    /HMB\s+(\d{4,9})/i,                               // "HMB 187659583" in GL details
    /(?:Chq|CHQ)[^0-9]*(\d{4,9})\s*\(Reversal\)/i,   // "Chq#187659863(Reversal)"
    /\b(\d{5,20})\b/,                                 // Isolated 5-20 digit number (e.g., "CLEARING OUTWARD 77829930" or concatenated like "009200001388")
  ];
  
  for (const p of patterns) {
    const m = text.match(p);
    if (m) {
      // Strip leading zeros for robust matching (e.g., "00659121" -> "659121")
      return m[1].replace(/^0+/, '');
    }
  }
  
  return null;
}

/**
 * Extract PSID number from text
 */
function extractPSID(text: string): string | null {
  const m = text.match(/PSID#?\s*(\d{15,})/i) || text.match(/\((\d{20,})\)/);
  return m ? m[1] : null;
}

/**
 * Extract transaction reference IDs (RAAST, OTB, EFT, RTGS, etc.)
 */
function extractRefID(text: string): string | null {
  const patterns = [
    { p: /RTGS\s*(?:INFLOW\s*)?#?(\d+)/i, g: 1 },
    { p: /([A-Z]{3}\d{10}[A-Za-z0-9]{20,})/, g: 1 },
    { p: /(OTB\d{10,})/i, g: 1 },
    { p: /(ABPAPKKA\d{10,})/i, g: 1 },
    { p: /Outward\s+Chq#(\d+)/i, g: 1 },
    { p: /EFT\s+Rec\s+from\s+Bank\s*\((\w+)\)/i, g: 1 },
    { p: /Return of Outward Clearing Chq#(\d+)/i, g: 1 },
    { p: /FBR\/CUSTOM\s*\((\d{6,})\)/i, g: 1 },
    { p: /1-BILL\s+INVOICE\s*\((\d{15,})\)/i, g: 1 },
    { p: /UBPS\s+to\s+FBR\/CUSTOM\s*\((\d{6,})\)/i, g: 1 },
  ];
  
  for (const { p, g } of patterns) {
    const m = text.match(p);
    if (m) return m[g];
  }
  return null;
}

/**
 * Extract descriptive key (for bank charges, margins, etc.)
 */
function extractDescKey(text: string): string | null {
  const patterns = [
    /(Margin\s+Recovered[^,]*)/i,
    /(Margin\s+Reversed[^,]*)/i,
    /(Service\s+Charges[^,]*)/i,
    /(Commission[^,]*Recovered[^,]*)/i,
    /(Commission\/Charges\s+Recovered[^,]*)/i,
    /(Commission\s+Recovered[^,]*)/i,
    /(PAD\s+Retired[^,]*)/i,
    /(Doc\.\s+Recvd[^,]*)/i,
    /(Cash\s+deposited[^,]*)/i,
    /(\d+%\s+Punjab\s+Sales\s+Tax)/i,
    /(Withholding\s+Tax)/i,
    /(FED)/i,
    /Inward\s+Clearing\s+Chq#(\d+)/i,
  ];
  
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1].substring(0, 60).trim();
  }
  return null;
}

/**
 * Get all matching keys from a transaction description
 */
function getAllKeys(text: string): string[] {
  const keys: string[] = [];
  
  const chqNo = extractChequeNo(text);
  if (chqNo) keys.push(chqNo);
  
  const psid = extractPSID(text);
  if (psid) keys.push(psid);
  
  const refId = extractRefID(text);
  if (refId) keys.push(refId);
  
  const descKey = extractDescKey(text);
  if (descKey) keys.push(descKey);
  
  return keys;
}

/**
 * Build primary unique key for a transaction
 */
function buildUniqueKey(text: string, amount: number, rowNo?: number): string {
  const keys = getAllKeys(text);
  const primaryKey = keys.length > 0 ? keys[0] : text.substring(0, 40).trim();
  const base = `${primaryKey}-${amount}`;
  return rowNo !== undefined ? `${base}#${rowNo}` : base;
}

/**
 * Detect if a GL entry is a reversal
 */
function detectReversal(details: string): { isReversal: boolean; partnerTransNo?: string } {
  // Only detect ACTUAL reversal entries â€” not regular business entries like "Margin Recovered"
  // Examples of real reversals:
  //   - "Travelling Expenses PO - Chq# 187659863(Reversal) â€“ 609702"
  //   - "Reverse Entry for Payment No. 913002"
  //   - "FSA Haroon Qureshi # 12049 Chq#187659698(Reversal) - 611977"
  //   - "Checks for Payment(Reversal) - 613705"  (references original Trans. No.)
  //   - "Checks for Payment(Reversal) - 617962"  (references original Trans. No.)
  // NOT reversals (regular business):
  //   - "Margin Recovered, DO Issue, Contract #2008, DO # 1903"
  //   - "Commission Recovered"
  //   - "Margin Reversed" (business term, not a reversal entry)
  const reversalPatterns = [
    /\(Reversal\)/i,          // "(Reversal)" in parentheses â€” e.g., "Chq# 187659863(Reversal)"
    /Reverse Entry for/i,      // "Reverse Entry for Payment No. ..."
    /^Reversal\s/i,            // "Reversal " at the very start of details text
    /\bReversal\s+Entry\b/i,   // "Reversal Entry" as a compound phrase
  ];
  
  for (const pattern of reversalPatterns) {
    if (pattern.test(details)) {
      // Try to extract the partner Trans. No. from the details
      // Multiple patterns to extract the referenced original transaction number:
      
      // Pattern 1: "(Reversal) - TRANNO" â€” e.g., "Checks for Payment(Reversal) - 613705"
      const reversalDashMatch = details.match(/\(Reversal\)\s*[-â€“â€”]\s*(\d+)/i);
      if (reversalDashMatch) {
        return { isReversal: true, partnerTransNo: reversalDashMatch[1] };
      }
      
      // Pattern 2: "Reverse Entry for Payment No. XXXXX"
      const paymentNoMatch = details.match(/Reverse Entry for Payment No\.\s*(\d+)/i);
      if (paymentNoMatch) {
        return { isReversal: true, partnerTransNo: paymentNoMatch[1] };
      }
      
      // Pattern 3: Generic "- DIGITS" at end of details (fallback)
      const partnerMatch = details.match(/[-â€“â€”]\s*(\d{5,})\s*$/);
      if (partnerMatch) {
        return { isReversal: true, partnerTransNo: partnerMatch[1] };
      }
      
      // Reversal detected but no partner Trans. No. found
      return { isReversal: true, partnerTransNo: undefined };
    }
  }
  
  return { isReversal: false };
}

/**
 * Check if two keys refer to the same cheque
 */
function chequeKeysMatch(key1: string, key2: string): boolean {
  if (key1 === key2) return true;
  if (key1.length >= 6 && key2.length >= 6 && (key1.includes(key2) || key2.includes(key1))) return true;
  return false;
}

/**
 * Calculate string similarity (0-1)
 */
function stringSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const aLower = a.toLowerCase().trim();
  const bLower = b.toLowerCase().trim();
  if (aLower === bLower) return 1;
  if (aLower.includes(bLower) || bLower.includes(aLower)) return 0.8;
  
  const aWords = new Set(aLower.split(/\s+/));
  const bWords = new Set(bLower.split(/\s+/));
  const intersection = new Set([...aWords].filter(w => bWords.has(w)));
  const union = new Set([...aWords, ...bWords]);
  return union.size > 0 ? intersection.size / union.size : 0;
}


export function appendGLAndReconcile(
  currentResult: ReconciliationResult,
  newGlData: Array<{ postingDate: string; transNo: string; origin: string; originNo: string; offsetAccount: string; details: string; cdLC: number; cumulativeBalance: number | null; debit: number | null; credit: number | null; blanketAgreement: string | null }>,
  autoMatchThreshold: number = 55
): ReconciliationResult {
  const cloned = deepCloneResult(currentResult);
  
  // 1. Identify existing transNos
  const existingTransNos = new Set<string>();
  for (const gl of cloned.glTransactions) {
    if (gl.transNo) existingTransNos.add(gl.transNo);
  }
  
  let nextRowNo = cloned.glTransactions.length > 0 
    ? Math.max(...cloned.glTransactions.map(t => t.rowNo)) + 1 
    : 1;
    
  let matchId = cloned.matchedPairs.length > 0 
    ? Math.max(...cloned.matchedPairs.map(p => p.id)) + 1 
    : 1;

  // 2. Filter & format new GL entries
  const newlyAddedGL: GLTransaction[] = [];
  for (const row of newGlData) {
    if (row.transNo && existingTransNos.has(row.transNo)) continue;
    
    const amount = row.debit || row.credit || 0;
    const glUniqueKey = buildUniqueKey(row.details, amount, nextRowNo);
    
    const newGL: GLTransaction = {
      rowNo: nextRowNo++,
      postingDate: row.postingDate,
      transNo: row.transNo,
      origin: row.origin,
      originNo: row.originNo,
      offsetAccount: row.offsetAccount,
      details: row.details,
      cdLC: row.cdLC,
      cumulativeBalance: row.cumulativeBalance,
      debit: row.debit,
      credit: row.credit,
      blanketAgreement: row.blanketAgreement,
      keyExtracted: '', // Not strictly needed for UI
      uniqueKey: glUniqueKey,
      reconStatus: 'Pending',
      isReversal: false, // We skip reversal detection for incremental for simplicity
      reversalPartnerTransNo: undefined,
      _allKeys: []
    } as GLTransaction & { _allKeys: string[] };
    
    newlyAddedGL.push(newGL);
    cloned.glTransactions.push(newGL);
  }
  
  if (newlyAddedGL.length === 0) {
    return cloned; // Nothing to update
  }

  // 3. Match unmatched BS against newlyAddedGL
  const unmatchedBS = cloned.bsTransactions.filter(t => t.reconStatus !== 'Matched');
  
  for (const bs of unmatchedBS) {
    if (bs.reconStatus === 'Matched') continue;
    
    const isPayment = bs.debit !== null && bs.debit > 0;
    const bsAmount = bs.debit || bs.credit || 0;
    const bsChqNo = extractChequeNo(bs.particulars);
    const bsRefId = extractRefID(bs.particulars);
    
    let bestMatch: GLTransaction | null = null;
    let bestScore = 0;
    let bestMatchReason = '';
    
    for (const gl of newlyAddedGL) {
      if (gl.reconStatus === 'Matched') continue;
      
      const glAmount = gl.debit || gl.credit || 0;

      // Standard direction, or same-side (both Credit / both Debit) when cheque + amount match exactly
      const isStandardDirection = (isPayment && bs.debit === gl.credit) || (!isPayment && bs.credit === gl.debit);
      const isSameSideExact = (bs.credit !== null && bs.credit === gl.credit) || (bs.debit !== null && bs.debit === gl.debit);
      if (!isStandardDirection && !isSameSideExact) continue;

      let score = 0;
      const reasons: string[] = [];

      // Amount match
      if (bsAmount === glAmount) {
        score += 40;
        reasons.push(`Exact amount PKR ${bsAmount}`);
      } else if (glAmount > 0 && Math.abs(bsAmount - glAmount) / glAmount <= 0.05) {
        score += 25;
        reasons.push(`Similar amount (within 5%)`);
      }

      // Cheque match
      const glChqNo = extractChequeNo(gl.details);
      if (bsChqNo && glChqNo && chequeKeysMatch(bsChqNo, glChqNo)) {
        score += 30;
        reasons.push(`Cheque match`);
      }

      if (!isStandardDirection && isSameSideExact) {
        if (!(bsChqNo && glChqNo && chequeKeysMatch(bsChqNo, glChqNo))) continue; // require cheque match for same-side
        score += 30;
        reasons.push(`Same-side match (both sides Credit/Debit)`);
      }
      
      // Ref ID match
      const glRefId = extractRefID(gl.details);
      if (bsRefId && glRefId && bsRefId === glRefId) {
        score += 25;
        reasons.push(`Ref ID match`);
      } else if (bsRefId && gl.details.includes(bsRefId)) {
        score += 20;
        reasons.push(`Partial Ref ID match`);
      }
      
      // Description similarity
      const similarity = calculateSimilarity(bs.particulars, gl.details);
      if (similarity > 0.7) {
        score += 30;
        reasons.push(`Strong description match (${Math.round(similarity*100)}%)`);
      } else if (similarity > 0.4) {
        score += 20;
        reasons.push(`Partial description match (${Math.round(similarity*100)}%)`);
      }
      
      if (score > bestScore) {
        bestScore = score;
        bestMatch = gl;
        bestMatchReason = reasons.join('; ');
      }
    }
    
    if (bestMatch && bestScore >= autoMatchThreshold) {
      const matchType: 'Payment' | 'Receipt' = bs.debit ? 'Payment' : 'Receipt';
      cloned.matchedPairs.push({
        id: matchId++,
        type: matchType,
        bsDate: bs.date,
        bsParticulars: bs.particulars,
        glDetails: bestMatch.details,
        uniqueKey: bs.uniqueKey,
        bsDebit: bs.debit,
        bsCredit: bs.credit,
        glDebit: bestMatch.debit,
        glCredit: bestMatch.credit,
        bsRowNo: bs.rowNo,
        glRowNo: bestMatch.rowNo,
      });
      bs.reconStatus = 'Matched';
      bs.matchedWith = bestMatch.uniqueKey;
      bestMatch.reconStatus = 'Matched';
      bestMatch.matchedWith = bs.uniqueKey;
    } else if (bestMatch && bestScore >= 30) {
      // Add to possible matches
      let pmId = cloned.possibleMatches.length > 0 ? Math.max(...cloned.possibleMatches.map(p => p.id)) + 1 : 1;
      const bsCategory: 'unRecordedPayment' | 'unRecordedReceipt' = bs.debit ? 'unRecordedPayment' : 'unRecordedReceipt';
      const glCategory: 'unPresentedCheque' | 'unClearedReceipt' = (bestMatch.credit && bestMatch.credit > 0) ? 'unPresentedCheque' : 'unClearedReceipt';
      
      cloned.possibleMatches.push({
        id: pmId,
        bsTransaction: bs,
        glTransaction: bestMatch,
        confidence: Math.min(bestScore, 100),
        matchReason: bestMatchReason,
        bsCategory,
        glCategory,
      });
    }
  }
  
  // Re-sort possible matches
  cloned.possibleMatches.sort((a, b) => b.confidence - a.confidence);
  cloned.possibleMatches.forEach((pm, i) => { pm.id = i + 1; });
  
  // 4. Recategorize unmatched items
  cloned.unPresentedCheques = [];
  cloned.unClearedReceipts = [];
  cloned.unRecordedPayments = [];
  cloned.unRecordedReceipts = [];
  
  const reversalGLKeys = new Set<string>();
  const reversalBSKeys = new Set<string>();
  for (const rev of cloned.reversalEntries) {
    if (rev.uniqueKey) reversalGLKeys.add(rev.uniqueKey);
  }
  for (const rev of cloned.bsReversalEntries) {
    if (rev.uniqueKey) reversalBSKeys.add(rev.uniqueKey);
  }
  
  for (const gl of cloned.glTransactions) {
    if (gl.reconStatus !== 'Matched' && !reversalGLKeys.has(gl.uniqueKey)) {
      if (gl.credit && gl.credit > 0) cloned.unPresentedCheques.push(gl);
      else if (gl.debit && gl.debit > 0) cloned.unClearedReceipts.push(gl);
    }
  }
  
  for (const bs of cloned.bsTransactions) {
    if (bs.reconStatus !== 'Matched' && !reversalBSKeys.has(bs.uniqueKey)) {
      if (bs.debit && bs.debit > 0) cloned.unRecordedPayments.push(bs);
      else if (bs.credit && bs.credit > 0) cloned.unRecordedReceipts.push(bs);
    }
  }

  // 5. Recalculate summary and audit
  recalculateSummary(cloned);
  
  return cloned;
}


/**
 * Main reconciliation function
 */
export function performReconciliation(
  bsData: Array<{ date: string; particulars: string; debit: number | null; credit: number | null; balance: number | null }>,
  glData: Array<{ postingDate: string; transNo: string; origin: string; originNo: string; offsetAccount: string; details: string; cdLC: number; cumulativeBalance: number | null; debit: number | null; credit: number | null; blanketAgreement: string | null }>,
  autoMatchThreshold: number = 55
): ReconciliationResult {
  
  // Step 1: Build BS transactions with keys
  const bsTransactions: BSTransaction[] = bsData.map((row, idx) => {
    const amount = row.debit || row.credit || 0;
    const keys = getAllKeys(row.particulars);
    const primaryKey = keys.length > 0 ? keys[0] : row.particulars.substring(0, 40).trim();
    const uniqueKey = buildUniqueKey(row.particulars, amount, idx + 1);
    return {
      rowNo: idx + 1,
      date: row.date,
      particulars: row.particulars,
      debit: row.debit,
      credit: row.credit,
      balance: row.balance,
      keyExtracted: primaryKey,
      uniqueKey,
      reconStatus: 'Pending',
      _allKeys: keys,
    } as BSTransaction & { _allKeys: string[] };
  });

  // Step 2: Build GL transactions with keys
  const glTransactionsRaw = glData.map((row, idx) => {
    const amount = Math.abs(row.cdLC || 0);
    const keys = getAllKeys(row.details);
    const primaryKey = keys.length > 0 ? keys[0] : row.details.substring(0, 40).trim();
    const uniqueKey = buildUniqueKey(row.details, amount, idx + 1);
    const reversal = detectReversal(row.details);
    return {
      rowNo: idx + 1,
      postingDate: row.postingDate,
      transNo: row.transNo,
      origin: row.origin,
      originNo: row.originNo,
      offsetAccount: row.offsetAccount,
      details: row.details,
      cdLC: row.cdLC,
      cumulativeBalance: row.cumulativeBalance,
      debit: row.debit,
      credit: row.credit,
      blanketAgreement: row.blanketAgreement,
      keyExtracted: primaryKey,
      uniqueKey,
      reconStatus: 'Pending' as string,
      isReversal: reversal.isReversal,
      reversalPartnerTransNo: reversal.partnerTransNo,
      _allKeys: keys,
    } as GLTransaction & { _allKeys: string[] };
  });

  // Step 3: Find reversal pairs using multi-strategy matching
  // Reversals and their originals often have DIFFERENT transNo values,
  // so we need to match them by:
  //   1. Cheque number (same chq# in both reversal and original)
  //   2. Payment number ("Reverse Entry for Payment No. XXXXX" â†’ find by originNo=XXXXX)
  //   3. Same absolute cdLC amount with opposite sign
  //   4. Same transNo (fallback for rare cases where they share transNo)

  const usedOriginals = new Set<number>(); // Track which originals are already paired
  const usedReversals = new Set<number>(); // Track which reversals are already paired

  // Strategy A: Match by cheque number â€” reversal has Chq#XXX(Reversal), original has Chq#XXX
  // Use ARRAY per cheque number (not single entry) to handle multiple entries with same chq#
  const reversalByChqNo = new Map<string, typeof glTransactionsRaw[]>();
  for (const gl of glTransactionsRaw) {
    if (gl.isReversal && gl.reconStatus === 'Pending') {
      const chqNo = extractChequeNo(gl.details);
      if (chqNo) {
        if (!reversalByChqNo.has(chqNo)) reversalByChqNo.set(chqNo, []);
        reversalByChqNo.get(chqNo)!.push(gl);
      }
    }
  }

  for (const gl of glTransactionsRaw) {
    if (!gl.isReversal && gl.reconStatus === 'Pending' && !usedOriginals.has(gl.rowNo)) {
      const chqNo = extractChequeNo(gl.details);
      if (chqNo && reversalByChqNo.has(chqNo)) {
        const revCandidates = reversalByChqNo.get(chqNo)!;
        // Find the first unused reversal with same absolute amount and opposite direction
        for (const revEntry of revCandidates) {
          if (usedReversals.has(revEntry.rowNo)) continue;
          if (Math.abs(gl.cdLC) === Math.abs(revEntry.cdLC) && gl.cdLC !== revEntry.cdLC) {
            gl.reconStatus = 'Reversal â€” Excluded';
            revEntry.reconStatus = 'Reversal â€” Excluded';
            usedOriginals.add(gl.rowNo);
            usedReversals.add(revEntry.rowNo);
            // Bidirectional partner tracking
            gl.reversalPartnerTransNo = revEntry.transNo;
            revEntry.reversalPartnerTransNo = gl.transNo;
            break;
          }
        }
      }
    }
  }

  // Strategy B: Match "Reverse Entry for Payment No. XXXXX" by originNo field
  const paymentNoPattern = /Reverse Entry for Payment No\.\s*(\d+)/i;
  for (const gl of glTransactionsRaw) {
    if (gl.isReversal && gl.reconStatus === 'Pending' && !usedReversals.has(gl.rowNo)) {
      const m = gl.details.match(paymentNoPattern);
      if (m) {
        const paymentNo = m[1];
        // Find the original entry with matching originNo
        for (const orig of glTransactionsRaw) {
          if (!orig.isReversal && orig.reconStatus === 'Pending' && !usedOriginals.has(orig.rowNo)) {
            if (orig.originNo === paymentNo && Math.abs(orig.cdLC) === Math.abs(gl.cdLC) && orig.cdLC !== gl.cdLC) {
              orig.reconStatus = 'Reversal â€” Excluded';
              gl.reconStatus = 'Reversal â€” Excluded';
              usedOriginals.add(orig.rowNo);
              usedReversals.add(gl.rowNo);
              // Bidirectional partner tracking
              orig.reversalPartnerTransNo = gl.transNo;
              gl.reversalPartnerTransNo = orig.transNo;
              break;
            }
          }
        }
      }
    }
  }

  // Strategy B2: Match reversal by partner Trans. No. referenced in Details
  // Examples: "Checks for Payment(Reversal) - 613705" â†’ find original with transNo=613705
  //           "FSA Haroon Qureshi # 12049 Chq#187659698(Reversal) - 611977" â†’ find original with transNo=611977
  // The detectReversal() function already extracted partnerTransNo from the "- XXXXX" pattern
  for (const gl of glTransactionsRaw) {
    if (gl.isReversal && gl.reconStatus === 'Pending' && !usedReversals.has(gl.rowNo) && gl.reversalPartnerTransNo) {
      const partnerTransNo = gl.reversalPartnerTransNo;
      // Find the original entry with matching transNo
      for (const orig of glTransactionsRaw) {
        if (!orig.isReversal && orig.reconStatus === 'Pending' && !usedOriginals.has(orig.rowNo)) {
          if (orig.transNo === partnerTransNo && Math.abs(orig.cdLC) === Math.abs(gl.cdLC) && orig.cdLC !== gl.cdLC) {
            orig.reconStatus = 'Reversal â€” Excluded';
            gl.reconStatus = 'Reversal â€” Excluded';
            usedOriginals.add(orig.rowNo);
            usedReversals.add(gl.rowNo);
            // Bidirectional partner tracking
            orig.reversalPartnerTransNo = gl.transNo;
            gl.reversalPartnerTransNo = orig.transNo;
            break;
          }
        }
      }
    }
  }

  // Strategy B3: Match reversal by same Origin No + opposite cdLC amount
  // Examples: Original row 441 (Origin No 31179, cdLC=-73998) and
  //           Reversal row 443 (Origin No 31179, cdLC=+73998)
  // Both the original and reversal share the same Origin No but have opposite cdLC values
  const reversalByOriginNo = new Map<string, typeof glTransactionsRaw[]>();
  for (const gl of glTransactionsRaw) {
    if (gl.isReversal && gl.reconStatus === 'Pending' && !usedReversals.has(gl.rowNo) && gl.originNo) {
      if (!reversalByOriginNo.has(gl.originNo)) reversalByOriginNo.set(gl.originNo, []);
      reversalByOriginNo.get(gl.originNo)!.push(gl);
    }
  }

  for (const gl of glTransactionsRaw) {
    if (!gl.isReversal && gl.reconStatus === 'Pending' && !usedOriginals.has(gl.rowNo) && gl.originNo) {
      const candidates = reversalByOriginNo.get(gl.originNo) || [];
      for (const revEntry of candidates) {
        if (usedReversals.has(revEntry.rowNo)) continue;
        if (Math.abs(gl.cdLC) === Math.abs(revEntry.cdLC) && gl.cdLC !== revEntry.cdLC) {
          gl.reconStatus = 'Reversal â€” Excluded';
          revEntry.reconStatus = 'Reversal â€” Excluded';
          usedOriginals.add(gl.rowNo);
          usedReversals.add(revEntry.rowNo);
          // Bidirectional partner tracking
          gl.reversalPartnerTransNo = revEntry.transNo;
          revEntry.reversalPartnerTransNo = gl.transNo;
          break;
        }
      }
    }
  }

  // Strategy C: Match by same transNo + opposite cdLC amount (original fallback)
  const transNoGroups = new Map<string, typeof glTransactionsRaw>();
  for (const txn of glTransactionsRaw) {
    const key = txn.transNo;
    if (!transNoGroups.has(key)) transNoGroups.set(key, []);
    transNoGroups.get(key)!.push(txn);
  }

  for (const [, txns] of transNoGroups) {
    const reversalEntries = txns.filter(t => t.isReversal && t.reconStatus === 'Pending' && !usedReversals.has(t.rowNo));
    const originalEntries = txns.filter(t => !t.isReversal && t.reconStatus === 'Pending' && !usedOriginals.has(t.rowNo));
    
    for (const rev of reversalEntries) {
      for (const orig of originalEntries) {
        if (orig.reconStatus === 'Pending' && !usedOriginals.has(orig.rowNo) && Math.abs(rev.cdLC) === Math.abs(orig.cdLC) && rev.cdLC !== orig.cdLC) {
          orig.reconStatus = 'Reversal â€” Excluded';
          rev.reconStatus = 'Reversal â€” Excluded';
          usedOriginals.add(orig.rowNo);
          usedReversals.add(rev.rowNo);
          // Bidirectional partner tracking
          orig.reversalPartnerTransNo = rev.transNo;
          rev.reversalPartnerTransNo = orig.transNo;
          break;
        }
      }
    }
  }

  // Strategy D: REMOVED â€” Global opposite cdLC amount matching was too aggressive and
  // incorrectly paired unrelated entries (e.g., Trans No 610021 originals with 609702 reversals
  // just because they happened to have the same amounts). Only genuine reversals detected by
  // cheque number, payment number, or same transNo should be paired.

  // Mark any remaining unpaired reversal entries as excluded (they cancel out in reconciliation)
  // But only include them in reversalEntries if they have a paired partner.
  // Unpaired reversals (no original found) are excluded from matching but NOT shown in the reversal sheet
  // to avoid confusion â€” they will appear as regular GL entries instead.
  for (const gl of glTransactionsRaw) {
    if (gl.isReversal && gl.reconStatus === 'Pending') {
      // Unpaired reversal â€” don't mark as excluded, leave as Pending so it goes through normal matching
      // This prevents orphan reversal entries from appearing in the reversal tab
    }
  }

  // Collect only properly PAIRED reversal entries (both the reversal AND its matched original)
  const reversalEntries: GLTransaction[] = [];
  for (const gl of glTransactionsRaw) {
    if (gl.reconStatus === 'Reversal â€” Excluded') {
      const { _allKeys, ...rest } = gl;
      reversalEntries.push(rest);
    }
  }

  // Clean up temp fields and create final GL transactions
  const glTransactions: GLTransaction[] = glTransactionsRaw.map(t => {
    const { _allKeys, ...rest } = t;
    return rest;
  });
  
  const bsTransactionsClean: BSTransaction[] = bsTransactions.map(t => {
    const { _allKeys, ...rest } = t;
    return rest;
  });

  // Step 3.5: Detect BS internal reversals
  // When a cheque is returned (e.g., "Return of Outward Clearing Chq#6324773"),
  // BS shows TWO entries for the same cheque â€” one debit and one credit with the same amount.
  // These are internal BS reversals that cancel each other out.
  // One side is a reversal within BS, and the other side matches with GL.
  //
  // CRITICAL: Which entry to exclude depends on the GL direction:
  //   - If GL has a CREDIT for this cheque â†’ BS debit matches GL credit â†’ mark BS credit as reversal
  //   - If GL has a DEBIT for this cheque â†’ BS credit matches GL debit â†’ mark BS debit as reversal
  //   - If GL has BOTH credit and debit â†’ neither should be excluded (both will match their own GL entry)
  //   - If GL has NEITHER â†’ both are internal reversals (default: mark credit as reversal)
  //
  // Example: "Return of Outward Clearing Chq#6324773 Cleared From Allied Bank Limited"
  //   BS Debit: 1,157,980 (original outward clearing â€” money went out)
  //   BS Credit: 1,157,980 (return of outward clearing â€” money came back)
  //   GL Debit: 1,157,980 (return receipt in GL â€” matches the BS credit)
  //   â†’ The BS debit is the reversal (it was returned), BS credit matches GL debit
  //
  // Strategy: Group BS entries by cheque number. For each group with both debit and credit
  // entries of the same amount, check GL direction to determine which BS entry to exclude.
  // If there are multiple debit+credit pairs with the same chq#, pair them in order.

  // Group BS entries by cheque number
  const bsByChequeNo = new Map<string, BSTransaction[]>();
  for (const bs of bsTransactionsClean) {
    if (bs.reconStatus !== 'Pending') continue;
    const chqNo = extractChequeNo(bs.particulars);
    if (chqNo) {
      if (!bsByChequeNo.has(chqNo)) bsByChequeNo.set(chqNo, []);
      bsByChequeNo.get(chqNo)!.push(bs);
    }
  }

  // For each cheque number group, find debit+credit pairs with same amount
  // Determine which entry to exclude based on GL direction
  // BS internal reversals: When a BS entry has BOTH debit and credit for the same cheque,
  // both entries are internal reversals that cancel each other out within BS.
  // BOTH the debit and credit entries must be marked as "BS Reversal â€” Excluded".
  // The net impact (debit - credit) is accounted for in the reconciliation formula.
  //
  // Example: "Return of Outward Clearing Chq#6324773 Cleared From Allied Bank Limited"
  //   BS Debit: 1,157,980 (original outward clearing â€” money went out)
  //   BS Credit: 1,157,980 (return of outward clearing â€” money came back)
  //   â†’ Both are BS reversals â€” they cancel internally. Neither appears in unrecorded.
  //   â†’ Net impact (debit - credit) is accounted for in the reconciliation statement.
  const bsReversalPairs: Array<{ debit: BSTransaction; credit: BSTransaction }> = [];
  for (const [chqNo, entries] of bsByChequeNo) {
    const debitEntries = entries.filter(e => e.debit && e.debit > 0 && e.reconStatus === 'Pending');
    const creditEntries = entries.filter(e => e.credit && e.credit > 0 && e.reconStatus === 'Pending');
    
    // Try to pair debit and credit entries with matching amounts
    const usedDebits = new Set<string>();
    const usedCredits = new Set<string>();
    
    for (const dr of debitEntries) {
      if (usedDebits.has(dr.uniqueKey)) continue;
      for (const cr of creditEntries) {
        if (usedCredits.has(cr.uniqueKey)) continue;
        // Match if same amount (debit amount === credit amount)
        if (dr.debit === cr.credit) {
          // Mark BOTH sides as BS Reversal â€” Excluded
          // These are internal BS reversals that cancel each other out
          bsReversalPairs.push({ debit: dr, credit: cr });
          usedDebits.add(dr.uniqueKey);
          usedCredits.add(cr.uniqueKey);
          
          dr.reconStatus = 'BS Reversal â€” Excluded';
          cr.reconStatus = 'BS Reversal â€” Excluded';
          break;
        }
      }
    }
  }

  // Also detect BS reversals by same description pattern (not just cheque number)
  // Group BS entries by normalized description (first 60 chars, lowercase)
  const bsByDesc = new Map<string, BSTransaction[]>();
  for (const bs of bsTransactionsClean) {
    if (bs.reconStatus !== 'Pending') continue;
    // Skip entries already grouped by cheque number
    const chqNo = extractChequeNo(bs.particulars);
    if (chqNo) continue; // Already handled above
    
    // Use a normalized key from the description
    const descKey = bs.particulars.substring(0, 60).toLowerCase().trim();
    if (descKey.length < 10) continue; // Too short to be meaningful
    if (!bsByDesc.has(descKey)) bsByDesc.set(descKey, []);
    bsByDesc.get(descKey)!.push(bs);
  }

  for (const [, entries] of bsByDesc) {
    const debitEntries = entries.filter(e => e.debit && e.debit > 0 && e.reconStatus === 'Pending');
    const creditEntries = entries.filter(e => e.credit && e.credit > 0 && e.reconStatus === 'Pending');
    
    const usedDebits = new Set<string>();
    const usedCredits = new Set<string>();
    
    for (const dr of debitEntries) {
      if (usedDebits.has(dr.uniqueKey)) continue;
      for (const cr of creditEntries) {
        if (usedCredits.has(cr.uniqueKey)) continue;
        if (dr.debit === cr.credit) {
          bsReversalPairs.push({ debit: dr, credit: cr });
          usedDebits.add(dr.uniqueKey);
          usedCredits.add(cr.uniqueKey);
          // Mark BOTH sides as BS Reversal â€” Excluded
          dr.reconStatus = 'BS Reversal â€” Excluded';
          cr.reconStatus = 'BS Reversal â€” Excluded';
          break;
        }
      }
    }
  }

  // Step 4: Auto-match BS â†” GL using multi-strategy approach
  const matchedPairs: MatchedPair[] = [];
  let matchId = 0;
  const matchedBSRows = new Set<number>();
  const matchedGLRows = new Set<number>();

  // Build GL lookup maps for efficient matching
  const glActiveByChequeNo = new Map<string, GLTransaction[]>();
  const glActiveByPSID = new Map<string, GLTransaction[]>();
  const glActiveByRefID = new Map<string, GLTransaction[]>();
  const glActiveByDescKey = new Map<string, GLTransaction[]>();
  const glActiveByAmount = new Map<number, GLTransaction[]>();
  const glActiveTransactions = glTransactions.filter(t => t.reconStatus === 'Pending');

  for (const gl of glActiveTransactions) {
    const chqNo = extractChequeNo(gl.details);
    if (chqNo) {
      if (!glActiveByChequeNo.has(chqNo)) glActiveByChequeNo.set(chqNo, []);
      glActiveByChequeNo.get(chqNo)!.push(gl);
    }
    
    const psid = extractPSID(gl.details);
    if (psid) {
      if (!glActiveByPSID.has(psid)) glActiveByPSID.set(psid, []);
      glActiveByPSID.get(psid)!.push(gl);
    }
    
    const refId = extractRefID(gl.details);
    if (refId) {
      if (!glActiveByRefID.has(refId)) glActiveByRefID.set(refId, []);
      glActiveByRefID.get(refId)!.push(gl);
    }
    
    const descKey = extractDescKey(gl.details);
    if (descKey) {
      const dk = descKey.substring(0, 40);
      if (!glActiveByDescKey.has(dk)) glActiveByDescKey.set(dk, []);
      glActiveByDescKey.get(dk)!.push(gl);
    }
    
    const glCreditAmt = gl.credit || 0;
    if (glCreditAmt > 0) {
      if (!glActiveByAmount.has(glCreditAmt)) glActiveByAmount.set(glCreditAmt, []);
      glActiveByAmount.get(glCreditAmt)!.push(gl);
    }
    const glDebitAmt = gl.debit || 0;
    if (glDebitAmt > 0) {
      if (!glActiveByAmount.has(glDebitAmt)) glActiveByAmount.set(glDebitAmt, []);
      glActiveByAmount.get(glDebitAmt)!.push(gl);
    }
  }

  /**
   * Try to match a BS transaction with a GL transaction
   */
  function findBestGLMatch(bs: BSTransaction): GLTransaction | null {
    if (bs.reconStatus !== 'Pending') return null;
    
    const isPayment = bs.debit !== null && bs.debit > 0;
    const bsAmount = bs.debit || bs.credit || 0;
    
    let bestMatch: GLTransaction | null = null;
    let bestScore = 0;
    
    // Strategy 1: Cheque number + exact amount match
    const bsChqNo = extractChequeNo(bs.particulars);
    if (bsChqNo) {
      const candidates = glActiveByChequeNo.get(bsChqNo) || [];
      for (const gl of candidates) {
        if (gl.reconStatus !== 'Pending' || matchedGLRows.has(gl.rowNo)) continue;
        // Standard direction ONLY: BS debit (payment) â†” GL credit, BS credit (receipt) â†” GL debit
        // Relaxed direction matches are NOT auto-matched; they appear in possible matches for manual review
        if (isPayment && bs.debit === gl.credit) {
          if (100 > bestScore) { bestMatch = gl; bestScore = 100; break; }
        } else if (!isPayment && bs.credit === gl.debit) {
          if (100 > bestScore) { bestMatch = gl; bestScore = 100; break; }
        }
      }
    }
    if (bestScore >= 100) return bestMatch;

    // Strategy 1b: Cheque number + exact amount match, SAME side (both Credit or both Debit).
    // Some bank statement exports record cheque payments under Credit on both BS and GL
    // instead of the usual opposite-side convention. Cheque number + exact amount is strong
    // enough evidence to auto-match even when the side doesn't follow the standard direction.
    if (bsChqNo) {
      const candidates = glActiveByChequeNo.get(bsChqNo) || [];
      for (const gl of candidates) {
        if (gl.reconStatus !== 'Pending' || matchedGLRows.has(gl.rowNo)) continue;
        const sameSideMatch = (bs.credit !== null && bs.credit === gl.credit) || (bs.debit !== null && bs.debit === gl.debit);
        if (sameSideMatch) {
          if (97 > bestScore) { bestMatch = gl; bestScore = 97; break; }
        }
      }
    }
    if (bestScore >= 97) return bestMatch;

    // Strategy 2: PSID match + amount
    const bsPSID = extractPSID(bs.particulars);
    if (bsPSID) {
      const candidates = glActiveByPSID.get(bsPSID) || [];
      for (const gl of candidates) {
        if (gl.reconStatus !== 'Pending' || matchedGLRows.has(gl.rowNo)) continue;
        if (isPayment && bs.debit === gl.credit) {
          if (98 > bestScore) { bestMatch = gl; bestScore = 98; break; }
        } else if (!isPayment && bs.credit === gl.debit) {
          if (98 > bestScore) { bestMatch = gl; bestScore = 98; break; }
        }
      }
    }
    if (bestScore >= 98) return bestMatch;
    
    // Strategy 3: Reference ID match
    const bsRefId = extractRefID(bs.particulars);
    if (bsRefId) {
      const candidates = glActiveByRefID.get(bsRefId) || [];
      for (const gl of candidates) {
        if (gl.reconStatus !== 'Pending' || matchedGLRows.has(gl.rowNo)) continue;
        if (isPayment && bs.debit === gl.credit) {
          if (96 > bestScore) { bestMatch = gl; bestScore = 96; break; }
        } else if (!isPayment && bs.credit === gl.debit) {
          if (96 > bestScore) { bestMatch = gl; bestScore = 96; break; }
        }
      }
    }
    if (bestScore >= 96) return bestMatch;

    // Strategy 4: Description key match + amount
    const bsDescKey = extractDescKey(bs.particulars);
    if (bsDescKey) {
      const dk = bsDescKey.substring(0, 40);
      const candidates = glActiveByDescKey.get(dk) || [];
      for (const gl of candidates) {
        if (gl.reconStatus !== 'Pending' || matchedGLRows.has(gl.rowNo)) continue;
        if (isPayment && bs.debit === gl.credit) {
          if (94 > bestScore) { bestMatch = gl; bestScore = 94; break; }
        } else if (!isPayment && bs.credit === gl.debit) {
          if (94 > bestScore) { bestMatch = gl; bestScore = 94; break; }
        }
      }
    }
    if (bestScore >= 94) return bestMatch;

    // Strategy 5: Cheque number with amount tolerance (Â±1)
    if (bsChqNo) {
      const candidates = glActiveByChequeNo.get(bsChqNo) || [];
      for (const gl of candidates) {
        if (gl.reconStatus !== 'Pending' || matchedGLRows.has(gl.rowNo)) continue;
        const glAmt = isPayment ? (gl.credit || 0) : (gl.debit || 0);
        const glAltAmt = isPayment ? (gl.debit || 0) : (gl.credit || 0);
        if (Math.abs(bsAmount - glAmt) <= 1) {
          if (90 > bestScore) { bestMatch = gl; bestScore = 90; break; }
        } else if (glAltAmt > 0 && Math.abs(bsAmount - glAltAmt) <= 1) {
          if (88 > bestScore) { bestMatch = gl; bestScore = 88; break; }
        }
      }
    }
    if (bestScore >= 90) return bestMatch;

    // Strategy 6: Cross-reference matching (relaxed direction)
    if (!bestMatch && bsChqNo) {
      for (const gl of glActiveTransactions) {
        if (gl.reconStatus !== 'Pending' || matchedGLRows.has(gl.rowNo)) continue;
        const glChqNo = extractChequeNo(gl.details);
        if (glChqNo && chequeKeysMatch(bsChqNo, glChqNo)) {
          // Standard direction ONLY (no relaxed direction in auto-match)
          if (isPayment && bs.debit === gl.credit) {
            if (92 > bestScore) { bestMatch = gl; bestScore = 92; break; }
          } else if (!isPayment && bs.credit === gl.debit) {
            if (92 > bestScore) { bestMatch = gl; bestScore = 92; break; }
          }
        }
      }
    }
    if (bestScore >= 90) return bestMatch;

    // Strategy 7: Same reference ID found in GL details text
    if (!bestMatch && bsRefId) {
      for (const gl of glActiveTransactions) {
        if (gl.reconStatus !== 'Pending' || matchedGLRows.has(gl.rowNo)) continue;
        if (gl.details.includes(bsRefId)) {
          if (isPayment && bs.debit === gl.credit) {
            if (88 > bestScore) { bestMatch = gl; bestScore = 88; break; }
          } else if (!isPayment && bs.credit === gl.debit) {
            if (88 > bestScore) { bestMatch = gl; bestScore = 88; break; }
          }
        }
      }
    }
    if (bestScore >= 85) return bestMatch;

    return bestMatch;
  }

  // Run matching - pass 1: exact matches
  for (const bs of bsTransactionsClean) {
    if (bs.reconStatus !== 'Pending') continue;
    
    const glMatch = findBestGLMatch(bs);
    if (glMatch) {
      matchId++;
      const matchType: 'Payment' | 'Receipt' = bs.debit ? 'Payment' : 'Receipt';
      
      matchedPairs.push({
        id: matchId,
        type: matchType,
        bsDate: bs.date,
        bsParticulars: bs.particulars,
        glDetails: glMatch.details,
        uniqueKey: bs.uniqueKey,
        bsDebit: bs.debit,
        bsCredit: bs.credit,
        glDebit: glMatch.debit,
        glCredit: glMatch.credit,
        bsRowNo: bs.rowNo,
        glRowNo: glMatch.rowNo,
      });
      
      bs.reconStatus = 'Matched';
      bs.matchedWith = glMatch.uniqueKey;
      glMatch.reconStatus = 'Matched';
      glMatch.matchedWith = bs.uniqueKey;
      
      matchedBSRows.add(bs.rowNo);
      matchedGLRows.add(glMatch.rowNo);
    }
  }

  // Pass 2: Cross-reference cheque matching for entries missed in pass 1
  // This catches cases where cheque number extraction produces slightly different formats
  for (const bs of bsTransactionsClean) {
    if (bs.reconStatus !== 'Pending') continue;
    const isPayment = bs.debit !== null && bs.debit > 0;
    const bsChqNo = extractChequeNo(bs.particulars);
    if (!bsChqNo) continue; // Only try cheque-based matching in pass 2

    let bestMatch: GLTransaction | null = null;
    let bestScore = 0;

    for (const gl of glActiveTransactions) {
      if (gl.reconStatus !== 'Pending' || matchedGLRows.has(gl.rowNo)) continue;
      const glChqNo = extractChequeNo(gl.details);
      if (!glChqNo || !chequeKeysMatch(bsChqNo, glChqNo)) continue;

      // Standard direction (BS debit ↔ GL credit, BS credit ↔ GL debit)
      if (isPayment && bs.debit === gl.credit) {
        if (99 > bestScore) { bestMatch = gl; bestScore = 99; }
      } else if (!isPayment && bs.credit === gl.debit) {
        if (99 > bestScore) { bestMatch = gl; bestScore = 99; }
      } else {
        // Same-side match: cheque number matches and amount matches exactly on the same
        // column (both Credit or both Debit) — some statement exports use this convention.
        const sameSideMatch = (bs.credit !== null && bs.credit === gl.credit) || (bs.debit !== null && bs.debit === gl.debit);
        if (sameSideMatch && 97 > bestScore) { bestMatch = gl; bestScore = 97; }
      }
    }

    if (bestMatch) {
      matchId++;
      const matchType: 'Payment' | 'Receipt' = bs.debit ? 'Payment' : 'Receipt';
      matchedPairs.push({
        id: matchId,
        type: matchType,
        bsDate: bs.date,
        bsParticulars: bs.particulars,
        glDetails: bestMatch.details,
        uniqueKey: bs.uniqueKey,
        bsDebit: bs.debit,
        bsCredit: bs.credit,
        glDebit: bestMatch.debit,
        glCredit: bestMatch.credit,
        bsRowNo: bs.rowNo,
        glRowNo: bestMatch.rowNo,
      });
      bs.reconStatus = 'Matched';
      bs.matchedWith = bestMatch.uniqueKey;
      bestMatch.reconStatus = 'Matched';
      bestMatch.matchedWith = bs.uniqueKey;
      matchedBSRows.add(bs.rowNo);
      matchedGLRows.add(bestMatch.rowNo);
    }
  }

  // Step 5: Categorize unmatched transactions
  const unPresentedCheques: GLTransaction[] = [];
  const unClearedReceipts: GLTransaction[] = [];
  const unRecordedPayments: BSTransaction[] = [];
  const unRecordedReceipts: BSTransaction[] = [];

  for (const gl of glTransactions) {
    if (gl.reconStatus === 'Reversal â€” Excluded') continue;
    if (gl.reconStatus === 'Pending') {
      if (gl.credit && gl.credit > 0) {
        gl.reconStatus = 'Un Presented Cheque';
        unPresentedCheques.push(gl);
      } else if (gl.debit && gl.debit > 0) {
        gl.reconStatus = 'Un Cleared Receipt';
        unClearedReceipts.push(gl);
      }
    }
  }

  for (const bs of bsTransactionsClean) {
    if (bs.reconStatus === 'Pending') {
      if (bs.debit && bs.debit > 0) {
        bs.reconStatus = 'Un Recorded Payment';
        unRecordedPayments.push(bs);
      } else if (bs.credit && bs.credit > 0) {
        bs.reconStatus = 'Un Recorded Receipt';
        unRecordedReceipts.push(bs);
      }
    }
  }

  // Collect BS reversal entries (for display in the Reversals tab)
  const bsReversalEntries: BSTransaction[] = [];
  for (const bs of bsTransactionsClean) {
    if (bs.reconStatus === 'BS Reversal â€” Excluded') {
      bsReversalEntries.push(bs);
    }
  }

  // Step 6: Calculate possible matches
  // Includes both standard direction (BS Dr â†” GL Cr, BS Cr â†” GL Dr) and
  // cross-direction matches (BS Dr â†” GL Dr, BS Cr â†” GL Cr) for cases like
  // returned outward clearing where BS credit matches GL debit.
  const possibleMatches: PossibleMatch[] = [];
  let pmId = 0;

  const unmatchedBS = [...unRecordedPayments, ...unRecordedReceipts];
  const unmatchedGL = [...unPresentedCheques, ...unClearedReceipts];

  for (const bs of unmatchedBS) {
    const isPayment = bs.debit !== null && bs.debit > 0;
    const bsAmount = bs.debit || bs.credit || 0;
    const bsChqNo = extractChequeNo(bs.particulars);
    const bsRefId = extractRefID(bs.particulars);

    for (const gl of unmatchedGL) {
      // Check standard direction: BS debit â†” GL credit; BS credit â†” GL debit
      const stdGlAmt = isPayment ? (gl.credit || 0) : (gl.debit || 0);
      // Check cross direction: BS debit â†” GL debit; BS credit â†” GL credit
      const crossGlAmt = isPayment ? (gl.debit || 0) : (gl.credit || 0);

      let confidence = 0;
      const reasons: string[] = [];
      let isStandardDirection = true;

      // Determine which direction to use
      let glAmt: number;
      if (stdGlAmt > 0) {
        glAmt = stdGlAmt;
        isStandardDirection = true;
      } else if (crossGlAmt > 0) {
        glAmt = crossGlAmt;
        isStandardDirection = false;
      } else {
        continue; // No amount in either direction
      }

      // Exact amount match
      if (bsAmount === glAmt) {
        confidence += isStandardDirection ? 40 : 35;
        reasons.push(`Same amount PKR ${formatPKRInline(bsAmount)}`);
      } else if (glAmt > 0 && Math.abs(bsAmount - glAmt) / glAmt <= 0.05) {
        // Amount within 5%
        confidence += isStandardDirection ? 25 : 20;
        reasons.push(`Similar amount PKR ${formatPKRInline(bsAmount)} â‰ˆ PKR ${formatPKRInline(glAmt)}`);
      }

      // Cheque number match
      const glChqNo = extractChequeNo(gl.details);
      if (bsChqNo && glChqNo && chequeKeysMatch(bsChqNo, glChqNo)) {
        confidence += isStandardDirection ? 30 : 25;
        reasons.push(`Cheque #${bsChqNo} match`);
      }

      // Reference ID match
      const glRefId = extractRefID(gl.details);
      if (bsRefId && glRefId && bsRefId === glRefId) {
        confidence += isStandardDirection ? 25 : 20;
        reasons.push(`Ref ID ${bsRefId} match`);
      } else if (bsRefId && gl.details.includes(bsRefId)) {
        confidence += isStandardDirection ? 25 : 20;
        reasons.push(`Ref ID found in GL details`);
      }

      // Description similarity
      const sim = stringSimilarity(bs.particulars, gl.details);
      if (sim > 0.5) {
        confidence += isStandardDirection ? 20 : 15;
        reasons.push(`Similar description (${Math.round(sim * 100)}%)`);
      } else if (sim > 0.3) {
        confidence += isStandardDirection ? 10 : 5;
        reasons.push(`Partial description match (${Math.round(sim * 100)}%)`);
      }

      // Add direction note for cross-direction matches
      if (!isStandardDirection) {
        reasons.push('Cross-direction match');
      }

      // Only include matches with confidence >= 30 (lowered to include cross-direction)
      if (confidence >= 30) {
        pmId++;
        const bsCategory: 'unRecordedPayment' | 'unRecordedReceipt' = bs.debit ? 'unRecordedPayment' : 'unRecordedReceipt';
        const glCategory: 'unPresentedCheque' | 'unClearedReceipt' = (gl.credit && gl.credit > 0) ? 'unPresentedCheque' : 'unClearedReceipt';
        
        possibleMatches.push({
          id: pmId,
          bsTransaction: bs,
          glTransaction: gl,
          confidence: Math.min(confidence, 100),
          matchReason: reasons.join('; '),
          bsCategory,
          glCategory,
        });
      }
    }
  }

  // Sort by confidence descending
  possibleMatches.sort((a, b) => b.confidence - a.confidence);
  // Re-number after sort
  possibleMatches.forEach((pm, i) => { pm.id = i + 1; });

  // Step 6.5: Auto-Match High Confidence Possible Matches
  const finalPossibleMatches: PossibleMatch[] = [];
  for (const pm of possibleMatches) {
    if (pm.confidence >= autoMatchThreshold) {
      const bs = bsTransactionsClean.find(t => t.uniqueKey === pm.bsTransaction.uniqueKey);
      const gl = glTransactions.find(t => t.uniqueKey === pm.glTransaction.uniqueKey);
      
      if (bs && gl && bs.reconStatus !== 'Matched' && gl.reconStatus !== 'Matched') {
        matchId++;
        const matchType = bs.debit ? 'Payment' : 'Receipt';
        matchedPairs.push({
          id: matchId,
          type: matchType,
          bsDate: bs.date,
          bsParticulars: bs.particulars,
          glDetails: gl.details,
          uniqueKey: bs.uniqueKey,
          bsDebit: bs.debit,
          bsCredit: bs.credit,
          glDebit: gl.debit,
          glCredit: gl.credit,
          bsRowNo: bs.rowNo,
          glRowNo: gl.rowNo,
        });
        bs.reconStatus = 'Matched';
        bs.matchedWith = gl.uniqueKey;
        gl.reconStatus = 'Matched';
        gl.matchedWith = bs.uniqueKey;
      }
    } else {
      const bs = bsTransactionsClean.find(t => t.uniqueKey === pm.bsTransaction.uniqueKey);
      const gl = glTransactions.find(t => t.uniqueKey === pm.glTransaction.uniqueKey);
      if (bs && gl && bs.reconStatus !== 'Matched' && gl.reconStatus !== 'Matched') {
        finalPossibleMatches.push(pm);
      }
    }
  }
  
  // Re-number remaining possible matches
  finalPossibleMatches.forEach((pm, i) => { pm.id = i + 1; });

  // Step 7: Calculate summary
  const glBalance = glTransactions.length > 0 
    ? glTransactions[glTransactions.length - 1].cumulativeBalance || 0
    : 0;
  
  const bsBalance = bsTransactionsClean.length > 0
    ? bsTransactionsClean[bsTransactionsClean.length - 1].balance || 0
    : 0;

  const totalUnPresentedCheques = unPresentedCheques.filter(t => t.reconStatus !== 'Matched').reduce((sum, t) => sum + (t.credit || 0), 0);
  const totalUnClearedReceipts = unClearedReceipts.filter(t => t.reconStatus !== 'Matched').reduce((sum, t) => sum + (t.debit || 0), 0);
  const totalUnRecordedPayments = unRecordedPayments.filter(t => t.reconStatus !== 'Matched').reduce((sum, t) => sum + (t.debit || 0), 0);
  const totalUnRecordedReceipts = unRecordedReceipts.filter(t => t.reconStatus !== 'Matched').reduce((sum, t) => sum + (t.credit || 0), 0);

  const paymentMatches = matchedPairs.filter(p => p.type === 'Payment');
  const receiptMatches = matchedPairs.filter(p => p.type === 'Receipt');
  
  const totalBSDebitMatched = paymentMatches.reduce((sum, p) => sum + (p.bsDebit || 0), 0);
  const totalBSCreditMatched = receiptMatches.reduce((sum, p) => sum + (p.bsCredit || 0), 0);
  const totalGLCreditMatched = paymentMatches.reduce((sum, p) => sum + (p.glCredit || 0), 0);
  const totalGLDebitMatched = receiptMatches.reduce((sum, p) => sum + (p.glDebit || 0), 0);

  // BS Reversal summary â€” must compute BEFORE adjustedGLBalance
  const bsReversalTotalDebit = bsReversalEntries.reduce((s, t) => s + (t.debit || 0), 0);
  const bsReversalTotalCredit = bsReversalEntries.reduce((s, t) => s + (t.credit || 0), 0);
  const bsReversalNet = bsReversalTotalDebit - bsReversalTotalCredit;

  // BS Reversal Net is subtracted because both sides of reversal pairs are excluded from matching,
  // but the BS balance still includes these entries. Their net debit impact (debit - credit)
  // reduces the adjusted GL balance to properly reconcile with BS.
  const adjustedGLBalance = glBalance + totalUnPresentedCheques - totalUnClearedReceipts - totalUnRecordedPayments + totalUnRecordedReceipts - bsReversalNet;
  const difference = adjustedGLBalance - bsBalance;

  // Compute Balance In GL and Balance In BS from transaction totals
  // Balance In GL = Opening Balance + Debit - Credit (debit increases, credit decreases balance)
  // Balance In BS = Opening Balance - Debit + Credit (debit decreases, credit increases balance)
  // Opening balance is ZERO â€” reconciliation starts from zero for both GL and BS
  const glTotalDebit = glTransactions.reduce((s, t) => s + (t.debit || 0), 0);
  const glTotalCredit = glTransactions.reduce((s, t) => s + (t.credit || 0), 0);
  const glOpeningBalance = 0; // Opening balance is zero for reconciliation
  const glComputedBalance = glOpeningBalance + glTotalDebit - glTotalCredit;

  const bsTotalDebit = bsTransactionsClean.reduce((s, t) => s + (t.debit || 0), 0);
  const bsTotalCredit = bsTransactionsClean.reduce((s, t) => s + (t.credit || 0), 0);
  const bsOpeningBalance = 0; // Opening balance is zero for reconciliation
  const bsComputedBalance = bsOpeningBalance - bsTotalDebit + bsTotalCredit;

  // ============================
  // GAP AUDIT â€” Break down why the gap exists
  // ============================
  const gapAuditItems: GapAuditItem[] = [];

  // 1. Reversal Net Impact
  // Reversal entries are excluded from matching but they affect the GL cumulative balance.
  // Their net effect (debit - credit) is embedded in GL Balance but not separately adjusted.
  const reversalDebitTotal = reversalEntries.reduce((s, t) => s + (t.debit || 0), 0);
  const reversalCreditTotal = reversalEntries.reduce((s, t) => s + (t.credit || 0), 0);
  const reversalNetImpact = reversalDebitTotal - reversalCreditTotal;
  gapAuditItems.push({
    source: 'reversal_net',
    label: 'Reversal Entries Net Impact',
    amount: reversalNetImpact,
    description: `Reversal entries are excluded from reconciliation matching but affect the GL cumulative balance. Net Debit: ${formatPKRInline(reversalDebitTotal)}, Net Credit: ${formatPKRInline(reversalCreditTotal)}. This net impact is embedded in GL Balance but not adjusted for in the reconciliation formula.`,
    entries: reversalEntries.map(e => ({ transNo: e.transNo, details: e.details, debit: e.debit, credit: e.credit })),
  });

  // 2. Matched Pair Amount Differences
  // If BS debit != GL credit in a payment match, or BS credit != GL debit in a receipt match,
  // the difference contributes to the gap.
  let totalMatchedAmountDiff = 0;
  const matchedDiffEntries: GapAuditItem['entries'] = [];
  for (const pair of matchedPairs) {
    if (pair.type === 'Payment') {
      const diff = (pair.bsDebit || 0) - (pair.glCredit || 0);
      if (diff !== 0) {
        totalMatchedAmountDiff += diff;
        matchedDiffEntries.push({
          particulars: pair.bsParticulars,
          details: pair.glDetails,
          debit: pair.bsDebit,
          credit: pair.glCredit,
        });
      }
    } else {
      const diff = (pair.bsCredit || 0) - (pair.glDebit || 0);
      if (diff !== 0) {
        totalMatchedAmountDiff += diff;
        matchedDiffEntries.push({
          particulars: pair.bsParticulars,
          details: pair.glDetails,
          debit: pair.bsCredit,
          credit: pair.glDebit,
        });
      }
    }
  }
  gapAuditItems.push({
    source: 'matched_amount_diff',
    label: 'Matched Pair Amount Differences',
    amount: totalMatchedAmountDiff,
    description: totalMatchedAmountDiff === 0
      ? 'All matched pairs have exact BS â†” GL amount correspondence. No amount mismatch found.'
      : `Some matched pairs have BS amounts that differ from GL amounts. Total mismatch: PKR ${formatPKRInline(Math.abs(totalMatchedAmountDiff))}. This means the matching engine paired entries with different amounts.`,
    entries: matchedDiffEntries,
  });

  // 3. BS Unaccounted Entries
  // BS entries with status still "Pending" that are NOT in unRecordedPayments/unRecordedReceipts
  // These entries are in the BS balance but not accounted for in any category
  const accountedBSKeys = new Set([
    ...matchedPairs.map(p => `${p.bsRowNo}`),
    ...unRecordedPayments.map(t => t.uniqueKey),
    ...unRecordedReceipts.map(t => t.uniqueKey),
  ]);
  const bsUnaccounted = bsTransactionsClean.filter(t =>
    !accountedBSKeys.has(t.uniqueKey) && t.reconStatus === 'Matched' === false && t.reconStatus !== 'Matched'
  );
  // Actually, simpler: any BS entry not matched and not in unrecorded categories
  const bsAllAccounted = new Set<string>();
  for (const mp of matchedPairs) { bsAllAccounted.add(`${mp.bsRowNo}`); }
  for (const urp of unRecordedPayments) { bsAllAccounted.add(urp.uniqueKey); }
  for (const urr of unRecordedReceipts) { bsAllAccounted.add(urr.uniqueKey); }
  for (const bsr of bsReversalEntries) { bsAllAccounted.add(bsr.uniqueKey); }
  const bsUnaccountedEntries = bsTransactionsClean.filter(t => !bsAllAccounted.has(t.uniqueKey) && !bsAllAccounted.has(String(t.rowNo)));
  const bsUnaccountedNet = bsUnaccountedEntries.reduce((s, t) => s + (t.debit || 0) - (t.credit || 0), 0);
  gapAuditItems.push({
    source: 'bs_unaccounted',
    label: 'BS Entries Not in Any Category',
    amount: bsUnaccountedNet,
    description: bsUnaccountedEntries.length === 0
      ? 'All bank statement entries are accounted for (either matched or categorized as unrecorded).'
      : `${bsUnaccountedEntries.length} bank statement entries are neither matched nor categorized as unrecorded payments/receipts. Net impact on gap: PKR ${formatPKRInline(Math.abs(bsUnaccountedNet))}.`,
    entries: bsUnaccountedEntries.map(e => ({ particulars: e.particulars, debit: e.debit, credit: e.credit })),
  });

  // 4. GL Unaccounted Entries
  // GL entries not matched, not in unpresented/uncleared, and not reversal
  const glAllAccounted = new Set<string>();
  for (const mp of matchedPairs) { glAllAccounted.add(`${mp.glRowNo}`); }
  for (const upc of unPresentedCheques) { glAllAccounted.add(upc.uniqueKey); }
  for (const ucr of unClearedReceipts) { glAllAccounted.add(ucr.uniqueKey); }
  for (const rev of reversalEntries) { glAllAccounted.add(rev.uniqueKey); }
  const glUnaccountedEntries = glTransactions.filter(t => !glAllAccounted.has(t.uniqueKey) && !glAllAccounted.has(String(t.rowNo)));
  const glUnaccountedNet = glUnaccountedEntries.reduce((s, t) => s + (t.debit || 0) - (t.credit || 0), 0);
  gapAuditItems.push({
    source: 'gl_unaccounted',
    label: 'GL Entries Not in Any Category',
    amount: glUnaccountedNet,
    description: glUnaccountedEntries.length === 0
      ? 'All GL entries are accounted for (matched, categorized, or reversal).'
      : `${glUnaccountedEntries.length} GL entries are neither matched, nor categorized as unpresented/uncleared, nor marked as reversal. Net impact: PKR ${formatPKRInline(Math.abs(glUnaccountedNet))}.`,
    entries: glUnaccountedEntries.map(e => ({ transNo: e.transNo, details: e.details, debit: e.debit, credit: e.credit })),
  });

  // 5. Mathematical Verification
  // The gap should equal: reversalNetImpact + matchedAmountDiff + bsUnaccountedNet + glUnaccountedNet + (any residual)
  const explainedGap = reversalNetImpact + totalMatchedAmountDiff + bsUnaccountedNet + glUnaccountedNet;
  const unexplainedGap = difference - explainedGap;
  gapAuditItems.push({
    source: 'calculation_check',
    label: 'Mathematical Verification',
    amount: unexplainedGap,
    description: unexplainedGap === 0
      ? `Gap fully explained: Reversal Net (${formatPKRInline(reversalNetImpact)}) + Matched Diff (${formatPKRInline(totalMatchedAmountDiff)}) + BS Unaccounted (${formatPKRInline(bsUnaccountedNet)}) + GL Unaccounted (${formatPKRInline(glUnaccountedNet)}) = PKR ${formatPKRInline(explainedGap)} = Gap amount.`
      : `Gap = PKR ${formatPKRInline(difference)}, but explained components sum to PKR ${formatPKRInline(explainedGap)}. Residual unexplained gap: PKR ${formatPKRInline(unexplainedGap)}. This may be due to cumulative balance computation differences or floating-point rounding.`,
  });

  const gapAudit: GapAudit = {
    gap: difference,
    items: gapAuditItems,
    reversalNetImpact,
    matchedAmountDiff: totalMatchedAmountDiff,
    bsUnaccountedNet,
    glUnaccountedNet,
    unexplainedGap,
  };

  return {
    summary: {
      glBalance,
      bsBalance,
      unPresentedCheques: { count: unPresentedCheques.length, total: totalUnPresentedCheques },
      unClearedReceipts: { count: unClearedReceipts.length, total: totalUnClearedReceipts },
      unRecordedPayments: { count: unRecordedPayments.length, total: totalUnRecordedPayments },
      unRecordedReceipts: { count: unRecordedReceipts.length, total: totalUnRecordedReceipts },
      matchedPairs: { count: matchedPairs.length, totalPayments: totalBSDebitMatched, totalReceipts: totalBSCreditMatched },
      bsReversals: { count: bsReversalEntries.length, totalDebit: bsReversalTotalDebit, totalCredit: bsReversalTotalCredit, netImpact: bsReversalNet },
      adjustedGLBalance,
      difference,
      glOpeningBalance,
      glTotalDebit,
      glTotalCredit,
      glComputedBalance,
      bsOpeningBalance,
      bsTotalDebit,
      bsTotalCredit,
      bsComputedBalance,
      totalBSDebitMatched,
      totalBSCreditMatched,
      totalGLDebitMatched,
      totalGLCreditMatched,
    },
    bsTransactions: bsTransactionsClean,
    glTransactions,
    matchedPairs,
    unPresentedCheques: unPresentedCheques.filter(t => t.reconStatus !== 'Matched'),
    unClearedReceipts: unClearedReceipts.filter(t => t.reconStatus !== 'Matched'),
    unRecordedPayments: unRecordedPayments.filter(t => t.reconStatus !== 'Matched'),
    unRecordedReceipts: unRecordedReceipts.filter(t => t.reconStatus !== 'Matched'),
    manualMatches: [],
    reversalEntries,
    bsReversalEntries,
    possibleMatches: finalPossibleMatches,
    gapAudit,
  };
}

function formatPKRInline(amount: number): string {
  return new Intl.NumberFormat('en-PK', { minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(amount);
}

/**
 * Deep clone a ReconciliationResult to avoid mutating React state
 */
function deepCloneResult(result: ReconciliationResult): ReconciliationResult {
  return JSON.parse(JSON.stringify(result));
}

/**
 * Apply manual match
 */
export function applyManualMatch(
  result: ReconciliationResult,
  bsUniqueKey: string,
  glUniqueKey: string,
  reason: string = 'Manual match by user'
): ReconciliationResult {
  // Deep clone to avoid mutating the original React state
  const cloned = deepCloneResult(result);
  
  const bs = cloned.bsTransactions.find(t => t.uniqueKey === bsUniqueKey);
  const gl = cloned.glTransactions.find(t => t.uniqueKey === glUniqueKey);
  
  if (!bs || !gl) return cloned;
  
  const matchType: 'Payment' | 'Receipt' = bs.debit ? 'Payment' : 'Receipt';
  const matchId = cloned.matchedPairs.length + 1;
  
  const newMatch: MatchedPair = {
    id: matchId,
    type: matchType,
    bsDate: bs.date,
    bsParticulars: bs.particulars,
    glDetails: gl.details,
    uniqueKey: `${bsUniqueKey}+${glUniqueKey}`,
    bsDebit: bs.debit,
    bsCredit: bs.credit,
    glDebit: gl.debit,
    glCredit: gl.credit,
    bsRowNo: bs.rowNo,
    glRowNo: gl.rowNo,
  };

  const manualMatch: ManualMatch = {
    id: `MM-${Date.now()}`,
    bsKey: bsUniqueKey,
    glKey: glUniqueKey,
    bsRowNo: bs.rowNo,
    glRowNo: gl.rowNo,
    type: matchType,
    bsParticulars: bs.particulars,
    glDetails: gl.details,
    bsAmount: bs.debit || bs.credit || 0,
    glAmount: gl.debit || gl.credit || 0,
    timestamp: new Date().toISOString(),
    reason,
  };
  
  bs.reconStatus = 'Matched';
  bs.matchedWith = glUniqueKey;
  gl.reconStatus = 'Matched';
  gl.matchedWith = bsUniqueKey;
  
  cloned.unPresentedCheques = cloned.unPresentedCheques.filter(t => t.uniqueKey !== glUniqueKey);
  cloned.unClearedReceipts = cloned.unClearedReceipts.filter(t => t.uniqueKey !== glUniqueKey);
  cloned.unRecordedPayments = cloned.unRecordedPayments.filter(t => t.uniqueKey !== bsUniqueKey);
  cloned.unRecordedReceipts = cloned.unRecordedReceipts.filter(t => t.uniqueKey !== bsUniqueKey);
  
  // Also update reconStatus in category arrays for consistency
  // (these entries were already filtered out above, but update for safety)
  for (const t of cloned.unRecordedPayments) {
    if (t.uniqueKey === bsUniqueKey) t.reconStatus = 'Matched';
  }
  for (const t of cloned.unRecordedReceipts) {
    if (t.uniqueKey === bsUniqueKey) t.reconStatus = 'Matched';
  }
  for (const t of cloned.unPresentedCheques) {
    if (t.uniqueKey === glUniqueKey) t.reconStatus = 'Matched';
  }
  for (const t of cloned.unClearedReceipts) {
    if (t.uniqueKey === glUniqueKey) t.reconStatus = 'Matched';
  }
  
  cloned.matchedPairs.push(newMatch);
  cloned.manualMatches.push(manualMatch);

  // Recalculate possible matches (some may be invalid now)
  recalculatePossibleMatches(cloned);
  
  recalculateSummary(cloned);
  return cloned;
}

/**
 * Apply one-to-many manual match
 * Matches ONE BS entry with MULTIPLE GL entries, or MULTIPLE BS entries with ONE GL entry
 * Each pair is created individually so all selected entries get matched
 */
export function applyOneToManyMatch(
  result: ReconciliationResult,
  bsUniqueKeys: string[],
  glUniqueKeys: string[],
  reason: string = 'Manual match by user'
): ReconciliationResult {
  // Deep clone to avoid mutating the original React state
  const cloned = deepCloneResult(result);

  // Build all possible pairs from the selected entries
  // If 1 BS + multiple GL: match that 1 BS with each GL
  // If multiple BS + 1 GL: match each BS with that 1 GL
  // If multiple BS + multiple GL: match pairwise (BS[0]â†”GL[0], BS[1]â†”GL[1], etc.)
  // plus any remaining unmatched entries
  const pairs: Array<{ bsKey: string; glKey: string }> = [];

  if (bsUniqueKeys.length === 1 && glUniqueKeys.length > 1) {
    // One BS â†’ Many GL
    for (const glKey of glUniqueKeys) {
      pairs.push({ bsKey: bsUniqueKeys[0], glKey });
    }
  } else if (glUniqueKeys.length === 1 && bsUniqueKeys.length > 1) {
    // Many BS â†’ One GL
    for (const bsKey of bsUniqueKeys) {
      pairs.push({ bsKey, glKey: glUniqueKeys[0] });
    }
  } else {
    // Pairwise matching (also handles 1:1)
    const count = Math.min(bsUniqueKeys.length, glUniqueKeys.length);
    for (let i = 0; i < count; i++) {
      pairs.push({ bsKey: bsUniqueKeys[i], glKey: glUniqueKeys[i] });
    }
  }

  const isOneToMany = bsUniqueKeys.length === 1 && glUniqueKeys.length > 1;
  const isManyToOne = glUniqueKeys.length === 1 && bsUniqueKeys.length > 1;

  let matchCount = 0;
  const matchedGLKeys = new Set<string>();

  for (const pair of pairs) {
    const bs = cloned.bsTransactions.find(t => t.uniqueKey === pair.bsKey);
    const gl = cloned.glTransactions.find(t => t.uniqueKey === pair.glKey);

    if (!bs || !gl) continue;

    // For one-to-many (1 BS â†’ many GL): allow BS to be re-used for multiple matches,
    // only check if GL is already matched
    // For many-to-one (many BS â†’ 1 GL): allow GL to be re-used for multiple matches,
    // only check if BS is already matched
    // For pairwise: check both sides
    if (isOneToMany) {
      if (gl.reconStatus === 'Matched' || matchedGLKeys.has(pair.glKey)) continue;
    } else if (isManyToOne) {
      if (bs.reconStatus === 'Matched') continue;
    } else {
      if (bs.reconStatus === 'Matched' || gl.reconStatus === 'Matched') continue;
    }

    const matchType: 'Payment' | 'Receipt' = bs.debit ? 'Payment' : 'Receipt';
    const matchId = cloned.matchedPairs.length + 1;

    const newMatch: MatchedPair = {
      id: matchId,
      type: matchType,
      bsDate: bs.date,
      bsParticulars: bs.particulars,
      glDetails: gl.details,
      uniqueKey: `${pair.bsKey}+${pair.glKey}`,
      bsDebit: bs.debit,
      bsCredit: bs.credit,
      glDebit: gl.debit,
      glCredit: gl.credit,
      bsRowNo: bs.rowNo,
      glRowNo: gl.rowNo,
    };

    const manualMatch: ManualMatch = {
      id: `MM-${Date.now()}-${matchCount}`,
      bsKey: pair.bsKey,
      glKey: pair.glKey,
      bsRowNo: bs.rowNo,
      glRowNo: gl.rowNo,
      type: matchType,
      bsParticulars: bs.particulars,
      glDetails: gl.details,
      bsAmount: bs.debit || bs.credit || 0,
      glAmount: gl.debit || gl.credit || 0,
      timestamp: new Date().toISOString(),
      reason,
    };

    // Mark GL entry as matched (for one-to-many, the BS is shared across pairs)
    gl.reconStatus = 'Matched';
    gl.matchedWith = pair.bsKey;
    matchedGLKeys.add(pair.glKey);

    // For one-to-many: set BS as matched on first pair, update matchedWith to list all GL keys
    // For other cases: mark both as matched
    if (isOneToMany) {
      if (!bs.reconStatus || bs.reconStatus === 'Pending' || bs.reconStatus.startsWith('Un')) {
        bs.reconStatus = 'Matched';
      }
      // Track all matched GL keys in matchedWith
      bs.matchedWith = Array.from(matchedGLKeys).join('+');
    } else {
      bs.reconStatus = 'Matched';
      bs.matchedWith = pair.glKey;
    }

    // Remove GL from unmatched lists
    cloned.unPresentedCheques = cloned.unPresentedCheques.filter(t => t.uniqueKey !== pair.glKey);
    cloned.unClearedReceipts = cloned.unClearedReceipts.filter(t => t.uniqueKey !== pair.glKey);
    // Remove BS from unmatched lists (only once, so filter each time â€” already-removed entries are no-ops)
    cloned.unRecordedPayments = cloned.unRecordedPayments.filter(t => t.uniqueKey !== pair.bsKey);
    cloned.unRecordedReceipts = cloned.unRecordedReceipts.filter(t => t.uniqueKey !== pair.bsKey);

    cloned.matchedPairs.push(newMatch);
    cloned.manualMatches.push(manualMatch);
    matchCount++;
  }

  if (matchCount > 0) {
    recalculatePossibleMatches(cloned);
    recalculateSummary(cloned);
  }

  return cloned;
}

/**
 * Mark same-side entries as reversals
 * When user selects debit AND credit entries from the same source (BS or GL),
 * they are reversal pairs that cancel each other out.
 * Supports:
 *   - GL debit + GL credit â†’ GL Reversal
 *   - BS debit + BS credit â†’ BS Reversal
 *   - Mixed selections are not allowed (must be same source)
 */
export function markAsManualReversal(
  result: ReconciliationResult,
  source: 'bs' | 'gl',
  uniqueKeys: string[],
  reason: string = 'Manual reversal by user'
): ReconciliationResult {
  // Deep clone to avoid mutating the original React state
  const cloned = deepCloneResult(result);

  if (source === 'gl') {
    const entries = uniqueKeys
      .map(key => cloned.glTransactions.find(t => t.uniqueKey === key))
      .filter((t): t is GLTransaction => t !== undefined && t.reconStatus !== 'Matched' && t.reconStatus !== 'Reversal â€” Excluded');

    if (entries.length < 2) return cloned;

    // Group into debit and credit entries
    const debitEntries = entries.filter(t => t.debit && t.debit > 0);
    const creditEntries = entries.filter(t => t.credit && t.credit > 0);

    // Pair debit entries with credit entries by amount (closest match first)
    const usedDebits = new Set<string>();
    const usedCredits = new Set<string>();
    const newReversalPairs: Array<{ debit: GLTransaction; credit: GLTransaction }> = [];

    for (const dr of debitEntries) {
      if (usedDebits.has(dr.uniqueKey)) continue;
      for (const cr of creditEntries) {
        if (usedCredits.has(cr.uniqueKey)) continue;
        // Match by same amount or closest amount
        if (dr.debit === cr.credit || Math.abs((dr.debit || 0) - (cr.credit || 0)) < 1) {
          newReversalPairs.push({ debit: dr, credit: cr });
          usedDebits.add(dr.uniqueKey);
          usedCredits.add(cr.uniqueKey);
          break;
        }
      }
    }

    // If no exact amount pairs found, pair in order (debit[0]â†”credit[0], etc.)
    if (newReversalPairs.length === 0 && debitEntries.length > 0 && creditEntries.length > 0) {
      const pairCount = Math.min(debitEntries.length, creditEntries.length);
      for (let i = 0; i < pairCount; i++) {
        newReversalPairs.push({ debit: debitEntries[i], credit: creditEntries[i] });
      }
    }

    // Mark all paired entries as reversals
    for (const pair of newReversalPairs) {
      pair.debit.reconStatus = 'Reversal â€” Excluded';
      pair.debit.isReversal = true;
      pair.debit.reversalPartnerTransNo = pair.credit.transNo;
      pair.debit.matchedWith = pair.credit.uniqueKey;

      pair.credit.reconStatus = 'Reversal â€” Excluded';
      pair.credit.isReversal = true;
      pair.credit.reversalPartnerTransNo = pair.debit.transNo;
      pair.credit.matchedWith = pair.debit.uniqueKey;

      // Add to reversal entries
      cloned.reversalEntries.push(pair.debit, pair.credit);

      // Remove from unprepresented/uncleared categories
      cloned.unPresentedCheques = cloned.unPresentedCheques.filter(
        t => t.uniqueKey !== pair.debit.uniqueKey && t.uniqueKey !== pair.credit.uniqueKey
      );
      cloned.unClearedReceipts = cloned.unClearedReceipts.filter(
        t => t.uniqueKey !== pair.debit.uniqueKey && t.uniqueKey !== pair.credit.uniqueKey
      );
    }

    // Also mark any remaining unpaired entries from the selection as reversals if all selected are from same group
    // (e.g., user selected 2 debit + 2 credit where only 1 pair exists by amount)
    for (const entry of entries) {
      if (entry.reconStatus !== 'Reversal â€” Excluded' && entry.reconStatus !== 'Matched') {
        // Check if this entry was in the selection but not paired
        // If there's no matching opposite entry, mark it individually if user selected both sides
        const hasPartner = newReversalPairs.some(
          p => p.debit.uniqueKey === entry.uniqueKey || p.credit.uniqueKey === entry.uniqueKey
        );
        if (!hasPartner && debitEntries.length > 0 && creditEntries.length > 0) {
          // Try to pair with next available opposite
          const opposite = entry.debit ? creditEntries.find(c => !usedCredits.has(c.uniqueKey)) : debitEntries.find(d => !usedDebits.has(d.uniqueKey));
          if (opposite) {
            entry.reconStatus = 'Reversal â€” Excluded';
            entry.isReversal = true;
            entry.reversalPartnerTransNo = opposite.transNo;
            opposite.reconStatus = 'Reversal â€” Excluded';
            opposite.isReversal = true;
            opposite.reversalPartnerTransNo = entry.transNo;
            cloned.reversalEntries.push(entry, opposite);
            if (entry.debit) usedDebits.add(entry.uniqueKey); else usedCredits.add(entry.uniqueKey);
            if (opposite.debit) usedDebits.add(opposite.uniqueKey); else usedCredits.add(opposite.uniqueKey);

            cloned.unPresentedCheques = cloned.unPresentedCheques.filter(
              t => t.uniqueKey !== entry.uniqueKey && t.uniqueKey !== opposite.uniqueKey
            );
            cloned.unClearedReceipts = cloned.unClearedReceipts.filter(
              t => t.uniqueKey !== entry.uniqueKey && t.uniqueKey !== opposite.uniqueKey
            );
          }
        }
      }
    }

  } else {
    // BS reversals
    const entries = uniqueKeys
      .map(key => cloned.bsTransactions.find(t => t.uniqueKey === key))
      .filter((t): t is BSTransaction => t !== undefined && t.reconStatus !== 'Matched' && t.reconStatus !== 'BS Reversal â€” Excluded');

    if (entries.length < 2) return cloned;

    const debitEntries = entries.filter(t => t.debit && t.debit > 0);
    const creditEntries = entries.filter(t => t.credit && t.credit > 0);

    const usedDebits = new Set<string>();
    const usedCredits = new Set<string>();

    for (const dr of debitEntries) {
      if (usedDebits.has(dr.uniqueKey)) continue;
      for (const cr of creditEntries) {
        if (usedCredits.has(cr.uniqueKey)) continue;
        if (dr.debit === cr.credit || Math.abs((dr.debit || 0) - (cr.credit || 0)) < 1) {
          dr.reconStatus = 'BS Reversal â€” Excluded';
          cr.reconStatus = 'BS Reversal â€” Excluded';
          dr.matchedWith = cr.uniqueKey;
          cr.matchedWith = dr.uniqueKey;
          cloned.bsReversalEntries.push(dr, cr);
          usedDebits.add(dr.uniqueKey);
          usedCredits.add(cr.uniqueKey);

          cloned.unRecordedPayments = cloned.unRecordedPayments.filter(
            t => t.uniqueKey !== dr.uniqueKey && t.uniqueKey !== cr.uniqueKey
          );
          cloned.unRecordedReceipts = cloned.unRecordedReceipts.filter(
            t => t.uniqueKey !== dr.uniqueKey && t.uniqueKey !== cr.uniqueKey
          );
          break;
        }
      }
    }

    // Fallback: pair in order if no exact amount matches
    const remainingDebits = debitEntries.filter(d => !usedDebits.has(d.uniqueKey));
    const remainingCredits = creditEntries.filter(c => !usedCredits.has(c.uniqueKey));
    const pairCount = Math.min(remainingDebits.length, remainingCredits.length);
    for (let i = 0; i < pairCount; i++) {
      remainingDebits[i].reconStatus = 'BS Reversal â€” Excluded';
      remainingCredits[i].reconStatus = 'BS Reversal â€” Excluded';
      remainingDebits[i].matchedWith = remainingCredits[i].uniqueKey;
      remainingCredits[i].matchedWith = remainingDebits[i].uniqueKey;
      cloned.bsReversalEntries.push(remainingDebits[i], remainingCredits[i]);
      usedDebits.add(remainingDebits[i].uniqueKey);
      usedCredits.add(remainingCredits[i].uniqueKey);

      cloned.unRecordedPayments = cloned.unRecordedPayments.filter(
        t => t.uniqueKey !== remainingDebits[i].uniqueKey && t.uniqueKey !== remainingCredits[i].uniqueKey
      );
      cloned.unRecordedReceipts = cloned.unRecordedReceipts.filter(
        t => t.uniqueKey !== remainingDebits[i].uniqueKey && t.uniqueKey !== remainingCredits[i].uniqueKey
      );
    }
  }

  recalculatePossibleMatches(cloned);
  recalculateSummary(cloned);
  return cloned;
}

/**
 * Unmatch a pair
 */
export function unmatchPair(
  result: ReconciliationResult,
  bsUniqueKey: string,
  glUniqueKey: string
): ReconciliationResult {
  // Deep clone to avoid mutating the original React state
  const cloned = deepCloneResult(result);
  
  const bs = cloned.bsTransactions.find(t => t.uniqueKey === bsUniqueKey);
  const gl = cloned.glTransactions.find(t => t.uniqueKey === glUniqueKey);
  
  if (!bs || !gl) return cloned;
  
  bs.reconStatus = 'Pending';
  bs.matchedWith = undefined;
  gl.reconStatus = 'Pending';
  gl.matchedWith = undefined;
  
  cloned.matchedPairs = cloned.matchedPairs.filter(p => 
    !(p.bsRowNo === bs.rowNo && p.glRowNo === gl.rowNo)
  );
  
  cloned.manualMatches = cloned.manualMatches.filter(m => 
    !(m.bsKey === bsUniqueKey && m.glKey === glUniqueKey)
  );
  
  if (gl.credit && gl.credit > 0) {
    gl.reconStatus = 'Un Presented Cheque';
    cloned.unPresentedCheques.push(gl);
  } else if (gl.debit && gl.debit > 0) {
    gl.reconStatus = 'Un Cleared Receipt';
    cloned.unClearedReceipts.push(gl);
  }
  
  if (bs.debit && bs.debit > 0) {
    bs.reconStatus = 'Un Recorded Payment';
    cloned.unRecordedPayments.push(bs);
  } else if (bs.credit && bs.credit > 0) {
    bs.reconStatus = 'Un Recorded Receipt';
    cloned.unRecordedReceipts.push(bs);
  }

  // Recalculate possible matches
  recalculatePossibleMatches(cloned);
  
  recalculateSummary(cloned);
  return cloned;
}

export function unmarkReversal(
  result: ReconciliationResult,
  source: 'bs' | 'gl',
  uniqueKey: string
): ReconciliationResult {
  const cloned = deepCloneResult(result);

  if (source === 'gl') {
    // Remove from reversal entries
    cloned.reversalEntries = cloned.reversalEntries.filter(t => t.uniqueKey !== uniqueKey);
    
    // Find in original transactions and reset
    const gl = cloned.glTransactions.find(t => t.uniqueKey === uniqueKey);
    if (gl) {
      gl.reconStatus = 'Pending';
      gl.isReversal = false;
      gl.reversalPartnerTransNo = undefined;
      
      // Categorize back into unmatched pools
      if (gl.credit && gl.credit > 0) {
        cloned.unPresentedCheques.push(gl);
      } else if (gl.debit && gl.debit > 0) {
        cloned.unClearedReceipts.push(gl);
      }
    }
  } else {
    // Remove from BS reversal entries
    cloned.bsReversalEntries = cloned.bsReversalEntries.filter(t => t.uniqueKey !== uniqueKey);
    
    // Find in original transactions and reset
    const bs = cloned.bsTransactions.find(t => t.uniqueKey === uniqueKey);
    if (bs) {
      bs.reconStatus = 'Pending';
      
      // Categorize back into unmatched pools
      if (bs.debit && bs.debit > 0) {
        cloned.unRecordedPayments.push(bs);
      } else if (bs.credit && bs.credit > 0) {
        cloned.unRecordedReceipts.push(bs);
      }
    }
  }

  // Recalculate summary totals
  recalculateSummary(cloned);

  return cloned;
}


/**
 * Recalculate possible matches after a manual match/unmatch
 */
export function recalculatePossibleMatches(result: ReconciliationResult) {
  const possibleMatches: PossibleMatch[] = [];
  let pmId = 0;
  
  const unmatchedBS = [...result.unRecordedPayments, ...result.unRecordedReceipts];
  const unmatchedGL = [...result.unPresentedCheques, ...result.unClearedReceipts];
  
  for (const bs of unmatchedBS) {
    const isPayment = bs.debit !== null && bs.debit > 0;
    const bsAmount = bs.debit || bs.credit || 0;
    const bsChqNo = extractChequeNo(bs.particulars);
    const bsRefId = extractRefID(bs.particulars);

    for (const gl of unmatchedGL) {
      // Check standard direction: BS debit â†” GL credit; BS credit â†” GL debit
      const stdGlAmt = isPayment ? (gl.credit || 0) : (gl.debit || 0);
      // Check cross direction: BS debit â†” GL debit; BS credit â†” GL credit
      const crossGlAmt = isPayment ? (gl.debit || 0) : (gl.credit || 0);

      let confidence = 0;
      const reasons: string[] = [];
      let isStandardDirection = true;

      // Determine which direction to use
      let glAmt: number;
      if (stdGlAmt > 0) {
        glAmt = stdGlAmt;
        isStandardDirection = true;
      } else if (crossGlAmt > 0) {
        glAmt = crossGlAmt;
        isStandardDirection = false;
      } else {
        continue;
      }

      // Exact amount match
      if (bsAmount === glAmt) {
        confidence += isStandardDirection ? 40 : 35;
        reasons.push(`Same amount PKR ${formatPKRInline(bsAmount)}`);
      } else if (glAmt > 0 && Math.abs(bsAmount - glAmt) / glAmt <= 0.05) {
        confidence += isStandardDirection ? 25 : 20;
        reasons.push(`Similar amount PKR ${formatPKRInline(bsAmount)} â‰ˆ PKR ${formatPKRInline(glAmt)}`);
      }

      // Cheque number match
      const glChqNo = extractChequeNo(gl.details);
      if (bsChqNo && glChqNo && chequeKeysMatch(bsChqNo, glChqNo)) {
        confidence += isStandardDirection ? 30 : 25;
        reasons.push(`Cheque #${bsChqNo} match`);
      }

      // Reference ID match
      const glRefId = extractRefID(gl.details);
      if (bsRefId && glRefId && bsRefId === glRefId) {
        confidence += isStandardDirection ? 25 : 20;
        reasons.push(`Ref ID ${bsRefId} match`);
      } else if (bsRefId && gl.details.includes(bsRefId)) {
        confidence += isStandardDirection ? 25 : 20;
        reasons.push(`Ref ID found in GL details`);
      }

      // Description similarity
      const sim = stringSimilarity(bs.particulars, gl.details);
      if (sim > 0.5) {
        confidence += isStandardDirection ? 20 : 15;
        reasons.push(`Similar description (${Math.round(sim * 100)}%)`);
      } else if (sim > 0.3) {
        confidence += isStandardDirection ? 10 : 5;
        reasons.push(`Partial description match (${Math.round(sim * 100)}%)`);
      }

      // Add direction note for cross-direction matches
      if (!isStandardDirection) {
        reasons.push('Cross-direction match');
      }

      // Only include matches with confidence >= 30
      if (confidence >= 30) {
        pmId++;
        const bsCategory: 'unRecordedPayment' | 'unRecordedReceipt' = bs.debit ? 'unRecordedPayment' : 'unRecordedReceipt';
        const glCategory: 'unPresentedCheque' | 'unClearedReceipt' = (gl.credit && gl.credit > 0) ? 'unPresentedCheque' : 'unClearedReceipt';
        
        possibleMatches.push({
          id: pmId,
          bsTransaction: bs,
          glTransaction: gl,
          confidence: Math.min(confidence, 100),
          matchReason: reasons.join('; '),
          bsCategory,
          glCategory,
        });
      }
    }
  }

  possibleMatches.sort((a, b) => b.confidence - a.confidence);
  possibleMatches.forEach((pm, i) => { pm.id = i + 1; });
  
  result.possibleMatches = possibleMatches;
}

export function recalculateSummary(result: ReconciliationResult) {
  const glBalance = result.summary.glBalance;
  const bsBalance = result.summary.bsBalance;

  const totalUnPresentedCheques = result.unPresentedCheques.reduce((sum, t) => sum + (t.credit || 0), 0);
  const totalUnClearedReceipts = result.unClearedReceipts.reduce((sum, t) => sum + (t.debit || 0), 0);
  const totalUnRecordedPayments = result.unRecordedPayments.reduce((sum, t) => sum + (t.debit || 0), 0);
  const totalUnRecordedReceipts = result.unRecordedReceipts.reduce((sum, t) => sum + (t.credit || 0), 0);

  const paymentMatches = result.matchedPairs.filter(p => p.type === 'Payment');
  const receiptMatches = result.matchedPairs.filter(p => p.type === 'Receipt');

  const uniquePaymentBS = Array.from(new Set(paymentMatches.map(p => p.bsRowNo))).map(rNo => paymentMatches.find(p => p.bsRowNo === rNo));
  const totalBSDebitMatched = uniquePaymentBS.reduce((sum, p) => sum + (p!.bsDebit || 0), 0);
  
  const uniqueReceiptBS = Array.from(new Set(receiptMatches.map(p => p.bsRowNo))).map(rNo => receiptMatches.find(p => p.bsRowNo === rNo));
  const totalBSCreditMatched = uniqueReceiptBS.reduce((sum, p) => sum + (p!.bsCredit || 0), 0);
  
  const uniquePaymentGL = Array.from(new Set(paymentMatches.map(p => p.glRowNo))).map(rNo => paymentMatches.find(p => p.glRowNo === rNo));
  const totalGLCreditMatched = uniquePaymentGL.reduce((sum, p) => sum + (p!.glCredit || 0), 0);
  
  const uniqueReceiptGL = Array.from(new Set(receiptMatches.map(p => p.glRowNo))).map(rNo => receiptMatches.find(p => p.glRowNo === rNo));
  const totalGLDebitMatched = uniqueReceiptGL.reduce((sum, p) => sum + (p!.glDebit || 0), 0);

  // BS Reversal net impact
  const bsReversalTotalDebit = result.bsReversalEntries.reduce((s, t) => s + (t.debit || 0), 0);
  const bsReversalTotalCredit = result.bsReversalEntries.reduce((s, t) => s + (t.credit || 0), 0);
  const bsReversalNet = bsReversalTotalDebit - bsReversalTotalCredit;

  // Compute Balance In GL and Balance In BS from transaction totals
  // Balance In GL = Opening Balance + Debit - Credit
  // Balance In BS = Opening Balance - Debit + Credit
  // Opening balance is ZERO â€” reconciliation starts from zero for both GL and BS
  const glTotalDebit = result.glTransactions.reduce((s, t) => s + (t.debit || 0), 0);
  const glTotalCredit = result.glTransactions.reduce((s, t) => s + (t.credit || 0), 0);
  const glOpeningBalance = 0; // Opening balance is zero for reconciliation
  const glComputedBalance = glOpeningBalance + glTotalDebit - glTotalCredit;

  const bsTotalDebit = result.bsTransactions.reduce((s, t) => s + (t.debit || 0), 0);
  const bsTotalCredit = result.bsTransactions.reduce((s, t) => s + (t.credit || 0), 0);
  const bsOpeningBalance = 0; // Opening balance is zero for reconciliation
  const bsComputedBalance = bsOpeningBalance - bsTotalDebit + bsTotalCredit;

  // BS Reversal Net is subtracted because both sides of reversal pairs are excluded from matching
  const adjustedGLBalance = glBalance + totalUnPresentedCheques - totalUnClearedReceipts - totalUnRecordedPayments + totalUnRecordedReceipts - bsReversalNet;
  const difference = adjustedGLBalance - bsBalance;

  result.summary = {
    glBalance,
    bsBalance,
    unPresentedCheques: { count: result.unPresentedCheques.length, total: totalUnPresentedCheques },
    unClearedReceipts: { count: result.unClearedReceipts.length, total: totalUnClearedReceipts },
    unRecordedPayments: { count: result.unRecordedPayments.length, total: totalUnRecordedPayments },
    unRecordedReceipts: { count: result.unRecordedReceipts.length, total: totalUnRecordedReceipts },
    matchedPairs: { count: result.matchedPairs.length, totalPayments: totalBSDebitMatched, totalReceipts: totalBSCreditMatched },
    bsReversals: {
      count: result.bsReversalEntries.length,
      totalDebit: bsReversalTotalDebit,
      totalCredit: bsReversalTotalCredit,
      netImpact: bsReversalNet,
    },
    adjustedGLBalance,
    difference,
    glOpeningBalance,
    glTotalDebit,
    glTotalCredit,
    glComputedBalance,
    bsOpeningBalance,
    bsTotalDebit,
    bsTotalCredit,
    bsComputedBalance,
    totalBSDebitMatched,
    totalBSCreditMatched,
    totalGLDebitMatched,
    totalGLCreditMatched,
  };

  // Recalculate gap audit
  const reversalDebitTotal = result.reversalEntries.reduce((s, t) => s + (t.debit || 0), 0);
  const reversalCreditTotal = result.reversalEntries.reduce((s, t) => s + (t.credit || 0), 0);
  const reversalNetImpact = reversalDebitTotal - reversalCreditTotal;

  let matchedAmountDiff = 0;
  for (const pair of result.matchedPairs) {
    if (pair.type === 'Payment') {
      matchedAmountDiff += (pair.bsDebit || 0) - (pair.glCredit || 0);
    } else {
      matchedAmountDiff += (pair.bsCredit || 0) - (pair.glDebit || 0);
    }
  }

  const bsAllAccounted = new Set<string>();
  for (const mp of result.matchedPairs) { bsAllAccounted.add(`${mp.bsRowNo}`); }
  for (const urp of result.unRecordedPayments) { bsAllAccounted.add(urp.uniqueKey); }
  for (const urr of result.unRecordedReceipts) { bsAllAccounted.add(urr.uniqueKey); }
  for (const bsr of result.bsReversalEntries) { bsAllAccounted.add(bsr.uniqueKey); }
  const bsUnaccountedEntries = result.bsTransactions.filter(t => !bsAllAccounted.has(t.uniqueKey) && !bsAllAccounted.has(String(t.rowNo)));
  const bsUnaccountedNet = bsUnaccountedEntries.reduce((s, t) => s + (t.debit || 0) - (t.credit || 0), 0);

  const glAllAccounted = new Set<string>();
  for (const mp of result.matchedPairs) { glAllAccounted.add(`${mp.glRowNo}`); }
  for (const upc of result.unPresentedCheques) { glAllAccounted.add(upc.uniqueKey); }
  for (const ucr of result.unClearedReceipts) { glAllAccounted.add(ucr.uniqueKey); }
  for (const rev of result.reversalEntries) { glAllAccounted.add(rev.uniqueKey); }
  const glUnaccountedEntries = result.glTransactions.filter(t => !glAllAccounted.has(t.uniqueKey) && !glAllAccounted.has(String(t.rowNo)));
  const glUnaccountedNet = glUnaccountedEntries.reduce((s, t) => s + (t.debit || 0) - (t.credit || 0), 0);

  const explainedGap = reversalNetImpact + matchedAmountDiff + bsUnaccountedNet + glUnaccountedNet;
  const unexplainedGap = difference - explainedGap;

  result.gapAudit = {
    gap: difference,
    items: result.gapAudit.items, // Keep existing item descriptions
    reversalNetImpact,
    matchedAmountDiff,
    bsUnaccountedNet,
    glUnaccountedNet,
    unexplainedGap,
  };
}


