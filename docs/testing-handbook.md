# 测试手册 (Testing Handbook)

> 数据分析平台的测试策略与执行手册。**Claude/开发者在改动代码后，按 §2「场景速查表」自主选择该跑的测试层。**
>
> 维护规则：随架构或测试能力变化更新本文档。新增测试能力后，更新 §10 落地状态表。
> 现状标注：✅ 已具备 ｜ 🟡 部分/临时 ｜ ⏳ 待落地

---

## 0. 怎么用这本手册

- **改代码前/后** → 看 §2 场景速查表，选必跑测试
- **改架构/加环境前** → 看 §1 测试金字塔，确认覆盖；按 CLAUDE.md 架构变更流程走
- **上线前** → 过 §9 发布检查清单（go/no-go）
- **Claude 自主判断原则**：默认按速查表跑；速查表未覆盖的改动，按「就近归类 + 风险递增」选——先本地，过则 CI，影响企微/数据则 staging。

---

## 1. 测试金字塔（四层）

```
本地(dev-login+mock) → CI(自动化门禁) → staging(企微测试应用) → 生产(分支+回滚)
   应用内+RLS+function逻辑   代码质量+单测+e2e   企微端到端+部署验证   灰度+快速回滚
```

| 层 | 职责 | 现状 | 触发 |
|---|---|---|---|
| **本地** | UI 流转、admin、**RLS 参数化**、function mock 单测、采集签名/加解密逻辑 | 🟡 栈已起，dev-login/mock 待补 | 开发者自行 |
| **CI** | lint + tsc + function check（hard gate） | ✅ 已有；vitest/e2e 待加 | push/PR |
| **staging** | 真企微端到端（OAuth/同步/推送/回调）、部署流程验证 | ⏳ 待落地 | develop 分支 |
| **生产** | 灰度发布、版本回滚 | ⏳ 待落地（当前 main 全量直发） | main 分支 |

---

## 2. 场景 → 测试层速查表（核心，Claude 按此自主选择）

| 改动类型 | 本地 | CI | staging | 生产 |
|---|---|---|---|---|
| 前端页面/组件 UI | dev-login + 手动看页面 + playwright e2e | tsc/lint | — | — |
| 前端 lib 逻辑（api/auth/collect/scheduler/monitor/report-center） | vitest 单测 + dev-login 验证 | vitest + tsc | — | — |
| Edge function（wecom-*/agent-query/collect-*） | **mock 企微 API 单测** + 直调 function 验证 | function check | **真企微端到端** | 验证性 curl |
| 数据库迁移（新表/视图/RPC/RLS） | 本地 migrate 重跑 + 数据验证 + restart postgrest | migrate 幂等检查 | 跑一次确认 | — |
| 采集逻辑（collect*.ts） | mock 单测 + 真实 token 本地跑一次（如有） | function check | — | 看 collect_logs |
| **RLS / 权限改动** | **伪造 claim 参数化测试**（核心） | — | 真企微用户验证 | — |
| DuckDB service（services/server.js） | 直调 /query /transform /compute 验证 | — | — | — |
| OpenClaw 插件（data-query/notify） | POST agent-query 网关模拟 userId | — | 真企微 channel | — |
| 部署/配置（compose/nginx/CI/deploy.sh） | — | — | **staging 验证部署** | 灰度 |
| DESIGN.md 相关 UI | 对照 DESIGN.md 检查（emoji/色彩/tabular-nums/icon） | — | — | — |

> 速查表未覆盖的改动：按「就近归类 + 风险递增」——先本地必跑，过则 CI，触及企微/数据流向/部署则上 staging。

---

## 3. 本地层 SOP（🟡 栈已起，测试能力待补）

### 3.1 起本地栈（✅ 已验证可用）

```bash
# 1. 登录私有镜像仓库（凭证见 1Password/deploy 备注）
docker login caj9ik14016wep.xuanyuan.run
docker login registry-crs-xinan1.ctyun.cn

# 2. 起 5 容器（Apple Silicon 走 amd64 模拟）
cd deploy
DOCKER_DEFAULT_PLATFORM=linux/amd64 docker compose -f docker-compose.yml -f docker-compose.override.yml up -d

# 3. 迁移（幂等可重跑）
bash ../scripts/migrate.sh
docker restart deploy-postgrest-1   # 刷 schema 缓存（迁移后必做）

# 4. 起前端
cd ../web && npm run dev   # http://localhost:3000
```

**已知本地限制**（不影响启动，影响完整功能）：
- InsForge 网关 7130 无 `/rest/v1` 路由 → 前端 SDK 读数据路径需走网关或配 nginx（待解决）
- `deploy/.env` 缺 `WECOM_*`/`AGENT_API_KEY`/`OOS_*` → 采集/推送/智能问数功能受限
- `auth_credentials`/`collect_tasks`/`collect_logs` 为反推 schema（按代码用法建，可能与生产略有差异）

