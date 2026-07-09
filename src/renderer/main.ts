import { createApp, defineComponent, h, onMounted, ref } from 'vue';
import App from './App.vue';
import RegisterPage from './pages/auth/RegisterPage.vue';
import LoginPage from './pages/auth/LoginPage.vue';

type RootStatus = {
	initialized: boolean;
	unlocked: boolean;
	rootId: string | null;
};

const RootGate = defineComponent({
	name: 'RootGate',
	components: {
		RegisterPage,
		LoginPage,
		App
	},
	setup() {
		const rootStatus = ref<RootStatus>({ initialized: false, unlocked: false, rootId: null });
		const showApp = ref(false);
		const message = ref('');
		const mnemonicNotice = ref('');

		const refreshStatus = async () => {
			rootStatus.value = await window.electronAPI.rootIdentity.status();
			showApp.value = rootStatus.value.initialized && rootStatus.value.unlocked;
		};

		const handleRegister = async (password: string) => {
			try {
				const result = await window.electronAPI.rootIdentity.initialize(password);
				mnemonicNotice.value = `助记词（仅展示一次，请离线保存）：${result.mnemonic}`;
				message.value = `注册成功，RootID=${result.rootId}`;
				await refreshStatus();
			} catch (error) {
				message.value = `注册失败：${error}`;
			}
		};

		const handleLogin = async (password: string) => {
			try {
				const result = await window.electronAPI.rootIdentity.unlock(password);
				message.value = `登录成功，RootID=${result.rootId}`;
				await refreshStatus();
			} catch (error) {
				message.value = `登录失败：${error}`;
			}
		};

		const handleLogout = async () => {
			try {
				await window.electronAPI.rootIdentity.lock();
				showApp.value = false;
				await refreshStatus();
			} catch (error) {
				message.value = `退出失败：${error}`;
			}
		};

		onMounted(async () => {
			await refreshStatus();
		});

		return () => {
			if (showApp.value) {
				return h(App);
			}

			const statusGrid = h('div', { class: 'status-grid' }, [
				h('div', { class: 'status-item' }, [h('strong', null, '是否已注册：'), rootStatus.value.initialized ? '是' : '否']),
				h('div', { class: 'status-item' }, [h('strong', null, '是否已登录：'), rootStatus.value.unlocked ? '是' : '否']),
				h('div', { class: 'status-item' }, [h('strong', null, 'RootID：'), rootStatus.value.rootId || '未创建'])
			]);

			const authNode = !rootStatus.value.initialized
				? h(RegisterPage, { onRegister: handleRegister })
				: !rootStatus.value.unlocked
					? h(LoginPage, { onLogin: handleLogin })
					: h('div', { class: 'row' }, [
						h('button', { onClick: () => { showApp.value = true; } }, '进入主界面'),
						h('button', { class: 'warn', onClick: handleLogout }, '退出登录')
					]);

			return h('section', { class: 'root-gate' }, [
				h('h1', null, '账号入口'),
				h('p', null, '登录前不展示主界面，请先完成 RootID 注册 / 登录。'),
				statusGrid,
				authNode,
				h('p', { class: 'message' }, message.value),
				mnemonicNotice.value ? h('p', { class: 'secret-notice' }, mnemonicNotice.value) : null
			]);
		};
	}
});

createApp(RootGate).mount('#app');
