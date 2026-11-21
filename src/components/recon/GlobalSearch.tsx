'use client';

import React, { useState, useMemo } from 'react';
import { Search, X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import type { ReconciliationResult } from '@/lib/reconciler';

interface GlobalSearchProps {
  result: ReconciliationResult;
  value: string;
  onChange: (value: string) => void;
}

export function GlobalSearch({ result, value, onChange }: GlobalSearchProps) {
  const searchResults = useMemo(() => {
    if (!value || value.length < 2) return null;
    const searchLower = value.toLowerCase();
    const found: string[] = [];

    const checkMatch = (text: string): boolean => text.toLowerCase().includes(searchLower);

    // Check matched pairs
    if (result.matchedPairs.some(p => checkMatch(p.bsParticulars) || checkMatch(p.glDetails) || checkMatch(p.bsDate))) {
      found.push('Matched');
    }
    // Check un presented cheques
    if (result.unPresentedCheques.some(t => checkMatch(t.details) || checkMatch(t.transNo) || checkMatch(t.postingDate))) {
      found.push('Un Presented Cheques');
    }
    // Check un cleared receipts
    if (result.unClearedReceipts.some(t => checkMatch(t.details) || checkMatch(t.transNo) || checkMatch(t.postingDate))) {
      found.push('Un Cleared Receipts');
    }
    // Check un recorded payments
    if (result.unRecordedPayments.some(t => checkMatch(t.particulars) || checkMatch(t.date))) {
      found.push('Un Recorded Payments');
    }
    // Check un recorded receipts
    if (result.unRecordedReceipts.some(t => checkMatch(t.particulars) || checkMatch(t.date))) {
      found.push('Un Recorded Receipts');
    }
    // Check reversals
    if (result.reversalEntries?.some(t => checkMatch(t.details) || checkMatch(t.transNo))) {
      found.push('Reversals');
    }
    // Check possible matches
    if (result.possibleMatches?.some(pm => checkMatch(pm.matchReason) || checkMatch(pm.bsTransaction.particulars) || checkMatch(pm.glTransaction.details))) {
      found.push('Possible Matches');
    }
    // Check manual adjustments
    if (result.manualMatches?.some(m => checkMatch(m.bsParticulars) || checkMatch(m.glDetails) || checkMatch(m.reason))) {
      found.push('Manual Adjustments');
    }

    return found;
  }, [value, result]);

  return (
    <div className="relative">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
      <Input
        placeholder="Search all data..."
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="pl-9 pr-8 w-64"
      />
      {value && (
        <button
          onClick={() => onChange('')}
          className="absolute right-2 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400 hover:text-slate-600"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
      {searchResults && searchResults.length > 0 && (
        <div className="absolute top-full mt-1 left-0 right-0 bg-white border rounded-md shadow-lg p-2 z-50 max-w-xs">
          <p className="text-[10px] text-slate-500 mb-1">Found in:</p>
          <div className="flex flex-wrap gap-1">
            {searchResults.map(r => (
              <Badge key={r} variant="secondary" className="text-[10px]">{r}</Badge>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
