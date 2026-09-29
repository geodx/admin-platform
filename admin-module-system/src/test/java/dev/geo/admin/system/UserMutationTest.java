package dev.geo.admin.system;

import dev.geo.admin.common.exception.ServiceException;
import dev.geo.admin.security.model.LoginPrincipal;
import dev.geo.admin.security.model.LoginUserInfo;
import dev.geo.admin.security.model.RoleGrant;
import dev.geo.admin.system.mapper.system.SysUserMapper;
import dev.geo.admin.system.mapper.system.SysUserPostMapper;
import dev.geo.admin.system.mapper.system.SysUserRoleMapper;
import dev.geo.admin.system.model.system.entity.SysUser;
import dev.geo.admin.system.resolve.aspect.DataScopeAspect;
import dev.geo.admin.system.service.system.ISysRoleService;
import dev.geo.admin.system.service.system.ISysUserService;
import dev.geo.admin.system.service.system.impl.SysUserServiceImpl;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.annotation.EnableAspectJAutoProxy;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;

import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Proxy;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;

import static org.junit.jupiter.api.Assertions.*;

class UserMutationTest {
    private final BCryptPasswordEncoder encoder = new BCryptPasswordEncoder(4);

    @AfterEach
    void clearSecurityContext() {
        SecurityContextHolder.clearContext();
    }

    @Test
    void duplicateAccountStopsCreateBeforeAnyWrite() {
        authenticate(1L, Set.of());
        AtomicInteger writes = new AtomicInteger();
        SysUserMapper users = stub(SysUserMapper.class, (proxy, method, args) -> {
            if (method.getName().equals("checkUserNameUnique")) return new SysUser(8L);
            if (method.getName().equals("insertUser")) writes.incrementAndGet();
            return 0;
        });
        var service = service(users, null, null);
        var user = new SysUser();
        user.setUserName("taken");
        user.setPassword("plain-password");

        var error = assertThrows(ServiceException.class, () -> service.insertUser(user));
        assertTrue(error.getMessage().contains("登录账号已存在"));
        assertEquals(0, writes.get());
    }

    @Test
    void roleScopeFailureStopsEditBeforeRelationsChange() {
        authenticate(1L, Set.of());
        AtomicInteger writes = new AtomicInteger();
        SysUserRoleMapper userRoles = stub(SysUserRoleMapper.class, (proxy, method, args) -> {
            writes.incrementAndGet();
            return 0;
        });
        ISysRoleService roles = stub(ISysRoleService.class, (proxy, method, args) -> {
            if (method.getName().equals("checkRoleDataScope")) {
                throw new ServiceException("没有权限访问角色数据！");
            }
            return null;
        });
        var service = service(null, userRoles, roles);
        var user = new SysUser(7L);
        user.setRoleIds(new Long[]{9L});

        assertThrows(ServiceException.class, () -> service.updateUser(user));
        assertEquals(0, writes.get());
    }

    @Test
    void roleAssignmentCannotModifyTheSuperAdministrator() {
        authenticate(1L, Set.of());
        AtomicInteger writes = new AtomicInteger();
        SysUserRoleMapper userRoles = stub(SysUserRoleMapper.class, (proxy, method, args) -> {
            writes.incrementAndGet();
            return 0;
        });
        var service = service(null, userRoles, null);

        assertThrows(ServiceException.class,
                () -> service.insertUserAuth(1L, new Long[]{2L}));
        assertEquals(0, writes.get());
    }

    @Test
    void resetPasswordEncodesExactlyOnceAtTheWriteInterface() {
        authenticate(1L, Set.of());
        AtomicReference<String> savedPassword = new AtomicReference<>();
        SysUserMapper users = stub(SysUserMapper.class, (proxy, method, args) -> {
            if (method.getName().equals("resetUserPwd")) {
                savedPassword.set((String) args[1]);
                return 1;
            }
            return 0;
        });
        var service = service(users, null, null);
        var user = new SysUser(7L);
        user.setPassword("new-password");

        assertEquals(1, service.resetPwd(user));
        assertNotEquals("new-password", savedPassword.get());
        assertTrue(encoder.matches("new-password", savedPassword.get()));
    }

    @Test
    void editCannotWritePasswordFromTheGeneralUserForm() {
        authenticate(1L, Set.of());
        AtomicReference<String> savedPassword = new AtomicReference<>("not-called");
        SysUserMapper users = stub(SysUserMapper.class, (proxy, method, args) -> {
            if (method.getName().equals("updateUser")) {
                savedPassword.set(((SysUser) args[0]).getPassword());
                return 1;
            }
            if (method.getName().equals("checkUserNameUnique")) return null;
            return 0;
        });
        SysUserRoleMapper userRoles = stub(SysUserRoleMapper.class, (proxy, method, args) -> 0);
        SysUserPostMapper userPosts = stub(SysUserPostMapper.class, (proxy, method, args) -> 0);
        var service = new SysUserServiceImpl(users, null, null, userRoles, userPosts,
                null, null, null, null, encoder);
        var user = new SysUser(7L);
        user.setUserName("account");
        user.setPassword("plain-password");

        assertEquals(1, service.updateUser(user));
        assertNull(savedPassword.get());
    }

    @Test
    void userScopeCheckPassesThroughTheDataScopeAspect() {
        authenticate(7L, Set.of(new RoleGrant(3L, DataScopeAspect.DATA_SCOPE_SELF,
                "staff", Set.of("system:user:list"))));
        AtomicReference<String> appliedScope = new AtomicReference<>();
        SysUserMapper users = stub(SysUserMapper.class, (proxy, method, args) -> {
            if (method.getName().equals("selectUserList")) {
                var query = (SysUser) args[0];
                appliedScope.set((String) query.getParams().get(DataScopeAspect.DATA_SCOPE));
                return List.of();
            }
            return 0;
        });
        var service = service(users, null, null);
        try (var context = new AnnotationConfigApplicationContext()) {
            context.register(ScopeAopConfig.class);
            context.registerBean(DataScopeAspect.class);
            context.registerBean(SysUserServiceImpl.class, () -> service);
            context.refresh();
            ISysUserService scoped = context.getBean(ISysUserService.class);
            assertThrows(ServiceException.class, () -> scoped.checkUserDataScope(8L));
        }
        assertNotNull(appliedScope.get());
        assertTrue(appliedScope.get().contains("u.id = 7"));
    }

    @Configuration
    @EnableAspectJAutoProxy(proxyTargetClass = true)
    static class ScopeAopConfig {
    }

    private SysUserServiceImpl service(SysUserMapper users, SysUserRoleMapper userRoles, ISysRoleService roles) {
        return new SysUserServiceImpl(users, null, null, userRoles, null,
                null, null, null, roles, encoder);
    }

    private static void authenticate(Long userId, Set<RoleGrant> grants) {
        var info = new LoginUserInfo(userId, "operator", "operator", null, null, null,
                "127.0.0.1", null, null, null, 7L, "Team", grants,
                Set.of("system:user:list"));
        var principal = new LoginPrincipal(info, null);
        SecurityContextHolder.getContext().setAuthentication(
                new UsernamePasswordAuthenticationToken(principal, null, principal.getAuthorities()));
    }

    @SuppressWarnings("unchecked")
    private static <T> T stub(Class<T> type, InvocationHandler handler) {
        return (T) Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[]{type}, handler);
    }
}
