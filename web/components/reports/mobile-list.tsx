"use client";

import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import type { Report } from "@/lib/api";

interface MobileReportsListProps {
  reports: Report[];
}

export function MobileReportsList({ reports }: MobileReportsListProps) {
  return (
    <div className="space-y-3 p-4">
      {reports.map((report) => (
        <Link key={report.id} href={`/reports/${report.id}`}>
          <Card className="hover:shadow-md transition-shadow active:scale-[0.98]">
            <CardContent className="p-4">
              <div className="flex items-start justify-between mb-2">
                <h3 className="font-medium text-base">{report.name}</h3>
                <Badge variant="secondary" className="text-xs">
                  {report.updatedAt}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground mb-3 line-clamp-2">
                {report.description}
              </p>
              <div className="flex gap-4 overflow-x-auto pb-1">
                {report.metrics.slice(0, 2).map((metric, i) => (
                  <div key={i} className="flex-shrink-0">
                    <p className="text-xs text-muted-foreground">{metric.name}</p>
                    <p className="text-lg font-bold">{metric.value}</p>
                    {metric.change && (
                      <p
                        className={
                          metric.trend === "up"
                            ? "text-xs text-green-600"
                            : metric.trend === "down"
                              ? "text-xs text-red-600"
                              : "text-xs text-gray-600"
                        }
                      >
                        {metric.change}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </Link>
      ))}
    </div>
  );
}