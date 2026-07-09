<template>
  <section class="org-page">
    <header class="hero card">
      <div>
        <p class="eyebrow">组织管理</p>
        <h1>组织</h1>
        <p class="lede">创建组织后，你会默认加入并成为管理员。只有管理员可以删除组织、添加成员和删除成员。</p>
      </div>
      <div class="hero-stats">
        <div class="stat">
          <strong>{{ organizations.length }}</strong>
          <span>我所属的组织</span>
        </div>
        <div class="stat">
          <strong>{{ adminOrgCount }}</strong>
          <span>我担任管理员</span>
        </div>
      </div>
    </header>

    <section class="grid">
      <aside class="card panel create-panel">
        <h2>创建组织</h2>
        <label>
          组织名称
          <input v-model="createForm.name" type="text" placeholder="例如：产品组" />
        </label>
        <label>
          组织描述
          <textarea v-model="createForm.description" rows="3" placeholder="可选，描述组织用途"></textarea>
        </label>
        <button class="primary" :disabled="creating" @click="createOrganization">
          {{ creating ? '创建中...' : '创建组织' }}
        </button>
        <p class="hint">创建人会自动成为该组织的管理员和首位成员。</p>
        <p v-if="message" class="message">{{ message }}</p>
      </aside>

      <main class="content">
        <section class="card panel list-panel">
          <div class="panel-title">
            <h2>我的组织</h2>
            <button class="ghost" @click="refreshOrganizations">刷新</button>
          </div>

          <div v-if="loading" class="empty-state">正在加载组织...</div>
          <div v-else-if="organizations.length === 0" class="empty-state">你还没有加入任何组织。先创建一个组织吧。</div>
          <div v-else class="org-list">
            <button
              v-for="organization in organizations"
              :key="organization.orgId"
              class="org-item"
              :class="{ active: selectedOrgId === organization.orgId }"
              @click="selectedOrgId = organization.orgId"
            >
              <div class="org-item-top">
                <strong>{{ organization.name }}</strong>
                <span class="role-badge" :class="organization.isCurrentUserAdmin ? 'admin' : 'member'">
                  {{ organization.isCurrentUserAdmin ? '管理员' : '成员' }}
                </span>
              </div>
              <p>{{ organization.description || '暂无描述' }}</p>
              <div class="org-meta">
                <span>{{ organization.memberCount }} 人</span>
                <span>{{ organization.adminCount }} 管理员</span>
              </div>
            </button>
          </div>
        </section>

        <section class="card panel detail-panel" v-if="selectedOrganization">
          <div class="panel-title detail-title">
            <div>
              <p class="eyebrow">组织详情</p>
              <h2>{{ selectedOrganization.name }}</h2>
              <p>{{ selectedOrganization.description || '暂无描述' }}</p>
            </div>
            <span class="role-badge" :class="selectedOrganization.isCurrentUserAdmin ? 'admin' : 'member'">
              {{ selectedOrganization.isCurrentUserAdmin ? '管理员' : '成员' }}
            </span>
          </div>

          <div class="detail-grid">
            <div><strong>组织 ID</strong><span>{{ selectedOrganization.orgId }}</span></div>
            <div><strong>创建者</strong><span>{{ selectedOrganization.createdBy }}</span></div>
            <div><strong>成员数</strong><span>{{ selectedOrganization.memberCount }}</span></div>
            <div><strong>管理员数</strong><span>{{ selectedOrganization.adminCount }}</span></div>
          </div>

          <h3>成员列表</h3>
          <ul class="member-list">
            <li v-for="member in selectedOrganization.members" :key="member.rootId" class="member-item">
              <div>
                <strong>{{ member.rootId }}</strong>
                <p>加入时间：{{ formatDate(member.joinedAt) }}</p>
                <p v-if="member.nodeInfo?.peerId">PeerId：{{ member.nodeInfo.peerId }}</p>
                <p v-if="member.nodeInfo?.addresses?.length">节点地址：{{ member.nodeInfo.addresses.join(' , ') }}</p>
              </div>
              <span class="role-badge" :class="member.role">{{ member.role === 'admin' ? '管理员' : '成员' }}</span>
            </li>
          </ul>

          <section v-if="selectedOrganization.isCurrentUserAdmin" class="admin-actions">
            <h3>管理员操作</h3>
            <div class="action-grid">
              <label>
                添加成员 RootID
                <input v-model="addMemberRootId" type="text" placeholder="64 位 RootID" />
              </label>
              <label>
                成员 PeerId（可选）
                <input v-model="addMemberPeerId" type="text" placeholder="例如：12D3KooW..." />
              </label>
              <label class="full-width">
                成员节点地址（必填其一，可多条，逗号/分号/换行分隔）
                <textarea v-model="addMemberAddresses" rows="3" placeholder="例如：/ip4/127.0.0.1/tcp/15002/ws"></textarea>
              </label>
              <button class="primary" :disabled="busyAction === 'add'" @click="addMember">
                {{ busyAction === 'add' ? '添加中...' : '添加成员' }}
              </button>

              <label>
                删除成员 RootID
                <input v-model="removeMemberRootId" type="text" placeholder="64 位 RootID" />
              </label>
              <button class="danger" :disabled="busyAction === 'remove'" @click="removeMember">
                {{ busyAction === 'remove' ? '删除中...' : '删除成员' }}
              </button>

              <button class="danger full-width" :disabled="busyAction === 'delete'" @click="deleteOrganization">
                {{ busyAction === 'delete' ? '删除中...' : '删除组织' }}
              </button>
            </div>
          </section>

          <p v-else class="hint">当前用户不是管理员，只能查看成员列表。</p>
        </section>

        <section v-else class="card panel empty-detail">
          <h2>组织详情</h2>
          <p>从左侧选择一个组织查看成员与管理操作。</p>
        </section>
      </main>
    </section>
  </section>
