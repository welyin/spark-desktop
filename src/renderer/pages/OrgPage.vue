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
            <el-form-item label="基础插件">
              <el-select v-model="createForm.basePluginDomain" placeholder="请选择组织基础插件" style="width: 100%">
                <el-option
                  v-for="plugin in foundationPlugins"
                  :key="plugin.domain"
                  :label="`${plugin.name} (${plugin.domain})`"
                  :value="plugin.domain"
                />
              </el-select>
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

          <p class="hint">创建人会自动成为该组织的管理员和首位成员。组织必须绑定一个基础插件。</p>
          <el-alert v-if="message" :title="message" type="info" :closable="false" show-icon />
        </el-card>

        <el-card shadow="never" class="panel-card">
          <template #header>
            <h2>通过邀请码加入</h2>
          </template>
          <el-form label-position="top">
            <el-form-item label="邀请码">
              <el-input
                v-model="inviteCodeInput"
                type="textarea"
                :rows="3"
                placeholder="粘贴管理员分享给你的邀请码"
              />
            </el-form-item>
            <el-button type="primary" :loading="acceptingInvite" @click="acceptInvite">
              {{ acceptingInvite ? '加入中...' : '加入组织' }}
            </el-button>
          </el-form>
          <p class="hint">加入前提：管理员已先将你的 RootID 录入组织成员。邀请码用于连接管理员节点并拉取组织数据。</p>
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
                @click="selectOrganization(organization)"
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
                  <span>基础插件：{{ organization.basePluginDomain || '-' }}</span>
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
            <el-descriptions-item label="基础插件">{{ selectedOrganization.basePluginDomain || '-' }}</el-descriptions-item>
            <el-descriptions-item label="成员数">{{ selectedOrganization.memberCount }}</el-descriptions-item>
            <el-descriptions-item label="管理员数">{{ selectedOrganization.adminCount }}</el-descriptions-item>
          </el-descriptions>

          <div v-if="syncOverview" class="replica-row">
            <el-tag :type="syncOverview.syncedPeers >= syncOverview.replicaTarget ? 'success' : 'warning'">
              副本 {{ syncOverview.syncedPeers }}/{{ syncOverview.replicaTarget }}
            </el-tag>
            <span class="replica-hint">
              {{ syncOverview.syncedPeers >= syncOverview.replicaTarget ? '副本充足' : '副本不足，建议成员保持在线或邀请更多节点' }}
              （已同步节点 {{ syncOverview.syncedPeers }} / 成员 {{ syncOverview.totalMembers }}）
            </span>
          </div>

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
            <el-table-column label="最近同步" min-width="160">
              <template #default="scope">{{ memberSyncLabel(scope.row.rootId) }}</template>
            </el-table-column>
          </el-table>

          <section v-if="selectedOrganization.isCurrentUserAdmin" class="admin-actions">
            <h3 class="section-title">管理员操作</h3>

            <el-card shadow="never" class="inner-op-card">
              <template #header>
                <h4>添加成员（预录入）</h4>
              </template>
              <el-form label-position="top">
                <el-form-item label="添加成员 RootID">
                  <el-input v-model="addMemberRootId" placeholder="64 位 RootID" />
                </el-form-item>
                <el-form-item label="成员 PeerId（可选）">
                  <el-input v-model="addMemberPeerId" placeholder="例如：12D3KooW..." />
                </el-form-item>
                <el-form-item label="成员节点地址（可选，可多条，逗号/分号/换行分隔）">
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
              <p class="hint">只填 RootID 即可预录入；对方凭邀请码加入时会自动回填节点地址。</p>
            </el-card>

            <el-card shadow="never" class="inner-op-card">
              <template #header>
                <h4>邀请成员</h4>
              </template>
              <p class="hint">预录入成员 RootID 后生成邀请码，经线下渠道发给对方；对方凭码连接你的节点完成加入（你需要保持在线）。</p>
              <el-button type="primary" plain :loading="busyAction === 'invite'" @click="createInvite">
                {{ busyAction === 'invite' ? '生成中...' : '生成邀请码' }}
              </el-button>
              <div v-if="generatedInvite" class="invite-result">
                <el-input v-model="generatedInvite" type="textarea" :rows="3" readonly />
                <el-button size="small" @click="copyInvite">复制邀请码</el-button>
              </div>
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
  basePluginDomain?: string;
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
  basePluginDomain: string;
};

