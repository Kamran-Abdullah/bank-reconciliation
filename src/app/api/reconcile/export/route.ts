import { NextRequest, NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import { ReconciliationResult } from '@/lib/reconciler';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const result: ReconciliationResult = body;

    const workbook = XLSX.utils.book_new();

    // Sheet 1: Summary
    const summaryData = [
      ['BANK RECONCILIATION STATEMENT'],
      ['Company Name | Reporting Period'],
      [],
      ['Description', 'Amount (PKR)', '±', 'Notes'],
      ['GL Balance / Company Ledger Closing Balance', result.summary.glBalance, 'Base', 'GL closing balance'],
      ['Add: Un Presented Cheques (+)', result.summary.unPresentedCheques.total, '+', 'GL issued cheques not yet cleared at bank'],
      ['Less: Un Cleared Receipts (−)', -result.summary.unClearedReceipts.total, '−', 'GL receipts not yet credited by bank'],
      ['Less: Un Recorded Payments (−)', -result.summary.unRecordedPayments.total, '−', 'Bank debits with no GL entry'],
      ['Add: Un Recorded Receipts (+)', result.summary.unRecordedReceipts.total, '+', 'Bank credits with no GL entry'],
    ];

    // Add BS Reversal Net if applicable
    if (result.summary.bsReversals.netImpact !== 0) {
      summaryData.push(
        ['Less: BS Reversal Net Impact (−)', -result.summary.bsReversals.netImpact, '−', `Dr ${result.summary.bsReversals.totalDebit} − Cr ${result.summary.bsReversals.totalCredit} = ${result.summary.bsReversals.netImpact}`]
      );
    }

    summaryData.push(
      [],
      ['Adjusted GL Balance (Total)', result.summary.adjustedGLBalance, 'ADJ', 'Must equal Bank Statement closing balance'],
      ['BS Balance / Bank Statement Closing Balance', result.summary.bsBalance, 'BS', 'Bank Statement closing balance'],
      ['Difference (ZERO = Fully Reconciled)', result.summary.difference, 'Δ', result.summary.difference === 0 ? 'FULLY RECONCILED' : 'Gap remains'],
      [],
      ['Cross-Check: BS Debit = GL Credit | BS Credit = GL Debit', 'BS Side (PKR)', 'GL Side (PKR)', 'Difference'],
      ['Payments: BS Debit Matched = GL Credit Matched', result.summary.totalBSDebitMatched, result.summary.totalGLCreditMatched, result.summary.totalBSDebitMatched - result.summary.totalGLCreditMatched],
      ['Receipts: BS Credit Matched = GL Debit Matched', result.summary.totalBSCreditMatched, result.summary.totalGLDebitMatched, result.summary.totalBSCreditMatched - result.summary.totalGLDebitMatched],
      [],
      ['Statistics', 'Count', 'Amount (PKR)'],
      ['Bank Statement — Total Entries', result.bsTransactions.length],
      ['GL Ledger — Total Entries', result.glTransactions.length],
      ['Auto-Matched Pairs', result.summary.matchedPairs.count],
      ['Un Presented Cheques', result.summary.unPresentedCheques.count, result.summary.unPresentedCheques.total],
      ['Un Cleared Receipts', result.summary.unClearedReceipts.count, result.summary.unClearedReceipts.total],
      ['Un Recorded Payments', result.summary.unRecordedPayments.count, result.summary.unRecordedPayments.total],
      ['Un Recorded Receipts', result.summary.unRecordedReceipts.count, result.summary.unRecordedReceipts.total],
      ['GL Reversals (Excluded)', result.reversalEntries?.length || 0],
      ['BS Reversals (Excluded)', result.bsReversalEntries?.length || 0],
      ['BS Reversal Net Impact', '', result.summary.bsReversals?.netImpact || 0],
      ['Possible Matches', result.possibleMatches?.length || 0],
      ['Manual Adjustments', result.manualMatches?.length || 0],
      [],
      ['Balance In GL', 'Amount (PKR)', 'Formula'],
      ['Opening Balance', 0, 'Opening balance is zero'],
      ['+ Debit', result.summary.glTotalDebit, '0 + Debit − Credit'],
      ['− Credit', result.summary.glTotalCredit],
      ['= Closing Balance', result.summary.glComputedBalance],
      ['Statement Closing Balance', result.summary.glBalance, 'From GL cumulative balance'],
      [],
      ['Balance In BS', 'Amount (PKR)', 'Formula'],
      ['Opening Balance', 0, 'Opening balance is zero'],
      ['− Debit', result.summary.bsTotalDebit, '0 − Debit + Credit'],
      ['+ Credit', result.summary.bsTotalCredit],
      ['= Closing Balance', result.summary.bsComputedBalance],
      ['Statement Closing Balance', result.summary.bsBalance, 'From BS closing balance'],
    );
    const summaryWs = XLSX.utils.aoa_to_sheet(summaryData);
    summaryWs['!cols'] = [{ wch: 50 }, { wch: 20 }, { wch: 10 }, { wch: 50 }];
    XLSX.utils.book_append_sheet(workbook, summaryWs, 'Summary');

    // Sheet 2: Matched Transactions
    const matchedHeader = ['#', 'Type', 'Source', 'BS Date', 'BS Particulars', 'GL Details', 'BS Debit', 'BS Credit', 'GL Debit', 'GL Credit', 'Amount'];
    const matchedRows = result.matchedPairs.map((p, i) => {
      const isManual = result.manualMatches.some(m => m.bsRowNo === p.bsRowNo && m.glRowNo === p.glRowNo);
      return [
        i + 1, p.type, isManual ? 'Manual' : 'Auto', p.bsDate, p.bsParticulars, p.glDetails,
        p.bsDebit || '', p.bsCredit || '', p.glDebit || '', p.glCredit || '',
        p.bsDebit || p.bsCredit || 0
      ];
    });
    const matchedWs = XLSX.utils.aoa_to_sheet([matchedHeader, ...matchedRows]);
    matchedWs['!cols'] = [{ wch: 6 }, { wch: 10 }, { wch: 8 }, { wch: 14 }, { wch: 50 }, { wch: 50 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(workbook, matchedWs, 'Matched Transactions');

    // Sheet 3: Un Presented Cheques
    const upcHeader = ['#', 'Posting Date', 'Trans No', 'Details', 'Debit (PKR)', 'Credit (PKR)'];
    const upcRows = result.unPresentedCheques.map((t, i) => [
      i + 1, t.postingDate, t.transNo, t.details, t.debit || '', t.credit || ''
    ]);
    const upcWs = XLSX.utils.aoa_to_sheet([upcHeader, ...upcRows]);
    upcWs['!cols'] = [{ wch: 6 }, { wch: 14 }, { wch: 12 }, { wch: 60 }, { wch: 16 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(workbook, upcWs, 'Un Presented Cheques');

    // Sheet 4: Un Cleared Receipts
    const ucrHeader = ['#', 'Posting Date', 'Trans No', 'Details', 'Debit (PKR)', 'Credit (PKR)'];
    const ucrRows = result.unClearedReceipts.map((t, i) => [
      i + 1, t.postingDate, t.transNo, t.details, t.debit || '', t.credit || ''
    ]);
    const ucrWs = XLSX.utils.aoa_to_sheet([ucrHeader, ...ucrRows]);
    ucrWs['!cols'] = [{ wch: 6 }, { wch: 14 }, { wch: 12 }, { wch: 60 }, { wch: 16 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(workbook, ucrWs, 'Un Cleared Receipts');

    // Sheet 5: Un Recorded Payments
    const urpHeader = ['#', 'Date', 'Particulars', 'Debit (PKR)'];
    const urpRows = result.unRecordedPayments.map((t, i) => [
      i + 1, t.date, t.particulars, t.debit || ''
    ]);
    const urpWs = XLSX.utils.aoa_to_sheet([urpHeader, ...urpRows]);
    urpWs['!cols'] = [{ wch: 6 }, { wch: 14 }, { wch: 60 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(workbook, urpWs, 'Un Recorded Payments');

    // Sheet 6: Un Recorded Receipts
    const urrHeader = ['#', 'Date', 'Particulars', 'Credit (PKR)'];
    const urrRows = result.unRecordedReceipts.map((t, i) => [
      i + 1, t.date, t.particulars, t.credit || ''
    ]);
    const urrWs = XLSX.utils.aoa_to_sheet([urrHeader, ...urrRows]);
    urrWs['!cols'] = [{ wch: 6 }, { wch: 14 }, { wch: 60 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(workbook, urrWs, 'Un Recorded Receipts');

    // Sheet 7: GL Reversals (Enhancement 1)
    const revHeader = ['#', 'Posting Date', 'Trans No', 'Details', 'Debit (PKR)', 'Credit (PKR)', 'Reversal Partner'];
    const revRows = (result.reversalEntries || []).map((t, i) => [
      i + 1, t.postingDate, t.transNo, t.details, t.debit || '', t.credit || '',
      t.isReversal ? 'Reversal' : 'Original'
    ]);
    const revWs = XLSX.utils.aoa_to_sheet([revHeader, ...revRows]);
    revWs['!cols'] = [{ wch: 6 }, { wch: 14 }, { wch: 12 }, { wch: 60 }, { wch: 16 }, { wch: 16 }, { wch: 18 }];
    XLSX.utils.book_append_sheet(workbook, revWs, 'GL Reversals');

    // Sheet 7.5: BS Internal Reversals
    const bsRevHeader = ['#', 'Date', 'Particulars', 'Debit (PKR)', 'Credit (PKR)', 'Status'];
    const bsRevRows = (result.bsReversalEntries || []).map((t, i) => [
      i + 1, t.date, t.particulars, t.debit || '', t.credit || '', t.reconStatus
    ]);
    const bsRevWs = XLSX.utils.aoa_to_sheet([bsRevHeader, ...bsRevRows]);
    bsRevWs['!cols'] = [{ wch: 6 }, { wch: 14 }, { wch: 60 }, { wch: 16 }, { wch: 16 }, { wch: 22 }];
    XLSX.utils.book_append_sheet(workbook, bsRevWs, 'BS Reversals');

    // Sheet 8: Possible Matches (Enhancement 4)
    const pmHeader = ['#', 'BS Date', 'BS Particulars', 'BS Amount', 'GL Details', 'GL Amount', 'Confidence %', 'Match Reason', 'BS Category', 'GL Category'];
    const pmRows = (result.possibleMatches || []).map((pm, i) => [
      i + 1, pm.bsTransaction.date, pm.bsTransaction.particulars,
      pm.bsTransaction.debit || pm.bsTransaction.credit || 0,
      pm.glTransaction.details,
      pm.glTransaction.debit || pm.glTransaction.credit || 0,
      pm.confidence, pm.matchReason, pm.bsCategory, pm.glCategory
    ]);
    const pmWs = XLSX.utils.aoa_to_sheet([pmHeader, ...pmRows]);
    pmWs['!cols'] = [{ wch: 6 }, { wch: 14 }, { wch: 50 }, { wch: 16 }, { wch: 50 }, { wch: 16 }, { wch: 12 }, { wch: 50 }, { wch: 20 }, { wch: 20 }];
    XLSX.utils.book_append_sheet(workbook, pmWs, 'Possible Matches');

    // Sheet 9: Manual Adjustment Report (Enhancement 5)
    const maHeader = ['#', 'Timestamp', 'Type', 'BS Particulars', 'BS Amount (PKR)', 'GL Details', 'GL Amount (PKR)', 'Amount Difference', 'Reason'];
    const maRows = (result.manualMatches || []).map((m, i) => [
      i + 1, m.timestamp || '', m.type, m.bsParticulars, m.bsAmount,
      m.glDetails, m.glAmount, Math.abs(m.bsAmount - m.glAmount),
      m.reason || 'Manual match by user'
    ]);
    const maWs = XLSX.utils.aoa_to_sheet([maHeader, ...maRows]);
    maWs['!cols'] = [{ wch: 6 }, { wch: 22 }, { wch: 10 }, { wch: 50 }, { wch: 16 }, { wch: 50 }, { wch: 16 }, { wch: 16 }, { wch: 50 }];
    XLSX.utils.book_append_sheet(workbook, maWs, 'Manual Adjustment Report');

    // Sheet 10: Bank Statement (all)
    const bsHeader = ['#', 'Date', 'Particulars', 'Key', 'Debit (PKR)', 'Credit (PKR)', 'Balance (PKR)', 'Status'];
    const bsRows = result.bsTransactions.map((t) => [
      t.rowNo, t.date, t.particulars, t.keyExtracted, t.debit || '', t.credit || '', t.balance || '', t.reconStatus
    ]);
    const bsWs = XLSX.utils.aoa_to_sheet([bsHeader, ...bsRows]);
    bsWs['!cols'] = [{ wch: 6 }, { wch: 14 }, { wch: 60 }, { wch: 30 }, { wch: 16 }, { wch: 16 }, { wch: 16 }, { wch: 22 }];
    XLSX.utils.book_append_sheet(workbook, bsWs, 'Bank Statement');

    // Sheet 11: GL Ledger (all)
    const glHeader = ['#', 'Posting Date', 'Trans No', 'Details', 'Key', 'Debit (PKR)', 'Credit (PKR)', 'Status'];
    const glRows = result.glTransactions.map((t) => [
      t.rowNo, t.postingDate, t.transNo, t.details, t.keyExtracted, t.debit || '', t.credit || '', t.reconStatus
    ]);
    const glWs = XLSX.utils.aoa_to_sheet([glHeader, ...glRows]);
    glWs['!cols'] = [{ wch: 6 }, { wch: 14 }, { wch: 12 }, { wch: 60 }, { wch: 30 }, { wch: 16 }, { wch: 16 }, { wch: 22 }];
    XLSX.utils.book_append_sheet(workbook, glWs, 'GL Ledger');

    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    return new NextResponse(buffer, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': 'attachment; filename=BankReconciliation_Jan2026.xlsx',
      },
    });
  } catch (error: unknown) {
    console.error('Export error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