</template>

<script lang="ts">
import { computed, defineComponent, onMounted, ref } from 'vue';

type OrganizationMember = {
  rootId: string;
  role: 'admin' | 'member';
  joinedAt: number;
  addedBy: string;
  nodeInfo?: {
    peerId?: string;
    addresses: string[];
  };
};

type OrganizationView = {
  orgId: string;
  name: string;
  description: string;
  createdAt: number;
  createdBy: string;
  updatedAt: number;
  members: OrganizationMember[];
  currentUserRole: 'admin' | 'member' | null;
  isCurrentUserAdmin: boolean;
  memberCount: number;
  adminCount: number;
};

type CreateForm = {
  name: string;
  description: string;
};

export default defineComponent({
  name: 'OrgPage',
  setup() {
    const organizations = ref<OrganizationView[]>([]);
    const selectedOrgId = ref('');
    const loading = ref(false);
    const creating = ref(false);
    const busyAction = ref<'add' | 'remove' | 'delete' | ''>('');
    const message = ref('');
    const addMemberRootId = ref('');
    const addMemberPeerId = ref('');
    const addMemberAddresses = ref('');
    const removeMemberRootId = ref('');
    const createForm = ref<CreateForm>({ name: '', description: '' });

    const selectedOrganization = computed(() => {
      return organizations.value.find((organization) => organization.orgId === selectedOrgId.value) ?? null;
    });

    const adminOrgCount = computed(() => {
      return organizations.value.filter((organization) => organization.isCurrentUserAdmin).length;
    });

    const refreshOrganizations = async () => {
      loading.value = true;
      message.value = '';
      try {
        organizations.value = await window.electronAPI.organization.listMine();
        if (!organizations.value.some((organization) => organization.orgId === selectedOrgId.value)) {
          selectedOrgId.value = organizations.value[0]?.orgId ?? '';
        }
      } catch (error) {
        message.value = `加载组织失败：${error}`;
      } finally {
        loading.value = false;
      }
    };

    const createOrganization = async () => {
      if (!createForm.value.name.trim()) {
        message.value = '请输入组织名称';
        return;
      }

      creating.value = true;
      message.value = '';
      try {
        const created = await window.electronAPI.organization.create({
          name: createForm.value.name,
          description: createForm.value.description
        });
        message.value = `组织已创建：${created.name}`;
        createForm.value = { name: '', description: '' };
        await refreshOrganizations();
        selectedOrgId.value = created.orgId;
      } catch (error) {
        message.value = `创建组织失败：${error}`;
      } finally {
        creating.value = false;
      }
    };

    const addMember = async () => {
      if (!selectedOrganization.value) {
        return;
      }

      const addresses = addMemberAddresses.value
        .split(/\r?\n|,|;/)
        .map((item) => item.trim())
        .filter((item) => item.length > 0);

      if (!addMemberRootId.value.trim()) {
        message.value = '请输入成员 RootID';
        return;
      }

      if (!addMemberPeerId.value.trim() && addresses.length === 0) {
        message.value = '请输入成员节点信息：PeerId 或至少一个多地址';
        return;
      }

      busyAction.value = 'add';
      message.value = '';
      try {
        const updated = await window.electronAPI.organization.addMember(selectedOrganization.value.orgId, {
          rootId: addMemberRootId.value,
          nodeInfo: {
            peerId: addMemberPeerId.value.trim() || undefined,
            addresses
          }
        });
        message.value = '成员添加成功';
        addMemberRootId.value = '';
        addMemberPeerId.value = '';
        addMemberAddresses.value = '';
        organizations.value = organizations.value.map((organization) =>
          organization.orgId === updated.orgId ? updated : organization
        );
      } catch (error) {
        message.value = `添加成员失败：${error}`;
      } finally {
        busyAction.value = '';
      }
    };

    const removeMember = async () => {
      if (!selectedOrganization.value) {
        return;
      }
      busyAction.value = 'remove';
      message.value = '';
      try {
        const updated = await window.electronAPI.organization.removeMember(selectedOrganization.value.orgId, removeMemberRootId.value);
        message.value = '成员已删除';
        removeMemberRootId.value = '';
        organizations.value = organizations.value.map((organization) =>
          organization.orgId === updated.orgId ? updated : organization
        );
      } catch (error) {
        message.value = `删除成员失败：${error}`;
      } finally {
        busyAction.value = '';
      }
    };

    const deleteOrganization = async () => {
      if (!selectedOrganization.value) {
        return;
      }
      if (!window.confirm(`确认删除组织「${selectedOrganization.value.name}」？`)) {
        return;
      }

      busyAction.value = 'delete';
      message.value = '';
      try {
        await window.electronAPI.organization.delete(selectedOrganization.value.orgId);
        message.value = '组织已删除';
        await refreshOrganizations();
      } catch (error) {
        message.value = `删除组织失败：${error}`;
      } finally {
        busyAction.value = '';
      }
    };

    const formatDate = (timestamp: number) => {
      return new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      }).format(new Date(timestamp));
    };

    onMounted(() => {
      void refreshOrganizations();
    });

    return {
      organizations,
      selectedOrgId,
      selectedOrganization,
      loading,
      creating,
      busyAction,
      message,
      adminOrgCount,
      addMemberRootId,
      addMemberPeerId,
      addMemberAddresses,
      removeMemberRootId,
      createForm,
      refreshOrganizations,
      createOrganization,
      addMember,
      removeMember,
      deleteOrganization,
      formatDate
    };
  }
});
</script>

