import { createClient } from '@insforge/sdk';
import type { CheckType, EvalDeps } from './types';
import { SdkStore } from './store';
import { runScan } from './engine';
import { EVALUATORS } from './evaluators';
import { probe as probeFn } from './probe';

const INSFORGE_API_BASE = process.env.INSFORGE_API_BASE!;
const INSFORGE_API_KEY = process.env.INSFORGE_API_KEY!;

function newClient() {
  return createClient({ baseUrl: INSFORGE_API_BASE, anonKey: INSFORGE_API_KEY });
}

function buildDeps(): EvalDeps {
  const client = newClient();
  return {
    now: new Date(),
    probe: (url, opts) => probeFn(url, opts),
    getCredentialToken: async (sourceId) => {
      const { data, error } = await client.database
        .from('auth_credentials')
        .select('credential_data')
        .eq('source_id', sourceId)
        .maybeSingle();
      if (error || !data?.credential_data) return null;
      try {
        const cred = JSON.parse(data.credential_data);
        return cred.token ?? null;
      } catch {
        return null;
      }
    },
  };
}

// 各扫描桶（Phase A：service_down/token_expire 生效；后两桶 Phase B 填）
export async function runServiceDownBucket() {
  try {
    await runScan(new SdkStore(newClient()), ['service_down'] as CheckType[], buildDeps(), EVALUATORS);
  } catch (e: any) {
    console.error('[monitor] service_down bucket 异常:', e?.message ?? e);
  }
}

export async function runCollectTokenBucket() {
  try {
    await runScan(new SdkStore(newClient()), ['collect_fail', 'request_fail', 'token_expire'] as CheckType[], buildDeps(), EVALUATORS);
  } catch (e: any) {
    console.error('[monitor] collect/token bucket 异常:', e?.message ?? e);
  }
}

export async function runHourlyBucket() {
  try {
    await runScan(new SdkStore(newClient()), ['data_freshness', 'contact_sync'] as CheckType[], buildDeps(), EVALUATORS);
  } catch (e: any) {
    console.error('[monitor] hourly bucket 异常:', e?.message ?? e);
  }
}

export async function runDailyBucket() {
  try {
    await runScan(new SdkStore(newClient()), ['data_integrity'] as CheckType[], buildDeps(), EVALUATORS);
  } catch (e: any) {
    console.error('[monitor] daily bucket 异常:', e?.message ?? e);
  }
}
