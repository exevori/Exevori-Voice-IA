// ============================================================
// EXEVORI VOICE IA — DATATABLE (composant réutilisable)
// Linear-style : dense, sortable, hover actions, pagination
// Utilisé : Phase 3 (contacts), Phase 4 (calls, emails), Phase 5+
// ============================================================

import React, { useMemo, useState } from "react";
import { ChevronUp, ChevronDown, ChevronLeft, ChevronRight, MoreHorizontal, Inbox } from "lucide-react";
import { cn } from "../../lib/utils";

/**
 * Props:
 *  - columns: [{ key, header, render?, sortable?, width?, className? }]
 *  - data:    [{ ... }]
 *  - rowKey:  string | (row) => string
 *  - onRowClick: (row) => void
 *  - rowActions: (row) => ReactNode (rendered on hover)
 *  - emptyState: { icon, title, description }
 *  - pageSize: number (default 25)
 *  - loading: boolean
 *  - testId: string
 */
export default function DataTable({
  columns,
  data,
  rowKey = "id",
  onRowClick,
  rowActions,
  emptyState,
  pageSize = 25,
  loading,
  testId = "datatable",
}) {
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState("asc");
  const [page, setPage] = useState(1);

  const sorted = useMemo(() => {
    if (!sortKey) return data;
    const arr = [...(data || [])];
    arr.sort((a, b) => {
      const av = a?.[sortKey], bv = b?.[sortKey];
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "number" && typeof bv === "number") return sortDir === "asc" ? av - bv : bv - av;
      return sortDir === "asc"
        ? String(av).localeCompare(String(bv), "fr", { numeric: true })
        : String(bv).localeCompare(String(av), "fr", { numeric: true });
    });
    return arr;
  }, [data, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil((sorted?.length || 0) / pageSize));
  const currentPage = Math.min(page, totalPages);
  const paginated = sorted.slice((currentPage - 1) * pageSize, currentPage * pageSize);

  const toggleSort = (key) => {
    if (sortKey === key) setSortDir(sortDir === "asc" ? "desc" : "asc");
    else { setSortKey(key); setSortDir("asc"); }
  };

  const getRowKey = (row, idx) =>
    typeof rowKey === "function" ? rowKey(row) : row?.[rowKey] ?? idx;

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-bg-card" data-testid={testId}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-border bg-white/3">
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  style={col.width ? { width: col.width } : undefined}
                  className={cn(
                    "px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider text-text-secondary",
                    col.sortable !== false && col.key !== "actions" && "cursor-pointer hover:text-text-primary select-none",
                    col.headerClassName
                  )}
                  onClick={() => col.sortable !== false && col.key !== "actions" && toggleSort(col.key)}
                  data-testid={`th-${col.key}`}
                >
                  <span className="inline-flex items-center gap-1">
                    {col.header}
                    {col.sortable !== false && sortKey === col.key && (
                      sortDir === "asc" ? <ChevronUp size={12} /> : <ChevronDown size={12} />
                    )}
                  </span>
                </th>
              ))}
              {rowActions && <th className="w-12" />}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              [0,1,2,3,4].map((i) => (
                <tr key={i} className="border-b border-border last:border-0">
                  {columns.map((col) => (
                    <td key={col.key} className="px-4 py-3">
                      <div className="h-3 w-3/4 rounded bg-white/5 animate-pulse" />
                    </td>
                  ))}
                  {rowActions && <td />}
                </tr>
              ))
            ) : paginated.length === 0 ? (
              <tr>
                <td colSpan={columns.length + (rowActions ? 1 : 0)}>
                  <DataTableEmpty {...emptyState} />
                </td>
              </tr>
            ) : (
              paginated.map((row, idx) => (
                <tr
                  key={getRowKey(row, idx)}
                  data-testid={`row-${getRowKey(row, idx)}`}
                  onClick={onRowClick ? () => onRowClick(row) : undefined}
                  className={cn(
                    "group border-b border-border last:border-0 transition-colors",
                    onRowClick && "cursor-pointer hover:bg-white/4"
                  )}
                >
                  {columns.map((col) => (
                    <td key={col.key} className={cn("px-4 py-2.5 text-text-secondary", col.className)}>
                      {col.render ? col.render(row) : (row?.[col.key] ?? "—")}
                    </td>
                  ))}
                  {rowActions && (
                    <td className="px-2 py-2.5 text-right opacity-0 transition-opacity group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
                      {rowActions(row)}
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Footer pagination */}
      {!loading && sorted.length > 0 && (
        <div className="flex items-center justify-between border-t border-border px-4 py-2.5 text-xs text-text-secondary">
          <span data-testid="datatable-count">
            {sorted.length === 1 ? "1 résultat" : `${sorted.length} résultats`}
          </span>
          {totalPages > 1 && (
            <div className="flex items-center gap-1">
              <button
                onClick={() => setPage(Math.max(1, currentPage - 1))}
                disabled={currentPage === 1}
                data-testid="datatable-prev"
                className="rounded-md p-1.5 text-text-secondary hover:text-text-primary hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ChevronLeft size={14} />
              </button>
              <span className="px-2 tabular-nums">
                {currentPage} / {totalPages}
              </span>
              <button
                onClick={() => setPage(Math.min(totalPages, currentPage + 1))}
                disabled={currentPage === totalPages}
                data-testid="datatable-next"
                className="rounded-md p-1.5 text-text-secondary hover:text-text-primary hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <ChevronRight size={14} />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DataTableEmpty({ icon: Icon = Inbox, title = "Aucun résultat", description }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white/5 text-text-tertiary">
        <Icon size={20} />
      </div>
      <div className="text-sm font-medium text-text-primary">{title}</div>
      {description && <div className="max-w-xs text-xs text-text-secondary">{description}</div>}
    </div>
  );
}

export function RowActionButton({ children, ...props }) {
  return (
    <button
      {...props}
      onClick={(e) => { e.stopPropagation(); props.onClick && props.onClick(e); }}
      className={cn(
        "inline-flex items-center justify-center rounded-md p-1.5 text-text-secondary hover:text-text-primary hover:bg-white/5 transition-colors",
        props.className
      )}
    >
      {children}
    </button>
  );
}

export function ActionsDots({ onClick }) {
  return (
    <RowActionButton onClick={onClick}><MoreHorizontal size={14} /></RowActionButton>
  );
}
