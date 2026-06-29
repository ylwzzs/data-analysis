"use client";

import Link from "next/link";
import { ChevronRight } from "lucide-react";

import type { Report } from "@/lib/api";

interface ReportCardProps {
  report: Report;
}

export function ReportCard({ report }: ReportCardProps) {
  return (
    <Link href={`/mobile/reports/${report.id}`}>
      <div className="bg-white rounded-lg p-4 shadow-sm border">
        <div className="flex items-center justify-between mb-2">
          <h3 className="font-medium">{report.name}</h3>
          <span className="text-xs text-muted-foreground">
            {report.updatedAt}
          </span>
        </div>
        <div className="flex items-center justify-between">
          <div className="flex gap-4">
            {report.metrics.slice(0, 2).map((m, i) => (
              <div key={i}>
                <p className="text-xs text-muted-foreground">{m.name}</p>
                <p className="text-lg font-semibold">{m.value}</p>
              </div>
            ))}
          </div>
          <ChevronRight className="w-5 h-5 text-muted-foreground" />
        </div>
      </div>
    </Link>
  );
}
