"use client";

import Link from "next/link";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Report } from "@/lib/api";

interface ReportListProps {
  reports: Report[];
}

export function ReportList({ reports }: ReportListProps) {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {reports.map((report) => (
        <Card key={report.id} className="hover:shadow-md transition-shadow">
          <CardHeader className="flex flex-row items-center justify-between pb-2">
            <CardTitle className="text-lg font-medium">{report.name}</CardTitle>
            <Badge variant="secondary">{report.updatedAt}</Badge>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground mb-4">
              {report.description}
            </p>
            <div className="grid grid-cols-2 gap-4 mb-4">
              {report.metrics.map((metric, i) => (
                <div key={i}>
                  <p className="text-sm text-muted-foreground">{metric.name}</p>
                  <p className="text-2xl font-bold">{metric.value}</p>
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
            <Link href={`/reports/${report.id}`}>
              <Button variant="outline" className="w-full">
                查看详情
              </Button>
            </Link>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
