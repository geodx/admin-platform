import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import axios, { AxiosError } from 'axios';

import { useAuthStore } from '../auth';
import { useAccessStore } from '../access';
import { useUserStore } from '../user';
import { setupRequestInterceptors } from '@/utils/request/modules/interceptors';

const mocks = vi.hoisted(() => ({
  refreshTokenApi: vi.fn(),
  getUserInfoApi: vi.fn(),
  loginApi: vi.fn(),
  logoutApi: vi.fn(),
  configureAuth: vi.fn(),
  useOnlineSession: vi.fn(() => ({ stop: vi.fn(), start: vi.fn() })),
  resetAccessRoutes: vi.fn(),
  replace: vi.fn(),
  currentRoute: { value: { path: '/dashboard', fullPath: '/dashboard', query: {} } },
}));

vi.mock('vue-router', () => ({
  useRouter: () => ({ currentRoute: mocks.currentRoute, replace: mocks.replace }),
}));
vi.mock('element-plus', () => ({
  ElMessage: { warning: vi.fn() },
  ElNotification: vi.fn(),
}));
vi.mock('@/plugins/locale', () => ({ $t: (key: string) => key }));
vi.mock('@/plugins/preference', () => ({ preferences: { app: { defaultHomePath: '/' } } }));
vi.mock('@/api/admin/auth', () => ({
  refreshTokenApi: mocks.refreshTokenApi,
  getUserInfoApi: mocks.getUserInfoApi,
  loginApi: mocks.loginApi,
  logoutApi: mocks.logoutApi,
}));
vi.mock('@/api/system/user', () => ({ updateUserPwd: vi.fn() }));
vi.mock('@/utils/request', () => ({ requestClient: { configureAuth: mocks.configureAuth } }));
vi.mock('@/router/access', () => ({ resetAccessRoutes: mocks.resetAccessRoutes }));
vi.mock('@/plugins/effects/hooks/use-online-session', () => ({
  useOnlineSession: mocks.useOnlineSession,
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('会话生命周期', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setActivePinia(createPinia());
    mocks.logoutApi.mockResolvedValue(undefined);
    mocks.replace.mockResolvedValue(undefined);
  });

  it('HTTP 与在线连接同时遇到 401 时只刷新一次', async () => {
    const pending = deferred<{ accessToken: string }>();
    mocks.refreshTokenApi.mockReturnValue(pending.promise);
    useAuthStore();

    const http = mocks.configureAuth.mock.calls[0]![0].refreshToken();
    const online = mocks.useOnlineSession.mock.calls[0]![0].refreshToken();
    expect(http).toBe(online);
    expect(mocks.refreshTokenApi).toHaveBeenCalledTimes(1);

    pending.resolve({ accessToken: 'new-token' });
    await expect(http).resolves.toBe('new-token');
    expect(useAccessStore().accessToken).toBe('new-token');
  });

  it('退出后到达的刷新结果不会恢复令牌', async () => {
    const pending = deferred<{ accessToken: string }>();
    mocks.refreshTokenApi.mockReturnValue(pending.promise);
    const auth = useAuthStore();
    const refresh = auth.refreshAccessToken();

    await auth.logout();
    pending.resolve({ accessToken: 'stale-token' });
    await expect(refresh).rejects.toMatchObject({ name: 'AbortError' });
    expect(useAccessStore().accessToken).toBeNull();
  });

  it('退出后到达的用户信息不会恢复用户与权限', async () => {
    const pending = deferred<{ username: string; permissions: string[]; roles: string[] }>();
    mocks.getUserInfoApi.mockReturnValue(pending.promise);
    const auth = useAuthStore();
    const info = auth.fetchUserInfo();

    await auth.logout();
    pending.resolve({ username: 'old-user', permissions: ['system:user:list'], roles: ['admin'] });
    await expect(info).rejects.toMatchObject({ name: 'AbortError' });
    expect(useUserStore().userInfo).toBeNull();
    expect(useAccessStore().permissions).toEqual([]);
  });

  it('新登录不会被旧会话的刷新结果覆盖', async () => {
    const oldRefresh = deferred<{ accessToken: string }>();
    const loginResult = deferred<{ accessToken: string }>();
    mocks.refreshTokenApi.mockReturnValue(oldRefresh.promise);
    mocks.loginApi.mockReturnValue(loginResult.promise);
    mocks.getUserInfoApi.mockResolvedValue({
      username: 'new-user',
      permissions: ['dashboard:view'],
      roles: ['user'],
    });
    const auth = useAuthStore();
    const pendingRefresh = auth.refreshAccessToken();

    const login = auth.authLogin({
      username: 'new-user',
      password: 'password',
      code: '1234',
      uuid: 'captcha',
      rememberMe: false,
    });
    oldRefresh.resolve({ accessToken: 'old-token' });
    await expect(pendingRefresh).rejects.toMatchObject({ name: 'AbortError' });
    loginResult.resolve({ accessToken: 'new-token' });
    await login;

    expect(useAccessStore().accessToken).toBe('new-token');
    expect(useUserStore().userInfo?.username).toBe('new-user');
  });

  it('并发的启动恢复共用刷新和用户信息请求', async () => {
    const pending = deferred<{ accessToken: string }>();
    mocks.refreshTokenApi.mockReturnValue(pending.promise);
    mocks.getUserInfoApi.mockResolvedValue({
      username: 'alice',
      permissions: [],
      roles: [],
    });
    const auth = useAuthStore();

    const first = auth.restoreSession();
    const second = auth.restoreSession();
    pending.resolve({ accessToken: 'restored-token' });

    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(true);
    expect(mocks.refreshTokenApi).toHaveBeenCalledTimes(1);
    expect(mocks.getUserInfoApi).toHaveBeenCalledTimes(1);
  });

  it('旧会话的 HTTP 401 不会在退出后重新刷新', async () => {
    const started = deferred<void>();
    const complete = deferred<void>();
    const auth = useAuthStore();
    useAccessStore().setAccessToken('old-token');
    const authOptions = mocks.configureAuth.mock.calls[0]![0];
    const client = axios.create({
      adapter: async (config) => {
        started.resolve();
        await complete.promise;
        throw new AxiosError('Unauthorized', 'ERR_BAD_REQUEST', config, undefined, {
          config,
          data: null,
          headers: config.headers,
          status: 401,
          statusText: 'Unauthorized',
        });
      },
    });
    setupRequestInterceptors(client, () => authOptions);

    const request = client.get('/secure');
    await started.promise;
    auth.clearSession();
    complete.resolve();

    await expect(request).rejects.toMatchObject({ response: { status: 401 } });
    expect(mocks.refreshTokenApi).not.toHaveBeenCalled();
  });

  it('其他入口已刷新令牌时，旧 HTTP 请求直接用新令牌重试', async () => {
    useAuthStore();
    const access = useAccessStore();
    access.setAccessToken('old-token');
    const authOptions = mocks.configureAuth.mock.calls[0]![0];
    const sentTokens: unknown[] = [];
    const client = axios.create({
      adapter: async (config) => {
        sentTokens.push(config.headers.get('Authorization'));
        if (sentTokens.length === 1) {
          access.setAccessToken('new-token');
          throw new AxiosError('Unauthorized', 'ERR_BAD_REQUEST', config, undefined, {
            config,
            data: null,
            headers: config.headers,
            status: 401,
            statusText: 'Unauthorized',
          });
        }
        return { config, data: 'ok', headers: config.headers, status: 200, statusText: 'OK' };
      },
    });
    setupRequestInterceptors(client, () => authOptions);

    await expect(client.get('/secure')).resolves.toMatchObject({ data: 'ok' });
    expect(sentTokens).toEqual(['Bearer old-token', 'Bearer new-token']);
    expect(mocks.refreshTokenApi).not.toHaveBeenCalled();
  });
});
