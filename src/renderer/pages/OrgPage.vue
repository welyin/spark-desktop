<template>
  <section class="org-page">
    <el-card shadow="never" class="hero-card">
      <div class="hero-inner">
        <div>
          <p class="eyebrow">组织管理</p>
          <h1>组织</h1>
          <p class="lede">创建组织后，你会默认加入并成为管理员。只有管理员可以删除组织、添加成员和删除成员。</p>
        </div>
        <el-row :gutter="12" class="hero-stats">
          <el-col :span="12">
            <el-statistic title="我所属的组织" :value="organizations.length" />
          </el-col>
          <el-col :span="12">
            <el-statistic title="我担任管理员" :value="adminOrgCount" />
          </el-col>
        </el-row>
      </div>
    </el-card>

    <el-row :gutter="16" class="content-row">
      <el-col :lg="8" :md="10" :sm="24" :xs="24">
        <el-card shadow="never" class="panel-card">
          <template #header>
            <h2>创建组织</h2>
          </template>

          <el-form label-position="top">
            <el-form-item label="组织名称">
              <el-input v-model="createForm.name" placeholder="例如：产品组" />
            </el-form-item>
            <el-form-item label="组织描述">
              <el-input
                v-model="createForm.description"
                type="textarea"
                :rows="3"
                placeholder="可选，描述组织用途"
              />
            </el-form-item>
            <el-button type="primary" :loading="creating" @click="createOrganization">
              {{ creating ? '创建中...' : '创建组织' }}
            </el-button>
          </el-form>

          <p class="hint">创建人会自动成为该组织的管理员和首位成员。</p>
          <el-alert v-if="message" :title="message" type="info" :closable="false" show-icon />
        </el-card>
      </el-col>

      <el-col :lg="16" :md="14" :sm="24" :xs="24">
        <el-card shadow="never" class="panel-card">
          <template #header>
            <div class="header-row">
              <h2>我的组织</h2>
              <el-button text type="primary" @click="refreshOrganizations">刷新</el-button>
            </div>
          </template>

          <el-empty v-if="loading" description="正在加载组织..." />
          <el-empty v-else-if="organizations.length === 0" description="你还没有加入任何组织。先创建一个组织吧。" />
          <el-scrollbar v-else max-height="230px">
            <div class="org-list">
              <el-card
                v-for="organization in organizations"
                :key="organization.orgId"
                shadow="hover"
                class="org-item"
                :class="{ active: selectedOrgId === organization.orgId }"
                @click="selectedOrgId = organization.orgId"
              >
                <div class="org-item-top">
                  <strong>{{ organization.name }}</strong>
                  <el-tag :type="organization.isCurrentUserAdmin ? 'danger' : 'info'">
                    {{ organization.isCurrentUserAdmin ? '管理员' : '成员' }}
                  </el-tag>
                </div>
                <p class="org-desc">{{ organization.description || '暂无描述' }}</p>
                <div class="org-meta">
                  <span>{{ organization.memberCount }} 人</span>
                  <span>{{ organization.adminCount }} 管理员</span>
                </div>
              </el-card>
            </div>
          </el-scrollbar>
        </el-card>

        <el-card v-if="selectedOrganization" shadow="never" class="panel-card detail-card">
          <template #header>
            <div class="header-row">
              <div>
                <p class="eyebrow">组织详情</p>
                <h2>{{ selectedOrganization.name }}</h2>
                <p class="lede">{{ selectedOrganization.description || '暂无描述' }}</p>
              </div>
              <el-tag :type="selectedOrganization.isCurrentUserAdmin ? 'danger' : 'info'">
                {{ selectedOrganization.isCurrentUserAdmin ? '管理员' : '成员' }}
              </el-tag>
            </div>
          </template>

          <el-descriptions :column="2" border>
            <el-descriptions-item label="组织 ID">{{ selectedOrganization.orgId }}</el-descriptions-item>
            <el-descriptions-item label="创建者">{{ selectedOrganization.createdBy }}</el-descriptions-item>
            <el-descriptions-item label="成员数">{{ selectedOrganization.memberCount }}</el-descriptions-item>
            <el-descriptions-item label="管理员数">{{ selectedOrganization.adminCount }}</el-descriptions-item>
          </el-descriptions>

          <h3 class="section-title">成员列表</h3>
          <el-table :data="selectedOrganization.members" stripe>
            <el-table-column prop="rootId" label="RootID" min-width="280" />
            <el-table-column label="角色" width="120">
              <template #default="scope">
                <el-tag :type="scope.row.role === 'admin' ? 'danger' : 'info'">
                  {{ scope.row.role === 'admin' ? '管理员' : '成员' }}
                </el-tag>
              </template>
            </el-table-column>
            <el-table-column label="加入时间" min-width="160">
              <template #default="scope">{{ formatDate(scope.row.joinedAt) }}</template>
            </el-table-column>
            <el-table-column label="PeerId" min-width="240">
              <template #default="scope">{{ scope.row.nodeInfo?.peerId || '-' }}</template>
            </el-table-column>
            <el-table-column label="节点地址" min-width="260">
              <template #default="scope">{{ (scope.row.nodeInfo?.addresses || []).join(' , ') || '-' }}</template>
            </el-table-column>
          </el-table>

          <section v-if="selectedOrganization.isCurrentUserAdmin" class="admin-actions">
            <h3 class="section-title">管理员操作</h3>

            <el-card shadow="never" class="inner-op-card">
              <template #header>
                <h4>添加成员</h4>
              </template>
              <el-form label-position="top">
                <el-form-item label="添加成员 RootID">
                  <el-input v-model="addMemberRootId" placeholder="64 位 RootID" />
                </el-form-item>
                <el-form-item label="成员 PeerId（可选）">
                  <el-input v-model="addMemberPeerId" placeholder="例如：12D3KooW..." />
                </el-form-item>
                <el-form-item label="成员节点地址（必填其一，可多条，逗号/分号/换行分隔）">
                  <el-input
                    v-model="addMemberAddresses"
                    type="textarea"
                    :rows="3"
                    placeholder="例如：/ip4/127.0.0.1/tcp/15002/ws"
                  />
                </el-form-item>
                <el-button type="primary" :loading="busyAction === 'add'" @click="addMember">
                  {{ busyAction === 'add' ? '添加中...' : '添加成员' }}
                </el-button>
              </el-form>
            </el-card>

            <el-card shadow="never" class="inner-op-card">
              <template #header>
                <h4>删除成员</h4>
              </template>
              <el-form label-position="top">
                <el-form-item label="删除成员 RootID">
                  <el-input v-model="removeMemberRootId" placeholder="64 位 RootID" />
                </el-form-item>
                <el-button type="danger" :loading="busyAction === 'remove'" @click="removeMember">
                  {{ busyAction === 'remove' ? '删除中...' : '删除成员' }}
                </el-button>
              </el-form>
            </el-card>

            <el-button type="danger" plain :loading="busyAction === 'delete'" @click="deleteOrganization">
              {{ busyAction === 'delete' ? '删除中...' : '删除组织' }}
            </el-button>
          </section>

          <el-alert v-else title="当前用户不是管理员，只能查看成员列表。" type="warning" :closable="false" show-icon />
        </el-card>

        <el-card v-else shadow="never" class="panel-card">
          <h2>组织详情</h2>
          <p>从左侧选择一个组织查看成员与管理操作。</p>
        </el-card>
      </el-col>
    </el-row>
  </section>
