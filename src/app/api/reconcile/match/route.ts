import { NextRequest, NextResponse } from 'next/server';
import { applyManualMatch, unmatchPair, ReconciliationResult } from '@/lib/reconciler';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { action, result: currentResult, bsUniqueKey, glUniqueKey, reason } = body;

    if (!currentResult) {
      return NextResponse.json({ error: 'No reconciliation result provided' }, { status: 400 });
    }

    let updatedResult: ReconciliationResult = currentResult as ReconciliationResult;

    if (action === 'match') {
      if (!bsUniqueKey || !glUniqueKey) {
        return NextResponse.json({ error: 'Both BS and GL unique keys are required' }, { status: 400 });
      }
      updatedResult = applyManualMatch(updatedResult, bsUniqueKey, glUniqueKey, reason || 'Manual match by user');
    } else if (action === 'unmatch') {
      if (!bsUniqueKey || !glUniqueKey) {
        return NextResponse.json({ error: 'Both BS and GL unique keys are required' }, { status: 400 });
      }
      updatedResult = unmatchPair(updatedResult, bsUniqueKey, glUniqueKey);
    } else {
      return NextResponse.json({ error: 'Invalid action. Use "match" or "unmatch"' }, { status: 400 });
    }

    return NextResponse.json(updatedResult);
  } catch (error: unknown) {
    console.error('Manual match error:', error);
    const message = error instanceof Error ? error.message : 'Unknown error';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
