# 角色归属与通讯录关联 补充 spec

**日期**：2026-07-22
**状态**：分析记录，待并入 `2026-07-20-permission-role-architecture-design.md`（该文件当前被 macOS 沙盒锁，EPERM，暂以独立文档承载）
**关联**：权限架构 spec §4.5、plan Task 6（同步联动）、本轮角色-通讯录调研

---

## 1. 角色归属：在本系统建，不在企微

角色（role）是「看数据的视角 / 数据权限划分」，是业务特有概念，企微通讯录里**没有这个东西**——企微只有行政组织（部门/岗位）。

### 1.1 概念边界（易混淆，先厘清）

| 概念 | 归属 | 性质 | 例子 |
|---|---|---|---|
| 部门 | 企微通讯录 | 行政组织架构（客观） | 水果部、东部战区、总经办 |
| 岗位 position | 企微通讯录 | 职务（客观） | 店长、采购员、财务 |
| **角色 role** | **本系统（roles 表）** | **数据权限划分（主观）** | boss/战区主管/店长/采购/财务 |
| 数据权限 | 本系统（data_permissions） | 四维范围 | branch_nums/brands/categories/can_see_cost |

### 1.2 不在企微建角色的理由

1. 企微无「数据范围」概念，部门/标签承载不了结构化的四维权限
2. 企微部门是行政划分，被权限需求绑架会违背组织逻辑（如「店长」是岗位但散在各门店部门下，无统一「店长部」）
3. 企微标签/可见范围能近似，但管理不便、无层级、数据权限仍要回本系统配，徒增同步依赖

### 1.3 正确分工

```
企微（身份 + 组织信号）              本系统（业务角色 + 权限）
wecom_id（身份锚）    ─────────────→  roles 表（boss/店长/采购…）
部门（行政组织）      ───映射(主)───→  data_permissions（四维）
岗位 position（职务）  ───映射(补)───→  dept_role_mapping（桥，部门）
                                    position→role（桥，岗位，待补）
```

企微只提供「信号」，本系统定义「角色 + 权限」，`dept_role_mapping`（部门）+ `position→role`（岗位）做映射桥。

---

## 2. 关联机制：设计 vs 现状

### 2.1 完整链路（设计）

```
企微通讯录同步 → ① 按 dept_role_mapping 写 role_id → ② get_user_perms 合并 → ③ wecom-oauth 签 claim → ④ RLS 视图过滤
                   ✗ 断裂（Task 6 未做）        ✅ 就绪        ✅ 就绪          ✅ 就绪
```

### 2.2 现状（调研结论）

| 环节 | 状态 |
|---|---|
| 表结构（roles/data_permissions/dept_role_mapping/org_users.role_id） | ✅ 072 建好 |
| 5 预置角色 + 部门→角色 regex 种子 | ✅ |
| **同步时写 role_id** | ❌ **断裂**：wecom-sync-contacts 和 webhook 都不消费 dept_role_mapping |
| get_user_perms 合并 RPC（角色+部门+个人 override + 临时授权时效） | ✅ |
| wecom-oauth 签四维 claim | ✅ |
| 四维 RLS 视图（report_*_v） | ✅ |
| admin 配置面（/admin/users、/admin/roles） | ❌ 全缺 |

**后果**：生产环境几乎所有 `org_users.role_id` 为 NULL（没人写它）。

---

## 3. ⚠️ 安全风险：fail-open

设计声称「未匹配 → 默认 manager 最小权限兜底」，但**运行时不是这样**：

- `get_user_perms` 对 `role_id=NULL` 的用户：角色层全空
- 若该用户所在部门的 `org_departments.branch_nums` 也未配具体门店号 → branch 兜底 `["*"]` **全门店**
- 结果：**未配角色的用户实际拿到全数据范围**（仅 can_see_cost=false）

这是当初为「零爆炸半径、不破坏旧 token」的有意取舍，但与「最小权限」叙述不符。报表已上线，任何未配角色者登录即可看全部门店数据。

**待核实**：生产 `org_departments.branch_nums` 是否给每个部门配了具体门店号。配齐了则 branch 维度有部门兜底；没配则 fail-open 成立。

---

## 4. 改进选项与推荐终态

| 选项 | 投入 | 收益 | 说明 |
|---|---|---|---|
| ① 补同步联动（Task 6） | 小 | 高 | sync/webhook 的 user upsert 前按 department_ids 查 dept_role_mapping 取 priority 最高 role_id 一起写 |
| ② 校准 regex + 部门树继承 | 小 | 中 | 采购类补「水果部/标品部/商品中心/商品运营」；父部门命中时子部门递归继承 |
| ③ 按岗位 position 赋角色 | 小 | 高 | 生产无「店长」部门但 position 常含「店长」→ 补 position→role 映射，解决店长硬伤 |
| ④ 建 admin 配置面 | 中 | 高 | /admin/users（手绑 role_id + 个人 override + 临时授权）、/admin/roles（可视化管理 regex） |
| ⑤ 修 fail-open | 小 | 高（安全） | get_user_perms 对 role_id=NULL 改 fail-safe（空权限或显式最小集），非兜底 `["*"]` |

**推荐终态：混合关联**
```
部门树自动归角色（战区/采购/财务）   ← dept_role_mapping（主规则）
      + 岗位补角色（店长）           ← position→role（补部门覆盖不到的）
      + admin 个人 override（特例）  ← /admin/users（兜底 + 临时授权）
```
符合主 spec 原则：「admin 只配规则 + 少量个人 override，不逐人维护」。

---

## 5. 在总体规划中的定位

按全局路线图（权限地基 ✅ → 语义层 → Phase 2 报表 → 权限收尾 → 迁移+预警）：

- **⑤ fail-open**：建议**立即止血**（1 个小改动，报表已上线有风险）
- **①③④ 同步联动 + position + admin 面**：归入**第 3 步「权限管理收尾」**
- **② regex 校准**：配合 admin 面一起做
