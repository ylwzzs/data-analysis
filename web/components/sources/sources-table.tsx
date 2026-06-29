"use client";

import { type ColumnDef } from "@tanstack/react-table";

import { DataTable } from "@/components/reports/data-table";
import { Badge } from "@/components/ui/badge";
import type { DataSource } from "@/lib/api";

const columns: ColumnDef<DataSource>[] = [
  { accessorKey: "name", header: "数据源" },
  { accessorKey: "apiEndpoint", header: "API 端点" },
  { accessorKey: "authType", header: "认证方式" },
  { accessorKey: "schedule", header: "调度" },
  {
    id: "status",
    header: "状态",
    cell: ({ row }) => (
      <Badge variant={row.original.enabled ? "default" : "secondary"}>
        {row.original.enabled ? "启用" : "禁用"}
      </Badge>
    ),
  },
  { accessorKey: "lastSync", header: "最后同步" },
  {
    id: "rowCount",
    header: "行数",
    cell: ({ row }) => (row.original.rowCount ?? 0).toLocaleString(),
  },
];

interface SourcesTableProps {
  data: DataSource[];
}

export function SourcesTable({ data }: SourcesTableProps) {
  return <DataTable columns={columns} data={data} />;
}