</template>

<script lang="ts">
import { computed, defineComponent, onMounted, ref } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';

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
        ElMessage.error(message.value);
      } finally {
        loading.value = false;
      }
    };

    const createOrganization = async () => {
      if (!createForm.value.name.trim()) {
        message.value = '请输入组织名称';
        ElMessage.warning(message.value);
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
        ElMessage.success(message.value);
        createForm.value = { name: '', description: '' };
        await refreshOrganizations();
        selectedOrgId.value = created.orgId;
      } catch (error) {
        message.value = `创建组织失败：${error}`;
        ElMessage.error(message.value);
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
        ElMessage.warning(message.value);
        return;
      }

      if (!addMemberPeerId.value.trim() && addresses.length === 0) {
        message.value = '请输入成员节点信息：PeerId 或至少一个多地址';
        ElMessage.warning(message.value);
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
        ElMessage.success(message.value);
        addMemberRootId.value = '';
        addMemberPeerId.value = '';
        addMemberAddresses.value = '';
        organizations.value = organizations.value.map((organization) =>
          organization.orgId === updated.orgId ? updated : organization
        );
      } catch (error) {
        message.value = `添加成员失败：${error}`;
        ElMessage.error(message.value);
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
        ElMessage.success(message.value);
        removeMemberRootId.value = '';
        organizations.value = organizations.value.map((organization) =>
          organization.orgId === updated.orgId ? updated : organization
        );
      } catch (error) {
        message.value = `删除成员失败：${error}`;
        ElMessage.error(message.value);
      } finally {
        busyAction.value = '';
      }
    };

    const deleteOrganization = async () => {
      if (!selectedOrganization.value) {
        return;
      }

      try {
        await ElMessageBox.confirm(`确认删除组织「${selectedOrganization.value.name}」？`, '删除确认', {
          type: 'warning',
          confirmButtonText: '确认删除',
          cancelButtonText: '取消'
        });
      } catch {
        return;
      }

      busyAction.value = 'delete';
      message.value = '';
      try {
        await window.electronAPI.organization.delete(selectedOrganization.value.orgId);
        message.value = '组织已删除';
        ElMessage.success(message.value);
        await refreshOrganizations();
      } catch (error) {
        message.value = `删除组织失败：${error}`;
        ElMessage.error(message.value);
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

.hero-card,
.panel-card,
.inner-op-card {
  border-radius: 14px;
}

.hero-inner {
  display: flex;
  justify-content: space-between;
  gap: 16px;
}

.eyebrow {
  margin: 0 0 6px;
  color: #0f766e;
  font-size: 12px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
}

h1,
h2,
h3,
h4 {
  margin: 0;
}

.lede {
  margin: 8px 0 0;
  color: #64748b;
}

.hero-stats {
  min-width: 260px;
}

.content-row {
  margin-top: 0;
}

.hint {
  margin-top: 10px;
  color: #64748b;
}

.header-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}

.org-list {
  display: grid;
  grid-template-columns: 1fr;
  gap: 10px;
}

.org-item {
  cursor: pointer;
  border: 1px solid var(--el-border-color);
}

.org-item.active {
  border-color: var(--el-color-primary);
}

.org-item-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 10px;
}

.org-desc {
  margin: 8px 0;
  color: #64748b;
}

.org-meta {
  display: flex;
  gap: 14px;
  color: #475569;
  font-size: 13px;
}

.detail-card {
  margin-top: 16px;
}

.section-title {
  margin: 18px 0 12px;
}

.admin-actions {
  margin-top: 16px;
  display: grid;
  gap: 12px;
}

@media (max-width: 900px) {
  .hero-inner {
    flex-direction: column;
  }

  .hero-stats {
    min-width: 100%;
  }
}
</style>
