import { describe, it, expect } from 'vitest';
import { parseAuditViewNames, computeAuditStats } from '../health';

describe('parseAuditViewNames', () => {
  it('extracts report_*_v_audit from definitions', () => {
    const openapi = {
      definitions: {
        report_store_sales_drill_v_audit: {},
        report_store_sales_drill_v: {},
        org_users: {},
      },
    };
    expect(parseAuditViewNames(openapi)).toEqual(['report_store_sales_drill_v_audit']);
  });
  it('falls back to paths, strips leading slash, dedups', () => {
    const openapi = { paths: { '/report_a_v_audit': {}, '/report_b_v_audit': {}, '/org_users': {} } };
    expect(parseAuditViewNames(openapi)).toEqual(['report_a_v_audit', 'report_b_v_audit']);
  });
  it('merges definitions + paths', () => {
    const openapi = {
      definitions: { report_a_v_audit: {} },
      paths: { '/report_b_v_audit': {} },
    };
    expect(parseAuditViewNames(openapi)).toEqual(['report_a_v_audit', 'report_b_v_audit']);
  });
  it('returns empty when none', () => {
    expect(parseAuditViewNames({ definitions: { org_users: {} } })).toEqual([]);
  });
});

describe('computeAuditStats', () => {
  it('finds _diff columns, computes max abs, sums _total', () => {
    const rows = [
      { region_total: 100, store_total: 100, region_vs_store_diff: 0, region_vs_sub_region_diff: 0.5 },
      { region_total: 200, store_total: 199, region_vs_store_diff: 1, region_vs_sub_region_diff: 0 },
    ];
    const s = computeAuditStats(rows);
    expect(s.status).toBe('warn');
    expect(s.diffColumns.find((d) => d.name === 'region_vs_store_diff')?.maxValue).toBe(1);
    expect(s.totals.region_total).toBe(300);
    expect(s.totals.store_total).toBe(299);
  });
  it('ok when all diffs < 0.01', () => {
    const rows = [{ region_total: 5, store_total: 5, region_vs_store_diff: 0.001 }];
    expect(computeAuditStats(rows).status).toBe('ok');
  });
  it('warn when any diff >= 0.01', () => {
    const rows = [{ region_total: 5, store_total: 4, region_vs_store_diff: 1 }];
    expect(computeAuditStats(rows).status).toBe('warn');
  });
  it('empty rows → ok, no diffColumns', () => {
    const s = computeAuditStats([]);
    expect(s.status).toBe('ok');
    expect(s.diffColumns).toEqual([]);
  });
  it('non-array (PostgREST error object) → ok, no crash', () => {
    const errObj = { code: 'PGRST205', message: 'Could not find the table', hint: '', details: '' };
    const s = computeAuditStats(errObj as any);
    expect(s.status).toBe('ok');
    expect(s.diffColumns).toEqual([]);
  });
});