type OrgSyncOverview = {
  orgId: string;
  replicaTarget: number;
  syncedPeers: number;
  totalMembers: number;
  members: Array<{
    rootId: string;
    peerId?: string;
    isSelf: boolean;
    everSynced: boolean;
    lastSyncedAt: number | null;
  }>;
};

type PluginCatalogItem = {
  id: string;
  domain: string;
  name: string;
  description: string;
  category: 'foundation' | 'business';
  version: string;
  views: string[];
};

export default defineComponent({
  name: 'OrgPage',
  emits: ['open-plugin-tab'],
  setup(_, { emit }) {
    const organizations = ref<OrganizationView[]>([]);
    const selectedOrgId = ref('');
    const loading = ref(false);
    const creating = ref(false);
    const busyAction = ref<'add' | 'remove' | 'delete' | 'invite' | ''>('');
    const message = ref('');
    const pluginCatalog = ref<PluginCatalogItem[]>([]);
    const addMemberRootId = ref('');
    const addMemberPeerId = ref('');
    const addMemberAddresses = ref('');
    const removeMemberRootId = ref('');
    const createForm = ref<CreateForm>({ name: '', description: '', basePluginDomain: '' });
    const inviteCodeInput = ref('');
    const acceptingInvite = ref(false);
    const generatedInvite = ref('');
    const syncOverview = ref<OrgSyncOverview | null>(null);

    const foundationPlugins = computed(() => {
      return pluginCatalog.value.filter((plugin) => plugin.category === 'foundation');
    });

    const selectedOrganization = computed(() => {
      return organizations.value.find((organization) => organization.orgId === selectedOrgId.value) ?? null;
    });

    const refreshSyncOverview = async () => {
      if (!selectedOrgId.value) {
        syncOverview.value = null;
        return;
      }
      try {
        syncOverview.value = await window.electronAPI.organization.getSyncOverview(selectedOrgId.value);
      } catch {
        syncOverview.value = null;
      }
    };

    const selectOrganization = (organization: OrganizationView) => {
      selectedOrgId.value = organization.orgId;
      generatedInvite.value = '';
      void refreshSyncOverview();

      if (!organization.basePluginDomain) {
        return;
      }

      emit('open-plugin-tab', {
        pluginDomain: organization.basePluginDomain,
        pluginView: 'default',
        title: `${organization.name} · 插件`,
        icon: '基',
        pluginContext: {
          orgId: organization.orgId
        }
      });
    };


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
        await refreshSyncOverview();
      } catch (error) {
        message.value = `加载组织失败：${error}`;
        ElMessage.error(message.value);
      } finally {
        loading.value = false;
      }
    };

    const loadPluginCatalog = async () => {
      try {
        pluginCatalog.value = await window.electronAPI.plugin.listCatalog();
        if (!createForm.value.basePluginDomain) {
          createForm.value.basePluginDomain = foundationPlugins.value[0]?.domain ?? '';
        }
      } catch (error) {
        message.value = `加载插件目录失败：${error}`;
      }
    };

    const createOrganization = async () => {
      if (!createForm.value.name.trim()) {
        message.value = '请输入组织名称';
        ElMessage.warning(message.value);
        return;
      }

      if (!createForm.value.basePluginDomain) {
        message.value = '请选择基础插件';
        ElMessage.warning(message.value);
        return;
      }

      creating.value = true;
      message.value = '';
      try {
        const created = await window.electronAPI.organization.create({
          name: createForm.value.name,
          description: createForm.value.description,
          basePluginDomain: createForm.value.basePluginDomain
        });
        message.value = `组织已创建：${created.name}`;
        ElMessage.success(message.value);
        createForm.value = {
          name: '',
          description: '',
          basePluginDomain: createForm.value.basePluginDomain
        };
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

      const nodeInfo = addMemberPeerId.value.trim() || addresses.length > 0
        ? {
            peerId: addMemberPeerId.value.trim() || undefined,
            addresses
          }
        : undefined;

      busyAction.value = 'add';
      message.value = '';
      try {
        const updated = await window.electronAPI.organization.addMember(selectedOrganization.value.orgId, {
          rootId: addMemberRootId.value,
          nodeInfo
        });
        message.value = '成员添加成功';
        ElMessage.success(message.value);
        addMemberRootId.value = '';
        addMemberPeerId.value = '';
        addMemberAddresses.value = '';
        organizations.value = organizations.value.map((organization) =>
          organization.orgId === updated.orgId ? updated : organization
        );
        await refreshSyncOverview();
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

    const createInvite = async () => {
      if (!selectedOrganization.value) {
        return;
      }

      busyAction.value = 'invite';
      message.value = '';
      try {
        const result = await window.electronAPI.organization.createInvite(selectedOrganization.value.orgId);
        generatedInvite.value = result.invite;
        message.value = '邀请码已生成，请通过线下渠道发送给被邀请人';
        ElMessage.success(message.value);
      } catch (error) {
        message.value = `生成邀请码失败：${error}`;
        ElMessage.error(message.value);
      } finally {
        busyAction.value = '';
      }
    };

    const copyInvite = async () => {
      try {
        await navigator.clipboard.writeText(generatedInvite.value);
        ElMessage.success('邀请码已复制');
      } catch {
        ElMessage.warning('复制失败，请手动选择文本复制');
      }
    };

    const acceptInvite = async () => {
      if (!inviteCodeInput.value.trim()) {
        message.value = '请输入邀请码';
        ElMessage.warning(message.value);
        return;
      }

      acceptingInvite.value = true;
      message.value = '';
      try {
        const joined = await window.electronAPI.organization.acceptInvite(inviteCodeInput.value.trim());
        message.value = `已加入组织：${joined.orgName}`;
        ElMessage.success(message.value);
        inviteCodeInput.value = '';
        await refreshOrganizations();
        selectedOrgId.value = joined.orgId;
        await refreshSyncOverview();
      } catch (error) {
        message.value = `加入组织失败：${error}`;
        ElMessage.error(message.value);
      } finally {
        acceptingInvite.value = false;
      }
    };

    const memberSyncLabel = (rootId: string) => {
      const item = syncOverview.value?.members.find((member) => member.rootId === rootId);
      if (!item) {
        return '-';
      }
      if (item.isSelf) {
        return '本机';
      }
      if (!item.everSynced) {
        return '未同步';
      }
      return item.lastSyncedAt ? formatDate(item.lastSyncedAt) : '已同步';
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
      void loadPluginCatalog();
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
      foundationPlugins,
      adminOrgCount,
      addMemberRootId,
      addMemberPeerId,
      addMemberAddresses,
      removeMemberRootId,
      createForm,
      inviteCodeInput,
      acceptingInvite,
      generatedInvite,
      syncOverview,
      selectOrganization,
      refreshOrganizations,
      createOrganization,
      addMember,
      removeMember,
      deleteOrganization,
      createInvite,
      copyInvite,
      acceptInvite,
      memberSyncLabel,
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

.replica-row {
  margin-top: 12px;
  display: flex;
  align-items: center;
  gap: 10px;
}

.replica-hint {
  color: #64748b;
  font-size: 13px;
}

.invite-result {
  margin-top: 12px;
  display: grid;
  gap: 8px;
  justify-items: start;
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