### 3.2 伪造登录 cookie（🟡 临时脚本可用，dev-login 端点待实现）

**临时**：`scripts/dev-token.sh` 生成测试用户 JWT（已验证可骗过 middleware + admin 白名单）：
```bash
JWT_SECRET=$(grep '^JWT_SECRET=' deploy/.env | cut -d= -f2- | tr -d '"')
TOKEN=$(JWT_SECRET="$JWT_SECRET" node -e '
  const c=require("crypto");const s=process.env.JWT_SECRET;
  const h=Buffer.from(JSON.stringify({alg:"HS256",typ:"JWT"})).toString("base64url");
  const now=Math.floor(Date.now()/1000);
  const p=Buffer.from(JSON.stringify({sub:"ZhangDuo",role:"authenticated",departments:["1"],branch_nums:["*"],can_see_cost:true,iss:"dev-bypass",iat:now,exp:now+604800})).toString("base64url");
  console.log(h+"."+p+"."+c.createHmac("sha256",s).update(h+"."+p).digest("base64url"));')
# 浏览器 DevTools → Application → Cookies → http://localhost:3000 设：
#   insforge_access_token = $TOKEN
#   wecom_userid = ZhangDuo   (admin 白名单：ZhangDuo / YangWei)
#   wecom_name = 张铎
```

**待实现**（推荐）：`web/app/api/auth/dev-login/route.ts`，dev-only（`NODE_ENV!=='production'` 自我禁用），访问即 Set-Cookie 跳首页。浏览器一键登录。

### 3.3 RLS 参数化测试（✅ 最佳方式——伪造任意 claim）

RLS 读 JWT claim，不关心 JWT 来源。**伪造 cookie 能参数化造任意权限用户**，比真企微更好测：

| 测试场景 | 伪造 claim | 预期 |
|---|---|---|
| 全权限 | `branch_nums:["*"], can_see_cost:true` | 全数据 + 成本列可见 |
| 单店 | `branch_nums:["54"]` | 只看 54 店 |
| 多店 | `branch_nums:["54","127"]` | 只看这两店 |
| 无成本权限 | `can_see_cost:false` | 成本列 NULL（`report_*_v` 的 CASE 脱敏） |
| 跨品牌 | （RLS 不含 brand，靠查询层；测 LATERAL WHERE） | — |

用 §3.2 脚本改 claim 重签，curl 带 cookie 验证返回数据范围。

### 3.4 mock 企微 function 单测（⏳ 模板待建）

`functions/wecom-*` 的业务逻辑可脱离真企微单测——mock 企微 API 响应：
- `wecom-oauth`：mock `gettoken`/`getuserinfo` → 验证 code→userid→签JWT→upsert
- `wecom-sync-contacts`：mock `department/list`/`user/list` → 验证 upsert + 软删除守卫
- `wecom-notify`：mock `message/send` → 验证各类 msgtype 分派
- `wecom-contacts-webhook`：用已知 TOKEN/AES_KEY **自签测试 XML** → 验证加解密 + receiveid 校验 + ChangeType 分派（不连真企微）
- `agent-query`：直接 POST `{sql, userId, agent_api_key}` 模拟不同 userId → 验证 perms 裁剪

模板放 `web/lib/__tests__/` 或 `functions/__tests__/`（vitest，environment=node）。

### 3.5 灌测试数据（⏳ 待建 fixture）

本地库无业务数据（首页显示"暂无目标"）。建 `database/test-fixtures/`：
- `dim_branch`：4 战区各几店（东部/南部/西部/中部，is_assessed_war_zone 白名单内）
- `dim_item`：跨两品牌 + canonical 合并样例
- `targets` + `target_metric_values`：一个 active 总部目标（hq 品类分解）+ 一个门店目标
- `report_daily_sales`/`_delivery`/`_wholesale`：一周样例数据（带品类组）
- `auth_credentials`：测试 Lemeng token

### 3.6 跑自动化

```bash
cd web
npm run test          # vitest 单测（lib/**.test.ts）
npx playwright test   # e2e（用 dev-login cookie fixture）
```

---

## 4. CI 层（✅ 已有门禁，🟡 待加单测/e2e）

现有（`.github/workflows/deploy.yml` quality job，hard gate）：
- ✅ `npx tsc --noEmit`
- ✅ `bash scripts/check-functions.sh`
- ✅ `npm run lint`（warning 不阻断）

待加：
- ⏳ `npm run test`（vitest，含 mock 企微 function）
- ⏳ `npx playwright test`（e2e，dev-login cookie fixture）

---

## 5. staging 层（⏳ 待落地——解决"生产前测企微"的核心）

