'use client';

import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { ChevronUp, ChevronDown, ChevronsUpDown, Filter, ArrowUp01, ArrowDown01, X, Search, Eye } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';

export interface ColumnDef<T> {
  key: string;
  label: string;
  width?: string;
  minWidth?: string;
  maxWidth?: string;
  flex?: string;
  align?: 'left' | 'right';
  sortable?: boolean;
  filterable?: boolean;
  isAmount?: boolean;
  wrap?: boolean;
  render?: (row: T, rowIndex: number) => React.ReactNode;
  getValue?: (row: T) => string | number | null;
}

interface SortState {
  column: string;
  direction: 'asc' | 'desc' | null;
}

interface FilterValueItem {
  raw: string;
  display: string;
  numeric: number;
  count: number;
}

interface DataTableProps<T> {
  data: T[];
  columns: ColumnDef<T>[];
  globalSearch?: string;
  rowKey: (row: T) => string;
  rowClassName?: (row: T) => string;
  maxHeight?: string;
  onRowClick?: (row: T) => void;
  emptyMessage?: string;
  /** Use 'fixed' for strict column widths with horizontal scroll; 'auto' (default) for content-driven sizing */
  tableLayout?: 'auto' | 'fixed';
}

function formatNumber(val: string | number | null): string {
  if (val === null || val === undefined) return '';
  const num = typeof val === 'number' ? val : parseFloat(String(val).replace(/,/g, ''));
  if (isNaN(num)) return String(val);
  return new Intl.NumberFormat('en-PK', { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(num);
}

function getCellValue<T>(col: ColumnDef<T>, row: T): string | number | null {
  return col.getValue ? col.getValue(row) : (row[col.key] as string | number | null);
}

function compareValues(aVal: string | number | null, bVal: string | number | null, direction: 'asc' | 'desc'): number {
  // Nulls always go last
  if (aVal === null || aVal === undefined) return 1;
  if (bVal === null || bVal === undefined) return -1;

  // Try numeric comparison
  const aNum = typeof aVal === 'number' ? aVal : parseFloat(String(aVal).replace(/,/g, ''));
  const bNum = typeof bVal === 'number' ? bVal : parseFloat(String(bVal).replace(/,/g, ''));

  if (!isNaN(aNum) && !isNaN(bNum)) {
    return direction === 'asc' ? aNum - bNum : bNum - aNum;
  }

  // String comparison
  const aStr = String(aVal);
  const bStr = String(bVal);
  return direction === 'asc' ? aStr.localeCompare(bStr) : bStr.localeCompare(aStr);
}

export function DataTable<T extends Record<string, unknown>>({
  data,
  columns,
  globalSearch = '',
  rowKey,
  rowClassName,
  maxHeight = '500px',
  onRowClick,
  emptyMessage = 'No data found',
  tableLayout = 'auto',
}: DataTableProps<T>) {
  const [sortState, setSortState] = useState<SortState>({ column: '', direction: null });
  const [filterState, setFilterState] = useState<Record<string, Set<string>>>({});
  const [filterSearch, setFilterSearch] = useState<Record<string, string>>({});
  const [openFilterCol, setOpenFilterCol] = useState<string | null>(null);

  // Reset sort/filter only when column KEYS change (not reference)
  const columnKeys = columns.map(c => c.key).join(',');
  useEffect(() => {
    setSortState({ column: '', direction: null });
    setFilterState({});
    setFilterSearch({});
  }, [columnKeys]);

  // Unified sort handler — called from both column header click and filter popover
  const setSort = useCallback((columnKey: string, direction: 'asc' | 'desc') => {
    setSortState({ column: columnKey, direction });
  }, []);

  const clearSort = useCallback(() => {
    setSortState({ column: '', direction: null });
  }, []);

  // Cycle sort: none → asc → desc → none
  const cycleSort = useCallback((columnKey: string) => {
    setSortState(prev => {
      if (prev.column !== columnKey) return { column: columnKey, direction: 'asc' };
      if (prev.direction === 'asc') return { column: columnKey, direction: 'desc' };
      if (prev.direction === 'desc') return { column: '', direction: null };
      return { column: columnKey, direction: 'asc' };
    });
  }, []);

  const toggleFilterValue = useCallback((columnKey: string, value: string) => {
    setFilterState(prev => {
      const current = prev[columnKey] || new Set<string>();
      const next = new Set(current);
      if (next.has(value)) next.delete(value); else next.add(value);
      return { ...prev, [columnKey]: next };
    });
  }, []);

  const selectAllFilter = useCallback((columnKey: string) => {
    setFilterState(prev => ({ ...prev, [columnKey]: new Set<string>() }));
  }, []);

  const deselectAllFilter = useCallback((columnKey: string, values: string[]) => {
    setFilterState(prev => ({ ...prev, [columnKey]: new Set(values) }));
  }, []);

  // Apply: hide all unchecked, show only checked
  const applyFilter = useCallback((columnKey: string, allValues: string[]) => {
    setFilterState(prev => {
      const hidden = prev[columnKey] || new Set<string>();
      const checkedValues = allValues.filter(v => !hidden.has(v));
      if (checkedValues.length === 0) return prev;
      const newHidden = new Set(allValues.filter(v => !checkedValues.includes(v)));
      return { ...prev, [columnKey]: newHidden };
    });
  }, []);

  const getUniqueValues = useCallback((column: ColumnDef<T>): FilterValueItem[] => {
    const countMap = new Map<string, number>();
    const displayMap = new Map<string, string>();
    const numericMap = new Map<string, number>();

    for (const row of data) {
      const val = getCellValue(column, row);
      if (val !== null && val !== undefined && String(val) !== '' && String(val) !== '0') {
        const rawStr = String(val);
        countMap.set(rawStr, (countMap.get(rawStr) || 0) + 1);
        if (!displayMap.has(rawStr)) {
          const numVal = parseFloat(rawStr.replace(/,/g, ''));
          displayMap.set(rawStr, column.isAmount ? formatNumber(val) : rawStr);
          numericMap.set(rawStr, isNaN(numVal) ? Infinity : numVal);
        }
      }
    }

    const items: FilterValueItem[] = [];
    for (const [raw, count] of countMap) {
      items.push({ raw, display: displayMap.get(raw) || raw, numeric: numericMap.get(raw) ?? Infinity, count });
    }

    items.sort((a, b) => column.isAmount ? a.numeric - b.numeric : a.display.localeCompare(b.display));
    return items;
  }, [data]);

  // Use ref for columns to avoid memo dependency on reference changes
  const columnsRef = useRef(columns);
  columnsRef.current = columns;

  // Main data pipeline: search → filter → sort
  const processedData = useMemo(() => {
    let result = [...data];
    const cols = columnsRef.current;

    // Global search
    if (globalSearch) {
      const s = globalSearch.toLowerCase();
      result = result.filter(row => cols.some(col => {
        const val = getCellValue(col, row);
        return val !== null && val !== undefined && String(val).toLowerCase().includes(s);
      }));
    }

    // Column filters (exclusion: values in Set are HIDDEN)
    for (const col of cols) {
      const filter = filterState[col.key];
      if (filter && filter.size > 0) {
        result = result.filter(row => {
          const val = getCellValue(col, row);
          const strVal = val !== null && val !== undefined ? String(val) : '';
          return !filter.has(strVal);
        });
      }
    }

    // Sort
    if (sortState.column && sortState.direction) {
      const col = cols.find(c => c.key === sortState.column);
      if (col) {
        result.sort((a, b) => {
          const aVal = getCellValue(col, a);
          const bVal = getCellValue(col, b);
          return compareValues(aVal, bVal, sortState.direction!);
        });
      }
    }

    return result;
  }, [data, columnKeys, globalSearch, filterState, sortState]);

  const getFilterCount = useCallback((columnKey: string) => {
    return filterState[columnKey]?.size || 0;
  }, [filterState]);

  const getHeaderStyle = (col: ColumnDef<T>): React.CSSProperties => {
    const style: React.CSSProperties = { textAlign: col.align || 'left' };
    if (col.width) {
      style.width = col.width;
      // Don't set minWidth for percentage widths (used in fixed layout)
      if (!col.width.endsWith('%')) style.minWidth = col.width;
    }
    if (col.minWidth) style.minWidth = col.minWidth;
    if (col.wrap) { style.whiteSpace = 'normal'; style.wordBreak = 'break-word'; style.overflowWrap = 'break-word'; }
    return style;
  };

  const getCellStyle = (col: ColumnDef<T>): React.CSSProperties => {
    const style: React.CSSProperties = { textAlign: col.align || 'left' };
    if (col.width) {
      style.width = col.width;
      if (!col.width.endsWith('%')) style.minWidth = col.width;
    }
    if (col.minWidth) style.minWidth = col.minWidth;
    if (col.maxWidth) style.maxWidth = col.maxWidth;
    if (col.wrap) { style.whiteSpace = 'normal'; style.wordBreak = 'break-word'; style.overflowWrap = 'break-word'; }
    // For fixed layout non-wrap columns, add overflow ellipsis
    if (tableLayout === 'fixed' && !col.wrap) {
      style.overflow = 'hidden';
      style.textOverflow = 'ellipsis';
      style.whiteSpace = 'nowrap';
    }
    return style;
  };

  const renderSortIndicator = (col: ColumnDef<T>) => {
    if (sortState.column === col.key && sortState.direction === 'asc') {
      return col.isAmount ? <ArrowUp01 className="h-3.5 w-3.5 ml-0.5 text-emerald-600" /> : <ChevronUp className="h-3.5 w-3.5 ml-0.5 text-emerald-600" />;
    }
    if (sortState.column === col.key && sortState.direction === 'desc') {
      return col.isAmount ? <ArrowDown01 className="h-3.5 w-3.5 ml-0.5 text-emerald-600" /> : <ChevronDown className="h-3.5 w-3.5 ml-0.5 text-emerald-600" />;
    }
    return <ChevronsUpDown className="h-3 w-3 ml-0.5 opacity-30" />;
  };

  const tableMinWidth = useMemo(() => {
    let total = 0;
    let hasPercentage = false;
    for (const col of columns) {
      const w = col.width || col.minWidth || '120';
      if (w.endsWith('%')) {
        hasPercentage = true;
        total += 120; // fallback estimate for percentage columns
      } else {
        total += parseInt(w, 10) || 120;
      }
    }
    // If using percentage widths with fixed layout, no minWidth needed
    if (hasPercentage && tableLayout === 'fixed') return undefined;
    return `${Math.max(total, 600)}px`;
  }, [columns, tableLayout]);

  // Both axes scroll on the SAME element (shadcn's inner table-container div) so that both
  // scrollbars sit at the edges of the visible maxHeight box, not at the bottom of all rows.
  const containerStyle: React.CSSProperties = maxHeight === 'none'
    ? { overflowY: 'visible', overflowX: 'visible', width: '100%' }
    : { maxHeight, overflowY: 'auto', width: '100%' };

  const innerRef = useRef<HTMLDivElement>(null);
  const dragState = useRef<{ dragging: boolean; startX: number; startY: number; scrollLeft: number; scrollTop: number }>({
    dragging: false, startX: 0, startY: 0, scrollLeft: 0, scrollTop: 0,
  });

  const handlePointerDown = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    // Ignore drags starting on interactive elements so clicks/selection still work normally
    const target = e.target as HTMLElement;
    if (target.closest('button, a, input, select, textarea, [role="checkbox"]')) return;
    const el = innerRef.current;
    if (!el) return;
    e.preventDefault(); // avoid starting a native text-selection drag
    window.getSelection()?.removeAllRanges();
    dragState.current = { dragging: true, startX: e.clientX, startY: e.clientY, scrollLeft: el.scrollLeft, scrollTop: el.scrollTop };
  }, []);

  const handlePointerMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const el = innerRef.current;
    const state = dragState.current;
    if (!state.dragging || !el) return;
    // Suppress native text selection while dragging to scroll
    e.preventDefault();
    el.scrollLeft = state.scrollLeft - (e.clientX - state.startX);
    el.scrollTop = state.scrollTop - (e.clientY - state.startY);
  }, []);

  const endDrag = useCallback(() => {
    dragState.current.dragging = false;
  }, []);

  // Filter popover content
  const renderFilterContent = (col: ColumnDef<T>) => {
    const allFilterItems = getUniqueValues(col);
    const searchStr = (filterSearch[col.key] || '').trim();
    const hiddenCount = getFilterCount(col.key);
    const totalValues = allFilterItems.length;
    const visibleValues = totalValues - hiddenCount;
    const allRawValues = allFilterItems.map(item => item.raw);

    const filteredItems = searchStr
      ? allFilterItems.filter(item => {
          const s = searchStr.toLowerCase();
          if (item.display.toLowerCase().includes(s)) return true;
          if (item.raw.toLowerCase().includes(s)) return true;
          if (col.isAmount) {
            const numSearch = searchStr.replace(/,/g, '');
            if (String(item.numeric).startsWith(numSearch)) return true;
            if (item.raw.replace(/[^0-9]/g, '').startsWith(numSearch)) return true;
          }
          return false;
        })
      : allFilterItems;

    return (
      <div className="w-72" onClick={(e) => e.stopPropagation()} onMouseDown={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="px-4 py-3 border-b border-slate-200 bg-slate-50/80 rounded-t-lg">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-semibold text-slate-800">{col.label}</p>
              <p className="text-[10px] text-slate-500 mt-0.5">
                {totalValues} unique values
                {hiddenCount > 0 && <span className="text-amber-600 font-medium"> · {visibleValues} shown · {hiddenCount} hidden</span>}
              </p>
            </div>
            {hiddenCount > 0 && (
              <button className="text-[10px] text-red-500 hover:text-red-700 font-medium hover:bg-red-50 px-2 py-1 rounded" onClick={() => setFilterState(prev => ({ ...prev, [col.key]: new Set<string>() }))}>
                Reset
              </button>
            )}
          </div>
        </div>

        {/* Sort buttons */}
        <div className="px-4 py-2 border-b border-slate-100 flex items-center gap-2">
          <span className="text-[10px] text-slate-400 font-medium uppercase tracking-wider mr-1">Sort:</span>
          <button
            className={`flex-1 h-7 text-[11px] rounded-md flex items-center justify-center gap-1 transition-all font-medium ${sortState.column === col.key && sortState.direction === 'asc' ? 'bg-emerald-100 text-emerald-700 shadow-sm' : 'bg-white text-slate-500 hover:bg-slate-50 border border-slate-200'}`}
            onClick={() => setSort(col.key, 'asc')}
          >
            <ArrowUp01 className="h-3 w-3" /> Asc
          </button>
          <button
            className={`flex-1 h-7 text-[11px] rounded-md flex items-center justify-center gap-1 transition-all font-medium ${sortState.column === col.key && sortState.direction === 'desc' ? 'bg-emerald-100 text-emerald-700 shadow-sm' : 'bg-white text-slate-500 hover:bg-slate-50 border border-slate-200'}`}
            onClick={() => setSort(col.key, 'desc')}
          >
            <ArrowDown01 className="h-3 w-3" /> Desc
          </button>
          {sortState.column === col.key && (
            <button className="h-7 px-2 text-red-500 hover:bg-red-50 rounded-md" onClick={clearSort}>
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        {/* Search */}
        <div className="px-4 py-2 border-b border-slate-100">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400" />
            <Input
              placeholder={col.isAmount ? "Search amount (e.g. 11164)..." : "Search values..."}
              className="h-8 text-xs pl-8 bg-white border-slate-200 focus:border-emerald-400 focus:ring-emerald-400"
              value={filterSearch[col.key] || ''}
              onChange={(e) => setFilterSearch(prev => ({ ...prev, [col.key]: e.target.value }))}
            />
          </div>
        </div>

        {/* Controls */}
        <div className="px-4 py-2 border-b border-slate-100 space-y-2">
          <div className="flex gap-1.5">
            <button className="flex-1 h-7 text-[11px] font-medium rounded-md bg-white text-slate-600 hover:bg-emerald-50 hover:text-emerald-700 border border-slate-200" onClick={() => selectAllFilter(col.key)}>
              Select All
            </button>
            <button className="flex-1 h-7 text-[11px] font-medium rounded-md bg-white text-slate-600 hover:bg-red-50 hover:text-red-700 border border-slate-200" onClick={() => deselectAllFilter(col.key, allRawValues)}>
              Deselect All
            </button>
          </div>
          {hiddenCount > 0 && visibleValues > 0 && (
            <button
              className="w-full h-8 text-[11px] font-semibold rounded-md bg-emerald-600 text-white hover:bg-emerald-700 flex items-center justify-center gap-1.5 shadow-sm"
              onClick={() => applyFilter(col.key, allRawValues)}
            >
              <Eye className="h-3.5 w-3.5" />
              Show {visibleValues} Selected Only
            </button>
          )}
        </div>

        {/* Value list */}
        <ScrollArea className="max-h-56">
          <div className="py-1">
            {filteredItems.length === 0 ? (
              <div className="px-4 py-6 text-center">
                <p className="text-xs text-slate-400">No values match &quot;{searchStr}&quot;</p>
              </div>
            ) : (
              filteredItems.map(item => {
                const isChecked = !filterState[col.key]?.has(item.raw);
                return (
                  <label key={item.raw} className={`flex items-center gap-2.5 px-4 py-1.5 cursor-pointer hover:bg-slate-50 ${!isChecked ? 'bg-red-50/50' : ''}`}>
                    <Checkbox
                      checked={isChecked}
                      onCheckedChange={() => toggleFilterValue(col.key, item.raw)}
                      className={`h-3.5 w-3.5 rounded ${isChecked ? 'border-emerald-400 data-[state=checked]:bg-emerald-500 data-[state=checked]:border-emerald-500' : 'border-slate-300'}`}
                    />
                    <span className={`text-xs flex-1 ${isChecked ? 'text-slate-800' : 'text-slate-400 line-through'}`} title={item.display}>
                      {item.display}
                    </span>
                    {item.count > 1 && (
                      <Badge variant="secondary" className="h-4 px-1.5 text-[9px] font-medium bg-slate-100 text-slate-500">{item.count}</Badge>
                    )}
                  </label>
                );
              })
            )}
          </div>
        </ScrollArea>
      </div>
    );
  };

  return (
    <div className="relative">
      <Table
        containerRef={innerRef}
        containerClassName="relative recon-table-scroll cursor-grab active:cursor-grabbing"
        containerProps={{
          style: containerStyle,
          onMouseDown: handlePointerDown,
          onMouseMove: handlePointerMove,
          onMouseUp: endDrag,
          onMouseLeave: endDrag,
        }}
        style={{
          tableLayout,
          ...(tableLayout === 'fixed' ? { width: '100%' } : { minWidth: tableMinWidth || '600px' }),
        }}
      >
        <TableHeader className="sticky top-0 z-10 bg-background">
          <TableRow>
            {columns.map(col => (
              <TableHead key={col.key} style={getHeaderStyle(col)} className={col.wrap ? 'text-xs' : 'text-xs whitespace-nowrap'}>
                <div className="flex items-center gap-1 relative">
                  {col.sortable !== false ? (
                    <Button variant="ghost" size="sm" className="h-6 px-1 text-xs font-medium" onClick={() => cycleSort(col.key)}>
                      {col.label}
                      {renderSortIndicator(col)}
                    </Button>
                  ) : (
                    <span className="px-1">{col.label}</span>
                  )}
                  {col.filterable !== false && (
                    <Popover
                      open={openFilterCol === col.key}
                      onOpenChange={(open) => {
                        setOpenFilterCol(open ? col.key : null);
                        if (!open) setFilterSearch(prev => ({ ...prev, [col.key]: '' }));
                      }}
                    >
                      <PopoverTrigger asChild>
                        <Button variant="ghost" size="sm" className={`h-6 w-6 p-0 rounded ${getFilterCount(col.key) > 0 ? 'bg-emerald-100 hover:bg-emerald-200' : 'hover:bg-slate-100'}`}>
                          <Filter className={`h-3 w-3 ${getFilterCount(col.key) > 0 ? 'text-emerald-600' : 'text-slate-400'}`} />
                          {getFilterCount(col.key) > 0 && (
                            <Badge className="absolute -top-1 -right-1 h-4 min-w-4 px-1 text-[9px] flex items-center justify-center bg-emerald-600 text-white border-2 border-white">
                              {getFilterCount(col.key)}
                            </Badge>
                          )}
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0 shadow-xl rounded-lg border border-slate-200" align="start" sideOffset={4}>
                        {renderFilterContent(col)}
                      </PopoverContent>
                    </Popover>
                  )}
                </div>
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {processedData.length === 0 ? (
            <TableRow>
              <TableCell colSpan={columns.length} className="text-center text-sm text-slate-500 py-8">{emptyMessage}</TableCell>
            </TableRow>
          ) : (
            processedData.map((row, i) => (
              <TableRow key={rowKey(row)} className={rowClassName ? rowClassName(row) : ''} onClick={() => onRowClick?.(row)} style={onRowClick ? { cursor: 'pointer' } : undefined}>
                {columns.map(col => (
                  <TableCell key={col.key} className={`text-xs py-2 ${col.wrap ? 'break-words' : 'whitespace-nowrap'}`} style={getCellStyle(col)}>
                    {col.render ? col.render(row, i) : (row[col.key] as React.ReactNode)}
                  </TableCell>
                ))}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