<style scoped>
.org-page {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.hero,
.panel {
  border-radius: 18px;
  border: 1px solid rgba(15, 23, 42, 0.08);
  background: linear-gradient(180deg, #ffffff 0%, #f8fafc 100%);
  box-shadow: 0 18px 36px rgba(15, 23, 42, 0.06);
}

.hero {
  display: flex;
  justify-content: space-between;
  gap: 24px;
  padding: 24px;
}

.eyebrow {
  margin: 0 0 6px;
  color: #0f766e;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.14em;
  text-transform: uppercase;
}

h1,
h2,
h3,
p {
  margin-top: 0;
}

.lede,
.hint,
.message {
  color: #475569;
}

.hero-stats {
  display: grid;
  grid-template-columns: repeat(2, minmax(120px, 1fr));
  gap: 12px;
}

.stat {
  min-width: 140px;
  padding: 14px;
  border-radius: 14px;
  background: rgba(15, 118, 110, 0.08);
}

.stat strong {
  display: block;
  font-size: 28px;
}

.stat span {
  color: #475569;
}

.grid {
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
  gap: 16px;
}

.content {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.panel {
  padding: 20px;
}

.panel-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.detail-title {
  align-items: flex-start;
}

.create-panel,
.list-panel,
.detail-panel,
.empty-detail {
  min-height: 100%;
}

label {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 14px;
  font-weight: 600;
}

input,
textarea {
  width: 100%;
  border-radius: 12px;
  border: 1px solid rgba(15, 23, 42, 0.12);
  padding: 12px 14px;
  font: inherit;
  background: #fff;
  box-sizing: border-box;
}

button {
  border: none;
  border-radius: 12px;
  padding: 12px 14px;
  font: inherit;
  font-weight: 700;
  cursor: pointer;
}

button.primary {
  background: #0f766e;
  color: #fff;
}

button.ghost {
  background: rgba(15, 23, 42, 0.06);
  color: #0f172a;
}

button.danger {
  background: #b91c1c;
  color: #fff;
}

button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.empty-state {
  padding: 16px 0;
  color: #64748b;
}

.org-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.org-item {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 8px;
  text-align: left;
  background: rgba(15, 23, 42, 0.04);
  border: 1px solid transparent;
}

.org-item.active {
  border-color: #0f766e;
  background: rgba(15, 118, 110, 0.08);
}

.org-item-top,
.org-meta,
.member-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.org-item p,
.member-item p {
  margin-bottom: 0;
  color: #64748b;
}

.role-badge {
  padding: 6px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 700;
}

.role-badge.admin {
  background: rgba(15, 118, 110, 0.16);
  color: #0f766e;
}

.role-badge.member {
  background: rgba(59, 130, 246, 0.14);
  color: #1d4ed8;
}

.detail-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
  margin: 18px 0;
}

.detail-grid > div,
.member-item {
  padding: 14px;
  border-radius: 14px;
  background: rgba(15, 23, 42, 0.04);
}

.detail-grid strong,
.member-item strong {
  display: block;
  margin-bottom: 6px;
}

.member-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.admin-actions {
  margin-top: 20px;
}

.action-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 12px;
  align-items: end;
}

.full-width {
  grid-column: 1 / -1;
}

@media (max-width: 960px) {
  .hero,
  .grid {
    grid-template-columns: 1fr;
    display: flex;
    flex-direction: column;
  }

  .hero-stats,
  .detail-grid,
  .action-grid {
    grid-template-columns: 1fr;
  }

  .member-item,
  .org-item-top,
  .org-meta,
  .panel-title,
  .hero {
    align-items: flex-start;
  }
}
</style>
