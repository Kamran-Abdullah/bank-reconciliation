'use client';

import React, { useState, useCallback, useRef, useMemo, useEffect } from 'react';
import {
  Upload, FileSpreadsheet, CheckCircle2, XCircle, AlertTriangle,
  ArrowRightLeft, Download, RefreshCw, Link2, Unlink, Loader2, Info,
  ArrowRight, Sparkles, Clock, Zap, Check, Save, FolderOpen, Trash2, Settings2, ChevronRight
} from 'lucide-react';
// Note: RefreshCw is still used by the Reversals tab icon
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { DataTable, type ColumnDef } from '@/components/recon/DataTable';
import { GlobalSearch } from '@/components/recon/GlobalSearch';
import { applyManualMatch, unmatchPair, applyOneToManyMatch, markAsManualReversal, unmarkReversal } from '@/lib/reconciler';
import type { ReconciliationResult, MatchedPair, GLTransaction, BSTransaction, PossibleMatch, ManualMatch, GapAudit } from '@/lib/reconciler';
import { 
  type ColumnMapping, type FilePreview, type SheetPreview, type ReconciliationSession,
  saveSession, getSessions, deleteSession, autoSaveSession, exportSessionToFile, importSessionFromFile
} from '@/lib/columnDetector';

function formatPKR(amount: number | null | undefined): string {
  if (amount === null || amount === undefined) return '—';
  return new Intl.NumberFormat('en-PK', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(amount);
}

function formatCompact(amount: number): string {
  if (Math.abs(amount) >= 1_000_000_000) return `${(amount / 1_000_000_000).toFixed(1)}B`;
  if (Math.abs(amount) >= 1_000_000) return `${(amount / 1_000_000).toFixed(1)}M`;
  if (Math.abs(amount) >= 1_000) return `${(amount / 1_000).toFixed(1)}K`;
  return amount.toFixed(0);
}

type SelectionMode = 'none' | 'active';
interface SelectedItem {
  source: 'bs' | 'gl';
  uniqueKey: string;
  particulars: string;
  amount: number;
  rowNo: number;
  debit?: number;
  credit?: number;
}

export default function BankReconciliationPage() {
  const [result, setResult] = useState<ReconciliationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [updatingGL, setUpdatingGL] = useState(false);
  const [exporting, setExporting] = useState(false);
  const updateGLRef = useRef<HTMLInputElement>(null);
  const [combinedFile, setCombinedFile] = useState<File | null>(null);
  const [bsFile, setBsFile] = useState<File | null>(null);
  const [glFile, setGlFile] = useState<File | null>(null);
  const [uploadMode, setUploadMode] = useState<'combined' | 'separate'>('combined');
  const [selectionMode, setSelectionMode] = useState<SelectionMode>('none');
  const [selectedBSItems, setSelectedBSItems] = useState<SelectedItem[]>([]);
  const [selectedGLItems, setSelectedGLItems] = useState<SelectedItem[]>([]);
  const [globalSearch, setGlobalSearch] = useState('');
  const [activeTab, setActiveTab] = useState('summary');
  const [acceptingMatchId, setAcceptingMatchId] = useState<number | null>(null);
  
  // Column mapping state
  const [previewData, setPreviewData] = useState<{ previews: FilePreview[] } | null>(null);
  const [showMappingUI, setShowMappingUI] = useState(false);
  const [editingMappings, setEditingMappings] = useState<Record<string, ColumnMapping[]>>({});
  const [previewing, setPreviewing] = useState(false);
  const [autoMatchThreshold, setAutoMatchThreshold] = useState<number>(55);
  
  // Session persistence state
  const [savedSessions, setSavedSessions] = useState<ReconciliationSession[]>([]);
  const [showSessions, setShowSessions] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const sessionImportRef = useRef<HTMLInputElement>(null);
  
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const bsInputRef = useRef<HTMLInputElement>(null);
  const glInputRef = useRef<HTMLInputElement>(null);

  // Load saved sessions on mount
  useEffect(() => {
    getSessions().then(sessions => setSavedSessions(sessions));
  }, []);

  // Auto-save session whenever result changes
  useEffect(() => {
    if (result) {
      try {
        const fileName = combinedFile?.name || bsFile?.name || glFile?.name || 'reconciliation';
        autoSaveSession(fileName, result);
      } catch (e) {
        console.warn('Auto-save failed (localStorage may be full):', e);
      }
    }
  }, [result]); // eslint-disable-line react-hooks/exhaustive-deps

  // Step 1: Preview file to detect columns
  const handlePreview = useCallback(async () => {
    const formData = new FormData();
    
    if (uploadMode === 'combined' && combinedFile) {
      formData.append('combinedFile', combinedFile);
    } else {
      if (bsFile) formData.append('bsFile', bsFile);
      if (glFile) formData.append('glFile', glFile);
    }

    if (!formData.has('combinedFile') && !formData.has('bsFile') && !formData.has('glFile')) {
      toast({ title: 'No files selected', description: 'Please upload at least one file', variant: 'destructive' });
      return;
    }

    setPreviewing(true);
    try {
      const response = await fetch('/api/reconcile/preview', { method: 'POST', body: formData });
      if (!response.ok) {
        let errMsg = 'Preview failed';
        try { const err = await response.json(); errMsg = err.error || errMsg; } catch { /* ignore */ }
        throw new Error(errMsg);
      }
      const data = await response.json();
      setPreviewData(data);
      
      // Initialize editing mappings from detected mappings
      const mappings: Record<string, ColumnMapping[]> = {};
      data.previews.forEach((fp: FilePreview) => {
        fp.sheets.forEach((sp: SheetPreview) => {
          mappings[`${fp.fileName}::${sp.sheetName}`] = sp.mappings.map(m => ({ ...m }));
        });
      });
      setEditingMappings(mappings);
      setShowMappingUI(true);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      toast({ title: 'Preview Error', description: message, variant: 'destructive' });
    } finally {
      setPreviewing(false);
    }
  }, [combinedFile, bsFile, glFile, uploadMode, toast]);

  // Step 2: Run reconciliation with confirmed column mappings
  const handleReconcileWithMappings = useCallback(async () => {
    const formData = new FormData();
    
    if (uploadMode === 'combined' && combinedFile) {
      formData.append('combinedFile', combinedFile);
    } else {
      if (bsFile) formData.append('bsFile', bsFile);
      if (glFile) formData.append('glFile', glFile);
    }
    
    formData.append('autoMatchThreshold', autoMatchThreshold.toString());

    // Build column mappings payload
    const bsMappings: ColumnMapping[] = [];
    const glMappings: ColumnMapping[] = [];
    
    if (previewData) {
      for (const [key, mappings] of Object.entries(editingMappings)) {
        const [fileName, sheetName] = key.split('::');
        const filePreview = previewData.previews.find((fp: FilePreview) => fp.fileName === fileName);
        const sheetPreview = filePreview?.sheets.find((sp: SheetPreview) => sp.sheetName === sheetName);
        if (sheetPreview?.detectedType === 'bs') {
          bsMappings.push(...mappings);
        } else if (sheetPreview?.detectedType === 'gl') {
          glMappings.push(...mappings);
        }
      }
    }

    formData.append('mappings', JSON.stringify({ bsMappings, glMappings }));

    setLoading(true);
    try {
      const response = await fetch('/api/reconcile', { method: 'POST', body: formData });
      if (!response.ok) {
        let errMsg = 'Reconciliation failed';
        try {
          const err = await response.json();
          errMsg = err.error || errMsg;
        } catch {
          errMsg = `Server error (${response.status}). The file may be too large — try a smaller dataset.`;
        }
        throw new Error(errMsg);
      }
      const data = await response.json();
      setResult(data);
      setActiveTab('summary');
      setGlobalSearch('');
      setShowMappingUI(false);
      setCurrentSessionId(`session-${Date.now()}`);
      toast({
        title: 'Reconciliation Complete',
        description: `Matched ${data.summary.matchedPairs.count} pairs. Difference: PKR ${formatPKR(data.summary.difference)}`,
        variant: data.summary.difference === 0 ? 'default' : 'destructive',
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      toast({ title: 'Error', description: message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [combinedFile, bsFile, glFile, uploadMode, previewData, editingMappings, toast]);

  const handleUpload = useCallback(async () => {
    const formData = new FormData();
    
    if (uploadMode === 'combined' && combinedFile) {
      formData.append('combinedFile', combinedFile);
    } else {
      if (bsFile) formData.append('bsFile', bsFile);
      if (glFile) formData.append('glFile', glFile);
    }

    if (!formData.has('combinedFile') && !formData.has('bsFile') && !formData.has('glFile')) {
      toast({ title: 'No files selected', description: 'Please upload at least one file', variant: 'destructive' });
      return;
    }

    setLoading(true);
    try {
      const response = await fetch('/api/reconcile', { method: 'POST', body: formData });
      if (!response.ok) {
        let errMsg = 'Reconciliation failed';
        try {
          const err = await response.json();
          errMsg = err.error || errMsg;
        } catch {
          errMsg = `Server error (${response.status}). The file may be too large — try a smaller dataset.`;
        }
        throw new Error(errMsg);
      }
      const data = await response.json();
      setResult(data);
      setActiveTab('summary');
      setGlobalSearch('');
      setCurrentSessionId(`session-${Date.now()}`);
      toast({
        title: 'Reconciliation Complete',
        description: `Matched ${data.summary.matchedPairs.count} pairs. Difference: PKR ${formatPKR(data.summary.difference)}`,
        variant: data.summary.difference === 0 ? 'default' : 'destructive',
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      toast({ title: 'Error', description: message, variant: 'destructive' });
    } finally {
      setLoading(false);
    }
  }, [combinedFile, bsFile, glFile, uploadMode, toast]);

  // Session handlers
  const handleLoadSession = useCallback((session: ReconciliationSession) => {
    setResult(session.result as ReconciliationResult);
    setActiveTab('summary');
    setCurrentSessionId(session.id);
    setShowSessions(false);
    toast({ title: 'Session Restored', description: `Loaded: ${session.name}` });
  }, [toast]);

  const handleSaveSession = useCallback(async () => {
    if (!result) return;
    const fileName = combinedFile?.name || bsFile?.name || glFile?.name || 'reconciliation';
    const session: ReconciliationSession = {
      id: currentSessionId || `session-${Date.now()}`,
      name: fileName,
      savedAt: new Date().toISOString(),
      fileName,
      result,
    };
    await saveSession(session);
    const sessions = await getSessions();
    setSavedSessions(sessions);
    toast({ title: 'Session Saved', description: 'You can resume this session later' });
  }, [result, combinedFile, bsFile, glFile, currentSessionId, toast]);

  const handleDeleteSession = useCallback(async (sessionId: string) => {
    await deleteSession(sessionId);
    const sessions = await getSessions();
    setSavedSessions(sessions);
    toast({ title: 'Session Deleted' });
  }, [toast]);

  const handleUnmarkReversal = useCallback((source: 'bs' | 'gl', uniqueKey: string) => {
    if (!result) return;
    try {
      const updatedResult = unmarkReversal(result, source, uniqueKey);
      setResult(updatedResult);
      toast({ title: 'Reversal Detached', description: 'The entry has been restored to the pending pool.' });
    } catch (error) {
      console.error('Unmark error:', error);
      toast({ title: 'Detach Error', description: 'Failed to detach reversal.', variant: 'destructive' });
    }
  }, [result, toast]);

  const handleExportSession = useCallback(() => {
    if (!result) return;
    
    const session: ReconciliationSession = {
      id: currentSessionId || crypto.randomUUID(),
      timestamp: Date.now(),
      name: `Reconciliation ${new Date().toLocaleDateString()}`,
      bsData: null,
      glData: null,
      result: result
    };
    
    exportSessionToFile(session);
    toast({ title: 'Session Exported', description: 'Save this file to restore your work later' });
  }, [result, currentSessionId, toast]);

  const handleUpdateGL = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !result) return;

    setUpdatingGL(true);
    try {
      const formData = new FormData();
      formData.append('glFile', file);
      formData.append('currentResult', JSON.stringify(result));
      formData.append('autoMatchThreshold', autoMatchThreshold.toString());

      const response = await fetch('/api/reconcile/update-gl', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || 'Failed to update GL data');
      }

      const updatedResult = await response.json();
      setResult(updatedResult);
      toast({ title: 'GL Updated', description: 'Successfully incorporated new GL entries and matched them.' });
    } catch (error) {
      console.error('GL Update Error:', error);
      const message = error instanceof Error ? error.message : 'Unknown error';
      toast({ title: 'GL Update Error', description: message, variant: 'destructive' });
    } finally {
      setUpdatingGL(false);
      if (updateGLRef.current) updateGLRef.current.value = '';
    }
  }, [result, autoMatchThreshold, toast]);

  const handleImportSession = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      const session = await importSessionFromFile(file);
      handleLoadSession(session);
    } catch (err) {
      toast({ title: 'Import Error', description: err instanceof Error ? err.message : 'Failed to import session', variant: 'destructive' });
    }
    // Reset input
    if (sessionImportRef.current) sessionImportRef.current.value = '';
  }, [handleLoadSession, toast]);

  // Update column mapping
  const updateMapping = useCallback((key: string, fieldIdx: number, newColumnIndex: number | null) => {
    setEditingMappings(prev => {
      const mappings = { ...prev };
      const arr = [...(mappings[key] || [])];
      arr[fieldIdx] = { ...arr[fieldIdx], columnIndex: newColumnIndex };
      mappings[key] = arr;
      return mappings;
    });
  }, []);

  // Let the user manually override the auto-detected confidence level
  const updateConfidence = useCallback((key: string, fieldIdx: number, newConfidence: number) => {
    setEditingMappings(prev => {
      const mappings = { ...prev };
      const arr = [...(mappings[key] || [])];
      arr[fieldIdx] = { ...arr[fieldIdx], confidence: newConfidence };
      mappings[key] = arr;
      return mappings;
    });
  }, []);

  const handleManualMatch = useCallback((reason?: string) => {
    if (!result) return;

    try {
      // Case 1: Only BS items selected — same-side BS reversal
      if (selectedBSItems.length > 0 && selectedGLItems.length === 0) {
        // Check if there are both debit and credit entries selected
        const hasDebit = selectedBSItems.some(i => i.debit && i.debit > 0);
        const hasCredit = selectedBSItems.some(i => i.credit && i.credit > 0);
        if (hasDebit && hasCredit) {
          const updated = markAsManualReversal(
            result,
            'bs',
            selectedBSItems.map(i => i.uniqueKey),
            reason || 'Manual BS reversal by user'
          );
          setResult(updated);
          setSelectedBSItems([]);
          setSelectedGLItems([]);
          setSelectionMode('none');
          toast({ title: 'BS Reversal Marked', description: `${selectedBSItems.length} BS entries marked as reversal pair(s)` });
          return;
        } else {
          toast({ title: 'Cannot Mark Reversal', description: 'Select both debit and credit entries from BS to mark as reversal', variant: 'destructive' });
          return;
        }
      }

      // Case 2: Only GL items selected — same-side GL reversal
      if (selectedGLItems.length > 0 && selectedBSItems.length === 0) {
        const hasDebit = selectedGLItems.some(i => i.debit && i.debit > 0);
        const hasCredit = selectedGLItems.some(i => i.credit && i.credit > 0);
        if (hasDebit && hasCredit) {
          const updated = markAsManualReversal(
            result,
            'gl',
            selectedGLItems.map(i => i.uniqueKey),
            reason || 'Manual GL reversal by user'
          );
          setResult(updated);
          setSelectedBSItems([]);
          setSelectedGLItems([]);
          setSelectionMode('none');
          toast({ title: 'GL Reversal Marked', description: `${selectedGLItems.length} GL entries marked as reversal pair(s)` });
          return;
        } else {
          toast({ title: 'Cannot Mark Reversal', description: 'Select both debit and credit entries from GL to mark as reversal', variant: 'destructive' });
          return;
        }
      }

      // Case 3: Both BS and GL items selected — one-to-many or pairwise matching
      if (selectedBSItems.length > 0 && selectedGLItems.length > 0) {
        const bsKeys = selectedBSItems.map(i => i.uniqueKey);
        const glKeys = selectedGLItems.map(i => i.uniqueKey);

        const updated = applyOneToManyMatch(
          result,
          bsKeys,
          glKeys,
          reason || 'Manual match by user'
        );
        setResult(updated);
        setSelectedBSItems([]);
        setSelectedGLItems([]);
        setSelectionMode('none');

        const totalPairs = bsKeys.length === 1 && glKeys.length > 1
          ? glKeys.length
          : glKeys.length === 1 && bsKeys.length > 1
            ? bsKeys.length
            : Math.min(bsKeys.length, glKeys.length);

        toast({ title: 'Match Applied', description: `${totalPairs} pair(s) manually matched successfully` });
        return;
      }
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      toast({ title: 'Match Error', description: message, variant: 'destructive' });
    }
  }, [result, selectedBSItems, selectedGLItems, toast]);

  const handleAcceptPossibleMatch = useCallback((pm: PossibleMatch) => {
    if (!result || acceptingMatchId !== null) return;
    setAcceptingMatchId(pm.id);
    try {
      // Apply match client-side to avoid large API payloads
      const updated = applyManualMatch(
        result,
        pm.bsTransaction.uniqueKey,
        pm.glTransaction.uniqueKey,
        `Accepted possible match (confidence: ${pm.confidence}%) — ${pm.matchReason}`
      );
      setResult(updated);
      setSelectedBSItems([]);
      setSelectedGLItems([]);
      setSelectionMode('none');
      toast({ title: 'Match Accepted', description: `Possible match applied (${pm.confidence}% confidence)` });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      toast({ title: 'Match Error', description: message, variant: 'destructive' });
    } finally {
      setAcceptingMatchId(null);
    }
  }, [result, toast, acceptingMatchId]);

  const handleUnmatch = useCallback((bsUniqueKey: string, glUniqueKey: string) => {
    if (!result) return;
    
    try {
      // Apply unmatch client-side to avoid large API payloads
      const updated = unmatchPair(result, bsUniqueKey, glUniqueKey);
      setResult(updated);
      toast({ title: 'Unmatched', description: 'Match removed successfully' });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      toast({ title: 'Unmatch Error', description: message, variant: 'destructive' });
    }
  }, [result, toast]);

  const handleUnmatchGroup = useCallback((pairsToUnmatch: Array<{bsUniqueKey: string, glUniqueKey: string}>) => {
    if (!result) return;
    try {
      let updated = result;
      for (const p of pairsToUnmatch) {
        updated = unmatchPair(updated, p.bsUniqueKey, p.glUniqueKey);
      }
      setResult(updated);
      toast({ title: 'Group Unmatched', description: 'Matches removed successfully' });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      toast({ title: 'Unmatch Error', description: message, variant: 'destructive' });
    }
  }, [result, toast]);

  const handleExport = useCallback(async () => {
    if (!result) return;
    setExporting(true);
    try {
      const response = await fetch('/api/reconcile/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result),
      });
      
      if (!response.ok) throw new Error('Export failed');
      
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'BankReconciliation_Jan2026.xlsx';
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: 'Exported', description: 'Bank reconciliation file downloaded' });
    } catch {
      toast({ title: 'Export Error', description: 'Failed to export file', variant: 'destructive' });
    } finally {
      setExporting(false);
    }
  }, [result, toast]);

  const startManualMatch = useCallback(() => {
    setSelectionMode('active');
    setSelectedBSItems([]);
    setSelectedGLItems([]);
    setActiveTab('manual');
    toast({ title: 'Manual Matching Mode', description: 'Select entries from both sides to match' });
  }, [toast]);

  // Refresh Matches handler removed — possible matches are now auto-calculated

  const cancelManualMatch = useCallback(() => {
    setSelectionMode('none');
    setSelectedBSItems([]);
    setSelectedGLItems([]);
  }, []);

  // Get possible matches for a specific BS transaction (for inline display in manual match)
  const getPossibleMatchesForBS = useCallback((bsUniqueKey: string): PossibleMatch[] => {
    if (!result) return [];
    return result.possibleMatches.filter(pm => pm.bsTransaction.uniqueKey === bsUniqueKey);
  }, [result]);

  // Column definitions for each tab — with isAmount flag for professional sort
  const groupedMatchedPairs = useMemo(() => {
    if (!result) return [];
    
    const groups: Map<string, any[]> = new Map();
    const singles: any[] = [];
    
    result.matchedPairs.forEach(p => {
      const isManual = result.manualMatches.some(m => m.bsRowNo === p.bsRowNo && m.glRowNo === p.glRowNo);
      
      if (!isManual) {
        singles.push(p);
        return;
      }
      
      const mm = result.manualMatches.find(m => m.bsRowNo === p.bsRowNo && m.glRowNo === p.glRowNo);
      if (mm && mm.timestamp) {
        if (!groups.has(mm.timestamp)) {
          groups.set(mm.timestamp, []);
        }
        groups.get(mm.timestamp)!.push(p);
      } else {
        singles.push(p);
      }
    });
    
    const out = [...singles];
    groups.forEach(arr => {
      if (arr.length === 1) {
        out.push(arr[0]);
      } else {
        const first = arr[0];
        const isOneBs = arr.every(x => x.bsRowNo === first.bsRowNo);
        const isOneGl = arr.every(x => x.glRowNo === first.glRowNo);
        
        if (isOneBs) {
          out.push({
             ...first,
             isGrouped: true,
             groupedPairs: arr,
             bsDebit: first.bsDebit,
             bsCredit: first.bsCredit,
             glDebit: arr.reduce((s, x) => s + (x.glDebit || 0), 0) || null,
             glCredit: arr.reduce((s, x) => s + (x.glCredit || 0), 0) || null,
             glDetails: `Matched with ${arr.length} GL entries (Multi-Match)`
          });
        } else if (isOneGl) {
          out.push({
             ...first,
             isGrouped: true,
             groupedPairs: arr,
             glDebit: first.glDebit,
             glCredit: first.glCredit,
             bsDebit: arr.reduce((s, x) => s + (x.bsDebit || 0), 0) || null,
             bsCredit: arr.reduce((s, x) => s + (x.bsCredit || 0), 0) || null,
             bsParticulars: `Matched with ${arr.length} BS entries (Multi-Match)`
          });
        } else {
          out.push(...arr);
        }
      }
    });
    
    return out.sort((a, b) => a.id - b.id);
  }, [result]);

  const matchedColumns: ColumnDef<MatchedPair & { isGrouped?: boolean, groupedPairs?: any[] }>[] = useMemo(() => [
    { key: 'id', label: '#', width: '50px', sortable: false, filterable: false, getValue: (r) => r.id },
    { key: 'type', label: 'Type', width: '80px', getValue: (r) => r.type, render: (r) => (
      <Badge variant={r.type === 'Payment' ? 'destructive' : 'default'} className="text-xs">{r.type}</Badge>
    )},
    { key: 'matchSource', label: 'Source', width: '90px', sortable: false, filterable: false, getValue: (r) => {
      if (!result) return 'Auto';
      const isManual = result.manualMatches.some(m => m.bsRowNo === r.bsRowNo && m.glRowNo === r.glRowNo);
      return isManual ? 'Manual' : 'Auto';
    }, render: (r) => {
      if (!result) return null;
      const isManual = result.manualMatches.some(m => m.bsRowNo === r.bsRowNo && m.glRowNo === r.glRowNo);
      return (
        <Badge variant="outline" className={`text-[10px] ${isManual ? 'border-blue-300 text-blue-600' : 'border-emerald-300 text-emerald-600'}`}>
          {isManual ? 'Manual' : 'Auto'}
        </Badge>
      );
    }},
    { key: 'bsDate', label: 'BS Date', width: '100px', getValue: (r) => r.bsDate },
    { key: 'bsParticulars', label: 'BS Particulars', minWidth: '250px', wrap: true, getValue: (r) => r.bsParticulars },
    { key: 'glDetails', label: 'GL Details', minWidth: '250px', wrap: true, getValue: (r) => r.glDetails },
    { key: 'bsDebit', label: 'BS Debit', width: '110px', align: 'right', isAmount: true, getValue: (r) => r.bsDebit, render: (r) => r.bsDebit ? formatPKR(r.bsDebit) : '' },
    { key: 'bsCredit', label: 'BS Credit', width: '110px', align: 'right', isAmount: true, getValue: (r) => r.bsCredit, render: (r) => r.bsCredit ? formatPKR(r.bsCredit) : '' },
    { key: 'glDebit', label: 'GL Debit', width: '110px', align: 'right', isAmount: true, getValue: (r) => r.glDebit, render: (r) => r.glDebit ? formatPKR(r.glDebit) : '' },
    { key: 'glCredit', label: 'GL Credit', width: '110px', align: 'right', isAmount: true, getValue: (r) => r.glCredit, render: (r) => r.glCredit ? formatPKR(r.glCredit) : '' },
    { key: 'actions', label: '', width: '50px', sortable: false, filterable: false, render: (r) => {
      if (!result) return null;
      const isManual = result.manualMatches.some(m => m.bsRowNo === r.bsRowNo && m.glRowNo === r.glRowNo);
      return (
        <Button variant="ghost" size="sm" className="h-7 w-7 p-0" title={isManual ? 'Unmatch (Manual)' : 'Disconnect Match'} onClick={(e) => {
          e.stopPropagation();
          if (r.isGrouped && r.groupedPairs) {
             const toUnmatch: Array<{bsUniqueKey: string, glUniqueKey: string}> = [];
             r.groupedPairs.forEach(p => {
               const bs = result.bsTransactions.find(t => t.rowNo === p.bsRowNo);
               const gl = result.glTransactions.find(t => t.rowNo === p.glRowNo);
               if (bs && gl) toUnmatch.push({ bsUniqueKey: bs.uniqueKey, glUniqueKey: gl.uniqueKey });
             });
             if (toUnmatch.length > 0) handleUnmatchGroup(toUnmatch);
          } else {
             const bs = result.bsTransactions.find(t => t.rowNo === r.bsRowNo);
             const gl = result.glTransactions.find(t => t.rowNo === r.glRowNo);
             if (bs && gl) handleUnmatch(bs.uniqueKey, gl.uniqueKey);
          }
        }}>
          <Unlink className={`h-3 w-3 ${isManual ? 'text-red-500' : 'text-orange-500'}`} />
        </Button>
      );
    }},
  ], [result, handleUnmatch, handleUnmatchGroup]);

  // GL columns with BOTH Debit and Credit (for unpresented/uncleared tabs)
  const glColumnsBoth: ColumnDef<GLTransaction>[] = useMemo(() => [
    { key: 'rowNo', label: '#', width: '50px', sortable: false, filterable: false, getValue: (r) => r.rowNo },
    { key: 'postingDate', label: 'Posting Date', width: '110px', getValue: (r) => r.postingDate },
    { key: 'transNo', label: 'Trans No', width: '90px', getValue: (r) => r.transNo },
    { key: 'details', label: 'Details', minWidth: '300px', wrap: true, getValue: (r) => r.details },
    { key: 'debit', label: 'Debit', width: '130px', align: 'right', isAmount: true, getValue: (r) => r.debit, render: (r) => r.debit ? formatPKR(r.debit) : '' },
    { key: 'credit', label: 'Credit', width: '130px', align: 'right', isAmount: true, getValue: (r) => r.credit, render: (r) => r.credit ? formatPKR(r.credit) : '' },
  ], []);

  // BS columns with BOTH Debit and Credit (for unrecorded pay/rec tabs)
  const bsColumnsBoth: ColumnDef<BSTransaction>[] = useMemo(() => [
    { key: 'rowNo', label: '#', width: '50px', sortable: false, filterable: false, getValue: (r) => r.rowNo },
    { key: 'date', label: 'Date', width: '110px', getValue: (r) => r.date },
    { key: 'particulars', label: 'Particulars', minWidth: '300px', wrap: true, getValue: (r) => r.particulars },
    { key: 'debit', label: 'Debit', width: '130px', align: 'right', isAmount: true, getValue: (r) => r.debit, render: (r) => r.debit ? formatPKR(r.debit) : '' },
    { key: 'credit', label: 'Credit', width: '130px', align: 'right', isAmount: true, getValue: (r) => r.credit, render: (r) => r.credit ? formatPKR(r.credit) : '' },
  ], []);

  // GL columns with single amount field + select (for selection mode in manual match)
  const glColumns = useCallback((amountField: 'debit' | 'credit', amountLabel: string): ColumnDef<GLTransaction>[] => [
    { key: 'rowNo', label: '#', width: '50px', sortable: false, filterable: false, getValue: (r) => r.rowNo },
    { key: 'postingDate', label: 'Posting Date', width: '110px', getValue: (r) => r.postingDate },
    { key: 'transNo', label: 'Trans No', width: '90px', getValue: (r) => r.transNo },
    { key: 'details', label: 'Details', minWidth: '300px', wrap: true, getValue: (r) => r.details },
    { key: amountField, label: amountLabel, width: '130px', align: 'right', isAmount: true, getValue: (r) => r[amountField], render: (r) => formatPKR(r[amountField]) },
    { key: 'select', label: 'Select', width: '70px', sortable: false, filterable: false, render: (r) => {
      const isSelected = selectedGLItems.some(s => s.uniqueKey === r.uniqueKey);
      return selectionMode !== 'none' ? (
        <button
          className={`w-6 h-6 rounded-md border-2 flex items-center justify-center transition-all ${isSelected ? 'bg-blue-600 border-blue-600 text-white' : 'border-slate-300 hover:border-blue-400 text-transparent hover:text-slate-400'}`}
          onClick={(e) => {
            e.stopPropagation();
            const item: SelectedItem = { source: 'gl', uniqueKey: r.uniqueKey, particulars: r.details, amount: r[amountField] || 0, rowNo: r.rowNo, debit: r.debit, credit: r.credit };
            setSelectedGLItems(prev => isSelected ? prev.filter(s => s.uniqueKey !== r.uniqueKey) : [...prev, item]);
          }}
        >
          <Check className="h-3.5 w-3.5" />
        </button>
      ) : null;
    }},
  ], [selectionMode, selectedGLItems]);

  // BS columns with single amount field + select (for selection mode in manual match)
  const bsColumns = useCallback((amountField: 'debit' | 'credit', amountLabel: string): ColumnDef<BSTransaction>[] => [
    { key: 'rowNo', label: '#', width: '50px', sortable: false, filterable: false, getValue: (r) => r.rowNo },
    { key: 'date', label: 'Date', width: '110px', getValue: (r) => r.date },
    { key: 'particulars', label: 'Particulars', minWidth: '300px', wrap: true, getValue: (r) => r.particulars },
    { key: amountField, label: amountLabel, width: '130px', align: 'right', isAmount: true, getValue: (r) => r[amountField], render: (r) => formatPKR(r[amountField]) },
    { key: 'select', label: 'Select', width: '70px', sortable: false, filterable: false, render: (r) => {
      const isSelected = selectedBSItems.some(s => s.uniqueKey === r.uniqueKey);
      return selectionMode !== 'none' ? (
        <button
          className={`w-6 h-6 rounded-md border-2 flex items-center justify-center transition-all ${isSelected ? 'bg-emerald-600 border-emerald-600 text-white' : 'border-slate-300 hover:border-emerald-400 text-transparent hover:text-slate-400'}`}
          onClick={(e) => {
            e.stopPropagation();
            const item: SelectedItem = { source: 'bs', uniqueKey: r.uniqueKey, particulars: r.particulars, amount: r[amountField] || 0, rowNo: r.rowNo, debit: r.debit, credit: r.credit };
            setSelectedBSItems(prev => isSelected ? prev.filter(s => s.uniqueKey !== r.uniqueKey) : [...prev, item]);
          }}
        >
          <Check className="h-3.5 w-3.5" />
        </button>
      ) : null;
    }},
  ], [selectionMode, selectedBSItems]);

  const reversalColumns: ColumnDef<GLTransaction>[] = useMemo(() => [
    { key: 'rowNo', label: '#', width: '50px', sortable: false, filterable: false, getValue: (r) => r.rowNo },
    { key: 'postingDate', label: 'Posting Date', width: '110px', getValue: (r) => r.postingDate },
    { key: 'transNo', label: 'Trans No', width: '90px', getValue: (r) => r.transNo },
    { key: 'details', label: 'Details', minWidth: '300px', wrap: true, getValue: (r) => r.details },
    { key: 'debit', label: 'Debit', width: '120px', align: 'right', isAmount: true, getValue: (r) => r.debit, render: (r) => r.debit ? formatPKR(r.debit) : '' },
    { key: 'credit', label: 'Credit', width: '120px', align: 'right', isAmount: true, getValue: (r) => r.credit, render: (r) => r.credit ? formatPKR(r.credit) : '' },
    { key: 'balance', label: 'Balance', width: '130px', align: 'right', isAmount: true, getValue: (r) => (r.debit || 0) - (r.credit || 0), render: (r) => {
      const balance = (r.debit || 0) - (r.credit || 0);
      if (balance === 0) return <span className="text-slate-400">—</span>;
      return <span className={balance > 0 ? 'text-red-700 font-medium' : 'text-emerald-700 font-medium'}>{formatPKR(Math.abs(balance))} {balance > 0 ? 'Dr' : 'Cr'}</span>;
    }},
    { key: 'action', label: 'Action', width: '90px', sortable: false, filterable: false, render: (r) => (
      <Button variant="outline" size="sm" onClick={() => handleUnmarkReversal('gl', r.uniqueKey)}>
        Detach
      </Button>
    )},
  ], [handleUnmarkReversal]);

  const bsReversalColumns: ColumnDef<BSTransaction>[] = useMemo(() => [
    { key: 'rowNo', label: '#', width: '50px', sortable: false, filterable: false, getValue: (r) => r.rowNo },
    { key: 'date', label: 'Date', width: '110px', getValue: (r) => r.date },
    { key: 'particulars', label: 'Particulars', minWidth: '300px', wrap: true, getValue: (r) => r.particulars },
    { key: 'debit', label: 'Debit', width: '130px', align: 'right', isAmount: true, getValue: (r) => r.debit, render: (r) => r.debit ? formatPKR(r.debit) : '' },
    { key: 'credit', label: 'Credit', width: '130px', align: 'right', isAmount: true, getValue: (r) => r.credit, render: (r) => r.credit ? formatPKR(r.credit) : '' },
    { key: 'action', label: 'Action', width: '90px', sortable: false, filterable: false, render: (r) => (
      <Button variant="outline" size="sm" onClick={() => handleUnmarkReversal('bs', r.uniqueKey)}>
        Detach
      </Button>
    )},
  ], [handleUnmarkReversal]);

  const manualAdjColumns: ColumnDef<ManualMatch>[] = useMemo(() => [
    { key: 'id', label: '#', width: '50px', sortable: false, filterable: false, render: (_r, i) => i + 1 },
    { key: 'timestamp', label: 'Timestamp', width: '150px', getValue: (r) => r.timestamp, render: (r) => (
      <span className="text-[11px] font-mono">{r.timestamp ? new Date(r.timestamp).toLocaleString() : '—'}</span>
    )},
    { key: 'type', label: 'Type', width: '80px', getValue: (r) => r.type, render: (r) => (
      <Badge variant={r.type === 'Payment' ? 'destructive' : 'default'} className="text-xs">{r.type}</Badge>
    )},
    { key: 'bsParticulars', label: 'BS Particulars', minWidth: '250px', wrap: true, getValue: (r) => r.bsParticulars },
    { key: 'bsAmount', label: 'BS Amount', width: '120px', align: 'right', isAmount: true, getValue: (r) => r.bsAmount, render: (r) => formatPKR(r.bsAmount) },
    { key: 'glDetails', label: 'GL Details', minWidth: '250px', wrap: true, getValue: (r) => r.glDetails },
    { key: 'glAmount', label: 'GL Amount', width: '120px', align: 'right', isAmount: true, getValue: (r) => r.glAmount, render: (r) => formatPKR(r.glAmount) },
    { key: 'diff', label: 'Amount Diff', width: '110px', align: 'right', sortable: false, render: (r) => {
      const diff = Math.abs(r.bsAmount - r.glAmount);
      return diff > 0 ? <span className="text-amber-600 font-mono">{formatPKR(diff)}</span> : <span className="text-emerald-600">—</span>;
    }},
    { key: 'reason', label: 'Reason', minWidth: '200px', wrap: true, getValue: (r) => r.reason, render: (r) => (
      <span className="text-[11px] text-slate-600">{r.reason || 'Manual match by user'}</span>
    )},
  ], []);

  // Reversal entries - use all entries (not filtered)
  const reversalCount = result?.reversalEntries?.length || 0;
  const bsReversalCount = result?.bsReversalEntries?.length || 0;
  const totalReversalCount = reversalCount + bsReversalCount;
  const manualMatchCount = result?.manualMatches?.length || 0;

  // Manual match columns — fixed layout for compact side-by-side view
  const manualBSCols: ColumnDef<BSTransaction>[] = useMemo(() => [
    { key: 'rowNo', label: '#', width: '35px', sortable: false, filterable: false, getValue: (r) => r.rowNo },
    { key: 'date', label: 'Date', width: '80px', getValue: (r) => r.date },
    { key: 'particulars', label: 'Remarks', width: '40%', wrap: true, getValue: (r) => r.particulars },
    { key: 'debit', label: 'Debit', width: '100px', align: 'right', isAmount: true, getValue: (r) => r.debit, render: (r) => r.debit ? formatPKR(r.debit) : '' },
    { key: 'credit', label: 'Credit', width: '100px', align: 'right', isAmount: true, getValue: (r) => r.credit, render: (r) => r.credit ? formatPKR(r.credit) : '' },
    { key: 'select', label: 'Sel', width: '42px', sortable: false, filterable: false, render: (r) => {
      const isSelected = selectedBSItems.some(s => s.uniqueKey === r.uniqueKey);
      const selIndex = selectedBSItems.findIndex(s => s.uniqueKey === r.uniqueKey);
      return (
        <button
          className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all ${isSelected ? 'bg-emerald-600 border-emerald-600 text-white' : 'border-slate-300 hover:border-emerald-400 text-transparent hover:text-slate-400'}`}
          onClick={(e) => {
            e.stopPropagation();
            const item: SelectedItem = { source: 'bs', uniqueKey: r.uniqueKey, particulars: r.particulars, amount: r.debit || r.credit || 0, rowNo: r.rowNo, debit: r.debit, credit: r.credit };
            setSelectedBSItems(prev => isSelected ? prev.filter(s => s.uniqueKey !== r.uniqueKey) : [...prev, item]);
          }}
        >
          {isSelected ? <span className="text-[9px] font-bold">{selIndex + 1}</span> : <Check className="h-3 w-3" />}
        </button>
      );
    }},
  ], [selectedBSItems, selectionMode]);

  const manualGLCols: ColumnDef<GLTransaction>[] = useMemo(() => [
    { key: 'rowNo', label: '#', width: '35px', sortable: false, filterable: false, getValue: (r) => r.rowNo },
    { key: 'postingDate', label: 'Date', width: '80px', getValue: (r) => r.postingDate },
    { key: 'details', label: 'Remarks', width: '40%', wrap: true, getValue: (r) => r.details },
    { key: 'debit', label: 'Debit', width: '100px', align: 'right', isAmount: true, getValue: (r) => r.debit, render: (r) => r.debit ? formatPKR(r.debit) : '' },
    { key: 'credit', label: 'Credit', width: '100px', align: 'right', isAmount: true, getValue: (r) => r.credit, render: (r) => r.credit ? formatPKR(r.credit) : '' },
    { key: 'select', label: 'Sel', width: '42px', sortable: false, filterable: false, render: (r) => {
      const isSelected = selectedGLItems.some(s => s.uniqueKey === r.uniqueKey);
      const selIndex = selectedGLItems.findIndex(s => s.uniqueKey === r.uniqueKey);
      return (
        <button
          className={`w-5 h-5 rounded-md border-2 flex items-center justify-center transition-all ${isSelected ? 'bg-blue-600 border-blue-600 text-white' : 'border-slate-300 hover:border-blue-400 text-transparent hover:text-slate-400'}`}
          onClick={(e) => {
            e.stopPropagation();
            const item: SelectedItem = { source: 'gl', uniqueKey: r.uniqueKey, particulars: r.details, amount: r.debit || r.credit || 0, rowNo: r.rowNo, debit: r.debit, credit: r.credit };
            setSelectedGLItems(prev => isSelected ? prev.filter(s => s.uniqueKey !== r.uniqueKey) : [...prev, item]);
          }}
        >
          {isSelected ? <span className="text-[9px] font-bold">{selIndex + 1}</span> : <Check className="h-3 w-3" />}
        </button>
      );
    }},
  ], [selectedGLItems]);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 to-slate-100">
      {/* Header */}
      <header className="border-b bg-white/80 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-[1800px] mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center gap-3">
              <div className="h-10 w-10 rounded-lg bg-emerald-600 flex items-center justify-center">
                <FileSpreadsheet className="h-6 w-6 text-white" />
              </div>
              <div>
                <h1 className="text-lg font-bold text-slate-900">Bank Reconciliation System</h1>
                <p className="text-xs text-slate-500">Bank Statement vs GL — Automated Matching</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {result && (
                <>
                  <GlobalSearch result={result} value={globalSearch} onChange={setGlobalSearch} />
                  <Button variant="outline" size="sm" onClick={startManualMatch}>
                    <Link2 className="h-4 w-4 mr-1" /> Manual Match
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleExport} disabled={exporting}>
                    {exporting ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Download className="h-4 w-4 mr-1" />}
                    Export XLSX
                  </Button>
                  <input 
                    type="file" 
                    accept=".xlsx,.xls,.csv" 
                    className="hidden" 
                    ref={updateGLRef} 
                    onChange={handleUpdateGL} 
                  />
                  <Button variant="default" size="sm" onClick={() => updateGLRef.current?.click()} disabled={updatingGL} className="bg-emerald-600 hover:bg-emerald-700">
                    {updatingGL ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <FolderOpen className="h-4 w-4 mr-1" />}
                    Upload Updated GL
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleSaveSession}>
                    <Save className="h-4 w-4 mr-1" /> Save Session
                  </Button>
                  <Button variant="outline" size="sm" onClick={handleExportSession}>
                    <Download className="h-4 w-4 mr-1" /> Export Session
                  </Button>
                </>
              )}
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-[1800px] mx-auto px-4 sm:px-6 lg:px-8 py-6">
        {/* Saved Sessions Banner */}
        {!result && savedSessions.length > 0 && !showMappingUI && (
          <Card className="mb-4 border-blue-200 bg-blue-50">
            <CardContent className="py-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <FolderOpen className="h-5 w-5 text-blue-600" />
                  <div>
                    <p className="text-sm font-medium text-blue-800">
                      {savedSessions.length} Saved Session{savedSessions.length !== 1 ? 's' : ''} Found
                    </p>
                    <p className="text-xs text-blue-600">Resume your previous reconciliation work</p>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" variant="outline" onClick={() => setShowSessions(!showSessions)}>
                    {showSessions ? 'Hide' : 'Show'} Sessions
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => sessionImportRef.current?.click()}>
                    <Upload className="h-3 w-3 mr-1" /> Import Session
                  </Button>
                  <input
                    ref={sessionImportRef}
                    type="file"
                    accept=".json"
                    className="hidden"
                    onChange={handleImportSession}
                  />
                </div>
              </div>
              {showSessions && (
                <div className="mt-3 space-y-2">
                  {savedSessions.map(session => (
                    <div key={session.id} className="flex items-center justify-between bg-white rounded-lg px-3 py-2 border border-blue-100">
                      <div>
                        <p className="text-sm font-medium text-slate-800">{session.name}</p>
                        <p className="text-xs text-slate-500">Saved: {new Date(session.savedAt).toLocaleString()}</p>
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" className="bg-blue-600 hover:bg-blue-700" onClick={() => handleLoadSession(session)}>
                          <ChevronRight className="h-3 w-3 mr-1" /> Resume
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => handleDeleteSession(session.id)}>
                          <Trash2 className="h-3 w-3 text-red-400" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* Column Mapping Preview UI */}
        {showMappingUI && previewData && (
          <Card className="mb-6 border-2 border-purple-300">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Settings2 className="h-5 w-5 text-purple-600" />
                Column Mapping — Verify & Adjust
              </CardTitle>
              <CardDescription>
                The system auto-detected your column structure. Adjust any incorrect mappings before running reconciliation.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="mb-6 p-4 border rounded-lg bg-slate-50 flex items-center justify-between border-purple-100 shadow-sm">
                <div>
                  <h4 className="font-medium text-slate-800 flex items-center gap-2"><Sparkles className="h-4 w-4 text-amber-500" /> Auto-Match Threshold</h4>
                  <p className="text-xs text-slate-500 mt-1">Possible matches with a confidence score above this percentage will be automatically matched.</p>
                </div>
                <div className="flex items-center gap-2 bg-white px-3 py-1.5 rounded-md border shadow-inner">
                  <Input 
                    type="number" 
                    value={autoMatchThreshold} 
                    onChange={e => setAutoMatchThreshold(parseInt(e.target.value) || 0)} 
                    className="w-16 h-8 text-center font-bold text-purple-700 border-none shadow-none focus-visible:ring-0 text-lg p-0" 
                    min={10} max={100} 
                  />
                  <span className="text-sm font-bold text-slate-400">%</span>
                </div>
              </div>
              <div className="space-y-6">
                {previewData.previews.map((fp: FilePreview) => 
                  fp.sheets.map((sp: SheetPreview) => {
                    const key = `${fp.fileName}::${sp.sheetName}`;
                    const mappings = editingMappings[key] || sp.mappings;
                    return (
                      <div key={key} className="border rounded-lg p-4">
                        <div className="flex items-center gap-2 mb-3">
                          <Badge variant={sp.detectedType === 'bs' ? 'default' : 'secondary'}>
                            {sp.detectedType === 'bs' ? 'Bank Statement' : sp.detectedType === 'gl' ? 'General Ledger' : 'Unknown'}
                          </Badge>
                          <span className="text-sm text-slate-600">Sheet: <b>{sp.sheetName}</b></span>
                          <span className="text-xs text-slate-400">from {fp.fileName}</span>
                        </div>
                        <div className="overflow-x-auto">
                          <table className="w-full text-sm">
                            <thead>
                              <tr className="border-b">
                                <th className="text-left py-2 px-2 w-48">Field</th>
                                <th className="text-left py-2 px-2 w-64">Detected Column</th>
                                <th className="text-left py-2 px-2">Sample Data</th>
                                <th className="text-center py-2 px-2 w-20">Confidence</th>
                              </tr>
                            </thead>
                            <tbody>
                              {mappings.map((mapping: ColumnMapping, idx: number) => (
                                <tr key={mapping.field} className="border-b border-slate-100">
                                  <td className="py-2 px-2">
                                    <span className="font-medium">{mapping.label}</span>
                                    {mapping.required && <span className="text-red-500 ml-1">*</span>}
                                  </td>
                                  <td className="py-2 px-2">
                                    <select
                                      className="w-full border rounded px-2 py-1 text-sm"
                                      value={mapping.columnIndex ?? -1}
                                      onChange={(e) => {
                                        const val = parseInt(e.target.value);
                                        updateMapping(key, idx, val >= 0 ? val : null);
                                      }}
                                    >
                                      <option value={-1}>— Not Mapped —</option>
                                      {sp.headers.map((header: string, colIdx: number) => (
                                        <option key={colIdx} value={colIdx}>
                                          Col {colIdx + 1}: {header || `(empty)`}
                                        </option>
                                      ))}
                                    </select>
                                  </td>
                                  <td className="py-2 px-2 text-xs text-slate-500">
                                    {mapping.sampleData.slice(0, 3).map((val: unknown, i: number) => (
                                      <span key={i} className="inline-block bg-slate-100 rounded px-1.5 py-0.5 mr-1 mb-0.5">
                                        {val instanceof Date ? val.toISOString().split('T')[0] : String(val ?? '—')}
                                      </span>
                                    ))}
                                  </td>
                                  <td className="py-2 px-2 text-center">
                                    {mapping.columnIndex !== null ? (
                                      <select
                                        className={`text-[10px] font-semibold rounded px-1.5 py-1 border-0 ${
                                          mapping.confidence >= 80
                                            ? 'bg-emerald-100 text-emerald-700'
                                            : mapping.confidence >= 50
                                            ? 'bg-amber-100 text-amber-700'
                                            : 'bg-red-100 text-red-700'
                                        }`}
                                        value={mapping.confidence >= 80 ? 'high' : mapping.confidence >= 50 ? 'medium' : 'low'}
                                        onChange={(e) => {
                                          const level = e.target.value;
                                          updateConfidence(key, idx, level === 'high' ? 90 : level === 'medium' ? 65 : 30);
                                        }}
                                      >
                                        <option value="high">High</option>
                                        <option value="medium">Medium</option>
                                        <option value="low">Low</option>
                                      </select>
                                    ) : (
                                      <Badge variant="outline" className="text-[10px]">None</Badge>
                                    )}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    );
                  })
                )}
                <div className="flex gap-3">
                  <Button
                    onClick={handleReconcileWithMappings}
                    disabled={loading}
                    className="bg-emerald-600 hover:bg-emerald-700 text-white flex-1"
                    size="lg"
                  >
                    {loading ? (
                      <><Loader2 className="h-5 w-5 mr-2 animate-spin" />Processing...</>
                    ) : (
                      <><ArrowRightLeft className="h-5 w-5 mr-2" />Confirm Mappings & Run Reconciliation</>
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => {
                      setShowMappingUI(false);
                      setPreviewData(null);
                    }}
                    size="lg"
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Upload Section */}
        {!result && !showMappingUI && (
          <Card className="mb-6">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Upload className="h-5 w-5 text-emerald-600" />
                Upload Bank Statement & GL Ledger
              </CardTitle>
              <CardDescription>
                Upload your Excel files to begin automatic reconciliation. The system will match transactions by cheque number, PSID, amount, and description.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="flex gap-2">
                  <Button
                    variant={uploadMode === 'combined' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setUploadMode('combined')}
                  >
                    Single File (BS + GL sheets)
                  </Button>
                  <Button
                    variant={uploadMode === 'separate' ? 'default' : 'outline'}
                    size="sm"
                    onClick={() => setUploadMode('separate')}
                  >
                    Separate Files
                  </Button>
                </div>

                {uploadMode === 'combined' ? (
                  <div
                    className="border-2 border-dashed border-slate-300 rounded-lg p-8 text-center hover:border-emerald-400 transition-colors cursor-pointer"
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <FileSpreadsheet className="h-12 w-12 mx-auto text-slate-400 mb-3" />
                    <p className="text-sm font-medium text-slate-700">
                      {combinedFile ? combinedFile.name : 'Click to upload Excel file with BS & GL sheets'}
                    </p>
                    <p className="text-xs text-slate-500 mt-1">
                      Supports .xlsx files with &quot;BS&quot; and &quot;Sheet1&quot;/&quot;GL&quot; tabs
                    </p>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept=".xlsx,.xls"
                      className="hidden"
                      onChange={(e) => setCombinedFile(e.target.files?.[0] || null)}
                    />
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div
                      className="border-2 border-dashed border-slate-300 rounded-lg p-6 text-center hover:border-emerald-400 transition-colors cursor-pointer"
                      onClick={() => bsInputRef.current?.click()}
                    >
                      <FileSpreadsheet className="h-8 w-8 mx-auto text-slate-400 mb-2" />
                      <p className="text-sm font-medium text-slate-700">
                        {bsFile ? bsFile.name : 'Bank Statement (.xlsx)'}
                      </p>
                      <p className="text-xs text-slate-500 mt-1">Date | Particulars | Debit | Credit | Balance</p>
                      <input
                        ref={bsInputRef}
                        type="file"
                        accept=".xlsx,.xls"
                        className="hidden"
                        onChange={(e) => setBsFile(e.target.files?.[0] || null)}
                      />
                    </div>
                    <div
                      className="border-2 border-dashed border-slate-300 rounded-lg p-6 text-center hover:border-emerald-400 transition-colors cursor-pointer"
                      onClick={() => glInputRef.current?.click()}
                    >
                      <FileSpreadsheet className="h-8 w-8 mx-auto text-slate-400 mb-2" />
                      <p className="text-sm font-medium text-slate-700">
                        {glFile ? glFile.name : 'General Ledger (.xlsx)'}
                      </p>
                      <p className="text-xs text-slate-500 mt-1">Posting Date | Trans No | Details | Debit | Credit</p>
                      <input
                        ref={glInputRef}
                        type="file"
                        accept=".xlsx,.xls"
                        className="hidden"
                        onChange={(e) => setGlFile(e.target.files?.[0] || null)}
                      />
                    </div>
                  </div>
                )}

                <div className="flex gap-3">
                  <Button
                    onClick={handlePreview}
                    disabled={previewing || loading}
                    className="flex-1 bg-purple-600 hover:bg-purple-700 text-white"
                    size="lg"
                  >
                    {previewing ? (
                      <><Loader2 className="h-5 w-5 mr-2 animate-spin" />Detecting Columns...</>
                    ) : (
                      <><Settings2 className="h-5 w-5 mr-2" />Preview & Map Columns</>
                    )}
                  </Button>
                  <Button
                    onClick={handleUpload}
                    disabled={loading || previewing}
                    variant="outline"
                    className="flex-1 border-emerald-600 text-emerald-700 hover:bg-emerald-50"
                    size="lg"
                  >
                    {loading ? (
                      <><Loader2 className="h-5 w-5 mr-2 animate-spin" />Processing...</>
                    ) : (
                      <><ArrowRightLeft className="h-5 w-5 mr-2" />Quick Run (Default Format)</>
                    )}
                  </Button>
                </div>
                <p className="text-xs text-center text-slate-500">
                  Use <b>Preview & Map Columns</b> for any bank format — auto-detects columns from most Pakistani bank formats.
                  <br />Use <b>Quick Run</b> if your file already matches the standard format.
                </p>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Manual Match Banner */}
        {selectionMode === 'active' && result && (
          <Card className="mb-4 border-2 border-amber-400 bg-amber-50">
            <CardContent className="py-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Info className="h-5 w-5 text-amber-600" />
                  <div>
                    <p className="text-sm font-medium text-amber-800">
                      Manual Matching Mode — Select entries from both sides, then click Match
                    </p>
                    <div className="flex gap-4 mt-1 text-xs text-amber-700">
                      {selectedBSItems.length > 0 && <span>BS: {selectedBSItems.length} selected (PKR {formatPKR(selectedBSItems.reduce((s, i) => s + i.amount, 0))})</span>}
                      {selectedGLItems.length > 0 && <span>GL: {selectedGLItems.length} selected (PKR {formatPKR(selectedGLItems.reduce((s, i) => s + i.amount, 0))})</span>}
                    </div>
                  </div>
                </div>
                <div className="flex gap-2">
                  {selectedBSItems.length > 0 && selectedGLItems.length > 0 && (
                    <Button size="sm" onClick={() => handleManualMatch()} className="bg-emerald-600 hover:bg-emerald-700">
                      <Link2 className="h-4 w-4 mr-1" /> Confirm Match ({selectedBSItems.length === 1 && selectedGLItems.length > 1 ? selectedGLItems.length : selectedGLItems.length === 1 && selectedBSItems.length > 1 ? selectedBSItems.length : Math.min(selectedBSItems.length, selectedGLItems.length)} pairs)
                    </Button>
                  )}
                  {selectedBSItems.length > 0 && selectedGLItems.length === 0 && (() => {
                    const hasDebit = selectedBSItems.some(i => i.debit && i.debit > 0);
                    const hasCredit = selectedBSItems.some(i => i.credit && i.credit > 0);
                    return hasDebit && hasCredit ? (
                      <Button size="sm" onClick={() => handleManualMatch()} className="bg-orange-600 hover:bg-orange-700">
                        <RefreshCw className="h-4 w-4 mr-1" /> Mark as BS Reversal ({selectedBSItems.length} entries)
                      </Button>
                    ) : null;
                  })()}
                  {selectedGLItems.length > 0 && selectedBSItems.length === 0 && (() => {
                    const hasDebit = selectedGLItems.some(i => i.debit && i.debit > 0);
                    const hasCredit = selectedGLItems.some(i => i.credit && i.credit > 0);
                    return hasDebit && hasCredit ? (
                      <Button size="sm" onClick={() => handleManualMatch()} className="bg-orange-600 hover:bg-orange-700">
                        <RefreshCw className="h-4 w-4 mr-1" /> Mark as GL Reversal ({selectedGLItems.length} entries)
                      </Button>
                    ) : null;
                  })()}
                  <Button size="sm" variant="outline" onClick={cancelManualMatch}>
                    Cancel
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Results */}
        {result && (
          <Tabs value={activeTab} onValueChange={setActiveTab}>
            <TabsList className="mb-4 flex flex-wrap h-auto gap-1">
              <TabsTrigger value="summary" className="text-xs sm:text-sm">
                <CheckCircle2 className="h-4 w-4 mr-1" /> Summary
              </TabsTrigger>
              <TabsTrigger value="matched" className="text-xs sm:text-sm">
                Matched ({result.summary.matchedPairs.count})
              </TabsTrigger>
              <TabsTrigger value="unpresented" className="text-xs sm:text-sm">
                Un Presented ({result.summary.unPresentedCheques.count})
              </TabsTrigger>
              <TabsTrigger value="uncleared" className="text-xs sm:text-sm">
                Un Cleared ({result.summary.unClearedReceipts.count})
              </TabsTrigger>
              <TabsTrigger value="unrecorded-pay" className="text-xs sm:text-sm">
                Un Recorded Pay ({result.summary.unRecordedPayments.count})
              </TabsTrigger>
              <TabsTrigger value="unrecorded-rec" className="text-xs sm:text-sm">
                Un Recorded Rec ({result.summary.unRecordedReceipts.count})
              </TabsTrigger>
              <TabsTrigger value="reversals" className="text-xs sm:text-sm">
                <RefreshCw className="h-4 w-4 mr-1" /> Reversals ({totalReversalCount})
              </TabsTrigger>
              <TabsTrigger value="manual-adj" className="text-xs sm:text-sm">
                <Clock className="h-4 w-4 mr-1" /> Adjustments ({manualMatchCount})
              </TabsTrigger>
              <TabsTrigger value="possible-matches" className="text-xs sm:text-sm">
                <Sparkles className="h-4 w-4 mr-1" /> Possible Matches ({result.possibleMatches.length})
              </TabsTrigger>
              <TabsTrigger value="manual" className="text-xs sm:text-sm">
                <Link2 className="h-4 w-4 mr-1" /> Manual Match
              </TabsTrigger>
            </TabsList>

            {/* Summary Tab */}
            <TabsContent value="summary">
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-6">
                <Card className="lg:col-span-2">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">Bank Reconciliation Statement</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <table className="w-full">
                      <tbody>
                        <tr className="border-b">
                          <td className="py-2 font-medium w-[400px]">GL Balance / Company Ledger Closing Balance</td>
                          <td className="py-2 text-right font-mono">{formatPKR(result.summary.glBalance)}</td>
                          <td className="py-2"><Badge variant="secondary">Base</Badge></td>
                        </tr>
                        <tr className="border-b bg-emerald-50">
                          <td className="py-2 font-medium">Add: Un Presented Cheques (+)</td>
                          <td className="py-2 text-right font-mono text-emerald-700">+ {formatPKR(result.summary.unPresentedCheques.total)}</td>
                          <td className="py-2"><Badge className="bg-emerald-100 text-emerald-700">+</Badge></td>
                        </tr>
                        <tr className="border-b bg-red-50">
                          <td className="py-2 font-medium">Less: Un Cleared Receipts (−)</td>
                          <td className="py-2 text-right font-mono text-red-700">− {formatPKR(result.summary.unClearedReceipts.total)}</td>
                          <td className="py-2"><Badge className="bg-red-100 text-red-700">−</Badge></td>
                        </tr>
                        <tr className="border-b bg-red-50">
                          <td className="py-2 font-medium">Less: Un Recorded Payments (−)</td>
                          <td className="py-2 text-right font-mono text-red-700">− {formatPKR(result.summary.unRecordedPayments.total)}</td>
                          <td className="py-2"><Badge className="bg-red-100 text-red-700">−</Badge></td>
                        </tr>
                        <tr className="border-b bg-emerald-50">
                          <td className="py-2 font-medium">Add: Un Recorded Receipts (+)</td>
                          <td className="py-2 text-right font-mono text-emerald-700">+ {formatPKR(result.summary.unRecordedReceipts.total)}</td>
                          <td className="py-2"><Badge className="bg-emerald-100 text-emerald-700">+</Badge></td>
                        </tr>
                        {result.summary.bsReversals.netImpact !== 0 && (
                          <tr className="border-b bg-orange-50">
                            <td className="py-2 font-medium">
                              Less: BS Reversal Net Impact (−)
                              <span className="text-[10px] text-orange-600 ml-2">
                                (Dr {formatPKR(result.summary.bsReversals.totalDebit)} − Cr {formatPKR(result.summary.bsReversals.totalCredit)})
                              </span>
                            </td>
                            <td className="py-2 text-right font-mono text-orange-700">− {formatPKR(Math.abs(result.summary.bsReversals.netImpact))}</td>
                            <td className="py-2"><Badge className="bg-orange-100 text-orange-700">−</Badge></td>
                          </tr>
                        )}
                        <tr className="border-t-2 border-slate-300">
                          <td colSpan={3} className="py-1"></td>
                        </tr>
                        <tr className="border-b bg-slate-100 font-bold">
                          <td className="py-2">Adjusted GL Balance (Total)</td>
                          <td className="py-2 text-right font-mono text-lg">{formatPKR(result.summary.adjustedGLBalance)}</td>
                          <td className="py-2"><Badge variant="secondary">ADJ</Badge></td>
                        </tr>
                        <tr className="border-b">
                          <td className="py-2 font-medium">BS Balance / Bank Statement Closing Balance</td>
                          <td className="py-2 text-right font-mono">{formatPKR(result.summary.bsBalance)}</td>
                          <td className="py-2"><Badge variant="secondary">BS</Badge></td>
                        </tr>
                        <tr className={result.summary.difference === 0 ? 'bg-emerald-100' : 'bg-amber-100'}>
                          <td className="py-2 font-bold text-base">
                            Difference (ZERO = Fully Reconciled)
                          </td>
                          <td className="py-2 text-right font-mono text-lg font-bold">
                            {formatPKR(result.summary.difference)}
                          </td>
                          <td className="py-2">
                            {result.summary.difference === 0 ? (
                              <Badge className="bg-emerald-600 text-white"><CheckCircle2 className="h-3 w-3 mr-1" /> Reconciled</Badge>
                            ) : (
                              <Badge className="bg-amber-500 text-white"><AlertTriangle className="h-3 w-3 mr-1" /> Gap</Badge>
                            )}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">Matching Statistics</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="p-3 rounded-lg bg-slate-50">
                        <p className="text-xs text-slate-500">BS Total Entries</p>
                        <p className="text-xl font-bold">{result.bsTransactions.length}</p>
                      </div>
                      <div className="p-3 rounded-lg bg-slate-50">
                        <p className="text-xs text-slate-500">GL Total Entries</p>
                        <p className="text-xl font-bold">{result.glTransactions.length}</p>
                      </div>
                      <div className="p-3 rounded-lg bg-emerald-50">
                        <p className="text-xs text-emerald-600">Auto-Matched</p>
                        <p className="text-xl font-bold text-emerald-700">{result.summary.matchedPairs.count}</p>
                      </div>
                      <div className="p-3 rounded-lg bg-blue-50">
                        <p className="text-xs text-blue-600">Manual Matches</p>
                        <p className="text-xl font-bold text-blue-700">{result.manualMatches.length}</p>
                      </div>
                      <div className="p-3 rounded-lg bg-purple-50">
                        <p className="text-xs text-purple-600">Reversals</p>
                        <p className="text-xl font-bold text-purple-700">{totalReversalCount}</p>
                      </div>
                      <div className="p-3 rounded-lg bg-amber-50">
                        <p className="text-xs text-amber-600">Possible Matches</p>
                        <p className="text-xl font-bold text-amber-700">{result.possibleMatches?.length || 0}</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">Cross-Check Verification</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <table className="w-full">
                      <tbody>
                        <tr className="border-b">
                          <td className="py-2 text-xs">BS Debit Matched = GL Credit Matched</td>
                          <td className="py-2 text-right font-mono text-xs">{formatPKR(result.summary.totalBSDebitMatched)}</td>
                          <td className="py-2 text-right font-mono text-xs">{formatPKR(result.summary.totalGLCreditMatched)}</td>
                          <td className="py-2 text-right">
                            {result.summary.totalBSDebitMatched === result.summary.totalGLCreditMatched ? (
                              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                            ) : (
                              <XCircle className="h-4 w-4 text-red-600" />
                            )}
                          </td>
                        </tr>
                        <tr>
                          <td className="py-2 text-xs">BS Credit Matched = GL Debit Matched</td>
                          <td className="py-2 text-right font-mono text-xs">{formatPKR(result.summary.totalBSCreditMatched)}</td>
                          <td className="py-2 text-right font-mono text-xs">{formatPKR(result.summary.totalGLDebitMatched)}</td>
                          <td className="py-2 text-right">
                            {result.summary.totalBSCreditMatched === result.summary.totalGLDebitMatched ? (
                              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                            ) : (
                              <XCircle className="h-4 w-4 text-red-600" />
                            )}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                    <div className="grid grid-cols-2 gap-3 mt-3">
                      <div className="p-3 rounded-lg bg-orange-50">
                        <p className="text-xs text-orange-600">Un Presented Cheques</p>
                        <p className="font-bold text-orange-700">{result.summary.unPresentedCheques.count} ({formatCompact(result.summary.unPresentedCheques.total)})</p>
                      </div>
                      <div className="p-3 rounded-lg bg-blue-50">
                        <p className="text-xs text-blue-600">Un Cleared Receipts</p>
                        <p className="font-bold text-blue-700">{result.summary.unClearedReceipts.count} ({formatCompact(result.summary.unClearedReceipts.total)})</p>
                      </div>
                      <div className="p-3 rounded-lg bg-red-50">
                        <p className="text-xs text-red-600">Un Recorded Payments</p>
                        <p className="font-bold text-red-700">{result.summary.unRecordedPayments.count} ({formatCompact(result.summary.unRecordedPayments.total)})</p>
                      </div>
                      <div className="p-3 rounded-lg bg-emerald-50">
                        <p className="text-xs text-emerald-600">Un Recorded Receipts</p>
                        <p className="font-bold text-emerald-700">{result.summary.unRecordedReceipts.count} ({formatCompact(result.summary.unRecordedReceipts.total)})</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>

                {/* Balance In GL */}
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">Balance In GL</CardTitle>
                    <CardDescription>Opening Balance + Debit − Credit</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <table className="w-full">
                      <tbody>
                        <tr className="border-b">
                          <td className="py-1.5 text-xs font-medium text-slate-600">Opening Balance</td>
                          <td className="py-1.5 text-right font-mono text-xs">0</td>
                        </tr>
                        <tr className="border-b bg-emerald-50">
                          <td className="py-1.5 text-xs font-medium text-emerald-700">+ Debit</td>
                          <td className="py-1.5 text-right font-mono text-xs text-emerald-700">+ {formatPKR(result.summary.glTotalDebit)}</td>
                        </tr>
                        <tr className="border-b bg-red-50">
                          <td className="py-1.5 text-xs font-medium text-red-700">− Credit</td>
                          <td className="py-1.5 text-right font-mono text-xs text-red-700">− {formatPKR(result.summary.glTotalCredit)}</td>
                        </tr>
                        <tr className="border-t-2 border-slate-300 font-bold">
                          <td className="py-2 text-xs">= Closing Balance</td>
                          <td className="py-2 text-right font-mono text-sm">{formatPKR(result.summary.glComputedBalance)}</td>
                        </tr>
                        <tr className="border-b">
                          <td className="py-1 text-[10px] text-slate-400">Statement Closing Balance</td>
                          <td className="py-1 text-right font-mono text-[10px] text-slate-400">{formatPKR(result.summary.glBalance)}</td>
                        </tr>
                        <tr>
                          <td className="py-1 text-[10px]" colSpan={2}>
                            {result.summary.glComputedBalance === result.summary.glBalance ? (
                              <span className="text-emerald-600 flex items-center gap-1"><CheckCircle2 className="h-3 w-3" /> Verified</span>
                            ) : (
                              <span className="text-amber-600 flex items-center gap-1"><AlertTriangle className="h-3 w-3" /> Variance: {formatPKR(Math.abs(result.summary.glComputedBalance - result.summary.glBalance))}</span>
                            )}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </CardContent>
                </Card>

                {/* Balance In BS */}
                <Card>
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base">Balance In BS</CardTitle>
                    <CardDescription>Opening Balance − Debit + Credit</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <table className="w-full">
                      <tbody>
                        <tr className="border-b">
                          <td className="py-1.5 text-xs font-medium text-slate-600">Opening Balance</td>
                          <td className="py-1.5 text-right font-mono text-xs">0</td>
                        </tr>
                        <tr className="border-b bg-red-50">
                          <td className="py-1.5 text-xs font-medium text-red-700">− Debit</td>
                          <td className="py-1.5 text-right font-mono text-xs text-red-700">− {formatPKR(result.summary.bsTotalDebit)}</td>
                        </tr>
                        <tr className="border-b bg-emerald-50">
                          <td className="py-1.5 text-xs font-medium text-emerald-700">+ Credit</td>
                          <td className="py-1.5 text-right font-mono text-xs text-emerald-700">+ {formatPKR(result.summary.bsTotalCredit)}</td>
                        </tr>
                        <tr className="border-t-2 border-slate-300 font-bold">
                          <td className="py-2 text-xs">= Closing Balance</td>
                          <td className="py-2 text-right font-mono text-sm">{formatPKR(result.summary.bsComputedBalance)}</td>
                        </tr>
                        <tr className="border-b">
                          <td className="py-1 text-[10px] text-slate-400">Statement Closing Balance</td>
                          <td className="py-1 text-right font-mono text-[10px] text-slate-400">{formatPKR(result.summary.bsBalance)}</td>
                        </tr>
                        <tr>
                          <td className="py-1 text-[10px]" colSpan={2}>
                            {result.summary.bsComputedBalance === result.summary.bsBalance ? (
                              <span className="text-emerald-600 flex items-center gap-1"><CheckCircle2 className="h-3 w-3" /> Verified</span>
                            ) : (
                              <span className="text-amber-600 flex items-center gap-1"><AlertTriangle className="h-3 w-3" /> Variance: {formatPKR(Math.abs(result.summary.bsComputedBalance - result.summary.bsBalance))}</span>
                            )}
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </CardContent>
                </Card>
              </div>

              {/* Gap Audit Section */}
              {result.gapAudit && result.summary.difference !== 0 && (
                <Card className="lg:col-span-2 border-2 border-amber-300">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center gap-2">
                      <AlertTriangle className="h-5 w-5 text-amber-600" />
                      Gap Audit — Why the Difference Exists
                    </CardTitle>
                    <CardDescription>
                      Breakdown of the PKR {formatPKR(result.summary.difference)} gap between Adjusted GL Balance and Bank Statement Balance
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {/* Gap Summary Bar */}
                    <div className="mb-5 p-4 rounded-lg bg-amber-50 border border-amber-200">
                      <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
                        <div className="text-center">
                          <p className="text-[10px] text-amber-600 uppercase tracking-wider font-semibold">Reversal Net</p>
                          <p className={`text-base font-bold ${result.gapAudit.reversalNetImpact === 0 ? 'text-slate-400' : result.gapAudit.reversalNetImpact > 0 ? 'text-red-700' : 'text-emerald-700'}`}>
                            {result.gapAudit.reversalNetImpact === 0 ? '—' : formatPKR(result.gapAudit.reversalNetImpact)}
                          </p>
                        </div>
                        <div className="text-center">
                          <p className="text-[10px] text-amber-600 uppercase tracking-wider font-semibold">Matched Diff</p>
                          <p className={`text-base font-bold ${result.gapAudit.matchedAmountDiff === 0 ? 'text-slate-400' : result.gapAudit.matchedAmountDiff > 0 ? 'text-red-700' : 'text-emerald-700'}`}>
                            {result.gapAudit.matchedAmountDiff === 0 ? '—' : formatPKR(result.gapAudit.matchedAmountDiff)}
                          </p>
                        </div>
                        <div className="text-center">
                          <p className="text-[10px] text-amber-600 uppercase tracking-wider font-semibold">BS Unaccounted</p>
                          <p className={`text-base font-bold ${result.gapAudit.bsUnaccountedNet === 0 ? 'text-slate-400' : result.gapAudit.bsUnaccountedNet > 0 ? 'text-red-700' : 'text-emerald-700'}`}>
                            {result.gapAudit.bsUnaccountedNet === 0 ? '—' : formatPKR(result.gapAudit.bsUnaccountedNet)}
                          </p>
                        </div>
                        <div className="text-center">
                          <p className="text-[10px] text-amber-600 uppercase tracking-wider font-semibold">GL Unaccounted</p>
                          <p className={`text-base font-bold ${result.gapAudit.glUnaccountedNet === 0 ? 'text-slate-400' : result.gapAudit.glUnaccountedNet > 0 ? 'text-red-700' : 'text-emerald-700'}`}>
                            {result.gapAudit.glUnaccountedNet === 0 ? '—' : formatPKR(result.gapAudit.glUnaccountedNet)}
                          </p>
                        </div>
                        <div className="text-center">
                          <p className="text-[10px] text-amber-600 uppercase tracking-wider font-semibold">Unexplained</p>
                          <p className={`text-base font-bold ${result.gapAudit.unexplainedGap === 0 ? 'text-emerald-600' : 'text-red-700'}`}>
                            {result.gapAudit.unexplainedGap === 0 ? '0 (Fully Explained)' : formatPKR(result.gapAudit.unexplainedGap)}
                          </p>
                        </div>
                      </div>
                      <div className="mt-3 pt-3 border-t border-amber-200 flex items-center justify-between">
                        <span className="text-xs text-amber-700">
                          Reversal Net + Matched Diff + BS Unaccounted + GL Unaccounted
                        </span>
                        <span className="text-sm font-bold text-amber-900">
                          = PKR {formatPKR(result.gapAudit.reversalNetImpact + result.gapAudit.matchedAmountDiff + result.gapAudit.bsUnaccountedNet + result.gapAudit.glUnaccountedNet)}
                        </span>
                      </div>
                    </div>

                    {/* Detailed Audit Items */}
                    <div className="space-y-3">
                      {result.gapAudit.items.map((item, idx) => (
                        <div key={idx} className={`rounded-lg border p-4 ${
                          item.source === 'reversal_net' ? 'border-purple-200 bg-purple-50' :
                          item.source === 'matched_amount_diff' ? 'border-blue-200 bg-blue-50' :
                          item.source === 'bs_unaccounted' ? 'border-orange-200 bg-orange-50' :
                          item.source === 'gl_unaccounted' ? 'border-cyan-200 bg-cyan-50' :
                          item.source === 'calculation_check' ? (item.amount === 0 ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50') :
                          'border-slate-200 bg-slate-50'
                        }`}>
                          <div className="flex items-start justify-between gap-4">
                            <div className="flex-1">
                              <div className="flex items-center gap-2 mb-1">
                                <Badge className={`text-[10px] ${
                                  item.source === 'reversal_net' ? 'bg-purple-600 text-white' :
                                  item.source === 'matched_amount_diff' ? 'bg-blue-600 text-white' :
                                  item.source === 'bs_unaccounted' ? 'bg-orange-600 text-white' :
                                  item.source === 'gl_unaccounted' ? 'bg-cyan-600 text-white' :
                                  item.amount === 0 ? 'bg-emerald-600 text-white' : 'bg-red-600 text-white'
                                }`}>
                                  {item.source === 'reversal_net' ? 'Reversal' :
                                   item.source === 'matched_amount_diff' ? 'Match Diff' :
                                   item.source === 'bs_unaccounted' ? 'BS Gap' :
                                   item.source === 'gl_unaccounted' ? 'GL Gap' : 'Verify'}
                                </Badge>
                                <h4 className="text-sm font-semibold text-slate-800">{item.label}</h4>
                              </div>
                              <p className="text-xs text-slate-600 leading-relaxed">{item.description}</p>
                            </div>
                            <div className="text-right flex-shrink-0">
                              <p className={`text-lg font-bold ${item.amount === 0 ? 'text-slate-400' : item.amount > 0 ? 'text-red-700' : 'text-emerald-700'}`}>
                                {item.amount === 0 ? '—' : `${item.amount > 0 ? '+' : ''}${formatPKR(item.amount)}`}
                              </p>
                            </div>
                          </div>

                          {/* Show specific entries if they exist and have significant impact */}
                          {item.entries && item.entries.length > 0 && item.amount !== 0 && (
                            <div className="mt-3 pt-3 border-t border-slate-200/60">
                              <p className="text-[10px] text-slate-500 uppercase tracking-wider font-semibold mb-2">
                                Contributing Entries ({item.entries.length})
                              </p>
                              <div className="max-h-40 overflow-y-auto">
                                <table className="w-full text-xs">
                                  <thead>
                                    <tr className="text-[10px] text-slate-500 uppercase">
                                      <th className="text-left pb-1 pr-2">Reference</th>
                                      <th className="text-left pb-1 pr-2">Details</th>
                                      <th className="text-right pb-1 pr-2">Debit</th>
                                      <th className="text-right pb-1">Credit</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {item.entries.slice(0, 20).map((entry, ei) => (
                                      <tr key={ei} className="border-t border-slate-100">
                                        <td className="py-1 pr-2 font-mono text-slate-600">{entry.transNo || entry.particulars?.substring(0, 15) || '—'}</td>
                                        <td className="py-1 pr-2 text-slate-600 max-w-[200px] truncate">{entry.details || entry.particulars || '—'}</td>
                                        <td className="py-1 pr-2 text-right font-mono text-red-700">{entry.debit ? formatPKR(entry.debit) : ''}</td>
                                        <td className="py-1 text-right font-mono text-emerald-700">{entry.credit ? formatPKR(entry.credit) : ''}</td>
                                      </tr>
                                    ))}
                                    {item.entries.length > 20 && (
                                      <tr><td colSpan={4} className="py-1 text-center text-slate-400">...and {item.entries.length - 20} more entries</td></tr>
                                    )}
                                  </tbody>
                                </table>
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              )}
              {/* No Gap - Show Success */}
              {result.gapAudit && result.summary.difference === 0 && (
                <Card className="lg:col-span-2 border-2 border-emerald-300">
                  <CardContent className="py-6">
                    <div className="flex items-center justify-center gap-3">
                      <CheckCircle2 className="h-8 w-8 text-emerald-600" />
                      <div>
                        <p className="text-lg font-bold text-emerald-800">Fully Reconciled — No Gap</p>
                        <p className="text-sm text-emerald-600">Adjusted GL Balance equals Bank Statement Balance. All entries are accounted for.</p>
                      </div>
                    </div>
                  </CardContent>
                </Card>
              )}
            </TabsContent>

            {/* Matched Transactions Tab */}
            <TabsContent value="matched">
              <Card className="overflow-hidden">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center justify-between">
                    <span>Matched Transactions ({result.matchedPairs.length})</span>
                    <span className="text-sm font-normal text-slate-500">
                      Payments: PKR {formatCompact(result.summary.matchedPairs.totalPayments)} | Receipts: PKR {formatCompact(result.summary.matchedPairs.totalReceipts)}
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <DataTable
                    data={groupedMatchedPairs as unknown as Record<string, unknown>[]}
                    columns={matchedColumns as unknown as ColumnDef<Record<string, unknown>>[]}
                    globalSearch={globalSearch}
                    rowKey={(r) => (r as any).isGrouped ? `group-${(r as any).id}` : `${(r as unknown as MatchedPair).bsRowNo}-${(r as unknown as MatchedPair).glRowNo}`}
                    maxHeight="600px"
                    emptyMessage="No matched transactions"
                  />
                </CardContent>
              </Card>
            </TabsContent>

            {/* Un Presented Cheques Tab */}
            <TabsContent value="unpresented">
              <Card className="overflow-hidden">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">
                    Un Presented Cheques — GL Issued, Not Yet Cleared at Bank
                    ({result.summary.unPresentedCheques.count} | PKR {formatPKR(result.summary.unPresentedCheques.total)})
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <DataTable
                    data={result.unPresentedCheques as unknown as Record<string, unknown>[]}
                    columns={glColumnsBoth as unknown as ColumnDef<Record<string, unknown>>[]}
                    globalSearch={globalSearch}
                    rowKey={(r) => (r as unknown as GLTransaction).uniqueKey}
                    maxHeight="500px"
                    emptyMessage="No un presented cheques"
                  />
                </CardContent>
              </Card>
            </TabsContent>

            {/* Un Cleared Receipts Tab */}
            <TabsContent value="uncleared">
              <Card className="overflow-hidden">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">
                    Un Cleared Receipts — In GL, Not Yet Credited by Bank
                    ({result.summary.unClearedReceipts.count} | PKR {formatPKR(result.summary.unClearedReceipts.total)})
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <DataTable
                    data={result.unClearedReceipts as unknown as Record<string, unknown>[]}
                    columns={glColumnsBoth as unknown as ColumnDef<Record<string, unknown>>[]}
                    globalSearch={globalSearch}
                    rowKey={(r) => (r as unknown as GLTransaction).uniqueKey}
                    maxHeight="500px"
                    emptyMessage="No un cleared receipts"
                  />
                </CardContent>
              </Card>
            </TabsContent>

            {/* Un Recorded Payments Tab */}
            <TabsContent value="unrecorded-pay">
              <Card className="overflow-hidden">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">
                    Un Recorded Payments — In Bank Statement, Not in GL
                    ({result.summary.unRecordedPayments.count} | PKR {formatPKR(result.summary.unRecordedPayments.total)})
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <DataTable
                    data={result.unRecordedPayments as unknown as Record<string, unknown>[]}
                    columns={bsColumnsBoth as unknown as ColumnDef<Record<string, unknown>>[]}
                    globalSearch={globalSearch}
                    rowKey={(r) => (r as unknown as BSTransaction).uniqueKey}
                    maxHeight="500px"
                    emptyMessage="No un recorded payments"
                  />
                </CardContent>
              </Card>
            </TabsContent>

            {/* Un Recorded Receipts Tab */}
            <TabsContent value="unrecorded-rec">
              <Card className="overflow-hidden">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">
                    Un Recorded Receipts — In Bank Statement, Not in GL
                    ({result.summary.unRecordedReceipts.count} | PKR {formatPKR(result.summary.unRecordedReceipts.total)})
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  <DataTable
                    data={result.unRecordedReceipts as unknown as Record<string, unknown>[]}
                    columns={bsColumnsBoth as unknown as ColumnDef<Record<string, unknown>>[]}
                    globalSearch={globalSearch}
                    rowKey={(r) => (r as unknown as BSTransaction).uniqueKey}
                    maxHeight="500px"
                    emptyMessage="No un recorded receipts"
                  />
                </CardContent>
              </Card>
            </TabsContent>

            {/* Reversals Tab */}
            <TabsContent value="reversals">
              {/* GL Reversals */}
              <Card className="overflow-hidden mb-4">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">
                    GL Reversals — Excluded from Reconciliation
                    ({reversalCount} entries)
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {reversalCount > 0 && (() => {
                    const entries = result.reversalEntries || [];
                    const originals = entries.filter((r: GLTransaction) => !r.isReversal);
                    const reversals = entries.filter((r: GLTransaction) => r.isReversal);

                    const origDebit = originals.reduce((s: number, r: GLTransaction) => s + (r.debit || 0), 0);
                    const origCredit = originals.reduce((s: number, r: GLTransaction) => s + (r.credit || 0), 0);
                    const revDebit = reversals.reduce((s: number, r: GLTransaction) => s + (r.debit || 0), 0);
                    const revCredit = reversals.reduce((s: number, r: GLTransaction) => s + (r.credit || 0), 0);

                    // Match signal: Original (debit-credit) should equal Reversal (credit-debit)
                    // i.e. Original net should be cancelled by Reversal net
                    const origNet = origDebit - origCredit;
                    const revNet = revDebit - revCredit;
                    const isMatched = Math.abs(origNet + revNet) === 0; // Original net + Reversal net should = 0
                    const matchDiff = Math.abs(origNet + revNet);

                    return (
                      <div className="mb-4 space-y-3">
                        {/* Original and Reversal Totals Side by Side */}
                        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                          {/* Original Entries Totals */}
                          <div className="p-4 rounded-lg border-2 border-blue-200 bg-blue-50">
                            <div className="flex items-center gap-2 mb-2">
                              <Badge variant="secondary" className="text-xs bg-blue-600 text-white">Original</Badge>
                              <span className="text-xs text-blue-600">{originals.length} entries</span>
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <p className="text-[10px] text-red-600 uppercase tracking-wider font-semibold">Total Debit</p>
                                <p className="text-base font-bold text-red-700">PKR {formatPKR(origDebit)}</p>
                              </div>
                              <div>
                                <p className="text-[10px] text-emerald-600 uppercase tracking-wider font-semibold">Total Credit</p>
                                <p className="text-base font-bold text-emerald-700">PKR {formatPKR(origCredit)}</p>
                              </div>
                            </div>
                            <div className="mt-2 pt-2 border-t border-blue-200">
                              <p className="text-[10px] text-blue-600 uppercase tracking-wider font-semibold">Net (Debit − Credit)</p>
                              <p className="text-sm font-bold text-blue-800">PKR {formatPKR(origNet)}</p>
                            </div>
                          </div>

                          {/* Reversal Entries Totals */}
                          <div className="p-4 rounded-lg border-2 border-red-200 bg-red-50">
                            <div className="flex items-center gap-2 mb-2">
                              <Badge variant="destructive" className="text-xs">Reversal</Badge>
                              <span className="text-xs text-red-600">{reversals.length} entries</span>
                            </div>
                            <div className="grid grid-cols-2 gap-3">
                              <div>
                                <p className="text-[10px] text-red-600 uppercase tracking-wider font-semibold">Total Debit</p>
                                <p className="text-base font-bold text-red-700">PKR {formatPKR(revDebit)}</p>
                              </div>
                              <div>
                                <p className="text-[10px] text-emerald-600 uppercase tracking-wider font-semibold">Total Credit</p>
                                <p className="text-base font-bold text-emerald-700">PKR {formatPKR(revCredit)}</p>
                              </div>
                            </div>
                            <div className="mt-2 pt-2 border-t border-red-200">
                              <p className="text-[10px] text-red-600 uppercase tracking-wider font-semibold">Net (Debit − Credit)</p>
                              <p className="text-sm font-bold text-red-800">PKR {formatPKR(revNet)}</p>
                            </div>
                          </div>
                        </div>

                        {/* Match Signal */}
                        <div className={`p-4 rounded-lg border-2 ${isMatched ? 'border-emerald-300 bg-emerald-50' : 'border-amber-300 bg-amber-50'}`}>
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              {isMatched ? (
                                <CheckCircle2 className="h-6 w-6 text-emerald-600" />
                              ) : (
                                <AlertTriangle className="h-6 w-6 text-amber-600" />
                              )}
                              <div>
                                <p className={`text-sm font-bold ${isMatched ? 'text-emerald-800' : 'text-amber-800'}`}>
                                  {isMatched ? 'Match Signal: Reversals Fully Balanced' : 'Match Signal: Reversals Not Balanced'}
                                </p>
                                <p className="text-xs text-slate-600 mt-0.5">
                                  Original Net (PKR {formatPKR(origNet)}) + Reversal Net (PKR {formatPKR(revNet)})
                                  {isMatched ? ' = 0' : ` = PKR ${formatPKR(matchDiff)} difference`}
                                </p>
                              </div>
                            </div>
                            <Badge className={`text-xs px-3 py-1 ${isMatched ? 'bg-emerald-600 text-white' : 'bg-amber-500 text-white'}`}>
                              {isMatched ? 'BALANCED' : `GAP: PKR ${formatPKR(matchDiff)}`}
                            </Badge>
                          </div>
                        </div>
                      </div>
                    );
                  })()}
                  <DataTable
                    data={(result.reversalEntries || []) as unknown as Record<string, unknown>[]}
                    columns={reversalColumns as unknown as ColumnDef<Record<string, unknown>>[]}
                    globalSearch={globalSearch}
                    rowKey={(r) => (r as unknown as GLTransaction).uniqueKey}
                    maxHeight="500px"
                    emptyMessage="No GL reversal entries found"
                  />
                </CardContent>
              </Card>

              {/* BS Reversals */}
              {bsReversalCount > 0 && (
                <Card className="overflow-hidden">
                  <CardHeader className="pb-3">
                    <CardTitle className="text-base flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full bg-orange-500 inline-block"></span>
                      BS Internal Reversals — Cheque entries with both Debit &amp; Credit
                      ({bsReversalCount} entries)
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    <div className="mb-4 p-4 rounded-lg border-2 border-orange-200 bg-orange-50">
                      <p className="text-sm text-orange-800">
                        These Bank Statement entries have been identified as internal reversals — the same cheque number appears with both a debit and a credit entry of the same amount. 
                        The credit entry is excluded from matching because it cancels out the debit entry. The corresponding debit entry remains available for BS↔GL matching.
                      </p>
                      <div className="grid grid-cols-2 gap-3 mt-3">
                        <div>
                          <p className="text-[10px] text-red-600 uppercase tracking-wider font-semibold">Total Debit (excluded)</p>
                          <p className="text-base font-bold text-red-700">PKR {formatPKR(result.bsReversalEntries.reduce((s: number, t: BSTransaction) => s + (t.debit || 0), 0))}</p>
                        </div>
                        <div>
                          <p className="text-[10px] text-emerald-600 uppercase tracking-wider font-semibold">Total Credit (excluded)</p>
                          <p className="text-base font-bold text-emerald-700">PKR {formatPKR(result.bsReversalEntries.reduce((s: number, t: BSTransaction) => s + (t.credit || 0), 0))}</p>
                        </div>
                      </div>
                    </div>
                    <DataTable
                      data={(result.bsReversalEntries || []) as unknown as Record<string, unknown>[]}
                      columns={bsReversalColumns as unknown as ColumnDef<Record<string, unknown>>[]}
                      globalSearch={globalSearch}
                      rowKey={(r) => (r as unknown as BSTransaction).uniqueKey}
                      maxHeight="500px"
                      emptyMessage="No BS reversal entries"
                    />
                  </CardContent>
                </Card>
              )}
            </TabsContent>

            {/* Manual Adjustment Report Tab */}
            <TabsContent value="manual-adj">
              <Card className="overflow-hidden">
                <CardHeader className="pb-3">
                  <CardTitle className="text-base flex items-center gap-2">
                    <Clock className="h-5 w-5 text-blue-500" />
                    Manual Adjustment Report
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {result.manualMatches.length > 0 && (
                    <div className="mb-4 flex gap-4">
                      <div className="p-3 rounded-lg bg-blue-50 flex-1">
                        <p className="text-xs text-blue-600">Total Adjustments</p>
                        <p className="text-lg font-bold text-blue-700">{result.manualMatches.length}</p>
                      </div>
                      <div className="p-3 rounded-lg bg-emerald-50 flex-1">
                        <p className="text-xs text-emerald-600">Total BS Amount</p>
                        <p className="text-lg font-bold text-emerald-700">PKR {formatPKR(result.manualMatches.reduce((s, m) => s + m.bsAmount, 0))}</p>
                      </div>
                      <div className="p-3 rounded-lg bg-amber-50 flex-1">
                        <p className="text-xs text-amber-600">Total GL Amount</p>
                        <p className="text-lg font-bold text-amber-700">PKR {formatPKR(result.manualMatches.reduce((s, m) => s + m.glAmount, 0))}</p>
                      </div>
                      <div className="p-3 rounded-lg bg-red-50 flex-1">
                        <p className="text-xs text-red-600">Amount Difference</p>
                        <p className="text-lg font-bold text-red-700">PKR {formatPKR(result.manualMatches.reduce((s, m) => s + Math.abs(m.bsAmount - m.glAmount), 0))}</p>
                      </div>
                    </div>
                  )}
                  <DataTable
                    data={result.manualMatches as unknown as Record<string, unknown>[]}
                    columns={manualAdjColumns as unknown as ColumnDef<Record<string, unknown>>[]}
                    globalSearch={globalSearch}
                    rowKey={(r) => (r as unknown as ManualMatch).id}
                    maxHeight="500px"
                    emptyMessage="No manual adjustments made yet"
                  />
                </CardContent>
              </Card>
            </TabsContent>

            {/* Possible Matches Tab — separate sheet */}
            <TabsContent value="possible-matches">
              <Card className="border-2 border-amber-200">
                <CardHeader className="pb-3 bg-gradient-to-r from-amber-50 to-amber-100/50">
                  <CardTitle className="text-base flex items-center justify-between">
                    <span className="flex items-center gap-2">
                      <Sparkles className="h-5 w-5 text-amber-600" />
                      Suggested Possible Matches
                      <Badge variant="secondary" className="text-xs bg-amber-100 text-amber-700">{result.possibleMatches.length} suggestion(s)</Badge>
                    </span>
                    <span className="text-xs text-amber-500 font-normal">Click &quot;Accept&quot; to instantly match a pair</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="p-0">
                  {result.possibleMatches.length === 0 ? (
                    <div className="py-12 text-center">
                      <Sparkles className="h-10 w-10 mx-auto mb-3 text-slate-300" />
                      <p className="text-sm text-slate-500 font-medium">No suggested matches available</p>
                      <p className="text-xs text-slate-400 mt-1">All entries may already be matched or amounts don&apos;t align</p>
                    </div>
                  ) : (
                    <DataTable
                      data={result.possibleMatches as unknown as Record<string, unknown>[]}
                      columns={[
                        { key: 'id', label: '#', width: '40px', sortable: false, filterable: false, getValue: (r) => (r as unknown as PossibleMatch).id, render: (_r, i) => i + 1 },
                        { key: 'bsParticulars', label: 'BS Particulars', width: '25%', wrap: true, getValue: (r) => (r as unknown as PossibleMatch).bsTransaction.particulars, render: (r) => {
                          const pm = r as unknown as PossibleMatch;
                          return (
                            <div className="overflow-hidden">
                              <div className="truncate" title={pm.bsTransaction.particulars}>{pm.bsTransaction.particulars}</div>
                              <div className="text-[10px] text-slate-400 mt-0.5">{pm.bsTransaction.date}</div>
                            </div>
                          );
                        }},
                        { key: 'bsAmount', label: 'BS Amount', width: '110px', align: 'right', isAmount: true, getValue: (r) => (r as unknown as PossibleMatch).bsTransaction.debit || (r as unknown as PossibleMatch).bsTransaction.credit || 0, render: (r) => {
                          const pm = r as unknown as PossibleMatch;
                          const amt = pm.bsTransaction.debit || pm.bsTransaction.credit || 0;
                          return <span className="font-mono text-emerald-700 whitespace-nowrap">PKR {formatPKR(amt)} <span className="text-[9px]">{pm.bsTransaction.debit ? 'Dr' : 'Cr'}</span></span>;
                        }},
                        { key: 'glDetails', label: 'GL Details', width: '25%', wrap: true, getValue: (r) => (r as unknown as PossibleMatch).glTransaction.details, render: (r) => {
                          const pm = r as unknown as PossibleMatch;
                          return (
                            <div className="overflow-hidden">
                              <div className="truncate" title={pm.glTransaction.details}>{pm.glTransaction.details}</div>
                              <div className="text-[10px] text-slate-400 mt-0.5">Date: {pm.glTransaction.postingDate}</div>
                            </div>
                          );
                        }},
                        { key: 'glAmount', label: 'GL Amount', width: '110px', align: 'right', isAmount: true, getValue: (r) => (r as unknown as PossibleMatch).glTransaction.debit || (r as unknown as PossibleMatch).glTransaction.credit || 0, render: (r) => {
                          const pm = r as unknown as PossibleMatch;
                          const amt = pm.glTransaction.debit || pm.glTransaction.credit || 0;
                          return <span className="font-mono text-blue-700 whitespace-nowrap">PKR {formatPKR(amt)} <span className="text-[9px]">{pm.glTransaction.debit ? 'Dr' : 'Cr'}</span></span>;
                        }},
                        { key: 'confidence', label: 'Conf.', width: '90px', getValue: (r) => (r as unknown as PossibleMatch).confidence, render: (r) => {
                          const pm = r as unknown as PossibleMatch;
                          const bsAmt = pm.bsTransaction.debit || pm.bsTransaction.credit || 0;
                          const glAmt = pm.glTransaction.debit || pm.glTransaction.credit || 0;
                          const diff = Math.abs(bsAmt - glAmt);
                          return (
                            <div className="text-center">
                              <Badge className={`text-[10px] px-1.5 ${pm.confidence >= 80 ? 'bg-emerald-100 text-emerald-700' : pm.confidence >= 60 ? 'bg-amber-100 text-amber-700' : 'bg-orange-100 text-orange-700'}`}>
                                {pm.confidence}%
                              </Badge>
                              {diff > 0 && <div className="text-[9px] text-amber-500 mt-0.5 whitespace-nowrap">Diff: {formatPKR(diff)}</div>}
                            </div>
                          );
                        }},
                        { key: 'matchReason', label: 'Match Reason', width: '18%', wrap: true, getValue: (r) => (r as unknown as PossibleMatch).matchReason, render: (r) => (
                          <span className="text-[11px] text-slate-500 line-clamp-2">{(r as unknown as PossibleMatch).matchReason}</span>
                        )},
                        { key: 'accept', label: 'Action', width: '100px', sortable: false, filterable: false, render: (r) => {
                          const pm = r as unknown as PossibleMatch;
                          const isAccepting = acceptingMatchId === pm.id;
                          const isAnyAccepting = acceptingMatchId !== null;
                          return (
                            <Button
                              size="sm"
                              className={`h-7 text-white text-[11px] px-2.5 whitespace-nowrap transition-all duration-300 ${
                                isAccepting
                                  ? 'bg-emerald-500 animate-pulse shadow-lg shadow-emerald-200'
                                  : isAnyAccepting
                                    ? 'bg-slate-300 cursor-not-allowed opacity-50'
                                    : 'bg-emerald-600 hover:bg-emerald-700 hover:shadow-md'
                              }`}
                              onClick={() => !isAnyAccepting && handleAcceptPossibleMatch(pm)}
                              disabled={isAnyAccepting}
                            >
                              {isAccepting ? (
                                <>
                                  <Loader2 className="h-3 w-3 mr-0.5 animate-spin" /> Applying...
                                </>
                              ) : (
                                <>
                                  <Zap className="h-3 w-3 mr-0.5" /> Accept
                                </>
                              )}
                            </Button>
                          );
                        }},
                      ] as unknown as ColumnDef<Record<string, unknown>>[]}
                      globalSearch={globalSearch}
                      rowKey={(r) => `pm-${(r as unknown as PossibleMatch).id}`}
                      rowClassName={() => 'hover:bg-amber-50/50'}
                      maxHeight="calc(100vh - 220px)"
                      tableLayout="fixed"
                      emptyMessage="No suggestions"
                    />
                  )}
                </CardContent>
              </Card>
            </TabsContent>

            {/* Manual Match Tab — multi-select with full column visibility */}
            <TabsContent value="manual">
              {/* Manual Match header */}
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2 text-sm">
                  <Info className="h-4 w-4 text-slate-400 flex-shrink-0" />
                  <span className="text-slate-500">Select entries from <b className="text-emerald-700">Bank Statement</b> and <b className="text-blue-700">GL Ledger</b> sides (multiple allowed), then click Match. <b className="text-orange-600">For same-side reversal:</b> select debit + credit from the same side only → "Mark as Reversal" appears.</span>
                </div>

              </div>
              <div className="flex items-center gap-2 mb-3">
                <Badge variant="secondary" className="text-xs">
                  {result.unRecordedPayments.length + result.unRecordedReceipts.length} BS unmatched · {result.unPresentedCheques.length + result.unClearedReceipts.length} GL unmatched
                </Badge>
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                {/* BS side */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center justify-between">
                      <span className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block"></span>
                        Bank Statement — Un Recorded Items
                        ({[...result.unRecordedPayments, ...result.unRecordedReceipts].length})
                      </span>
                      <div className="flex items-center gap-2">
                        {selectedBSItems.length > 0 && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-6 text-[10px] px-2 border-emerald-300 text-emerald-700 hover:bg-emerald-50"
                            onClick={() => setSelectedBSItems([])}
                          >
                            Clear ({selectedBSItems.length})
                          </Button>
                        )}
                        {selectedBSItems.length > 0 ? (
                          <Badge className="bg-emerald-600 text-white text-[10px] px-2 py-0.5">{selectedBSItems.length} Selected</Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px] text-slate-400 px-2 py-0.5">No Selection</Badge>
                        )}
                      </div>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    <div className="overflow-x-auto overflow-y-auto" style={{ maxHeight: 'calc(100vh - 300px)' }}>
                      <DataTable
                        data={[...result.unRecordedPayments, ...result.unRecordedReceipts] as unknown as Record<string, unknown>[]}
                        columns={manualBSCols as unknown as ColumnDef<Record<string, unknown>>[]}
                        globalSearch={globalSearch}
                        rowKey={(r) => (r as unknown as BSTransaction).uniqueKey}
                        rowClassName={(r) => {
                          const bs = r as unknown as BSTransaction;
                          if (selectedBSItems.some(s => s.uniqueKey === bs.uniqueKey)) return 'bg-emerald-50 ring-1 ring-emerald-300 font-medium';
                          // Dim unselected rows when there's a selection
                          if (selectedBSItems.length > 0) return 'opacity-40';
                          return '';
                        }}
                        maxHeight="none"
                        tableLayout="fixed"
                        emptyMessage="No un recorded BS items"
                      />
                    </div>
                  </CardContent>
                </Card>

                {/* GL side with integrated possible matches */}
                <Card>
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center justify-between">
                      <span className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full bg-blue-500 inline-block"></span>
                        GL Ledger — Un Presented / Un Cleared Items
                        ({[...result.unPresentedCheques, ...result.unClearedReceipts].length})
                      </span>
                      <div className="flex items-center gap-2">
                        {selectedGLItems.length > 0 && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-6 text-[10px] px-2 border-blue-300 text-blue-700 hover:bg-blue-50"
                            onClick={() => setSelectedGLItems([])}
                          >
                            Clear ({selectedGLItems.length})
                          </Button>
                        )}
                        {selectedGLItems.length > 0 ? (
                          <Badge className="bg-blue-600 text-white text-[10px] px-2 py-0.5">{selectedGLItems.length} Selected</Badge>
                        ) : (
                          <Badge variant="outline" className="text-[10px] text-slate-400 px-2 py-0.5">No Selection</Badge>
                        )}
                      </div>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="p-0">
                    {/* Possible matches section — shown when a BS item is selected */}
                    {selectedBSItems.length === 1 && getPossibleMatchesForBS(selectedBSItems[0].uniqueKey).length > 0 && (
                      <div className="border-b border-amber-300 bg-amber-50">
                        <div className="px-3 py-1.5 bg-amber-100 border-b border-amber-200 flex items-center gap-2">
                          <Sparkles className="h-3.5 w-3.5 text-amber-600 flex-shrink-0" />
                          <span className="text-[11px] font-semibold text-amber-800 truncate">
                            Matches for: {selectedBSItems[0].particulars.substring(0, 40)}... (PKR {formatPKR(selectedBSItems[0].amount)})
                          </span>
                        </div>
                        <div className="overflow-x-auto overflow-y-auto" style={{ maxHeight: '140px' }}>
                          <table className="w-full text-xs" style={{ tableLayout: 'fixed' }}>
                            <thead className="sticky top-0 z-10 bg-amber-50">
                              <tr>
                                <th className="text-left py-1 px-2 font-semibold text-blue-700" style={{ width: '40%' }}>GL Details</th>
                                <th className="text-right py-1 px-2 font-semibold text-blue-700" style={{ width: '100px' }}>Amount</th>
                                <th className="text-center py-1 px-2 font-semibold text-amber-700" style={{ width: '55px' }}>Conf.</th>
                                <th className="text-center py-1 px-2" style={{ width: '60px' }}></th>
                              </tr>
                            </thead>
                            <tbody>
                              {getPossibleMatchesForBS(selectedBSItems[0].uniqueKey).map((pm) => (
                                <tr key={`inline-pm-${pm.id}`} className="border-b border-amber-100 hover:bg-amber-100/50">
                                  <td className="py-1 px-2 text-slate-700" style={{ width: '40%' }}>
                                    <div className="truncate" title={pm.glTransaction.details}>{pm.glTransaction.details}</div>
                                    <div className="text-[9px] text-slate-400">Trans #{pm.glTransaction.transNo}</div>
                                  </td>
                                  <td className="py-1 px-2 text-right font-mono text-blue-700 whitespace-nowrap" style={{ width: '100px' }}>
                                    {formatPKR(pm.glTransaction.debit || pm.glTransaction.credit || 0)}
                                  </td>
                                  <td className="py-1 px-2 text-center" style={{ width: '55px' }}>
                                    <Badge className={`text-[8px] px-1 ${pm.confidence >= 80 ? 'bg-emerald-100 text-emerald-700' : pm.confidence >= 60 ? 'bg-amber-100 text-amber-700' : 'bg-orange-100 text-orange-700'}`}>
                                      {pm.confidence}%
                                    </Badge>
                                  </td>
                                  <td className="py-1 px-2 text-center" style={{ width: '60px' }}>
                                    <Button
                                      size="sm"
                                      className={`h-5 text-white text-[9px] px-1.5 transition-all ${
                                        acceptingMatchId === pm.id
                                          ? 'bg-emerald-500 animate-pulse'
                                          : acceptingMatchId !== null
                                            ? 'bg-slate-300 cursor-not-allowed opacity-50'
                                            : 'bg-emerald-600 hover:bg-emerald-700'
                                      }`}
                                      onClick={() => acceptingMatchId === null && handleAcceptPossibleMatch(pm)}
                                      disabled={acceptingMatchId !== null}
                                    >
                                      {acceptingMatchId === pm.id ? (
                                        <><Loader2 className="h-2.5 w-2.5 mr-0.5 animate-spin" />...</>
                                      ) : (
                                        <><Zap className="h-2.5 w-2.5 mr-0.5" /> OK</>
                                      )}
                                    </Button>
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    <div className="overflow-x-auto overflow-y-auto" style={{ maxHeight: 'calc(100vh - 300px)' }}>
                      <DataTable
                        data={[...result.unPresentedCheques, ...result.unClearedReceipts] as unknown as Record<string, unknown>[]}
                        columns={manualGLCols as unknown as ColumnDef<Record<string, unknown>>[]}
                        globalSearch={globalSearch}
                        rowKey={(r) => (r as unknown as GLTransaction).uniqueKey}
                        rowClassName={(r) => {
                          const glKey = (r as unknown as GLTransaction).uniqueKey;
                          if (selectedGLItems.some(s => s.uniqueKey === glKey)) return 'bg-blue-50 ring-1 ring-blue-300 font-medium';
                          if (selectedBSItems.length === 1) {
                            const isPossible = getPossibleMatchesForBS(selectedBSItems[0].uniqueKey).some(
                              pm => pm.glTransaction.uniqueKey === glKey
                            );
                            if (isPossible) return 'bg-amber-50';
                          }
                          // Dim unselected rows when there's a selection
                          if (selectedGLItems.length > 0) return 'opacity-40';
                          return '';
                        }}
                        maxHeight="none"
                        tableLayout="fixed"
                        emptyMessage="No unmatched GL items"
                      />
                    </div>
                  </CardContent>
                </Card>
              </div>

              {/* Match action bar — always visible */}
              <Card className={`mt-4 transition-all duration-300 ${selectedBSItems.length > 0 && selectedGLItems.length > 0 ? 'border-2 border-emerald-400 bg-emerald-50 shadow-md' : selectedBSItems.length > 0 || selectedGLItems.length > 0 ? 'border border-amber-300 bg-amber-50' : 'border border-slate-200 bg-slate-50'}`}>
                <CardContent className="py-3">
                  {selectedBSItems.length === 0 && selectedGLItems.length === 0 && (
                    <div className="flex items-center justify-center gap-3 py-2 text-sm text-slate-400">
                      <Link2 className="h-4 w-4" />
                      <span>Select entries from each side to match, or select debit + credit from the same side to mark as reversal</span>
                    </div>
                  )}

                  {(selectedBSItems.length > 0 || selectedGLItems.length > 0) && (selectedBSItems.length === 0 || selectedGLItems.length === 0) && (
                    <div className="flex items-center justify-between flex-wrap gap-3">
                      <div className="flex items-center gap-4 flex-wrap">
                        {selectedBSItems.length > 0 && (
                          <div className="bg-white rounded-lg border border-emerald-200 px-3 py-2">
                            <div className="text-[10px] uppercase font-semibold text-emerald-600 mb-1">BS: {selectedBSItems.length} entry(ies)</div>
                            <div className="font-mono font-bold text-sm text-emerald-700">Total: PKR {formatPKR(selectedBSItems.reduce((s, i) => s + i.amount, 0))}</div>
                          </div>
                        )}
                        {selectedGLItems.length > 0 && (
                          <div className="bg-white rounded-lg border border-blue-200 px-3 py-2">
                            <div className="text-[10px] uppercase font-semibold text-blue-600 mb-1">GL: {selectedGLItems.length} entry(ies)</div>
                            <div className="font-mono font-bold text-sm text-blue-700">Total: PKR {formatPKR(selectedGLItems.reduce((s, i) => s + i.amount, 0))}</div>
                          </div>
                        )}
                        {(() => {
                          // Check if same-side reversal is possible
                          const items = selectedBSItems.length > 0 ? selectedBSItems : selectedGLItems;
                          const source = selectedBSItems.length > 0 ? 'BS' : 'GL';
                          const hasDebit = items.some(i => i.debit && i.debit > 0);
                          const hasCredit = items.some(i => i.credit && i.credit > 0);
                          if (hasDebit && hasCredit) {
                            return (
                              <div className="flex items-center gap-2 text-orange-600 text-xs font-medium">
                                <RefreshCw className="h-4 w-4" />
                                <span>Debit + Credit selected from {source} — will mark as reversal</span>
                              </div>
                            );
                          }
                          return (
                            <div className="flex items-center gap-2 text-amber-600 text-xs font-medium">
                              <AlertTriangle className="h-4 w-4" />
                              <span>Select entries from the other side, or select both debit & credit from this side for reversal</span>
                            </div>
                          );
                        })()}
                      </div>
                      <div className="flex gap-2">
                        {(() => {
                          const items = selectedBSItems.length > 0 ? selectedBSItems : selectedGLItems;
                          const hasDebit = items.some(i => i.debit && i.debit > 0);
                          const hasCredit = items.some(i => i.credit && i.credit > 0);
                          if (hasDebit && hasCredit) {
                            const source = selectedBSItems.length > 0 ? 'BS' : 'GL';
                            return (
                              <Button size="sm" onClick={() => handleManualMatch()} className="bg-orange-600 hover:bg-orange-700 text-white">
                                <RefreshCw className="h-4 w-4 mr-1" /> Mark as {source} Reversal ({items.length} entries)
                              </Button>
                            );
                          }
                          return null;
                        })()}
                        <Button size="sm" variant="outline" onClick={() => { setSelectedBSItems([]); setSelectedGLItems([]); }}>
                          Clear Selection
                        </Button>
                      </div>
                    </div>
                  )}

                  {selectedBSItems.length > 0 && selectedGLItems.length > 0 && (() => {
                    // Check for same-side reversal possibilities among the selections
                    const bsHasDebit = selectedBSItems.some(i => i.debit && i.debit > 0);
                    const bsHasCredit = selectedBSItems.some(i => i.credit && i.credit > 0);
                    const glHasDebit = selectedGLItems.some(i => i.debit && i.debit > 0);
                    const glHasCredit = selectedGLItems.some(i => i.credit && i.credit > 0);
                    const bsReversalPossible = bsHasDebit && bsHasCredit;
                    const glReversalPossible = glHasDebit && glHasCredit;

                    return (
                      <div className="flex flex-col gap-3">
                        <div className="flex items-center justify-between flex-wrap gap-3">
                          <div className="flex items-center gap-4 flex-wrap">
                            {/* BS Summary */}
                            <div className="bg-white rounded-lg border border-emerald-200 px-3 py-2 min-w-[180px]">
                              <div className="text-[10px] uppercase font-semibold text-emerald-600 mb-1">BS Entries ({selectedBSItems.length})</div>
                              <div className="space-y-0.5 max-h-20 overflow-y-auto">
                                {selectedBSItems.map((item, idx) => (
                                  <div key={item.uniqueKey} className="text-[11px] text-slate-600 flex justify-between gap-2">
                                    <span className="truncate max-w-[140px]">{idx + 1}. {item.particulars.substring(0, 30)}</span>
                                    <span className="font-mono text-emerald-700 whitespace-nowrap">PKR {formatPKR(item.amount)}</span>
                                  </div>
                                ))}
                              </div>
                              <div className="mt-1 pt-1 border-t border-emerald-100 font-mono font-bold text-sm text-emerald-700">
                                Total: PKR {formatPKR(selectedBSItems.reduce((s, i) => s + i.amount, 0))}
                              </div>
                            </div>

                            <div className="flex flex-col items-center gap-1">
                              <ArrowRight className="h-5 w-5 text-emerald-600 flex-shrink-0" />
                              {(() => {
                                const bsTotal = selectedBSItems.reduce((s, i) => s + i.amount, 0);
                                const glTotal = selectedGLItems.reduce((s, i) => s + i.amount, 0);
                                const diff = Math.abs(bsTotal - glTotal);
                                return diff === 0 ? (
                                  <Badge className="bg-emerald-100 text-emerald-700 text-[10px]">
                                    <CheckCircle2 className="h-3 w-3 mr-1" /> Exact Match
                                  </Badge>
                                ) : (
                                  <Badge className="bg-amber-100 text-amber-700 text-[10px]">
                                    <AlertTriangle className="h-3 w-3 mr-1" /> Diff: PKR {formatPKR(diff)}
                                  </Badge>
                                );
                              })()}
                            </div>

                            {/* GL Summary */}
                            <div className="bg-white rounded-lg border border-blue-200 px-3 py-2 min-w-[180px]">
                              <div className="text-[10px] uppercase font-semibold text-blue-600 mb-1">GL Entries ({selectedGLItems.length})</div>
                              <div className="space-y-0.5 max-h-20 overflow-y-auto">
                                {selectedGLItems.map((item, idx) => (
                                  <div key={item.uniqueKey} className="text-[11px] text-slate-600 flex justify-between gap-2">
                                    <span className="truncate max-w-[140px]">{idx + 1}. {item.particulars.substring(0, 30)}</span>
                                    <span className="font-mono text-blue-700 whitespace-nowrap">PKR {formatPKR(item.amount)}</span>
                                  </div>
                                ))}
                              </div>
                              <div className="mt-1 pt-1 border-t border-blue-100 font-mono font-bold text-sm text-blue-700">
                                Total: PKR {formatPKR(selectedGLItems.reduce((s, i) => s + i.amount, 0))}
                              </div>
                            </div>

                            {/* Amount Comparison */}
                            <div className="bg-white rounded-lg border border-slate-200 px-3 py-2 text-xs">
                              <div className="text-[10px] uppercase font-semibold text-slate-500 mb-1.5">Amount Comparison</div>
                              <div className="space-y-1 font-mono">
                                <div className="flex justify-between gap-4">
                                  <span className="text-slate-500">BS Total:</span>
                                  <span className="text-emerald-600 font-semibold">PKR {formatPKR(selectedBSItems.reduce((s, i) => s + i.amount, 0))}</span>
                                </div>
                                <div className="flex justify-between gap-4">
                                  <span className="text-slate-500">GL Total:</span>
                                  <span className="text-blue-600 font-semibold">PKR {formatPKR(selectedGLItems.reduce((s, i) => s + i.amount, 0))}</span>
                                </div>
                                {(() => {
                                  const bsTotal = selectedBSItems.reduce((s, i) => s + i.amount, 0);
                                  const glTotal = selectedGLItems.reduce((s, i) => s + i.amount, 0);
                                  const netDiff = Math.abs(bsTotal - glTotal);
                                  return (
                                    <div className="border-t border-slate-200 pt-1 flex justify-between gap-4">
                                      <span className="text-slate-600 font-bold">Net Diff:</span>
                                      <span className={`font-bold ${netDiff === 0 ? 'text-emerald-600' : 'text-amber-600'}`}>
                                        {netDiff === 0 ? 'PKR 0 ✓' : `PKR ${formatPKR(netDiff)}`}
                                      </span>
                                    </div>
                                  );
                                })()}
                                <div className="border-t border-slate-100 pt-1 text-[10px] text-slate-400">
                                  {selectedBSItems.length === 1 && selectedGLItems.length > 1
                                    ? `1 BS entry matched with ${selectedGLItems.length} GL entries`
                                    : selectedGLItems.length === 1 && selectedBSItems.length > 1
                                      ? `${selectedBSItems.length} BS entries matched with 1 GL entry`
                                      : `${Math.min(selectedBSItems.length, selectedGLItems.length)} pair(s) will be matched`}
                                </div>
                              </div>
                            </div>
                          </div>
                          <div className="flex gap-2 flex-shrink-0">
                            <Button size="sm" onClick={() => handleManualMatch()} className="bg-emerald-600 hover:bg-emerald-700 text-white">
                              <Link2 className="h-4 w-4 mr-1" /> Match Selected ({selectedBSItems.length === 1 && selectedGLItems.length > 1 ? selectedGLItems.length : selectedGLItems.length === 1 && selectedBSItems.length > 1 ? selectedBSItems.length : Math.min(selectedBSItems.length, selectedGLItems.length)} pairs)
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => {
                              setSelectedBSItems([]);
                              setSelectedGLItems([]);
                            }}>
                              Clear Selection
                            </Button>
                          </div>
                        </div>
                        {/* Same-side reversal options when both sides have selections */}
                        {(bsReversalPossible || glReversalPossible) && (
                          <div className="flex items-center gap-3 py-2 px-3 bg-orange-50 rounded-lg border border-orange-200">
                            <RefreshCw className="h-4 w-4 text-orange-600 flex-shrink-0" />
                            <span className="text-xs text-orange-700 font-medium">Same-side reversal detected!</span>
                            {bsReversalPossible && (
                              <Button size="sm" onClick={() => {
                                if (!result) return;
                                const updated = markAsManualReversal(
                                  result,
                                  'bs',
                                  selectedBSItems.map(i => i.uniqueKey),
                                  'Manual BS reversal by user'
                                );
                                setResult(updated);
                                setSelectedBSItems([]);
                                setSelectedGLItems([]);
                                setSelectionMode('none');
                                toast({ title: 'BS Reversal Marked', description: `${selectedBSItems.length} BS entries marked as reversal pair(s)` });
                              }} className="bg-orange-600 hover:bg-orange-700 text-white text-xs h-7">
                                <RefreshCw className="h-3 w-3 mr-1" /> Mark as BS Reversal
                              </Button>
                            )}
                            {glReversalPossible && (
                              <Button size="sm" onClick={() => {
                                if (!result) return;
                                const updated = markAsManualReversal(
                                  result,
                                  'gl',
                                  selectedGLItems.map(i => i.uniqueKey),
                                  'Manual GL reversal by user'
                                );
                                setResult(updated);
                                setSelectedBSItems([]);
                                setSelectedGLItems([]);
                                setSelectionMode('none');
                                toast({ title: 'GL Reversal Marked', description: `${selectedGLItems.length} GL entries marked as reversal pair(s)` });
                              }} className="bg-orange-600 hover:bg-orange-700 text-white text-xs h-7">
                                <RefreshCw className="h-3 w-3 mr-1" /> Mark as GL Reversal
                              </Button>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </CardContent>
              </Card>
            </TabsContent>
          </Tabs>
        )}
      </main>
    </div>
  );
}
