import { computed, ref } from 'vue';
import { useRouter } from 'vue-router';

import { ElMessage, ElNotification } from 'element-plus';
import { defineStore } from 'pinia';
import { useAccessStore } from './access';
import { useUserStore } from './user';
import { $t } from '@/plugins/locale';

import { LOGIN_PATH } from '@/constants/core';
import { preferences } from '@/plugins/preference';
import {
  getUserInfoApi,
  loginApi,
  logoutApi,
  refreshTokenApi,
  type LoginParams,
} from '@/api/admin/auth';
import { requestClient } from '@/utils/request';
import { resetAccessRoutes } from '@/router/access';
import { useOnlineSession } from '@/plugins/effects/hooks/use-online-session';
import { updateUserPwd } from '@/api/system/user';

/**
 * @zh_CN 登录、会话权限相关
 */
export const useAuthStore = defineStore('auth', () => {
  const accessStore = useAccessStore();
  const userStore = useUserStore();
  const router = useRouter();

  const loginLoading = ref(false);
  let sessionRevision = 0;
  let refreshPromise: null | Promise<string> = null;
  let restorePromise: null | Promise<boolean> = null;
  /**
   * 是否已经执行过启动会话检查。
   *
   * 页面刷新后初始值为 false，路由守卫会调用 restoreSession()。
   */
  const sessionInitialized = ref(false);

  const isAuthenticated = computed(() => {
    return Boolean(accessStore.accessToken && userStore.userInfo);
  });

  requestClient.configureAuth({
    getToken: () => accessStore.accessToken,
    getSessionRevision: () => sessionRevision,
    refreshToken: refreshAccessToken,
    onUnauthorized: handleSessionExpired,
  });

  const { stop: stopOnlineSession, start: startOnlineSession } = useOnlineSession({
    enabled: () => sessionInitialized.value && isAuthenticated.value,
    getToken: () => accessStore.accessToken,
    refreshToken: refreshAccessToken,
    onInvalidated: (forced) => handleSessionExpired(
      forced ? '当前会话已被管理员强制下线，请重新登录' : undefined,
    ),
  });
  /**
   * 异步处理登录操作
   * 完整登录状态必须同时包含：
   *  accessToken、userInfo、permissions
   * @param params 登录表单数据
   */
  async function authLogin(params: LoginParams, onSuccess?: () => Promise<void> | void) {
    if (loginLoading.value) {
      return null;
    }
    loginLoading.value = true;
    clearSession();
    const revision = sessionRevision;
    try {
      const result = await loginApi(params);
      assertCurrentSession(revision);
      if (!result.accessToken) {
        throw new Error('登录接口未返回 accessToken');
      }
      // 获取到 accessToken
      accessStore.setAccessToken(result.accessToken);
      accessStore.setIsAccessChecked(false);

      // 获取用户信息并存储到 accessStore 中
      const userInfo = await fetchUserInfo();
      assertCurrentSession(revision);

      // 登录已经成功，不需要路由守卫再次执行 refresh。
      sessionInitialized.value = true;

      if (accessStore.loginExpired) {
        accessStore.setLoginExpired(false);
      }

      if (onSuccess) {
        await onSuccess();
      } else {
        const redirect = router.currentRoute.value.query.redirect;
        const target = typeof redirect === 'string' ? redirect : preferences.app.defaultHomePath;
        await router.replace(target);
      }
      assertCurrentSession(revision);
      ElNotification({
        message: `${$t('authentication.loginSuccessDesc')}:${userInfo.nickName ?? userInfo.username}`,
        title: $t('authentication.loginSuccess'),
        type: 'success',
      });
    } catch (error) {
      if (revision === sessionRevision) {
        clearSession();
      }
      throw error;
    } finally {
      loginLoading.value = false;
    }
  }

  /**
   * 通过HttpCookie中的 RefreshToken  获取新的 AccessToken。
   *
   * 所有刷新入口共用同一个请求；会话切换后丢弃旧请求的结果。
   */
  function refreshAccessToken(): Promise<string> {
    if (refreshPromise) {
      return refreshPromise;
    }
    const revision = sessionRevision;
    const pending = refreshTokenApi()
      .then((result) => {
        assertCurrentSession(revision);
        if (!result.accessToken) {
          throw new Error('刷新接口未返回 Access Token');
        }
        accessStore.setAccessToken(result.accessToken);
        return result.accessToken;
      })
      .finally(() => {
        if (refreshPromise === pending) {
          refreshPromise = null;
        }
      });
    refreshPromise = pending;
    return pending;
  }
  /**
   * 页面刷新时恢复登录状态。
   *
   * AccessToken不持久化，页面刷新会先调用refresh，然后再请求getInfo。
   */
  function restoreSession(): Promise<boolean> {
    if (sessionInitialized.value) {
      return Promise.resolve(isAuthenticated.value);
    }
    if (restorePromise) {
      return restorePromise;
    }
    const revision = sessionRevision;
    const pending = (async () => {
      try {
        if (!accessStore.accessToken) {
          await refreshAccessToken();
        }
        assertCurrentSession(revision);
        if (!userStore.userInfo) {
          await fetchUserInfo();
        }
        assertCurrentSession(revision);
        return isAuthenticated.value;
      } catch {
        // Cookie 失效或会话已切换时，不让旧恢复流程清除新登录。
        if (revision === sessionRevision) {
          clearSession();
        }
        return false;
      } finally {
        if (revision === sessionRevision) {
          sessionInitialized.value = true;
        }
      }
    })().finally(() => {
      if (restorePromise === pending) {
        restorePromise = null;
      }
    });
    restorePromise = pending;
    return pending;
  }
  /**
   * 获取用户信息。
   * 更新permissions
   */
  async function fetchUserInfo() {
    const revision = sessionRevision;
    const userInfo = await getUserInfoApi();
    assertCurrentSession(revision);
    userStore.setUserInfo(userInfo);
    accessStore.setPermissions(userInfo.permissions ?? []);
    return userInfo;
  }
  /**
   * AccessToken和RefreshToken都已经失效。
   *
   * 该方法由请求拦截器在 refresh 失败后调用。
   */
  async function handleSessionExpired(message = '登录状态已过期，请重新登录'): Promise<void> {
    if (sessionInitialized.value && !accessStore.accessToken && !userStore.userInfo) {
      return;
    }
    const currentRoute = router.currentRoute.value;
    const redirect = currentRoute.fullPath;

    clearSession();
    if (currentRoute.path !== LOGIN_PATH) {
      ElMessage.warning(message);
      await router.replace({
        path: LOGIN_PATH,
        query: {
          redirect,
        },
      });
    }
  }

  /**
   * 主动退出登录。
   */
  async function logout(redirect: boolean = true) {
    const currentRoute = router.currentRoute.value;
    const redirectPath = currentRoute.fullPath;
    clearSession();
    const revision = sessionRevision;
    try {
      await logoutApi();
    } catch (error) {
      console.warn('退出登录接口请求失败', error);
    } finally {
      if (revision === sessionRevision) {
        // 登录页带上当前路由地址
        await router.replace({
          path: LOGIN_PATH,
          query: redirect && currentRoute.path !== LOGIN_PATH ? { redirect: redirectPath } : {},
        });
      }
    }
  }

  /** 改密会撤销当前会话，提前关闭在线连接，避免把主动退出提示为会话异常。 */
  async function changePassword(oldPassword: string, newPassword: string) {
    stopOnlineSession();
    try {
      await updateUserPwd(oldPassword, newPassword);
    } catch (error) {
      startOnlineSession();
      throw error;
    }
    await logout(false);
  }
  /**
   * 清理客户端认证和权限状态。
   */
  function clearSession(): void {
    sessionRevision += 1;
    refreshPromise = null;
    restorePromise = null;
    stopOnlineSession();
    resetAccessRoutes();
    userStore.$reset();
    accessStore.$reset();
    /*
     * 当前未登录状态，防止进入登录页后再次请求 refresh。
     */
    sessionInitialized.value = true;
  }
  function assertCurrentSession(revision: number): void {
    if (revision !== sessionRevision) {
      throw new DOMException('会话已切换', 'AbortError');
    }
  }
  function $reset() {
    sessionRevision += 1;
    refreshPromise = null;
    restorePromise = null;
    loginLoading.value = false;
    sessionInitialized.value = false;
  }

  return {
    isAuthenticated,
    loginLoading,
    sessionInitialized,
    $reset,
    authLogin,
    clearSession,
    changePassword,
    fetchUserInfo,
    handleSessionExpired,
    logout,
    refreshAccessToken,
    restoreSession,
  };
});