> 涉及加环境 + 企微测试应用配置 = 架构变更。按 CLAUDE.md 流程：方案对比 → 用户同意 → 更新 architecture.md → 实现。

**规划**：
- 同一台服务器起第二套 compose（端口偏移 + 子域名 `staging.data.shanhaiyiguo.com`）
- 独立 PG database（或 schema）+ 脱敏测试数据
- **企微测试应用**：企微后台再建 A-test/B-test 自建应用，OAuth 回调/通讯录同步/推送指向 staging 域名；加服务器出口 IP 到可信 IP
- `develop` 分支 → 自动部署 staging

**建后能测**：真 OAuth 登录、真通讯录同步、真消息推送、真回调验签、OpenClaw 真企微 channel、完整部署流程。

---

## 6. 生产层（⏳ 灰度/回滚待落地）

当前：`push main` → GHA 全量重建部署，无灰度、无版本、回滚靠 git revert 重部署。

**推荐渐进**：
1. ⏳ **分支策略**：`develop`→staging，`main`→生产。staging 验证 OK 再合 main
2. ⏳ **镜像版本 tag**：web 镜像打 `:git-sha`（不只 `:latest`），nginx 指定版本，出问题切回上版本
3. ⏳ **功能开关**：大功能包 `if(flag)`，按 env/用户灰度
4. （可选）蓝绿部署：双 upstream 切换——小团队可不必

---

## 7. 企微鉴权测试矩阵

| 环节 | 本地 | staging | 生产 |
|---|---|---|---|
| middleware 门禁 / admin 白名单 | ✅ 伪造 cookie | ✅ | 谨慎验证 |
| **RLS 行级权限** | ✅ **最佳**（参数化 claim） | ✅ | 不测 |
| wecom-oauth 登录流程 | mock 单测 | ✅ **真企微** | 验证性 |
| 通讯录同步 / 回调 webhook | mock 单测（自签 XML） | ✅ **真企微** | 不测 |
| 消息推送 wecom-notify | mock 单测 | ✅ **真企微** | 不测 |
| OpenClaw 智能问数 | POST 网关模拟 userId | ✅ 真企微 channel | 不测 |

---

## 8. 测试数据策略

- **本地**：§3.5 fixture（小规模样例，覆盖 4 战区/两品牌/品类组/target 各状态）
- **staging**：生产脱敏快照（去真实姓名/手机/成本）或合成数据
- **生产**：不造测试数据（用真实业务数据观察）
- **共享**：迁移种子数据（002 等）保持幂等，测试 fixture 独立文件不进生产迁移

---

## 9. 发布检查清单（go/no-go）

上线前过一遍：
- [ ] 本地：dev-login 过关键页面 + RLS 参数化测过 + 相关 function mock 单测绿
- [ ] CI：lint/tsc/function-check/vitest/playwright 全绿
- [ ] 迁移：本地重跑幂等通过 + restart postgrest 验证
- [ ] DESIGN.md：UI 改动对照检查（无 emoji / 色彩 token / tabular-nums / lucide icon）
- [ ] staging（若涉及企微/部署）：真企微端到端过 + 部署流程验证
- [ ] 回滚预案：知道上一个镜像版本 / git revert 路径
- [ ] 监控：改动若影响 collect/数据流，确认 collect_fail / data_freshness 监控仍生效

---

## 10. 落地状态总表

| 能力 | 状态 | 依赖 |
|---|---|---|
| 本地 5 容器栈 | ✅ | 私有仓库凭证 + amd64 模拟 |
| 本地迁移 + PostgREST | ✅ | — |
| 伪造 cookie 登录（临时脚本） | ✅ | deploy/.env 的 JWT_SECRET |
| dev-login 端点 | ⏳ | 加 route（dev-only） |
| RLS 参数化测试 | ✅ | 伪造 cookie 脚本 |
| mock 企微 function 单测模板 | ⏳ | 建 vitest fixture |
| 测试数据 fixture | ⏳ | 建 database/test-fixtures/ |
| CI: vitest + e2e | ⏳ | 加 GHA step |
| staging 环境 | ⏳ | 架构变更，需用户同意 |
| 企微测试应用 | ⏳ | 企微后台配置 |
| 生产分支策略 | ⏳ | develop 分支 + GHA |
| 生产镜像版本/回滚 | ⏳ | deploy.sh 打 tag |
```

---

我后续改代码时会**按 §2 速查表自主选测试层**（默认本地必跑，触及企微/部署则建议上 staging）。

手册已就位。要不要我现在把本地层的 ⏳ 项落地——**dev-login 端点 + mock 企微 function 单测模板 + 测试数据 fixture**？这三样做完，本地层就完整可用，后续开发我能在本地覆盖绝大部分测试。staging 那块（架构变更）我们另起一次按 CLAUDE.md 流程走。
